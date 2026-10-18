import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { PostgresMcpConnectionStore } from "./connections.js";
import { hashState } from "./oauth.js";
import { PostgresMcpServerStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Connexions MCP (OAuth) : PostgreSQL", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let servers: PostgresMcpServerStore;
  let connections: PostgresMcpConnectionStore;
  const [org, other] = [randomUUID(), randomUUID()];
  const [alice, bob, eve] = [randomUUID(), randomUUID(), randomUUID()];
  const a = { userId: alice, organizationId: org };
  const b = { userId: bob, organizationId: org };
  const e = { userId: eve, organizationId: other };
  const oauth = { issuer: "https://auth.example/", authorizationEndpoint: "https://auth.example/a", tokenEndpoint: "https://auth.example/t", clientId: "snowfall", clientSecret: "s3cret" };

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    const keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    servers = new PostgresMcpServerStore(pool, keyring);
    connections = new PostgresMcpConnectionStore(pool, keyring);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    for (const id of [alice, bob, eve]) await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@t.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'admin'), ($1, $4, 'member'), ($2, $5, 'admin')", [org, other, alice, bob, eve]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob, eve]]);
    await pool.end();
    await owner.end();
  });

  it("jetons personnels : invisibles des collègues, chiffrés, jamais rattachés au serveur d'une autre organisation", async () => {
    const server = await servers.create(a, { name: "Jira", url: "https://mcp.example/mcp", oauth });
    assert.equal(server.auth, "oauth");
    assert.deepEqual((await servers.connection(a, server.id))?.oauth, oauth);
    // Configuration OAuth chiffrée (le secret client n'apparaît pas en clair).
    const raw = await withTenant(owner, a, (client) => client.query("SELECT oauth FROM mcp_servers WHERE id = $1", [server.id]));
    assert.ok(!JSON.stringify(raw.rows).includes("s3cret"));
    // Un serveur OAuth n'a pas de jeton partagé.
    await assert.rejects(servers.create(a, { name: "X", url: "https://mcp.example/x", token: "t", oauth }), /mcp_servers_auth_check/);

    await connections.saveTokens(a, server.id, { accessToken: "at-alice", refreshToken: "rt-alice", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal((await connections.tokens(a, server.id))?.accessToken, "at-alice");
    assert.equal(await connections.tokens(b, server.id), null);
    assert.deepEqual(await connections.connected(b), []);
    const peek = await withTenant(pool, b, (client) => client.query("SELECT 1 FROM mcp_user_tokens WHERE server_id = $1", [server.id]));
    assert.equal(peek.rowCount, 0);
    const stored = await withTenant(owner, a, (client) => client.query("SELECT access_token, refresh_token FROM mcp_user_tokens WHERE server_id = $1", [server.id]));
    assert.ok(!JSON.stringify(stored.rows).includes("at-alice") && !JSON.stringify(stored.rows).includes("rt-alice"));
    await assert.rejects(withTenant(owner, a, (client) => client.query("UPDATE mcp_user_tokens SET access_token = 'clair' WHERE server_id = $1", [server.id])), /mcp_user_tokens_encrypted_check/);
    // Eve (autre organisation) ne peut pas rattacher un jeton à ce serveur, même en SQL direct.
    await assert.rejects(
      withTenant(pool, e, (client) => client.query("INSERT INTO mcp_user_tokens (server_id, organization_id, user_id, access_token) VALUES ($1, $2, $3, '1:v1.AAAA.BBBB')", [server.id, other, eve])),
      /mcp_user_tokens_server_org_fk/,
    );

    // Renouvellement : le refresh token est gardé si le fournisseur n'en renvoie pas.
    await connections.saveTokens(a, server.id, { accessToken: "at-alice-2" });
    assert.equal((await connections.tokens(a, server.id))?.refreshToken, "rt-alice");
  });

  it("demande de connexion : liée à l'utilisateur, à usage unique, expirée au bout de 10 minutes", async () => {
    const server = await servers.create(a, { name: "Notion", url: "https://mcp.example/n", oauth });
    const state = hashState("state-1");
    await connections.savePending(a, state, { serverId: server.id, verifier: "v-123" });
    assert.equal(await connections.takePending(b, state), null);
    assert.deepEqual(await connections.takePending(a, state), { serverId: server.id, verifier: "v-123" });
    assert.equal(await connections.takePending(a, state), null);

    const old = hashState("state-2");
    await connections.savePending(a, old, { serverId: server.id, verifier: "v-456" });
    await withTenant(owner, a, (client) => client.query("UPDATE mcp_oauth_states SET expires_at = now() - interval '1 minute' WHERE state_hash = $1", [old]));
    assert.equal(await connections.takePending(a, old), null);
    const raw = await withTenant(owner, a, (client) => client.query("SELECT verifier FROM mcp_oauth_states"));
    assert.ok(!JSON.stringify(raw.rows).includes("v-456"));

    // Serveur supprimé : connexions et demandes disparaissent avec lui.
    await connections.saveTokens(a, server.id, { accessToken: "at" });
    await servers.delete(a, server.id);
    assert.equal(await connections.tokens(a, server.id), null);
  });
});
