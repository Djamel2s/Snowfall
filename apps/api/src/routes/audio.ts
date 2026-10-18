import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AUDIO_TYPES, AudioError, audioMatches, MAX_AUDIO_BYTES, speakable, type OpenAiCompatibleSpeech } from "../audio/speech.js";
import type { RouteKit } from "./kit.js";

const speechSchema = z.object({ text: z.string().min(1).max(20_000) }).strict();
const languageSchema = z.object({ language: z.enum(["fr", "en"]).optional() });

/**
 * Voix locale. Dictée : l'audio (corps brut, format annoncé puis vérifié sur
 * la signature) part au service local, revient en texte, n'est jamais gardé.
 * Lecture : le texte d'une réponse revient en MP3. Audit sans contenu.
 */
export function registerAudioRoutes(api: FastifyInstance, kit: RouteKit, speech: OpenAiCompatibleSpeech) {
  const checkLimit = api.createRateLimit({ max: 20, timeWindow: "1 minute", keyGenerator: (request) => `user-audio:${kit.principal(request).userId}` });

  api.get("/audio/capabilities", async (request, reply) => {
    kit.principal(request);
    kit.privateResponse(reply);
    return { dictation: speech.canTranscribe, speech: speech.canSpeak };
  });

  api.post("/audio/transcriptions", { bodyLimit: MAX_AUDIO_BYTES }, async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const limit = await checkLimit(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });
    if (!speech.canTranscribe) return reply.code(404).send({ error: "Not found" });
    const mediaType = String(request.headers["x-audio-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const query = languageSchema.safeParse(request.query);
    const bytes = request.body;
    if (!(mediaType in AUDIO_TYPES) || !Buffer.isBuffer(bytes) || bytes.length === 0 || !audioMatches(mediaType, bytes) || !query.success) {
      return reply.code(415).send({ error: "Unsupported audio" });
    }
    try {
      const text = await speech.transcribe(bytes, mediaType, query.data.language);
      await kit.record(request, user, { eventType: "audio.transcribe", targetType: "user", targetId: user.userId, details: { size: bytes.length, mediaType } });
      return { text };
    } catch (error) {
      return reply.code(502).send({ error: "Transcription failed", reason: error instanceof AudioError ? error.code : "unavailable" });
    }
  });

  api.post("/audio/speech", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const limit = await checkLimit(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });
    if (!speech.canSpeak) return reply.code(404).send({ error: "Not found" });
    const body = speechSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const text = speakable(body.data.text);
    if (!text) return reply.code(400).send({ error: "Invalid request" });
    try {
      const audio = await speech.speak(text);
      return reply.header("Content-Type", "audio/mpeg").header("Content-Disposition", "inline").send(audio);
    } catch (error) {
      return reply.code(502).send({ error: "Speech failed", reason: error instanceof AudioError ? error.code : "unavailable" });
    }
  });
}
