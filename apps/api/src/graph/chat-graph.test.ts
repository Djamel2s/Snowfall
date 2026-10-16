import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatRunner, type ChatModel } from "./chat-graph.js";

describe("Chat graph", () => {
  it("traite un message et renvoie une réponse", async () => {
    const result = await createChatRunner()({ message: "Bonjour" });

    assert.equal(result.content, "Snowfall a reçu ton message : Bonjour");
    assert.equal(result.model, "echo");
  });

  it("diffuse la réponse jeton par jeton", async () => {
    const tokens: string[] = [];
    const result = await createChatRunner()(
      { message: "Explique-moi TypeScript." },
      { onToken: (text) => tokens.push(text) },
    );

    assert.ok(tokens.length > 1);
    assert.equal(tokens.join(""), result.content);
  });

  it("transmet l'historique et remonte la consommation de tokens", async () => {
    let seenTurns: unknown;
    const model: ChatModel = {
      id: "fake",
      async *stream({ turns }) {
        seenTurns = turns;
        yield { type: "token", text: "ok" };
        yield { type: "usage", inputTokens: 12, outputTokens: 1 };
      },
    };
    const history = [{ role: "user" as const, content: "avant" }];

    const result = await createChatRunner(model)({ message: "maintenant", history });

    // La boucle envoie la transcription complète : historique puis message.
    assert.deepEqual(seenTurns, [...history, { role: "user", content: "maintenant" }]);
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 1 });
  });

  it("refuse une réponse vide", async () => {
    const model: ChatModel = {
      id: "vide",
      async *stream() {
        yield { type: "token", text: "   " };
      },
    };

    await assert.rejects(createChatRunner(model)({ message: "x" }), /EMPTY_MODEL_RESPONSE/);
  });

  it("interrompt la génération quand le client annule", async () => {
    const controller = new AbortController();
    const model: ChatModel = {
      id: "lent",
      async *stream(_request, signal) {
        for (let i = 0; i < 100; i++) {
          if (signal?.aborted) throw new Error("aborted");
          if (i === 2) controller.abort();
          yield { type: "token", text: `${i} ` };
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      },
    };

    await assert.rejects(
      createChatRunner(model)({ message: "x" }, { signal: controller.signal }),
    );
  });
});
