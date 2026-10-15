// Implémentations en mémoire pour les tests de routes (aucune base requise).
import type { AttachmentMeta } from "../attachments/store.js";
import type { SessionStore } from "../auth/session-store.js";
import {
  normalizeForSearch,
  type ConversationOwner,
  type ConversationStore,
  type ConversationSummary,
  type StoredMessage,
} from "../conversations/store.js";

type FakeConversation = ConversationSummary & { owner: ConversationOwner };

export function createFakeConversationStore(): ConversationStore & {
  /** Pièces jointes connues du faux magasin (id → métadonnées). */
  files: Map<string, AttachmentMeta>;
} {
  const conversations = new Map<string, FakeConversation>();
  const messages = new Map<string, StoredMessage[]>();
  const files = new Map<string, AttachmentMeta>();
  let clock = Date.now();
  const now = () => new Date((clock += 1)).toISOString();

  const owns = (owner: ConversationOwner, id: string) => {
    const conversation = conversations.get(id);
    return conversation?.owner.userId === owner.userId && conversation.owner.organizationId === owner.organizationId;
  };
  const summary = ({ owner: _owner, ...rest }: FakeConversation): ConversationSummary => rest;
  const message = (role: StoredMessage["role"], content: string): StoredMessage => ({
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: now(),
  });

  return {
    files,

    list: async (owner) =>
      [...conversations.values()]
        .filter((item) => owns(owner, item.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summary),

    create: async (owner, title = "Nouvelle conversation", agentId, projectId) => {
      const at = now();
      const conversation: FakeConversation = {
        id: crypto.randomUUID(),
        owner: { userId: owner.userId, organizationId: owner.organizationId },
        title,
        agentId: agentId ?? null,
        projectId: projectId ?? null,
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
      if (changes.title !== undefined) conversation.title = changes.title;
      if (changes.projectId !== undefined) conversation.projectId = changes.projectId;
      return summary(conversation);
    },

    search: async (owner, query) => {
      const needle = normalizeForSearch(query);
      return [...conversations.values()]
        .filter((item) => owns(owner, item.id))
        .flatMap((item) => {
          const hit = (messages.get(item.id) ?? []).find((entry) => normalizeForSearch(entry.content).includes(needle));
          if (hit) return [{ id: item.id, title: item.title, snippet: hit.content.slice(0, 80) }];
          return normalizeForSearch(item.title).includes(needle) ? [{ id: item.id, title: item.title }] : [];
        });
    },

    getMessages: async (owner, id) => (owns(owner, id) ? [...(messages.get(id) ?? [])] : null),

    delete: async (owner, id) => {
      if (!owns(owner, id)) return false;
      conversations.delete(id);
      messages.delete(id);
      return true;
    },

    appendExchange: async (owner, id, userContent, assistantContent, options = {}) => {
      if (!owns(owner, id)) return null;
      let list = messages.get(id)!;
      if (options.replaceFromMessageId) {
        const index = list.findIndex((entry) => entry.id === options.replaceFromMessageId && entry.role === "user");
        if (index === -1) return null;
        list = list.slice(0, index);
        messages.set(id, list);
      }
      const userMessage = message("user", userContent);
      const attached = (options.attachmentIds ?? []).map((fileId) => files.get(fileId)).filter((file) => !!file);
      if (attached.length) userMessage.attachments = attached.map((file) => ({ ...file, messageId: userMessage.id }));
      const assistantMessage = message("assistant", assistantContent);
      list.push(userMessage, assistantMessage);
      conversations.get(id)!.updatedAt = now();
      return { userMessage, assistantMessage };
    },

    replaceLastAssistant: async (owner, id, previousAssistantId, content) => {
      if (!owns(owner, id)) return null;
      const list = messages.get(id)!;
      if (list.at(-1)?.id !== previousAssistantId) return null;
      const replacement = message("assistant", content);
      list.splice(-1, 1, replacement);
      return replacement;
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
