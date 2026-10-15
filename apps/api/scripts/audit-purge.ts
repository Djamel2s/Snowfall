// Purge du journal d'audit applicatif au-delà de la durée de conservation.
// Lancé avec le compte de migration (seul rôle disposant de DELETE) :
//
//   npm run audit:purge -- [--archive audit-2026.jsonl] [--dry-run]
//
// AUDIT_RETENTION_DAYS (365 par défaut, 90 minimum, imposé aussi par le
// trigger en base). Avec --archive, les lignes purgées sont d'abord écrites en
// JSONL : à chiffrer et déposer sur un stockage WORM selon la politique.
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const args = process.argv.slice(2);
const archivePath = args.includes("--archive") ? args[args.indexOf("--archive") + 1] : undefined;
const dryRun = args.includes("--dry-run");
const retentionDays = Number(process.env.AUDIT_RETENTION_DAYS ?? 365);

if (!Number.isInteger(retentionDays) || retentionDays < 90) {
  throw new Error("AUDIT_RETENTION_DAYS doit être un entier ≥ 90.");
}
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl) throw new Error("DATABASE_MIGRATION_URL est obligatoire.");
if (args.includes("--archive") && !archivePath) throw new Error("--archive attend un chemin de fichier.");

const client = new Client({ connectionString: migrationUrl });

async function main() {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL snowfall.audit_purge = 'on'");
  const cutoff = (await client.query<{ cutoff: Date }>(
    "SELECT now() - make_interval(days => $1) AS cutoff",
    [retentionDays],
  )).rows[0]!.cutoff;

  if (archivePath) {
    const out = createWriteStream(archivePath, { flags: "wx", mode: 0o600 });
    const rows = await client.query("SELECT * FROM audit_events WHERE occurred_at < $1 ORDER BY occurred_at", [cutoff]);
    for (const row of rows.rows) {
      if (!out.write(`${JSON.stringify(row)}\n`)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
    console.log(`Archive : ${rows.rowCount} événement(s) écrit(s) dans ${archivePath}.`);
  }

  const deleted = await client.query("DELETE FROM audit_events WHERE occurred_at < $1", [cutoff]);
  // La purge elle-même est tracée, et reste après la purge suivante.
  await client.query(
    `INSERT INTO audit_events (event_type, outcome, details)
     VALUES ('audit.purge', 'success', $1)`,
    [{ deleted: deleted.rowCount ?? 0, retentionDays, cutoff: cutoff.toISOString(), archived: Boolean(archivePath), dryRun }],
  );

  await client.query(dryRun ? "ROLLBACK" : "COMMIT");
  console.log(
    `${dryRun ? "[simulation] " : ""}${deleted.rowCount ?? 0} événement(s) antérieur(s) au ${cutoff.toISOString()} ` +
      `${dryRun ? "seraient purgés" : "purgés"} (conservation : ${retentionDays} jours).`,
  );
}

main()
  .catch(async (error: unknown) => {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Échec de la purge :", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
