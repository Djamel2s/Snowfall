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
  LOCAL_LLM_BASE_URL: z.union([z.url(), z.literal("")]).optional(),
  LOCAL_LLM_API_KEY: z.string().optional(),
  // "fournisseur:modèle" des conversations sans agent, ex. "mistral:mistral-small-latest".
  LLM_DEFAULT_MODEL: z
    .string()
    .regex(/^(mistral|openai|anthropic|local):[\w.:\/-]{1,120}$/)
    .optional()
    .or(z.literal("")),
  // Inclut le raisonnement des modèles qui « réfléchissent » avant de répondre.
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(16_000),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
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
    localBaseUrl: string | undefined;
    localApiKey: string | undefined;
    defaultSelection: ModelSelection | undefined;
    maxOutputTokens: number;
    timeoutMs: number;
  };
};

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
      localBaseUrl: e.LOCAL_LLM_BASE_URL || undefined,
      localApiKey: e.LOCAL_LLM_API_KEY || undefined,
      defaultSelection,
      maxOutputTokens: e.LLM_MAX_OUTPUT_TOKENS,
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
  };
}
