// Implémentations en mémoire pour les tests de routes (aucune base requise).
import { activePath, latestLeaf } from "../conversations/branches.js";
import type { MessageFeedback } from "../conversations/store.js";
import { DEFAULT_CONVERSATION_TITLE, provisionalTitle } from "../conversations/store.js";
import type { AttachmentMeta } from "../attachments/store.js";
import type { SessionStore } from "../auth/session-store.js";
import type { TenantContext } from "../db/tenant.js";
import type { ChunkInput, KnowledgeBase, KnowledgeFolder, KnowledgeOwner, KnowledgeSource, KnowledgeStore } from "../knowledge/store.js";
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
  /** Conversations ayant reçu un échange automatique (tâche planifiée, API), hors Pilotage. */
  automated: Set<string>;
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
  const automated = new Set<string>();
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
    automated,
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

    retitle: async (owner, conversationId, title, provisional) => {
      const conversation = conversations.get(conversationId);
      if (!conversation || !owns(owner, conversationId) || conversation.temporary || conversation.title !== provisional) return false;
      conversation.title = title;
      return true;
    },

    list: async (owner) =>
      [...conversations.values()]
        // Comme PostgreSQL : une conversation sans message n'est pas dans l'historique.
        .filter((item) => owns(owner, item.id) && !item.temporary && (messages.get(item.id)?.length ?? 0) > 0)
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
      // Comme PostgreSQL : le premier échange pose le titre provisoire (début de la demande).
      const conversation = conversations.get(id)!;
      if (list.length === 0 && conversation.title === DEFAULT_CONVERSATION_TITLE && userContent) conversation.title = provisionalTitle(userContent);
      const userMessage = message("user", userContent, parentId);
      const attached = (options.attachmentIds ?? []).map((fileId) => files.get(fileId)).filter((file) => !!file);
      if (attached.length) userMessage.attachments = attached.map((file) => ({ ...file, messageId: userMessage.id }));
      const assistantMessage: StoredMessage & { parentId: string | null } = message("assistant", assistantContent, userMessage.id);
      if (options.sources?.length) assistantMessage.sources = options.sources;
      if (options.author) assistantMessage.author = options.author;
      if (options.incomplete) assistantMessage.incomplete = true;
      if (options.activity) assistantMessage.activity = options.activity;
      list.push(userMessage, assistantMessage);
      leaves.set(id, assistantMessage.id);
      if (options.runId) runs.set(assistantMessage.id, options.runId);
      if (options.automated) automated.add(id);
      conversations.get(id)!.updatedAt = now();
      const { parentId: _u, ...user } = userMessage;
      const { parentId: _a, ...assistant } = assistantMessage;
      return { userMessage: user, assistantMessage: assistant };
    },

    replaceLastAssistant: async (owner, id, previousAssistantId, content, sources, runId, author, incomplete, activity) => {
      if (!owns(owner, id)) return null;
      const list = messages.get(id)!;
      const previous = list.find((item) => item.id === previousAssistantId && item.role === "assistant");
      if (leaf(id) !== previousAssistantId || !previous) return null;
      const replacement: StoredMessage & { parentId: string | null } = message("assistant", content, previous.parentId);
      if (sources?.length) replacement.sources = sources;
      if (author) replacement.author = author;
      if (incomplete) replacement.incomplete = true;
      if (activity) replacement.activity = activity;
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

/**
 * Bibliothèque de connaissances en mémoire. Visibilité proche de la RLS : son
 * auteur, une base rattachée à un agent (les droits sur l'agent sont vérifiés
 * par l'API), ou à un de ses projets. Les droits fins (partages) sont couverts
 * par les tests PostgreSQL.
 */
export function createFakeKnowledgeStore(): KnowledgeStore {
  type Base = Omit<KnowledgeBase, "access"> & { organizationId: string; updatedAt: string };
  type Source = KnowledgeSource & { organizationId: string; bytes: Buffer; createdBy: string };
  type Link = { kind: "agent" | "project"; ownerId: string; baseId: string; userId: string; position: number };
  const bases = new Map<string, Base>();
  const sources = new Map<string, Source>();
  const folders = new Map<string, KnowledgeFolder & { organizationId: string }>();
  const links: Link[] = [];
  const chunks = new Map<string, ChunkInput[] & { model?: string | null }>();
  const now = () => new Date().toISOString();

  const visible = (tenant: TenantContext, base: Base | undefined): base is Base =>
    !!base &&
    base.organizationId === tenant.organizationId &&
    (base.createdBy === tenant.userId || links.some((link) => link.baseId === base.id && (link.kind === "agent" || link.userId === tenant.userId)));
  // Sans rôle ni partage dans ce faux : l'auteur modifie, les autres lisent.
  const access = (tenant: TenantContext, base: Base): KnowledgeBase["access"] => (base.createdBy === tenant.userId ? "owner" : "view");
  const baseOf = (tenant: TenantContext, id: string) => {
    const base = bases.get(id);
    return visible(tenant, base) ? base : null;
  };
  const sourceOf = (tenant: TenantContext, id: string) => {
    const source = sources.get(id);
    return source && baseOf(tenant, source.baseId) ? source : null;
  };
  const publicBase = (tenant: TenantContext, base: Base): KnowledgeBase => ({
    id: base.id,
    name: base.name,
    createdBy: base.createdBy,
    confidential: base.confidential,
    revision: base.revision,
    access: access(tenant, base),
  });
  const publicSource = ({ organizationId: _o, bytes: _b, createdBy: _c, ...source }: Source): KnowledgeSource => ({ ...source });
  const bump = (baseId: string) => {
    const base = bases.get(baseId);
    if (base) {
      base.revision++;
      base.updatedAt = now();
    }
  };
  const ownerId = (owner: KnowledgeOwner) => (owner.kind === "agent" ? owner.agentId : owner.projectId);
  const linked = (tenant: TenantContext, owner: KnowledgeOwner) =>
    links
      .filter((link) => link.kind === owner.kind && link.ownerId === ownerId(owner) && (owner.kind === "agent" || link.userId === tenant.userId))
      .sort((a, b) => a.position - b.position)
      .map((link) => baseOf(tenant, link.baseId))
      .filter((base): base is Base => Boolean(base));
  const create = (tenant: TenantContext, name: string | null): Base => {
    const base: Base = { id: crypto.randomUUID(), name, createdBy: tenant.userId, confidential: false, revision: 0, organizationId: tenant.organizationId, updatedAt: now() };
    bases.set(base.id, base);
    return base;
  };
  const descendants = (folderId: string): string[] => [folderId, ...[...folders.values()].filter((folder) => folder.parentId === folderId).flatMap((folder) => descendants(folder.id))];
  const depth = (folderId: string | null): number => (folderId ? 1 + depth(folders.get(folderId)?.parentId ?? null) : 0);

  return {
    listBases: async (tenant) =>
      [...bases.values()]
        .filter((base) => base.organizationId === tenant.organizationId && base.createdBy === tenant.userId)
        .map((base) => ({
          ...publicBase(tenant, base),
          sourceCount: [...sources.values()].filter((source) => source.baseId === base.id).length,
          shared: false,
          updatedAt: base.updatedAt,
          usedBy: links.filter((link) => link.baseId === base.id).map((link) => ({ kind: link.kind, id: link.ownerId })),
        })),
    getBase: async (tenant, baseId) => {
      const base = baseOf(tenant, baseId);
      return base ? publicBase(tenant, base) : null;
    },
    createBase: async (tenant, name) => publicBase(tenant, create(tenant, name)),
    renameBase: async (tenant, baseId, name) => {
      const base = baseOf(tenant, baseId);
      if (!base || access(tenant, base) === "view") return null;
      base.name = name;
      return publicBase(tenant, base);
    },
    deleteBase: async (tenant, baseId) => {
      const base = baseOf(tenant, baseId);
      if (!base || base.createdBy !== tenant.userId) return false;
      bases.delete(baseId);
      for (const [id, source] of sources) if (source.baseId === baseId) sources.delete(id);
      for (const [id, folder] of folders) if (folder.baseId === baseId) folders.delete(id);
      for (let index = links.length - 1; index >= 0; index--) if (links[index]!.baseId === baseId) links.splice(index, 1);
      return true;
    },
    listFolders: async (tenant, baseId) =>
      baseOf(tenant, baseId) ? [...folders.values()].filter((folder) => folder.baseId === baseId).map(({ organizationId: _o, ...folder }) => folder) : [],
    createFolder: async (tenant, baseId, input) => {
      const base = baseOf(tenant, baseId);
      if (!base || access(tenant, base) === "view") return null;
      if (input.parentId && folders.get(input.parentId)?.baseId !== baseId) return null;
      if (depth(input.parentId) >= 8) return null;
      const folder = { id: crypto.randomUUID(), baseId, parentId: input.parentId, name: input.name, createdAt: now(), organizationId: tenant.organizationId };
      folders.set(folder.id, folder);
      const { organizationId: _o, ...view } = folder;
      return view;
    },
    updateFolder: async (tenant, folderId, input) => {
      const folder = folders.get(folderId);
      if (!folder || !baseOf(tenant, folder.baseId)) return null;
      if (input.parentId !== undefined && input.parentId !== null) {
        if (folders.get(input.parentId)?.baseId !== folder.baseId || descendants(folderId).includes(input.parentId)) return null;
      }
      if (input.name !== undefined) folder.name = input.name;
      if (input.parentId !== undefined) folder.parentId = input.parentId;
      const { organizationId: _o, ...view } = folder;
      return view;
    },
    deleteFolder: async (tenant, folderId) => {
      const folder = folders.get(folderId);
      if (!folder || !baseOf(tenant, folder.baseId)) return false;
      const removed = new Set(descendants(folderId));
      for (const id of removed) folders.delete(id);
      for (const [id, source] of sources) if (source.folderId && removed.has(source.folderId)) sources.delete(id);
      bump(folder.baseId);
      return true;
    },
    moveSource: async (tenant, sourceId, folderId) => {
      const source = sourceOf(tenant, sourceId);
      if (!source || (folderId && folders.get(folderId)?.baseId !== source.baseId)) return false;
      source.folderId = folderId;
      return true;
    },
    basesFor: async (tenant, owner) => linked(tenant, owner).map((base) => publicBase(tenant, base)),
    setBasesFor: async (tenant, owner, baseIds) => {
      const wanted = [...new Set(baseIds)];
      if (wanted.some((id) => !baseOf(tenant, id))) return false;
      for (let index = links.length - 1; index >= 0; index--) {
        const link = links[index]!;
        if (link.kind === owner.kind && link.ownerId === ownerId(owner)) links.splice(index, 1);
      }
      for (const [position, baseId] of wanted.entries()) links.push({ kind: owner.kind, ownerId: ownerId(owner), baseId, userId: tenant.userId, position });
      return true;
    },
    findBase: async (tenant, owner) => {
      const base = linked(tenant, owner)[0];
      return base ? publicBase(tenant, base) : null;
    },
    ensureBase: async (tenant, owner) => {
      const existing = linked(tenant, owner)[0];
      if (existing) return publicBase(tenant, existing);
      // Projet d'un autre membre : invisible, comme sous RLS.
      if (owner.kind === "project" && links.some((link) => link.kind === "project" && link.ownerId === owner.projectId && link.userId !== tenant.userId)) throw new Error("PROJECT_NOT_FOUND");
      const base = create(tenant, null);
      links.push({ kind: owner.kind, ownerId: ownerId(owner), baseId: base.id, userId: tenant.userId, position: 0 });
      return publicBase(tenant, base);
    },
    setConfidential: async (tenant, baseId, confidential) => {
      const base = baseOf(tenant, baseId);
      if (!base) return null;
      base.confidential = confidential;
      base.revision++;
      return publicBase(tenant, base);
    },
    listSources: async (tenant, baseId) =>
      [...sources.values()].filter((source) => source.baseId === baseId && sourceOf(tenant, source.id)).map(publicSource),
    addSource: async (tenant, baseId, input) => {
      if (!baseOf(tenant, baseId)) throw new Error("KNOWLEDGE_BASE_NOT_FOUND");
      const source: Source = {
        id: crypto.randomUUID(),
        baseId,
        folderId: input.folderId ?? null,
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
      return { ...publicSource(source), base: publicBase(tenant, bases.get(source.baseId)!) };
    },
    sourceContent: async (tenant, sourceId) => {
      const source = sourceOf(tenant, sourceId);
      return source ? { name: source.name, url: source.url, mediaType: source.mediaType, bytes: source.bytes } : null;
    },
    sourcePassages: async (tenant, sourceId) => {
      const source = sourceOf(tenant, sourceId);
      if (!source || source.status !== "ready") return null;
      return { name: source.name, passages: (chunks.get(sourceId) ?? []).map((chunk) => ({ text: chunk.text, heading: chunk.heading ?? null, page: chunk.page ?? null })) };
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
        base: publicBase(tenant, base),
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
