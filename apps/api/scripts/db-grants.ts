// Applique les droits du rôle applicatif après chaque migration.
// Lancé avec le compte de migration (propriétaire des tables).
import { Client } from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const appUrl = process.env.DATABASE_URL;
if (!migrationUrl || !appUrl) {
  throw new Error("DATABASE_MIGRATION_URL et DATABASE_URL sont obligatoires.");
}

const appRole = decodeURIComponent(new URL(appUrl).username);
const client = new Client({ connectionString: migrationUrl });

// Droits minimaux par table. Toute table absente de cette liste reste
// inaccessible au rôle applicatif (refus par défaut).
const privileges: Record<string, string[]> = {
  organizations: ["SELECT"],
  users: ["SELECT"],
  organization_members: ["SELECT"],
  external_identities: ["SELECT"],
  organization_keys: ["SELECT", "INSERT"],
  conversations: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  messages: ["SELECT", "INSERT", "DELETE"],
  sessions: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  audit_events: ["INSERT"],
};

async function main() {
  await client.connect();
  const role = client.escapeIdentifier(appRole);

  await client.query("BEGIN");
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`);

  for (const [table, grants] of Object.entries(privileges)) {
    await client.query(
      `GRANT ${grants.join(", ")} ON ${client.escapeIdentifier(table)} TO ${role}`,
    );
  }
  await client.query("COMMIT");

  console.log(`Droits appliqués au rôle ${appRole}.`);
}

main()
  .catch(async (error) => {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Échec de db:grants :", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
