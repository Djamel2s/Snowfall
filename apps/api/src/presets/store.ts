import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { settingsOf, type ConversationSettings } from "../conversations/store.js";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Préréglages de conversation : réglages nommés (créativité, longueur,
// instructions), privés. Nom et instructions chiffrés.

export type Preset = { id: string; name: string; settings: ConversationSettings; createdAt: string };
export type PresetInput = { name: string; settings: ConversationSettings };

/** Au-delà, l'utilisateur supprime d'abord un préréglage. */
export const MAX_PRESETS = 50;

export interface PresetStore {
  list(tenant: TenantContext): Promise<Preset[]>;
  /** null : plafond atteint. */
  create(tenant: TenantContext, input: PresetInput): Promise<Preset | null>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
}

export const presetAad = (tenant: TenantContext, id: string, field: "name" | "instructions") =>
  `preset-${field}:${tenant.organizationId}:${tenant.userId}:${id}`;

type Row = {
  id: string;
  name: string;
  creativity: ConversationSettings["creativity"] | null;
  length: ConversationSettings["length"] | null;
  instructions: string | null;
  createdAt: string;
};
const COLUMNS = `id, name, creativity, length, instructions, created_at AS "createdAt"`;

export class PostgresPresetStore implements PresetStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async view(client: PoolClient, tenant: TenantContext, row: Row): Promise<Preset> {
    return {
      id: row.id,
      name: await this.keyring.decrypt(client, tenant.organizationId, row.name, presetAad(tenant, row.id, "name")),
      settings: settingsOf({
        creativity: row.creativity ?? undefined,
        length: row.length ?? undefined,
        instructions: row.instructions
          ? await this.keyring.decrypt(client, tenant.organizationId, row.instructions, presetAad(tenant, row.id, "instructions"))
          : undefined,
      }),
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }

  list(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (
        await client.query<Row>(
          `SELECT ${COLUMNS} FROM conversation_presets WHERE organization_id = $1 AND user_id = $2 ORDER BY created_at LIMIT ${MAX_PRESETS}`,
          [tenant.organizationId, tenant.userId],
        )
      ).rows;
      const items: Preset[] = [];
      for (const row of rows) items.push(await this.view(client, tenant, row));
      return items;
    });
  }

  create(tenant: TenantContext, input: PresetInput) {
    return withTenant(this.pool, tenant, async (client) => {
      // Verrou par utilisateur : deux créations simultanées ne dépassent pas le plafond.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`presets:${tenant.organizationId}:${tenant.userId}`]);
      const count = await client.query<{ count: string }>(
        "SELECT count(*) FROM conversation_presets WHERE organization_id = $1 AND user_id = $2",
        [tenant.organizationId, tenant.userId],
      );
      if (Number(count.rows[0]!.count) >= MAX_PRESETS) return null;
      const id = randomUUID();
      const { creativity, length, instructions } = settingsOf(input.settings);
      const row = (
        await client.query<Row>(
          `INSERT INTO conversation_presets (id, organization_id, user_id, name, creativity, length, instructions)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
          [
            id,
            tenant.organizationId,
            tenant.userId,
            await this.keyring.encrypt(client, tenant.organizationId, input.name, presetAad(tenant, id, "name")),
            creativity ?? null,
            length ?? null,
            instructions ? await this.keyring.encrypt(client, tenant.organizationId, instructions, presetAad(tenant, id, "instructions")) : null,
          ],
        )
      ).rows[0]!;
      return this.view(client, tenant, row);
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM conversation_presets WHERE id = $1 AND organization_id = $2 AND user_id = $3", [
        id,
        tenant.organizationId,
        tenant.userId,
      ]);
      return (result.rowCount ?? 0) > 0;
    });
  }
}

/** En mémoire : développement sans base, tests. */
export class MemoryPresetStore implements PresetStore {
  private readonly items = new Map<string, Preset & { tenant: TenantContext }>();

  private mine(tenant: TenantContext) {
    return [...this.items.values()].filter((item) => item.tenant.organizationId === tenant.organizationId && item.tenant.userId === tenant.userId);
  }

  async list(tenant: TenantContext) {
    return this.mine(tenant).map(({ tenant: _tenant, ...item }) => item);
  }

  async create(tenant: TenantContext, input: PresetInput) {
    if (this.mine(tenant).length >= MAX_PRESETS) return null;
    const item = { id: randomUUID(), name: input.name, settings: settingsOf(input.settings), createdAt: new Date().toISOString() };
    this.items.set(item.id, { ...item, tenant });
    return item;
  }

  async delete(tenant: TenantContext, id: string) {
    const item = this.items.get(id);
    if (!item || item.tenant.userId !== tenant.userId || item.tenant.organizationId !== tenant.organizationId) return false;
    return this.items.delete(id);
  }
}
