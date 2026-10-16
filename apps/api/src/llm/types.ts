export const providerIds = ["mistral", "openai", "anthropic", "google", "local"] as const;

export type ProviderId = (typeof providerIds)[number];

export type ModelInfo = { id: string; label: string };

export type ProviderSettings = {
  apiKey: string;
  /** Serveurs compatibles OpenAI (Ollama, vLLM…) : URL fixée par la config, jamais par l'utilisateur. */
  baseUrl?: string | undefined;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Serveur local : le modèle sait appeler des outils (LOCAL_LLM_TOOLS). */
  tools?: boolean;
};

export type ModelSelection = { provider: ProviderId; model: string };
