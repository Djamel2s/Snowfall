import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ATTACHMENT_MAX_BYTES } from "../db/schema.js";
import { detectFile, sanitizeFileName } from "../attachments/detect.js";
import { ExtractionError, extractText } from "../attachments/extract.js";
import type { AttachmentStore } from "../attachments/store.js";
import type { MalwareScanner } from "../security/antivirus.js";
import type { RouteKit } from "./kit.js";
import { scanUpload } from "./scan.js";

const conversationParams = z.object({ id: z.uuid() });
const attachmentParams = z.object({ id: z.uuid() });

function decodeName(header: unknown) {
  if (typeof header !== "string") return "fichier";
  try {
    return sanitizeFileName(decodeURIComponent(header));
  } catch {
    return sanitizeFileName(header);
  }
}

export function registerAttachmentRoutes(api: FastifyInstance, kit: RouteKit, store: AttachmentStore, scanner?: MalwareScanner) {
  const checkUploadLimit = api.createRateLimit({
    max: 30,
    timeWindow: "1 minute",
    keyGenerator: (request) => `user-uploads:${kit.principal(request).userId}`,
  });

  api.post(
    "/conversations/:id/attachments",
    { bodyLimit: ATTACHMENT_MAX_BYTES },
    async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);

      const limit = await checkUploadLimit(request);
      if (!limit.isAllowed && limit.isExceeded) {
        reply.header("Retry-After", Math.ceil(limit.ttl / 1000));
        return reply.code(429).send({ error: "Too many requests" });
      }
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const params = conversationParams.safeParse(request.params);
      if (!params.success || !Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ error: "Invalid request" });
      }

      const bytes = request.body;
      const name = decodeName(request.headers["x-file-name"]);
      const file = detectFile(bytes, name);
      if (!file) {
        await kit.record(request, user, {
          eventType: "attachment.create",
          outcome: "denied",
          targetType: "conversation",
          targetId: params.data.id,
          details: { reason: "unsupported_type", size: bytes.length },
        });
        return reply.code(415).send({ error: "Unsupported file" });
      }

      // Antivirus avant toute lecture du contenu.
      if (!(await scanUpload(kit, scanner, request, reply, user, bytes, { type: "conversation", id: params.data.id }))) return reply;

      let text: string | null = null;
      if (file.kind === "document") {
        try {
          text = await extractText(bytes, file.mediaType);
        } catch (error) {
          if (error instanceof ExtractionError) return reply.code(422).send({ error: "Unreadable document" });
          throw error;
        }
      }

      try {
        const attachment = await store.create(user, params.data.id, { name, file, bytes, text });
        if (!attachment) return reply.code(404).send({ error: "Not found" });

        await kit.record(request, user, {
          eventType: "attachment.create",
          targetType: "attachment",
          targetId: attachment.id,
          details: { kind: file.kind, mediaType: file.mediaType, size: bytes.length },
        });
        return reply.code(201).send({ attachment });
      } catch (error) {
        if (error instanceof Error && error.message === "TOO_MANY_ATTACHMENTS") {
          return reply.code(409).send({ error: "Too many attachments" });
        }
        throw error;
      }
    },
  );

  api.get("/attachments/:id/content", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);

    const params = attachmentParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });

    const file = await store.content(user, params.data.id);
    if (!file) return reply.code(404).send({ error: "Not found" });

    // Jamais interprété par le navigateur : téléchargement, sandbox, type figé.
    reply.header("Content-Type", file.mediaType);
    reply.header(
      "Content-Disposition",
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(file.bytes);
  });

  api.delete("/attachments/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

    const params = attachmentParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await store.delete(user, params.data.id))) return reply.code(404).send({ error: "Not found" });

    await kit.record(request, user, { eventType: "attachment.delete", targetType: "attachment", targetId: params.data.id });
    return reply.code(204).send();
  });
}
