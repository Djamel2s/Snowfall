import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import type { ModelImage } from "../graph/chat-graph.js";
import type { DetectedFile } from "./detect.js";

export type AttachmentMeta = {
  id: string;
  name: string;
  kind: "document" | "image";
  mediaType: string;
  size: number;
  messageId: string | null;
  createdAt: string;
};

/** Pièce jointe prête pour le modèle : texte extrait ou image en base64. */
export type ModelAttachment =
  | { kind: "document"; name: string; text: string }
  | { kind: "image"; name: string; image: ModelImage };

export const MAX_PENDING_PER_CONVERSATION = 10;
const ORPHAN_HOURS = 24;

export interface AttachmentStore {
  create(
    tenant: TenantContext,
    conversationId: string,
    input: { name: string; file: DetectedFile; bytes: Buffer; text: string | null },
  ): Promise<AttachmentMeta | null>;
  /** Pièces jointes encore libres (ou celles du message modifié) de la conversation. */
  claimable(
    tenant: TenantContext,
    conversationId: string,
    ids: string[],
    editedMessageId?: string,
  ): Promise<AttachmentMeta[]>;
  forModel(tenant: TenantContext, conversationId: string, ids: string[]): Promise<Map<string, ModelAttachment>>;
  content(tenant: TenantContext, id: string): Promise<{ name: string; mediaType: string; bytes: Buffer } | null>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
  /** Mes fichiers : ceux déjà envoyés, toutes conversations (hors temporaires), récents d'abord. */
  library(tenant: TenantContext): Promise<LibraryFile[]>;
  /**
   * Réutiliser un fichier : copie, rechiffrée, en attente d'envoi dans une autre
   * conversation. Fichier d'une conversation sensible : la cible le devient aussi
   * (modèle local). null : fichier ou conversation introuvable, ou source temporaire.
   */
  copy(tenant: TenantContext, id: string, conversationId: string): Promise<{ attachment: AttachmentMeta; sensitive: boolean } | null>;
  /** Supprimer un fichier, même envoyé (le message garde son texte). */
  remove(tenant: TenantContext, id: string): Promise<boolean>;
}

export type LibraryFile = AttachmentMeta & { conversationId: string };

/** Taille de la liste « Mes fichiers ». */
export const LIBRARY_LIMIT = 200;

export const attachmentAad = (tenant: TenantContext, id: string, field: "name" | "content" | "text") =>
  `attachment-${field}:${tenant.organizationId}:${tenant.userId}:${id}`;

type MetaRow = {
  id: string;
  name: string;
  kind: "document" | "image";
  mediaType: string;
  size: number;
  messageId: string | null;
  createdAt: string;
};

const META = `id, name, kind, media_type AS "mediaType", size_bytes AS size,
  message_id AS "messageId", created_at AS "createdAt"`;

export async function decryptMeta(
  keyring: OrganizationKeyring,
  client: PoolClient,
  tenant: TenantContext,
  row: MetaRow,
): Promise<AttachmentMeta> {
  return {
    ...row,
    name: await keyring.decrypt(client, tenant.organizationId, row.name, attachmentAad(tenant, row.id, "name")),
  };
}

export class PostgresAttachmentStore implements AttachmentStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  create(
    tenant: TenantContext,
    conversationId: string,
    input: { name: string; file: DetectedFile; bytes: Buffer; text: string | null },
  ) {
    return withTenant(this.pool, tenant, async (client) => {
      // Fichiers jamais envoyés : purgés à l'occasion d'un nouvel envoi.
      await client.query(
        `DELETE FROM attachments
         WHERE user_id = $1 AND organization_id = $2 AND message_id IS NULL
           AND created_at < now() - make_interval(hours => $3)`,
        [tenant.userId, tenant.organizationId, ORPHAN_HOURS],
      );

      const conversation = await client.query(
        "SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND organization_id = $3",
        [conversationId, tenant.userId, tenant.organizationId],
      );
      if (!conversation.rowCount) return null;

      const pending = await client.query<{ count: string }>(
        `SELECT count(*) FROM attachments
         WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3 AND message_id IS NULL`,
        [conversationId, tenant.userId, tenant.organizationId],
      );
      if (Number(pending.rows[0]!.count) >= MAX_PENDING_PER_CONVERSATION) throw new Error("TOO_MANY_ATTACHMENTS");

      const id = randomUUID();
      const encrypt = (value: string, field: "name" | "text") =>
        this.keyring.encrypt(client, tenant.organizationId, value, attachmentAad(tenant, id, field));

      const result = await client.query<MetaRow>(
        `INSERT INTO attachments
           (id, organization_id, user_id, conversation_id, kind, media_type, size_bytes, name, content, extracted_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${META}`,
        [
          id,
          tenant.organizationId,
          tenant.userId,
          conversationId,
          input.file.kind,
          input.file.mediaType,
          input.bytes.length,
          await encrypt(input.name, "name"),
          await this.keyring.encryptBytes(client, tenant.organizationId, input.bytes, attachmentAad(tenant, id, "content")),
          input.text === null ? null : await encrypt(input.text, "text"),
        ],
      );
      return { ...result.rows[0]!, name: input.name };
    });
  }

  claimable(tenant: TenantContext, conversationId: string, ids: string[], editedMessageId?: string) {
    if (ids.length === 0) return Promise.resolve([]);
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<MetaRow>(
        `SELECT ${META} FROM attachments
         WHERE id = ANY($1::uuid[]) AND conversation_id = $2 AND user_id = $3 AND organization_id = $4
           AND (message_id IS NULL OR message_id = $5)`,
        [ids, conversationId, tenant.userId, tenant.organizationId, editedMessageId ?? null],
      );
      const items: AttachmentMeta[] = [];
      for (const row of result.rows) items.push(await decryptMeta(this.keyring, client, tenant, row));
      return items;
    });
  }

  forModel(tenant: TenantContext, conversationId: string, ids: string[]) {
    return withTenant(this.pool, tenant, async (client) => {
      const map = new Map<string, ModelAttachment>();
      if (ids.length === 0) return map;

      const result = await client.query<{
        id: string;
        kind: "document" | "image";
        mediaType: ModelImage["mediaType"];
        name: string;
        content: string;
        text: string | null;
      }>(
        `SELECT id, kind, media_type AS "mediaType", name,
                CASE WHEN kind = 'image' THEN content END AS content, extracted_text AS text
         FROM attachments
         WHERE id = ANY($1::uuid[]) AND conversation_id = $2 AND user_id = $3 AND organization_id = $4`,
        [ids, conversationId, tenant.userId, tenant.organizationId],
      );

      for (const row of result.rows) {
        const name = await this.keyring.decrypt(client, tenant.organizationId, row.name, attachmentAad(tenant, row.id, "name"));
        if (row.kind === "image") {
          const bytes = await this.keyring.decryptBytes(
            client,
            tenant.organizationId,
            row.content,
            attachmentAad(tenant, row.id, "content"),
          );
          map.set(row.id, { kind: "image", name, image: { mediaType: row.mediaType, data: bytes.toString("base64") } });
        } else {
          const text = row.text
            ? await this.keyring.decrypt(client, tenant.organizationId, row.text, attachmentAad(tenant, row.id, "text"))
            : "";
          map.set(row.id, { kind: "document", name, text });
        }
      }
      return map;
    });
  }

  content(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{ name: string; mediaType: string; content: string }>(
        `SELECT name, media_type AS "mediaType", content FROM attachments
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [id, tenant.userId, tenant.organizationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        name: await this.keyring.decrypt(client, tenant.organizationId, row.name, attachmentAad(tenant, id, "name")),
        mediaType: row.mediaType,
        bytes: await this.keyring.decryptBytes(client, tenant.organizationId, row.content, attachmentAad(tenant, id, "content")),
      };
    });
  }

  library(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<MetaRow & { conversationId: string }>(
        `SELECT a.id, a.name, a.kind, a.media_type AS "mediaType", a.size_bytes AS size,
                a.message_id AS "messageId", a.created_at AS "createdAt", a.conversation_id AS "conversationId"
         FROM attachments a
         JOIN conversations c ON c.id = a.conversation_id AND c.user_id = a.user_id AND c.organization_id = a.organization_id
         WHERE a.user_id = $1 AND a.organization_id = $2 AND a.message_id IS NOT NULL AND NOT c.temporary
         ORDER BY a.created_at DESC
         LIMIT ${LIBRARY_LIMIT}`,
        [tenant.userId, tenant.organizationId],
      );
      const items: LibraryFile[] = [];
      for (const { conversationId, ...row } of result.rows) items.push({ ...(await decryptMeta(this.keyring, client, tenant, row)), conversationId });
      return items;
    });
  }

  copy(tenant: TenantContext, id: string, conversationId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const source = (
        await client.query<{ kind: "document" | "image"; mediaType: string; name: string; content: string; text: string | null; sensitive: boolean; temporary: boolean }>(
          `SELECT a.kind, a.media_type AS "mediaType", a.name, a.content, a.extracted_text AS text, c.sensitive, c.temporary
           FROM attachments a
           JOIN conversations c ON c.id = a.conversation_id AND c.user_id = a.user_id AND c.organization_id = a.organization_id
           WHERE a.id = $1 AND a.user_id = $2 AND a.organization_id = $3`,
          [id, tenant.userId, tenant.organizationId],
        )
      ).rows[0];
      // Une conversation temporaire ne laisse rien derrière elle, ses fichiers non plus.
      if (!source || source.temporary) return null;
      const target = await client.query(
        "SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND organization_id = $3 FOR UPDATE",
        [conversationId, tenant.userId, tenant.organizationId],
      );
      if (!target.rowCount) return null;
      const pending = await client.query<{ count: string }>(
        `SELECT count(*) FROM attachments
         WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3 AND message_id IS NULL`,
        [conversationId, tenant.userId, tenant.organizationId],
      );
      if (Number(pending.rows[0]!.count) >= MAX_PENDING_PER_CONVERSATION) throw new Error("TOO_MANY_ATTACHMENTS");

      // Déchiffré sous l'identité de la source, rechiffré sous celle de la copie (AAD).
      const name = await this.keyring.decrypt(client, tenant.organizationId, source.name, attachmentAad(tenant, id, "name"));
      const bytes = await this.keyring.decryptBytes(client, tenant.organizationId, source.content, attachmentAad(tenant, id, "content"));
      const text = source.text === null ? null : await this.keyring.decrypt(client, tenant.organizationId, source.text, attachmentAad(tenant, id, "text"));
      const copyId = randomUUID();
      const seal = (value: string, field: "name" | "text") => this.keyring.encrypt(client, tenant.organizationId, value, attachmentAad(tenant, copyId, field));
      const row = (
        await client.query<MetaRow>(
          `INSERT INTO attachments
             (id, organization_id, user_id, conversation_id, kind, media_type, size_bytes, name, content, extracted_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING ${META}`,
          [
            copyId,
            tenant.organizationId,
            tenant.userId,
            conversationId,
            source.kind,
            source.mediaType,
            bytes.length,
            await seal(name, "name"),
            await this.keyring.encryptBytes(client, tenant.organizationId, bytes, attachmentAad(tenant, copyId, "content")),
            text === null ? null : await seal(text, "text"),
          ],
        )
      ).rows[0]!;
      if (source.sensitive) {
        await client.query("UPDATE conversations SET sensitive = true WHERE id = $1 AND user_id = $2 AND organization_id = $3", [
          conversationId,
          tenant.userId,
          tenant.organizationId,
        ]);
      }
      return { attachment: { ...row, name }, sensitive: source.sensitive };
    });
  }

  remove(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM attachments WHERE id = $1 AND user_id = $2 AND organization_id = $3", [id, tenant.userId, tenant.organizationId]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      // Seule une pièce jointe pas encore envoyée peut être retirée.
      const result = await client.query(
        `DELETE FROM attachments
         WHERE id = $1 AND user_id = $2 AND organization_id = $3 AND message_id IS NULL`,
        [id, tenant.userId, tenant.organizationId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
