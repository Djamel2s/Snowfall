import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import { LocalKeyEncryptionProvider, type KeyEncryptionProvider } from "./envelope.js";

/** Fournisseur de KEK selon la configuration (KMS_PROVIDER). */
export function createKeyEncryption(kms: AppConfig["kms"], masterKey: Buffer) {
  const local = new LocalKeyEncryptionProvider(masterKey);
  if (kms.provider === "local") return new KeyEncryptionRouter(local, local);
  const vault = new VaultTransitKeyEncryptionProvider(kms);
  return new KeyEncryptionRouter(vault, local, vault);
}

export type VaultAuthSettings =
  | { method: "token"; token: string }
  | {
      method: "approle";
      roleId: string;
      /** Secret fourni directement, ou fichier relu à chaque connexion (rotation sans redémarrage). */
      secretId?: string | undefined;
      secretIdFile?: string | undefined;
      mount: string;
    };

/**
 * Jeton Vault de l'API. AppRole : jeton court (TTL du rôle), renouvelé avant
 * expiration, redemandé s'il est révoqué ou arrivé à sa durée maximale.
 * Jamais écrit sur disque ni journalisé.
 */
export class VaultTokenSource {
  private token: string | null = null;
  private expiresAt = 0;
  private renewable = false;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly address: string,
    private readonly auth: VaultAuthSettings,
    private readonly namespace: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  private headers(token?: string) {
    return {
      "content-type": "application/json",
      ...(token ? { "x-vault-token": token } : {}),
      ...(this.namespace ? { "x-vault-namespace": this.namespace } : {}),
    };
  }

  private remember(auth: { client_token: string; lease_duration: number; renewable: boolean }) {
    this.token = auth.client_token;
    this.renewable = auth.renewable;
    // Marge de 20 % : renouvelé bien avant l'expiration réelle.
    this.expiresAt = Date.now() + Math.max(5, auth.lease_duration) * 1000 * 0.8;
    return this.token;
  }

  private async login(): Promise<string> {
    if (this.auth.method === "token") return this.auth.token;
    const secretId = this.auth.secretIdFile ? (await readFile(this.auth.secretIdFile, "utf8")).trim() : this.auth.secretId;
    if (!secretId) throw new Error("KMS_APPROLE_SECRET_MISSING");
    const response = await fetch(`${this.address}/v1/auth/${this.auth.mount}/login`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ role_id: this.auth.roleId, secret_id: secretId }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`KMS_LOGIN_${response.status}`);
    }
    const { auth } = (await response.json()) as { auth: { client_token: string; lease_duration: number; renewable: boolean } };
    return this.remember(auth);
  }

  private async renew(token: string): Promise<string> {
    const response = await fetch(`${this.address}/v1/auth/token/renew-self`, {
      method: "POST",
      headers: this.headers(token),
      body: "{}",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return this.login();
    }
    const { auth } = (await response.json()) as { auth: { client_token: string; lease_duration: number; renewable: boolean } };
    // Durée maximale atteinte (le TTL accordé ne progresse plus) : nouveau jeton.
    if (auth.lease_duration < 10) return this.login();
    return this.remember(auth);
  }

  /** Jeton valide ; une seule connexion à la fois même sous charge. */
  async get(): Promise<string> {
    if (this.auth.method === "token") return this.auth.token;
    if (this.token && Date.now() < this.expiresAt) return this.token;
    this.pending ??= (this.token && this.renewable ? this.renew(this.token) : this.login()).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Jeton refusé par Vault (révoqué) : le prochain appel se reconnecte. */
  invalidate() {
    this.token = null;
    this.expiresAt = 0;
  }
}

/**
 * KEK dans HashiCorp Vault ou OpenBao (moteur Transit) : la clé maîtresse ne
 * quitte jamais le KMS ; l'API ne voit que les DEK, chiffrées/déchiffrées par
 * appel réseau. Clé Transit attendue : type aes256-gcm96, derived=true (le
 * contexte lie chaque DEK à son organisation et à sa version).
 */
export class VaultTransitKeyEncryptionProvider implements KeyEncryptionProvider {
  private readonly tokens: VaultTokenSource;

  constructor(
    private readonly settings: {
      address: string;
      auth: VaultAuthSettings;
      namespace?: string | undefined;
      mount: string;
      key: string;
      timeoutMs?: number;
    },
  ) {
    this.tokens = new VaultTokenSource(settings.address, settings.auth, settings.namespace, settings.timeoutMs ?? 5_000);
  }

  static isWrapped(value: string) {
    return value.startsWith("vault:v");
  }

  private async call<T>(operation: "encrypt" | "decrypt" | "rewrap", body: Record<string, string>, retry = true): Promise<T> {
    const response = await fetch(
      `${this.settings.address}/v1/${this.settings.mount}/${operation}/${this.settings.key}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vault-token": await this.tokens.get(),
          ...(this.settings.namespace ? { "x-vault-namespace": this.settings.namespace } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.settings.timeoutMs ?? 5_000),
      },
    );
    // Jeton expiré ou révoqué : une reconnexion, puis échec franc.
    if (response.status === 403 && retry && this.settings.auth.method === "approle") {
      await response.body?.cancel();
      this.tokens.invalidate();
      return this.call<T>(operation, body, false);
    }
    if (!response.ok) {
      // Le corps peut contenir des détails internes : jamais propagé.
      await response.body?.cancel();
      throw new Error(`KMS_${operation.toUpperCase()}_${response.status}`);
    }
    return ((await response.json()) as { data: T }).data;
  }

  async wrap(dataKey: Buffer, context: string) {
    const data = await this.call<{ ciphertext: string }>("encrypt", {
      plaintext: dataKey.toString("base64"),
      context: Buffer.from(context, "utf8").toString("base64"),
    });
    return data.ciphertext;
  }

  async unwrap(wrapped: string, context: string) {
    const data = await this.call<{ plaintext: string }>("decrypt", {
      ciphertext: wrapped,
      context: Buffer.from(context, "utf8").toString("base64"),
    });
    const key = Buffer.from(data.plaintext, "base64");
    if (key.length !== 32) throw new Error("KMS_INVALID_KEY");
    return key;
  }

  /** Rotation de la KEK : rechiffre avec la dernière version, sans exposer la DEK. */
  async rewrap(wrapped: string, context: string) {
    const data = await this.call<{ ciphertext: string }>("rewrap", {
      ciphertext: wrapped,
      context: Buffer.from(context, "utf8").toString("base64"),
    });
    return data.ciphertext;
  }
}

/**
 * Chiffre avec le fournisseur actif ; déchiffre selon le format de la valeur
 * stockée. Permet de passer de la KEK locale au KMS sans interruption, puis de
 * tout rechiffrer avec `npm run keys:rotate -- --kek`.
 */
export class KeyEncryptionRouter implements KeyEncryptionProvider {
  constructor(
    private readonly active: KeyEncryptionProvider,
    private readonly local: KeyEncryptionProvider,
    private readonly vault?: VaultTransitKeyEncryptionProvider,
  ) {}

  wrap(dataKey: Buffer, context: string) {
    return this.active.wrap(dataKey, context);
  }

  unwrap(wrapped: string, context: string) {
    if (VaultTransitKeyEncryptionProvider.isWrapped(wrapped)) {
      if (!this.vault) throw new Error("KMS_NOT_CONFIGURED");
      return this.vault.unwrap(wrapped, context);
    }
    return this.local.unwrap(wrapped, context);
  }

  /** Nouvelle enveloppe avec la KEK active (et sa dernière version). */
  async rotate(wrapped: string, context: string) {
    if (this.active === this.vault && VaultTransitKeyEncryptionProvider.isWrapped(wrapped)) {
      return this.vault.rewrap(wrapped, context);
    }
    return this.active.wrap(await this.unwrap(wrapped, context), context);
  }
}
