import http from "node:http";
import type { AddressInfo } from "node:net";

/** Outil publié par le faux serveur (format du protocole MCP). */
export type FakeMcpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

/**
 * Faux serveur MCP (Streamable HTTP) pour les tests : session, pagination de
 * tools/list, réponses JSON ou SSE, appels enregistrés. Ses outils sont
 * modifiables à chaud, pour simuler un serveur qui change après approbation.
 */
export async function startFakeMcpServer(options: {
  tools: FakeMcpTool[];
  token?: string;
  /** Jeton accepté (OAuth : émis par le faux fournisseur) ; remplace token. */
  accepts?: (token: string) => boolean;
  /** Métadonnées de ressource protégée (RFC 9728) servies en GET. */
  resourceMetadata?: () => Record<string, unknown>;
  sse?: boolean;
  reply?: (name: string, args: unknown) => string;
}) {
  const state = {
    tools: options.tools,
    calls: [] as { name: string; arguments: unknown; session: string | undefined; token?: string }[],
    unauthorized: 0,
  };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      if (request.method === "GET" && options.resourceMetadata && request.url?.startsWith("/.well-known/oauth-protected-resource")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(options.resourceMetadata()));
        return;
      }
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      if (options.accepts && !(bearer && options.accepts(bearer))) {
        state.unauthorized++;
        response.writeHead(401).end();
        return;
      }
      if (options.token && request.headers.authorization !== `Bearer ${options.token}`) {
        state.unauthorized++;
        response.writeHead(401).end();
        return;
      }
      const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const session = request.headers["mcp-session-id"] as string | undefined;
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
          break;
        case "tools/list": {
          // Deux pages : la pagination doit être suivie.
          const first = message.params?.cursor !== "page-2";
          result = first
            ? { tools: state.tools.slice(0, 1), ...(state.tools.length > 1 ? { nextCursor: "page-2" } : {}) }
            : { tools: state.tools.slice(1) };
          break;
        }
        case "tools/call": {
          const name = message.params?.name as string;
          state.calls.push({ name, arguments: message.params?.arguments, session, ...(bearer ? { token: bearer } : {}) });
          result = { content: [{ type: "text", text: options.reply?.(name, message.params?.arguments) ?? `ok:${name}` }] };
          break;
        }
        default:
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
          return;
      }
      const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      const headers: Record<string, string> = message.method === "initialize" ? { "mcp-session-id": "session-42" } : {};
      if (options.sse) {
        response.writeHead(200, { ...headers, "content-type": "text/event-stream" });
        // Une notification avant la réponse : elle doit être ignorée.
        response.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${payload}\n\n`);
      } else {
        response.writeHead(200, { ...headers, "content-type": "application/json" }).end(payload);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    state,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
