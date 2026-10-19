// Crée (ou resynchronise) les rôles PostgreSQL à moindre privilège et la base
// Keycloak. Idempotent. À lancer avec un compte superutilisateur, une fois à
// l'installation puis à chaque rotation de mot de passe.
import { Client } from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({
  // SNOWFALL_ENV_FILE : autre fichier (pile de test isolée), sinon le .env du dépôt.
  path: process.env.SNOWFALL_ENV_FILE ?? fileURLToPath(new URL("../../../.env", import.meta.url)),
});

function credentials(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} est obligatoire.`);

  const url = new URL(value);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = url.pathname.replace(/^\//, "");

  if (!user || !password || !database) {
    throw new Error(`${name} doit contenir utilisateur, mot de passe et base.`);
  }
  if (password.length < 16) {
    throw new Error(`${name} : mot de passe trop court (16 caractères minimum).`);
  }
  return { user, password, database };
}

const admin = process.env.DATABASE_ADMIN_URL;
if (!admin) throw new Error("DATABASE_ADMIN_URL est obligatoire.");

const migrator = credentials("DATABASE_MIGRATION_URL");
const app = credentials("DATABASE_URL");
const keycloakPassword = process.env.KEYCLOAK_DB_PASSWORD;

if (migrator.user === app.user) {
  throw new Error("Les comptes de migration et applicatif doivent être distincts.");
}
if (migrator.database !== app.database) {
  throw new Error("DATABASE_URL et DATABASE_MIGRATION_URL doivent viser la même base.");
}
if (!keycloakPassword || keycloakPassword.length < 16) {
  throw new Error("KEYCLOAK_DB_PASSWORD est obligatoire (16 caractères minimum).");
}

const client = new Client({ connectionString: admin });

async function upsertRole(name: string, password: string) {
  const role = client.escapeIdentifier(name);
  const secret = client.escapeLiteral(password);
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  const options = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

  await client.query(
    exists.rowCount
      ? `ALTER ROLE ${role} WITH ${options} PASSWORD ${secret}`
      : `CREATE ROLE ${role} WITH ${options} PASSWORD ${secret}`,
  );
}

async function main() {
  await client.connect();

  const isSuperuser = await client.query<{ rolsuper: boolean }>(
    "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
  );
  if (!isSuperuser.rows[0]?.rolsuper) {
    throw new Error("DATABASE_ADMIN_URL doit utiliser un compte superutilisateur.");
  }

  await upsertRole(migrator.user, migrator.password);
  await upsertRole(app.user, app.password);
  await upsertRole("keycloak", keycloakPassword!);

  const db = client.escapeIdentifier(app.database);
  const m = client.escapeIdentifier(migrator.user);
  const a = client.escapeIdentifier(app.user);

  // Base applicative : personne d'autre ne s'y connecte.
  await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await client.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${db} TO ${m}`);
  await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${a}`);
  await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await client.query(`ALTER SCHEMA public OWNER TO ${m}`);

  // Garde-fous côté rôle applicatif.
  await client.query(`ALTER ROLE ${a} SET statement_timeout = '30s'`);
  await client.query(`ALTER ROLE ${a} SET idle_in_transaction_session_timeout = '60s'`);

  // Transfert des objets créés précédemment par le superutilisateur.
  await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION ${m}`);
  await client.query(`ALTER SCHEMA drizzle OWNER TO ${m}`);

  const objects = await client.query<{ schema: string; name: string; kind: string }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'drizzle')
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND pg_get_userbyid(c.relowner) <> $1
       -- Les séquences rattachées à une colonne suivent leur table.
       AND NOT (c.relkind = 'S' AND EXISTS (
         SELECT 1 FROM pg_depend d
         WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
       ))`,
    [migrator.user],
  );
  for (const object of objects.rows) {
    const target = `${client.escapeIdentifier(object.schema)}.${client.escapeIdentifier(object.name)}`;
    const statement =
      object.kind === "S" ? "SEQUENCE" : object.kind === "v" ? "VIEW" : object.kind === "m" ? "MATERIALIZED VIEW" : "TABLE";
    await client.query(`ALTER ${statement} ${target} OWNER TO ${m}`);
  }

  const functions = await client.query<{ signature: string }>(
    `SELECT p.oid::regprocedure::text AS signature
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> $1`,
    [migrator.user],
  );
  for (const fn of functions.rows) {
    await client.query(`ALTER FUNCTION ${fn.signature} OWNER TO ${m}`);
  }

  // Base Keycloak séparée, accessible uniquement par le rôle keycloak.
  const keycloakDb = await client.query("SELECT 1 FROM pg_database WHERE datname = 'keycloak'");
  if (!keycloakDb.rowCount) {
    await client.query("CREATE DATABASE keycloak OWNER keycloak");
  }
  await client.query("REVOKE ALL ON DATABASE keycloak FROM PUBLIC");
  await client.query("GRANT CONNECT, CREATE, TEMPORARY ON DATABASE keycloak TO keycloak");

  // Sauvegarde (facultatif) : lecture seule de toutes les données, RLS
  // ignorée (sinon le dump serait silencieusement incomplet), aucune écriture.
  const backupPassword = process.env.BACKUP_DB_PASSWORD;
  if (backupPassword) {
    if (backupPassword.length < 16) throw new Error("BACKUP_DB_PASSWORD : 16 caractères minimum.");
    const role = client.escapeIdentifier("snowfall_backup");
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'snowfall_backup'");
    const options = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD ${client.escapeLiteral(backupPassword)}`;
    await client.query(exists.rowCount ? `ALTER ROLE ${role} WITH ${options}` : `CREATE ROLE ${role} WITH ${options}`);
    await client.query(`GRANT pg_read_all_data TO ${role}`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
    await client.query(`GRANT CONNECT ON DATABASE keycloak TO ${role}`);
    // Transactions longues autorisées (gros dumps), mais jamais d'écriture.
    await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  }

  // Supervision (facultatif) : statistiques seulement (pg_monitor), aucune
  // lecture des tables de l'application.
  const monitorPassword = process.env.MONITOR_DB_PASSWORD;
  if (monitorPassword) {
    if (monitorPassword.length < 16) throw new Error("MONITOR_DB_PASSWORD : 16 caractères minimum.");
    await upsertRole("snowfall_monitor", monitorPassword);
    await client.query("GRANT pg_monitor TO snowfall_monitor");
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO snowfall_monitor`);
    await client.query("ALTER ROLE snowfall_monitor SET statement_timeout = '10s'");
  }

  console.log(
    `Rôles prêts : ${migrator.user} (migrations), ${app.user} (application), keycloak.`,
  );
}

main()
  .catch((error) => {
    console.error("Échec de db:setup :", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
