import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { open, seal, type KeyEncryptionProvider } from "./envelope.js";

// Valeur stockée en base : "<version de clé>:<chiffré v1>".
const FIELD_PATTERN = /^(\d+):(v1\..+)$/;
const MAX_CACHED_KEYS = 1_000;

/** Contexte (AAD côté KMS) qui lie une DEK enveloppée à son organisation et sa version. */
export function organizationKeyContext(organizationId: string, version: number) {
  return `organization-key:${organizationId}:${version}`;
}

/** Version de clé d'une valeur chiffrée, ou null si la valeur n'est pas chiffrée. */
export function keyVersionOf(stored: string) {
  const match = FIELD_PATTERN.exec(stored);
  return match ? Number(match[1]) : null;
}

/**
 * Une clé de données (DEK) par organisation, chiffrée par la KEK.
 * Doit être utilisé dans une transaction où le contexte tenant (RLS) est posé.
 */
export class OrganizationKeyring {
  private readonly cache = new Map<string, Buffer>();

  constructor(private readonly kek: KeyEncryptionProvider) {}

  async encrypt(
    client: PoolClient,
    organizationId: string,
    plaintext: string,
    aad: string,
  ): Promise<string> {
    const { version, key } = await this.activeKey(client, organizationId);
    return `${version}:${seal(key, plaintext, aad)}`;
  }

  async decrypt(
    client: PoolClient,
    organizationId: string,
    stored: string,
    aad: string,
  ): Promise<string> {
    return (await this.decryptBytes(client, organizationId, stored, aad)).toString("utf8");
  }

  /** Contenu binaire (pièces jointes) : chiffré tel quel, sans passer par du texte. */
  async encryptBytes(
    client: PoolClient,
    organizationId: string,
    plaintext: Buffer,
    aad: string,
  ): Promise<string> {
    const { version, key } = await this.activeKey(client, organizationId);
    return `${version}:${seal(key, plaintext, aad)}`;
  }

  async decryptBytes(
    client: PoolClient,
    organizationId: string,
    stored: string,
    aad: string,
  ): Promise<Buffer> {
    const match = FIELD_PATTERN.exec(stored);
    if (!match) throw new Error("UNENCRYPTED_VALUE");

    const key = await this.keyVersion(client, organizationId, Number(match[1]));
    return open(key, match[2]!, aad);
  }

  private context(organizationId: string, version: number) {
    return organizationKeyContext(organizationId, version);
  }

  /** Oublie les clés en cache (après une rotation, dans un processus long). */
  forget() {
    this.cache.clear();
  }

  private remember(cacheKey: string, key: Buffer) {
    if (this.cache.size >= MAX_CACHED_KEYS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, key);
  }

  private async activeKey(client: PoolClient, organizationId: string) {
    let row = await this.latestRow(client, organizationId);

    if (!row) {
      const key = randomBytes(32);
      const wrapped = await this.kek.wrap(key, this.context(organizationId, 1));
      await client.query(
        `INSERT INTO organization_keys (organization_id, version, wrapped_key)
         VALUES ($1, 1, $2)
         ON CONFLICT DO NOTHING`,
        [organizationId, wrapped],
      );
      row = await this.latestRow(client, organizationId);
      if (!row) throw new Error("ORGANIZATION_KEY_UNAVAILABLE");
    }

    return { version: row.version, key: await this.unwrapRow(organizationId, row) };
  }

  private async keyVersion(client: PoolClient, organizationId: string, version: number) {
    const cached = this.cache.get(`${organizationId}:${version}`);
    if (cached) return cached;

    const result = await client.query<{ version: number; wrapped_key: string }>(
      `SELECT version, wrapped_key FROM organization_keys
       WHERE organization_id = $1 AND version = $2`,
      [organizationId, version],
    );
    const row = result.rows[0];
    if (!row) throw new Error("ORGANIZATION_KEY_UNAVAILABLE");

    return this.unwrapRow(organizationId, row);
  }

  private async latestRow(client: PoolClient, organizationId: string) {
    const result = await client.query<{ version: number; wrapped_key: string }>(
      `SELECT version, wrapped_key FROM organization_keys
       WHERE organization_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [organizationId],
    );
    return result.rows[0];
  }

  private async unwrapRow(
    organizationId: string,
    row: { version: number; wrapped_key: string },
  ) {
    const cacheKey = `${organizationId}:${row.version}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const key = await this.kek.unwrap(
      row.wrapped_key,
      this.context(organizationId, row.version),
    );
    this.remember(cacheKey, key);
    return key;
  }
}
