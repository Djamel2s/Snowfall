import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { creativities, lengths, settingsOf } from "../conversations/store.js";
import type { PresetStore } from "../presets/store.js";
import { MAX_INSTRUCTIONS } from "../workspace/preferences.js";
import type { RouteKit } from "./kit.js";
import { instructionsRejection } from "./workspace.js";

/** Réglages d'une conversation ou d'un préréglage (instructions vides : aucune). */
export const conversationSettingsSchema = z
  .object({
    creativity: z.enum(creativities).optional(),
    length: z.enum(lengths).optional(),
    instructions: z.string().trim().max(MAX_INSTRUCTIONS).optional(),
  })
  .strict();

const idParams = z.object({ id: z.uuid() });
const inputSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    settings: conversationSettingsSchema,
  })
  .strict();

/** Préréglages : privés ; audit sans contenu (ni nom, ni instructions). */
export function registerPresetRoutes(api: FastifyInstance, kit: RouteKit, store: PresetStore) {
  api.get("/me/presets", async (request, reply) => {
    kit.privateResponse(reply);
    return { presets: await store.list(kit.principal(request)) };
  });

  api.post("/me/presets", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const body = inputSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    // Ces instructions partiront vers le modèle à chaque usage : mêmes contrôles qu'à l'usage direct.
    const rejected = body.data.settings.instructions ? instructionsRejection(body.data.settings.instructions) : null;
    if (rejected) return reply.code(400).send({ error: "Invalid request", reason: `instructions_${rejected}` });
    const preset = await store.create(user, { name: body.data.name, settings: settingsOf(body.data.settings) });
    if (!preset) return reply.code(409).send({ error: "Too many presets", reason: "presets_limit" });
    await kit.record(request, user, { eventType: "preset.create", targetType: "preset", targetId: preset.id });
    return reply.code(201).send({ preset });
  });

  api.delete("/me/presets/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await store.delete(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "preset.delete", targetType: "preset", targetId: params.data.id });
    return reply.code(204).send();
  });
}
