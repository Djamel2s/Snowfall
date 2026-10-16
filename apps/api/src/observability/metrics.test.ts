import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { AuthenticatedUser } from "../auth/auth.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore } from "../testing/fakes.js";
import { countingAuditLog, createMetrics, startMetricsServer } from "./metrics.js";

const ORIGIN = "http://localhost:5173";
const user: AuthenticatedUser = { userId: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111", role: "member" };

describe("Métriques Prometheus", () => {
  it("mesure routes, générations, tokens et audit, sans identifiant ni contenu", async (t) => {
    const metrics = createMetrics();
    const conversations = createFakeConversationStore();
    const app = createAppServer({
      appOrigin: ORIGIN,
      logger: false,
      authenticate: async () => user,
      conversationStore: conversations,
      metrics,
      audit: countingAuditLog({ record: async () => undefined }, metrics),
      runChat: async (_input, options) => {
        options?.onToken?.("ok");
        return { content: "Réponse confidentielle", model: "fake", usage: { inputTokens: 12, outputTokens: 7 } };
      },
    });
    t.after(() => app.close());

    const conversation = await conversations.create(user);
    await app.inject({ method: "POST", url: `/conversations/${conversation.id}/messages`, headers: { origin: ORIGIN }, payload: { content: "Question secrète" } });
    await app.inject({ method: "GET", url: `/conversations/${crypto.randomUUID()}/messages` });

    const text = await metrics.registry.metrics();
    assert.match(text, /snowfall_http_request_duration_seconds_count\{method="POST",route="\/conversations\/:id\/messages",status="200"\} 1/);
    assert.match(text, /route="\/conversations\/:id\/messages",status="404"/);
    assert.match(text, /snowfall_llm_tokens_total\{provider="echo",direction="input"\} 12/);
    assert.match(text, /snowfall_llm_generation_seconds_count\{provider="echo",outcome="success"\} 1/);
    assert.match(text, /snowfall_audit_events_total\{event="conversation.access",outcome="denied"\} 1/);
    // Ni identifiant, ni contenu, ni utilisateur dans les séries.
    for (const secret of [conversation.id, user.userId, user.organizationId, "secrète", "confidentielle"]) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it("le point /metrics exige le jeton s'il est configuré", async (t) => {
    const metrics = createMetrics();
    const server = startMetricsServer(metrics, { host: "127.0.0.1", port: 0, token: "jeton-de-test" });
    t.after(() => server.close());
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    assert.equal((await fetch(`${url}/metrics`)).status, 401);
    assert.equal((await fetch(`${url}/metrics`, { headers: { authorization: "Bearer autre-jeton!" } })).status, 401);
    const ok = await fetch(`${url}/metrics`, { headers: { authorization: "Bearer jeton-de-test" } });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /snowfall_process_cpu_seconds_total/);
    assert.equal((await fetch(`${url}/autre`)).status, 404);
  });
});
