import { z } from "zod";
import { defineTool, type AgentTool } from "../agent/tools.js";
import { OpenApiClient } from "./openapi.js";
import { McpClient, toolFingerprint, type McpServerSettings, type McpToolDefinition } from "./client.js";
import type { ApprovedMcpTool, McpServerRecord } from "./store.js";
import { datamark, stripTags } from "../security/neutralize.js";

// Outils MCP confiés à un agent. Règles :
// - seuls les outils APPROUVÉS par l'administrateur sont proposés ;
// - à chaque réponse, la définition actuelle est comparée à l'empreinte
//   approuvée : si le serveur a changé un outil (description piégée, schéma
//   élargi…), l'outil est bloqué jusqu'à une nouvelle approbation ;
// - « lecture » ou « écriture » est décidé par l'administrateur ; une écriture
//   demande la validation de l'utilisateur à chaque appel ;
// - le résultat est une donnée non fiable, balisée.

export const MAX_SCHEMA_CHARS = 20_000;

/** Partie d'un nom d'outil sûre pour les fournisseurs (a-z, 0-9, _). */
const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * Nom exposé au modèle : mcp_<serveur>_<id>_<outil>, 64 caractères au plus.
 * Le fragment d'identifiant rend le nom unique ET stable : deux serveurs de même
 * nom (« CRM » prod et recette) ne se disputent jamais un outil, et un appel
 * validé avant une pause vise toujours le même serveur à la reprise.
 */
export function exposedName(server: { id: string; name: string }, tool: string) {
  const id = server.id.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase();
  return `mcp_${slug(server.name).slice(0, 16).replace(/_+$/, "") || "serveur"}_${id}_${slug(tool)}`.slice(0, 64).replace(/_+$/, "");
}

/** Nom exposable : lettres minuscules, chiffres, « _ », comme l'exigent les fournisseurs. */
export const validToolName = (name: string) => /^[a-z][a-z0-9_]{0,63}$/.test(name);

/**
 * Schéma JSON → validateur. Refusé s'il est trop gros, illisible, ou si ce n'est
 * pas un objet : les fournisseurs exigent des paramètres de type « object »
 * (sinon TOUTES les réponses de l'agent échoueraient, pas seulement cet outil).
 */
export function schemaValidator(schema: Record<string, unknown>): z.ZodType | null {
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) return null;
  // Combinateurs à la racine : la conversion perd le type « object » (refusé par les fournisseurs).
  if (schema.type !== "object" || ["oneOf", "anyOf", "allOf", "not"].some((key) => key in schema)) return null;
  try {
    const validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    // Ce que recevra le fournisseur : doit rester un objet après conversion.
    return (z.toJSONSchema(validator) as { type?: unknown }).type === "object" ? validator : null;
  } catch {
    return null;
  }
}

/** Ce que l'administrateur approuve : la définition actuelle et son empreinte. */
export function approvedSnapshot(definition: McpToolDefinition, access: "read" | "write"): ApprovedMcpTool {
  return {
    name: definition.name,
    ...(definition.title ? { title: definition.title } : {}),
    description: definition.description,
    inputSchema: definition.inputSchema,
    access,
    fingerprint: toolFingerprint(definition),
  };
}

/** Résultat gardé (au-delà, tronqué AVANT nettoyage : temps de traitement borné). */
export const MAX_RESULT_CHARS = 50_000;
const neutralize = (text: string) => datamark(stripTags(text.slice(0, MAX_RESULT_CHARS), /<\/?\s*mcp_result\b[^>]{0,200}>/gi));
const attribute = (text: string) => text.replace(/[<>"&]/g, " ");

export type McpToolEvents = {
  /** Un outil approuvé a changé depuis l'approbation : bloqué. */
  changed: (server: McpServerRecord, tool: string) => void;
  /** Serveur injoignable pour cette réponse. */
  unavailable: (server: McpServerRecord) => void;
  /** Appel effectué (tracé dans l'audit, sans contenu). */
  called: (server: McpServerRecord, tool: string, outcome: "success" | "failure") => void;
};

/**
 * Outils MCP d'une réponse : connexion aux serveurs approuvés choisis par
 * l'agent, vérification des empreintes, puis outils prêts pour la boucle.
 */
export async function mcpToolsFor(
  servers: (McpServerRecord & { token: string | null; spec?: unknown })[],
  events: McpToolEvents,
  options: {
    signal?: AbortSignal | undefined;
    fetcher?: typeof fetch;
    client?: (settings: McpServerSettings) => McpClient;
    /** Contrôle des adresses résolues (sans proxy de sortie). */
    checkAddress?: McpServerSettings["checkAddress"];
  } = {},
): Promise<AgentTool[]> {
  const names = new Set<string>();
  // Serveurs interrogés en parallèle, mais outils assemblés dans l'ordre de la
  // liste : le résultat ne dépend jamais de l'ordre d'arrivée des réponses.
  const perServer = await Promise.all(
    servers
      .filter((server) => server.status === "approved" && server.tools.length)
      .map(async (server): Promise<AgentTool[]> => {
        const tools: AgentTool[] = [];
        const settings = { url: server.url, token: server.token ?? undefined, checkAddress: options.checkAddress };
        const client = options.client?.(settings) ?? connectorClient(server, settings, options.fetcher);
        let current: McpToolDefinition[];
        try {
          current = await client.listTools(options.signal);
        } catch {
          events.unavailable(server);
          return tools;
        }
        for (const approved of server.tools) {
          const live = current.find((tool) => tool.name === approved.name);
          // Disparu, ou modifié depuis l'approbation : bloqué (« rug pull »).
          if (!live || toolFingerprint(live) !== approved.fingerprint) {
            events.changed(server, approved.name);
            continue;
          }
          const parameters = schemaValidator(approved.inputSchema);
          const name = exposedName(server, approved.name);
          if (!parameters || !validToolName(name)) continue;
          tools.push(
            defineTool({
              name,
              description: `[${server.kind === "openapi" ? "API" : "Serveur MCP"} « ${server.name} »] ${approved.title ? `${approved.title} : ` : ""}${approved.description}`.slice(0, 1_500),
              parameters,
              access: approved.access,
              preview: (args: unknown) => ({
                title: `${server.name} · ${approved.title ?? approved.name}`,
                detail: JSON.stringify(args, null, 2).slice(0, 4_000),
              }),
              async execute(args: unknown, { signal }) {
                try {
                  const result = await client.callTool(approved.name, args, signal);
                  events.called(server, approved.name, result.isError ? "failure" : "success");
                  return {
                    content: `<mcp_result server="${attribute(server.name)}" tool="${attribute(approved.name)}"${result.isError ? ' error="true"' : ""}>\n${neutralize(result.text)}\n</mcp_result>`,
                    summary: approved.title ?? approved.name,
                  };
                } catch (error) {
                  events.called(server, approved.name, "failure");
                  throw error;
                }
              },
            }) as AgentTool,
          );
        }
        return tools;
      }),
  );
  // Deux outils réduits au même nom (« Get-User » et « get_user », troncature) : aucun n'est
  // proposé. Garder « le premier » permettrait, à la reprise d'une pause, d'exécuter
  // l'autre outil sous le nom que l'utilisateur a validé.
  const all = perServer.flat();
  for (const tool of all) names.add(names.has(tool.name) ? `!${tool.name}` : tool.name);
  return all.filter((tool) => !names.has(`!${tool.name}`));
}

/** Noms exposés en conflit dans une liste d'outils (même nom après simplification). */
export function clashingNames(server: { id: string; name: string }, tools: string[]) {
  const seen = new Map<string, number>();
  for (const tool of tools) seen.set(exposedName(server, tool), (seen.get(exposedName(server, tool)) ?? 0) + 1);
  return new Set(tools.filter((tool) => (seen.get(exposedName(server, tool)) ?? 0) > 1));
}

/** Client d'un connecteur : protocole MCP, ou appels HTTP décrits par une spécification OpenAPI. */
export function connectorClient(server: { kind?: "mcp" | "openapi"; spec?: unknown }, settings: McpServerSettings, fetcher?: typeof fetch): Pick<McpClient, "listTools" | "callTool"> {
  if (server.kind === "openapi") return new OpenApiClient(settings, server.spec, fetcher);
  return new McpClient(settings, fetcher);
}

