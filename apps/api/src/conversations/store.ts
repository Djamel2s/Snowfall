import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";

export type MessageRole = "user" | "assistant";

export const DEFAULT_CONVERSATION_TITLE = "Nouvelle conversation";

export type ConversationOwner = {
  userId: string;
  organizationId: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredMessage = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
};

export interface ConversationStore {
  list(owner: ConversationOwner): Promise<ConversationSummary[]>;
  create(owner: ConversationOwner, title?: string): Promise<ConversationSummary>;
  getMessages(
    owner: ConversationOwner,
    conversationId: string,
  ): Promise<StoredMessage[] | null>;
  delete(owner: ConversationOwner, conversationId: string): Promise<boolean>;
  appendExchange(
    owner: ConversationOwner,
    conversationId: string,
    userContent: string,
    assistantContent: string,
  ): Promise<{ userMessage: StoredMessage; assistantMessage: StoredMessage } | null>;
}

// L'AAD lie chaque chiffré à son propriétaire et à sa ligne.
function titleAad(owner: ConversationOwner, conversationId: string) {
  return `conversation-title:${owner.organizationId}:${owner.userId}:${conversationId}`;
}

function messageAad(
  owner: ConversationOwner,
  conversationId: string,
  messageId: string,
  role: MessageRole,
) {
  return `message:${owner.organizationId}:${owner.userId}:${conversationId}:${messageId}:${role}`;
}

type ConversationRow = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

type MessageRow = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
};

/**
 * Isolation en profondeur : chaque requête filtre explicitement par
 * (organisation, utilisateur) ET s'exécute sous RLS avec le contexte tenant.
 */
export class PostgresConversationStore implements ConversationStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async decryptTitle(
    client: PoolClient,
    owner: ConversationOwner,
    row: ConversationRow,
  ): Promise<ConversationSummary> {
    return {
      id: row.id,
      title: row.title === null
        ? DEFAULT_CONVERSATION_TITLE
        : await this.keyring.decrypt(
            client,
            owner.organizationId,
            row.title,
            titleAad(owner, row.id),
          ),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async list(owner: ConversationOwner): Promise<ConversationSummary[]> {
    return withTenant(this.pool, owner, async (client) => {
      const result = await client.query<ConversationRow>(
        `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM conversations
         WHERE user_id = $1 AND organization_id = $2
         ORDER BY updated_at DESC
         LIMIT 200`,
        [owner.userId, owner.organizationId],
      );

      const summaries: ConversationSummary[] = [];
      for (const row of result.rows) {
        summaries.push(await this.decryptTitle(client, owner, row));
      }
      return summaries;
    });
  }

  async create(
    owner: ConversationOwner,
    title?: string,
  ): Promise<ConversationSummary> {
    return withTenant(this.pool, owner, async (client) => {
      const id = randomUUID();
      const encryptedTitle = title
        ? await this.keyring.encrypt(client, owner.organizationId, title, titleAad(owner, id))
        : null;

      const result = await client.query<ConversationRow>(
        `INSERT INTO conversations (id, user_id, organization_id, title)
         SELECT $1, $2, $3, $4
         WHERE EXISTS (
           SELECT 1 FROM organization_members
           WHERE user_id = $2 AND organization_id = $3
         )
         RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [id, owner.userId, owner.organizationId, encryptedTitle],
      );

      const row = result.rows[0];
      if (!row) throw new Error("MEMBERSHIP_REQUIRED");

      return {
        id: row.id,
        title: title ?? DEFAULT_CONVERSATION_TITLE,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  async getMessages(
    owner: ConversationOwner,
    conversationId: string,
  ): Promise<StoredMessage[] | null> {
    return withTenant(this.pool, owner, async (client) => {
      const exists = await client.query(
        `SELECT 1 FROM conversations
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [conversationId, owner.userId, owner.organizationId],
      );
      if (!exists.rowCount) return null;

      const result = await client.query<MessageRow>(
        `SELECT id, role, content, created_at AS "createdAt"
         FROM messages
         WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3
         ORDER BY created_at ASC, id ASC`,
        [conversationId, owner.userId, owner.organizationId],
      );

      const messages: StoredMessage[] = [];
      for (const row of result.rows) {
        messages.push({
          ...row,
          content: await this.keyring.decrypt(
            client,
            owner.organizationId,
            row.content,
            messageAad(owner, conversationId, row.id, row.role),
          ),
        });
      }
      return messages;
    });
  }

  async delete(
    owner: ConversationOwner,
    conversationId: string,
  ): Promise<boolean> {
    return withTenant(this.pool, owner, async (client) => {
      const result = await client.query(
        `DELETE FROM conversations
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [conversationId, owner.userId, owner.organizationId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async appendExchange(
    owner: ConversationOwner,
    conversationId: string,
    userContent: string,
    assistantContent: string,
  ) {
    return withTenant(this.pool, owner, async (client) => {
      const conversation = await client.query<{ title: string | null }>(
        `SELECT title FROM conversations
         WHERE id = $1 AND user_id = $2 AND organization_id = $3
         FOR UPDATE`,
        [conversationId, owner.userId, owner.organizationId],
      );
      const current = conversation.rows[0];
      if (!current) return null;

      const insert = async (role: MessageRole, content: string) => {
        const id = randomUUID();
        const encrypted = await this.keyring.encrypt(
          client,
          owner.organizationId,
          content,
          messageAad(owner, conversationId, id, role),
        );
        const result = await client.query<MessageRow>(
          `INSERT INTO messages
             (id, conversation_id, user_id, organization_id, role, content, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
           RETURNING id, role, created_at AS "createdAt"`,
          [id, conversationId, owner.userId, owner.organizationId, role, encrypted],
        );
        return { ...result.rows[0]!, content } as StoredMessage;
      };

      const userMessage = await insert("user", userContent);
      const assistantMessage = await insert("assistant", assistantContent);

      const title = current.title ?? await this.keyring.encrypt(
        client,
        owner.organizationId,
        userContent.slice(0, 80),
        titleAad(owner, conversationId),
      );

      await client.query(
        `UPDATE conversations SET title = $4, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [conversationId, owner.userId, owner.organizationId, title],
      );

      return { userMessage, assistantMessage };
    });
  }
}
