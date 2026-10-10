import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "La variable DATABASE_URL est obligatoire pour les opérations Drizzle.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./apps/api/src/db/schema.ts",
  out: "./apps/api/drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
