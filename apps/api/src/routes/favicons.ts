import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthenticatedUser } from "../auth/auth.js";
import { faviconDomain, type FaviconService } from "../web/favicon.js";
import type { RouteKit } from "./kit.js";

export type FaviconDependencies = {
  favicons: FaviconService;
  /**
   * Domaines autorisés par l'organisation pour les récupérations (vide : tous) ;
   * null : l'organisation ne sort pas sur le web (ni recherche web, ni liens).
   */
  domains: (user: AuthenticatedUser) => Promise<string[] | null>;
};

const params = z.object({ domain: z.string().min(3).max(253) });

/**
 * Icône d'un site cité dans une réponse, servie par Snowfall (le navigateur ne
 * contacte jamais le site). Absente ou invalide : 404, l'interface affiche
 * l'initiale du site.
 */
export function registerFaviconRoutes(api: FastifyInstance, kit: RouteKit, deps: FaviconDependencies) {
  api.get("/favicons/:domain", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (request, reply) => {
    const user = kit.principal(request);
    const parsed = params.safeParse(request.params);
    const domain = parsed.success ? faviconDomain(parsed.data.domain) : null;
    const domains = domain ? await deps.domains(user) : null;
    // Organisation sans sortie web : aucune récupération, l'interface affiche l'initiale.
    if (!domain || !domains) return reply.code(404).send({ error: "Not found" });
    const icon = await deps.favicons.get(user.organizationId, domain, domains);
    reply.header("Cache-Control", `private, max-age=${icon ? 86_400 : 3_600}`);
    if (!icon) return reply.code(404).send({ error: "Not found" });
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
    reply.header("Content-Disposition", 'inline; filename="icon"');
    return reply.type(icon.type).send(icon.bytes);
  });
}
