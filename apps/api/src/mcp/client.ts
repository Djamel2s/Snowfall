import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress, validateUrl } from "../knowledge/safe-fetch.js";

// Client MCP minimal (Model Context Protocol), transport « Streamable HTTP » :
// JSON-RPC 2.0 en POST, réponse en JSON ou en flux SSE. Seuls les outils sont
// utilisés (initialize, tools/list, tools/call). Écrit ici plutôt que pris dans
// le SDK officiel, qui embarque un serveur complet (express, hono…) : un client
// n'en a pas besoin, et chaque dépendance est une surface d'attaque.

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOOLS = 100;

export class McpError extends Error {
  constructor(readonly code: "invalid_url" | "http_error" | "protocol_error" | "timeout" | "too_large" | "tool_error") {
    super(`MCP_${code.toUpperCase()}`);
  }
}

export type McpToolDefinition = {
  name: string;
  title?: string | undefined;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Indication du serveur (non fiable) : l'outil ne modifie rien. */
  readOnlyHint: boolean;
};

export type McpServerSettings = {
  url: string;
  token?: string | undefined;
  /**
   * Vérifie, avant chaque requête, que le nom résout vers des adresses publiques.
   * En production la sortie passe par le proxy (qui résout et refuse lui-même
   * les adresses internes, DNS rebinding compris) ; sans proxy, ce contrôle
   * évite au moins de viser directement le réseau interne.
   */
  checkAddress?: ((hostname: string) => Promise<void>) | undefined;
};

/** Contrôle DNS par défaut quand aucun proxy de sortie n'est configuré. */
export async function publicAddressOnly(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new McpError("invalid_url");
      });
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new McpError("invalid_url");
}

/**
 * Empreinte d'un outil : nom, titre, description et schéma (tout ce que lit le
 * modèle), sérialisés de façon stable.
 * Si un serveur change ce qu'un outil fait (ou dit faire) après approbation,
 * l'empreinte change et l'outil est bloqué jusqu'à une nouvelle approbation.
 */
export function toolFingerprint(tool: Pick<McpToolDefinition, "name" | "title" | "description" | "inputSchema">) {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
        : value;
  return createHash("sha256").update(JSON.stringify(stable({ name: tool.name, title: tool.title ?? null, description: tool.description, inputSchema: tool.inputSchema }))).digest("hex");
}

/**
 * Adresse d'un serveur MCP : HTTPS, publique (mêmes règles anti-SSRF qu'un lien
 * importé). allowLocal : tests seulement (faux serveur en HTTP sur 127.0.0.1).
 */
export function validateMcpUrl(raw: string, allowLocal = false) {
  try {
    if (allowLocal) {
      const local = new URL(raw);
      if (local.protocol !== "http:" && local.protocol !== "https:") throw new McpError("invalid_url");
      return local;
    }
    const url = validateUrl(raw);
    if (url.protocol !== "https:") throw new McpError("invalid_url");
    return url;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError("invalid_url");
  }
}

type JsonRpcResponse = { jsonrpc: "2.0"; id?: number | string; result?: unknown; error?: { code: number; message: string } };

/** Lit une réponse JSON-RPC : JSON simple, ou flux SSE dont on garde la réponse à notre requête. */
async function readResponse(response: Response, id: number): Promise<JsonRpcResponse | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new McpError("too_large");
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      const message = JSON.parse(data) as JsonRpcResponse;
      if (message.id === id) return message;
    }
    return null;
  }
  return text.trim() ? (JSON.parse(text) as JsonRpcResponse) : null;
}

export class McpClient {
  private session: string | null = null;
  private nextId = 1;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly settings: McpServerSettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Envoie une requête ; renvoie aussi la session utilisée (pour savoir laquelle a expiré). */
  private async post(body: Record<string, unknown>, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const session = this.session;
    if (this.settings.checkAddress) {
      // Contrôle DNS soumis au même délai et à la même annulation que la requête.
      const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
      await Promise.race([
        this.settings.checkAddress(new URL(this.settings.url).hostname),
        new Promise<never>((_resolve, reject) => stop.addEventListener("abort", () => reject(new McpError("timeout")), { once: true })),
      ]);
    }
    try {
      const response = await this.fetcher(this.settings.url, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          ...(session ? { "Mcp-Session-Id": session } : {}),
          ...(this.settings.token ? { Authorization: `Bearer ${this.settings.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      return { response, session };
    } catch (error) {
      if (timeout.aborted) throw new McpError("timeout");
      throw error;
    }
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal, retried = false): Promise<unknown> {
    if (method !== "initialize") await this.initialize(signal);
    const id = this.nextId++;
    const { response, session: sent } = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    // Session expirée (serveur redémarré…) : le protocole demande d'en ouvrir une nouvelle.
    // Avec des appels parallèles, seul le premier à voir l'expiration la réinitialise ;
    // les autres attendent la nouvelle poignée de main et rejouent leur requête.
    // (Un 404 sur session signifie que le serveur n'a PAS traité la requête : rejouer ne double rien.)
    if (response.status === 404 && sent && method !== "initialize" && !retried) {
      await response.body?.cancel();
      if (this.session === sent) {
        this.session = null;
        this.ready = null;
      }
      return this.request(method, params, signal, true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new McpError("http_error");
    }
    const session = response.headers.get("mcp-session-id");
    if (session && /^[\x21-\x7e]{1,200}$/.test(session)) this.session = session;
    const message = await readResponse(response, id);
    if (!message) throw new McpError("protocol_error");
    if (message.error) throw new McpError(method === "tools/call" ? "tool_error" : "protocol_error");
    return message.result;
  }

  /** Poignée de main MCP (une fois par client). */
  initialize(signal?: AbortSignal) {
    this.ready ??= (async () => {
      await this.request(
        "initialize",
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "snowfall", version: "1.0" } },
        signal,
      );
      const notified = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
      await notified.response.body?.cancel();
    })().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  /** Outils publiés par le serveur (pagination suivie, nombre borné). */
  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {}, signal)) as {
        tools?: { name?: unknown; title?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } }[];
        nextCursor?: unknown;
      };
      for (const tool of result.tools ?? []) {
        // Nom trop long : on l'ignore plutôt que de le tronquer (le serveur ne reconnaîtrait pas le nom coupé).
        if (typeof tool.name !== "string" || tool.name.length > 128 || !tool.inputSchema || typeof tool.inputSchema !== "object") continue;
        tools.push({
          name: tool.name,
          ...(typeof tool.title === "string" ? { title: tool.title.slice(0, 200) } : {}),
          description: typeof tool.description === "string" ? tool.description.slice(0, 2_000) : "",
          inputSchema: tool.inputSchema as Record<string, unknown>,
          readOnlyHint: tool.annotations?.readOnlyHint === true,
        });
        if (tools.length >= MAX_TOOLS) return tools;
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  /** Appel d'un outil : texte des contenus renvoyés (les autres types sont ignorés). */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const result = (await this.request("tools/call", { name, arguments: args ?? {} }, signal)) as {
      content?: { type?: unknown; text?: unknown }[];
      structuredContent?: unknown;
      isError?: unknown;
    };
    const parts = (result.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string);
    if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
    return { text: parts.join("\n\n"), isError: result.isError === true };
  }
}
