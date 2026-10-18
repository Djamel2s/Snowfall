import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { authorizationUrl, discoverOAuth, exchangeCode, hashState, newState, OAuthError, pkce } from "./oauth.js";

/** Faux réseau : une réponse JSON par adresse. */
const network = (routes: Record<string, unknown>): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = routes[url];
    return new Response(body === undefined ? "{}" : JSON.stringify(body), { status: body === undefined ? 404 : 200 });
  }) as typeof fetch;

const config = { issuer: "https://auth.example/", authorizationEndpoint: "https://auth.example/authorize", tokenEndpoint: "https://auth.example/token", clientId: "snowfall" };

describe("OAuth MCP : règles de sécurité", () => {
  it("PKCE S256 : l'empreinte est le SHA-256 du secret ; state aléatoire, haché pour la base", () => {
    const { verifier, challenge } = pkce();
    assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
    assert.match(newState(), /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(newState(), newState());
    assert.match(hashState("x"), /^[0-9a-f]{64}$/);
  });

  it("adresse d'autorisation : client, retour, ressource, S256", () => {
    const url = new URL(authorizationUrl({ ...config, scope: "read" }, { state: "s", challenge: "c", redirectUri: "https://app.example/mcp/callback", resource: "https://mcp.example/mcp" }));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("resource"), "https://mcp.example/mcp");
    assert.equal(url.searchParams.get("scope"), "read");
  });

  it("découverte : refuse un serveur MCP ou un fournisseur non HTTPS, et un fournisseur sans S256", async () => {
    await assert.rejects(discoverOAuth("http://mcp.example/mcp", { clientId: "c" }, { fetcher: network({}) }), OAuthError);
    const insecure = network({
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": { authorization_servers: ["http://auth.example"] },
    });
    await assert.rejects(discoverOAuth("https://mcp.example/mcp", { clientId: "c" }, { fetcher: insecure }), (error: unknown) => error instanceof OAuthError && error.code === "invalid_metadata");
    const plainOnly = network({
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": { authorization_servers: ["https://auth.example"] },
      "https://auth.example/.well-known/oauth-authorization-server": { issuer: "https://auth.example", authorization_endpoint: "https://auth.example/a", token_endpoint: "https://auth.example/t", code_challenge_methods_supported: ["plain"] },
    });
    await assert.rejects(discoverOAuth("https://mcp.example/mcp", { clientId: "c" }, { fetcher: plainOnly }), (error: unknown) => error instanceof OAuthError && error.code === "invalid_metadata");
  });

  it("réponse de jeton : refusée si elle n'est pas un jeton « Bearer » valide", async () => {
    const reply = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const input = { code: "c", verifier: "v", redirectUri: "https://app.example/mcp/callback", resource: "https://mcp.example/mcp" };
    await assert.rejects(exchangeCode(config, input, { fetcher: reply({ access_token: "a", token_type: "mac" }) }), (error: unknown) => error instanceof OAuthError && error.code === "invalid_token");
    await assert.rejects(exchangeCode(config, input, { fetcher: reply({ access_token: "a b", token_type: "Bearer" }) }), OAuthError);
    const tokens = await exchangeCode(config, input, { fetcher: reply({ access_token: "abc", token_type: "bearer", expires_in: 60, refresh_token: "r" }) });
    assert.equal(tokens.accessToken, "abc");
    assert.equal(tokens.refreshToken, "r");
    assert.ok(Date.parse(tokens.expiresAt!) > Date.now());
  });
});
