import type { Pool } from "pg";

export type MessageRole = "user" | "assistant";

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
  addMessage(
    owner: ConversationOwner,
    conversationId: string,
    role: MessageRole,
    content: string,
  ): Promise<StoredMessage | null>;
}

export class PostgresConversationStore implements ConversationStore {
  constructor(private readonly pool: Pool) {}

  async list(owner: ConversationOwner): Promise<ConversationSummary[]> {
    const result = await this.pool.query(
      `SELECT id, title, created_at AS "createdAt",
              updated_at AS "updatedAt"
       FROM conversations
       WHERE user_id = $1 AND organization_id = $2
       ORDER BY updated_at DESC
       LIMIT 200`,
      [owner.userId, owner.organizationId],
    );

    return result.rows;
  }

  async create(
    owner: ConversationOwner,
    title = "Nouvelle conversation",
  ): Promise<ConversationSummary> {
    const result = await this.pool.query(
      `INSERT INTO conversations (user_id, organization_id, title)
       SELECT $1, $2, $3
       WHERE EXISTS (
         SELECT 1 FROM organization_members
         WHERE user_id = $1 AND organization_id = $2
       )
       RETURNING id, title, created_at AS "createdAt",
                 updated_at AS "updatedAt"`,
      [owner.userId, owner.organizationId, title],
    );

    if (!result.rowCount) {
      throw new Error("MEMBERSHIP_REQUIRED");
    }

    return result.rows[0] as ConversationSummary;
  }

  async getMessages(
    owner: ConversationOwner,
    conversationId: string,
  ): Promise<StoredMessage[] | null> {
    const exists = await this.pool.query(
      `SELECT 1 FROM conversations
       WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
      [conversationId, owner.userId, owner.organizationId],
    );

    if (!exists.rowCount) return null;

    const result = await this.pool.query(
      `SELECT id, role, content, created_at AS "createdAt"
       FROM messages
       WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3
       ORDER BY created_at ASC, id ASC`,
      [conversationId, owner.userId, owner.organizationId],
    );

    return result.rows as StoredMessage[];
  }

  async delete(
    owner: ConversationOwner,
    conversationId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM conversations
       WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
      [conversationId, owner.userId, owner.organizationId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async addMessage(
    owner: ConversationOwner,
    conversationId: string,
    role: MessageRole,
    content: string,
  ): Promise<StoredMessage | null> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const conversation = await client.query(
        `SELECT id, title FROM conversations
         WHERE id = $1 AND user_id = $2 AND organization_id = $3
         FOR UPDATE`,
        [conversationId, owner.userId, owner.organizationId],
      );

      if (!conversation.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }

      const inserted = await client.query(
        `INSERT INTO messages
           (conversation_id, user_id, organization_id, role, content)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, role, content, created_at AS "createdAt"`,
        [conversationId, owner.userId, owner.organizationId, role, content],
      );

      const title =
        role === "user" && conversation.rows[0].title === "Nouvelle conversation"
          ? content.slice(0, 80)
          : conversation.rows[0].title;

      await client.query(
        `UPDATE conversations
         SET title = $4, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [conversationId, owner.userId, owner.organizationId, title],
      );

      await client.query("COMMIT");
      return inserted.rows[0] as StoredMessage;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
