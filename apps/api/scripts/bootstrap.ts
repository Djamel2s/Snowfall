import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

// Écrit des appartenances : réservé au compte de migration, pas au rôle applicatif.
const databaseUrl = process.env.DATABASE_MIGRATION_URL;
const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
const subject = process.env.SNOWFALL_BOOTSTRAP_SUBJECT;
const email = process.env.SNOWFALL_BOOTSTRAP_EMAIL;
const organizationName =
  process.env.SNOWFALL_BOOTSTRAP_ORGANIZATION ?? "Snowfall Test";

if (!databaseUrl || !issuer || !subject || !email) {
  throw new Error(
    "Configure DATABASE_MIGRATION_URL, OIDC_ISSUER, SNOWFALL_BOOTSTRAP_SUBJECT et SNOWFALL_BOOTSTRAP_EMAIL.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });

async function main() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingIdentity = await client.query(
      `SELECT 1 FROM external_identities
       WHERE issuer = $1 AND subject = $2`,
      [issuer, subject],
    );

    const existingEmail = await client.query(
      "SELECT 1 FROM users WHERE lower(email) = lower($1)",
      [email],
    );

    if (existingIdentity.rowCount || existingEmail.rowCount) {
      throw new Error(
        "L'identité Keycloak ou l'e-mail existe déjà. Aucune modification conservée.",
      );
    }

    const userId = randomUUID();
    const organizationId = randomUUID();

    await client.query(
      "INSERT INTO users (id, email) VALUES ($1, $2)",
      [userId, email],
    );

    await client.query(
      "INSERT INTO organizations (id, name) VALUES ($1, $2)",
      [organizationId, organizationName],
    );

    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [organizationId, userId],
    );

    await client.query(
      `INSERT INTO external_identities (issuer, subject, user_id)
       VALUES ($1, $2, $3)`,
      [issuer, subject, userId],
    );

    await client.query("COMMIT");
    console.log("Bootstrap terminé : utilisateur, organisation et identité associés.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error("Échec du bootstrap :", error instanceof Error ? error.message : "erreur inconnue");
    process.exitCode = 1;
  })
  .finally(() => pool.end());