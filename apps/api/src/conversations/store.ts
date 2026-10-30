import { activePath, latestLeaf, type BranchInfo, type BranchNode } from "./branches.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { decryptMeta, type AttachmentMeta } from "../attachments/store.js";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { redactSensitive } from "../security/sensitive.js";
import { withTenant } from "../db/tenant.js";
import type { ModelSelection } from "../llm/types.js";

export type MessageRole = "user" | "assistant";

/** Source de la base de connaissances citée par une réponse. */
export type MessageSource = {
  n: number;
  sourceId: string;
  name: string;
  url: string | null;
  /** web : page trouvée par la recherche web (sourceId = adresse). */
  base: "agent" | "project" | "web";
  section?: string | null;
  page?: number | null;
};

/** Bases de connaissances consultées par la conversation. */
export type KnowledgeToggles = { agent: boolean; project: boolean };

/** Réglages propres à une conversation : priment sur ceux de l'agent. */
export const creativities = ["precise", "balanced", "creative"] as const;
export const lengths = ["concise", "complete"] as const;
export type ConversationSettings = {
  creativity?: (typeof creativities)[number];
  length?: (typeof lengths)[number];
  /** Consignes pour cette conversation seulement (chiffrées). */
  instructions?: string;
};

/** Réglages sans champ vide (une instruction vide = pas d'instruction). */
export function settingsOf(input: { [K in keyof ConversationSettings]?: ConversationSettings[K] | undefined }): ConversationSettings {
  return {
    ...(input.creativity ? { creativity: input.creativity } : {}),
    ...(input.length ? { length: input.length } : {}),
    ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
  };
}

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
  knowledge: KnowledgeToggles;
  projectId: string | null;
  /** Présent (true) seulement pour une conversation temporaire. */
  temporary?: true;
  /** Présent (true) dès qu'une donnée sensible y a été détectée : modèle local à jamais. */
  sensitive?: true;
  /** Présent seulement si au moins un réglage est posé. */
  settings?: ConversationSettings;
  /** Présent (true) pour une conversation archivée. */
  archived?: true;
  /** Présent seulement s'il y a des étiquettes. */
  tags?: string[];
  createdAt: string;
  updatedAt: string;
};

/** Durée de vie d'une conversation temporaire (aussi fixée en base, par trigger). */
export const TEMPORARY_TTL_HOURS = 24;

/** Conversation temporaire arrivée à échéance (relevée hors contexte tenant). */
export type ExpiredConversation = { conversationId: string; organizationId: string; userId: string };

export type StoredMessage = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  attachments?: AttachmentMeta[];
  sources?: MessageSource[];
  /** Versions de ce tour (modification, régénération) : présent seulement s'il y en a plusieurs. */
  branch?: BranchInfo;
  /** Retour de l'utilisateur sur une réponse. */
  feedback?: MessageFeedback;
  /** Auteur d'une réponse : « agent:<id> » ou « model:<fournisseur>:<modèle> ». */
  author?: string;
  /** Réponse inachevée (coupée par la longueur maximale, ou arrêtée) : peut être continuée. */
  incomplete?: true;
};

export type MessageFeedback = { rating: "up" | "down"; comment?: string };

export type SearchHit = {
  id: string;
  title: string;
  /** Extrait du message correspondant ; absent si seul le titre correspond. */
  snippet?: string;
};

export type ExchangeOptions = {
  /** Pièces jointes à rattacher au message utilisateur. */
  attachmentIds?: string[];
  /**
   * Modification : la nouvelle version devient une SŒUR de ce message (l'ancienne
   * branche reste consultable). Ses pièces jointes passent à la nouvelle version.
   */
  replaceFromMessageId?: string;
  /** Sources citées par la réponse. */
  sources?: MessageSource[];
  /** Run qui a produit la réponse (retour 👍👎 → trace). */
  runId?: string;
  /** Auteur de la réponse (agent ou modèle de ce tour). */
  author?: string;
  /** Réponse inachevée. */
  incomplete?: boolean;
};

export interface ConversationStore {
  list(owner: ConversationOwner): Promise<ConversationSummary[]>;
  create(
    owner: ConversationOwner,
    title?: string,
    agentId?: string,
    projectId?: string,
    model?: ModelSelection,
    options?: { temporary?: boolean },
  ): Promise<ConversationSummary>;
  get(owner: ConversationOwner, conversationId: string): Promise<ConversationSummary | null>;
  /** Conversations temporaires échues, toutes organisations (purge). */
  expiredTemporary?(): Promise<ExpiredConversation[]>;
  /** Donnée sensible détectée : la conversation reste sur un modèle local (définitif). */
  markSensitive(owner: ConversationOwner, conversationId: string): Promise<void>;
  /**
   * Titre généré (reformulation de la première demande) : remplace le titre
   * provisoire `provisional`, jamais un titre choisi par l'utilisateur entre-temps.
   */
  retitle?(owner: ConversationOwner, conversationId: string, title: string, provisional: string): Promise<boolean>;
  /** Agent ou modèle : changeable à tout moment (le contrôle « local à vie » est fait par la route). */
  update(
    owner: ConversationOwner,
    conversationId: string,
    changes: {
      title?: string;
      projectId?: string | null;
      selection?: ConversationSelection;
      knowledge?: Partial<KnowledgeToggles>;
      /** Remplace tous les réglages (objet vide : réglages de l'agent). */
      settings?: ConversationSettings;
      archived?: boolean;
      tags?: string[];
    },
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
  /**
   * Retour sur une réponse (null : retiré). Renvoie le run qui l'a produite
   * (pour noter sa trace), ou null si la réponse n'existe pas dans cette conversation.
   */
  setFeedback(
    owner: ConversationOwner,
    conversationId: string,
    messageId: string,
    feedback: MessageFeedback | null,
  ): Promise<{ runId: string | null } | null>;
  /** Conversation importée (autre service) : messages chaînés dans l'ordre, une seule branche. */
  importConversation(owner: ConversationOwner, title: string, messages: { role: MessageRole; content: string }[]): Promise<ConversationSummary>;
  /**
   * Bifurquer : nouvelle conversation reprenant la branche affichée jusqu'à ce
   * message (inclus), avec le même agent ou modèle, projet et réglages. Une
   * conversation sensible le reste. null : conversation ou message introuvable
   * (hors de la branche affichée). Les pièces jointes restent dans l'originale.
   */
  fork(owner: ConversationOwner, conversationId: string, messageId: string): Promise<ConversationSummary | null>;
  /** Affiche une autre version d'un tour : la branche suit sa suite la plus récente. */
  selectBranch(owner: ConversationOwner, conversationId: string, messageId: string): Promise<boolean>;
  /** Régénération : nouvelle version de la dernière réponse (sœur), si elle n'a pas changé entre-temps. */
  replaceLastAssistant(
    owner: ConversationOwner,
    conversationId: string,
    previousAssistantId: string,
    content: string,
    sources?: MessageSource[],
    runId?: string,
    author?: string,
    incomplete?: boolean,
  ): Promise<StoredMessage | null>;
  /**
   * Continuer : la suite s'ajoute à la dernière réponse (même message), si elle
   * est toujours la fin de la branche affichée.
   */
  extendAssistant(
    owner: ConversationOwner,
    conversationId: string,
    messageId: string,
    addition: string,
    incomplete: boolean,
  ): Promise<StoredMessage | null>;
}

export function feedbackAad(owner: ConversationOwner, messageId: string) {
  return `message-feedback:${owner.organizationId}:${owner.userId}:${messageId}`;
}

// L'AAD lie chaque chiffré à son propriétaire et à sa ligne.
export function titleAad(owner: ConversationOwner, conversationId: string) {
  return `conversation-title:${owner.organizationId}:${owner.userId}:${conversationId}`;
}

export function conversationFieldAad(owner: ConversationOwner, conversationId: string, field: "instructions" | "tags") {
  return `conversation-${field}:${owner.organizationId}:${owner.userId}:${conversationId}`;
}

export function messageAad(
  owner: ConversationOwner,
  conversationId: string,
  messageId: string,
  role: MessageRole,
) {
  return `message:${owner.organizationId}:${owner.userId}:${conversationId}:${messageId}:${role}`;
}

export function messageSourcesAad(owner: ConversationOwner, conversationId: string, messageId: string) {
  return `message-sources:${owner.organizationId}:${owner.userId}:${conversationId}:${messageId}`;
}

type ConversationRow = {
  id: string;
  title: string | null;
  agentId: string | null;
  modelProvider: ModelSelection["provider"] | null;
  modelId: string | null;
  useAgentKnowledge: boolean;
  useProjectKnowledge: boolean;
  projectId: string | null;
  temporary: boolean;
  sensitive: boolean;
  creativity: ConversationSettings["creativity"] | null;
  length: ConversationSettings["length"] | null;
  instructions: string | null;
  archived: boolean;
  tags: string | null;
  createdAt: string;
  updatedAt: string;
};

const SUMMARY_COLUMNS = `id, title, agent_id AS "agentId", project_id AS "projectId",
  model_provider AS "modelProvider", model_id AS "modelId",
  use_agent_knowledge AS "useAgentKnowledge", use_project_knowledge AS "useProjectKnowledge",
  temporary, sensitive, creativity, length, instructions, archived, tags,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const modelOf = (row: ConversationRow): ModelSelection | null =>
  row.modelProvider && row.modelId ? { provider: row.modelProvider, model: row.modelId } : null;

const knowledgeOf = (row: ConversationRow): KnowledgeToggles => ({
  agent: row.useAgentKnowledge,
  project: row.useProjectKnowledge,
});

type MessageRow = {
  id: string;
  role: MessageRole;
  content: string;
  sources?: string | null;
  createdAt: string;
  author?: string | null;
  incomplete?: boolean;
};

const SEARCH_MAX_RESULTS = 30;
/** Clé de tri des versions : horodatage à la microseconde, comparable comme texte. */
const SORT_KEY = `to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS "sortKey"`;

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
/**
 * Messages recopiés (copie de conversation, import) : pas une activité du jour.
 * Le compteur du pilotage (trigger messages_activity_count) les ignore pour
 * cette transaction seulement.
 */
/** Titre provisoire (début de la première demande), en attendant le titre généré. */
export const provisionalTitle = (text: string) => redactSensitive(text).slice(0, 80);

/** Conversation restée vide (aucun message) : effacée après ce délai. */
export const EMPTY_CONVERSATION_HOURS = 24;

const notActivity = (client: PoolClient) => client.query("SELECT set_config('app.copy', 'on', true)");

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
      knowledge: knowledgeOf(row),
      projectId: row.projectId,
      ...(row.temporary ? { temporary: true as const } : {}),
      ...(row.sensitive ? { sensitive: true as const } : {}),
      ...(await this.decryptFiling(client, owner, row)),
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

  /** Réglages, archive et étiquettes : seuls les champs posés apparaissent. */
  private async decryptFiling(client: PoolClient, owner: ConversationOwner, row: ConversationRow) {
    const settings: ConversationSettings = {
      ...(row.creativity ? { creativity: row.creativity } : {}),
      ...(row.length ? { length: row.length } : {}),
      ...(row.instructions
        ? { instructions: await this.keyring.decrypt(client, owner.organizationId, row.instructions, conversationFieldAad(owner, row.id, "instructions")) }
        : {}),
    };
    const tags = row.tags
      ? (JSON.parse(await this.keyring.decrypt(client, owner.organizationId, row.tags, conversationFieldAad(owner, row.id, "tags"))) as string[])
      : [];
    return {
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(row.archived ? { archived: true as const } : {}),
      ...(tags.length ? { tags } : {}),
    };
  }

  private async decryptMessage(
    client: PoolClient,
    owner: ConversationOwner,
    conversationId: string,
    row: MessageRow,
  ): Promise<StoredMessage> {
    const { sources, author, incomplete, ...rest } = row;
    const message: StoredMessage = {
      ...rest,
      ...(author ? { author } : {}),
      ...(incomplete ? { incomplete: true as const } : {}),
      content: await this.keyring.decrypt(
        client,
        owner.organizationId,
        row.content,
        messageAad(owner, conversationId, row.id, row.role),
      ),
    };
    if (sources) {
      message.sources = JSON.parse(
        await this.keyring.decrypt(client, owner.organizationId, sources, messageSourcesAad(owner, conversationId, row.id)),
      ) as MessageSource[];
    }
    return message;
  }

  private async summaries(client: PoolClient, owner: ConversationOwner) {
    const result = await client.query<ConversationRow>(
      `SELECT ${SUMMARY_COLUMNS}
       FROM conversations
       WHERE user_id = $1 AND organization_id = $2 AND NOT temporary
         -- Pas encore de message : pas dans l'historique (« Nouvelle conversation » sans rien écrire).
         AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)
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
    return withTenant(this.pool, owner, async (client) => {
      // Ménage : conversations ouvertes puis laissées vides depuis plus d'un jour (sauf
      // celle d'une tâche planifiée, qui attend son premier passage). Sous la RLS de l'auteur.
      await client.query(
        `DELETE FROM conversations c
         WHERE c.user_id = $1 AND c.organization_id = $2 AND NOT c.temporary
           AND c.created_at < now() - interval '${EMPTY_CONVERSATION_HOURS} hours'
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM agent_schedules s WHERE s.conversation_id = c.id)`,
        [owner.userId, owner.organizationId],
      );
      return this.summaries(client, owner);
    });
  }

  /** Échéances tenues par trigger hors RLS forcée : seuls les identifiants sortent. */
  async expiredTemporary(): Promise<ExpiredConversation[]> {
    const result = await this.pool.query<{ conversation_id: string; organization_id: string; user_id: string }>(
      "SELECT conversation_id, organization_id, user_id FROM snowfall_expired_temporary()",
    );
    return result.rows.map((row) => ({ conversationId: row.conversation_id, organizationId: row.organization_id, userId: row.user_id }));
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
    options: { temporary?: boolean } = {},
  ): Promise<ConversationSummary> {
    if (agentId && model) throw new Error("INVALID_SELECTION");
    // Une conversation temporaire n'est rangée nulle part.
    if (options.temporary && projectId) throw new Error("INVALID_SELECTION");
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
        `INSERT INTO conversations (id, user_id, organization_id, title, agent_id, project_id, model_provider, model_id, temporary)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
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
          options.temporary === true,
        ],
      );

      const row = result.rows[0];
      if (!row) throw new Error("MEMBERSHIP_REQUIRED");

      return {
        id: row.id,
        agentId: row.agentId,
        model: modelOf(row),
        knowledge: knowledgeOf(row),
        projectId: row.projectId,
        ...(row.temporary ? { temporary: true as const } : {}),
        title: title ?? DEFAULT_CONVERSATION_TITLE,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  markSensitive(owner: ConversationOwner, conversationId: string) {
    return withTenant(this.pool, owner, async (client) => {
      await client.query("UPDATE conversations SET sensitive = true WHERE id = $1 AND user_id = $2 AND organization_id = $3", [conversationId, owner.userId, owner.organizationId]);
    });
  }

  async retitle(owner: ConversationOwner, conversationId: string, title: string, provisional: string) {
    return withTenant(this.pool, owner, async (client) => {
      const row = (
        await client.query<{ title: string | null }>(
          "SELECT title FROM conversations WHERE id = $1 AND user_id = $2 AND organization_id = $3 AND NOT temporary FOR UPDATE",
          [conversationId, owner.userId, owner.organizationId],
        )
      ).rows[0];
      if (!row?.title) return false;
      const current = await this.keyring.decrypt(client, owner.organizationId, row.title, titleAad(owner, conversationId));
      if (current !== provisional) return false;
      const encrypted = await this.keyring.encrypt(client, owner.organizationId, redactSensitive(title).slice(0, 80), titleAad(owner, conversationId));
      await client.query("UPDATE conversations SET title = $4 WHERE id = $1 AND user_id = $2 AND organization_id = $3", [conversationId, owner.userId, owner.organizationId, encrypted]);
      return true;
    });
  }

  async update(
    owner: ConversationOwner,
    conversationId: string,
    changes: {
      title?: string;
      projectId?: string | null;
      selection?: ConversationSelection;
      knowledge?: Partial<KnowledgeToggles>;
      settings?: ConversationSettings;
      archived?: boolean;
      tags?: string[];
    },
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
        // Une conversation temporaire n'entre dans aucun projet (contrainte CHECK aussi en base).
        const temporary = await client.query(
          "SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND organization_id = $3 AND temporary",
          [conversationId, owner.userId, owner.organizationId],
        );
        if (temporary.rowCount) throw new Error("PROJECT_NOT_FOUND");
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
      if (changes.knowledge?.agent !== undefined) {
        values.push(changes.knowledge.agent);
        sets.push(`use_agent_knowledge = $${values.length}`);
      }
      if (changes.knowledge?.project !== undefined) {
        values.push(changes.knowledge.project);
        sets.push(`use_project_knowledge = $${values.length}`);
      }
      if (changes.settings) {
        const { creativity, length, instructions } = changes.settings;
        values.push(
          creativity ?? null,
          length ?? null,
          instructions
            ? await this.keyring.encrypt(client, owner.organizationId, instructions, conversationFieldAad(owner, conversationId, "instructions"))
            : null,
        );
        sets.push(`creativity = $${values.length - 2}`, `length = $${values.length - 1}`, `instructions = $${values.length}`);
      }
      if (changes.archived !== undefined) {
        values.push(changes.archived);
        sets.push(`archived = $${values.length}`);
      }
      if (changes.tags !== undefined) {
        values.push(
          changes.tags.length
            ? await this.keyring.encrypt(client, owner.organizationId, JSON.stringify(changes.tags), conversationFieldAad(owner, conversationId, "tags"))
            : null,
        );
        sets.push(`tags = $${values.length}`);
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
      const exists = await client.query<{ leaf: string | null }>(
        `SELECT current_leaf_id AS leaf FROM conversations
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [conversationId, owner.userId, owner.organizationId],
      );
      if (!exists.rowCount) return null;

      const all = await client.query<MessageRow & { parentId: string | null; sortKey: string }>(
        `SELECT id, role, content, sources, author, incomplete, parent_id AS "parentId", created_at AS "createdAt", ${SORT_KEY}
         FROM messages
         WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3
         ORDER BY created_at ASC, id ASC`,
        [conversationId, owner.userId, owner.organizationId],
      );
      // Branche affichée : de la racine à la feuille retenue. Les autres versions ne sont pas déchiffrées.
      const { path, branches } = activePath(all.rows.map((row) => ({ id: row.id, parentId: row.parentId, createdAt: row.sortKey })), exists.rows[0]!.leaf);
      const rows = new Map(all.rows.map((row) => [row.id, row]));
      const result = { rows: path.map((id) => rows.get(id)!) };

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

      const ratings = await client.query<{ messageId: string; rating: number; comment: string | null }>(
        `SELECT message_id AS "messageId", rating, comment FROM message_feedback
         WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3 AND message_id = ANY($4::uuid[])`,
        [conversationId, owner.userId, owner.organizationId, path],
      );
      const feedback = new Map<string, MessageFeedback>();
      for (const row of ratings.rows) {
        feedback.set(row.messageId, {
          rating: row.rating > 0 ? "up" : "down",
          ...(row.comment ? { comment: await this.keyring.decrypt(client, owner.organizationId, row.comment, feedbackAad(owner, row.messageId)) } : {}),
        });
      }

      const messages: StoredMessage[] = [];
      for (const { parentId: _parent, sortKey: _key, ...row } of result.rows) {
        const message = await this.decryptMessage(client, owner, conversationId, row);
        const attachments = byMessage.get(row.id);
        const branch = branches.get(row.id);
        const rated = feedback.get(row.id);
        messages.push({ ...message, ...(attachments ? { attachments } : {}), ...(branch ? { branch } : {}), ...(rated ? { feedback: rated } : {}) });
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
    sources: MessageSource[] | undefined,
    parentId: string | null,
    runId?: string,
    author?: string,
    incomplete = false,
  ) {
    const id = randomUUID();
    const encrypted = await this.keyring.encrypt(
      client,
      owner.organizationId,
      content,
      messageAad(owner, conversationId, id, role),
    );
    const encryptedSources = sources?.length
      ? await this.keyring.encrypt(client, owner.organizationId, JSON.stringify(sources), messageSourcesAad(owner, conversationId, id))
      : null;
    const result = await client.query<{ id: string; role: MessageRole; createdAt: string }>(
      `INSERT INTO messages
         (id, conversation_id, user_id, organization_id, role, content, sources, parent_id, run_id, author, incomplete, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp())
       RETURNING id, role, created_at AS "createdAt"`,
      [id, conversationId, owner.userId, owner.organizationId, role, encrypted, encryptedSources, parentId, runId ?? null, author ?? null, incomplete],
    );
    const message: StoredMessage = { ...result.rows[0]!, content };
    if (sources?.length) message.sources = sources;
    if (author) message.author = author;
    if (incomplete) message.incomplete = true;
    return message;
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

      // Parent du nouveau message : la fin de la branche affichée, ou, pour une
      // modification, le parent du message modifié (la nouvelle version est sa sœur).
      let parentId: string | null;
      if (options.replaceFromMessageId) {
        const edited = await client.query<{ parentId: string | null }>(
          `SELECT parent_id AS "parentId" FROM messages
           WHERE id = $4 AND role = 'user' AND conversation_id = $1 AND user_id = $2 AND organization_id = $3`,
          [conversationId, owner.userId, owner.organizationId, options.replaceFromMessageId],
        );
        if (!edited.rowCount) return null;
        parentId = edited.rows[0]!.parentId;
      } else {
        parentId = await this.currentLeaf(client, owner, conversationId);
      }

      const userMessage = await this.insertMessage(client, owner, conversationId, "user", userContent, undefined, parentId);
      const assistantMessage = await this.insertMessage(client, owner, conversationId, "assistant", assistantContent, options.sources, userMessage.id, options.runId, options.author, options.incomplete);

      if (options.attachmentIds?.length) {
        const linked = await client.query<AttachmentMeta & { name: string }>(
          `UPDATE attachments SET message_id = $5
           WHERE id = ANY($4::uuid[]) AND (message_id IS NULL OR message_id = $6)
             AND conversation_id = $1 AND user_id = $2 AND organization_id = $3
           RETURNING id, name, kind, media_type AS "mediaType", size_bytes AS size,
                     message_id AS "messageId", created_at AS "createdAt"`,
          [conversationId, owner.userId, owner.organizationId, options.attachmentIds, userMessage.id, options.replaceFromMessageId ?? null],
        );
        userMessage.attachments = [];
        for (const row of linked.rows) {
          userMessage.attachments.push(await decryptMeta(this.keyring, client, owner, row));
        }
      }

      const title = current.title ?? await this.keyring.encrypt(
        client,
        owner.organizationId,
        // Titre visible partout (liste, recherche) : jamais d'identifiant sensible en clair.
        provisionalTitle(userContent || userMessage.attachments?.[0]?.name || DEFAULT_CONVERSATION_TITLE),
        titleAad(owner, conversationId),
      );

      await client.query(
        `UPDATE conversations SET title = $4, current_leaf_id = $5, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [conversationId, owner.userId, owner.organizationId, title, assistantMessage.id],
      );

      return { userMessage, assistantMessage };
    });
  }

  /** Arbre des messages (identifiants seulement : rien n'est déchiffré). */
  private async nodes(client: PoolClient, owner: ConversationOwner, conversationId: string) {
    const result = await client.query<BranchNode>(
      `SELECT id, parent_id AS "parentId", ${SORT_KEY.replace(' AS "sortKey"', ' AS "createdAt"')} FROM messages
       WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3`,
      [conversationId, owner.userId, owner.organizationId],
    );
    return result.rows;
  }

  /** Dernier message de la branche affichée (NULL : conversation vide). */
  private async currentLeaf(client: PoolClient, owner: ConversationOwner, conversationId: string) {
    const conversation = await client.query<{ leaf: string | null }>(
      `SELECT current_leaf_id AS leaf FROM conversations
       WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
      [conversationId, owner.userId, owner.organizationId],
    );
    const nodes = await this.nodes(client, owner, conversationId);
    return activePath(nodes, conversation.rows[0]?.leaf ?? null).path.at(-1) ?? null;
  }

  async fork(owner: ConversationOwner, conversationId: string, messageId: string) {
    return withTenant(this.pool, owner, async (client) => {
      const source = (
        await client.query<ConversationRow & { leaf: string | null }>(
          `SELECT ${SUMMARY_COLUMNS}, current_leaf_id AS leaf FROM conversations
           WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
          [conversationId, owner.userId, owner.organizationId],
        )
      ).rows[0];
      if (!source) return null;
      // Une conversation temporaire disparaît en 24 h : elle ne se recopie pas.
      if (source.temporary) throw new Error("TEMPORARY");
      await notActivity(client);

      const all = await client.query<MessageRow & { parentId: string | null; sortKey: string }>(
        `SELECT id, role, content, sources, author, incomplete, parent_id AS "parentId", created_at AS "createdAt", ${SORT_KEY}
         FROM messages
         WHERE conversation_id = $1 AND user_id = $2 AND organization_id = $3
         ORDER BY created_at ASC, id ASC`,
        [conversationId, owner.userId, owner.organizationId],
      );
      const { path } = activePath(all.rows.map((row) => ({ id: row.id, parentId: row.parentId, createdAt: row.sortKey })), source.leaf);
      const end = path.indexOf(messageId);
      if (end === -1) return null;
      const rows = new Map(all.rows.map((row) => [row.id, row]));
      const copied: StoredMessage[] = [];
      for (const id of path.slice(0, end + 1)) {
        const { parentId: _parent, sortKey: _key, ...row } = rows.get(id)!;
        copied.push(await this.decryptMessage(client, owner, conversationId, row));
      }
      const original = await this.decryptTitle(client, owner, source);

      // Nouvelle conversation : tout est rechiffré sous ses propres identifiants (AAD).
      const id = randomUUID();
      const seal = (text: string, aad: string) => this.keyring.encrypt(client, owner.organizationId, text, aad);
      const inserted = await client.query<ConversationRow>(
        `INSERT INTO conversations
           (id, user_id, organization_id, title, agent_id, project_id, model_provider, model_id,
            use_agent_knowledge, use_project_knowledge, sensitive, creativity, length, instructions)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
         WHERE EXISTS (SELECT 1 FROM organization_members WHERE user_id = $2 AND organization_id = $3)
         RETURNING ${SUMMARY_COLUMNS}`,
        [
          id,
          owner.userId,
          owner.organizationId,
          await seal(original.title, titleAad(owner, id)),
          source.agentId,
          source.projectId,
          source.modelProvider,
          source.modelId,
          source.useAgentKnowledge,
          source.useProjectKnowledge,
          source.sensitive,
          source.creativity,
          source.length,
          original.settings?.instructions ? await seal(original.settings.instructions, conversationFieldAad(owner, id, "instructions")) : null,
        ],
      );
      if (!inserted.rowCount) throw new Error("MEMBERSHIP_REQUIRED");

      let parentId: string | null = null;
      for (const message of copied) {
        parentId = (await this.insertMessage(client, owner, id, message.role, message.content, message.sources, parentId, undefined, message.author, message.incomplete === true)).id;
      }
      const row = (
        await client.query<ConversationRow>(
          `UPDATE conversations SET current_leaf_id = $4 WHERE id = $1 AND user_id = $2 AND organization_id = $3 RETURNING ${SUMMARY_COLUMNS}`,
          [id, owner.userId, owner.organizationId, parentId],
        )
      ).rows[0]!;
      return this.decryptTitle(client, owner, row);
    });
  }

  async importConversation(owner: ConversationOwner, title: string, messages: { role: MessageRole; content: string }[]) {
    const conversation = await this.create(owner, title);
    try {
      await withTenant(this.pool, owner, async (client) => {
        await notActivity(client);
        let parentId: string | null = null;
        for (const message of messages) {
          parentId = (await this.insertMessage(client, owner, conversation.id, message.role, message.content, undefined, parentId)).id;
        }
        await client.query(
          `UPDATE conversations SET current_leaf_id = $4, updated_at = now()
           WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
          [conversation.id, owner.userId, owner.organizationId, parentId],
        );
      });
    } catch (error) {
      // Pas de conversation vide laissée derrière un import échoué.
      await this.delete(owner, conversation.id).catch(() => undefined);
      throw error;
    }
    return conversation;
  }

  async setFeedback(owner: ConversationOwner, conversationId: string, messageId: string, feedback: MessageFeedback | null) {
    return withTenant(this.pool, owner, async (client) => {
      const message = await client.query<{ runId: string | null }>(
        `SELECT run_id AS "runId" FROM messages
         WHERE id = $1 AND role = 'assistant' AND conversation_id = $2 AND user_id = $3 AND organization_id = $4`,
        [messageId, conversationId, owner.userId, owner.organizationId],
      );
      if (!message.rowCount) return null;
      if (!feedback) {
        await client.query("DELETE FROM message_feedback WHERE message_id = $1 AND user_id = $2 AND organization_id = $3", [messageId, owner.userId, owner.organizationId]);
      } else {
        const comment = feedback.comment ? await this.keyring.encrypt(client, owner.organizationId, feedback.comment, feedbackAad(owner, messageId)) : null;
        await client.query(
          `INSERT INTO message_feedback (message_id, conversation_id, organization_id, user_id, rating, comment)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (message_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()`,
          [messageId, conversationId, owner.organizationId, owner.userId, feedback.rating === "up" ? 1 : -1, comment],
        );
      }
      return { runId: message.rows[0]!.runId };
    });
  }

  async selectBranch(owner: ConversationOwner, conversationId: string, messageId: string) {
    return withTenant(this.pool, owner, async (client) => {
      const conversation = await client.query(
        `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND organization_id = $3 FOR UPDATE`,
        [conversationId, owner.userId, owner.organizationId],
      );
      if (!conversation.rowCount) return false;
      const nodes = await this.nodes(client, owner, conversationId);
      if (!nodes.some((node) => node.id === messageId)) return false;
      await client.query(
        `UPDATE conversations SET current_leaf_id = $4
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [conversationId, owner.userId, owner.organizationId, latestLeaf(nodes, messageId)],
      );
      return true;
    });
  }

  async replaceLastAssistant(
    owner: ConversationOwner,
    conversationId: string,
    previousAssistantId: string,
    content: string,
    sources?: MessageSource[],
    runId?: string,
    author?: string,
    incomplete?: boolean,
  ) {
    return withTenant(this.pool, owner, async (client) => {
      const conversation = await client.query(
        `SELECT 1 FROM conversations
         WHERE id = $1 AND user_id = $2 AND organization_id = $3
         FOR UPDATE`,
        [conversationId, owner.userId, owner.organizationId],
      );
      if (!conversation.rowCount) return null;

      // La conversation a bougé entre-temps (autre réponse, autre branche) : rien n'est ajouté.
      if ((await this.currentLeaf(client, owner, conversationId)) !== previousAssistantId) return null;
      const previous = await client.query<{ parentId: string | null }>(
        `SELECT parent_id AS "parentId" FROM messages
         WHERE id = $1 AND role = 'assistant' AND conversation_id = $2 AND user_id = $3 AND organization_id = $4`,
        [previousAssistantId, conversationId, owner.userId, owner.organizationId],
      );
      if (!previous.rowCount) return null;

      // Nouvelle version, sœur de l'ancienne : celle-ci reste consultable.
      const message = await this.insertMessage(client, owner, conversationId, "assistant", content, sources, previous.rows[0]!.parentId, runId, author, incomplete);
      await client.query(
        `UPDATE conversations SET current_leaf_id = $4, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [conversationId, owner.userId, owner.organizationId, message.id],
      );
      return message;
    });
  }

  async extendAssistant(owner: ConversationOwner, conversationId: string, messageId: string, addition: string, incomplete: boolean) {
    return withTenant(this.pool, owner, async (client) => {
      const conversation = await client.query(
        `SELECT 1 FROM conversations
         WHERE id = $1 AND user_id = $2 AND organization_id = $3
         FOR UPDATE`,
        [conversationId, owner.userId, owner.organizationId],
      );
      if (!conversation.rowCount) return null;
      // La conversation a bougé entre-temps (autre réponse, autre branche) : rien n'est ajouté.
      if ((await this.currentLeaf(client, owner, conversationId)) !== messageId) return null;
      const row = (
        await client.query<MessageRow>(
          `SELECT id, role, content, sources, author, incomplete, created_at AS "createdAt" FROM messages
           WHERE id = $1 AND role = 'assistant' AND conversation_id = $2 AND user_id = $3 AND organization_id = $4`,
          [messageId, conversationId, owner.userId, owner.organizationId],
        )
      ).rows[0];
      if (!row) return null;
      const message = await this.decryptMessage(client, owner, conversationId, row);
      message.content += addition;
      await client.query(
        `UPDATE messages SET content = $5, incomplete = $6
         WHERE id = $1 AND conversation_id = $2 AND user_id = $3 AND organization_id = $4`,
        [
          messageId,
          conversationId,
          owner.userId,
          owner.organizationId,
          await this.keyring.encrypt(client, owner.organizationId, message.content, messageAad(owner, conversationId, messageId, "assistant")),
          incomplete,
        ],
      );
      await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1 AND user_id = $2 AND organization_id = $3", [
        conversationId,
        owner.userId,
        owner.organizationId,
      ]);
      if (incomplete) message.incomplete = true;
      else delete message.incomplete;
      return message;
    });
  }
}
