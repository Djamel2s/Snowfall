import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { AuditEvent } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { LinkError, safeFetch } from "../knowledge/safe-fetch.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore } from "../testing/fakes.js";
import { ClamdScanner, ScannerUnavailableError, type MalwareScanner } from "./antivirus.js";

// Fichier de test antivirus standard (EICAR), inoffensif, reconnu par tous les moteurs.
const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");

/** Faux clamd : protocole INSTREAM réel (taille sur 4 octets, bloc final nul). */
function fakeClamd(): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let data = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.subarray(0, 10).toString() === "zINSTREAM\0") buffer = buffer.subarray(10);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          received.push(data);
          socket.end(data.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        if (buffer.length < 4 + size) break;
        data = Buffer.concat([data, buffer.subarray(4, 4 + size)]);
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, received })));
}

describe("Antivirus (clamd INSTREAM)", () => {
  let clamd: Awaited<ReturnType<typeof fakeClamd>>;
  before(async () => {
    clamd = await fakeClamd();
  });
  after(() => new Promise<void>((resolve) => clamd.server.close(() => resolve())));

  it("signale un fichier infecté et laisse passer un fichier sain, même volumineux", async () => {
    const scanner = new ClamdScanner({ host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000 });
    assert.deepEqual(await scanner.scan(EICAR), { clean: false, signature: "Eicar-Test-Signature" });
    const big = Buffer.alloc(300_000, 7);
    assert.deepEqual(await scanner.scan(big), { clean: true });
    // Découpé en blocs de 64 Ko, reconstitué à l'identique côté clamd.
    assert.ok(clamd.received.at(-1)!.equals(big));
  });

  it("service injoignable : erreur explicite (le fichier sera refusé)", async () => {
    const scanner = new ClamdScanner({ host: "127.0.0.1", port: 1, timeoutMs: 2_000 });
    await assert.rejects(scanner.scan(Buffer.from("x")), ScannerUnavailableError);
  });
});

describe("Antivirus sur les routes", () => {
  const user: AuthenticatedUser = { userId: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111", role: "member" };
  const ORIGIN = "http://localhost:5173";

  function setup(scanner: MalwareScanner) {
    const events: AuditEvent[] = [];
    const conversations = createFakeConversationStore();
    const stored: string[] = [];
    const app = createAppServer({
      appOrigin: ORIGIN,
      logger: false,
      authenticate: async () => user,
      conversationStore: conversations,
      audit: { record: async (_request, event) => void events.push(event) },
      scanner,
      attachments: {
        create: async (_tenant, _conversation, input) => {
          stored.push(input.name);
          return { id: crypto.randomUUID(), name: input.name, kind: input.file.kind, mediaType: input.file.mediaType, size: input.bytes.length, messageId: null, createdAt: "" };
        },
        claimable: async () => [],
        forModel: async () => new Map(),
        content: async () => null,
        delete: async () => false,
      },
    });
    return { app, events, stored, conversations };
  }

  const upload = (conversationId: string, name: string, body: Buffer) => ({
    method: "POST" as const,
    url: `/conversations/${conversationId}/attachments`,
    headers: { origin: ORIGIN, "content-type": "application/octet-stream", "x-file-name": name },
    payload: body,
  });

  it("refuse un fichier infecté (422), le trace, et ne le stocke jamais", async (t) => {
    const { app, events, stored, conversations } = setup({ scan: async (bytes) => (bytes.includes("EICAR") ? { clean: false, signature: "Eicar-Test-Signature" } : { clean: true }) });
    t.after(() => app.close());
    const conversation = await conversations.create(user);

    const infected = await app.inject(upload(conversation.id, "note.txt", EICAR));
    assert.equal(infected.statusCode, 422);
    assert.deepEqual(stored, []);
    const event = events.find((item) => item.eventType === "security.malware_detected");
    assert.equal(event?.details?.signature, "Eicar-Test-Signature");

    assert.equal((await app.inject(upload(conversation.id, "note.txt", Buffer.from("bonjour")))).statusCode, 201);
    assert.deepEqual(stored, ["note.txt"]);
  });

  it("antivirus indisponible : refus (503), jamais d'acceptation par défaut", async (t) => {
    const { app, events, stored, conversations } = setup({
      scan: async () => {
        throw new ScannerUnavailableError("UNREACHABLE");
      },
    });
    t.after(() => app.close());
    const conversation = await conversations.create(user);
    const response = await app.inject(upload(conversation.id, "note.txt", Buffer.from("bonjour")));
    assert.equal(response.statusCode, 503);
    assert.deepEqual(stored, []);
    assert.ok(events.some((item) => item.eventType === "security.scan_unavailable"));
  });
});

describe("Proxy de sortie", () => {
  let target: HttpServer;
  let proxy: HttpServer;
  let targetPort = 0;
  let proxyPort = 0;
  const seen: string[] = [];

  before(async () => {
    target = createHttpServer((_request, response) => response.writeHead(200, { "content-type": "text/plain" }).end("via proxy"));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    targetPort = (target.address() as AddressInfo).port;
    // Proxy minimal : relaie les requêtes HTTP absolues, refuse les tunnels.
    proxy = createHttpServer((request, response) => {
      seen.push(request.url ?? "");
      const url = new URL(request.url ?? "");
      if (url.hostname !== "docs.exemple.com") return response.writeHead(403).end();
      fetch(`http://127.0.0.1:${targetPort}${url.pathname}`).then(async (upstream) => response.writeHead(upstream.status, { "content-type": "text/plain" }).end(await upstream.text()));
    });
    proxy.on("connect", (request, socket) => {
      seen.push(`CONNECT ${request.url}`);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyPort = (proxy.address() as AddressInfo).port;
  });
  after(async () => {
    await new Promise<void>((resolve) => target.close(() => resolve()));
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  it("passe par le proxy, qui décide ; un refus du proxy est explicite", async () => {
    const options = { maxBytes: 10_000, timeoutMs: 5_000, proxy: `http://127.0.0.1:${proxyPort}` };
    const page = await safeFetch("http://docs.exemple.com/guide", options);
    assert.equal(page.bytes.toString(), "via proxy");
    assert.equal(seen[0], "http://docs.exemple.com/guide");

    await assert.rejects(safeFetch("http://autre.exemple.com/", options), (error: LinkError) => error.code === "proxy_denied");
    await assert.rejects(safeFetch("https://docs.exemple.com/", options), (error: LinkError) => error.code === "proxy_denied");
    assert.equal(seen.at(-1), "CONNECT docs.exemple.com:443");
    // Les contrôles d'URL restent appliqués avant le proxy.
    await assert.rejects(safeFetch("http://169.254.169.254/", options), (error: LinkError) => error.code === "blocked_address");
  });
});
