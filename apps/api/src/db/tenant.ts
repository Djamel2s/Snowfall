import type { Pool, PoolClient } from "pg";

export type TenantContext = {
  userId: string;
  organizationId: string;
};

/**
 * Exécute fn dans une transaction où le contexte tenant est posé pour les
 * politiques RLS. set_config(..., true) limite la portée à la transaction :
 * rien ne fuit vers la requête suivante qui réutilise la connexion du pool.
 */
export async function withTenant<T>(
  pool: Pool,
  tenant: TenantContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.organization_id', $1, true),
              set_config('app.user_id', $2, true)`,
      [tenant.organizationId, tenant.userId],
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
