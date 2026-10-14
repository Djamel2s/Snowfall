import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { deriveKey, open, seal } from "../crypto/envelope.js";

export const SESSION_IDLE_SECONDS = 30 * 60;
export const SESSION_MAX_SECONDS = 10 * 60 * 60;
// Au-delà, on revalide la session auprès de Keycloak (compte désactivé,
// session fermée côté IdP, etc.) : la révocation prend effet en < 5 min.
const REFRESH_AFTER_SECONDS = 4 * 60;
const TOUCH_AFTER_SECONDS = 60;

export type UserProfile = {
  name?: string;
  email?: string;
  username?: string;
};

export type OidcTokens = {
  refreshToken: string;
  idToken: string;
};

/** null = grant refusé par l'IdP (session révoquée) ; une exception = panne. */
export type TokenRefresher = (
  refreshToken: string,
  expectedSubject: string,
) => Promise<OidcTokens | null>;

export type ActiveSession = {
  userId: string;
  subject: string;
  profile: UserProfile;
};

export type SessionResolution =
  | { status: "valid"; session: ActiveSession }
  | { status: "missing" }
  | { status: "ended"; userId: string; reason: "idle" | "expired" | "revoked" };

export interface SessionStore {
  create(input: {
    userId: string;
    subject: string;
    tokens: OidcTokens;
    profile: UserProfile;
  }): Promise<string>;
  resolve(token: string | undefined): Promise<SessionResolution>;
  revoke(token: string | undefined): Promise<{ userId: string; idToken: string } | null>;
  purgeExpired(): Promise<number>;
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isPlausibleToken(token: string | undefined): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

type SessionRow = {
  user_id: string;
  subject: string;
  refresh_token_enc: string;
  id_token_enc: string;
  profile_enc: string;
  expired: boolean;
  idle: boolean;
  needs_refresh: boolean;
  needs_touch: boolean;
};

export class PostgresSessionStore implements SessionStore {
  private readonly key: Buffer;

  constructor(
    private readonly pool: Pool,
    masterKey: Buffer,
    private readonly refresh: TokenRefresher,
  ) {
    this.key = deriveKey(masterKey, "session/v1");
  }

  private sealField(idHash: string, field: string, value: string) {
    return seal(this.key, value, `session:${idHash}:${field}`);
  }

  private openField(idHash: string, field: string, value: string) {
    return open(this.key, value, `session:${idHash}:${field}`).toString("utf8");
  }

  async create(input: {
    userId: string;
    subject: string;
    tokens: OidcTokens;
    profile: UserProfile;
  }) {
    const token = randomBytes(32).toString("base64url");
    const idHash = hashSessionToken(token);

    await this.pool.query(
      `INSERT INTO sessions
         (id_hash, user_id, subject, refresh_token_enc, id_token_enc, profile_enc, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
      [
        idHash,
        input.userId,
        input.subject,
        this.sealField(idHash, "refresh_token", input.tokens.refreshToken),
        this.sealField(idHash, "id_token", input.tokens.idToken),
        this.sealField(idHash, "profile", JSON.stringify(input.profile)),
        SESSION_MAX_SECONDS,
      ],
    );

    return token;
  }

  async resolve(token: string | undefined): Promise<SessionResolution> {
    if (!isPlausibleToken(token)) return { status: "missing" };

    const idHash = hashSessionToken(token);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // FOR UPDATE : un seul rafraîchissement à la fois par session, sinon la
      // rotation des refresh tokens invaliderait les requêtes concurrentes.
      const result = await client.query<SessionRow>(
        `SELECT user_id, subject, refresh_token_enc, id_token_enc, profile_enc,
                now() >= expires_at AS expired,
                last_seen_at < now() - make_interval(secs => $2) AS idle,
                refreshed_at < now() - make_interval(secs => $3) AS needs_refresh,
                last_seen_at < now() - make_interval(secs => $4) AS needs_touch
         FROM sessions
         WHERE id_hash = $1
         FOR UPDATE`,
        [idHash, SESSION_IDLE_SECONDS, REFRESH_AFTER_SECONDS, TOUCH_AFTER_SECONDS],
      );
      const row = result.rows[0];

      if (!row) {
        await client.query("COMMIT");
        return { status: "missing" };
      }

      const end = async (reason: "idle" | "expired" | "revoked") => {
        await client.query("DELETE FROM sessions WHERE id_hash = $1", [idHash]);
        await client.query("COMMIT");
        return { status: "ended" as const, userId: row.user_id, reason };
      };

      if (row.expired) return await end("expired");
      if (row.idle) return await end("idle");

      if (row.needs_refresh) {
        const refreshed = await this.refresh(
          this.openField(idHash, "refresh_token", row.refresh_token_enc),
          row.subject,
        );
        if (!refreshed) return await end("revoked");

        await client.query(
          `UPDATE sessions
           SET refresh_token_enc = $2, id_token_enc = $3,
               refreshed_at = now(), last_seen_at = now()
           WHERE id_hash = $1`,
          [
            idHash,
            this.sealField(idHash, "refresh_token", refreshed.refreshToken),
            this.sealField(idHash, "id_token", refreshed.idToken),
          ],
        );
      } else if (row.needs_touch) {
        await client.query(
          "UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1",
          [idHash],
        );
      }

      await client.query("COMMIT");

      return {
        status: "valid",
        session: {
          userId: row.user_id,
          subject: row.subject,
          profile: JSON.parse(
            this.openField(idHash, "profile", row.profile_enc),
          ) as UserProfile,
        },
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(token: string | undefined) {
    if (!isPlausibleToken(token)) return null;

    const idHash = hashSessionToken(token);
    const result = await this.pool.query<{ user_id: string; id_token_enc: string }>(
      "DELETE FROM sessions WHERE id_hash = $1 RETURNING user_id, id_token_enc",
      [idHash],
    );
    const row = result.rows[0];
    if (!row) return null;

    return {
      userId: row.user_id,
      idToken: this.openField(idHash, "id_token", row.id_token_enc),
    };
  }

  async purgeExpired() {
    const result = await this.pool.query(
      `DELETE FROM sessions
       WHERE expires_at <= now()
          OR last_seen_at < now() - make_interval(secs => $1)`,
      [SESSION_IDLE_SECONDS],
    );
    return result.rowCount ?? 0;
  }
}
