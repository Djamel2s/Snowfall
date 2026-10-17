import { z } from "zod";
import { defineTool, type AgentTool } from "../agent/tools.js";
import { McpClient, toolFingerprint, type McpServerSettings, type McpToolDefinition } from "./client.js";
import type { ApprovedMcpTool, McpServerRecord } from "./store.js";

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

/** Nom exposé au modèle : mcp_<serveur>_<outil>, 64 caractères au plus. */
export function exposedName(server: string, tool: string) {
  return `mcp_${slug(server).slice(0, 20) || "serveur"}_${slug(tool)}`.slice(0, 64).replace(/_+$/, "");
}

/** Schéma JSON → validateur (refusé s'il est trop gros ou illisible). */
export function schemaValidator(schema: Record<string, unknown>): z.ZodType | null {
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) return null;
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
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

const neutralize = (text: string) => text.replace(/<\/?\s*mcp_result\b[^>]*>/gi, "");
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
  servers: (McpServerRecord & { token: string | null })[],
  events: McpToolEvents,
  options: { signal?: AbortSignal | undefined; fetcher?: typeof fetch; client?: (settings: McpServerSettings) => McpClient } = {},
): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  const names = new Set<string>();
  await Promise.all(
    servers
      .filter((server) => server.status === "approved" && server.tools.length)
      .map(async (server) => {
        const client = options.client?.({ url: server.url, token: server.token ?? undefined }) ?? new McpClient({ url: server.url, token: server.token ?? undefined }, options.fetcher);
        let current: McpToolDefinition[];
        try {
          current = await client.listTools(options.signal);
        } catch {
          events.unavailable(server);
          return;
        }
        for (const approved of server.tools) {
          const live = current.find((tool) => tool.name === approved.name);
          // Disparu, ou modifié depuis l'approbation : bloqué (« rug pull »).
          if (!live || toolFingerprint(live) !== approved.fingerprint) {
            events.changed(server, approved.name);
            continue;
          }
          const parameters = schemaValidator(approved.inputSchema);
          const name = exposedName(server.name, approved.name);
          if (!parameters || names.has(name) || !/^[a-z][a-z0-9_]{0,63}$/.test(name)) continue;
          names.add(name);
          tools.push(
            defineTool({
              name,
              description: `[Serveur MCP « ${server.name} »] ${approved.title ? `${approved.title} : ` : ""}${approved.description}`.slice(0, 1_500),
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
      }),
  );
  return tools;
}
