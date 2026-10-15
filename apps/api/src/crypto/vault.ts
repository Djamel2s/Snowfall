import type { AppConfig } from "../config.js";
import { LocalKeyEncryptionProvider, type KeyEncryptionProvider } from "./envelope.js";

/** Fournisseur de KEK selon la configuration (KMS_PROVIDER). */
export function createKeyEncryption(kms: AppConfig["kms"], masterKey: Buffer) {
  const local = new LocalKeyEncryptionProvider(masterKey);
  if (kms.provider === "local") return new KeyEncryptionRouter(local, local);
  const vault = new VaultTransitKeyEncryptionProvider(kms);
  return new KeyEncryptionRouter(vault, local, vault);
}

/**
 * KEK dans HashiCorp Vault ou OpenBao (moteur Transit) : la clé maîtresse ne
 * quitte jamais le KMS ; l'API ne voit que les DEK, chiffrées/déchiffrées par
 * appel réseau. Clé Transit attendue : type aes256-gcm96, derived=true (le
 * contexte lie chaque DEK à son organisation et à sa version).
 */
export class VaultTransitKeyEncryptionProvider implements KeyEncryptionProvider {
  constructor(
    private readonly settings: {
      address: string;
      token: string;
      namespace?: string | undefined;
      mount: string;
      key: string;
      timeoutMs?: number;
    },
  ) {}

  static isWrapped(value: string) {
    return value.startsWith("vault:v");
  }

  private async call<T>(operation: "encrypt" | "decrypt" | "rewrap", body: Record<string, string>): Promise<T> {
    const response = await fetch(
      `${this.settings.address}/v1/${this.settings.mount}/${operation}/${this.settings.key}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vault-token": this.settings.token,
          ...(this.settings.namespace ? { "x-vault-namespace": this.settings.namespace } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.settings.timeoutMs ?? 5_000),
      },
    );
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
