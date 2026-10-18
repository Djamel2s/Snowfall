import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Bibliothèque de prompts : privés, ou partagés avec l'organisation (lecture).
// Seul l'auteur modifie ou supprime un prompt.

export type Prompt = { id: string; name: string; content: string; shared: boolean; mine: boolean; updatedAt: string };
export type PromptInput = { name: string; content: string; shared: boolean };

export interface PromptStore {
  list(tenant: TenantContext): Promise<Prompt[]>;
  create(tenant: TenantContext, input: PromptInput): Promise<Prompt>;
  update(tenant: TenantContext, id: string, input: PromptInput): Promise<Prompt | null>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
}

/** Variables d'un prompt : {{nom}}, dans l'ordre d'apparition, sans doublon. */
export function promptVariables(content: string) {
  return [...new Set([...content.matchAll(/\{\{\s*([\p{L}\p{N}_ -]{1,40}?)\s*\}\}/gu)].map((match) => match[1]!.trim()))];
}

const aad = (tenant: TenantContext, id: string, field: "name" | "content") => `prompt-${field}:${tenant.organizationId}:${id}`;
type Row = { id: string; userId: string; name: string; content: string; shared: boolean; updatedAt: string };
const COLUMNS = `id, user_id AS "userId", name, content, shared, updated_at AS "updatedAt"`;

export class PostgresPromptStore implements PromptStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async view(client: PoolClient, tenant: TenantContext, row: Row): Promise<Prompt> {
    return {
      id: row.id,
      name: await this.keyring.decrypt(client, tenant.organizationId, row.name, aad(tenant, row.id, "name")),
      content: await this.keyring.decrypt(client, tenant.organizationId, row.content, aad(tenant, row.id, "content")),
      shared: row.shared,
      mine: row.userId === tenant.userId,
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  private seal(client: PoolClient, tenant: TenantContext, id: string, input: PromptInput) {
    return Promise.all([
      this.keyring.encrypt(client, tenant.organizationId, input.name, aad(tenant, id, "name")),
      this.keyring.encrypt(client, tenant.organizationId, input.content, aad(tenant, id, "content")),
    ]);
  }

  list(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      // RLS : les siens et ceux partagés dans l'organisation.
      const rows = (await client.query<Row>(`SELECT ${COLUMNS} FROM prompts WHERE organization_id = $1 ORDER BY updated_at DESC LIMIT 500`, [tenant.organizationId])).rows;
      const items: Prompt[] = [];
      for (const row of rows) items.push(await this.view(client, tenant, row));
      return items;
    });
  }

  create(tenant: TenantContext, input: PromptInput) {
    return withTenant(this.pool, tenant, async (client) => {
      const id = randomUUID();
      const [name, content] = await this.seal(client, tenant, id, input);
      const row = (
        await client.query<Row>(
          `INSERT INTO prompts (id, organization_id, user_id, name, content, shared) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
          [id, tenant.organizationId, tenant.userId, name, content, input.shared],
        )
      ).rows[0]!;
      return this.view(client, tenant, row);
    });
  }

  update(tenant: TenantContext, id: string, input: PromptInput) {
    return withTenant(this.pool, tenant, async (client) => {
      const [name, content] = await this.seal(client, tenant, id, input);
      const row = (
        await client.query<Row>(
          `UPDATE prompts SET name = $4, content = $5, shared = $6, updated_at = now()
           WHERE id = $1 AND organization_id = $2 AND user_id = $3 RETURNING ${COLUMNS}`,
          [id, tenant.organizationId, tenant.userId, name, content, input.shared],
        )
      ).rows[0];
      return row ? this.view(client, tenant, row) : null;
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM prompts WHERE id = $1 AND organization_id = $2 AND user_id = $3", [id, tenant.organizationId, tenant.userId]);
      return (result.rowCount ?? 0) > 0;
    });
  }
}

/** En mémoire : développement sans base, tests. */
export class MemoryPromptStore implements PromptStore {
  private readonly items = new Map<string, Omit<Prompt, "mine"> & { tenant: TenantContext }>();

  private visible(tenant: TenantContext) {
    return [...this.items.values()].filter((item) => item.tenant.organizationId === tenant.organizationId && (item.shared || item.tenant.userId === tenant.userId));
  }

  private view({ tenant: owner, ...item }: Omit<Prompt, "mine"> & { tenant: TenantContext }, tenant: TenantContext): Prompt {
    return { ...item, mine: owner.userId === tenant.userId };
  }

  async list(tenant: TenantContext) {
    return this.visible(tenant).map((item) => this.view(item, tenant));
  }

  async create(tenant: TenantContext, input: PromptInput) {
    const item = { id: randomUUID(), ...input, updatedAt: new Date().toISOString(), tenant };
    this.items.set(item.id, item);
    return this.view(item, tenant);
  }

  async update(tenant: TenantContext, id: string, input: PromptInput) {
    const item = this.items.get(id);
    if (!item || item.tenant.userId !== tenant.userId || item.tenant.organizationId !== tenant.organizationId) return null;
    Object.assign(item, input, { updatedAt: new Date().toISOString() });
    return this.view(item, tenant);
  }

  async delete(tenant: TenantContext, id: string) {
    const item = this.items.get(id);
    if (!item || item.tenant.userId !== tenant.userId || item.tenant.organizationId !== tenant.organizationId) return false;
    return this.items.delete(id);
  }
}
