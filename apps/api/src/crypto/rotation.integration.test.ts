import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { PostgresAgentStore } from "../agents/store.js";
import { PostgresConversationStore } from "../conversations/store.js";
import { PostgresUserMemoryStore } from "../memory/store.js";
import { PostgresPromptStore } from "../prompts/store.js";
import { PostgresSkillStore } from "../skills/store.js";
import { LocalKeyEncryptionProvider } from "./envelope.js";
import { organizationKeyContext, OrganizationKeyring } from "./keyring.js";
import { reencryptTable, staleValues, tablesFor } from "./rotation.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Rotation des clés : PostgreSQL (tout rechiffré, tout relisible)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  const kek = new LocalKeyEncryptionProvider(randomBytes(32));
  const keyring = new OrganizationKeyring(kek);
  const org = randomUUID();
  const [alice, gone] = [randomUUID(), randomUUID()];
  const avatar = { kind: "alien" as const, color: "mint" as const, eyes: "sleepy" as const, accessory: "none" as const };
  const as = (userId: string) => ({ userId, organizationId: org });

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A')", [org]);
    for (const id of [alice, gone]) {
      await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@t.local`]);
      await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [org, id]);
    }
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = $1", [org]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, gone]]);
    await pool.end();
    await owner.end();
  });

  /** Comme le script : propriétaire des tables, sous la RLS du contexte posé. */
  async function inTenant<T>(userId: string | null, fn: (client: PoolClient) => Promise<T>) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [org, userId ?? ""]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function everywhere(fn: (client: PoolClient, target: (typeof import("./rotation.js"))["ENCRYPTED_TABLES"][number], tenant: { organizationId: string; userId: string }) => Promise<number>) {
    let total = 0;
    for (const target of tablesFor(false)) total += await inTenant(null, (client) => fn(client, target, { organizationId: org, userId: "" }));
    for (const userId of [alice, gone]) for (const target of tablesFor(true)) total += await inTenant(userId, (client) => fn(client, target, { organizationId: org, userId }));
    return total;
  }

  it("nouvelle clé : chaque valeur est rechiffrée, l'ancienne version ne sert plus, tout se relit", async () => {
    const agents = new PostgresAgentStore(pool, keyring);
    const conversations = new PostgresConversationStore(pool, keyring);
    const memories = new PostgresUserMemoryStore(pool, keyring);
    const prompts = new PostgresPromptStore(pool, keyring);
    const skills = new PostgresSkillStore(pool, keyring);
    // Données de l'organisation et de deux membres (dont un qui partira), sur la version 1.
    const agent = await agents.create(as(alice), { name: "Juriste", avatar, instructions: "Cite toujours l'article.", provider: "mistral", model: "mistral-small-latest" });
    const conversation = await conversations.create(as(alice), undefined, agent.id);
    const exchange = (await conversations.appendExchange(as(alice), conversation.id, "Question confidentielle", "Réponse confidentielle"))!;
    await conversations.setFeedback(as(alice), conversation.id, exchange.assistantMessage.id, { rating: "down", comment: "Imprécis" });
    await memories.add(as(alice), "Préfère des réponses courtes");
    await prompts.create(as(gone), { name: "Résumé", content: "Résume en 3 points." });
    // Compétence avec un modèle binaire (colonne facultative « original ») et une référence texte.
    const skill = await skills.create(as(alice), { name: "Quittances", description: "Faire les quittances", instructions: "Lance fill.py.", confidential: false });
    const template = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(300)]);
    const binary = await skills.addFile(as(alice), skill.id, { name: "modele.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: template.length, text: "[Classeur]", original: template });
    await skills.addFile(as(alice), skill.id, { name: "plan.md", mediaType: "text/markdown", size: 6, text: "# Plan" });
    const withSkill = await agents.create(as(alice), { name: "Gestion", avatar, instructions: "", provider: "mistral", model: "mistral-small-latest", skills: [skill.id] });

    // Rotation : version 2 de la clé d'organisation.
    await inTenant(null, async (client) => {
      await client.query("INSERT INTO organization_keys (organization_id, version, wrapped_key) VALUES ($1, 2, $2)", [org, await kek.wrap(randomBytes(32), organizationKeyContext(org, 2))]);
    });
    keyring.forget();
    assert.ok((await everywhere((client, target, tenant) => staleValues(client, target, tenant, 2))) >= 7);

    const rewritten = await everywhere((client, target, tenant) => reencryptTable(client, keyring, target, tenant, 2));
    assert.ok(rewritten >= 6);
    // Preuve : plus aucune valeur sur la version 1, dans aucune table.
    assert.equal(await everywhere((client, target, tenant) => staleValues(client, target, tenant, 2)), 0);
    // Relancer ne change rien (idempotent).
    assert.equal(await everywhere((client, target, tenant) => reencryptTable(client, keyring, target, tenant, 2)), 0);

    // Tout se relit par les stores habituels (AAD intactes).
    assert.equal((await agents.get(as(alice), agent.id))?.instructions, "Cite toujours l'article.");
    const messages = await conversations.getMessages(as(alice), conversation.id);
    assert.deepEqual(messages?.map((message) => message.content), ["Question confidentielle", "Réponse confidentielle"]);
    assert.equal(messages?.[1]?.feedback?.comment, "Imprécis");
    assert.equal((await conversations.get(as(alice), conversation.id))?.title, "Question confidentielle");
    assert.deepEqual((await memories.list(as(alice))).map((memory) => memory.content), ["Préfère des réponses courtes"]);
    assert.deepEqual((await prompts.list(as(gone))).map((prompt) => prompt.content), ["Résume en 3 points."]);
    // Original binaire rechiffré à l'identique (AAD « original ») ; fichier sans original intact.
    assert.ok((await skills.readOriginal(as(alice), withSkill.id, skill.id, binary!.id))?.equals(template));
    const loaded = await skills.load(as(alice), withSkill.id, skill.id);
    assert.deepEqual(loaded?.files.map((file) => [file.name, file.hasOriginal]), [["modele.xlsx", true], ["plan.md", false]]);
  });
});
