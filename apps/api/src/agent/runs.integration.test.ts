import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { z } from "zod";
import { PostgresConversationStore } from "../conversations/store.js";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { createChatRunner, type ChatChunk, type ChatModel } from "../graph/chat-graph.js";
import { EncryptedCheckpointSaver } from "./checkpointer.js";
import { PostgresRunStore, type RunRequest } from "./runs.js";
import { defineTool } from "./tools.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;
const SECRET = "Projet Orion : budget 4,2 M€";

const request: RunRequest = {
  kind: "message",
  content: SECRET,
  attachmentIds: [],
  agentId: null,
  provider: "mistral",
  role: "member",
  details: {},
};

describe("Exécution durable : PostgreSQL (RLS, chiffrement, bail)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let keyring: OrganizationKeyring;
  let runs: PostgresRunStore;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const a = { userId: alice, organizationId: orgA };
  const b = { userId: bob, organizationId: orgB };
  let conversationId = "";

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    runs = new PostgresRunStore(pool, keyring);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [orgA, orgB]);
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $3), ($2, $4)", [alice, bob, `${alice}@test.local`, `${bob}@test.local`]);
    await owner.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'member'), ($2, $4, 'member')",
      [orgA, orgB, alice, bob],
    );
    conversationId = (await new PostgresConversationStore(pool, keyring).create(a, "Run")).id;
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[orgA, orgB]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob]]);
    await pool.end();
    await owner.end();
  });

  it("une seule réponse active par conversation ; bail exclusif ; invisible d'une autre organisation", async () => {
    const run = await runs.create(a, conversationId, request, "instance-1", 60_000);
    assert.ok(run);
    assert.equal(await runs.create(a, conversationId, request, "instance-2", 60_000), null);
    assert.equal((await runs.active(a, conversationId))?.request.content, SECRET);
    // Bail valide détenu par instance-1 : personne d'autre ne le reprend.
    assert.equal(await runs.claim(a, run.id, "instance-2", 60_000), null);
    assert.deepEqual(await runs.renew(a, run.id, "instance-2", 60_000), { held: false, cancelRequested: false });
    assert.deepEqual(await runs.renew(a, run.id, "instance-1", 60_000, { text: "Début", steps: [], pending: [] }), { held: true, cancelRequested: false });

    assert.equal(await runs.get(b, run.id), null);
    assert.equal(await runs.requestCancel(b, run.id), false);
    assert.equal(await runs.requestCancel(a, run.id), true);
    assert.equal((await runs.renew(a, run.id, "instance-1", 60_000)).cancelRequested, true);

    // Rien en clair : ni la question, ni l'avancement.
    // Lecture brute par le propriétaire des tables (RLS imposée aussi : contexte du tenant).
    const raw = await withTenant(owner, a, (client) => client.query("SELECT request, progress FROM agent_runs WHERE id = $1", [run.id]));
    assert.equal(raw.rowCount, 1);
    assert.ok(!JSON.stringify(raw.rows).includes("Orion") && !JSON.stringify(raw.rows).includes("Début"));
    await runs.finish(a, run.id);
    assert.equal(await runs.active(a, conversationId), null);
  });

  it("bail expiré ou validation trop ancienne : listé pour reprise, identifiants seulement", async () => {
    // Bail très court : expiré presque aussitôt (instance tombée).
    const run = (await runs.create(a, conversationId, request, "instance-1", 1))!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stale = await runs.stale(3600);
    assert.deepEqual(stale.find((item) => item.runId === run.id), { runId: run.id, organizationId: orgA, userId: alice, status: "running" });
    // La file de reprise n'est lisible que par la fonction dédiée.
    await assert.rejects(pool.query("SELECT * FROM agent_run_leases"), /permission denied/);
    // Repris par une autre instance : l'ancienne perd son bail.
    assert.ok(await runs.claim(a, run.id, "instance-2", 60_000));
    assert.equal((await runs.renew(a, run.id, "instance-1", 60_000)).held, false);

    await runs.pause(a, run.id, "instance-2", { text: "", steps: [], pending: [] });
    assert.equal((await runs.get(a, run.id))?.status, "waiting");
    assert.ok(!(await runs.stale(3600)).some((item) => item.runId === run.id));
    assert.ok((await runs.stale(0)).some((item) => item.runId === run.id && item.status === "waiting"));
    // Sans contexte de tenant, le rôle applicatif ne voit aucune ligne (RLS).
    assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_runs")).rows[0]!.n, 0);
    await runs.finish(a, run.id);
  });

  it("points de reprise chiffrés : pause sur validation, reprise, puis effacement", async () => {
    const run = (await runs.create(a, conversationId, request, "instance-1", 60_000))!;
    const saver = new EncryptedCheckpointSaver(pool, keyring, a);
    let written = 0;
    const save = defineTool({
      name: "save_note",
      description: "Enregistre.",
      parameters: z.object({ text: z.string() }).strict(),
      access: "write",
      preview: ({ text }) => ({ title: "Note", detail: text }),
      execute: async () => {
        written++;
        return { content: "Note enregistrée." };
      },
    });
    const model: ChatModel = {
      id: "scripted",
      supportsTools: true,
      async *stream(chat): AsyncIterable<ChatChunk> {
        if (chat.turns?.at(-1)?.role === "tool") {
          yield { type: "token", text: "Fait." };
          return;
        }
        yield { type: "tool_call", call: { id: "c1", name: "save_note", arguments: { text: SECRET } } };
      },
    };
    const runner = createChatRunner(model);
    const durable = { checkpointer: saver, threadId: run.id };

    const paused = await runner({ message: SECRET, tools: [save] }, { durable });
    assert.equal(paused.pending?.length, 1);
    assert.equal(paused.pending![0]!.preview.detail, SECRET);
    const raw = await withTenant(owner, a, (client) =>
      client.query(
        `SELECT c.checkpoint, c.metadata, w.value FROM agent_checkpoints c
         LEFT JOIN agent_checkpoint_writes w ON w.run_id = c.run_id WHERE c.run_id = $1`,
        [run.id],
      ),
    );
    assert.ok(raw.rowCount! > 0);
    assert.ok(!JSON.stringify(raw.rows).includes("Orion"));
    // Points de reprise d'une autre organisation : invisibles.
    assert.equal(await new EncryptedCheckpointSaver(pool, keyring, b).getTuple({ configurable: { thread_id: run.id } }), undefined);

    // Reprise par une « autre instance » (nouveau saver, même base).
    const resumed = await createChatRunner(model)(
      { message: "", tools: [save] },
      { durable: { checkpointer: new EncryptedCheckpointSaver(pool, keyring, a), threadId: run.id, resume: { [paused.pending![0]!.id]: true } } },
    );
    assert.equal(resumed.content, "Fait.");
    assert.equal(written, 1);

    await saver.deleteThread(run.id);
    const left = await withTenant(owner, a, (client) => client.query("SELECT count(*)::int AS n FROM agent_checkpoints WHERE run_id = $1", [run.id]));
    assert.equal(left.rows[0].n, 0);
    await runs.finish(a, run.id);
  });

  it("refuse tout contenu non chiffré (contrainte)", async () => {
    const run = (await runs.create(a, conversationId, request, "instance-1", 60_000))!;
    await assert.rejects(
      withTenant(owner, a, (client) => client.query("UPDATE agent_runs SET progress = '{\"text\":\"en clair\"}' WHERE id = $1", [run.id])),
      /agent_runs_encrypted_check/,
    );
    await assert.rejects(
      withTenant(owner, a, (client) =>
        client.query(
          "INSERT INTO agent_checkpoints (organization_id, user_id, run_id, checkpoint_id, checkpoint, metadata) VALUES ($1, $2, $3, 'x', 'en clair', 'en clair')",
          [orgA, alice, run.id],
        ),
      ),
      /agent_checkpoints_encrypted_check/,
    );
    await runs.finish(a, run.id);
  });
});
