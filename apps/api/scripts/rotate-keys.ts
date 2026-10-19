// Rotation des clés de chiffrement. Lancé avec le compte de migration.
//
//   npm run keys:rotate -- --kek
//       Rechiffre toutes les clés d'organisation (DEK) avec la KEK active :
//       après une rotation de la clé Transit dans Vault/OpenBao, ou pour
//       migrer de la KEK locale vers le KMS (KMS_PROVIDER=vault).
//   npm run keys:rotate -- --dek [--org <uuid>] [--reencrypt]
//       Crée une nouvelle version de DEK (toutes les organisations, ou une
//       seule) ; les nouvelles écritures l'utilisent aussitôt. --reencrypt
//       rechiffre aussi les données existantes avec cette nouvelle version.
//   npm run keys:rotate -- --verify [--org <uuid>]
//       Compte, table par table, les valeurs encore chiffrées avec une version
//       antérieure (code de sortie 2 s'il en reste) : à zéro, l'ancienne clé ne
//       sert plus à rien.
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { loadKmsConfig } from "../src/config.js";
import { parseMasterKey } from "../src/crypto/envelope.js";
import { organizationKeyContext, OrganizationKeyring } from "../src/crypto/keyring.js";
import { reencryptTable, staleValues, tablesFor } from "../src/crypto/rotation.js";
import { createKeyEncryption } from "../src/crypto/vault.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl) throw new Error("DATABASE_MIGRATION_URL est obligatoire.");
if (!flag("--verify") && flag("--kek") === flag("--dek")) {
  throw new Error("Préciser --kek ou --dek (voir l'en-tête du script).");
}

const { masterKey, kms } = loadKmsConfig();
const kek = createKeyEncryption(kms, parseMasterKey(masterKey));
const keyring = new OrganizationKeyring(kek);
const pool = new Pool({ connectionString: migrationUrl, max: 2 });

async function inTenant<T>(organizationId: string, userId: string | null, fn: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [organizationId, userId ?? ""],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function organizations() {
  const only = option("--org");
  const result = await pool.query<{ id: string }>(
    only ? "SELECT id FROM organizations WHERE id = $1" : "SELECT id FROM organizations ORDER BY created_at",
    only ? [only] : [],
  );
  if (only && result.rowCount === 0) throw new Error(`Organisation ${only} introuvable.`);
  return result.rows.map((row) => row.id);
}

async function rotateKek() {
  let count = 0;
  for (const organizationId of await organizations()) {
    count += await inTenant(organizationId, null, async (client) => {
      const keys = await client.query<{ version: number; wrapped_key: string }>(
        "SELECT version, wrapped_key FROM organization_keys WHERE organization_id = $1 FOR UPDATE",
        [organizationId],
      );
      for (const key of keys.rows) {
        const rewrapped = await kek.rotate(key.wrapped_key, organizationKeyContext(organizationId, key.version));
        await client.query(
          "UPDATE organization_keys SET wrapped_key = $3 WHERE organization_id = $1 AND version = $2",
          [organizationId, key.version, rewrapped],
        );
      }
      return keys.rowCount ?? 0;
    });
  }
  console.log(`KEK : ${count} clé(s) d'organisation rechiffrée(s) avec le fournisseur « ${kms.provider} ».`);
}

async function rotateDek(organizationId: string) {
  return inTenant(organizationId, null, async (client) => {
    const latest = await client.query<{ version: number | null }>(
      "SELECT max(version) AS version FROM organization_keys WHERE organization_id = $1",
      [organizationId],
    );
    const version = (latest.rows[0]?.version ?? 0) + 1;
    const wrapped = await kek.wrap(randomBytes(32), organizationKeyContext(organizationId, version));
    await client.query(
      "INSERT INTO organization_keys (organization_id, version, wrapped_key) VALUES ($1, $2, $3)",
      [organizationId, version, wrapped],
    );
    return version;
  });
}

/**
 * Rechiffre, avec la version de clé la plus récente, TOUTES les colonnes chiffrées
 * de l'organisation (inventaire unique : src/crypto/rotation.ts) : d'abord les
 * données de l'organisation, puis celles de chaque membre, sous leur RLS.
 */
async function reencrypt(organizationId: string, latest: number) {
  let updated = 0;
  for (const target of tablesFor(false)) {
    updated += await inTenant(organizationId, null, (client) => reencryptTable(client, keyring, target, { organizationId, userId: "" }, latest));
  }
  for (const userId of await members(organizationId)) {
    for (const target of tablesFor(true)) {
      updated += await inTenant(organizationId, userId, (client) => reencryptTable(client, keyring, target, { organizationId, userId }, latest));
    }
  }
  return updated;
}

/**
 * Membres actuels ET anciens : un départ efface conversations, projets, mémoire et
 * connexions (cascade), mais pas les prompts. La RLS par personne interdit de les
 * lister sans connaître leur auteur : on reprend toute personne ayant agi dans
 * l'organisation selon l'audit (chaque prompt y est tracé à sa création).
 */
async function members(organizationId: string) {
  const rows = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM organization_members WHERE organization_id = $1
     UNION SELECT DISTINCT actor_user_id FROM audit_events WHERE organization_id = $1 AND actor_user_id IS NOT NULL`,
    [organizationId],
  );
  return rows.rows.map((row) => row.user_id);
}

/** Valeurs encore chiffrées avec une version antérieure, table par table (preuve avant de retirer une clé). */
async function verify(organizationId: string) {
  const latest = await inTenant(organizationId, null, async (client) =>
    Number((await client.query<{ version: number }>("SELECT max(version) AS version FROM organization_keys WHERE organization_id = $1", [organizationId])).rows[0]?.version ?? 0),
  );
  const stale = new Map<string, number>();
  for (const target of tablesFor(false)) {
    stale.set(target.table, (stale.get(target.table) ?? 0) + (await inTenant(organizationId, null, (client) => staleValues(client, target, { organizationId, userId: "" }, latest))));
  }
  for (const userId of await members(organizationId)) {
    for (const target of tablesFor(true)) {
      stale.set(target.table, (stale.get(target.table) ?? 0) + (await inTenant(organizationId, userId, (client) => staleValues(client, target, { organizationId, userId }, latest))));
    }
  }
  const total = [...stale.values()].reduce((sum, count) => sum + count, 0);
  console.log(`Organisation ${organizationId} : version ${latest}, ${total} valeur(s) sur une version antérieure.`);
  for (const [table, count] of stale) if (count) console.log(`  ${table} : ${count}`);
  return total;
}

async function main() {
  if (flag("--verify")) {
    let total = 0;
    for (const organizationId of await organizations()) total += await verify(organizationId);
    if (total) process.exitCode = 2;
    return;
  }
  if (flag("--kek")) {
    await rotateKek();
    return;
  }
  for (const organizationId of await organizations()) {
    const version = await rotateDek(organizationId);
    keyring.forget();
    const reencrypted = flag("--reencrypt") ? await reencrypt(organizationId, version) : 0;
    console.log(
      `DEK : organisation ${organizationId} → version ${version}` +
        (flag("--reencrypt") ? ` (${reencrypted} ligne(s) rechiffrée(s))` : ""),
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error("Échec de la rotation :", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
