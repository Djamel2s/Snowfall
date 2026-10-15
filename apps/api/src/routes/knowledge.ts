import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Agent, AgentStore } from "../agents/store.js";
import { sanitizeFileName } from "../attachments/detect.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { KNOWLEDGE_FILE_MAX_BYTES } from "../db/schema.js";
import { detectKnowledgeFile } from "../knowledge/detect.js";
import { LinkError } from "../knowledge/safe-fetch.js";
import type { KnowledgeService } from "../knowledge/service.js";
import { KnowledgeLimitError, type KnowledgeOwner, type KnowledgeSource } from "../knowledge/store.js";
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
  size: source.size,
  chunkCount: source.chunkCount,
  embeddingModel: source.embeddingModel,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});

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
        details: { owner: base.owner, confidential: saved.confidential },
      });
      return { knowledge: { id: saved.id, confidential: saved.confidential } };
    });

    api.post(`/${kind}/:id/knowledge/files`, { bodyLimit: KNOWLEDGE_FILE_MAX_BYTES }, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (await rateLimited(request, reply)) return reply;
      const resolved = await resolveOwner(request, reply, user, true, kind);
      if (!resolved) return reply;
      if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "Invalid request" });

      const bytes = request.body;
      const name = decodeName(request.headers["x-file-name"]);
      const detected = detectKnowledgeFile(bytes, name, KNOWLEDGE_FILE_MAX_BYTES);
      if (typeof detected === "string") {
        await kit.record(request, user, {
          eventType: "knowledge.source_create",
          outcome: "denied",
          targetType: resolved.owner.kind,
          targetId: resolved.owner.kind === "agent" ? resolved.owner.agentId : resolved.owner.projectId,
          details: { reason: detected, size: bytes.length },
        });
        return reply.code(415).send({ error: "Unsupported file", reason: detected });
      }

      // Antivirus avant tout stockage ou extraction.
      const ownerId = resolved.owner.kind === "agent" ? resolved.owner.agentId : resolved.owner.projectId;
      if (!(await scanUpload(kit, deps.scanner, request, reply, user, bytes, { type: resolved.owner.kind, id: ownerId }))) return reply;

      const base = await ensureBase(reply, user, resolved.owner);
      if (!base) return reply;
      try {
        const source = await store.addSource(user, base.id, { kind: "file", name, mediaType: detected.mediaType, bytes });
        knowledge.enqueue(user, source.id, request);
        await kit.record(request, user, {
          eventType: "knowledge.source_create",
          targetType: "knowledge_source",
          targetId: source.id,
          details: { kind: "file", owner: base.owner, format: detected.format, size: bytes.length, confidential: base.confidential },
        });
        return reply.code(202).send({ source: view(source) });
      } catch (error) {
        if (error instanceof KnowledgeLimitError) return reply.code(409).send({ error: "Limit reached", reason: error.code });
        throw error;
      }
    });

    api.post(`/${kind}/:id/knowledge/links`, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (await rateLimited(request, reply)) return reply;
      const resolved = await resolveOwner(request, reply, user, true, kind);
      if (!resolved) return reply;
      const body = linkSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid request" });

      const policy = await knowledge.linkPolicy(user);
      if (!policy.enabled) return reply.code(403).send({ error: "Links disabled", reason: "links_disabled" });

      let url: URL;
      try {
        url = knowledge.validateLink(body.data.url, policy.domains);
      } catch (error) {
        const reason = error instanceof LinkError ? error.code : "invalid_url";
        // Tentative de SSRF ou domaine non autorisé : tracée, sans l'URL.
        await kit.record(request, user, {
          eventType: "knowledge.link_denied",
          outcome: "denied",
          targetType: resolved.owner.kind,
          targetId: resolved.owner.kind === "agent" ? resolved.owner.agentId : resolved.owner.projectId,
          details: { reason },
        });
        return reply.code(400).send({ error: "Invalid link", reason });
      }

      const base = await ensureBase(reply, user, resolved.owner);
      if (!base) return reply;
      try {
        const source = await store.addSource(user, base.id, {
          kind: "link",
          name: sanitizeFileName(`${url.hostname}${url.pathname === "/" ? "" : url.pathname}`),
          url: url.href,
          mediaType: null,
          bytes: Buffer.alloc(0),
        });
        knowledge.enqueue(user, source.id, request);
        await kit.record(request, user, {
          eventType: "knowledge.source_create",
          targetType: "knowledge_source",
          targetId: source.id,
          details: { kind: "link", owner: base.owner, confidential: base.confidential },
        });
        return reply.code(202).send({ source: view(source) });
      } catch (error) {
        if (error instanceof KnowledgeLimitError) return reply.code(409).send({ error: "Limit reached", reason: error.code });
        throw error;
      }
    });

  }

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
    if (source.agentId) {
      const agent = deps.agents ? await deps.agents.get(user, source.agentId) : null;
      if (!agent || !deps.canManageAgent(user, agent)) {
        await kit.denyWrite(request, reply, user);
        return null;
      }
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
      details: { owner: source.base.owner },
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
