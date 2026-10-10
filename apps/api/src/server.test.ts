import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAppServer } from "./server.js";

describe("API HTTP", () => {
  it("renvoie 200 sur GET /health", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
    assert.equal(response.headers["cache-control"], undefined);
  });

  it("renvoie 404 sur une route inconnue", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/route-inconnue",
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "Not found" });
  });

  it("refuse une méthode autre que GET sur /health", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/health",
    });

    assert.equal(response.statusCode, 404);
  });

  it("rejette un message vide sur POST /chat", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "   " },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json().error, "Invalid request");
  });

  it("renvoie une réponse du graphe sur POST /chat", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "Bonjour" },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      response: "Snowfall a reçu ton message : Bonjour",
    });
  });

  it("rejette les champs inconnus sur POST /chat", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        message: "Bonjour",
        admin: true,
      },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json().error, "Invalid request");
  });
});
