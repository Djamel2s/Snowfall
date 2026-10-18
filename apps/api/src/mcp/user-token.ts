import type { TenantContext } from "../db/tenant.js";
import type { McpServerSettings } from "./client.js";
import type { McpConnectionStore } from "./connections.js";
import { isFresh, refreshTokens } from "./oauth.js";
import type { McpConnection } from "./store.js";

export type TokenDeps = { connections?: McpConnectionStore | undefined; fetcher?: typeof fetch | undefined; checkAddress?: McpServerSettings["checkAddress"]; allowLocal?: boolean | undefined };

/**
 * Jeton à présenter au serveur MCP pour CET utilisateur :
 * - mode « token » : le jeton de l'organisation ;
 * - mode « oauth » : le sien, renouvelé s'il expire. Renouvellement impossible :
 *   la connexion est effacée (l'utilisateur se reconnectera) — jamais de jeton mort gardé.
 * null : pas de jeton (pas connecté) ; le serveur n'est alors pas proposé.
 */
export async function bearerFor(server: McpConnection, tenant: TenantContext, deps: TokenDeps): Promise<string | null | undefined> {
  if (server.auth === "token") return server.token ?? undefined;
  if (!server.oauth || !deps.connections) return null;
  const tokens = await deps.connections.tokens(tenant, server.id);
  if (!tokens) return null;
  if (isFresh(tokens)) return tokens.accessToken;
  if (!tokens.refreshToken) {
    await deps.connections.deleteTokens(tenant, server.id);
    return null;
  }
  try {
    const renewed = await refreshTokens(server.oauth, tokens.refreshToken, server.url, {
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      checkAddress: deps.checkAddress,
      ...(deps.allowLocal ? { allowLocal: true } : {}),
    });
    await deps.connections.saveTokens(tenant, server.id, renewed);
    return renewed.accessToken;
  } catch {
    await deps.connections.deleteTokens(tenant, server.id);
    return null;
  }
}
