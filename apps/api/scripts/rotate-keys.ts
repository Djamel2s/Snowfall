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
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { profileAad } from "../src/agents/store.js";
import { attachmentAad } from "../src/attachments/store.js";
import { loadKmsConfig } from "../src/config.js";
import { messageAad, titleAad } from "../src/conversations/store.js";
import { parseMasterKey } from "../src/crypto/envelope.js";
import { keyVersionOf, organizationKeyContext, OrganizationKeyring } from "../src/crypto/keyring.js";
import { createKeyEncryption } from "../src/crypto/vault.js";
import { projectNameAad } from "../src/projects/store.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl) throw new Error("DATABASE_MIGRATION_URL est obligatoire.");
if (flag("--kek") === flag("--dek")) {
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

type Tenant = { organizationId: string; userId: string };

/** Rechiffre une valeur si elle n'utilise pas encore la dernière version de clé. */
async function refresh(client: PoolClient, tenant: Tenant, latest: number, stored: string | null, aad: string, binary = false) {
  if (stored === null || keyVersionOf(stored) === latest) return null;
  if (binary) {
    const bytes = await keyring.decryptBytes(client, tenant.organizationId, stored, aad);
    return keyring.encryptBytes(client, tenant.organizationId, bytes, aad);
  }
  const plain = await keyring.decrypt(client, tenant.organizationId, stored, aad);
  return keyring.encrypt(client, tenant.organizationId, plain, aad);
}

async function reencrypt(organizationId: string, latest: number) {
  let updated = 0;

  // Agents : niveau organisation.
  updated += await inTenant(organizationId, null, async (client) => {
    const rows = await client.query<{ id: string; profile_enc: string }>(
      "SELECT id, profile_enc FROM agents WHERE organization_id = $1",
      [organizationId],
    );
    let count = 0;
    for (const row of rows.rows) {
      const tenant = { organizationId, userId: "" };
      const next = await refresh(client, tenant, latest, row.profile_enc, profileAad(organizationId, row.id));
      if (next) {
        await client.query("UPDATE agents SET profile_enc = $2 WHERE id = $1", [row.id, next]);
        count++;
      }
    }
    return count;
  });

  // Données personnelles : sous le contexte de chaque membre (RLS par utilisateur).
  const members = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM organization_members WHERE organization_id = $1",
    [organizationId],
  );
  for (const { user_id: userId } of members.rows) {
    const tenant = { organizationId, userId };
    updated += await inTenant(organizationId, userId, async (client) => {
      let count = 0;
      const conversations = await client.query<{ id: string; title: string | null }>(
        "SELECT id, title FROM conversations WHERE organization_id = $1 AND user_id = $2",
        [organizationId, userId],
      );
      for (const row of conversations.rows) {
        const next = await refresh(client, tenant, latest, row.title, titleAad(tenant, row.id));
        if (next) {
          await client.query("UPDATE conversations SET title = $2 WHERE id = $1", [row.id, next]);
          count++;
        }
      }

      const messages = await client.query<{ id: string; conversation_id: string; role: "user" | "assistant"; content: string }>(
        "SELECT id, conversation_id, role, content FROM messages WHERE organization_id = $1 AND user_id = $2",
        [organizationId, userId],
      );
      for (const row of messages.rows) {
        const next = await refresh(client, tenant, latest, row.content, messageAad(tenant, row.conversation_id, row.id, row.role));
        if (next) {
          await client.query("UPDATE messages SET content = $2 WHERE id = $1", [row.id, next]);
          count++;
        }
      }

      const projects = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM projects WHERE organization_id = $1 AND user_id = $2",
        [organizationId, userId],
      );
      for (const row of projects.rows) {
        const next = await refresh(client, tenant, latest, row.name, projectNameAad(tenant, row.id));
        if (next) {
          await client.query("UPDATE projects SET name = $2 WHERE id = $1", [row.id, next]);
          count++;
        }
      }

      const files = await client.query<{ id: string; name: string; content: string; extracted_text: string | null }>(
        "SELECT id, name, content, extracted_text FROM attachments WHERE organization_id = $1 AND user_id = $2",
        [organizationId, userId],
      );
      for (const row of files.rows) {
        const name = await refresh(client, tenant, latest, row.name, attachmentAad(tenant, row.id, "name"));
        const content = await refresh(client, tenant, latest, row.content, attachmentAad(tenant, row.id, "content"), true);
        const text = await refresh(client, tenant, latest, row.extracted_text, attachmentAad(tenant, row.id, "text"));
        if (name || content || text) {
          await client.query(
            `UPDATE attachments SET name = coalesce($2, name), content = coalesce($3, content),
               extracted_text = coalesce($4, extracted_text) WHERE id = $1`,
            [row.id, name, content, text],
          );
          count++;
        }
      }
      return count;
    });
  }
  return updated;
}

async function main() {
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
