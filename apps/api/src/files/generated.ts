import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Fichiers produits par l'interpréteur de code (graphiques, CSV, tableurs…).
// Créés pendant la réponse (sans message), puis rattachés à la réponse quand
// elle est enregistrée ; les orphelins (réponse arrêtée ou échouée) sont purgés.

export type GeneratedFileMeta = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  messageId: string | null;
  createdAt: string;
  /**
   * Contrôle de fidélité : nombres du document absents des sources (ni déduits).
   * Montrés à la personne sur la carte du fichier : le modèle, lui, ignore l'alerte
   * (mesuré le 20 novembre). Absent : rien à signaler.
   */
  review?: string[];
};

export type GeneratedFileInput = { name: string; mediaType: string; bytes: Buffer; review?: string[] | undefined };

/** Au plus 20 nombres signalés par fichier, 32 caractères chacun. */
export const MAX_REVIEW_NUMBERS = 20;
const reviewOf = (numbers: string[] | undefined) => (numbers ?? []).filter((item) => item.length > 0 && item.length <= 32).slice(0, MAX_REVIEW_NUMBERS);

export interface GeneratedFileStore {
  create(tenant: TenantContext, conversationId: string, input: GeneratedFileInput): Promise<GeneratedFileMeta>;
  /** Rattache les fichiers d'une réponse à son message (seulement ceux encore libres de cette conversation). */
  attach(tenant: TenantContext, conversationId: string, messageId: string, ids: string[]): Promise<number>;
  list(tenant: TenantContext, conversationId: string): Promise<GeneratedFileMeta[]>;
  /** Tous les fichiers de la conversation, y compris ceux de la réponse en cours (pas encore rattachés), du plus ancien au plus récent. */
  listAll(tenant: TenantContext, conversationId: string): Promise<GeneratedFileMeta[]>;
  content(tenant: TenantContext, conversationId: string, id: string): Promise<{ name: string; mediaType: string; bytes: Buffer } | null>;
  /** Fichiers jamais rattachés depuis plus de 24 h (réponse arrêtée, échouée). */
  purgeOrphans(tenant: TenantContext): Promise<number>;
}

export const generatedFileAad = (tenant: TenantContext, id: string, field: "name" | "content" | "review") => `generated-file-${field}:${tenant.organizationId}:${tenant.userId}:${id}`;
const aad = generatedFileAad;

type Row = { id: string; name: string; mediaType: string; size: number; messageId: string | null; createdAt: string; review: string | null };
const META = `id, name, media_type AS "mediaType", size_bytes AS size, message_id AS "messageId", created_at AS "createdAt", review`;

export class PostgresGeneratedFileStore implements GeneratedFileStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async meta(client: PoolClient, tenant: TenantContext, row: Row): Promise<GeneratedFileMeta> {
    const { review, ...rest } = row;
    const meta: GeneratedFileMeta = { ...rest, name: await this.keyring.decrypt(client, tenant.organizationId, row.name, aad(tenant, row.id, "name")) };
    if (review) meta.review = reviewOf(JSON.parse(await this.keyring.decrypt(client, tenant.organizationId, review, aad(tenant, row.id, "review"))) as string[]);
    return meta;
  }

  create(tenant: TenantContext, conversationId: string, input: GeneratedFileInput) {
    return withTenant(this.pool, tenant, async (client) => {
      const id = randomUUID();
      const review = reviewOf(input.review);
      const row = (
        await client.query<Row>(
          `INSERT INTO generated_files (id, organization_id, user_id, conversation_id, media_type, size_bytes, name, content, review)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${META}`,
          [
            id,
            tenant.organizationId,
            tenant.userId,
            conversationId,
            input.mediaType,
            input.bytes.length,
            await this.keyring.encrypt(client, tenant.organizationId, input.name, aad(tenant, id, "name")),
            await this.keyring.encryptBytes(client, tenant.organizationId, input.bytes, aad(tenant, id, "content")),
            review.length ? await this.keyring.encrypt(client, tenant.organizationId, JSON.stringify(review), aad(tenant, id, "review")) : null,
          ],
        )
      ).rows[0]!;
      return this.meta(client, tenant, row);
    });
  }

  attach(tenant: TenantContext, conversationId: string, messageId: string, ids: string[]) {
    if (ids.length === 0) return Promise.resolve(0);
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query(
        "UPDATE generated_files SET message_id = $3 WHERE conversation_id = $1 AND id = ANY($2) AND message_id IS NULL",
        [conversationId, ids, messageId],
      );
      return result.rowCount ?? 0;
    });
  }

  list(tenant: TenantContext, conversationId: string) {
    return this.select(tenant, conversationId, true);
  }

  listAll(tenant: TenantContext, conversationId: string) {
    return this.select(tenant, conversationId, false);
  }

  private select(tenant: TenantContext, conversationId: string, attachedOnly: boolean) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (
        await client.query<Row>(
          `SELECT ${META} FROM generated_files WHERE conversation_id = $1${attachedOnly ? " AND message_id IS NOT NULL" : ""} ORDER BY created_at LIMIT 500`,
          [conversationId],
        )
      ).rows;
      const files: GeneratedFileMeta[] = [];
      for (const row of rows) files.push(await this.meta(client, tenant, row));
      return files;
    });
  }

  content(tenant: TenantContext, conversationId: string, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<Row & { content: string }>(`SELECT ${META}, content FROM generated_files WHERE conversation_id = $1 AND id = $2`, [conversationId, id])
      ).rows[0];
      if (!row) return null;
      return {
        name: (await this.meta(client, tenant, row)).name,
        mediaType: row.mediaType,
        bytes: await this.keyring.decryptBytes(client, tenant.organizationId, row.content, aad(tenant, id, "content")),
      };
    });
  }

  purgeOrphans(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM generated_files WHERE message_id IS NULL AND created_at < now() - interval '24 hours'");
      return result.rowCount ?? 0;
    });
  }
}

type MemoryFile = GeneratedFileMeta & TenantContext & { conversationId: string; bytes: Buffer };

/** En mémoire : développement sans base, tests. */
export class MemoryGeneratedFileStore implements GeneratedFileStore {
  private readonly files = new Map<string, MemoryFile>();

  private mine(tenant: TenantContext, conversationId: string) {
    return [...this.files.values()].filter(
      (file) => file.organizationId === tenant.organizationId && file.userId === tenant.userId && file.conversationId === conversationId,
    );
  }

  private view({ organizationId: _org, userId: _user, conversationId: _conversation, bytes: _bytes, ...meta }: MemoryFile): GeneratedFileMeta {
    return meta;
  }

  async create(tenant: TenantContext, conversationId: string, input: GeneratedFileInput) {
    const review = reviewOf(input.review);
    const file: MemoryFile = {
      id: randomUUID(),
      name: input.name,
      mediaType: input.mediaType,
      size: input.bytes.length,
      messageId: null,
      createdAt: new Date().toISOString(),
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      conversationId,
      bytes: input.bytes,
      ...(review.length ? { review } : {}),
    };
    this.files.set(file.id, file);
    return this.view(file);
  }

  async attach(tenant: TenantContext, conversationId: string, messageId: string, ids: string[]) {
    let count = 0;
    for (const file of this.mine(tenant, conversationId)) {
      if (ids.includes(file.id) && file.messageId === null) {
        file.messageId = messageId;
        count++;
      }
    }
    return count;
  }

  async list(tenant: TenantContext, conversationId: string) {
    return this.mine(tenant, conversationId)
      .filter((file) => file.messageId !== null)
      .map((file) => this.view(file));
  }

  async listAll(tenant: TenantContext, conversationId: string) {
    return this.mine(tenant, conversationId).map((file) => this.view(file));
  }

  async content(tenant: TenantContext, conversationId: string, id: string) {
    const file = this.mine(tenant, conversationId).find((item) => item.id === id);
    return file ? { name: file.name, mediaType: file.mediaType, bytes: file.bytes } : null;
  }

  async purgeOrphans() {
    return 0;
  }
}
