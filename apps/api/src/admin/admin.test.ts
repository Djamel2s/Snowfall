import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditEvent } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import type { Agent, AgentStore } from "../agents/store.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore } from "../testing/fakes.js";
import type { Member, MemberStore } from "../workspace/members.js";
import { MemoryAdminOverviewStore, monthsBack, type AdminOverviewData } from "./overview.js";

const ORIGIN = "http://localhost:5173";
const ORG = "11111111-1111-4111-8111-111111111111";
const admin: AuthenticatedUser = { userId: "33333333-3333-4333-8333-333333333333", organizationId: ORG, role: "admin" };
const member: AuthenticatedUser = { ...admin, userId: "22222222-2222-4222-8222-222222222222", role: "member" };
const [shared, hidden, small] = ["a1111111-1111-4111-8111-111111111111", "a2222222-2222-4222-8222-222222222222", "a3333333-3333-4333-8333-333333333333"];

const data: AdminOverviewData = {
  days: Array.from({ length: 90 }, (_, index) => ({ day: `d${index}`, users: index % 4, messages: index })),
  active7: 3,
  active30: 6,
  activePeriod: 7,
  agents: [
    { agentId: shared, messages: 120, users: 6 },
    { agentId: hidden, messages: 40, users: 5 },
    // Moins de 5 personnes : le magasin ne le renvoie pas (comme la fonction SQL).
    { agentId: small, messages: 900, users: 1 },
  ],
  tokens: [{ period: monthsBack(0), byProvider: { mistral: 1200 } }],
  tools: { code: 4 },
};

function setup(user: AuthenticatedUser) {
  const events: AuditEvent[] = [];
  const members = { list: async () => Array.from({ length: 8 }, (_, index) => ({ userId: `u${index}` }) as Member) } as unknown as MemberStore;
  const agents = { list: async () => [{ id: shared, name: "Assistant RH" } as Agent] } as unknown as AgentStore;
  const app = createAppServer({
    appOrigin: ORIGIN,
    logger: false,
    conversationStore: createFakeConversationStore(),
    authenticate: async () => user,
    audit: { record: async (_request, event) => void events.push(event) },
    runChat: async () => ({ content: "ok", model: "fake" }),
    members,
    agents,
    agentRatings: { ratings: async () => ({ [shared]: { up: 9, total: 12 } }) },
    // L'organisation ne connaît que les administrateurs du magasin (ici : `admin`).
    adminOverview: new MemoryAdminOverviewStore({ [ORG]: data }, (tenant) => tenant.userId === admin.userId),
  });
  return { app, events };
}

describe("Administration › Pilotage", () => {
  it("administrateur : totaux de l'organisation, agents nommés s'il les voit, taux de 👍, jamais de classement par personne", async () => {
    const { app } = setup(admin);
    const response = await app.inject({ method: "GET", url: "/admin/overview?days=7" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const body = response.json();
    assert.deepEqual(body.members, { total: 8, active7: 3, active30: 6, activePeriod: 7 });
    assert.equal(body.activity.length, 7);
    assert.deepEqual(body.agents, [
      { agentId: shared, messages: 120, users: 6, name: "Assistant RH", rating: { up: 9, total: 12 } },
      // Agent privé d'un autre : compté, sans nom.
      { agentId: hidden, messages: 40, users: 5, name: null },
    ]);
    assert.deepEqual(body.tools, { code: 4 });
    // Aucun identifiant de personne dans la réponse.
    for (const forbidden of ["userId", '"u0"', member.userId, admin.userId]) assert.equal(response.body.includes(forbidden), false, forbidden);
  });

  it("membre : refusé et journalisé ; période hors liste : refusée", async () => {
    const { app, events } = setup(member);
    assert.equal((await app.inject({ method: "GET", url: "/admin/overview" })).statusCode, 403);
    assert.deepEqual(events.map((event) => [event.eventType, event.outcome]), [["admin.overview", "denied"]]);
    const { app: adminApp } = setup(admin);
    assert.equal((await adminApp.inject({ method: "GET", url: "/admin/overview?days=365" })).statusCode, 400);
    assert.equal((await adminApp.inject({ method: "GET", url: "/admin/overview?days=30&user=x" })).statusCode, 400);
  });

  it("rôle « admin » dans le jeton mais plus administrateur en base : la base refuse aussi", async () => {
    const demoted = { ...admin, userId: "44444444-4444-4444-8444-444444444444" };
    const { app, events } = setup(demoted);
    assert.equal((await app.inject({ method: "GET", url: "/admin/overview" })).statusCode, 403);
    assert.equal(events.at(-1)?.outcome, "denied");
  });
});
