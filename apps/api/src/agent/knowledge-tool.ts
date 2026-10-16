import { z } from "zod";
import type { TenantContext } from "../db/tenant.js";
import type { ActiveBase, Citation, KnowledgeService, Passage } from "../knowledge/service.js";
import { renderKnowledge } from "../knowledge/service.js";
import { defineTool } from "./tools.js";

/**
 * Numérotation des sources sur toute la réponse : si l'agent cherche trois
 * fois, un même passage garde son numéro et les [n] restent cohérents.
 */
export class CitationRegistry {
  private readonly passages = new Map<string, Passage>();

  add(found: Passage[]): Passage[] {
    return found.map((passage) => {
      const key = `${passage.sourceId}:${passage.text.slice(0, 200)}`;
      const known = this.passages.get(key);
      if (known) return known;
      const numbered = { ...passage, n: this.passages.size + 1 };
      this.passages.set(key, numbered);
      return numbered;
    });
  }

  /** Sources réellement citées ([n] dans la réponse), sinon toutes celles consultées. */
  citations(answer: string): Citation[] {
    const cited = new Set([...answer.matchAll(/\[(\d{1,3})\]/g)].map((match) => Number(match[1])));
    const all = [...this.passages.values()];
    const kept = cited.size ? all.filter((passage) => cited.has(passage.n)) : all;
    return kept.map(({ text: _text, ...citation }) => citation);
  }
}

const parameters = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(500)
      .describe("Question autonome et précise, reformulée avec le contexte de la conversation (pas de « il », « ça »)."),
    scope: z
      .enum(["all", "agent", "project"])
      .optional()
      .describe("Base à interroger : celle de l'agent, celle du projet, ou les deux (défaut)."),
  })
  .strict();

/**
 * Outil « search_knowledge » : RAG agentique. Le modèle décide quand chercher,
 * formule la requête, et peut chercher plusieurs fois (autre angle, autre
 * base) avant de répondre. Bases et droits sont fixés par le serveur : le
 * modèle ne peut pas viser une autre base que celles de la conversation.
 */
export function knowledgeTool(
  service: KnowledgeService,
  tenant: TenantContext,
  bases: ActiveBase[],
  citations: CitationRegistry,
) {
  const labels = bases.map((base) => (base.label === "agent" ? "la base de l'agent" : "la base du projet")).join(" et ");
  return defineTool({
    name: "search_knowledge",
    description:
      `Cherche dans ${labels} (documents de l'organisation). À utiliser dès que la question peut concerner ` +
      "ces documents : politiques internes, procédures, contrats, données du projet. Renvoie des extraits " +
      "numérotés ; cite-les dans la réponse avec leur numéro entre crochets, ex. [1]. Si rien n'est trouvé, " +
      "reformule une fois, puis dis que l'information n'est pas dans les documents.",
    parameters,
    access: "read",
    async execute({ query, scope }) {
      const selected = !scope || scope === "all" ? bases : bases.filter((base) => base.label === scope);
      if (selected.length === 0) return { content: "Cette base n'est pas disponible dans cette conversation.", summary: query };
      const found = citations.add(await service.retrieve(tenant, selected, { text: query }));
      if (found.length === 0) return { content: "Aucun extrait pertinent trouvé pour cette requête.", summary: query };
      return { content: renderKnowledge(found), summary: query };
    },
  });
}
