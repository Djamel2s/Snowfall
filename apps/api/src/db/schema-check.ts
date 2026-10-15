import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import * as schema from "./schema.js";

/**
 * Vérifie au démarrage que la base a reçu toutes les migrations : sans cela,
 * l'API démarre puis échoue à la première requête (« relation does not exist »).
 * Lit uniquement le catalogue PostgreSQL, accessible au rôle applicatif.
 */
export async function findSchemaDrift(pool: Pool): Promise<string[]> {
  const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable));
  const names = tables.map((table) => getTableName(table));

  const { rows } = await pool.query<{ name: string; exists: boolean }>(
    "SELECT name, to_regclass('public.' || quote_ident(name)) IS NOT NULL AS exists FROM unnest($1::text[]) AS name",
    [names],
  );
  const drift = rows.filter((row) => !row.exists).map((row) => `table ${row.name}`);

  // Colonnes ajoutées par une migration récente.
  const { rows: columns } = await pool.query<{ table: string; column: string }>(
    `SELECT table_name AS "table", column_name AS "column"
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [names],
  );
  const present = new Set(columns.map((row) => `${row.table}.${row.column}`));
  for (const table of tables) {
    const name = getTableName(table);
    if (drift.includes(`table ${name}`)) continue;
    for (const column of getTableConfig(table).columns) {
      if (!present.has(`${name}.${column.name}`)) drift.push(`colonne ${name}.${column.name}`);
    }
  }

  // Contrainte des fournisseurs : chaque nouveau fournisseur passe par une migration.
  const { rows: constraint } = await pool.query<{ definition: string }>(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'agents_provider_check'",
  );
  const definition = constraint[0]?.definition;
  if (definition) {
    for (const provider of schema.agentProviders) {
      if (!definition.includes(`'${provider}'`)) drift.push(`fournisseur ${provider}`);
    }
  }

  return drift;
}
