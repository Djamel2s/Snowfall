import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditEvent } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { csvCell } from "../routes/security.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore } from "../testing/fakes.js";
import type { Member, MemberStore } from "../workspace/members.js";
import { MemorySecurityStore, type AuditEntry } from "./security.js";

const ORIGIN = "http://localhost:5173";
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const admin: AuthenticatedUser = { userId: "33333333-3333-4333-8333-333333333333", organizationId: ORG, role: "admin" };
const member: AuthenticatedUser = { ...admin, userId: "22222222-2222-4222-8222-222222222222", role: "member" };

const event = (index: number, eventType: string, outcome: AuditEntry["outcome"] = "success", organizationId = ORG): AuditEntry & { organizationId: string } => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
  eventType,
  outcome,
  actorUserId: member.userId,
  targetType: "conversation",
  targetId: `c${index}`,
  ip: "10.0.0.1",
  details: { model: "mistral-small" },
  organizationId,
});

function setup(user: AuthenticatedUser, store: MemorySecurityStore, extra: Partial<Parameters<typeof createAppServer>[0]> = {}) {
  const events: AuditEvent[] = [];
  const members = { list: async () => [{ userId: member.userId, email: "camille@polaris.example", role: "member" } as Member] } as unknown as MemberStore;
  const app = createAppServer({
    appOrigin: ORIGIN,
    logger: false,
    conversationStore: createFakeConversationStore(),
    authenticate: async () => user,
    audit: { record: async (_request, recorded) => void events.push(recorded) },
    runChat: async () => ({ content: "ok", model: "fake" }),
    members,
    security: store,
    ...extra,
  });
  return { app, events };
}

describe("Administration › Sécurité", () => {
  const all = [
    ...Array.from({ length: 70 }, (_, index) => event(index, index % 2 ? "message.create" : "auth.login")),
    event(80, "security.malware_detected", "denied"),
    event(81, "auth.login", "success", OTHER),
  ];
  const admins = (tenant: { userId: string }) => tenant.userId === admin.userId;

  it("journal : de son organisation seulement, du plus récent, par pages de 50, avec l'e-mail de l'auteur", async () => {
    const { app } = setup(admin, new MemorySecurityStore(all, admins));
    const first = (await app.inject({ method: "GET", url: "/admin/audit" })).json() as { events: (AuditEntry & { actorEmail: string })[]; next: { before: string; beforeId: string } };
    assert.equal(first.events.length, 50);
    assert.equal(first.events[0]!.eventType, "security.malware_detected");
    assert.equal(first.events[0]!.actorEmail, "camille@polaris.example");
    assert.ok(!first.events.some((entry) => entry.targetId === "c81"));
    const second = (await app.inject({ method: "GET", url: `/admin/audit?before=${encodeURIComponent(first.next.before)}&beforeId=${first.next.beforeId}` })).json() as { events: AuditEntry[]; next: unknown };
    assert.equal(second.events.length, 21);
    assert.equal(second.next, null);
    // Filtres : catégorie (préfixe), problèmes seulement.
    const logins = (await app.inject({ method: "GET", url: "/admin/audit?category=auth" })).json() as { events: AuditEntry[] };
    assert.ok(logins.events.every((entry) => entry.eventType.startsWith("auth.")));
    const problems = (await app.inject({ method: "GET", url: "/admin/audit?problems=1" })).json() as { events: AuditEntry[] };
    assert.deepEqual(problems.events.map((entry) => entry.eventType), ["security.malware_detected"]);
    // Entrées invalides : refusées avant la base.
    for (const url of ["/admin/audit?category=auth;drop", "/admin/audit?before=hier", "/admin/audit?before=2026-10-01T00:00:00Z", "/admin/audit?limit=100000"]) {
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 400, url);
    }
  });

  it("export CSV : journalisé, formules neutralisées (pas d'exécution à l'ouverture dans un tableur)", async () => {
    const trap = { ...event(90, "agent.update"), targetId: '=HYPERLINK("https://evil.example","clic")' };
    const { app, events } = setup(admin, new MemorySecurityStore([...all, trap], admins));
    const response = await app.inject({ method: "GET", url: "/admin/audit/export" });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /^text\/csv/);
    assert.match(String(response.headers["content-disposition"]), /attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = response.body.replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(lines.length, 1 + 72);
    assert.ok(lines.some((line) => line.includes(`"'=HYPERLINK(""https://evil.example"",""clic"")"`)));
    assert.deepEqual(events.map((recorded) => [recorded.eventType, recorded.details?.rows]), [["security.audit_export", 72]]);
    assert.equal(csvCell("@SUM(1)"), `"'@SUM(1)"`);
    assert.equal(csvCell("-2+3"), `"'-2+3"`);
    assert.equal(csvCell('simple "texte"'), '"simple ""texte"""');
  });

  it("conservation : durées proposées seulement ; journalisée", async () => {
    const store = new MemorySecurityStore([], admins);
    const { app, events } = setup(admin, store);
    assert.deepEqual((await app.inject({ method: "GET", url: "/admin/security/retention" })).json(), { conversationDays: null, choices: [30, 90, 180, 365, 730, 1095] });
    assert.equal((await app.inject({ method: "PUT", url: "/admin/security/retention", headers: { origin: ORIGIN }, payload: { conversationDays: 90 } })).statusCode, 200);
    assert.equal(await store.retention(admin), 90);
    for (const conversationDays of [1, 0, -5, 45, "90", 100000]) {
      assert.equal((await app.inject({ method: "PUT", url: "/admin/security/retention", headers: { origin: ORIGIN }, payload: { conversationDays } })).statusCode, 400, String(conversationDays));
    }
    assert.equal((await app.inject({ method: "PUT", url: "/admin/security/retention", headers: { origin: ORIGIN }, payload: { conversationDays: null } })).statusCode, 200);
    assert.deepEqual(events.map((recorded) => [recorded.eventType, recorded.details?.conversationDays]), [["security.retention_update", 90], ["security.retention_update", "unlimited"]]);
  });

  it("membre : ni journal, ni export, ni conservation (refus journalisés) ; rôle périmé : la base refuse aussi", async () => {
    const { app, events } = setup(member, new MemorySecurityStore(all, admins));
    for (const [method, url] of [["GET", "/admin/audit"], ["GET", "/admin/audit/export"], ["GET", "/admin/security/retention"], ["PUT", "/admin/security/retention"]] as const) {
      assert.equal((await app.inject({ method, url, headers: { origin: ORIGIN }, ...(method === "PUT" ? { payload: { conversationDays: 30 } } : {}) })).statusCode, 403, url);
    }
    assert.deepEqual(events.map((recorded) => recorded.outcome), ["denied", "denied", "denied", "denied"]);
    const demoted = { ...admin, userId: "44444444-4444-4444-8444-444444444444" };
    const { app: stale } = setup(demoted, new MemorySecurityStore(all, admins));
    assert.equal((await stale.inject({ method: "GET", url: "/admin/audit" })).statusCode, 403);
    assert.equal((await stale.inject({ method: "PUT", url: "/admin/security/retention", headers: { origin: ORIGIN }, payload: { conversationDays: 30 } })).statusCode, 403);
  });

  it("purge de conservation : la conversation échue est effacée sous l'identité de son auteur, et journalisée", async (t) => {
    const conversations = createFakeConversationStore();
    const old = await conversations.create(member, "Ancienne");
    const kept = await conversations.create(member, "Récente");
    const store = new MemorySecurityStore([], admins, [{ conversationId: old.id, organizationId: ORG, userId: member.userId }]);
    const { app, events } = setup(admin, store, { conversationStore: conversations, runTiming: { recoveryMs: 20 } });
    t.after(() => app.close());
    await app.ready();
    for (let attempt = 0; attempt < 50 && (await conversations.get(member, old.id)); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await conversations.get(member, old.id), null);
    assert.ok(await conversations.get(member, kept.id));
    assert.deepEqual(events.filter((recorded) => recorded.eventType === "conversation.purge").map((recorded) => [recorded.targetId, recorded.details?.reason]), [[old.id, "retention"]]);
  });
});
