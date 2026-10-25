import type { Pool } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

export const locales = ["fr", "en"] as const;
export type Locale = (typeof locales)[number];
export const themes = ["system", "dark", "light"] as const;
export type Theme = (typeof themes)[number];

/** Instructions personnalisées : courtes (elles accompagnent chaque message). */
export const MAX_INSTRUCTIONS = 1_500;

export type Preferences = {
  locale: Locale | null;
  sendOnEnter: boolean;
  reduceMotion: "system" | "on" | "off";
  /** Mémoire activée par l'utilisateur (désactivée par défaut). */
  memory: boolean;
  theme: Theme;
  /** « Qui je suis, comment me répondre » : ajouté au prompt de chaque réponse. Chiffré. */
  instructions: string;
};

export const defaultPreferences: Preferences = { locale: null, sendOnEnter: true, reduceMotion: "system", memory: false, theme: "system", instructions: "" };

export interface PreferencesStore {
  get(tenant: TenantContext): Promise<Preferences>;
  update(tenant: TenantContext, preferences: Preferences): Promise<Preferences>;
}

export const instructionsAad = (tenant: TenantContext) => `user-instructions:${tenant.organizationId}:${tenant.userId}`;

type Row = Omit<Preferences, "instructions"> & { instructions_enc: string | null };
const COLUMNS = `locale, send_on_enter AS "sendOnEnter", reduce_motion AS "reduceMotion", memory_enabled AS "memory", theme, instructions_enc`;

export class PostgresPreferencesStore implements PreferencesStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async view(client: import("pg").PoolClient, tenant: TenantContext, row: Row | undefined): Promise<Preferences> {
    if (!row) return defaultPreferences;
    const { instructions_enc: sealed, ...rest } = row;
    return {
      ...rest,
      theme: themes.includes(rest.theme) ? rest.theme : "system",
      instructions: sealed ? await this.keyring.decrypt(client, tenant.organizationId, sealed, instructionsAad(tenant)) : "",
    };
  }

  get(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<Row>(`SELECT ${COLUMNS} FROM user_preferences WHERE organization_id = $1 AND user_id = $2`, [tenant.organizationId, tenant.userId]);
      return this.view(client, tenant, result.rows[0]);
    });
  }

  update(tenant: TenantContext, preferences: Preferences) {
    return withTenant(this.pool, tenant, async (client) => {
      const instructions = preferences.instructions.trim();
      const sealed = instructions ? await this.keyring.encrypt(client, tenant.organizationId, instructions, instructionsAad(tenant)) : null;
      const result = await client.query<Row>(
        `INSERT INTO user_preferences (organization_id, user_id, locale, send_on_enter, reduce_motion, memory_enabled, theme, instructions_enc, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (organization_id, user_id) DO UPDATE SET
           locale = EXCLUDED.locale,
           send_on_enter = EXCLUDED.send_on_enter,
           reduce_motion = EXCLUDED.reduce_motion,
           memory_enabled = EXCLUDED.memory_enabled,
           theme = EXCLUDED.theme,
           instructions_enc = EXCLUDED.instructions_enc,
           updated_at = now()
         RETURNING ${COLUMNS}`,
        [tenant.organizationId, tenant.userId, preferences.locale, preferences.sendOnEnter, preferences.reduceMotion, preferences.memory, preferences.theme, sealed],
      );
      return this.view(client, tenant, result.rows[0]);
    });
  }
}
