import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Agent, AgentStore } from "../agents/store.js";
import { sanitizeFileName } from "../attachments/detect.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { KNOWLEDGE_FILE_MAX_BYTES } from "../db/schema.js";
import { detectKnowledgeFile } from "../knowledge/detect.js";
import { LinkError } from "../knowledge/safe-fetch.js";
import type { KnowledgeService } from "../knowledge/service.js";
import { baseName, KnowledgeLimitError, MAX_BASES_PER_OWNER, type KnowledgeBase, type KnowledgeFolder, type KnowledgeOwner, type KnowledgeSource } from "../knowledge/store.js";
import type { MalwareScanner } from "../security/antivirus.js";
import type { RouteKit } from "./kit.js";
import { scanUpload } from "./scan.js";

export type KnowledgeRouteDependencies = {
  knowledge: KnowledgeService;
  agents?: AgentStore | undefined;
  canManageAgent: (user: AuthenticatedUser, agent: Agent) => boolean;
  scanner?: MalwareScanner | undefined;
};

const ownerParams = z.object({ id: z.uuid() });
type OwnerKind = "agents" | "projects";
const sourceParams = z.object({ id: z.uuid() });
const linkSchema = z.object({ url: z.string().trim().min(8).max(2_000) }).strict();
const baseSchema = z.object({ confidential: z.boolean() }).strict();
const nameSchema = z.string().max(200).transform((value, context) => baseName(value) ?? (context.addIssue({ code: "custom", message: "name" }), z.NEVER));
const createBaseSchema = z.object({ name: nameSchema }).strict();
const updateBaseSchema = z.object({ name: nameSchema.optional(), confidential: z.boolean().optional() }).strict();
const folderSchema = z.object({ name: nameSchema, parentId: z.uuid().nullable().default(null) }).strict();
const updateFolderSchema = z.object({ name: nameSchema.optional(), parentId: z.uuid().nullable().optional() }).strict();
const moveSchema = z.object({ folderId: z.uuid().nullable() }).strict();
const linksSchema = z.object({ baseIds: z.array(z.uuid()).max(MAX_BASES_PER_OWNER) }).strict();
const folderLink = linkSchema.extend({ folderId: z.uuid().nullable().optional() });

function decodeName(header: unknown) {
  if (typeof header !== "string") return "document";
  try {
    return sanitizeFileName(decodeURIComponent(header));
  } catch {
    return sanitizeFileName(header);
  }
}

/** Vue publique d'une source : jamais son contenu. */
const view = (source: KnowledgeSource) => ({
  id: source.id,
  kind: source.kind,
  status: source.status,
  errorCode: source.errorCode,
  name: source.name,
  url: source.url,
  mediaType: source.mediaType,
  folderId: source.folderId,
  size: source.size,
  chunkCount: source.chunkCount,
  embeddingModel: source.embeddingModel,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});

/** Vue publique d'une base : son droit, jamais son contenu. */
const baseView = (base: KnowledgeBase) => ({ id: base.id, name: base.name, confidential: base.confidential, access: base.access, mine: base.access === "owner" });
const folderView = (folder: KnowledgeFolder) => ({ id: folder.id, parentId: folder.parentId, name: folder.name, createdAt: folder.createdAt });

/** Refus de la base de données (droit, clé étrangère, contrôle). */
function isRefusal(error: unknown) {
  const code = (error as { code?: string }).code;
  return code === "42501" || code === "23503" || code === "23514";
}

export function registerKnowledgeRoutes(api: FastifyInstance, kit: RouteKit, deps: KnowledgeRouteDependencies) {
  const { knowledge } = deps;
  const store = knowledge.store;

  const checkImportLimit = api.createRateLimit({
    max: 30,
    timeWindow: "1 minute",
    keyGenerator: (request) => `user-knowledge:${kit.principal(request).userId}`,
  });

  /**
   * Agent : visible de toute l'organisation, modifiable par son auteur ou un
   * admin. Projet : réservé à son propriétaire (garanti par la RLS).
   */
  async function resolveOwner(
    request: FastifyRequest,
    reply: FastifyReply,
    user: AuthenticatedUser,
    write: boolean,
    kind: OwnerKind,
  ): Promise<{ owner: KnowledgeOwner; agent: Agent | null; canManage: boolean } | null> {
    const params = ownerParams.safeParse(request.params);
    if (!params.success) {
      await reply.code(400).send({ error: "Invalid request" });
      return null;
    }
    if (write && !kit.canWrite(user)) {
      await kit.denyWrite(request, reply, user);
      return null;
    }
    if (kind === "projects") {
      return { owner: { kind: "project", projectId: params.data.id }, agent: null, canManage: kit.canWrite(user) };
    }

    const agent = deps.agents ? await deps.agents.get(user, params.data.id) : null;
    if (!agent) {
      await reply.code(404).send({ error: "Not found" });
      return null;
    }
    const canManage = kit.canWrite(user) && deps.canManageAgent(user, agent);
    if (write && !canManage) {
      await kit.denyWrite(request, reply, user);
      return null;
    }
    return { owner: { kind: "agent", agentId: agent.id }, agent, canManage };
  }

  async function ensureBase(reply: FastifyReply, user: AuthenticatedUser, owner: KnowledgeOwner) {
    try {
      return await store.ensureBase(user, owner);
    } catch (error) {
      if (error instanceof Error && ["AGENT_NOT_FOUND", "PROJECT_NOT_FOUND"].includes(error.message)) {
        await reply.code(404).send({ error: "Not found" });
        return null;
      }
      throw error;
    }
  }

  async function rateLimited(request: FastifyRequest, reply: FastifyReply) {
    const limit = await checkImportLimit(request);
    if (!limit.isAllowed && limit.isExceeded) {
      reply.header("Retry-After", Math.ceil(limit.ttl / 1000));
      await reply.code(429).send({ error: "Too many requests" });
      return true;
    }
    return false;
  }

  type Target = { type: string; id: string; owner: string };

  /** Fichier entrant : format reconnu, antivirus, puis enregistré (chiffré) et indexé. */
  // La base n'est résolue (et créée au besoin) qu'après l'antivirus : un fichier refusé ne laisse rien.
  async function ingestFile(request: FastifyRequest, reply: FastifyReply, user: AuthenticatedUser, resolveBase: () => Promise<KnowledgeBase | null>, target: Target, folderId: string | null) {
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "Invalid request" });
    const bytes = request.body;
    const name = decodeName(request.headers["x-file-name"]);
    const detected = detectKnowledgeFile(bytes, name, KNOWLEDGE_FILE_MAX_BYTES, { images: knowledge.readsImages });
    if (typeof detected === "string") {
      await kit.record(request, user, { eventType: "knowledge.source_create", outcome: "denied", targetType: target.type, targetId: target.id, details: { reason: detected, size: bytes.length } });
      return reply.code(415).send({ error: "Unsupported file", reason: detected });
    }
    // Antivirus avant tout stockage ou extraction.
    if (!(await scanUpload(kit, deps.scanner, request, reply, user, bytes, { type: target.type, id: target.id }))) return reply;
    const base = await resolveBase();
    if (!base) return reply;
    try {
      const source = await store.addSource(user, base.id, { kind: "file", name, mediaType: detected.mediaType, bytes, folderId });
      knowledge.enqueue(user, source.id, request);
      await kit.record(request, user, {
        eventType: "knowledge.source_create",
        targetType: "knowledge_source",
        targetId: source.id,
        details: { kind: "file", owner: target.owner, format: detected.format, size: bytes.length, confidential: base.confidential },
      });
      return reply.code(202).send({ source: view(source) });
    } catch (error) {
      if (error instanceof KnowledgeLimitError) return reply.code(409).send({ error: "Limit reached", reason: error.code });
      // Dossier d'une autre base, ou base non modifiable : refusé par la base de données.
      if (isRefusal(error)) return reply.code(404).send({ error: "Not found" });
      throw error;
    }
  }

  /** Lien entrant : politique de l'organisation, contrôle anti-SSRF, puis récupéré en tâche de fond. */
  async function ingestLink(request: FastifyRequest, reply: FastifyReply, user: AuthenticatedUser, base: KnowledgeBase, target: Target, input: { url: string; folderId?: string | null | undefined }) {
    const policy = await knowledge.linkPolicy(user);
    if (!policy.enabled) return reply.code(403).send({ error: "Links disabled", reason: "links_disabled" });
    let url: URL;
    try {
      url = knowledge.validateLink(input.url, policy.domains);
    } catch (error) {
      const reason = error instanceof LinkError ? error.code : "invalid_url";
      // Tentative de SSRF ou domaine non autorisé : tracée, sans l'URL.
      await kit.record(request, user, { eventType: "knowledge.link_denied", outcome: "denied", targetType: target.type, targetId: target.id, details: { reason } });
      return reply.code(400).send({ error: "Invalid link", reason });
    }
    try {
      const source = await store.addSource(user, base.id, {
        kind: "link",
        name: sanitizeFileName(`${url.hostname}${url.pathname === "/" ? "" : url.pathname}`),
        url: url.href,
        mediaType: null,
        bytes: Buffer.alloc(0),
        folderId: input.folderId ?? null,
      });
      knowledge.enqueue(user, source.id, request);
      await kit.record(request, user, { eventType: "knowledge.source_create", targetType: "knowledge_source", targetId: source.id, details: { kind: "link", owner: target.owner, confidential: base.confidential } });
      return reply.code(202).send({ source: view(source) });
    } catch (error) {
      if (error instanceof KnowledgeLimitError) return reply.code(409).send({ error: "Limit reached", reason: error.code });
      if (isRefusal(error)) return reply.code(404).send({ error: "Not found" });
      throw error;
    }
  }

  for (const kind of ["agents", "projects"] as const) {
    api.get(`/${kind}/:id/knowledge`, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const resolved = await resolveOwner(request, reply, user, false, kind);
      if (!resolved) return reply;

      const base = await store.findBase(user, resolved.owner);
      const [sources, embedder, links] = await Promise.all([
        base ? store.listSources(user, base.id) : Promise.resolve([]),
        knowledge.embedderFor(user, base ?? { confidential: false }),
        knowledge.linkPolicy(user),
      ]);
      return {
        knowledge: {
          id: base?.id ?? null,
          confidential: base?.confidential ?? false,
          canManage: resolved.canManage,
          embeddingModel: embedder?.id ?? null,
          linksEnabled: links.enabled,
          sources: sources.map(view),
        },
      };
    });

    api.patch(`/${kind}/:id/knowledge`, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const resolved = await resolveOwner(request, reply, user, true, kind);
      if (!resolved) return reply;
      const body = baseSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid request" });

      // Base confidentielle d'agent : l'agent doit répondre avec un modèle local.
      if (body.data.confidential && resolved.agent && resolved.agent.provider !== "local") {
        return reply.code(409).send({ error: "Local model required", reason: "agent_requires_local" });
      }
      const base = await ensureBase(reply, user, resolved.owner);
      if (!base) return reply;
      const saved = await store.setConfidential(user, base.id, body.data.confidential);
      if (!saved) return reply.code(404).send({ error: "Not found" });
      knowledge.forget(base.id);

      await kit.record(request, user, {
        eventType: "knowledge.confidential_update",
        targetType: "knowledge_base",
        targetId: base.id,
        details: { confidential: saved.confidential },
      });
      return { knowledge: { id: saved.id, confidential: saved.confidential } };
    });

    api.post(`/${kind}/:id/knowledge/files`, { bodyLimit: KNOWLEDGE_FILE_MAX_BYTES }, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (await rateLimited(request, reply)) return reply;
      const resolved = await resolveOwner(request, reply, user, true, kind);
      if (!resolved) return reply;
      const ownerId = resolved.owner.kind === "agent" ? resolved.owner.agentId : resolved.owner.projectId;
      return ingestFile(request, reply, user, () => ensureBase(reply, user, resolved.owner), { type: resolved.owner.kind, id: ownerId, owner: resolved.owner.kind }, null);
    });

    api.post(`/${kind}/:id/knowledge/links`, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (await rateLimited(request, reply)) return reply;
      const resolved = await resolveOwner(request, reply, user, true, kind);
      if (!resolved) return reply;
      const body = linkSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid request" });
      const ownerId = resolved.owner.kind === "agent" ? resolved.owner.agentId : resolved.owner.projectId;
      const base = await ensureBase(reply, user, resolved.owner);
      if (!base) return reply;
      return ingestLink(request, reply, user, base, { type: resolved.owner.kind, id: ownerId, owner: resolved.owner.kind }, body.data);
    });

    // Bases rattachées (plusieurs, dans l'ordre) : la première reçoit les notes de l'agent.
    api.get(`/${kind}/:id/knowledge-bases`, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const resolved = await resolveOwner(request, reply, user, false, kind);
      if (!resolved) return reply;
      const bases = await store.basesFor(user, resolved.owner);
      // Documents prêts, toutes bases comprises (pastille « connaissances » de la saisie).
      let readySources = 0;
      for (const base of bases) readySources += (await store.listSources(user, base.id)).filter((source) => source.status === "ready").length;
      return { bases: bases.map(baseView), canManage: resolved.canManage, readySources };
    });

    api.put(`/${kind}/:id/knowledge-bases`, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const resolved = await resolveOwner(request, reply, user, true, kind);
      if (!resolved) return reply;
      const body = linksSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid request" });
      // Base confidentielle : l'agent doit répondre avec un modèle local.
      if (resolved.agent && resolved.agent.provider !== "local") {
        for (const id of body.data.baseIds) {
          if ((await store.getBase(user, id))?.confidential) return reply.code(409).send({ error: "Local model required", reason: "agent_requires_local" });
        }
      }
      const ownerId = resolved.owner.kind === "agent" ? resolved.owner.agentId : resolved.owner.projectId;
      if (!(await store.setBasesFor(user, resolved.owner, body.data.baseIds))) {
        // Une base qu'on ne peut pas modifier (agent) ou pas lire (projet) : refus de la base de données.
        await kit.record(request, user, { eventType: "knowledge.link_update", outcome: "denied", targetType: resolved.owner.kind, targetId: ownerId, details: { bases: body.data.baseIds.length } });
        return reply.code(403).send({ error: "Forbidden" });
      }
      for (const id of body.data.baseIds) knowledge.forget(id);
      await kit.record(request, user, { eventType: "knowledge.link_update", targetType: resolved.owner.kind, targetId: ownerId, details: { bases: body.data.baseIds.length } });
      return { bases: (await store.basesFor(user, resolved.owner)).map(baseView) };
    });
  }

  // ---- Bibliothèque ------------------------------------------------------------------

  const baseParams = z.object({ id: z.uuid() });

  /** Base visible, et modifiable si write ; sinon réponse envoyée (404 ou refus tracé). */
  async function libraryBase(request: FastifyRequest, reply: FastifyReply, user: AuthenticatedUser, write: boolean) {
    const params = baseParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" }), null;
    if (write && !kit.canWrite(user)) return kit.denyWrite(request, reply, user), null;
    const base = await store.getBase(user, params.data.id);
    if (!base) return reply.code(404).send({ error: "Not found" }), null;
    if (write && base.access === "view") return kit.denyWrite(request, reply, user), null;
    return base;
  }

  api.get("/knowledge/bases", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    return { bases: (await store.listBases(user)).map((base) => ({ ...baseView(base), sourceCount: base.sourceCount, shared: base.shared, usedBy: base.usedBy, updatedAt: base.updatedAt })) };
  });

  api.post("/knowledge/bases", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const body = createBaseSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const base = await store.createBase(user, body.data.name);
    if (!base) return reply.code(409).send({ error: "Limit reached", reason: "too_many_bases" });
    await kit.record(request, user, { eventType: "knowledge.base_create", targetType: "knowledge_base", targetId: base.id });
    return reply.code(201).send({ base: baseView(base) });
  });

  api.get("/knowledge/bases/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const base = await libraryBase(request, reply, user, false);
    if (!base) return reply;
    const [folders, sources, embedder, links] = await Promise.all([store.listFolders(user, base.id), store.listSources(user, base.id), knowledge.embedderFor(user, base), knowledge.linkPolicy(user)]);
    return {
      base: { ...baseView(base), embeddingModel: embedder?.id ?? null, linksEnabled: links.enabled },
      folders: folders.map(folderView),
      sources: sources.map(view),
    };
  });

  api.patch("/knowledge/bases/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const base = await libraryBase(request, reply, user, true);
    if (!base) return reply;
    const body = updateBaseSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    let saved: KnowledgeBase | null = base;
    if (body.data.name !== undefined) saved = await store.renameBase(user, base.id, body.data.name);
    if (saved && body.data.confidential !== undefined && body.data.confidential !== base.confidential) {
      saved = await store.setConfidential(user, base.id, body.data.confidential);
      knowledge.forget(base.id);
      await kit.record(request, user, { eventType: "knowledge.confidential_update", targetType: "knowledge_base", targetId: base.id, details: { confidential: body.data.confidential } });
    }
    if (!saved) return reply.code(404).send({ error: "Not found" });
    if (body.data.name !== undefined) await kit.record(request, user, { eventType: "knowledge.base_update", targetType: "knowledge_base", targetId: base.id });
    return { base: baseView(saved) };
  });

  api.delete("/knowledge/bases/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const base = await libraryBase(request, reply, user, true);
    if (!base) return reply;
    // Supprimer : son auteur (ou un administrateur), pas un simple éditeur.
    if (base.access !== "owner" && !kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    if (!(await store.deleteBase(user, base.id))) return reply.code(404).send({ error: "Not found" });
    knowledge.forget(base.id);
    await kit.record(request, user, { eventType: "knowledge.base_delete", targetType: "knowledge_base", targetId: base.id });
    return reply.code(204).send();
  });

  api.post("/knowledge/bases/:id/folders", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const base = await libraryBase(request, reply, user, true);
    if (!base) return reply;
    const body = folderSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const folder = await store.createFolder(user, base.id, body.data);
    if (!folder) return reply.code(409).send({ error: "Invalid folder", reason: "folder_rejected" });
    knowledge.forget(base.id);
    await kit.record(request, user, { eventType: "knowledge.folder_create", targetType: "knowledge_base", targetId: base.id });
    return reply.code(201).send({ folder: folderView(folder) });
  });

  api.patch("/knowledge/folders/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = baseParams.safeParse(request.params);
    const body = updateFolderSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const folder = await store.updateFolder(user, params.data.id, body.data);
    // Boucle, trop profond, autre base, ou base non modifiable : refus.
    if (!folder) return reply.code(409).send({ error: "Invalid folder", reason: "folder_rejected" });
    knowledge.forget(folder.baseId);
    await kit.record(request, user, { eventType: "knowledge.folder_update", targetType: "knowledge_base", targetId: folder.baseId });
    return { folder: folderView(folder) };
  });

  api.delete("/knowledge/folders/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = baseParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await store.deleteFolder(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "knowledge.folder_delete", targetType: "knowledge_folder", targetId: params.data.id });
    return reply.code(204).send();
  });

  api.post("/knowledge/bases/:id/files", { bodyLimit: KNOWLEDGE_FILE_MAX_BYTES }, async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (await rateLimited(request, reply)) return reply;
    const base = await libraryBase(request, reply, user, true);
    if (!base) return reply;
    const folder = request.headers["x-folder-id"];
    const folderId = typeof folder === "string" && z.uuid().safeParse(folder).success ? folder : null;
    return ingestFile(request, reply, user, async () => base, { type: "knowledge_base", id: base.id, owner: "library" }, folderId);
  });

  api.post("/knowledge/bases/:id/links", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (await rateLimited(request, reply)) return reply;
    const base = await libraryBase(request, reply, user, true);
    if (!base) return reply;
    const body = folderLink.strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    return ingestLink(request, reply, user, base, { type: "knowledge_base", id: base.id, owner: "library" }, body.data);
  });

  api.patch("/knowledge/sources/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const source = await writableSource(request, reply, user);
    if (!source) return reply;
    const body = moveSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await store.moveSource(user, source.id, body.data.folderId))) return reply.code(409).send({ error: "Invalid folder", reason: "folder_rejected" });
    return { source: { ...view(source), folderId: body.data.folderId } };
  });

  /** Source accessible en écriture : base de projet (RLS) ou agent géré par l'utilisateur. */
  async function writableSource(request: FastifyRequest, reply: FastifyReply, user: AuthenticatedUser) {
    const params = sourceParams.safeParse(request.params);
    if (!params.success) {
      await reply.code(400).send({ error: "Invalid request" });
      return null;
    }
    if (!kit.canWrite(user)) {
      await kit.denyWrite(request, reply, user);
      return null;
    }
    const source = await store.getSource(user, params.data.id);
    if (!source) {
      await reply.code(404).send({ error: "Not found" });
      return null;
    }
    // Droit calculé par la base de données (auteur, partage en modification, administrateur).
    if (source.base.access === "view") {
      await kit.denyWrite(request, reply, user);
      return null;
    }
    return source;
  }

  api.delete("/knowledge/sources/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const source = await writableSource(request, reply, user);
    if (!source) return reply;

    if (!(await store.deleteSource(user, source.id))) return reply.code(404).send({ error: "Not found" });
    knowledge.forget(source.baseId);
    await kit.record(request, user, {
      eventType: "knowledge.source_delete",
      targetType: "knowledge_source",
      targetId: source.id,
      details: { baseId: source.baseId },
    });
    return reply.code(204).send();
  });

  api.post("/knowledge/sources/:id/reindex", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (await rateLimited(request, reply)) return reply;
    const source = await writableSource(request, reply, user);
    if (!source) return reply;

    await store.setStatus(user, source.id, "pending");
    knowledge.enqueue(user, source.id, request);
    await kit.record(request, user, { eventType: "knowledge.source_reindex", targetType: "knowledge_source", targetId: source.id });
    return reply.code(202).send({ source: { ...view(source), status: "pending", errorCode: null } });
  });

  // Texte lu d'un document (passages dans l'ordre) : ouvrir une citation à sa place,
  // dans l'interface, au lieu de télécharger le fichier. Mêmes droits que le téléchargement.
  api.get("/knowledge/sources/:id/passages", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const params = sourceParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const found = await store.sourcePassages(user, params.data.id);
    if (!found) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "knowledge.source_view", targetType: "knowledge_source", targetId: params.data.id });
    return { name: found.name, passages: found.passages };
  });

  api.get("/knowledge/sources/:id/content", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const params = sourceParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });

    const file = await store.sourceContent(user, params.data.id);
    if (!file || file.bytes.length === 0) return reply.code(404).send({ error: "Not found" });

    // Jamais interprété par le navigateur : téléchargement, sandbox, type neutre.
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
    reply.header("X-Content-Type-Options", "nosniff");
    await kit.record(request, user, { eventType: "knowledge.source_download", targetType: "knowledge_source", targetId: params.data.id });
    return reply.send(file.bytes);
  });
}
