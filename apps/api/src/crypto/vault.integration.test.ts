import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { VaultTransitKeyEncryptionProvider } from "./vault.js";

// OpenBao / Vault réel, préparé par infra/openbao/bootstrap.sh. Le jeton
// d'administration ne sert qu'à régler le rôle de test et à révoquer.
const address = process.env.TEST_VAULT_ADDR;
const admin = process.env.TEST_VAULT_ADMIN_TOKEN;

async function bao(path: string, body?: unknown, token = admin!) {
  const response = await fetch(`${address}/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-vault-token": token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : ((await response.json()) as { data: Record<string, string> });
}

describe("KMS : AppRole sur OpenBao", { skip: !address || !admin }, () => {
  let roleId = "";
  let secretFile = "";

  before(async () => {
    // Rôle de test aux jetons très courts : 2 s, 6 s au maximum.
    await bao("auth/approle/role/snowfall-test", {
      token_policies: "snowfall-api",
      token_ttl: "2s",
      token_max_ttl: "6s",
      secret_id_num_uses: 0,
    });
    roleId = (await bao("auth/approle/role/snowfall-test/role-id"))!.data.role_id!;
    const secretId = (await bao("auth/approle/role/snowfall-test/secret-id", {}))!.data.secret_id!;
    secretFile = join(await mkdtemp(join(tmpdir(), "approle-")), "secret_id");
    await writeFile(secretFile, `${secretId}\n`, { mode: 0o600 });
  });

  const provider = () =>
    new VaultTransitKeyEncryptionProvider({
      address: address!,
      auth: { method: "approle", roleId, secretIdFile: secretFile, mount: "approle" },
      mount: "transit",
      key: "snowfall",
    });

  it("chiffre et déchiffre une clé d'organisation, liée à son contexte", async () => {
    const kms = provider();
    const key = randomBytes(32);
    const wrapped = await kms.wrap(key, "organization-key:org-a:1");
    assert.match(wrapped, /^vault:v\d+:/);
    assert.ok((await kms.unwrap(wrapped, "organization-key:org-a:1")).equals(key));
    await assert.rejects(kms.unwrap(wrapped, "organization-key:org-b:1"), /KMS_DECRYPT_400/);
  });

  it("renouvelle puis remplace le jeton court, et survit à une révocation", async () => {
    const kms = provider();
    const key = randomBytes(32);
    const wrapped = await kms.wrap(key, "ctx");
    // Au-delà du TTL (2 s) puis de la durée maximale (6 s) : toujours fonctionnel.
    for (const wait of [2_500, 4_500]) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      assert.ok((await kms.unwrap(wrapped, "ctx")).equals(key));
    }
    // Révocation de tous les jetons du rôle : reconnexion automatique.
    await bao("auth/token/revoke-orphan", { token: "" }).catch(() => undefined);
    await bao("sys/leases/revoke-prefix/auth/approle/login", {});
    assert.ok((await kms.unwrap(wrapped, "ctx")).equals(key));
  });

  it("la politique n'autorise que chiffrer, déchiffrer et rechiffrer", async () => {
    const login = await fetch(`${address}/v1/auth/approle/login`, {
      method: "POST",
      body: JSON.stringify({ role_id: roleId, secret_id: (await import("node:fs")).readFileSync(secretFile, "utf8").trim() }),
    });
    const token = ((await login.json()) as { auth: { client_token: string } }).auth.client_token;
    for (const path of ["transit/keys/snowfall", "transit/export/encryption-key/snowfall", "sys/policies/acl"]) {
      await assert.rejects(bao(path, undefined, token), /403/, path);
    }
    await assert.rejects(bao("transit/keys/snowfall/rotate", {}, token), /403/);
  });

  it("un secret_id invalide est refusé", async () => {
    const wrong = join(await mkdtemp(join(tmpdir(), "approle-")), "secret_id");
    await writeFile(wrong, "00000000-0000-0000-0000-000000000000");
    const kms = new VaultTransitKeyEncryptionProvider({
      address: address!,
      auth: { method: "approle", roleId, secretIdFile: wrong, mount: "approle" },
      mount: "transit",
      key: "snowfall",
    });
    await assert.rejects(kms.wrap(randomBytes(32), "ctx"), /KMS_LOGIN_400/);
  });
});
