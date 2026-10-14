import { z } from "zod";

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
  };
}
