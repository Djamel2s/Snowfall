
import { drizzle } from "drizzle-orm/node-postgres";
import { defineRelations } from "drizzle-orm";
import { Pool } from "pg";

import * as schema from "./schema.js";

const relations = defineRelations(schema);

let poolInstance: Pool | undefined;
let dbInstance: ReturnType<typeof drizzle<typeof relations>> | undefined;

export function getPool(): Pool {
  if (poolInstance) {
    return poolInstance;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("La variable DATABASE_URL est obligatoire.");
  }

  poolInstance = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "snowfall-api",
  });

  poolInstance.on("error", (error) => {
    console.error(
      "Erreur inattendue sur une connexion PostgreSQL inactive.",
      error,
    );
  });

  return poolInstance;
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle<typeof relations>({
      client: getPool(),
      relations,
    });
  }

  return dbInstance;
}
