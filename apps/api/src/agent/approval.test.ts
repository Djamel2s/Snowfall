import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { createChatRunner, type ChatChunk, type ChatModel, type ChatRequest, type ToolEvent } from "../graph/chat-graph.js";
import { defaultAgentTools, knownTools, permittedTools } from "./catalog.js";
import { defineTool, DENIED_RESULT, runTool, type Approver, type ToolPreview } from "./tools.js";

function scripted(steps: ((request: ChatRequest) => ChatChunk[])[]) {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    id: "scripted",
    supportsTools: true,
    async *stream(request) {
      requests.push(structuredClone(request));
      for (const chunk of steps[Math.min(requests.length - 1, steps.length - 1)]!(request)) yield chunk;
    },
  };
  return { model, requests };
}

const call = (id: string, name: string, args: unknown): ChatChunk => ({ type: "tool_call", call: { id, name, arguments: args } });

/** Outil d'écriture qui compte ses exécutions. */
function sendMail() {
  const sent: string[] = [];
  const tool = defineTool({
    name: "send_mail",
    description: "Envoie un e-mail.",
    parameters: z.object({ to: z.email(), body: z.string().min(1) }).strict(),
    access: "write",
    preview: ({ to, body }) => ({ title: `E-mail à ${to}`, detail: body }),
    execute: async ({ to }) => {
      sent.push(to);
      return { content: "envoyé", summary: to };
    },
  });
  return { tool, sent };
}

const signal = () => new AbortController().signal;

describe("Validation humaine des outils d'écriture", () => {
  it("sans moyen de demander l'accord, l'écriture est refusée", async () => {
    const { tool, sent } = sendMail();
    const result = await runTool([tool], { name: "send_mail", arguments: { to: "a@b.fr", body: "x" } }, signal());
    assert.equal(result.denied, true);
    assert.equal(result.content, DENIED_RESULT);
    assert.deepEqual(sent, []);
  });

  it("l'utilisateur voit exactement ce qui sera exécuté, après validation des arguments", async () => {
    const { tool, sent } = sendMail();
    const asked: ToolPreview[] = [];
    const approve: Approver = async ({ preview }) => {
      asked.push(preview);
      return true;
    };
    // Arguments invalides : erreur au modèle, on ne dérange pas l'utilisateur.
    const invalid = await runTool([tool], { name: "send_mail", arguments: { to: "pas un mail", body: "x" } }, signal(), approve);
    assert.equal(invalid.isError, true);
    assert.equal(asked.length, 0);

    const ok = await runTool([tool], { id: "c1", name: "send_mail", arguments: { to: "a@b.fr", body: "Bonjour" } }, signal(), approve);
    assert.equal(ok.isError, false);
    assert.deepEqual(asked, [{ title: "E-mail à a@b.fr", detail: "Bonjour" }]);
    assert.deepEqual(sent, ["a@b.fr"]);
  });

  it("refus : le modèle l'apprend et continue, l'étape est marquée refusée", async () => {
    const { tool, sent } = sendMail();
    const { model, requests } = scripted([
      () => [call("c1", "send_mail", { to: "boss@exemple.fr", body: "Démission" })],
      () => [{ type: "token", text: "D'accord, je n'envoie rien." }],
    ]);
    const events: ToolEvent[] = [];
    const result = await createChatRunner(model)(
      { message: "x", tools: [tool] },
      { approve: async () => false, onTool: (event) => events.push(event) },
    );
    assert.deepEqual(sent, []);
    assert.deepEqual(events.map((event) => event.status), ["running", "denied"]);
    const last = requests[1]!.turns!.at(-1)!;
    assert.ok(last.role === "tool" && last.content === DENIED_RESULT && !last.isError);
    assert.equal(result.content, "D'accord, je n'envoie rien.");
  });

  it("un outil de lecture ne demande jamais d'accord", async () => {
    const read = defineTool({
      name: "lookup",
      description: "Lit.",
      parameters: z.object({}).strict(),
      access: "read",
      execute: async () => ({ content: "ok" }),
    });
    let asked = 0;
    const result = await runTool([read], { name: "lookup", arguments: {} }, signal(), async () => (asked++, false));
    assert.equal(result.isError, false);
    assert.equal(asked, 0);
  });

  it("un outil d'écriture sans aperçu est rejeté dès sa définition", () => {
    assert.throws(() =>
      defineTool({ name: "rm", description: "x", parameters: z.object({}), access: "write", execute: async () => ({ content: "" }) }),
    );
  });
});

describe("Autorisations des outils", () => {
  it("organisation ∩ agent ; sans agent, lecture seule", () => {
    assert.deepEqual([...permittedTools(["search_knowledge", "save_to_knowledge"], ["save_to_knowledge"])], ["save_to_knowledge"]);
    assert.deepEqual([...permittedTools(["search_knowledge"], ["search_knowledge", "save_to_knowledge"])], ["search_knowledge"]);
    assert.deepEqual([...permittedTools(["search_knowledge", "save_to_knowledge"], null)], ["search_knowledge"]);
    assert.deepEqual([...permittedTools([], defaultAgentTools)], []);
  });

  it("ignore les identifiants inconnus (outil retiré du catalogue)", () => {
    assert.deepEqual(knownTools(["save_to_knowledge", "rm_rf", "search_knowledge", "search_knowledge"]), ["search_knowledge", "save_to_knowledge"]);
  });
});
