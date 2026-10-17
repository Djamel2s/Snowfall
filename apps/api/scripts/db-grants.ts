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
  agents: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  conversations: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  messages: ["SELECT", "INSERT", "DELETE"],
  sessions: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  audit_events: ["INSERT"],
  organization_settings: ["SELECT", "INSERT", "UPDATE"],
  token_usage: ["SELECT", "INSERT", "UPDATE"],
  tool_usage: ["SELECT", "INSERT", "UPDATE"],
  message_feedback: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  projects: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  attachments: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  user_preferences: ["SELECT", "INSERT", "UPDATE"],
  organization_invitations: ["SELECT", "INSERT", "DELETE"],
  knowledge_bases: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  knowledge_sources: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  knowledge_chunks: ["SELECT", "INSERT", "DELETE"],
  // knowledge_jobs : aucun droit, lue seulement via snowfall_pending_knowledge().
  agent_runs: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  agent_checkpoints: ["SELECT", "INSERT", "DELETE"],
  agent_checkpoint_writes: ["SELECT", "INSERT", "DELETE"],
  // agent_run_leases : aucun droit, lue seulement via snowfall_stale_runs().
  conversation_summaries: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  generated_files: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  mcp_servers: ["SELECT", "INSERT", "UPDATE", "DELETE"],
};

// Opérations sensibles hors RLS (membres, provisioning, SSO) : uniquement via
// ces fonctions SECURITY DEFINER, qui contrôlent elles-mêmes les droits.
const functions = [
  "snowfall_provision_identity(text, text, text, boolean, text[])",
  "snowfall_set_member_role(uuid, text)",
  "snowfall_remove_member(uuid)",
  "snowfall_set_organization_sso(text, text)",
  "snowfall_pending_knowledge()",
  "snowfall_stale_runs(interval)",
];

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
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`);
  for (const signature of functions) {
    await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`);
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
