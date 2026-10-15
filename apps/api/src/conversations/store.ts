import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { decryptMeta, type AttachmentMeta } from "../attachments/store.js";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import type { ModelSelection } from "../llm/types.js";

export type MessageRole = "user" | "assistant";

/** Qui répond : un agent, un modèle choisi, ou (les deux à null) le modèle par défaut. */
export type ConversationSelection = { agentId: string | null; model: ModelSelection | null };

export const DEFAULT_CONVERSATION_TITLE = "Nouvelle conversation";

export type ConversationOwner = {
  userId: string;
  organizationId: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  agentId: string | null;
  /** Modèle choisi pour une conversation sans agent. */
  model: ModelSelection | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredMessage = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  attachments?: AttachmentMeta[];
};

export type SearchHit = {
  id: string;
  title: string;
  /** Extrait du message correspondant ; absent si seul le titre correspond. */
  snippet?: string;
};

export type ExchangeOptions = {
  /** Pièces jointes à rattacher au message utilisateur. */
  attachmentIds?: string[];
  /** Modification : ce message utilisateur et tout ce qui suit sont remplacés. */
  replaceFromMessageId?: string;
};

export interface ConversationStore {
  list(owner: ConversationOwner): Promise<ConversationSummary[]>;
  create(
    owner: ConversationOwner,
    title?: string,
    agentId?: string,
    projectId?: string,
    model?: ModelSelection,
  ): Promise<ConversationSummary>;
  get(owner: ConversationOwner, conversationId: string): Promise<ConversationSummary | null>;
  /** Changer l'agent ou le modèle n'est possible que tant que la conversation est vide. */
  update(
    owner: ConversationOwner,
    conversationId: string,
    changes: { title?: string; projectId?: string | null; selection?: ConversationSelection },
  ): Promise<ConversationSummary | null>;
  search(owner: ConversationOwner, query: string): Promise<SearchHit[]>;
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
    options?: ExchangeOptions,
  ): Promise<{ userMessage: StoredMessage; assistantMessage: StoredMessage } | null>;
  /** Régénération : remplace la dernière réponse si elle n'a pas changé entre-temps. */
  replaceLastAssistant(
    owner: ConversationOwner,
    conversationId: string,
    previousAssistantId: string,
    content: string,
  ): Promise<StoredMessage | null>;
}

// L'AAD lie chaque chiffré à son propriétaire et à sa ligne.
export function titleAad(owner: ConversationOwner, conversationId: string) {
  return `conversation-title:${owner.organizationId}:${owner.userId}:${conversationId}`;
}

export function messageAad(
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
  agentId: string | null;
  modelProvider: ModelSelection["provider"] | null;
  modelId: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
};

const SUMMARY_COLUMNS = `id, title, agent_id AS "agentId", project_id AS "projectId",
  model_provider AS "modelProvider", model_id AS "modelId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const modelOf = (row: ConversationRow): ModelSelection | null =>
  row.modelProvider && row.modelId ? { provider: row.modelProvider, model: row.modelId } : null;

type MessageRow = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
};

const SEARCH_MAX_RESULTS = 30;

/** Comparaison insensible à la casse et aux accents. */
export function normalizeForSearch(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function snippet(text: string, index: number, length: number) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

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
      agentId: row.agentId,
      model: modelOf(row),
      projectId: row.projectId,
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

  private async decryptMessage(
    client: PoolClient,
    owner: ConversationOwner,
    conversationId: string,
    row: MessageRow,
  ): Promise<StoredMessage> {
    return {
      ...row,
      content: await this.keyring.decrypt(
        client,
        owner.organizationId,
        row.content,
        messageAad(owner, conversationId, row.id, row.role),
      ),
    };
  }

  private async summaries(client: PoolClient, owner: ConversationOwner) {
    const result = await client.query<ConversationRow>(
      `SELECT ${SUMMARY_COLUMNS}
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
  }

  async list(owner: ConversationOwner): Promise<ConversationSummary[]> {
    return withTenant(this.pool, owner, (client) => this.summaries(client, owner));
  }

  async get(owner: ConversationOwner, conversationId: string) {
    return withTenant(this.pool, owner, async (client) => {
      const result = await client.query<ConversationRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM conversations
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [conversationId, owner.userId, owner.organizationId],
      );
      const row = result.rows[0];
      return row ? this.decryptTitle(client, owner, row) : null;
    });
  }

  async create(
    owner: ConversationOwner,
    title?: string,
    agentId?: string,
    projectId?: string,
    model?: ModelSelection,
  ): Promise<ConversationSummary> {
    if (agentId && model) throw new Error("INVALID_SELECTION");
    return withTenant(this.pool, owner, async (client) => {
      if (agentId) {
        // RLS : seul un agent de l'organisation courante est visible.
        const agent = await client.query("SELECT 1 FROM agents WHERE id = $1", [agentId]);
        if (!agent.rowCount) throw new Error("AGENT_NOT_FOUND");
      }
      if (projectId) {
        const project = await client.query(
          "SELECT 1 FROM projects WHERE id = $1 AND user_id = $2 AND organization_id = $3",
          [projectId, owner.userId, owner.organizationId],
        );
        if (!project.rowCount) throw new Error("PROJECT_NOT_FOUND");
      }

      const id = randomUUID();
      const encryptedTitle = title
        ? await this.keyring.encrypt(client, owner.organizationId, title, titleAad(owner, id))
        : null;

      const result = await client.query<ConversationRow>(
        `INSERT INTO conversations (id, user_id, organization_id, title, agent_id, project_id, model_provider, model_id)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8
         WHERE EXISTS (
           SELECT 1 FROM organization_members
           WHERE user_id = $2 AND organization_id = $3
         )
         RETURNING ${SUMMARY_COLUMNS}`,
        [
          id,
          owner.userId,
          owner.organizationId,
          encryptedTitle,
          agentId ?? null,
          projectId ?? null,
          model?.provider ?? null,
          model?.model ?? null,
        ],
      );

      const row = result.rows[0];
      if (!row) throw new Error("MEMBERSHIP_REQUIRED");

      return {
        id: row.id,
        agentId: row.agentId,
        model: modelOf(row),
        projectId: row.projectId,
        title: title ?? DEFAULT_CONVERSATION_TITLE,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  async update(
    owner: ConversationOwner,
    conversationId: string,
    changes: { title?: string; projectId?: string | null; selection?: ConversationSelection },
  ) {
    const { selection } = changes;
    if (selection?.agentId && selection.model) throw new Error("INVALID_SELECTION");

    return withTenant(this.pool, owner, async (client) => {
      if (selection) {
        // Verrou : aucun message ne peut arriver entre le contrôle et la mise à jour.
        const current = await client.query(
          `SELECT 1 FROM conversations
           WHERE id = $1 AND user_id = $2 AND organization_id = $3
           FOR UPDATE`,
          [conversationId, owner.userId, owner.organizationId],
        );
        if (!current.rowCount) return null;
        const started = await client.query(
          "SELECT 1 FROM messages WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3 LIMIT 1",
          [conversationId, owner.userId, owner.organizationId],
        );
        if (started.rowCount) throw new Error("CONVERSATION_STARTED");
        if (selection.agentId) {
          const agent = await client.query("SELECT 1 FROM agents WHERE id = $1", [selection.agentId]);
          if (!agent.rowCount) throw new Error("AGENT_NOT_FOUND");
        }
      }
      if (changes.projectId) {
        const project = await client.query(
          "SELECT 1 FROM projects WHERE id = $1 AND user_id = $2 AND organization_id = $3",
          [changes.projectId, owner.userId, owner.organizationId],
        );
        if (!project.rowCount) throw new Error("PROJECT_NOT_FOUND");
      }

      const sets: string[] = [];
      const values: unknown[] = [conversationId, owner.userId, owner.organizationId];
      if (changes.title !== undefined) {
        values.push(
          await this.keyring.encrypt(client, owner.organizationId, changes.title, titleAad(owner, conversationId)),
        );
        sets.push(`title = $${values.length}`);
      }
      if (changes.projectId !== undefined) {
        values.push(changes.projectId);
        sets.push(`project_id = $${values.length}`);
      }
      if (selection) {
        values.push(selection.agentId, selection.model?.provider ?? null, selection.model?.model ?? null);
        sets.push(
          `agent_id = $${values.length - 2}`,
          `model_provider = $${values.length - 1}`,
          `model_id = $${values.length}`,
        );
      }
      if (sets.length === 0) return null;

      // Renommer ou ranger ne modifie pas l'ordre (updated_at) de l'historique.
      const result = await client.query<ConversationRow>(
        `UPDATE conversations SET ${sets.join(", ")}
         WHERE id = $1 AND user_id = $2 AND organization_id = $3
         RETURNING ${SUMMARY_COLUMNS}`,
        values,
      );
      const row = result.rows[0];
      return row ? this.decryptTitle(client, owner, row) : null;
    });
  }

  /**
   * Titres et messages sont chiffrés : la recherche se fait côté serveur après
   * déchiffrement, bornée aux 200 conversations récentes de l'utilisateur.
   */
  async search(owner: ConversationOwner, query: string): Promise<SearchHit[]> {
    const needle = normalizeForSearch(query.trim());
    if (needle.length < 2) return [];

    return withTenant(this.pool, owner, async (client) => {
      const conversations = await this.summaries(client, owner);
      const hits = new Map<string, SearchHit>();

      for (const conversation of conversations) {
        if (normalizeForSearch(conversation.title).includes(needle)) {
          hits.set(conversation.id, { id: conversation.id, title: conversation.title });
        }
      }

      const ids = conversations.map((conversation) => conversation.id);
      const titles = new Map(conversations.map((conversation) => [conversation.id, conversation.title]));
      const messages = await client.query<MessageRow & { conversationId: string }>(
        `SELECT id, role, content, created_at AS "createdAt", conversation_id AS "conversationId"
         FROM messages
         WHERE conversation_id = ANY($1::uuid[]) AND user_id = $2 AND organization_id = $3
         ORDER BY created_at DESC
         LIMIT 5000`,
        [ids, owner.userId, owner.organizationId],
      );

      for (const row of messages.rows) {
        if (hits.get(row.conversationId)?.snippet) continue;
        const message = await this.decryptMessage(client, owner, row.conversationId, row);
        const index = normalizeForSearch(message.content).indexOf(needle);
        if (index !== -1) {
          hits.set(row.conversationId, {
            id: row.conversationId,
            title: titles.get(row.conversationId) ?? DEFAULT_CONVERSATION_TITLE,
            snippet: snippet(message.content, index, needle.length),
          });
        }
        if (hits.size >= SEARCH_MAX_RESULTS && [...hits.values()].every((hit) => hit.snippet)) break;
      }

      // Ordre de l'historique (le plus récent d'abord).
      return ids.filter((id) => hits.has(id)).map((id) => hits.get(id)!).slice(0, SEARCH_MAX_RESULTS);
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

      const files = await client.query<AttachmentMeta & { name: string }>(
        `SELECT id, name, kind, media_type AS "mediaType", size_bytes AS size,
                message_id AS "messageId", created_at AS "createdAt"
         FROM attachments
         WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3 AND message_id IS NOT NULL
         ORDER BY created_at ASC`,
        [conversationId, owner.userId, owner.organizationId],
      );
      const byMessage = new Map<string, AttachmentMeta[]>();
      for (const row of files.rows) {
        const meta = await decryptMeta(this.keyring, client, owner, row);
        byMessage.set(row.messageId!, [...(byMessage.get(row.messageId!) ?? []), meta]);
      }

      const messages: StoredMessage[] = [];
      for (const row of result.rows) {
        const message = await this.decryptMessage(client, owner, conversationId, row);
        const attachments = byMessage.get(row.id);
        messages.push(attachments ? { ...message, attachments } : message);
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

  private async insertMessage(
    client: PoolClient,
    owner: ConversationOwner,
    conversationId: string,
    role: MessageRole,
    content: string,
  ) {
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
  }

  async appendExchange(
    owner: ConversationOwner,
    conversationId: string,
    userContent: string,
    assistantContent: string,
    options: ExchangeOptions = {},
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

      if (options.replaceFromMessageId) {
        // Modification : le message édité et toute la suite sont supprimés ;
        // leurs pièces jointes redeviennent libres (message_id → NULL).
        const deleted = await client.query(
          `DELETE FROM messages m
           USING messages edited
           WHERE edited.id = $4 AND edited.role = 'user'
             AND edited.conversation_id = $1 AND edited.user_id = $2 AND edited.organization_id = $3
             AND m.conversation_id = $1 AND m.user_id = $2 AND m.organization_id = $3
             AND (m.created_at, m.id) >= (edited.created_at, edited.id)`,
          [conversationId, owner.userId, owner.organizationId, options.replaceFromMessageId],
        );
        if (!deleted.rowCount) return null;
      }

      const userMessage = await this.insertMessage(client, owner, conversationId, "user", userContent);
      const assistantMessage = await this.insertMessage(client, owner, conversationId, "assistant", assistantContent);

      if (options.attachmentIds?.length) {
        const linked = await client.query<AttachmentMeta & { name: string }>(
          `UPDATE attachments SET message_id = $5
           WHERE id = ANY($4::uuid[]) AND message_id IS NULL
             AND conversation_id = $1 AND user_id = $2 AND organization_id = $3
           RETURNING id, name, kind, media_type AS "mediaType", size_bytes AS size,
                     message_id AS "messageId", created_at AS "createdAt"`,
          [conversationId, owner.userId, owner.organizationId, options.attachmentIds, userMessage.id],
        );
        userMessage.attachments = [];
        for (const row of linked.rows) {
          userMessage.attachments.push(await decryptMeta(this.keyring, client, owner, row));
        }
      }

      const title = current.title ?? await this.keyring.encrypt(
        client,
        owner.organizationId,
        (userContent || userMessage.attachments?.[0]?.name || DEFAULT_CONVERSATION_TITLE).slice(0, 80),
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

  async replaceLastAssistant(
    owner: ConversationOwner,
    conversationId: string,
    previousAssistantId: string,
    content: string,
  ) {
    return withTenant(this.pool, owner, async (client) => {
      const conversation = await client.query(
        `SELECT 1 FROM conversations
         WHERE id = $1 AND user_id = $2 AND organization_id = $3
         FOR UPDATE`,
        [conversationId, owner.userId, owner.organizationId],
      );
      if (!conversation.rowCount) return null;

      const last = await client.query<{ id: string }>(
        `SELECT id FROM messages
         WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [conversationId, owner.userId, owner.organizationId],
      );
      // La conversation a bougé entre-temps : on n'écrase rien.
      if (last.rows[0]?.id !== previousAssistantId) return null;

      await client.query(
        "DELETE FROM messages WHERE id = $1 AND user_id = $2 AND organization_id = $3 AND role = 'assistant'",
        [previousAssistantId, owner.userId, owner.organizationId],
      );
      const message = await this.insertMessage(client, owner, conversationId, "assistant", content);
      await client.query(
        `UPDATE conversations SET updated_at = now()
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [conversationId, owner.userId, owner.organizationId],
      );
      return message;
    });
  }
}
