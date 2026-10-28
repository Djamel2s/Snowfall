import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedUser } from "../auth/auth.js";
import { CONNECTOR_CATALOG } from "../mcp/catalog.js";
import { AGENT_TEMPLATES, templateById } from "../templates/catalog.js";
import type { AgentTemplate } from "../templates/types.js";
import type { RouteKit } from "./kit.js";

// Catalogue d'agents prêts à l'emploi. Installer un modèle passe par les routes
// ordinaires (compétences, agents) au nom de l'utilisateur : mêmes contrôles
// (consignes déguisées, données sensibles, outils permis, modèles autorisés),
// même audit. Le résultat est un agent ordinaire, à lui, modifiable.

export type InternalCall = (user: AuthenticatedUser, method: "GET" | "POST", url: string, payload?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>;

export type TemplateDependencies = {
  call: InternalCall;
  /** Outils activés par l'organisation (pour signaler ce qui manque). */
  organizationTools: (user: AuthenticatedUser) => Promise<readonly string[]>;
};

/** Outils réellement demandés : ceux du modèle, plus la délégation s'il a une équipe. */
const wanted = (template: AgentTemplate) => (template.team?.length ? [...new Set([...template.tools, "delegate" as const])] : template.tools);

/** Ce que l'interface affiche d'un modèle (jamais ses cas d'évaluation détaillés). */
function view(template: AgentTemplate, organizationTools: readonly string[]) {
  return {
    id: template.id,
    category: template.category,
    name: template.name,
    tagline: template.tagline,
    capabilities: template.capabilities,
    limits: template.limits,
    avatar: template.avatar,
    tools: template.tools,
    missingTools: wanted(template).filter((tool) => !organizationTools.includes(tool)),
    skills: template.skills.map((skill) => ({ name: skill.name, description: skill.description, scripts: (skill.files ?? []).filter((file) => file.name.endsWith(".py")).length })),
    connectors: template.connectors.flatMap((id) => {
      const connector = CONNECTOR_CATALOG.find((item) => item.id === id);
      return connector ? [{ id, name: connector.name, icon: connector.icon ?? null, color: connector.color ?? null }] : [];
    }),
    knowledge: template.knowledge,
    starters: template.starters,
    team: (template.team ?? []).flatMap((id) => {
      const member = templateById(id);
      return member ? [{ id, name: member.name }] : [];
    }),
    evaluation: { cases: template.evaluation.cases.length, ...(template.evaluation.measured ? { measured: template.evaluation.measured } : {}) },
  };
}

export function registerTemplateRoutes(api: FastifyInstance, kit: RouteKit, deps: TemplateDependencies) {
  api.get("/agent-templates", async (request, reply) => {
    const user = kit.principal(request);
    reply.header("Cache-Control", "private, max-age=300");
    const tools = await deps.organizationTools(user);
    return { templates: AGENT_TEMPLATES.map((template) => view(template, tools)) };
  });

  /** Fournisseur et modèle : celui par défaut s'il est permis, sinon le premier permis. */
  async function modelFor(user: AuthenticatedUser) {
    const response = await deps.call(user, "GET", "/models");
    const catalog = response.body as { providers?: { id: string; available: boolean; allowed?: boolean; models: { id: string }[] }[]; defaultModel?: { provider: string; model: string } | null };
    const usable = (catalog.providers ?? []).filter((provider) => provider.available && provider.allowed !== false && provider.models.length);
    const preferred = catalog.defaultModel && usable.find((provider) => provider.id === catalog.defaultModel!.provider && provider.models.some((model) => model.id === catalog.defaultModel!.model));
    if (preferred) return catalog.defaultModel!;
    const first = usable[0];
    return first ? { provider: first.id, model: first.models[0]!.id } : null;
  }

  async function installOne(request: FastifyRequest, user: AuthenticatedUser, template: AgentTemplate, delegates: string[]) {
    // Compétences : celles déjà installées (même nom, à lui) sont réutilisées, pas dupliquées.
    const library = ((await deps.call(user, "GET", "/skills")).body as { skills?: { id: string; name: string; mine: boolean }[] }).skills ?? [];
    const skillIds: string[] = [];
    for (const skill of template.skills) {
      const existing = library.find((item) => item.mine && item.name === skill.name);
      if (existing) {
        skillIds.push(existing.id);
        continue;
      }
      const created = await deps.call(user, "POST", "/skills", { name: skill.name, description: skill.description, instructions: skill.instructions, confidential: false });
      if (created.status !== 201) throw Object.assign(new Error("SKILL_REFUSED"), { detail: { skill: skill.name, status: created.status, body: created.body } });
      const id = (created.body as { skill: { id: string } }).skill.id;
      for (const file of skill.files ?? []) {
        const uploaded = await deps.call(user, "POST", `/skills/${id}/files`, Buffer.from(file.text, "utf8"), { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) });
        if (uploaded.status !== 201) throw Object.assign(new Error("SKILL_FILE_REFUSED"), { detail: { skill: skill.name, file: file.name, status: uploaded.status } });
      }
      skillIds.push(id);
    }
    const model = await modelFor(user);
    if (!model) throw Object.assign(new Error("NO_MODEL"), { detail: {} });
    const created = await deps.call(user, "POST", "/agents", {
      name: template.name,
      avatar: template.avatar,
      instructions: template.instructions,
      provider: model.provider,
      model: model.model,
      tools: delegates.length ? [...new Set([...template.tools, "delegate"])] : template.tools,
      delegates,
      parameters: template.parameters,
      skills: skillIds,
    });
    if (created.status !== 201) throw Object.assign(new Error("AGENT_REFUSED"), { detail: { status: created.status, body: created.body } });
    const agent = (created.body as { agent: { id: string; name: string } }).agent;
    await kit.record(request, user, { eventType: "agent.template_install", targetType: "agent", targetId: agent.id, details: { template: template.id, skills: skillIds.length, team: delegates.length } });
    return agent;
  }

  api.post("/agent-templates/:id/install", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = z.object({ id: z.string().regex(/^[a-z0-9-]{1,60}$/) }).safeParse(request.params);
    const template = params.success ? templateById(params.data.id) : undefined;
    if (!template) return reply.code(404).send({ error: "Not found" });
    try {
      // L'équipe d'abord (un niveau) : les spécialistes que cet agent consultera.
      const team: { id: string; name: string }[] = [];
      for (const id of template.team ?? []) {
        const member = templateById(id);
        if (member) team.push(await installOne(request, user, member, []));
      }
      const agent = await installOne(request, user, template, team.map((item) => item.id));
      const tools = await deps.organizationTools(user);
      return reply.code(201).send({ agent, team, missingTools: wanted(template).filter((tool) => !tools.includes(tool)) });
    } catch (error) {
      const detail = (error as { detail?: Record<string, unknown> }).detail ?? {};
      request.log.warn({ template: template.id, reason: (error as Error).message, status: detail.status }, "Installation d'un modèle d'agent refusée");
      const reason = (error as Error).message === "NO_MODEL" ? "no_model" : "install_refused";
      return reply.code(reason === "no_model" ? 409 : 422).send({ error: "Install failed", reason });
    }
  });
}
