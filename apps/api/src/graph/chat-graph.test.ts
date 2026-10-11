import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runChatGraph } from "./chat-graph.js";

describe("Chat graph", () => {
  it("traite un message et renvoie une réponse", async () => {
    const response = await runChatGraph({ message: "Bonjour" });

    assert.equal(
      response,
      "Snowfall a reçu ton message : Bonjour",
    );
  });

  it("préserve le contenu du message", async () => {
    const message = "Explique-moi TypeScript.";
    const response = await runChatGraph({ message });

    assert.equal(response, `Snowfall a reçu ton message : ${message}`);
  });
});