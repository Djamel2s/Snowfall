import { z } from "zod";
import type { ModelSelection, ProviderId } from "./llm/types.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_ORIGIN: z.url().default("http://localhost:5173"),
  OIDC_ISSUER: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(32),
  SNOWFALL_MASTER_KEY: z.string().min(1),
  TRUST_PROXY: z.string().optional(),
  REDIS_URL: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_MODEL: z.string().min(1).default("mistral-small-latest"),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  LOCAL_LLM_BASE_URL: z.union([z.url(), z.literal("")]).optional(),
  LOCAL_LLM_API_KEY: z.string().optional(),
  // "fournisseur:modèle" des conversations sans agent, ex. "mistral:mistral-small-latest".
  LLM_DEFAULT_MODEL: z
    .string()
    .regex(/^(mistral|openai|anthropic|google|local):[\w.:\/-]{1,120}$/)
    .optional()
    .or(z.literal("")),
  // Inclut le raisonnement des modèles qui « réfléchissent » avant de répondre.
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(16_000),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  // Scopes OIDC en plus de "openid profile email" ; "organization" active le
  // SSO par organisation (le scope doit être assigné au client dans Keycloak).
  OIDC_EXTRA_SCOPES: z.string().regex(/^[a-z_:-]*( [a-z_:-]+)*$/).default(""),
  // Chiffrement des clés d'organisation : "local" (KEK dérivée de
  // SNOWFALL_MASTER_KEY) ou "vault" (HashiCorp Vault / OpenBao Transit).
  KMS_PROVIDER: z.enum(["local", "vault"]).default("local"),
  VAULT_ADDR: z.url().optional(),
  VAULT_TOKEN: z.string().optional(),
  VAULT_NAMESPACE: z.string().optional(),
  VAULT_TRANSIT_MOUNT: z.string().regex(/^[\w-]+$/).default("transit"),
  VAULT_TRANSIT_KEY: z.string().regex(/^[\w-]+$/).default("snowfall"),
  // Copie des événements d'audit vers un SIEM (en plus de la base).
  AUDIT_STDOUT: z.enum(["true", "false"]).default("true"),
  SIEM_WEBHOOK_URL: z.union([z.url(), z.literal("")]).optional(),
  SIEM_WEBHOOK_TOKEN: z.string().optional(),
  SIEM_FORMAT: z.enum(["json", "splunk-hec"]).default("json"),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  appOrigin: string;
  oidc: { issuer: string; clientId: string; clientSecret: string };
  masterKey: string;
  trustProxy: boolean | string;
  redisUrl: string | undefined;
  cookieSecure: boolean;
  llm: {
    mistralApiKey: string | undefined;
    openaiApiKey: string | undefined;
    anthropicApiKey: string | undefined;
    googleApiKey: string | undefined;
    localBaseUrl: string | undefined;
    localApiKey: string | undefined;
    defaultSelection: ModelSelection | undefined;
    maxOutputTokens: number;
    timeoutMs: number;
  };
  oidcExtraScopes: string[];
  kms:
    | { provider: "local" }
    | { provider: "vault"; address: string; token: string; namespace: string | undefined; mount: string; key: string };
  audit: {
    stdout: boolean;
    siem: { url: string; token: string | undefined; format: "json" | "splunk-hec" } | undefined;
  };
};

/**
 * Réglages KMS seuls (scripts d'exploitation : rotation des clés), sans
 * exiger le reste de la configuration de l'API.
 */
export function loadKmsConfig(env: NodeJS.ProcessEnv = process.env): { masterKey: string; kms: AppConfig["kms"] } {
  const parsed = envSchema
    .pick({
      NODE_ENV: true,
      SNOWFALL_MASTER_KEY: true,
      KMS_PROVIDER: true,
      VAULT_ADDR: true,
      VAULT_TOKEN: true,
      VAULT_NAMESPACE: true,
      VAULT_TRANSIT_MOUNT: true,
      VAULT_TRANSIT_KEY: true,
    })
    .safeParse(env);
  if (!parsed.success) {
    throw new Error(`Configuration KMS invalide : ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  const e = parsed.data;
  if (e.KMS_PROVIDER === "vault" && (!e.VAULT_ADDR || !e.VAULT_TOKEN)) {
    throw new Error("KMS_PROVIDER=vault exige VAULT_ADDR et VAULT_TOKEN.");
  }
  return {
    masterKey: e.SNOWFALL_MASTER_KEY,
    kms:
      e.KMS_PROVIDER === "vault"
        ? {
            provider: "vault",
            address: e.VAULT_ADDR!.replace(/\/$/, ""),
            token: e.VAULT_TOKEN!,
            namespace: e.VAULT_NAMESPACE || undefined,
            mount: e.VAULT_TRANSIT_MOUNT,
            key: e.VAULT_TRANSIT_KEY,
          }
        : { provider: "local" },
  };
}

// Liste explicite d'IP/CIDR des reverse proxies (ex. "10.0.0.5,10.0.1.0/24").
// "true" fait confiance à tout X-Forwarded-For : à éviter hors réseau maîtrisé.
function parseTrustProxy(value: string | undefined): boolean | string {
  if (!value || value === "false") return false;
  if (value === "true") return true;
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Configuration invalide ou incomplète : ${fields}`);
  }

  const e = parsed.data;
  const appOrigin = new URL(e.APP_ORIGIN).origin;
  const production = e.NODE_ENV === "production";

  if (production && !appOrigin.startsWith("https://")) {
    throw new Error("APP_ORIGIN doit être en HTTPS en production.");
  }
  // Sans modèle par défaut explicite : Mistral si sa clé est fournie.
  const defaultSelection: ModelSelection | undefined = e.LLM_DEFAULT_MODEL
    ? {
        provider: e.LLM_DEFAULT_MODEL.split(":")[0] as ProviderId,
        model: e.LLM_DEFAULT_MODEL.slice(e.LLM_DEFAULT_MODEL.indexOf(":") + 1),
      }
    : e.MISTRAL_API_KEY
      ? { provider: "mistral", model: e.MISTRAL_MODEL }
      : undefined;

  if (production && !defaultSelection) {
    throw new Error(
      "LLM_DEFAULT_MODEL (ou MISTRAL_API_KEY) est obligatoire en production : le modèle echo est réservé au développement.",
    );
  }
  if (production && !e.OIDC_ISSUER.startsWith("https://")) {
    throw new Error("OIDC_ISSUER doit être en HTTPS en production.");
  }
  if (e.KMS_PROVIDER === "vault" && (!e.VAULT_ADDR || !e.VAULT_TOKEN)) {
    throw new Error("KMS_PROVIDER=vault exige VAULT_ADDR et VAULT_TOKEN.");
  }
  if (production && e.KMS_PROVIDER === "vault" && !e.VAULT_ADDR!.startsWith("https://")) {
    throw new Error("VAULT_ADDR doit être en HTTPS en production.");
  }
  if (production && e.SIEM_WEBHOOK_URL && !e.SIEM_WEBHOOK_URL.startsWith("https://")) {
    throw new Error("SIEM_WEBHOOK_URL doit être en HTTPS en production.");
  }

  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    appOrigin,
    oidc: {
      issuer: e.OIDC_ISSUER.replace(/\/$/, ""),
      clientId: e.OIDC_CLIENT_ID,
      clientSecret: e.OIDC_CLIENT_SECRET,
    },
    masterKey: e.SNOWFALL_MASTER_KEY,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    redisUrl: e.REDIS_URL || undefined,
    cookieSecure: appOrigin.startsWith("https://"),
    llm: {
      mistralApiKey: e.MISTRAL_API_KEY || undefined,
      openaiApiKey: e.OPENAI_API_KEY || undefined,
      anthropicApiKey: e.ANTHROPIC_API_KEY || undefined,
      googleApiKey: e.GOOGLE_API_KEY || undefined,
      localBaseUrl: e.LOCAL_LLM_BASE_URL || undefined,
      localApiKey: e.LOCAL_LLM_API_KEY || undefined,
      defaultSelection,
      maxOutputTokens: e.LLM_MAX_OUTPUT_TOKENS,
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
    oidcExtraScopes: e.OIDC_EXTRA_SCOPES.split(" ").filter(Boolean),
    kms: loadKmsConfig(env).kms,
    audit: {
      stdout: e.AUDIT_STDOUT === "true",
      siem: e.SIEM_WEBHOOK_URL
        ? { url: e.SIEM_WEBHOOK_URL, token: e.SIEM_WEBHOOK_TOKEN || undefined, format: e.SIEM_FORMAT }
        : undefined,
    },
  };
}
