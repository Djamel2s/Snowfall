
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

import { getDb, getPool } from "../db/pool.js";

const databasePlugin: FastifyPluginAsync = async (app) => {
  const pool = getPool();
  const db = getDb();

  try {
    await pool.query("SELECT 1");
  } catch (error) {
    app.log.error({ err: error }, "Échec de connexion à PostgreSQL.");
    await pool.end();
    throw error;
  }

  app.decorate("db", db);
  app.decorate("pg", pool);

  app.addHook("onClose", async () => {
    await pool.end();
  });

  app.log.info("Connexion PostgreSQL établie.");
};

export default fp(databasePlugin, {
  name: "snowfall-database",
});
