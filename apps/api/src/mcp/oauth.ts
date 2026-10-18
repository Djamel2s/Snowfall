import { createHash, randomBytes } from "node:crypto";
import { McpError, validateMcpUrl, type McpServerSettings } from "./client.js";

// Connexion d'un utilisateur à un serveur MCP avec SON compte (OAuth 2.1, comme
// le prévoit la spécification d'autorisation MCP) : chaque action sur l'outil
// externe est faite en son nom, avec ses droits, et lui est attribuée là-bas.
//
// - découverte : métadonnées de la ressource protégée (RFC 9728) puis du serveur
//   d'autorisation (RFC 8414) ;
// - code d'autorisation + PKCE S256 (aucun secret dans le navigateur) ;
// - indicateur de ressource (RFC 8707) : le jeton est émis pour CE serveur MCP ;
// - jetons gardés côté serveur, chiffrés, jamais renvoyés au navigateur.

export type OAuthServerConfig = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | undefined;
  scope?: string | undefined;
};

export type OAuthTokens = { accessToken: string; refreshToken?: string | undefined; expiresAt?: string | undefined };

export class OAuthError extends Error {
  constructor(readonly code: "discovery_failed" | "invalid_metadata" | "token_failed" | "invalid_token" | "invalid_state") {
    super(`OAUTH_${code.toUpperCase()}`);
  }
}

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 256 * 1024;

type Deps = { fetcher?: typeof fetch | undefined; checkAddress?: McpServerSettings["checkAddress"]; allowLocal?: boolean | undefined };

/** Une adresse fournie par un tiers : mêmes règles que l'adresse MCP (HTTPS, publique). */
async function checked(raw: unknown, deps: Deps) {
  if (typeof raw !== "string" || raw.length > 2_000) throw new OAuthError("invalid_metadata");
  let url: URL;
  try {
    url = validateMcpUrl(raw, deps.allowLocal);
  } catch {
    throw new OAuthError("invalid_metadata");
  }
  await deps.checkAddress?.(url.hostname);
  return url;
}

async function getJson(url: URL, deps: Deps, init: RequestInit = {}) {
  const response = await (deps.fetcher ?? fetch)(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
  }).catch(() => null);
  if (!response) return { status: 0, body: null as Record<string, unknown> | null };
  const text = await response.text().catch(() => "");
  if (text.length > MAX_BYTES) return { status: response.status, body: null };
  try {
    const body = JSON.parse(text) as unknown;
    return { status: response.status, body: body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null };
  } catch {
    return { status: response.status, body: null };
  }
}

/**
 * Trouve le serveur d'autorisation d'un serveur MCP. clientId (et secret
 * éventuel) : enregistrés par l'administrateur auprès du fournisseur.
 */
export async function discoverOAuth(mcpUrl: string, client: { clientId: string; clientSecret?: string | undefined; scope?: string | undefined }, deps: Deps = {}): Promise<OAuthServerConfig> {
  const resource = await checked(mcpUrl, deps);
  const path = resource.pathname.replace(/\/$/, "");
  // RFC 9728 : d'abord au chemin de la ressource, puis à la racine.
  let metadata: Record<string, unknown> | null = null;
  for (const candidate of [`/.well-known/oauth-protected-resource${path}`, "/.well-known/oauth-protected-resource"]) {
    const { status, body } = await getJson(new URL(candidate, resource.origin), deps);
    if (status === 200 && body) {
      metadata = body;
      break;
    }
  }
  const servers = metadata?.authorization_servers;
  if (!Array.isArray(servers) || !servers.length) throw new OAuthError("discovery_failed");
  const issuer = await checked(servers[0], deps);

  const issuerPath = issuer.pathname.replace(/\/$/, "");
  let server: Record<string, unknown> | null = null;
  for (const candidate of [`/.well-known/oauth-authorization-server${issuerPath}`, `${issuerPath}/.well-known/openid-configuration`]) {
    const { status, body } = await getJson(new URL(candidate, issuer.origin), deps);
    if (status === 200 && body) {
      server = body;
      break;
    }
  }
  if (!server) throw new OAuthError("discovery_failed");
  // RFC 8414 : l'émetteur annoncé doit être celui interrogé (pas de substitution).
  if (typeof server.issuer !== "string" || server.issuer.replace(/\/$/, "") !== issuer.href.replace(/\/$/, "")) throw new OAuthError("invalid_metadata");
  const methods = server.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new OAuthError("invalid_metadata");
  return {
    issuer: issuer.href,
    authorizationEndpoint: (await checked(server.authorization_endpoint, deps)).href,
    tokenEndpoint: (await checked(server.token_endpoint, deps)).href,
    clientId: client.clientId,
    ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
    ...(client.scope ? { scope: client.scope } : {}),
  };
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** Secret de la demande (gardé côté serveur) et son empreinte (envoyée au fournisseur). */
export function pkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export const newState = () => base64url(randomBytes(32));
export const hashState = (state: string) => createHash("sha256").update(state, "utf8").digest("hex");

export function authorizationUrl(config: OAuthServerConfig, input: { state: string; challenge: string; redirectUri: string; resource: string }) {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  if (config.scope) url.searchParams.set("scope", config.scope);
  return url.href;
}

async function tokenRequest(config: OAuthServerConfig, params: Record<string, string>, deps: Deps): Promise<OAuthTokens> {
  const url = await checked(config.tokenEndpoint, deps).catch(() => {
    throw new OAuthError("token_failed");
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const form = new URLSearchParams(params);
  if (config.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64")}`;
  } else {
    form.set("client_id", config.clientId);
  }
  const { status, body } = await getJson(url, deps, { method: "POST", headers, body: form.toString() });
  if (status !== 200 || !body) throw new OAuthError("token_failed");
  const access = body.access_token;
  const type = body.token_type;
  if (typeof access !== "string" || !access || access.length > 8_000 || /\s/.test(access)) throw new OAuthError("invalid_token");
  if (typeof type !== "string" || type.toLowerCase() !== "bearer") throw new OAuthError("invalid_token");
  const refresh = typeof body.refresh_token === "string" && body.refresh_token.length <= 8_000 ? body.refresh_token : undefined;
  const lifetime = Number(body.expires_in);
  return {
    accessToken: access,
    ...(refresh ? { refreshToken: refresh } : {}),
    ...(Number.isFinite(lifetime) && lifetime > 0 ? { expiresAt: new Date(Date.now() + Math.min(lifetime, 31_536_000) * 1000).toISOString() } : {}),
  };
}

export function exchangeCode(config: OAuthServerConfig, input: { code: string; verifier: string; redirectUri: string; resource: string }, deps: Deps = {}) {
  return tokenRequest(config, { grant_type: "authorization_code", code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri, resource: input.resource }, deps);
}

export function refreshTokens(config: OAuthServerConfig, refreshToken: string, resource: string, deps: Deps = {}) {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken, resource }, deps);
}

/** Jeton encore utilisable (marge d'une minute) ? */
export const isFresh = (tokens: OAuthTokens) => !tokens.expiresAt || Date.parse(tokens.expiresAt) - Date.now() > 60_000;

