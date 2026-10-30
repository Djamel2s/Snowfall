import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { withTenant } from "../db/tenant.js";
import { PostgresBrandingStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

const png = () => {
  const bytes = Buffer.alloc(96);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  return bytes;
};

describe("Identité : PostgreSQL (membres en lecture, administrateurs en écriture, isolation)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let store: PostgresBrandingStore;
  const [org, other] = [randomUUID(), randomUUID()];
  const [admin, member, outsider] = [randomUUID(), randomUUID(), randomUUID()];
  const as = (userId: string, organizationId = org) => ({ userId, organizationId });

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    store = new PostgresBrandingStore(pool);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    await owner.query("INSERT INTO users (id, email) SELECT id, id || '@t.local' FROM unnest($1::uuid[]) AS id", [[admin, member, outsider]]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'admin'), ($1, $4, 'member'), ($2, $5, 'admin')", [org, other, admin, member, outsider]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[admin, member, outsider]]);
    await pool.end();
    await owner.end();
  });

  it("administrateur : logo et couleur ; membre : lecture seule ; autre organisation : rien", async () => {
    assert.equal(await store.setLogo(as(admin), { bytes: png(), type: "image/png" }), true);
    assert.equal(await store.setColor(as(admin), "#e5484d"), true);
    const branding = await store.get(as(member));
    assert.equal(branding.color, "#e5484d");
    assert.equal(branding.logo?.type, "image/png");
    assert.deepEqual((await store.logo(as(member)))?.bytes, png());

    // Membre : refusé par la base (RLS), même sans passer par la route.
    assert.equal(await store.setColor(as(member), "#000000"), false);
    assert.equal(await store.clearLogo(as(member)), false);
    assert.equal((await store.get(as(admin))).color, "#e5484d");
    // Autre organisation : ne voit ni ne modifie rien ; administrateur d'ailleurs prétendant être ici : refusé.
    assert.deepEqual(await store.get(as(outsider, other)), { color: null, logo: null });
    assert.equal(await store.setColor(as(outsider, org), "#000000"), false);
    assert.equal((await store.get(as(admin))).color, "#e5484d");

    // La base refuse elle-même un contenu qui n'est pas PNG/JPEG, et une couleur hors format.
    await assert.rejects(
      withTenant(pool, as(admin), (client) => client.query("UPDATE organization_branding SET logo = $1, logo_type = 'image/png', updated_by = $2 WHERE organization_id = $3", [Buffer.from("<svg onload=alert(1)>").toString("base64"), admin, org])),
      /organization_branding_logo_magic_check/,
    );
    await assert.rejects(
      withTenant(pool, as(admin), (client) => client.query("UPDATE organization_branding SET color = 'red', updated_by = $1 WHERE organization_id = $2", [admin, org])),
      /organization_branding_color_check/,
    );
    // Supprimé : retour au logo de Snowfall.
    assert.equal(await store.clearLogo(as(admin)), true);
    assert.equal(await store.logo(as(member)), null);
  });
});
