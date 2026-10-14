import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import {
  hashSessionToken,
  PostgresSessionStore,
  type OidcTokens,
  type TokenRefresher,
} from "./session-store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("PostgresSessionStore", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  const userId = randomUUID();
  const masterKey = randomBytes(32);
  let refresher: TokenRefresher = async () => null;
  let refreshCalls = 0;

  const store = () =>
    new PostgresSessionStore(pool, masterKey, async (token, subject) => {
      refreshCalls++;
      return refresher(token, subject);
    });

  const tokens: OidcTokens = { refreshToken: "refresh-1", idToken: "id-1" };

  async function newSession() {
    return store().create({ userId, subject: "kc-sub", tokens, profile: { name: "Alice" } });
  }

  async function age(token: string, column: string, seconds: number) {
    await pool.query(
      `UPDATE sessions SET ${column} = now() - make_interval(secs => $2) WHERE id_hash = $1`,
      [hashSessionToken(token), seconds],
    );
  }

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@test.local`,
    ]);
  });

  after(async () => {
    await owner.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.end();
    await owner.end();
  });

  it("résout une session valide sans stocker le jeton ni les secrets en clair", async () => {
    const token = await newSession();
    const resolution = await store().resolve(token);

    assert.equal(resolution.status, "valid");
    if (resolution.status === "valid") {
      assert.equal(resolution.session.userId, userId);
      assert.deepEqual(resolution.session.profile, { name: "Alice" });
    }

    const raw = await pool.query("SELECT * FROM sessions WHERE id_hash = $1", [
      hashSessionToken(token),
    ]);
    const serialized = JSON.stringify(raw.rows);
    assert.ok(!serialized.includes(token));
    assert.ok(!serialized.includes("refresh-1"));
    assert.ok(!serialized.includes("Alice"));
  });

  it("ignore un jeton inconnu ou malformé", async () => {
    assert.equal((await store().resolve(undefined)).status, "missing");
    assert.equal((await store().resolve("' OR 1=1 --")).status, "missing");
    assert.equal(
      (await store().resolve(randomBytes(32).toString("base64url"))).status,
      "missing",
    );
  });

  it("expire une session inactive et la supprime", async () => {
    const token = await newSession();
    await age(token, "last_seen_at", 31 * 60);

    assert.deepEqual(await store().resolve(token), {
      status: "ended",
      userId,
      reason: "idle",
    });
    assert.equal((await store().resolve(token)).status, "missing");
  });

  it("expire une session au-delà de sa durée maximale", async () => {
    const token = await newSession();
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id_hash = $1", [
      hashSessionToken(token),
    ]);

    const resolution = await store().resolve(token);
    assert.equal(resolution.status, "ended");
  });

  it("revalide auprès de l'IdP et fait tourner le refresh token", async () => {
    const token = await newSession();
    await age(token, "refreshed_at", 5 * 60);
    let received: string | undefined;
    refresher = async (refreshToken) => {
      received = refreshToken;
      return { refreshToken: "refresh-2", idToken: "id-2" };
    };
    refreshCalls = 0;

    assert.equal((await store().resolve(token)).status, "valid");
    assert.equal(received, "refresh-1");
    assert.equal(refreshCalls, 1);

    // Rafraîchie : pas de nouvel appel avant l'échéance suivante.
    assert.equal((await store().resolve(token)).status, "valid");
    assert.equal(refreshCalls, 1);

    const revoked = await store().revoke(token);
    assert.equal(revoked?.idToken, "id-2");
  });

  it("termine la session si l'IdP refuse le refresh (compte désactivé, logout)", async () => {
    const token = await newSession();
    await age(token, "refreshed_at", 5 * 60);
    refresher = async () => null;

    assert.deepEqual(await store().resolve(token), {
      status: "ended",
      userId,
      reason: "revoked",
    });
    assert.equal((await store().resolve(token)).status, "missing");
  });

  it("conserve la session si l'IdP est momentanément injoignable", async () => {
    const token = await newSession();
    await age(token, "refreshed_at", 5 * 60);
    refresher = async () => {
      throw new Error("ECONNREFUSED");
    };

    await assert.rejects(store().resolve(token), /ECONNREFUSED/);

    refresher = async () => ({ refreshToken: "refresh-3", idToken: "id-3" });
    assert.equal((await store().resolve(token)).status, "valid");
  });

  it("un chiffré de session ne se relit pas avec une autre clé maîtresse", async () => {
    const token = await newSession();
    const other = new PostgresSessionStore(pool, randomBytes(32), async () => null);
    await assert.rejects(other.resolve(token), /DECRYPTION_FAILED/);
  });

  it("révoque une session (logout)", async () => {
    const token = await newSession();
    assert.equal((await store().revoke(token))?.idToken, "id-1");
    assert.equal((await store().resolve(token)).status, "missing");
    assert.equal(await store().revoke(token), null);
  });
});
