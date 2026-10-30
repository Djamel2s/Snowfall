import type { Pool } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Identité de l'organisation : logo (remplace celui de Snowfall partout) et
// couleur du logo par défaut. Lecture : tous les membres. Écriture : les
// administrateurs (vérifié par la route ET par la RLS).

export type Branding = { color: string | null; logo: { version: number; type: string } | null };
export type BrandingLogo = { bytes: Buffer; type: string; version: number };

export interface BrandingStore {
  get(tenant: TenantContext): Promise<Branding>;
  logo(tenant: TenantContext): Promise<BrandingLogo | null>;
  /** false : refusé par la base (pas administrateur). */
  setLogo(tenant: TenantContext, logo: { bytes: Buffer; type: "image/png" | "image/jpeg" }): Promise<boolean>;
  clearLogo(tenant: TenantContext): Promise<boolean>;
  setColor(tenant: TenantContext, color: string | null): Promise<boolean>;
}

const EMPTY: Branding = { color: null, logo: null };

export class PostgresBrandingStore implements BrandingStore {
  constructor(private readonly pool: Pool) {}

  get(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<{ color: string | null; logo_type: string | null; version: number }>(
          "SELECT color, logo_type, version FROM organization_branding WHERE organization_id = $1",
          [tenant.organizationId],
        )
      ).rows[0];
      if (!row) return EMPTY;
      return { color: row.color, logo: row.logo_type ? { version: row.version, type: row.logo_type } : null };
    });
  }

  logo(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<{ logo: string | null; logo_type: string | null; version: number }>(
          "SELECT logo, logo_type, version FROM organization_branding WHERE organization_id = $1",
          [tenant.organizationId],
        )
      ).rows[0];
      return row?.logo && row.logo_type ? { bytes: Buffer.from(row.logo, "base64"), type: row.logo_type, version: row.version } : null;
    });
  }

  /** Une ligne par organisation : créée au premier réglage, puis mise à jour (version +1). */
  private write(tenant: TenantContext, values: { logo?: string | null; logoType?: string | null; color?: string | null }) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query(
        `INSERT INTO organization_branding (organization_id, logo, logo_type, color, updated_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id) DO UPDATE SET
           logo = CASE WHEN $6 THEN EXCLUDED.logo ELSE organization_branding.logo END,
           logo_type = CASE WHEN $6 THEN EXCLUDED.logo_type ELSE organization_branding.logo_type END,
           color = CASE WHEN $7 THEN EXCLUDED.color ELSE organization_branding.color END,
           version = organization_branding.version + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [tenant.organizationId, values.logo ?? null, values.logoType ?? null, values.color ?? null, tenant.userId, "logo" in values, "color" in values],
      );
      return (result.rowCount ?? 0) > 0;
    }).catch((error: unknown) => {
      // RLS : un non-administrateur ne peut ni créer ni modifier la ligne.
      if ((error as { code?: string }).code === "42501") return false;
      throw error;
    });
  }

  setLogo(tenant: TenantContext, logo: { bytes: Buffer; type: "image/png" | "image/jpeg" }) {
    return this.write(tenant, { logo: logo.bytes.toString("base64"), logoType: logo.type });
  }

  clearLogo(tenant: TenantContext) {
    return this.write(tenant, { logo: null, logoType: null });
  }

  setColor(tenant: TenantContext, color: string | null) {
    return this.write(tenant, { color });
  }
}

/** Développement et tests. */
export class MemoryBrandingStore implements BrandingStore {
  private readonly rows = new Map<string, { color: string | null; logo: BrandingLogo | null; version: number }>();
  constructor(private readonly isAdmin: (tenant: TenantContext) => boolean = () => true) {}

  private row(tenant: TenantContext) {
    return this.rows.get(tenant.organizationId) ?? { color: null, logo: null, version: 0 };
  }

  async get(tenant: TenantContext) {
    const row = this.row(tenant);
    return { color: row.color, logo: row.logo ? { version: row.logo.version, type: row.logo.type } : null };
  }

  async logo(tenant: TenantContext) {
    return this.row(tenant).logo;
  }

  private save(tenant: TenantContext, change: (row: { color: string | null; logo: BrandingLogo | null; version: number }) => void) {
    if (!this.isAdmin(tenant)) return false;
    const row = { ...this.row(tenant) };
    row.version += 1;
    change(row);
    this.rows.set(tenant.organizationId, row);
    return true;
  }

  async setLogo(tenant: TenantContext, logo: { bytes: Buffer; type: "image/png" | "image/jpeg" }) {
    return this.save(tenant, (row) => (row.logo = { bytes: logo.bytes, type: logo.type, version: row.version }));
  }

  async clearLogo(tenant: TenantContext) {
    return this.save(tenant, (row) => (row.logo = null));
  }

  async setColor(tenant: TenantContext, color: string | null) {
    return this.save(tenant, (row) => (row.color = color));
  }
}
