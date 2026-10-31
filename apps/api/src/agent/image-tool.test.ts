import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generatedFileIds } from "./code-tool.js";
import { imageTool, MAX_IMAGES_PER_ANSWER, OpenAiCompatibleImages } from "./image-tool.js";
import { runTool, TOOL_TIMEOUT_MS } from "./tools.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const signal = new AbortController().signal;
const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

describe("Génération d'images locale", () => {
  it("service compatible OpenAI : PNG vérifié, tout autre contenu refusé", async () => {
    const sent: unknown[] = [];
    const ok = new OpenAiCompatibleImages({ baseUrl: "http://images:8080", model: "sdxl" }, (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 });
    }) as typeof fetch);
    assert.deepEqual(await ok.generate("a snowy mountain", "1024x1024", signal), PNG);
    assert.deepEqual(sent[0], { model: "sdxl", prompt: "a snowy mountain", n: 1, size: "1024x1024", response_format: "b64_json" });
    const html = new OpenAiCompatibleImages({ baseUrl: "http://images:8080", model: "sdxl" }, reply({ data: [{ b64_json: Buffer.from("<svg onload=alert(1)>").toString("base64") }] }));
    await assert.rejects(html.generate("x", "1024x1024", signal), /IMAGE_INVALID/);
  });

  it("outil : image enregistrée et rattachée à la réponse ; limite par réponse ; antivirus", async () => {
    const saved: string[] = [];
    const images = { count: 0 };
    const tool = imageTool({
      generator: { generate: async () => PNG },
      saveFile: async (file) => (saved.push(file.mediaType), { id: `f${saved.length}`, name: file.name, mediaType: file.mediaType, size: file.bytes.length, createdAt: "" } as never),
      images,
    });
    const result = await tool.execute({ prompt: "logo neige" }, { signal });
    assert.deepEqual(result.data, { files: ["f1"] });
    assert.deepEqual(generatedFileIds([{ role: "tool", name: "generate_image", data: result.data }]), ["f1"]);
    images.count = MAX_IMAGES_PER_ANSWER;
    assert.match((await tool.execute({ prompt: "encore" }, { signal })).content, /Limite/);

    const infected = imageTool({ generator: { generate: async () => PNG }, scanner: { scan: async () => ({ clean: false, signature: "Eicar" }) } as never, saveFile: async () => assert.fail("pas d'enregistrement"), images: { count: 0 } });
    assert.match((await infected.execute({ prompt: "x" }, { signal })).content, /refusée/);
  });

  it("délai propre à l'outil : une image lente (1024×1024 ≈ 1 min sur GPU) n'est pas coupée par le délai commun", async () => {
    const tool = imageTool({ generator: { generate: async () => PNG }, saveFile: async () => ({ id: "f1" }) as never, images: { count: 0 } });
    // Constaté en vrai : coupée à 30 s, l'image échouait alors que le service répondait en 54 s.
    assert.ok((tool.timeoutMs ?? TOOL_TIMEOUT_MS) >= 180_000);
    // Le délai commun s'applique toujours aux outils qui n'en déclarent pas.
    const slow = { ...tool, timeoutMs: 20, execute: (_args: unknown, context: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          // Garde le test en vie (le délai d'AbortSignal ne retient pas la boucle d'événements).
          const alive = setTimeout(() => undefined, 5_000);
          context.signal.addEventListener("abort", () => (clearTimeout(alive), reject(new Error("coupé"))));
        }) };
    assert.match((await runTool([slow as never], { name: "generate_image", arguments: { prompt: "alien" } }, signal)).content, /délai dépassé/);
  });
});
