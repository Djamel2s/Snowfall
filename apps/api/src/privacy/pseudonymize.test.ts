import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatChunk, ChatModel, ChatRequest } from "../graph/chat-graph.js";
import { PSEUDONYMIZE_DESIGN, PSEUDONYMIZE_HELD_OUT, type PseudonymizeCase } from "./pseudonymize-cases.js";
import { Pseudonymizer, pseudonymizingModel } from "./pseudonymize.js";

function measure(cases: PseudonymizeCase[]) {
  let personal = 0;
  let leaked = 0;
  let kept = 0;
  let damaged = 0;
  const leaks: string[] = [];
  for (const item of cases) {
    const masked = new Pseudonymizer().mask(item.text);
    for (const value of item.personal) {
      personal++;
      if (masked.includes(value)) {
        leaked++;
        leaks.push(value);
      }
    }
    for (const word of item.keep) {
      kept++;
      if (!masked.includes(word)) damaged++;
    }
  }
  return { personal, leaked, kept, damaged, leaks };
}

describe("Pseudonymisation : repérage", () => {
  it("jeu de mise au point : rien ne fuit, rien d'ordinaire n'est abîmé", () => {
    const result = measure(PSEUDONYMIZE_DESIGN);
    assert.deepEqual([result.leaked, result.damaged, result.leaks], [0, 0, []]);
  });

  it("jeu tenu à l'écart : mesure (écrit après les règles)", () => {
    const result = measure(PSEUDONYMIZE_HELD_OUT);
    console.log(`Pseudonymisation (tenu à l'écart) : ${result.personal - result.leaked}/${result.personal} valeurs masquées, ${result.damaged}/${result.kept} mots ordinaires abîmés ; fuites : ${result.leaks.join(", ") || "aucune"}`);
    // Plancher : une régression des règles fait échouer le test.
    assert.ok(result.leaked <= 2, `${result.leaked} fuites`);
    assert.ok(result.damaged <= 1, `${result.damaged} mots abîmés`);
  });

  it("jetons stables : même personne, même jeton, d'un message à l'autre", () => {
    const pseudonymizer = new Pseudonymizer();
    const first = pseudonymizer.mask("Julie Martin a écrit.");
    const second = pseudonymizer.mask("Réponds à Martin, et à julie.martin@polaris.fr.");
    assert.equal(first, "[PERSONNE_1] a écrit.");
    assert.equal(second, "Réponds à [PERSONNE_1], et à [EMAIL_1].");
    assert.equal(pseudonymizer.unmask("Bonjour [PERSONNE_1] ([EMAIL_1]), [PERSONNE_9]"), "Bonjour Julie Martin (julie.martin@polaris.fr), [PERSONNE_9]");
  });

  it("faux jeton déjà présent dans un texte : jamais restitué comme une autre personne", () => {
    const pseudonymizer = new Pseudonymizer();
    const masked = pseudonymizer.mask("Julie Martin cite [PERSONNE_1].");
    // Le vrai jeton désigne Julie Martin ; le faux est neutralisé (tiret bas remplacé).
    assert.equal(masked, "[PERSONNE_1] cite [PERSONNE‗1].");
    assert.equal(pseudonymizer.unmask(masked), "Julie Martin cite [PERSONNE‗1].");
  });

  it("texte démesuré : borné dans le temps", () => {
    const started = performance.now();
    new Pseudonymizer().mask(`${"Julie ".repeat(20_000)}${"a@b.c ".repeat(20_000)}${"12 rue ".repeat(10_000)}`);
    assert.ok(performance.now() - started < 3_000, `${Math.round(performance.now() - started)} ms`);
  });

  it("flux : un jeton coupé entre deux morceaux est restitué entier", () => {
    const pseudonymizer = new Pseudonymizer();
    pseudonymizer.mask("Écris à Sophie Bernard.");
    const output = pseudonymizer.unmasker();
    const parts = ["Bonjour [PERS", "ONNE_1], merci", " pour [", "tout]."].map((chunk) => output.push(chunk));
    assert.equal(parts.join("") + output.flush(), "Bonjour Sophie Bernard, merci pour [tout].");
  });
});

describe("Pseudonymisation : modèle enveloppé", () => {
  /** Faux fournisseur : il garde ce qu'il reçoit et répond en citant les jetons. */
  function provider(chunks: ChatChunk[]) {
    const seen: ChatRequest[] = [];
    const model: ChatModel = {
      id: "externe",
      supportsTools: true,
      async *stream(request) {
        seen.push(request);
        yield* chunks;
      },
    };
    return { seen, model: pseudonymizingModel(model) };
  }

  const request: ChatRequest = {
    instructions: "Tu aides l'équipe de Mme Leroy.",
    history: [
      { role: "user", content: "Le dossier de Julie Martin (06 12 34 56 78) ?" },
      { role: "assistant", content: "Je regarde.", toolCalls: [{ id: "c1", name: "search_knowledge", arguments: { query: "Julie Martin" } }], providerData: { signature: "Julie Martin" } },
      { role: "tool", toolCallId: "c1", name: "search_knowledge", content: "Fiche : Julie Martin, 12 rue des Lilas." },
    ],
    message: "Écris-lui à julie.martin@polaris.fr.",
  };

  it("rien de personnel ne part ; la réponse et les arguments d'outils reviennent en clair", async () => {
    const { seen, model } = provider([
      { type: "token", text: "C'est fait pour [PERS" },
      { type: "token", text: "ONNE_2]." },
      { type: "tool_call", call: { id: "c2", name: "save_to_knowledge", arguments: { content: "Mail envoyé à [EMAIL_1]" } } },
    ]);
    const chunks: ChatChunk[] = [];
    for await (const chunk of model.stream(request)) chunks.push(chunk);

    const sent = JSON.stringify({ ...seen[0], history: seen[0]!.history.map((turn) => ({ ...turn, providerData: undefined })) });
    for (const value of ["Leroy", "Julie Martin", "06 12 34 56 78", "12 rue des Lilas", "julie.martin@polaris.fr"]) assert.ok(!sent.includes(value), `${value} est parti`);
    // Données signées du fournisseur : intactes (sinon il les rejette).
    assert.deepEqual((seen[0]!.history[1] as { providerData?: unknown }).providerData, { signature: "Julie Martin" });
    assert.match(seen[0]!.instructions!, /jetons comme \[PERSONNE_1\]/);

    const text = chunks.filter((chunk) => chunk.type === "token").map((chunk) => (chunk as { text: string }).text).join("");
    assert.equal(text, "C'est fait pour Julie Martin.");
    const call = chunks.find((chunk) => chunk.type === "tool_call") as { call: { arguments: { content: string } } };
    assert.equal(call.call.arguments.content, "Mail envoyé à julie.martin@polaris.fr");
  });
});
