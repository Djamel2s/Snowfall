// Chiffre les titres et messages enregistrés en clair avant l'activation du
// chiffrement, puis valide les contraintes qui interdisent le clair.
// Idempotent. Nécessite DATABASE_ADMIN_URL et SNOWFALL_MASTER_KEY.
import { Pool } from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { LocalKeyEncryptionProvider, parseMasterKey } from "../src/crypto/envelope.js";
import { OrganizationKeyring } from "../src/crypto/keyring.js";

dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const adminUrl = process.env.DATABASE_ADMIN_URL;
const masterKey = process.env.SNOWFALL_MASTER_KEY;
if (!adminUrl || !masterKey) {
  throw new Error("DATABASE_ADMIN_URL et SNOWFALL_MASTER_KEY sont obligatoires.");
}

const ENCRYPTED = "^[0-9]+:v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$";
const pool = new Pool({ connectionString: adminUrl, max: 1 });
const keyring = new OrganizationKeyring(
  new LocalKeyEncryptionProvider(parseMasterKey(masterKey)),
);

async function main() {
  const client = await pool.connect();
  let titles = 0;
  let messages = 0;

  try {
    await client.query("BEGIN");

    const conversations = await client.query<{
      id: string; organization_id: string; user_id: string; title: string;
    }>(
      `SELECT id, organization_id, user_id, title FROM conversations
       WHERE title IS NOT NULL AND title !~ $1
       FOR UPDATE`,
      [ENCRYPTED],
    );
    for (const row of conversations.rows) {
      const value = row.title === "Nouvelle conversation"
        ? null
        : await keyring.encrypt(
            client,
            row.organization_id,
            row.title,
            `conversation-title:${row.organization_id}:${row.user_id}:${row.id}`,
          );
      await client.query("UPDATE conversations SET title = $2 WHERE id = $1", [row.id, value]);
      titles++;
    }

    const plain = await client.query<{
      id: string; conversation_id: string; organization_id: string;
      user_id: string; role: string; content: string;
    }>(
      `SELECT id, conversation_id, organization_id, user_id, role, content
       FROM messages WHERE content !~ $1
       FOR UPDATE`,
      [ENCRYPTED],
    );
    for (const row of plain.rows) {
      const value = await keyring.encrypt(
        client,
        row.organization_id,
        row.content,
        `message:${row.organization_id}:${row.user_id}:${row.conversation_id}:${row.id}:${row.role}`,
      );
      await client.query("UPDATE messages SET content = $2 WHERE id = $1", [row.id, value]);
      messages++;
    }

    await client.query(
      "ALTER TABLE conversations VALIDATE CONSTRAINT conversations_title_encrypted_check",
    );
    await client.query(
      "ALTER TABLE messages VALIDATE CONSTRAINT messages_content_encrypted_check",
    );
    await client.query("COMMIT");

    console.log(`Chiffrés : ${titles} titre(s), ${messages} message(s). Contraintes validées.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error("Échec du chiffrement :", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
