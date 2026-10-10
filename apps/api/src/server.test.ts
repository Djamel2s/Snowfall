
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { createAppServer } from "./server.js";

const server = createAppServer();
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

describe("API HTTP", () => {
  it("renvoie 200 et un statut ok sur GET /health", async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("renvoie 404 sur une route inconnue", async () => {
    const response = await fetch(`${baseUrl}/route-inconnue`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
  });

  it("refuse une méthode autre que GET sur /health", async () => {
    const response = await fetch(`${baseUrl}/health`, {
      method: "POST",
    });

    assert.equal(response.status, 404);
  });
});
