import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Partage interne : un instantané figé, lisible par l'organisation jusqu'à son
// expiration. Le jeton est le secret du lien ; seul son hachage sert à la recherche.

export type SharedMessage = { role: "user" | "assistant"; content: string; createdAt: string; sources?: { n: number; name: string }[] };

export type ShareSnapshot = {
  /** Agent qui répondait (nom et avatar seulement). */
  agent?: { name: string; avatar: unknown } | undefined;
  messages: SharedMessage[];
};

export type ShareRecord = { id: string; token: string; expiresAt: string; createdAt: string };
export type OpenedShare = { id: string; title: string; snapshot: ShareSnapshot; expiresAt: string; createdAt: string; mine: boolean };

export const SHARE_DURATIONS = [1, 7, 30] as const;

export interface ShareStore {
  create(tenant: TenantContext, input: { conversationId: string; title: string; snapshot: ShareSnapshot; days: number }): Promise<ShareRecord>;
  /** Liens encore valides d'une conversation (son auteur seulement). */
  list(tenant: TenantContext, conversationId: string): Promise<ShareRecord[]>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
  /** Ouverture par un membre de l'organisation ; null si inconnu ou expiré. */
  open(tenant: TenantContext, token: string): Promise<OpenedShare | null>;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export const shareAad = (tenant: TenantContext, id: string, field: "token" | "title" | "snapshot") => `conversation-share-${field}:${tenant.organizationId}:${id}`;
const aad = shareAad;
/** 256 bits, encodés pour une URL. */
export const newShareToken = () => randomBytes(32).toString("base64url");

type Row = { id: string; userId: string; token: string; title: string; snapshot: string; expiresAt: string; createdAt: string };

export class PostgresShareStore implements ShareStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private reveal(client: PoolClient, tenant: TenantContext, row: Row, field: "token" | "title" | "snapshot", value: string) {
    // AAD rattachée au propriétaire du partage (l'organisation) et à la ligne.
    return this.keyring.decrypt(client, tenant.organizationId, value, aad(tenant, row.id, field));
  }

  create(tenant: TenantContext, input: { conversationId: string; title: string; snapshot: ShareSnapshot; days: number }) {
    return withTenant(this.pool, tenant, async (client) => {
      const token = newShareToken();
      const id = (await client.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]!.id;
      const seal = (value: string, field: "token" | "title" | "snapshot") => this.keyring.encrypt(client, tenant.organizationId, value, aad(tenant, id, field));
      const row = (
        await client.query<{ expiresAt: string; createdAt: string }>(
          `INSERT INTO conversation_shares (id, organization_id, user_id, conversation_id, token_hash, token, title, snapshot, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9))
           RETURNING expires_at AS "expiresAt", created_at AS "createdAt"`,
          [id, tenant.organizationId, tenant.userId, input.conversationId, hash(token), await seal(token, "token"), await seal(input.title, "title"), await seal(JSON.stringify(input.snapshot), "snapshot"), input.days],
        )
      ).rows[0]!;
      return { id, token, expiresAt: new Date(row.expiresAt).toISOString(), createdAt: new Date(row.createdAt).toISOString() };
    });
  }

  list(tenant: TenantContext, conversationId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (
        await client.query<Row>(
          `SELECT id, user_id AS "userId", token, title, snapshot, expires_at AS "expiresAt", created_at AS "createdAt"
           FROM conversation_shares
           WHERE conversation_id = $1 AND organization_id = $2 AND user_id = $3 AND expires_at > now()
           ORDER BY created_at DESC`,
          [conversationId, tenant.organizationId, tenant.userId],
        )
      ).rows;
      const shares: ShareRecord[] = [];
      for (const row of rows) {
        shares.push({ id: row.id, token: await this.reveal(client, tenant, row, "token", row.token), expiresAt: new Date(row.expiresAt).toISOString(), createdAt: new Date(row.createdAt).toISOString() });
      }
      return shares;
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM conversation_shares WHERE id = $1 AND organization_id = $2 AND user_id = $3", [id, tenant.organizationId, tenant.userId]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  open(tenant: TenantContext, token: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<Row>(
          `SELECT id, user_id AS "userId", token, title, snapshot, expires_at AS "expiresAt", created_at AS "createdAt"
           FROM conversation_shares
           WHERE token_hash = $1 AND organization_id = $2 AND expires_at > now()`,
          [hash(token), tenant.organizationId],
        )
      ).rows[0];
      if (!row) return null;
      return {
        id: row.id,
        title: await this.reveal(client, tenant, row, "title", row.title),
        snapshot: JSON.parse(await this.reveal(client, tenant, row, "snapshot", row.snapshot)) as ShareSnapshot,
        expiresAt: new Date(row.expiresAt).toISOString(),
        createdAt: new Date(row.createdAt).toISOString(),
        mine: row.userId === tenant.userId,
      };
    });
  }
}

/** En mémoire : développement sans base, tests. */
export class MemoryShareStore implements ShareStore {
  private readonly shares = new Map<string, ShareRecord & { tenant: TenantContext; conversationId: string; title: string; snapshot: ShareSnapshot; hash: string }>();
  now = () => Date.now();

  async create(tenant: TenantContext, input: { conversationId: string; title: string; snapshot: ShareSnapshot; days: number }) {
    const token = newShareToken();
    const created = new Date(this.now());
    const record = { id: crypto.randomUUID(), token, expiresAt: new Date(created.getTime() + input.days * 86_400_000).toISOString(), createdAt: created.toISOString() };
    this.shares.set(record.id, { ...record, tenant, conversationId: input.conversationId, title: input.title, snapshot: structuredClone(input.snapshot), hash: hash(token) });
    return record;
  }

  async list(tenant: TenantContext, conversationId: string) {
    return [...this.shares.values()]
      .filter((share) => share.conversationId === conversationId && share.tenant.userId === tenant.userId && share.tenant.organizationId === tenant.organizationId && Date.parse(share.expiresAt) > this.now())
      .map(({ id, token, expiresAt, createdAt }) => ({ id, token, expiresAt, createdAt }));
  }

  async delete(tenant: TenantContext, id: string) {
    const share = this.shares.get(id);
    if (!share || share.tenant.userId !== tenant.userId || share.tenant.organizationId !== tenant.organizationId) return false;
    return this.shares.delete(id);
  }

  async open(tenant: TenantContext, token: string) {
    const share = [...this.shares.values()].find((item) => item.hash === hash(token) && item.tenant.organizationId === tenant.organizationId);
    if (!share || Date.parse(share.expiresAt) <= this.now()) return null;
    return { id: share.id, title: share.title, snapshot: structuredClone(share.snapshot), expiresAt: share.expiresAt, createdAt: share.createdAt, mine: share.tenant.userId === tenant.userId };
  }
}
