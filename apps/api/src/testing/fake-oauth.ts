import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Faux serveur d'autorisation OAuth 2.1 pour les tests : vérifie vraiment le
 * PKCE (S256), l'adresse de retour, le client et l'indicateur de ressource, émet
 * des jetons à durée de vie courte et des jetons de renouvellement. Chaque jeton
 * est rattaché à un « compte » (l'utilisateur qui a consenti).
 */
export async function startFakeOAuthServer(options: { clientId: string; clientSecret?: string; issuerOverride?: string; lifetime?: number }) {
  const codes = new Map<string, { challenge: string; redirectUri: string; resource: string; account: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, { account: string; resource: string }>();
  const state = { tokenRequests: [] as Record<string, string>[], accounts: access };
  const issue = (account: string, resource: string) => {
    const token = `at-${randomBytes(12).toString("hex")}`;
    const renew = `rt-${randomBytes(12).toString("hex")}`;
    access.set(token, account);
    refresh.set(renew, { account, resource });
    return { access_token: token, token_type: "Bearer", expires_in: options.lifetime ?? 3600, refresh_token: renew };
  };
  let issuer = "";
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", issuer);
      const json = (status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(200, {
          issuer: options.issuerOverride ?? issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/authorize") {
        // Consentement simulé : le compte est donné dans l'adresse (?account=…).
        const params = url.searchParams;
        if (params.get("client_id") !== options.clientId || params.get("code_challenge_method") !== "S256" || !params.get("resource")) return json(400, { error: "invalid_request" });
        const code = `code-${randomBytes(8).toString("hex")}`;
        codes.set(code, { challenge: params.get("code_challenge")!, redirectUri: params.get("redirect_uri")!, resource: params.get("resource")!, account: params.get("account") ?? "anonyme" });
        const back = new URL(params.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", params.get("state")!);
        response.writeHead(302, { location: back.href }).end();
        return;
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = Object.fromEntries(new URLSearchParams(body));
        state.tokenRequests.push(form);
        const basic = /^Basic (.+)$/.exec(request.headers.authorization ?? "")?.[1];
        const [id, secret] = basic ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent) : [form.client_id, undefined];
        if (id !== options.clientId || (options.clientSecret && secret !== options.clientSecret)) return json(401, { error: "invalid_client" });
        if (form.grant_type === "authorization_code") {
          const grant = codes.get(form.code ?? "");
          codes.delete(form.code ?? "");
          const expected = grant && createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
          if (!grant || expected !== grant.challenge || form.redirect_uri !== grant.redirectUri || form.resource !== grant.resource) return json(400, { error: "invalid_grant" });
          return json(200, issue(grant.account, grant.resource));
        }
        if (form.grant_type === "refresh_token") {
          const grant = refresh.get(form.refresh_token ?? "");
          refresh.delete(form.refresh_token ?? "");
          if (!grant || form.resource !== grant.resource) return json(400, { error: "invalid_grant" });
          return json(200, issue(grant.account, grant.resource));
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      json(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    state,
    /** Compte titulaire d'un jeton d'accès (undefined : jeton inconnu). */
    accountOf: (token: string) => access.get(token),
    /** Simule le consentement de l'utilisateur et renvoie l'adresse de retour (code, state). */
    consent: async (authorizationUrl: string, account: string) => {
      const url = new URL(authorizationUrl);
      url.searchParams.set("account", account);
      const response = await fetch(url, { redirect: "manual" });
      return new URL(response.headers.get("location")!);
    },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
