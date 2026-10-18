import { z } from "zod";
import { defaultAgentTools, toolIds } from "../agent/catalog.js";

export const alienColors = ["pink", "coral", "mint", "lavender", "sky", "lime", "snow", "gold"] as const;
export const alienEyes = ["classic", "round", "sleepy", "happy", "wink", "sparkle"] as const;
export const alienAccessories = [
  "none", "antenna", "headset", "bow", "crown", "scarf",
  "flower", "cap", "halo", "helmet", "ufo", "tie",
] as const;

const MAX_IMAGE_BYTES = 150_000;
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Vérifie le type réel de l'image (signature binaire) et pas seulement le
 * type annoncé : refuse SVG (scripts), formats exotiques et fichiers lourds.
 */
export function isSafeImageDataUrl(value: string) {
  const match = DATA_URL.exec(value);
  if (!match) return false;

  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return false;

  switch (match[1]) {
    case "png":
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "webp":
      return (
        bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
        bytes.subarray(8, 12).toString("latin1") === "WEBP"
      );
    default:
      return false;
  }
}

export const avatarSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("alien"),
    color: z.enum(alienColors),
    eyes: z.enum(alienEyes),
    accessory: z.enum(alienAccessories),
  }).strict(),
  z.object({
    kind: z.literal("image"),
    data: z.string().max(210_000).refine(isSafeImageDataUrl, "Image invalide"),
  }).strict(),
]);

export const agentProfileSchema = z.object({
  name: z.string().trim().min(1).max(40),
  avatar: avatarSchema,
  instructions: z.string().trim().max(4000).default(""),
  /** Outils choisis par l'auteur, parmi ceux de l'organisation (vérifié à l'enregistrement). */
  tools: z.array(z.enum(toolIds)).max(toolIds.length).default(defaultAgentTools),
  /** Serveurs MCP approuvés confiés à l'agent (outil « mcp »). */
  mcpServers: z.array(z.uuid()).max(10).default([]),
  /** Agents spécialistes que celui-ci peut consulter (outil « delegate »). */
  delegates: z.array(z.uuid()).max(5).default([]),
  /** Réglages des réponses ; absents : ceux du fournisseur. */
  parameters: z
    .object({
      creativity: z.enum(["precise", "balanced", "creative"]).optional(),
      length: z.enum(["concise", "complete"]).optional(),
    })
    .strict()
    .default({}),
}).strict();

/** Réglages d'agent → paramètres de génération (température, longueur maximale). */
export function generationOf(parameters: AgentProfile["parameters"] | undefined) {
  return {
    ...(parameters?.creativity ? { temperature: { precise: 0.1, balanced: 0.5, creative: 0.9 }[parameters.creativity] } : {}),
    ...(parameters?.length === "concise" ? { maxOutputTokens: 1_000 } : {}),
  };
}

export type AgentAvatar = z.infer<typeof avatarSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const defaultAvatar: AgentAvatar = { kind: "alien", color: "sky", eyes: "classic", accessory: "none" };

/** Avatar relu depuis la base : un format retiré (mochi, chibi) devient l'avatar par défaut. */
export function readAvatar(value: unknown): AgentAvatar {
  const parsed = avatarSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultAvatar;
}
