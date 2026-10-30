import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditEvent } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore } from "../testing/fakes.js";
import type { MemberStore } from "../workspace/members.js";
import { inspectLogo, LOGO_MAX_BYTES } from "./image.js";
import { MemoryBrandingStore } from "./store.js";

const ORIGIN = "http://localhost:5173";
const ORG = "11111111-1111-4111-8111-111111111111";
const admin: AuthenticatedUser = { userId: "33333333-3333-4333-8333-333333333333", organizationId: ORG, role: "admin" };
const member: AuthenticatedUser = { ...admin, userId: "22222222-2222-4222-8222-222222222222", role: "member" };

/** En-tête PNG minimal (signature + IHDR) aux dimensions données. */
export function pngOf(width: number, height: number, extra = 64) {
  const header = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/** JPEG minimal : SOI, APP0, SOF0 (hauteur, largeur). */
function jpegOf(width: number, height: number) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(32)]);
}

function setup(user: AuthenticatedUser, store = new MemoryBrandingStore((tenant) => tenant.userId === admin.userId), scanner?: { scan: (bytes: Buffer) => Promise<{ clean: true } | { clean: false; signature: string }> }) {
  const events: AuditEvent[] = [];
  const members = { organization: async () => ({ id: ORG, name: "Polaris", sso: { alias: null, defaultRole: "member" } }) } as unknown as MemberStore;
  const app = createAppServer({
    appOrigin: ORIGIN,
    logger: false,
    conversationStore: createFakeConversationStore(),
    authenticate: async () => user,
    audit: { record: async (_request, event) => void events.push(event) },
    runChat: async () => ({ content: "ok", model: "fake" }),
    members,
    branding: store,
    ...(scanner ? { scanner } : {}),
  });
  const upload = (bytes: Buffer) => app.inject({ method: "PUT", url: "/branding/logo", headers: { origin: ORIGIN, "content-type": "application/octet-stream" }, payload: bytes });
  return { app, events, store, upload };
}

describe("Identité de l'organisation : logo et couleur", () => {
  it("image reconnue par son contenu : PNG et JPEG oui ; SVG, HTML déguisé, trop grand, trop lourd : non", () => {
    assert.deepEqual(inspectLogo(pngOf(512, 512)), { type: "image/png", width: 512, height: 512 });
    assert.deepEqual(inspectLogo(jpegOf(300, 200)), { type: "image/jpeg", width: 300, height: 200 });
    assert.equal(inspectLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), "unsupported");
    assert.equal(inspectLogo(Buffer.from("<html><script>alert(1)</script></html>")), "unsupported");
    assert.equal(inspectLogo(pngOf(4096, 4096)), "dimensions");
    assert.equal(inspectLogo(pngOf(8, 8)), "dimensions");
    assert.equal(inspectLogo(pngOf(512, 512, LOGO_MAX_BYTES)), "too_large");
  });

  it("administrateur : importe, le logo est servi en image (sans interprétation), puis supprimé ; tout est journalisé", async () => {
    const { app, events, upload } = setup(admin);
    assert.deepEqual((await app.inject({ method: "GET", url: "/branding" })).json(), { name: "Polaris", color: null, logo: null });
    assert.equal((await app.inject({ method: "GET", url: "/branding/logo" })).statusCode, 404);

    const logo = pngOf(512, 512);
    const saved = await upload(logo);
    assert.equal(saved.statusCode, 200);
    const branding = (await app.inject({ method: "GET", url: "/branding" })).json() as { logo: { version: number } };
    assert.ok(branding.logo.version > 0);
    const served = await app.inject({ method: "GET", url: `/branding/logo?v=${branding.logo.version}` });
    assert.equal(served.headers["content-type"], "image/png");
    assert.equal(served.headers["x-content-type-options"], "nosniff");
    assert.match(String(served.headers["content-security-policy"]), /default-src 'none'; sandbox/);
    assert.deepEqual(served.rawPayload, logo);

    assert.equal((await app.inject({ method: "DELETE", url: "/branding/logo", headers: { origin: ORIGIN } })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/branding/logo" })).statusCode, 404);
    assert.deepEqual(events.map((event) => event.eventType), ["branding.logo_update", "branding.logo_delete"]);
  });

  it("refus : SVG, HTML déguisé en PNG, trop lourd ; fichier signalé par l'antivirus", async () => {
    const { upload, store } = setup(admin, undefined, { scan: async (bytes) => (bytes.includes("EICAR") ? { clean: false, signature: "Eicar" } : { clean: true }) });
    assert.equal((await upload(Buffer.from("<svg onload=alert(1)>"))).statusCode, 415);
    assert.equal((await upload(Buffer.concat([Buffer.from("<html>"), pngOf(64, 64)]))).statusCode, 415);
    assert.equal((await upload(Buffer.alloc(LOGO_MAX_BYTES + 512, 1))).statusCode, 413);
    assert.equal((await upload(Buffer.concat([pngOf(64, 64), Buffer.from("EICAR")]))).statusCode, 422);
    assert.equal((await store.get(admin)).logo, null);
  });

  it("membre : voit le logo, ne le change pas (refus journalisé) ; couleur validée", async () => {
    const shared = new MemoryBrandingStore((tenant) => tenant.userId === admin.userId);
    const asAdmin = setup(admin, shared);
    assert.equal((await asAdmin.app.inject({ method: "PUT", url: "/branding/color", headers: { origin: ORIGIN }, payload: { color: "#E5484D" } })).json().color, "#e5484d");
    assert.equal((await asAdmin.app.inject({ method: "PUT", url: "/branding/color", headers: { origin: ORIGIN }, payload: { color: "red; background:url(x)" } })).statusCode, 400);

    const { app, events, upload } = setup(member, shared);
    assert.equal(((await app.inject({ method: "GET", url: "/branding" })).json() as { color: string }).color, "#e5484d");
    assert.equal((await upload(pngOf(64, 64))).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: "/branding/logo", headers: { origin: ORIGIN } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: "/branding/color", headers: { origin: ORIGIN }, payload: { color: null } })).statusCode, 403);
    assert.deepEqual(events.map((event) => [event.eventType, event.outcome]), [["branding.logo_update", "denied"], ["branding.logo_delete", "denied"], ["branding.color_update", "denied"]]);
  });
});
