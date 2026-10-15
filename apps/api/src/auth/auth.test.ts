import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import type { FastifyRequest } from "fastify";
import type { AuditEvent } from "../audit/audit.js";
import {
  createSessionAuthenticator,
  selectMembership,
  type Membership,
} from "./auth.js";
import { LoginTransactionCodec } from "./oidc.js";
import type { SessionResolution, SessionStore } from "./session-store.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function fakeRequest(headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  return {
    headers,
    cookies,
    log: { error: () => undefined },
  } as unknown as FastifyRequest;
}

function authenticator(options: {
  resolution?: SessionResolution | Error;
  memberships?: Membership[];
}) {
  const events: AuditEvent[] = [];
  const sessions: SessionStore = {
    create: async () => "",
    resolve: async () => {
      if (options.resolution instanceof Error) throw options.resolution;
      return options.resolution ?? {
        status: "valid",
        session: { userId: "user-1", subject: "sub", profile: { name: "Alice" } },
      };
    },
    revoke: async () => null,
    revokeIdpSession: async () => [],
    purgeExpired: async () => 0,
  };

  const authenticate = createSessionAuthenticator({
    cookieName: "snowfall_session",
    sessions,
    directory: {
      findUserId: async () => null,
      memberships: async () => options.memberships ?? [{ organizationId: ORG_A, role: "member" }],
    },
    audit: { record: async (_request, event) => { events.push(event); } },
  });

  return { authenticate, events };
}

describe("selectMembership", () => {
  const both: Membership[] = [
    { organizationId: ORG_A, role: "owner" },
    { organizationId: ORG_B, role: "reader" },
  ];

  it("résout l'unique organisation sans en-tête", () => {
    assert.deepEqual(selectMembership([both[0]!], undefined), {
      organizationId: ORG_A,
      role: "owner",
    });
  });

  it("ne choisit jamais implicitement entre plusieurs organisations", () => {
    assert.equal(selectMembership(both, undefined), null);
    assert.equal(selectMembership(both, ""), null);
  });

  it("accepte une organisation demandée dont l'utilisateur est membre", () => {
    assert.deepEqual(selectMembership(both, ORG_B), { organizationId: ORG_B, role: "reader" });
  });

  it("refuse une organisation demandée dont l'utilisateur n'est pas membre", () => {
    assert.equal(selectMembership([both[0]!], ORG_B), null);
  });

  it("refuse un en-tête multiple (tableau)", () => {
    assert.equal(selectMembership(both, [ORG_A, ORG_B]), null);
  });

  it("refuse un rôle inconnu en base", () => {
    assert.equal(selectMembership([{ organizationId: ORG_A, role: "superadmin" }], ORG_A), null);
  });
});

describe("createSessionAuthenticator", () => {
  it("authentifie une session valide avec son profil", async () => {
    const { authenticate } = authenticator({});
    assert.deepEqual(await authenticate(fakeRequest()), {
      userId: "user-1",
      organizationId: ORG_A,
      role: "member",
      profile: { name: "Alice" },
    });
  });

  it("refuse l'absence de session", async () => {
    const { authenticate, events } = authenticator({ resolution: { status: "missing" } });
    assert.equal(await authenticate(fakeRequest()), null);
    assert.equal(events.length, 0);
  });

  it("refuse et trace une session révoquée côté IdP", async () => {
    const { authenticate, events } = authenticator({
      resolution: { status: "ended", userId: "user-1", reason: "revoked" },
    });
    assert.equal(await authenticate(fakeRequest()), null);
    assert.equal(events[0]?.eventType, "auth.session_ended");
    assert.equal(events[0]?.outcome, "denied");
  });

  it("refuse (fail closed) si la validation de session échoue", async () => {
    const { authenticate } = authenticator({ resolution: new Error("IdP indisponible") });
    assert.equal(await authenticate(fakeRequest()), null);
  });

  it("refuse et trace une organisation usurpée via x-organization-id", async () => {
    const { authenticate, events } = authenticator({});
    assert.equal(await authenticate(fakeRequest({ "x-organization-id": ORG_B })), null);
    assert.equal(events[0]?.eventType, "auth.organization_access");
    assert.equal(events[0]?.outcome, "denied");
  });

  it("refuse un utilisateur sans appartenance", async () => {
    const { authenticate } = authenticator({ memberships: [] });
    assert.equal(await authenticate(fakeRequest()), null);
  });
});

describe("LoginTransactionCodec", () => {
  const codec = new LoginTransactionCodec(randomBytes(32));
  const transaction = { state: "s", nonce: "n", codeVerifier: "v", createdAt: Date.now() };

  it("relit une transaction valide", () => {
    assert.deepEqual(codec.decode(codec.encode(transaction)), transaction);
  });

  it("refuse une transaction modifiée", () => {
    const [version, iv, payload] = codec.encode(transaction).split(".");
    const bytes = Buffer.from(payload!, "base64url");
    bytes[0] = bytes[0]! ^ 0x01;
    assert.equal(codec.decode([version, iv, bytes.toString("base64url")].join(".")), null);
  });

  it("refuse une transaction expirée", () => {
    const encoded = codec.encode({ ...transaction, createdAt: Date.now() - 11 * 60 * 1000 });
    assert.equal(codec.decode(encoded), null);
  });

  it("refuse une transaction chiffrée avec une autre clé", () => {
    const other = new LoginTransactionCodec(randomBytes(32));
    assert.equal(codec.decode(other.encode(transaction)), null);
  });
});
