import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { detectFile, sanitizeFileName } from "../attachments/detect.js";
import { ExtractionError, extractText } from "../attachments/extract.js";
import { ATTACHMENT_MAX_BYTES } from "../db/schema.js";
import { detectInjection } from "../security/injection.js";
import type { MalwareScanner } from "../security/antivirus.js";
import { detectSensitive } from "../security/sensitive.js";
import { readZip, SkillArchiveError, splitSkillArchive } from "../skills/archive.js";
import { isOtherScript, isPythonScript, scriptText, SKILL_SCRIPT_TYPE } from "../skills/scripts.js";
import { MAX_SKILL_FILES, SkillRuleError, type SkillInput, type SkillStore } from "../skills/store.js";
import type { RouteKit } from "./kit.js";
import { scanUpload } from "./scan.js";

const idParams = z.object({ id: z.uuid() });
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });
const inputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    // Quand s'en servir : c'est ce que le modèle lit pour décider de la charger.
    // 1 024 : la limite des compétences Anthropic (import compatible).
    description: z.string().trim().min(1).max(1_024),
    instructions: z.string().trim().min(1).max(20_000),
    confidential: z.boolean().default(false),
  })
  .strict();

/**
 * Une compétence partagée touche tous les agents qui l'utilisent : refus d'une
 * consigne déguisée ; donnée sensible seulement dans une compétence confidentielle
 * (réservée aux modèles locaux).
 */
function rejection(input: SkillInput): string | null {
  const text = `${input.description}\n${input.instructions}`;
  if (detectInjection(text).suspicious) return "skill_injection";
  if (!input.confidential && detectSensitive(text).length) return "skill_sensitive";
  return null;
}

function decodeName(header: unknown) {
  if (typeof header !== "string") return "reference";
  try {
    return sanitizeFileName(decodeURIComponent(header));
  } catch {
    return sanitizeFileName(header);
  }
}

/** Bibliothèque de compétences : audit sans contenu (ni nom, ni texte). Partage : routes/sharing.ts. */
export function registerSkillRoutes(api: FastifyInstance, kit: RouteKit, store: SkillStore, scanner?: MalwareScanner) {
  const checkUploadLimit = api.createRateLimit({
    max: 30,
    timeWindow: "1 minute",
    keyGenerator: (request) => `skill-uploads:${kit.principal(request).userId}`,
  });

  api.get("/skills", async (request, reply) => {
    kit.privateResponse(reply);
    return { skills: await store.list(kit.principal(request)) };
  });

  api.post("/skills", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const body = inputSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const rejected = rejection(body.data);
    if (rejected) return reply.code(400).send({ error: "Invalid request", reason: rejected });
    const skill = await store.create(user, body.data);
    await kit.record(request, user, { eventType: "skill.create", targetType: "skill", targetId: skill.id, details: { confidential: skill.confidential } });
    return reply.code(201).send({ skill });
  });

  api.put("/skills/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = idParams.safeParse(request.params);
    const body = inputSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const rejected = rejection(body.data);
    if (rejected) return reply.code(400).send({ error: "Invalid request", reason: rejected });
    const skill = await store.update(user, params.data.id, body.data);
    if (!skill) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, {
      eventType: "skill.update",
      targetType: "skill",
      targetId: skill.id,
      details: { version: skill.version, confidential: skill.confidential, ...(skill.mine ? {} : { editor: true }) },
    });
    return { skill };
  });

  api.delete("/skills/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await store.delete(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "skill.delete", targetType: "skill", targetId: params.data.id });
    return reply.code(204).send();
  });

  api.get("/skills/:id/versions", async (request, reply) => {
    kit.privateResponse(reply);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    return { versions: await store.versions(kit.principal(request), params.data.id) };
  });

  // Fichier de référence : texte extrait seulement (PDF, Word, texte…), antivirus d'abord.
  api.post("/skills/:id/files", { bodyLimit: ATTACHMENT_MAX_BYTES }, async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const limit = await checkUploadLimit(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = idParams.safeParse(request.params);
    if (!params.success || !Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "Invalid request" });

    const skill = await store.get(user, params.data.id);
    if (!skill) return reply.code(404).send({ error: "Not found" });
    if (!skill.canEdit) return kit.denyWrite(request, reply, user);

    const bytes = request.body;
    const name = decodeName(request.headers["x-file-name"]);
    // Script Python : gardé tel quel (texte), exécuté plus tard dans le bac à sable seulement.
    const script = isPythonScript(name) ? scriptText(bytes) : null;
    if (isPythonScript(name) && script === null) return reply.code(422).send({ error: "Unreadable document", reason: "skill_script_invalid" });
    const detected = script === null ? detectFile(bytes, name) : null;
    if (script === null && (!detected || detected.kind !== "document")) return reply.code(415).send({ error: "Unsupported file" });
    const file = { mediaType: script === null ? detected!.mediaType : SKILL_SCRIPT_TYPE };
    if (!(await scanUpload(kit, scanner, request, reply, user, bytes, { type: "skill", id: params.data.id }))) return reply;

    let text: string;
    try {
      text = script ?? (await extractText(bytes, detected!.mediaType as Parameters<typeof extractText>[1])).trim();
    } catch (error) {
      if (error instanceof ExtractionError) return reply.code(422).send({ error: "Unreadable document" });
      throw error;
    }
    if (!text.trim()) return reply.code(422).send({ error: "Unreadable document" });
    // Une compétence ordinaire peut partir vers un modèle externe : rien de sensible dedans.
    if (!skill.confidential && detectSensitive(text).length) return reply.code(400).send({ error: "Invalid request", reason: "skill_file_sensitive" });

    try {
      const saved = await store.addFile(user, params.data.id, { name, mediaType: file.mediaType, size: bytes.length, text });
      if (!saved) return reply.code(404).send({ error: "Not found" });
      await kit.record(request, user, { eventType: "skill.file_add", targetType: "skill", targetId: params.data.id, details: { mediaType: file.mediaType, size: bytes.length } });
      return reply.code(201).send({ file: saved });
    } catch (error) {
      if (error instanceof SkillRuleError && error.code === "TOO_MANY_FILES") return reply.code(409).send({ error: "Too many files", reason: "skill_files_limit" });
      throw error;
    }
  });

  // Import d'un dossier de compétence zippé (format Anthropic : SKILL.md + références).
  api.post("/skills/import", { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const limit = await checkUploadLimit(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const query = z.object({ confidential: z.enum(["true", "false"]).optional() }).safeParse(request.query);
    if (!query.success || !Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "Invalid request" });
    const bytes = request.body;
    // Signature ZIP (« PK\x03\x04 ») avant tout.
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return reply.code(415).send({ error: "Unsupported file", reason: "skill_zip_invalid" });
    if (!(await scanUpload(kit, scanner, request, reply, user, bytes, { type: "skill", id: "import" }))) return reply;

    let archive: ReturnType<typeof splitSkillArchive>;
    try {
      archive = splitSkillArchive(readZip(bytes));
    } catch (error) {
      if (error instanceof SkillArchiveError) return reply.code(400).send({ error: "Invalid request", reason: `skill_zip_${error.code}` });
      throw error;
    }
    const confidential = query.data.confidential === "true";
    const input = inputSchema.safeParse({ name: archive.skill.name.slice(0, 60), description: archive.skill.description, instructions: archive.skill.instructions, confidential });
    if (!input.success) return reply.code(400).send({ error: "Invalid request", reason: "skill_zip_invalid_skill_md" });
    const rejected = rejection(input.data);
    if (rejected) return reply.code(400).send({ error: "Invalid request", reason: rejected });

    // Références : texte extrait ; scripts Python gardés (exécutés dans le bac à sable) ;
    // autres langages mis de côté (rien pour les exécuter).
    const files: { name: string; mediaType: string; size: number; text: string }[] = [];
    const skipped: { name: string; reason: "script" | "unsupported" | "unreadable" | "limit" }[] = [];
    for (const entry of archive.others) {
      const name = entry.path.slice(0, 120);
      if (isOtherScript(name)) {
        skipped.push({ name, reason: "script" });
        continue;
      }
      if (isPythonScript(name)) {
        const script = scriptText(entry.data);
        if (script === null || !script.trim()) skipped.push({ name, reason: "unreadable" });
        else if (files.length >= MAX_SKILL_FILES) skipped.push({ name, reason: "limit" });
        else if (!confidential && detectSensitive(script).length) return reply.code(400).send({ error: "Invalid request", reason: "skill_file_sensitive", file: name });
        else files.push({ name, mediaType: SKILL_SCRIPT_TYPE, size: entry.data.length, text: script });
        continue;
      }
      const buffer = Buffer.from(entry.data);
      const file = detectFile(buffer, name.split("/").pop() ?? name);
      if (!file || file.kind !== "document") {
        skipped.push({ name, reason: "unsupported" });
        continue;
      }
      if (files.length >= MAX_SKILL_FILES) {
        skipped.push({ name, reason: "limit" });
        continue;
      }
      let text = "";
      try {
        text = (await extractText(buffer, file.mediaType)).trim();
      } catch (error) {
        if (!(error instanceof ExtractionError)) throw error;
      }
      if (!text) {
        skipped.push({ name, reason: "unreadable" });
        continue;
      }
      if (!confidential && detectSensitive(text).length) return reply.code(400).send({ error: "Invalid request", reason: "skill_file_sensitive", file: name });
      files.push({ name, mediaType: file.mediaType, size: buffer.length, text });
    }

    const skill = await store.create(user, input.data);
    try {
      for (const file of files) await store.addFile(user, skill.id, file);
    } catch (error) {
      // Pas de compétence à moitié importée.
      await store.delete(user, skill.id).catch(() => undefined);
      throw error;
    }
    await kit.record(request, user, {
      eventType: "skill.import",
      targetType: "skill",
      targetId: skill.id,
      details: { files: files.length, skipped: skipped.length, confidential },
    });
    return reply.code(201).send({ skill: (await store.get(user, skill.id)) ?? skill, skipped });
  });

  api.delete("/skills/:id/files/:fileId", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = fileParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await store.removeFile(user, params.data.id, params.data.fileId))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "skill.file_remove", targetType: "skill", targetId: params.data.id });
    return reply.code(204).send();
  });
}
