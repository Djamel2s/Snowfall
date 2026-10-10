
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });

    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  response.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  response.end(JSON.stringify({ error: "Not found" }));
}

export function createAppServer() {
  return createServer(handleRequest);
}

const entryPoint = process.argv[1];

if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  const host = "127.0.0.1";
  const port = Number(process.env.PORT ?? 3001);
  const server = createAppServer();

  server.listen(port, host, () => {
    console.log(`Snowfall API listening on http://${host}:${port}`);
  });
}
