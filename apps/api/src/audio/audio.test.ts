import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditEvent } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore } from "../testing/fakes.js";
import { OpenAiCompatibleSpeech, speakable } from "./speech.js";

const ORIGIN = "http://localhost:5173";
const member: AuthenticatedUser = { userId: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111", role: "member" };
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 2)]);

/** Faux service audio compatible OpenAI : enregistre ce qu'il reçoit. */
function fakeSpeechService(options: { badAudio?: boolean } = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([key, value]) => [key, typeof value === "string" ? value : `fichier:${(value as File).type}`])) : init?.body });
    if (url.endsWith("/v1/audio/transcriptions")) return new Response(JSON.stringify({ text: " Combien de jours de congés ? " }), { status: 200 });
    if (url.endsWith("/v1/audio/speech")) return new Response(options.badAudio ? Buffer.from("<html>") : MP3, { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { calls, speech: new OpenAiCompatibleSpeech({ baseUrl: "http://speaches:8000", model: "whisper-small" }, { baseUrl: "http://speaches:8000", model: "kokoro", voice: "ff_siwis" }, fetcher) };
}

function setup(speech?: OpenAiCompatibleSpeech) {
  const events: AuditEvent[] = [];
  const app = createAppServer({
    appOrigin: ORIGIN,
    logger: false,
    conversationStore: createFakeConversationStore(),
    authenticate: async () => member,
    audit: { record: async (_request, event) => void events.push(event) },
    ...(speech ? { speech } : {}),
  });
  return { app, events };
}

const dictate = (audio: Buffer, type = "audio/webm") => ({
  method: "POST" as const,
  url: "/audio/transcriptions?language=fr",
  headers: { origin: ORIGIN, "content-type": "application/octet-stream", "x-audio-type": type },
  payload: audio,
});

describe("Voix locale : dictée et lecture", () => {
  it("désactivée par défaut : aucune capacité annoncée, routes indisponibles", async (t) => {
    const { app } = setup();
    t.after(() => app.close());
    assert.deepEqual((await app.inject({ method: "GET", url: "/audio/capabilities" })).json(), { dictation: false, speech: false });
    assert.equal((await app.inject(dictate(WEBM))).statusCode, 404);
  });

  it("dictée : audio vérifié sur sa signature, texte rendu, audio jamais gardé ni audité", async (t) => {
    const fake = fakeSpeechService();
    const { app, events } = setup(fake.speech);
    t.after(() => app.close());
    const response = await app.inject(dictate(WEBM));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().text, "Combien de jours de congés ?");
    assert.deepEqual(fake.calls[0]!.body, { file: "fichier:audio/webm", model: "whisper-small", response_format: "json", language: "fr" });
    // Un fichier qui n'est pas de l'audio (type annoncé mensonger) : refusé avant tout envoi.
    assert.equal((await app.inject(dictate(Buffer.from("<script>alert(1)</script>"), "audio/webm"))).statusCode, 415);
    assert.equal((await app.inject(dictate(WEBM, "application/pdf"))).statusCode, 415);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(events.map((event) => event.eventType), ["audio.transcribe"]);
    assert.ok(!JSON.stringify(events).includes("congés"));
  });

  it("lecture : Markdown retiré, MP3 vérifié (une réponse qui n'est pas de l'audio est refusée)", async (t) => {
    const fake = fakeSpeechService();
    const { app } = setup(fake.speech);
    t.after(() => app.close());
    const response = await app.inject({ method: "POST", url: "/audio/speech", headers: { origin: ORIGIN }, payload: { text: "**30 jours** par an [1].\n\n```js\nconsole.log(1)\n```" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "audio/mpeg");
    assert.equal(JSON.parse(String(fake.calls[0]!.body)).input, "30 jours par an .");
    const bad = fakeSpeechService({ badAudio: true });
    const other = setup(bad.speech);
    t.after(() => other.app.close());
    assert.equal((await other.app.inject({ method: "POST", url: "/audio/speech", headers: { origin: ORIGIN }, payload: { text: "Bonjour" } })).statusCode, 502);
  });

  it("texte à lire : sans code, liens réduits à leur libellé", () => {
    assert.equal(speakable("Voir [le guide](https://x.example) et `npm test`."), "Voir le guide et npm test.");
  });
});
