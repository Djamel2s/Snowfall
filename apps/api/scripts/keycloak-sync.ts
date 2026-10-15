// Applique à un realm Keycloak déjà importé les réglages que --import-realm
// n'applique qu'à la création : SMTP, mot de passe oublié, organisations (SSO),
// déconnexion back-channel et scope "organization" du client Snowfall.
// Idempotent. Utilise le compte d'administration bootstrap (.env).
//
//   npm run keycloak:sync
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const env = (name: string, fallback?: string) => {
  const value = process.env[name] || fallback;
  if (value === undefined) throw new Error(`${name} est obligatoire.`);
  return value;
};

const base = env("KEYCLOAK_URL", "http://localhost:8080").replace(/\/$/, "");
const realm = env("KEYCLOAK_REALM", "snowfall");
const clientId = env("OIDC_CLIENT_ID", "snowfall-bff");

async function adminToken() {
  const response = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: env("KEYCLOAK_ADMIN"),
      password: env("KEYCLOAK_ADMIN_PASSWORD"),
    }),
  });
  if (!response.ok) throw new Error(`Connexion admin Keycloak refusée (${response.status}).`);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function main() {
  const token = await adminToken();
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${base}/admin/realms/${realm}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} : ${response.status} ${await response.text()}`);
    return (response.status === 204 || response.headers.get("content-length") === "0"
      ? undefined
      : await response.json().catch(() => undefined)) as T;
  };

  const smtpServer: Record<string, string> = {
    host: env("SMTP_HOST", "mailpit"),
    port: env("SMTP_PORT", "1025"),
    from: env("SMTP_FROM", "no-reply@snowfall.local"),
    fromDisplayName: env("SMTP_FROM_NAME", "Snowfall"),
    starttls: env("SMTP_STARTTLS", "false"),
    ssl: env("SMTP_SSL", "false"),
    auth: process.env.SMTP_USER ? "true" : "false",
    ...(process.env.SMTP_USER ? { user: process.env.SMTP_USER, password: env("SMTP_PASSWORD") } : {}),
  };

  // Mise à jour partielle : seuls ces champs du realm changent.
  await api("", {
    method: "PUT",
    body: JSON.stringify({ smtpServer, resetPasswordAllowed: true, verifyEmail: true, organizationsEnabled: true }),
  });
  console.log(`Realm ${realm} : SMTP ${smtpServer.host}:${smtpServer.port}, mot de passe oublié, organisations.`);

  const [client] = await api<{ id: string; attributes?: Record<string, string> }[]>(
    `/clients?clientId=${encodeURIComponent(clientId)}`,
  );
  if (!client) throw new Error(`Client ${clientId} introuvable.`);

  const backchannel = env(
    "SNOWFALL_BACKCHANNEL_LOGOUT_URL",
    "http://host.docker.internal:3001/auth/backchannel-logout",
  );
  await api(`/clients/${client.id}`, {
    method: "PUT",
    body: JSON.stringify({
      ...client,
      frontchannelLogout: false,
      attributes: {
        ...client.attributes,
        "backchannel.logout.url": backchannel,
        "backchannel.logout.session.required": "true",
        "backchannel.logout.revoke.offline.tokens": "true",
      },
    }),
  });
  console.log(`Client ${clientId} : déconnexion back-channel → ${backchannel}`);

  const scopes = await api<{ id: string; name: string }[]>("/client-scopes");
  const organization = scopes.find((scope) => scope.name === "organization");
  if (organization) {
    await api(`/clients/${client.id}/optional-client-scopes/${organization.id}`, { method: "PUT" });
    console.log(`Client ${clientId} : scope optionnel "organization" (SSO, OIDC_EXTRA_SCOPES=organization).`);
  } else {
    console.warn('Scope "organization" absent : SSO par organisation indisponible sur ce Keycloak.');
  }
}

main().catch((error: unknown) => {
  console.error("Échec de la synchronisation Keycloak :", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
