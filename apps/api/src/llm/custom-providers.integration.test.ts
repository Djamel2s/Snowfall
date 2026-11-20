import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { MAX_CUSTOM_PROVIDERS, PostgresCustomProviderStore } from "./custom-providers.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Fournisseurs personnalisés : PostgreSQL", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let store: PostgresCustomProviderStore;
  const [org, other] = [randomUUID(), randomUUID()];
  const [alice, eve] = [randomUUID(), randomUUID()];
  const a = { userId: alice, organizationId: org };
  const e = { userId: eve, organizationId: other };
  const URL_A = "https://router.example.com/api/v1";

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    store = new PostgresCustomProviderStore(pool, new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32))));
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    for (const id of [alice, eve]) await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@t.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'admin'), ($2, $4, 'admin')", [org, other, alice, eve]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, eve]]);
    await pool.end();
    await owner.end();
  });

  it("servi à son organisation seulement ; clé chiffrée en base ; RLS", async () => {
    const id = await store.create(a, { name: "Routeur", baseUrl: URL_A, apiKey: "sk-router-secret-9876" });
    assert.deepEqual(await store.endpoints(a), [{ id, name: "Routeur", baseUrl: URL_A, apiKey: "sk-router-secret-9876" }]);
    assert.deepEqual((await store.list(a)).map((item) => [item.name, item.hint]), [["Routeur", "9876"]]);
    assert.deepEqual(await store.endpoints(e), []);
    const raw = await owner.query("SELECT api_key FROM organization_model_providers WHERE id = $1", [id]);
    assert.ok(!JSON.stringify(raw.rows).includes("sk-router"));
    // Une autre organisation ne peut ni lire, ni écrire, ni retirer.
    const peek = await withTenant(pool, e, (client) => client.query("SELECT 1 FROM organization_model_providers WHERE organization_id = $1", [org]));
    assert.equal(peek.rowCount, 0);
    assert.equal(await store.remove(e, id), false);
    await assert.rejects(
      withTenant(pool, e, (client) =>
        client.query("INSERT INTO organization_model_providers (organization_id, name, base_url) VALUES ($1, 'x', 'https://evil.example.com')", [org]),
      ),
      /row-level security/,
    );
  });

  it("adresse changée en base pour détourner la clé : la clé ne se déchiffre plus", async () => {
    const id = await store.create(a, { name: "Détourné", baseUrl: URL_A, apiKey: "sk-detour-secret-1111" });
    // Écriture directe en base (RLS forcée : dans le contexte de l'organisation), une ligne touchée.
    const tampered = await withTenant(owner, a, (client) => client.query("UPDATE organization_model_providers SET base_url = 'https://evil.example.com/v1' WHERE id = $1", [id]));
    assert.equal(tampered.rowCount, 1);
    await assert.rejects(() => store.endpoints(a));
    assert.equal(await store.remove(a, id), true);
  });

  it("la base refuse : clé en clair, adresse HTTP, indice sans clé", async () => {
    const id = await store.create(a, { name: "Sans clé", baseUrl: URL_A });
    assert.equal((await store.endpoints(a)).find((item) => item.id === id)?.apiKey, undefined);
    await assert.rejects(
      withTenant(owner, a, (client) => client.query("UPDATE organization_model_providers SET api_key = 'sk-en-clair', hint = 'lair' WHERE id = $1", [id])),
      /organization_model_providers_encrypted_check/,
    );
    await assert.rejects(
      withTenant(owner, a, (client) => client.query("UPDATE organization_model_providers SET base_url = 'http://router.example.com' WHERE id = $1", [id])),
      /organization_model_providers_url_check/,
    );
    await assert.rejects(
      withTenant(owner, a, (client) => client.query("UPDATE organization_model_providers SET hint = 'abcd' WHERE id = $1", [id])),
      /organization_model_providers_key_check/,
    );
    assert.equal(await store.remove(a, id), true);
  });

  it(`au plus ${MAX_CUSTOM_PROVIDERS} par organisation, même en parallèle`, async () => {
    const before = (await store.list(a)).length;
    const results = await Promise.allSettled(
      Array.from({ length: MAX_CUSTOM_PROVIDERS + 5 - before }, (_, index) => store.create(a, { name: `R${index}`, baseUrl: URL_A })),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, MAX_CUSTOM_PROVIDERS - before);
    assert.equal((await store.list(a)).length, MAX_CUSTOM_PROVIDERS);
  });
});
