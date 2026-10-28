import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Comptes poussés par l'annuaire de l'entreprise (SCIM 2.0, RFC 7643/7644).
// Une organisation qui en a est gérée par l'annuaire : seul un compte actif
// rejoint à la connexion (voir snowfall_provision_identity).

export type ScimUser = {
  id: string;
  externalId: string | null;
  /** Adresse e-mail, en minuscules. */
  userName: string;
  displayName: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ScimUserInput = { externalId: string | null; userName: string; displayName: string | null; active: boolean };
export type ScimFilter = { attribute: "userName" | "externalId"; value: string };

export interface ScimUserStore {
  list(tenant: TenantContext, filter: ScimFilter | null, startIndex: number, count: number): Promise<{ total: number; items: ScimUser[] }>;
  get(tenant: TenantContext, id: string): Promise<ScimUser | null>;
  /** "conflict" : ce userName existe déjà dans l'organisation. */
  create(tenant: TenantContext, input: ScimUserInput): Promise<ScimUser | "conflict">;
  update(tenant: TenantContext, id: string, input: ScimUserInput): Promise<ScimUser | "conflict" | null>;
  delete(tenant: TenantContext, id: string): Promise<ScimUser | null>;
}

type Row = { id: string; externalId: string | null; userName: string; displayName: string | null; active: boolean; createdAt: string; updatedAt: string };
const COLUMNS = `id, external_id AS "externalId", user_name AS "userName", display_name AS "displayName", active, created_at AS "createdAt", updated_at AS "updatedAt"`;
const view = (row: Row): ScimUser => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() });
const unique = (error: unknown) => (error as { code?: string }).code === "23505";

export class PostgresScimUserStore implements ScimUserStore {
  constructor(private readonly pool: Pool) {}

  list(tenant: TenantContext, filter: ScimFilter | null, startIndex: number, count: number) {
    return withTenant(this.pool, tenant, async (client) => {
      const column = filter?.attribute === "externalId" ? "external_id" : "user_name";
      const where = filter ? `AND ${column} = $2` : "";
      const params: unknown[] = [tenant.organizationId, ...(filter ? [filter.attribute === "userName" ? filter.value.toLowerCase() : filter.value] : [])];
      const total = Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM scim_users WHERE organization_id = $1 ${where}`, params)).rows[0]!.n);
      const rows = await client.query<Row>(
        `SELECT ${COLUMNS} FROM scim_users WHERE organization_id = $1 ${where} ORDER BY created_at, id LIMIT ${Number(count)} OFFSET ${Number(startIndex) - 1}`,
        params,
      );
      return { total, items: rows.rows.map(view) };
    });
  }

  get(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (await client.query<Row>(`SELECT ${COLUMNS} FROM scim_users WHERE id = $1 AND organization_id = $2`, [id, tenant.organizationId])).rows[0];
      return row ? view(row) : null;
    });
  }

  async create(tenant: TenantContext, input: ScimUserInput) {
    try {
      return await withTenant(this.pool, tenant, async (client) =>
        view(
          (
            await client.query<Row>(
              `INSERT INTO scim_users (id, organization_id, external_id, user_name, display_name, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
              [randomUUID(), tenant.organizationId, input.externalId, input.userName, input.displayName, input.active],
            )
          ).rows[0]!,
        ),
      );
    } catch (error) {
      if (unique(error)) return "conflict" as const;
      throw error;
    }
  }

  async update(tenant: TenantContext, id: string, input: ScimUserInput) {
    try {
      return await withTenant(this.pool, tenant, async (client) => {
        const row = (
          await client.query<Row>(
            `UPDATE scim_users SET external_id = $3, user_name = $4, display_name = $5, active = $6, updated_at = now()
             WHERE id = $1 AND organization_id = $2 RETURNING ${COLUMNS}`,
            [id, tenant.organizationId, input.externalId, input.userName, input.displayName, input.active],
          )
        ).rows[0];
        return row ? view(row) : null;
      });
    } catch (error) {
      if (unique(error)) return "conflict" as const;
      throw error;
    }
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (await client.query<Row>(`DELETE FROM scim_users WHERE id = $1 AND organization_id = $2 RETURNING ${COLUMNS}`, [id, tenant.organizationId])).rows[0];
      return row ? view(row) : null;
    });
  }
}

/** En mémoire : développement sans base, tests. */
export class MemoryScimUserStore implements ScimUserStore {
  readonly items: (ScimUser & { organizationId: string })[] = [];

  private of(tenant: TenantContext) {
    return this.items.filter((item) => item.organizationId === tenant.organizationId);
  }

  async list(tenant: TenantContext, filter: ScimFilter | null, startIndex: number, count: number) {
    const all = this.of(tenant).filter((item) => !filter || (filter.attribute === "userName" ? item.userName === filter.value.toLowerCase() : item.externalId === filter.value));
    return { total: all.length, items: all.slice(startIndex - 1, startIndex - 1 + count).map(({ organizationId: _o, ...item }) => item) };
  }

  async get(tenant: TenantContext, id: string) {
    const item = this.of(tenant).find((entry) => entry.id === id);
    if (!item) return null;
    const { organizationId: _o, ...rest } = item;
    return rest;
  }

  async create(tenant: TenantContext, input: ScimUserInput) {
    if (this.of(tenant).some((item) => item.userName === input.userName)) return "conflict" as const;
    const now = new Date().toISOString();
    const item = { id: randomUUID(), ...input, createdAt: now, updatedAt: now, organizationId: tenant.organizationId };
    this.items.push(item);
    const { organizationId: _o, ...rest } = item;
    return rest;
  }

  async update(tenant: TenantContext, id: string, input: ScimUserInput) {
    const item = this.of(tenant).find((entry) => entry.id === id);
    if (!item) return null;
    if (this.of(tenant).some((other) => other.id !== id && other.userName === input.userName)) return "conflict" as const;
    Object.assign(item, input, { updatedAt: new Date().toISOString() });
    const { organizationId: _o, ...rest } = item;
    return rest;
  }

  async delete(tenant: TenantContext, id: string) {
    const index = this.items.findIndex((entry) => entry.id === id && entry.organizationId === tenant.organizationId);
    if (index === -1) return null;
    const [item] = this.items.splice(index, 1);
    const { organizationId: _o, ...rest } = item!;
    return rest;
  }
}
