import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { UnixSocketOcr } from "../ocr/client.js";
import { assertSocketInProduction, localEndpoint } from "./local-endpoint.js";

describe("Services isolés : socket Unix, ou pont local en développement", () => {
  it("socket Unix par défaut ; tcp:// en boucle locale seulement", () => {
    assert.deepEqual(localEndpoint("/run/sandbox/sandbox.sock"), { socketPath: "/run/sandbox/sandbox.sock" });
    assert.deepEqual(localEndpoint("tcp://127.0.0.1:7811"), { host: "127.0.0.1", port: 7811 });
    assert.deepEqual(localEndpoint("tcp://localhost:7811"), { host: "127.0.0.1", port: 7811 });
    assert.deepEqual(localEndpoint("tcp://[::1]:7811"), { host: "::1", port: 7811 });
    // Jamais une autre machine : le code exécuté et les documents ne quittent pas l'hôte.
    for (const bad of ["tcp://10.0.0.5:7811", "tcp://sandbox:7811", "tcp://127.0.0.1.evil.example:7811", "tcp://127.0.0.1:0", "tcp://127.0.0.1:70000", "tcp://127.0.0.1"]) {
      assert.throws(() => localEndpoint(bad), /Adresse locale invalide/, bad);
    }
  });

  it("production : socket Unix exigé (un port local est joignable par tout processus de l'hôte)", () => {
    assert.throws(() => assertSocketInProduction("SANDBOX_SOCKET", "tcp://127.0.0.1:7811", true), /socket Unix exigé en production/);
    assert.doesNotThrow(() => assertSocketInProduction("SANDBOX_SOCKET", "/run/sandbox/sandbox.sock", true));
    assert.doesNotThrow(() => assertSocketInProduction("SANDBOX_SOCKET", "tcp://127.0.0.1:7811", false));
    assert.throws(() => assertSocketInProduction("OCR_SOCKET", "tcp://192.168.1.2:7812", false), /Adresse locale invalide/);
  });

  it("un client joint le service par le pont local", async (t) => {
    const server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ text: `lu (${request.headers["content-type"]})` }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const ocr = new UnixSocketOcr(`tcp://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.equal(await ocr.recognize(Buffer.from("x"), "image/png"), "lu (image/png)");
  });
});
