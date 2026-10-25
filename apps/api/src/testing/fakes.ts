// Implémentations en mémoire pour les tests de routes (aucune base requise).
import { activePath, latestLeaf } from "../conversations/branches.js";
import type { MessageFeedback } from "../conversations/store.js";
import type { AttachmentMeta } from "../attachments/store.js";
import type { SessionStore } from "../auth/session-store.js";
import type { TenantContext } from "../db/tenant.js";
import type { ChunkInput, KnowledgeBase, KnowledgeOwner, KnowledgeSource, KnowledgeStore } from "../knowledge/store.js";
import { contextHeader } from "../knowledge/search.js";
import {
  normalizeForSearch,
  type ConversationOwner,
  type ConversationStore,
  type ConversationSummary,
  type StoredMessage,
} from "../conversations/store.js";

type FakeConversation = ConversationSummary & { owner: ConversationOwner; expiresAt?: number };

export function createFakeConversationStore(): ConversationStore & {
  /** Pièces jointes connues du faux magasin (id → métadonnées). */
  files: Map<string, AttachmentMeta>;
  /** Fait échoir une conversation temporaire (tests de purge). */
  expire(conversationId: string): void;
} {
  const conversations = new Map<string, FakeConversation>();
  // Tous les messages (toutes branches), avec leur parent ; feuille affichée par conversation.
  const messages = new Map<string, (StoredMessage & { parentId: string | null })[]>();
  const leaves = new Map<string, string | null>();
  const view = (id: string): StoredMessage[] => {
    const all = messages.get(id) ?? [];
    const { path, branches } = activePath(all, leaves.get(id) ?? null);
    return path.map((messageId) => {
      const { parentId: _parent, ...message } = all.find((item) => item.id === messageId)!;
      const branch = branches.get(messageId);
      const rated = feedback.get(messageId);
      return { ...message, ...(branch ? { branch } : {}), ...(rated ? { feedback: rated } : {}) };
    });
  };
  const leaf = (id: string) => view(id).at(-1)?.id ?? null;
  const feedback = new Map<string, MessageFeedback>();
  const runs = new Map<string, string>();
  const files = new Map<string, AttachmentMeta>();
  let clock = Date.now();
  const now = () => new Date((clock += 1)).toISOString();

  const owns = (owner: ConversationOwner, id: string) => {
    const conversation = conversations.get(id);
    return conversation?.owner.userId === owner.userId && conversation.owner.organizationId === owner.organizationId;
  };
  const summary = ({ owner: _owner, expiresAt: _expires, ...rest }: FakeConversation): ConversationSummary => rest;
  const message = (role: StoredMessage["role"], content: string, parentId: string | null): StoredMessage & { parentId: string | null } => ({
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: now(),
    parentId,
  });

  return {
    files,
    markSensitive: async (owner, conversationId) => {
      const conversation = conversations.get(conversationId);
      if (conversation && owns(owner, conversationId)) conversation.sensitive = true;
    },
    expire: (conversationId) => {
      const conversation = conversations.get(conversationId);
      if (conversation?.temporary) conversation.expiresAt = 0;
    },

    expiredTemporary: async () =>
      [...conversations.values()]
        .filter((item) => item.temporary && (item.expiresAt ?? Infinity) <= Date.now())
        .map((item) => ({ conversationId: item.id, ...item.owner })),

    list: async (owner) =>
      [...conversations.values()]
        .filter((item) => owns(owner, item.id) && !item.temporary)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summary),

    create: async (owner, title = "Nouvelle conversation", agentId, projectId, model, options = {}) => {
      if (agentId && model) throw new Error("INVALID_SELECTION");
      if (options.temporary && projectId) throw new Error("INVALID_SELECTION");
      const at = now();
      const conversation: FakeConversation = {
        id: crypto.randomUUID(),
        owner: { userId: owner.userId, organizationId: owner.organizationId },
        title,
        agentId: agentId ?? null,
        model: model ?? null,
        knowledge: { agent: true, project: true },
        projectId: projectId ?? null,
        ...(options.temporary ? { temporary: true as const, expiresAt: Date.now() + 24 * 3_600_000 } : {}),
        createdAt: at,
        updatedAt: at,
      };
      conversations.set(conversation.id, conversation);
      messages.set(conversation.id, []);
      return summary(conversation);
    },

    get: async (owner, id) => (owns(owner, id) ? summary(conversations.get(id)!) : null),

    update: async (owner, id, changes) => {
      if (!owns(owner, id)) return null;
      const conversation = conversations.get(id)!;
      if (changes.selection) {
        if (changes.selection.agentId && changes.selection.model) throw new Error("INVALID_SELECTION");
        conversation.agentId = changes.selection.agentId;
        conversation.model = changes.selection.model;
      }
      if (changes.knowledge) conversation.knowledge = { ...conversation.knowledge, ...changes.knowledge };
      if (changes.title !== undefined) conversation.title = changes.title;
      if (changes.projectId && conversation.temporary) throw new Error("PROJECT_NOT_FOUND");
      if (changes.projectId !== undefined) conversation.projectId = changes.projectId;
      if (changes.settings) {
        if (Object.keys(changes.settings).length) conversation.settings = { ...changes.settings };
        else delete conversation.settings;
      }
      if (changes.archived !== undefined) {
        if (changes.archived) conversation.archived = true;
        else delete conversation.archived;
      }
      if (changes.tags !== undefined) {
        if (changes.tags.length) conversation.tags = [...changes.tags];
        else delete conversation.tags;
      }
      return summary(conversation);
    },

    search: async (owner, query) => {
      const needle = normalizeForSearch(query);
      return [...conversations.values()]
        .filter((item) => owns(owner, item.id) && !item.temporary)
        .flatMap((item) => {
          const hit = (messages.get(item.id) ?? []).find((entry) => normalizeForSearch(entry.content).includes(needle));
          if (hit) return [{ id: item.id, title: item.title, snippet: hit.content.slice(0, 80) }];
          return normalizeForSearch(item.title).includes(needle) ? [{ id: item.id, title: item.title }] : [];
        });
    },

    getMessages: async (owner, id) => (owns(owner, id) ? view(id) : null),

    fork: async (owner, id, messageId) => {
      if (!owns(owner, id)) return null;
      const source = conversations.get(id)!;
      if (source.temporary) throw new Error("TEMPORARY");
      const path = view(id);
      const end = path.findIndex((item) => item.id === messageId);
      if (end === -1) return null;
      const at = now();
      const { owner: _owner, expiresAt: _expires, archived: _archived, tags: _tags, ...rest } = source;
      const copy: FakeConversation = { ...structuredClone(rest), owner, id: crypto.randomUUID(), createdAt: at, updatedAt: at };
      conversations.set(copy.id, copy);
      let parentId: string | null = null;
      const list: (StoredMessage & { parentId: string | null })[] = [];
      for (const { branch: _branch, feedback: _feedback, attachments: _files, ...item } of path.slice(0, end + 1)) {
        const entry: StoredMessage & { parentId: string | null } = { ...structuredClone(item), id: crypto.randomUUID(), parentId };
        list.push(entry);
        parentId = entry.id;
      }
      messages.set(copy.id, list);
      leaves.set(copy.id, parentId);
      return summary(copy);
    },

    importConversation: async (owner, title, imported) => {
      const at = now();
      const conversation: FakeConversation = {
        id: crypto.randomUUID(),
        owner: { userId: owner.userId, organizationId: owner.organizationId },
        title,
        agentId: null,
        model: null,
        knowledge: { agent: true, project: true },
        projectId: null,
        createdAt: at,
        updatedAt: at,
      };
      conversations.set(conversation.id, conversation);
      const list: (StoredMessage & { parentId: string | null })[] = [];
      for (const entry of imported) list.push(message(entry.role, entry.content, list.at(-1)?.id ?? null));
      messages.set(conversation.id, list);
      return summary(conversation);
    },

    setFeedback: async (owner, id, messageId, rating) => {
      if (!owns(owner, id) || !(messages.get(id) ?? []).some((item) => item.id === messageId && item.role === "assistant")) return null;
      if (rating) feedback.set(messageId, rating);
      else feedback.delete(messageId);
      return { runId: runs.get(messageId) ?? null };
    },

    selectBranch: async (owner, id, messageId) => {
      if (!owns(owner, id) || !(messages.get(id) ?? []).some((item) => item.id === messageId)) return false;
      leaves.set(id, latestLeaf(messages.get(id)!, messageId));
      return true;
    },

    delete: async (owner, id) => {
      if (!owns(owner, id)) return false;
      conversations.delete(id);
      messages.delete(id);
      return true;
    },

    appendExchange: async (owner, id, userContent, assistantContent, options = {}) => {
      if (!owns(owner, id)) return null;
      const list = messages.get(id)!;
      let parentId = leaf(id);
      if (options.replaceFromMessageId) {
        const edited = list.find((entry) => entry.id === options.replaceFromMessageId && entry.role === "user");
        if (!edited) return null;
        parentId = edited.parentId;
      }
      const userMessage = message("user", userContent, parentId);
      const attached = (options.attachmentIds ?? []).map((fileId) => files.get(fileId)).filter((file) => !!file);
      if (attached.length) userMessage.attachments = attached.map((file) => ({ ...file, messageId: userMessage.id }));
      const assistantMessage: StoredMessage & { parentId: string | null } = message("assistant", assistantContent, userMessage.id);
      if (options.sources?.length) assistantMessage.sources = options.sources;
      if (options.author) assistantMessage.author = options.author;
      if (options.incomplete) assistantMessage.incomplete = true;
      list.push(userMessage, assistantMessage);
      leaves.set(id, assistantMessage.id);
      if (options.runId) runs.set(assistantMessage.id, options.runId);
      conversations.get(id)!.updatedAt = now();
      const { parentId: _u, ...user } = userMessage;
      const { parentId: _a, ...assistant } = assistantMessage;
      return { userMessage: user, assistantMessage: assistant };
    },

    replaceLastAssistant: async (owner, id, previousAssistantId, content, sources, runId, author, incomplete) => {
      if (!owns(owner, id)) return null;
      const list = messages.get(id)!;
      const previous = list.find((item) => item.id === previousAssistantId && item.role === "assistant");
      if (leaf(id) !== previousAssistantId || !previous) return null;
      const replacement: StoredMessage & { parentId: string | null } = message("assistant", content, previous.parentId);
      if (sources?.length) replacement.sources = sources;
      if (author) replacement.author = author;
      if (incomplete) replacement.incomplete = true;
      list.push(replacement);
      leaves.set(id, replacement.id);
      if (runId) runs.set(replacement.id, runId);
      const { parentId: _p, ...stored } = replacement;
      return stored;
    },

    extendAssistant: async (owner, id, messageId, addition, incomplete) => {
      if (!owns(owner, id) || leaf(id) !== messageId) return null;
      const target = messages.get(id)!.find((item) => item.id === messageId && item.role === "assistant");
      if (!target) return null;
      target.content += addition;
      if (incomplete) target.incomplete = true;
      else delete target.incomplete;
      conversations.get(id)!.updatedAt = now();
      const { parentId: _p, ...stored } = target;
      return { ...stored };
    },
  };
}

/** Magasin de sessions minimal : aucune session valide. */
export function emptySessionStore(): SessionStore {
  return {
    create: async () => "",
    resolve: async () => ({ status: "missing" }),
    revoke: async () => null,
    revokeIdpSession: async () => [],
    purgeExpired: async () => 0,
  };
}

/** Base de connaissances en mémoire (mêmes règles de visibilité que la RLS). */
export function createFakeKnowledgeStore(): KnowledgeStore {
  type Base = KnowledgeBase & { organizationId: string; agentId: string | null; projectId: string | null; userId: string | null };
  type Source = KnowledgeSource & { organizationId: string; bytes: Buffer; createdBy: string };
  const bases = new Map<string, Base>();
  const sources = new Map<string, Source>();
  const chunks = new Map<string, ChunkInput[] & { model?: string | null }>();
  const now = () => new Date().toISOString();

  const visible = (tenant: TenantContext, base: Base | undefined): base is Base =>
    !!base && base.organizationId === tenant.organizationId && (base.userId === null || base.userId === tenant.userId);
  const baseOf = (tenant: TenantContext, id: string) => {
    const base = bases.get(id);
    return visible(tenant, base) ? base : null;
  };
  const sourceOf = (tenant: TenantContext, id: string) => {
    const source = sources.get(id);
    return source && baseOf(tenant, source.baseId) ? source : null;
  };
  const publicBase = (base: Base): KnowledgeBase => ({ id: base.id, owner: base.owner, confidential: base.confidential, revision: base.revision });
  const publicSource = ({ organizationId: _o, bytes: _b, createdBy: _c, ...source }: Source): KnowledgeSource => ({ ...source });
  const bump = (baseId: string) => {
    const base = bases.get(baseId);
    if (base) base.revision++;
  };
  const find = (tenant: TenantContext, owner: KnowledgeOwner) =>
    [...bases.values()].find(
      (base) =>
        visible(tenant, base) &&
        (owner.kind === "agent" ? base.agentId === owner.agentId : base.projectId === owner.projectId && base.userId === tenant.userId),
    ) ?? null;

  return {
    findBase: async (tenant, owner) => {
      const base = find(tenant, owner);
      return base ? publicBase(base) : null;
    },
    ensureBase: async (tenant, owner) => {
      const existing = find(tenant, owner);
      if (existing) return publicBase(existing);
      // Projet d'un autre membre : invisible, comme sous RLS.
      const foreign = owner.kind === "project" && [...bases.values()].some((base) => base.projectId === owner.projectId);
      if (foreign) throw new Error("PROJECT_NOT_FOUND");
      const base: Base = {
        id: crypto.randomUUID(),
        owner: owner.kind,
        confidential: false,
        revision: 0,
        organizationId: tenant.organizationId,
        agentId: owner.kind === "agent" ? owner.agentId : null,
        projectId: owner.kind === "project" ? owner.projectId : null,
        userId: owner.kind === "project" ? tenant.userId : null,
      };
      bases.set(base.id, base);
      return publicBase(base);
    },
    setConfidential: async (tenant, baseId, confidential) => {
      const base = baseOf(tenant, baseId);
      if (!base) return null;
      base.confidential = confidential;
      base.revision++;
      return publicBase(base);
    },
    listSources: async (tenant, baseId) =>
      [...sources.values()].filter((source) => source.baseId === baseId && sourceOf(tenant, source.id)).map(publicSource),
    addSource: async (tenant, baseId, input) => {
      if (!baseOf(tenant, baseId)) throw new Error("KNOWLEDGE_BASE_NOT_FOUND");
      const source: Source = {
        id: crypto.randomUUID(),
        baseId,
        kind: input.kind,
        status: "pending",
        errorCode: null,
        name: input.name,
        url: input.url ?? null,
        mediaType: input.mediaType,
        size: input.bytes.length,
        chunkCount: 0,
        embeddingModel: null,
        createdAt: now(),
        updatedAt: now(),
        organizationId: tenant.organizationId,
        bytes: input.bytes,
        createdBy: tenant.userId,
      };
      sources.set(source.id, source);
      bump(baseId);
      return publicSource(source);
    },
    getSource: async (tenant, sourceId) => {
      const source = sourceOf(tenant, sourceId);
      if (!source) return null;
      const base = bases.get(source.baseId)!;
      return { ...publicSource(source), base: publicBase(base), agentId: base.agentId };
    },
    sourceContent: async (tenant, sourceId) => {
      const source = sourceOf(tenant, sourceId);
      return source ? { name: source.name, url: source.url, mediaType: source.mediaType, bytes: source.bytes } : null;
    },
    updateFetched: async (tenant, sourceId, input) => {
      const source = sourceOf(tenant, sourceId);
      if (!source) return;
      Object.assign(source, { name: input.name, mediaType: input.mediaType, bytes: input.bytes, size: input.bytes.length });
    },
    setStatus: async (tenant, sourceId, status, errorCode = null) => {
      const source = sourceOf(tenant, sourceId);
      if (!source) return;
      Object.assign(source, { status, errorCode, updatedAt: now() });
      bump(source.baseId);
    },
    replaceChunks: async (tenant, sourceId, items, embeddingModel) => {
      const source = sourceOf(tenant, sourceId);
      if (!source) return false;
      chunks.set(sourceId, items);
      Object.assign(source, { status: "ready", errorCode: null, chunkCount: items.length, embeddingModel });
      bump(source.baseId);
      return true;
    },
    deleteSource: async (tenant, sourceId) => {
      const source = sourceOf(tenant, sourceId);
      if (!source) return false;
      sources.delete(sourceId);
      chunks.delete(sourceId);
      bump(source.baseId);
      return true;
    },
    baseRevision: async (tenant, baseId) => baseOf(tenant, baseId)?.revision ?? null,
    load: async (tenant, baseId) => {
      const base = baseOf(tenant, baseId);
      if (!base) return null;
      const ready = [...sources.values()].filter((source) => source.baseId === baseId && source.status === "ready");
      return {
        base: publicBase(base),
        sources: new Map(ready.map((source) => [source.id, { name: source.name, url: source.url }])),
        chunks: ready.flatMap((source) =>
          (chunks.get(source.id) ?? []).map((chunk, ordinal) => ({
            id: `${source.id}:${ordinal}`,
            sourceId: source.id,
            ordinal,
            text: chunk.text,
            heading: chunk.heading ?? null,
            page: chunk.page ?? null,
            context: contextHeader(source.name, chunk.heading),
            vector: chunk.vector,
            model: source.embeddingModel,
          })),
        ),
      };
    },
    pending: async () =>
      [...sources.values()]
        .filter((source) => source.status === "pending" || source.status === "processing")
        .map((source) => ({ sourceId: source.id, organizationId: source.organizationId, createdBy: source.createdBy })),
  };
}
