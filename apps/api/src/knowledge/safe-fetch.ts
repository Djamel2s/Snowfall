import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import tls from "node:tls";

// Récupération d'une URL fournie par un utilisateur, protégée contre la SSRF :
// - http(s) uniquement, ports standards, pas d'identifiants dans l'URL ;
// - chaque adresse résolue est vérifiée AU MOMENT DE LA CONNEXION (lookup
//   personnalisé) : un DNS qui change de réponse (rebinding) ne contourne rien ;
// - réseaux privés, boucle locale, lien local, métadonnées cloud, multicast,
//   plages réservées et IPv4 mappées en IPv6 refusés ;
// - redirections suivies à la main, revalidées, au plus 3 ;
// - taille, durée et encodage bornés ; aucun cookie ni en-tête d'authentification.

export class LinkError extends Error {
  constructor(readonly code: LinkErrorCode) {
    super(`LINK_${code.toUpperCase()}`);
  }
}

export type LinkErrorCode =
  | "invalid_url"
  | "blocked_address"
  | "domain_not_allowed"
  | "too_many_redirects"
  | "http_error"
  | "too_large"
  | "timeout"
  | "unsupported_encoding"
  | "proxy_denied"
  | "network_error";

// Deux listes distinctes : une BlockList mixte confronte aussi une adresse
// IPv4 aux plages IPv6 « mappées », ce qui bloquerait tout Internet.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6");
}

/** IPv4 mappée (::ffff:a.b.c.d) ou compatible (::a.b.c.d), sous toutes ses écritures. */
function embeddedIpv4(address: string) {
  const lower = address.toLowerCase();
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16);
    const low = Number.parseInt(hex[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

/** Adresse joignable sur Internet public (et seulement elle). */
export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !blockedV4.check(address, "ipv4");
  // Une IPv4 déguisée en IPv6 n'est jamais acceptée telle quelle.
  if (embeddedIpv4(address) !== null || address.toLowerCase().startsWith("::ffff:")) return false;
  return !blockedV6.check(address, "ipv6");
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp", ".private"];

export function hostAllowed(host: string, domains: string[]) {
  if (domains.length === 0) return true;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** URL acceptable : http(s), port standard, sans identifiants ni hôte interne. */
export function validateUrl(raw: string, domains: string[] = [], anyPort = false): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LinkError("invalid_url");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new LinkError("invalid_url");
  if (!anyPort && url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))) {
    throw new LinkError("invalid_url");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)) || (!host.includes(".") && !isIP(host))) {
    throw new LinkError("blocked_address");
  }
  if (isIP(host) && !isPublicAddress(host)) throw new LinkError("blocked_address");
  if (!hostAllowed(host, domains)) throw new LinkError("domain_not_allowed");
  url.hash = "";
  return url;
}

export type FetchedLink = { url: string; contentType: string; fileName: string | null; bytes: Buffer };

export type SafeFetchOptions = {
  maxBytes: number;
  timeoutMs: number;
  domains?: string[];
  signal?: AbortSignal;
  /**
   * Proxy de sortie (ex. Squid, http://egress:3128) : il résout le nom et
   * refuse lui-même les adresses internes ; l'application garde ses contrôles
   * d'URL. HTTPS passe par un tunnel CONNECT (le proxy ne voit pas le contenu).
   */
  proxy?: string | undefined;
  /** Tests uniquement : résolution DNS simulée, contrôle d'adresse et port libres. */
  testing?: {
    resolve: (hostname: string) => LookupAddress[];
    isAllowedAddress?: (address: string) => boolean;
    anyPort?: boolean;
  };
};

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(isAllowed: (address: string) => boolean, resolve?: (hostname: string) => LookupAddress[]) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    const done = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (error) return callback(error, "");
      // Une seule adresse interne suffit à refuser l'hôte.
      if (addresses.length === 0 || addresses.some((item) => !isAllowed(item.address))) {
        return callback(Object.assign(new Error("BLOCKED_ADDRESS"), { code: "EBLOCKED" }), "");
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    if (resolve) done(null, resolve(hostname));
    else dnsLookup(hostname, { all: true, verbatim: true }, done);
  };
}

function fileNameFrom(disposition: string | undefined) {
  const match = disposition && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

const HEADERS = {
  "User-Agent": "SnowfallKnowledgeBot/1.0 (+indexation de documents)",
  Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,text/markdown,application/json,*/*;q=0.5",
  "Accept-Encoding": "identity",
};

function requestOnce(url: URL, options: SafeFetchOptions, deadline: number): Promise<{ redirect: string } | FetchedLink> {
  const isAllowed = options.testing?.isAllowedAddress ?? isPublicAddress;
  const proxy = options.proxy ? new URL(options.proxy) : null;

  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new LinkError("timeout"));

    const onResponse = (response: http.IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location) return reject(new LinkError("http_error"));
        return resolve({ redirect: new URL(location, url).href });
      }
      if (status !== 200) {
        response.resume();
        // Refus du proxy de sortie (adresse interne, domaine non autorisé).
        return reject(new LinkError(proxy && status === 403 ? "proxy_denied" : "http_error"));
      }
      const encoding = (response.headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding !== "identity") {
        response.destroy();
        return reject(new LinkError("unsupported_encoding"));
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (declared > options.maxBytes) {
        response.destroy();
        return reject(new LinkError("too_large"));
      }

      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          response.destroy();
          reject(new LinkError("too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () =>
        resolve({
          url: url.href,
          contentType: String(response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase(),
          fileName: fileNameFrom(response.headers["content-disposition"]),
          bytes: Buffer.concat(chunks),
        }),
      );
      response.on("error", () => reject(new LinkError("network_error")));
    };

    const wire = (request: http.ClientRequest) => {
      const abort = () => request.destroy(new Error("ABORTED"));
      options.signal?.addEventListener("abort", abort, { once: true });
      request.on("timeout", () => {
        request.destroy();
        reject(new LinkError("timeout"));
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        options.signal?.removeEventListener("abort", abort);
        reject(error instanceof LinkError ? error : new LinkError(error.code === "EBLOCKED" ? "blocked_address" : "network_error"));
      });
      request.on("close", () => options.signal?.removeEventListener("abort", abort));
      return request;
    };

    // Sans proxy : connexion directe, chaque adresse résolue est vérifiée.
    if (!proxy) {
      const transport = url.protocol === "https:" ? https : http;
      wire(
        transport.request(
          url,
          {
            method: "GET",
            lookup: guardedLookup(isAllowed, options.testing?.resolve) as never,
            headers: HEADERS,
            timeout: remaining,
            // Pas d'agent partagé : aucune connexion réutilisée d'une URL à l'autre.
            agent: false,
          },
          onResponse,
        ),
      ).end();
      return;
    }

    const proxyPort = Number(proxy.port || 80);
    if (url.protocol === "http:") {
      wire(
        http.request(
          { host: proxy.hostname, port: proxyPort, method: "GET", path: url.href, headers: { ...HEADERS, Host: url.host }, timeout: remaining, agent: false },
          onResponse,
        ),
      ).end();
      return;
    }

    const target = `${url.hostname}:${url.port || 443}`;
    const connect = wire(
      http.request({ host: proxy.hostname, port: proxyPort, method: "CONNECT", path: target, headers: { Host: target }, timeout: remaining, agent: false }),
    );
    connect.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        return reject(new LinkError("proxy_denied"));
      }
      wire(
        https.request(
          url,
          {
            method: "GET",
            headers: HEADERS,
            timeout: Math.max(1, deadline - Date.now()),
            agent: false,
            // TLS de bout en bout à travers le tunnel, certificat vérifié.
            createConnection: () => tls.connect({ socket, ...(isIP(url.hostname) ? {} : { servername: url.hostname }) }),
          },
          onResponse,
        ),
      ).end();
    });
    connect.end();
  });
}

/** Télécharge une URL publique en respectant toutes les protections ci-dessus. */
export async function safeFetch(raw: string, options: SafeFetchOptions): Promise<FetchedLink> {
  const deadline = Date.now() + options.timeoutMs;
  const anyPort = options.testing?.anyPort ?? false;
  let url = validateUrl(raw, options.domains, anyPort);
  for (let hops = 0; hops <= 3; hops++) {
    const result = await requestOnce(url, options, deadline);
    if (!("redirect" in result)) return result;
    url = validateUrl(result.redirect, options.domains, anyPort);
  }
  throw new LinkError("too_many_redirects");
}
