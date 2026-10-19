// Test de bout en bout sur la VRAIE pile : Keycloak (connexion, TOTP), API, Postgres
// (RLS, chiffrement), interface. Tout est jetable et isolé de la pile de
// développement : projet compose « snowfall-e2e », autres ports, secrets générés
// à chaque passage, fichier d'environnement dédié (le .env du dépôt n'est jamais lu).
//
//   node scripts/e2e-real.mjs            (démonte tout à la fin, même en échec)
//   node scripts/e2e-real.mjs --keep     (laisse la pile en place pour regarder)
//
// Prérequis : Docker, et les dépendances installées (npm ci).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const keep = process.argv.includes("--keep");
const windows = process.platform === "win32";
const secret = (bytes = 24) => randomBytes(bytes).toString("base64url");

const ports = { db: 55480, keycloak: 58080, api: 3101, web: 55173 };
const origin = `http://localhost:${ports.web}`;
const pass = {
  admin: secret(),
  migrator: secret(),
  app: secret(),
  keycloakDb: secret(),
  keycloakAdmin: secret(),
  oidc: secret(),
  user: `E2e-${secret(12)}!`,
};
const db = (user, password) => `postgres://${user}:${password}@127.0.0.1:${ports.db}/snowfall`;
const user = { username: "e2e.camille", email: "camille.e2e@snowfall.test" };

const env = {
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: String(ports.api),
  APP_ORIGIN: origin,
  DATABASE_ADMIN_URL: db("postgres", pass.admin),
  DATABASE_MIGRATION_URL: db("snowfall_migrator", pass.migrator),
  DATABASE_URL: db("snowfall_app", pass.app),
  KEYCLOAK_DB_PASSWORD: pass.keycloakDb,
  OIDC_ISSUER: `http://localhost:${ports.keycloak}/realms/snowfall`,
  OIDC_CLIENT_ID: "snowfall-bff",
  OIDC_CLIENT_SECRET: pass.oidc,
  OIDC_EXTRA_SCOPES: "organization",
  SNOWFALL_MASTER_KEY: randomBytes(32).toString("base64"),
  KMS_PROVIDER: "local",
  ANTIVIRUS: "off",
  METRICS_PORT: "0",
  AUDIT_STDOUT: "false",
  KNOWLEDGE_LINKS: "off",
  // Aucun fournisseur d'IA : le modèle local de développement répond (rien ne sort).
  LLM_DEFAULT_MODEL: "",
  MISTRAL_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GOOGLE_API_KEY: "",
  LOCAL_LLM_BASE_URL: "",
  LANGFUSE_PUBLIC_KEY: "",
  LANGFUSE_SECRET_KEY: "",
  SIEM_WEBHOOK_URL: "",
  WEB_SEARCH_URL: "",
  SNOWFALL_BOOTSTRAP_EMAIL: user.email,
  SNOWFALL_BOOTSTRAP_ORGANIZATION: "Polaris E2E",
};
const envFile = join(tmpdir(), `snowfall-e2e-${secret(6)}.env`);
writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
const childEnv = { ...process.env, ...env, SNOWFALL_ENV_FILE: envFile };
const composeEnv = {
  ...process.env,
  E2E_DB_ADMIN_PASSWORD: pass.admin,
  E2E_DB_PORT: String(ports.db),
  E2E_KEYCLOAK_ADMIN_PASSWORD: pass.keycloakAdmin,
  E2E_KEYCLOAK_DB_PASSWORD: pass.keycloakDb,
  E2E_OIDC_CLIENT_SECRET: pass.oidc,
  E2E_APP_ORIGIN: origin,
  E2E_API_PORT: String(ports.api),
  E2E_KEYCLOAK_PORT: String(ports.keycloak),
};
const compose = ["compose", "-p", "snowfall-e2e", "-f", "compose.e2e.yaml"];

function step(label) {
  console.log(`\n▶ ${label}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: windows, env: childEnv, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} : code ${result.status}`);
}

const background = [];
function start(label, command, args, cwd) {
  const child = spawn(command, args, { cwd, shell: windows, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => log.push(String(chunk)));
  background.push({ label, child, log });
  return child;
}

function stopAll() {
  for (const { child } of background) {
    if (child.exitCode !== null) continue;
    if (windows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
}

async function waitFor(label, url, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // pas encore prêt
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} injoignable : ${url}`);
}

/** Compte de test dans Keycloak (e-mail vérifié, TOTP à configurer à la 1re connexion). */
async function createUser() {
  const base = `http://localhost:${ports.keycloak}`;
  const token = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "e2e-admin", password: pass.keycloakAdmin }),
  }).then((response) => response.json());
  const headers = { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" };
  const created = await fetch(`${base}/admin/realms/snowfall/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: user.username,
      email: user.email,
      firstName: "Camille",
      lastName: "E2E",
      emailVerified: true,
      enabled: true,
      credentials: [{ type: "password", value: pass.user, temporary: false }],
    }),
  });
  if (created.status !== 201) throw new Error(`Création du compte Keycloak : ${created.status} ${await created.text()}`);
  return created.headers.get("location").split("/").pop();
}

let failed = false;
try {
  step("Pile isolée : Postgres");
  run("docker", [...compose, "up", "-d", "--wait", "db"], { env: composeEnv });
  step("Rôles, base Keycloak, migrations");
  run("npm", ["run", "db:setup", "-w", "apps/api"]);
  run("npm", ["run", "db:migrate", "-w", "apps/api"]);
  step("Keycloak (realm importé)");
  run("docker", [...compose, "up", "-d", "keycloak"], { env: composeEnv });
  await waitFor("Keycloak", `${env.OIDC_ISSUER}/.well-known/openid-configuration`);
  const subject = await createUser();
  childEnv.SNOWFALL_BOOTSTRAP_SUBJECT = subject;
  writeFileSync(envFile, `\nSNOWFALL_BOOTSTRAP_SUBJECT=${subject}\n`, { flag: "a" });
  run("npm", ["run", "db:bootstrap-test", "-w", "apps/api"]);

  step("API et interface");
  start("api", "npx", ["tsx", "src/server.ts"], join(root, "apps/api"));
  await waitFor("API", `http://127.0.0.1:${ports.api}/health`, 60_000);
  childEnv.SNOWFALL_API_URL = `http://127.0.0.1:${ports.api}`;
  start("web", "npx", ["vite", "--port", String(ports.web), "--strictPort", "--host", "localhost"], join(root, "apps/web"));
  await waitFor("Interface", origin, 60_000);

  step("Parcours réel (Playwright)");
  run("npx", ["playwright", "test", "-c", "playwright.real.config.ts"], {
    cwd: join(root, "apps/web"),
    env: { ...childEnv, E2E_ORIGIN: origin, E2E_USERNAME: user.username, E2E_PASSWORD: pass.user, E2E_DB_ADMIN: env.DATABASE_ADMIN_URL },
  });
  console.log("\n✔ Parcours réel réussi.");
} catch (error) {
  failed = true;
  console.error(`\n✘ ${error instanceof Error ? error.message : error}`);
  for (const { label, log } of background) console.error(`\n--- journal ${label} (fin) ---\n${log.join("").slice(-4_000)}`);
} finally {
  stopAll();
  if (!keep) spawnSync("docker", [...compose, "down", "-v", "--remove-orphans"], { cwd: root, stdio: "inherit", shell: windows, env: composeEnv });
  rmSync(envFile, { force: true });
  process.exitCode = failed ? 1 : 0;
}
