import { defineConfig } from "drizzle-kit";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({
  path: fileURLToPath(new URL("../../.env", import.meta.url)),
});

// Compte propriétaire du schéma, distinct du compte applicatif (DATABASE_URL).
const databaseUrl = process.env.DATABASE_MIGRATION_URL;

if (!databaseUrl) {
  throw new Error(
    "La variable DATABASE_MIGRATION_URL est obligatoire pour les opérations Drizzle.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
