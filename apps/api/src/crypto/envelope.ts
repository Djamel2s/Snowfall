import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

// Format : "v1.<iv base64url>.<ciphertext+tag base64url>" — AES-256-GCM.
// L'AAD lie le chiffré à son contexte (tenant, ligne, colonne) : un chiffré
// déplacé vers une autre ligne ou un autre tenant ne se déchiffre pas.
const FORMAT_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class DecryptionError extends Error {
  constructor() {
    super("DECRYPTION_FAILED");
  }
}

export function parseMasterKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error(
      "SNOWFALL_MASTER_KEY doit contenir 32 octets encodés en base64 (voir .env.example pour la commande de génération).",
    );
  }

  return key;
}

export function deriveKey(masterKey: Buffer, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.alloc(0), `snowfall/${purpose}`, 32),
  );
}

export function seal(key: Buffer, plaintext: Buffer | string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString("base64url"),
    Buffer.concat([ciphertext, tag]).toString("base64url"),
  ].join(".");
}

export function open(key: Buffer, sealed: string, aad: string): Buffer {
  const [version, ivPart, payloadPart, ...rest] = sealed.split(".");

  if (version !== FORMAT_VERSION || !ivPart || !payloadPart || rest.length > 0) {
    throw new DecryptionError();
  }

  const iv = Buffer.from(ivPart, "base64url");
  const payload = Buffer.from(payloadPart, "base64url");

  if (iv.length !== IV_BYTES || payload.length < TAG_BYTES) {
    throw new DecryptionError();
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(payload.subarray(0, payload.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new DecryptionError();
  }
}

/**
 * Chiffre/déchiffre les clés de données (DEK) des organisations.
 * L'implémentation locale dérive une KEK de SNOWFALL_MASTER_KEY ; en production
 * elle doit être remplacée par un KMS/HSM (Vault Transit, KMS cloud, etc.)
 * pour que la KEK ne quitte jamais le module matériel.
 */
export interface KeyEncryptionProvider {
  wrap(dataKey: Buffer, context: string): Promise<string>;
  unwrap(wrapped: string, context: string): Promise<Buffer>;
}

export class LocalKeyEncryptionProvider implements KeyEncryptionProvider {
  private readonly kek: Buffer;

  constructor(masterKey: Buffer) {
    this.kek = deriveKey(masterKey, "kek/v1");
  }

  async wrap(dataKey: Buffer, context: string) {
    return seal(this.kek, dataKey, context);
  }

  async unwrap(wrapped: string, context: string) {
    return open(this.kek, wrapped, context);
  }
}
