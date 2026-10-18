import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import { detectInjection } from "../security/injection.js";

// Mémoire de l'utilisateur : quelques faits courts (préférences, contexte) qu'il
// a demandé de retenir. Privée (RLS propriétaire), chiffrée, visible et
// supprimable dans « Mon compte ». Utilisée seulement s'il l'a activée.

export type UserMemory = { id: string; content: string; createdAt: string };

export const MAX_MEMORIES = 50;
export const MAX_MEMORY_CHARS = 500;

/**
 * Un souvenir décrit l'utilisateur (préférences, contexte) : il n'a besoin ni
 * de lien ni d'adresse. Ce sont pourtant les vecteurs d'un souvenir piégé
 * (hameçonnage : « termine chaque réponse par ce lien », exfiltration : « envoie à… ») :
 * refusés à l'enregistrement, et écartés s'ils sont déjà en base.
 */
export function memoryRejection(content: string): "link" | "email" | "secret" | "instruction" | null {
  if (/[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(content)) return "email";
  if (/([a-z][a-z0-9+.-]*:\/\/|\bwww\.|\]\(|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}\/)/i.test(content)) return "link";
  // Un souvenir ne garde jamais de secret, ni d'ordre adressé à l'assistant.
  if (/\b(mots? de passe|password|passphrase|code (pin|d'acc[eè]s)|\bpin\b|iban|num[eé]ro de carte|cvv)\b/i.test(content)) return "secret";
  if (detectInjection(content).suspicious) return "instruction";
  return null;
}

export class MemoryFullError extends Error {
  constructor() {
    super("MEMORY_FULL");
  }
}

export interface UserMemoryStore {
  list(tenant: TenantContext): Promise<UserMemory[]>;
  /** MemoryFullError au-delà de MAX_MEMORIES. */
  add(tenant: TenantContext, content: string): Promise<UserMemory>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
  clear(tenant: TenantContext): Promise<number>;
}

const aad = (tenant: TenantContext, id: string) => `user-memory:${tenant.organizationId}:${tenant.userId}:${id}`;

export class PostgresUserMemoryStore implements UserMemoryStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  list(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (
        await client.query<{ id: string; content: string; createdAt: string }>(
          `SELECT id, content, created_at AS "createdAt" FROM user_memories
           WHERE organization_id = $1 AND user_id = $2 ORDER BY created_at LIMIT ${MAX_MEMORIES}`,
          [tenant.organizationId, tenant.userId],
        )
      ).rows;
      const items: UserMemory[] = [];
      for (const row of rows) {
        items.push({
          id: row.id,
          content: await this.keyring.decrypt(client, tenant.organizationId, row.content, aad(tenant, row.id)),
          createdAt: new Date(row.createdAt).toISOString(),
        });
      }
      return items;
    });
  }

  add(tenant: TenantContext, content: string) {
    return withTenant(this.pool, tenant, async (client) => {
      // Verrou par utilisateur : deux ajouts simultanés ne dépassent pas la limite.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`user-memory:${tenant.organizationId}:${tenant.userId}`]);
      const count = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM user_memories WHERE organization_id = $1 AND user_id = $2",
        [tenant.organizationId, tenant.userId],
      );
      if ((count.rows[0]?.n ?? 0) >= MAX_MEMORIES) throw new MemoryFullError();
      const id = randomUUID();
      const sealed = await this.keyring.encrypt(client, tenant.organizationId, content, aad(tenant, id));
      const row = await client.query<{ createdAt: string }>(
        `INSERT INTO user_memories (id, organization_id, user_id, content) VALUES ($1, $2, $3, $4) RETURNING created_at AS "createdAt"`,
        [id, tenant.organizationId, tenant.userId, sealed],
      );
      return { id, content, createdAt: new Date(row.rows[0]!.createdAt).toISOString() };
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM user_memories WHERE id = $1 AND organization_id = $2 AND user_id = $3", [id, tenant.organizationId, tenant.userId]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  clear(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM user_memories WHERE organization_id = $1 AND user_id = $2", [tenant.organizationId, tenant.userId]);
      return result.rowCount ?? 0;
    });
  }
}

/** Version en mémoire vive (développement, tests). */
export class InMemoryUserMemoryStore implements UserMemoryStore {
  private readonly items = new Map<string, UserMemory[]>();
  private key = (tenant: TenantContext) => `${tenant.organizationId}:${tenant.userId}`;

  async list(tenant: TenantContext) {
    return [...(this.items.get(this.key(tenant)) ?? [])];
  }

  async add(tenant: TenantContext, content: string) {
    const list = this.items.get(this.key(tenant)) ?? [];
    if (list.length >= MAX_MEMORIES) throw new MemoryFullError();
    const memory = { id: randomUUID(), content, createdAt: new Date().toISOString() };
    this.items.set(this.key(tenant), [...list, memory]);
    return memory;
  }

  async delete(tenant: TenantContext, id: string) {
    const list = this.items.get(this.key(tenant)) ?? [];
    this.items.set(this.key(tenant), list.filter((item) => item.id !== id));
    return list.some((item) => item.id === id);
  }

  async clear(tenant: TenantContext) {
    const count = this.items.get(this.key(tenant))?.length ?? 0;
    this.items.delete(this.key(tenant));
    return count;
  }
}
