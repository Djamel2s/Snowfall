import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Bibliothèque de prompts : privés, ou partagés (personne, groupe, organisation ;
// lecture ou modification, voir sharing/). Seul l'auteur supprime ou partage.

export type Prompt = {
  id: string;
  name: string;
  content: string;
  mine: boolean;
  /** Partagé avec au moins quelqu'un (vu par son auteur). */
  shared: boolean;
  /** L'auteur, ou un éditeur autorisé. */
  canEdit: boolean;
  updatedAt: string;
};
export type PromptInput = { name: string; content: string };

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

export const promptAad = (tenant: TenantContext, id: string, field: "name" | "content") => `prompt-${field}:${tenant.organizationId}:${id}`;
const aad = promptAad;
type Row = { id: string; userId: string; name: string; content: string; shared: boolean; access: "view" | "edit" | null; updatedAt: string };
const COLUMNS = `id, user_id AS "userId", name, content, updated_at AS "updatedAt",
  snowfall_access('prompt', id) AS access,
  EXISTS (SELECT 1 FROM resource_grants g WHERE g.organization_id = prompts.organization_id AND g.resource_type = 'prompt' AND g.resource_id = prompts.id) AS shared`;

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
      mine: row.userId === tenant.userId,
      shared: row.userId === tenant.userId && row.shared,
      canEdit: row.userId === tenant.userId || row.access === "edit",
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
      // RLS : les siens et ceux qu'on lui partage (personne, groupe, organisation).
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
          `INSERT INTO prompts (id, organization_id, user_id, name, content) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
          [id, tenant.organizationId, tenant.userId, name, content],
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
          // L'auteur, ou un éditeur autorisé (la RLS le vérifie aussi) ; jamais l'auteur changé.
          `UPDATE prompts SET name = $4, content = $5, updated_at = now()
           WHERE id = $1 AND organization_id = $2 AND (user_id = $3 OR snowfall_access('prompt', id) = 'edit') RETURNING ${COLUMNS}`,
          [id, tenant.organizationId, tenant.userId, name, content],
        )
      ).rows[0];
      return row ? this.view(client, tenant, row) : null;
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const owned = await client.query("SELECT 1 FROM prompts WHERE id = $1 AND organization_id = $2 AND user_id = $3", [id, tenant.organizationId, tenant.userId]);
      if (!owned.rowCount) return false;
      // Ses autorisations partent avec lui.
      await client.query("DELETE FROM resource_grants WHERE organization_id = $1 AND resource_type = 'prompt' AND resource_id = $2", [tenant.organizationId, id]);
      const result = await client.query("DELETE FROM prompts WHERE id = $1 AND organization_id = $2 AND user_id = $3", [id, tenant.organizationId, tenant.userId]);
      return (result.rowCount ?? 0) > 0;
    });
  }
}

type MemoryPrompt = { id: string; name: string; content: string; updatedAt: string; tenant: TenantContext };

/**
 * En mémoire : développement sans base, tests. Partage : `access` dit, pour un
 * prompt et un utilisateur, le droit accordé (fourni par le magasin de partage).
 */
export class MemoryPromptStore implements PromptStore {
  private readonly items = new Map<string, MemoryPrompt>();

  constructor(private readonly access: (tenant: TenantContext, id: string) => "view" | "edit" | null = () => null) {}

  private visible(tenant: TenantContext) {
    return [...this.items.values()].filter((item) => item.tenant.organizationId === tenant.organizationId && (item.tenant.userId === tenant.userId || this.access(tenant, item.id)));
  }

  private view({ tenant: owner, ...item }: MemoryPrompt, tenant: TenantContext): Prompt {
    const mine = owner.userId === tenant.userId;
    return { ...item, mine, shared: false, canEdit: mine || this.access(tenant, item.id) === "edit" };
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
    if (!item || item.tenant.organizationId !== tenant.organizationId) return null;
    if (item.tenant.userId !== tenant.userId && this.access(tenant, id) !== "edit") return null;
    Object.assign(item, { name: input.name, content: input.content, updatedAt: new Date().toISOString() });
    return this.view(item, tenant);
  }

  async delete(tenant: TenantContext, id: string) {
    const item = this.items.get(id);
    if (!item || item.tenant.userId !== tenant.userId || item.tenant.organizationId !== tenant.organizationId) return false;
    return this.items.delete(id);
  }
}
