import type { Pool } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";

export const locales = ["fr", "en"] as const;
export type Locale = (typeof locales)[number];

export type Preferences = {
  locale: Locale | null;
  sendOnEnter: boolean;
  reduceMotion: "system" | "on" | "off";
  /** Mémoire activée par l'utilisateur (désactivée par défaut). */
  memory: boolean;
};

export const defaultPreferences: Preferences = { locale: null, sendOnEnter: true, reduceMotion: "system", memory: false };

export interface PreferencesStore {
  get(tenant: TenantContext): Promise<Preferences>;
  update(tenant: TenantContext, preferences: Preferences): Promise<Preferences>;
}

const COLUMNS = `locale, send_on_enter AS "sendOnEnter", reduce_motion AS "reduceMotion", memory_enabled AS "memory"`;

export class PostgresPreferencesStore implements PreferencesStore {
  constructor(private readonly pool: Pool) {}

  get(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<Preferences>(
        `SELECT ${COLUMNS} FROM user_preferences WHERE organization_id = $1 AND user_id = $2`,
        [tenant.organizationId, tenant.userId],
      );
      return result.rows[0] ?? defaultPreferences;
    });
  }

  update(tenant: TenantContext, preferences: Preferences) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<Preferences>(
        `INSERT INTO user_preferences (organization_id, user_id, locale, send_on_enter, reduce_motion, memory_enabled, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (organization_id, user_id) DO UPDATE SET
           locale = EXCLUDED.locale,
           send_on_enter = EXCLUDED.send_on_enter,
           reduce_motion = EXCLUDED.reduce_motion,
           memory_enabled = EXCLUDED.memory_enabled,
           updated_at = now()
         RETURNING ${COLUMNS}`,
        [tenant.organizationId, tenant.userId, preferences.locale, preferences.sendOnEnter, preferences.reduceMotion, preferences.memory],
      );
      return result.rows[0]!;
    });
  }
}
