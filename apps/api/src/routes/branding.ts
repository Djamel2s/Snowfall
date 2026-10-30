import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedUser } from "../auth/auth.js";
import { inspectLogo, LOGO_MAX_BYTES } from "../branding/image.js";
import type { BrandingStore } from "../branding/store.js";
import type { MalwareScanner } from "../security/antivirus.js";
import type { MemberStore } from "../workspace/members.js";
import type { RouteKit } from "./kit.js";
import { scanUpload } from "./scan.js";

// Administration › Identité : le logo de l'organisation remplace celui de
// Snowfall dans toute l'application ; sans logo, celui de Snowfall, dans la
// couleur choisie. Lecture : les membres. Écriture : les administrateurs.

export type BrandingDependencies = { store: BrandingStore; members?: MemberStore | undefined; scanner?: MalwareScanner | undefined };

const color = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((value) => value.toLowerCase()).nullable() }).strict();

export function registerBrandingRoutes(api: FastifyInstance, kit: RouteKit, deps: BrandingDependencies) {
  const denied = async (request: FastifyRequest, reply: FastifyReply, user: AuthenticatedUser, action: string) => {
    await kit.record(request, user, { eventType: `branding.${action}`, outcome: "denied", details: { role: user.role } });
    return reply.code(403).send({ error: "Forbidden" });
  };

  api.get("/branding", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const [branding, organization] = await Promise.all([deps.store.get(user), deps.members?.organization(user).catch(() => null)]);
    return { name: organization?.name ?? null, color: branding.color, logo: branding.logo ? { version: branding.logo.version } : null };
  });

  api.get("/branding/logo", async (request, reply) => {
    const user = kit.principal(request);
    const logo = await deps.store.logo(user);
    if (!logo) return reply.code(404).send({ error: "Not found" });
    // Adresse versionnée (?v=) : mise en cache longue, privée ; jamais interprété autrement qu'en image.
    reply.header("Cache-Control", "private, max-age=86400");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
    reply.header("Content-Disposition", 'inline; filename="logo"');
    return reply.type(logo.type).send(logo.bytes);
  });

  api.put("/branding/logo", { bodyLimit: LOGO_MAX_BYTES + 1024 }, async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return denied(request, reply, user, "logo_update");
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "Invalid request" });
    const bytes = request.body;
    const image = inspectLogo(bytes);
    if (typeof image === "string") return reply.code(image === "too_large" ? 413 : 415).send({ error: "Invalid logo", reason: image });
    if (!(await scanUpload(kit, deps.scanner, request, reply, user, bytes, { type: "branding", id: user.organizationId }))) return reply;
    if (!(await deps.store.setLogo(user, { bytes, type: image.type }))) return denied(request, reply, user, "logo_update");
    await kit.record(request, user, { eventType: "branding.logo_update", targetType: "organization", targetId: user.organizationId, details: { type: image.type, width: image.width, height: image.height, size: bytes.length } });
    return { branding: await deps.store.get(user).then((branding) => ({ color: branding.color, logo: branding.logo ? { version: branding.logo.version } : null })) };
  });

  api.delete("/branding/logo", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return denied(request, reply, user, "logo_delete");
    if (!(await deps.store.clearLogo(user))) return denied(request, reply, user, "logo_delete");
    await kit.record(request, user, { eventType: "branding.logo_delete", targetType: "organization", targetId: user.organizationId });
    return reply.code(204).send();
  });

  api.put("/branding/color", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return denied(request, reply, user, "color_update");
    const body = color.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await deps.store.setColor(user, body.data.color))) return denied(request, reply, user, "color_update");
    await kit.record(request, user, { eventType: "branding.color_update", targetType: "organization", targetId: user.organizationId, details: { color: body.data.color ?? "default" } });
    return { color: body.data.color };
  });
}
