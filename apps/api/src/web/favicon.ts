import type { FetchedLink } from "../knowledge/safe-fetch.js";

// Icône d'un site cité, récupérée PAR SNOWFALL et servie depuis sa propre
// adresse : le navigateur ne contacte jamais le site ni un service tiers
// (Google, DuckDuckGo…), qui apprendraient sinon quelles pages chacun lit.
// Récupération par safeFetch (URL publique, pas d'adresse interne, taille
// bornée), image vérifiée par ses premiers octets : PNG, ICO, JPEG, GIF ou
// WebP seulement, jamais de SVG (du code, pas une image).

export const FAVICON_MAX_BYTES = 64 * 1024;
const PAGE_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 4_000;
const HIT_MS = 7 * 24 * 3600_000;
const MISS_MS = 24 * 3600_000;
const CACHE_MAX = 2_000;

export type Favicon = { bytes: Buffer; type: string };
/** domains : domaines autorisés par l'organisation (vide : tous les domaines publics). */
export type FaviconFetch = (url: string, options: { maxBytes: number; timeoutMs: number; domains: string[] }) => Promise<FetchedLink>;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Nom de domaine public seulement (pas d'adresse IP, pas de port, pas de chemin). */
export function faviconDomain(raw: string) {
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN.test(domain) ? domain : null;
}

/** Type d'image d'après ses premiers octets ; null pour tout le reste (SVG, HTML…). */
export function imageType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0 && bytes.readUInt16LE(4) > 0) return "image/x-icon";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Adresse de l'icône déclarée par la page d'accueil (<link rel="icon">), en https seulement. */
export function declaredIcon(html: string, base: string) {
  for (const tag of html.slice(0, PAGE_MAX_BYTES).match(/<link\b[^>]{0,500}>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!rel.split(/\s+/).includes("icon") && !rel.includes("apple-touch-icon")) continue;
    const href = /\bhref\s*=\s*["']([^"']{1,500})["']/i.exec(tag)?.[1];
    if (!href || /\.svg(\?|$)/i.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (url.protocol === "https:") return url.href;
    } catch {
      // Adresse illisible : suivante.
    }
  }
  return null;
}

/**
 * Icônes des sites, en cache par organisation (deux organisations ne se
 * renseignent pas, même par le temps de réponse, sur les sites lus par l'autre).
 */
export class FaviconService {
  private readonly cache = new Map<string, { at: number; icon: Favicon | null }>();
  private readonly inflight = new Map<string, Promise<Favicon | null>>();

  constructor(private readonly fetch: FaviconFetch) {}

  async get(organizationId: string, domain: string, domains: string[] = []): Promise<Favicon | null> {
    const key = `${organizationId}:${domain}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < (cached.icon ? HIT_MS : MISS_MS)) return cached.icon;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const loading = this.load(domain, domains)
      .catch(() => null)
      .then((icon) => {
        this.cache.delete(key);
        this.cache.set(key, { at: Date.now(), icon });
        // Le plus ancien sort en premier (ordre d'insertion d'une Map).
        while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
        return icon;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, loading);
    return loading;
  }

  private async image(url: string, domains: string[]) {
    const fetched = await this.fetch(url, { maxBytes: FAVICON_MAX_BYTES, timeoutMs: TIMEOUT_MS, domains });
    const type = imageType(fetched.bytes);
    return type ? { bytes: fetched.bytes, type } : null;
  }

  private async load(domain: string, domains: string[]): Promise<Favicon | null> {
    const origin = `https://${domain}`;
    const direct = await this.image(`${origin}/favicon.ico`, domains).catch(() => null);
    if (direct) return direct;
    const page = await this.fetch(`${origin}/`, { maxBytes: PAGE_MAX_BYTES, timeoutMs: TIMEOUT_MS, domains }).catch(() => null);
    if (!page || !page.contentType.includes("html")) return null;
    const declared = declaredIcon(page.bytes.toString("utf8"), page.url);
    return declared ? this.image(declared, domains).catch(() => null) : null;
  }
}
