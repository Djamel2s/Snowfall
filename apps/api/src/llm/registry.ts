import { createChatRunner, type ChatModel, type ChatRunner } from "../graph/chat-graph.js";
import { createAnthropicModel, listAnthropicModels } from "./anthropic.js";
import { createGoogleModel, listGoogleModels } from "./google.js";
import { createMistralModel, listMistralModels } from "./mistral.js";
import { createOpenAiCompatibleModel, listOpenAiCompatibleModels } from "./openai.js";
import {
  providerIds,
  type ModelInfo,
  type ModelSelection,
  type ProviderId,
  type ProviderSettings,
} from "./types.js";

export type ProviderCatalog = {
  id: ProviderId;
  available: boolean;
  models: ModelInfo[];
}[];

export class ProviderUnavailableError extends Error {
  constructor() {
    super("PROVIDER_UNAVAILABLE");
  }
}

export interface ModelRegistry {
  catalog(): Promise<ProviderCatalog>;
  /** Liste blanche : seul un modèle publié par un fournisseur configuré est accepté. */
  isAllowed(selection: ModelSelection): Promise<boolean>;
  /** Sans sélection : modèle par défaut de la plateforme. */
  runner(selection?: ModelSelection): ChatRunner;
  /** Fournisseur qui servira la sélection ("echo" : modèle local de développement). */
  providerFor(selection?: ModelSelection): ProviderId | "echo";
}

const CATALOG_TTL_MS = 10 * 60 * 1000;

type ProviderAdapter = {
  create(model: string): ChatModel;
  list(): Promise<ModelInfo[]>;
};

export class ProviderRegistry implements ModelRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();
  private readonly runners = new Map<string, ChatRunner>();
  private readonly cache = new Map<ProviderId, { at: number; models: ModelInfo[] }>();

  constructor(
    providers: Partial<Record<ProviderId, ProviderSettings>>,
    private readonly options: {
      /** Modèle des conversations sans agent. */
      defaultSelection?: ModelSelection | undefined;
      /** Repli de développement quand aucun modèle par défaut n'est configuré. */
      fallback?: ChatModel | undefined;
    } = {},
  ) {
    for (const id of providerIds) {
      const settings = providers[id];
      if (!settings) continue;

      this.adapters.set(id, adapterFor(id, settings));
    }
  }

  private async models(id: ProviderId): Promise<ModelInfo[] | null> {
    const adapter = this.adapters.get(id);
    if (!adapter) return null;

    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;

    try {
      const models = await adapter.list();
      this.cache.set(id, { at: Date.now(), models });
      return models;
    } catch {
      // Fournisseur injoignable ou clé refusée : on garde l'ancienne liste
      // si elle existe, sinon le fournisseur apparaît indisponible.
      return cached?.models ?? null;
    }
  }

  async catalog(): Promise<ProviderCatalog> {
    return Promise.all(
      providerIds.map(async (id) => {
        const models = await this.models(id);
        return { id, available: models !== null && models.length > 0, models: models ?? [] };
      }),
    );
  }

  async isAllowed({ provider, model }: ModelSelection) {
    const models = await this.models(provider);
    return models?.some((item) => item.id === model) ?? false;
  }

  providerFor(selection?: ModelSelection): ProviderId | "echo" {
    return (selection ?? this.options.defaultSelection)?.provider ?? "echo";
  }

  runner(selection?: ModelSelection): ChatRunner {
    const target = selection ?? this.options.defaultSelection;
    const key = target ? `${target.provider}:${target.model}` : "fallback";
    const cached = this.runners.get(key);
    if (cached) return cached;

    let model = this.options.fallback;
    if (target) {
      const adapter = this.adapters.get(target.provider);
      model = adapter?.create(target.model);
    }

    if (!model) {
      return async () => {
        throw new ProviderUnavailableError();
      };
    }

    const runner = createChatRunner(model);
    this.runners.set(key, runner);
    return runner;
  }
}

function adapterFor(id: ProviderId, settings: ProviderSettings): ProviderAdapter {
  switch (id) {
    case "mistral":
      return {
        create: (model) => createMistralModel(model, settings),
        list: () => listMistralModels(settings),
      };
    case "anthropic":
      return {
        create: (model) => createAnthropicModel(model, settings),
        list: () => listAnthropicModels(settings),
      };
    case "google":
      return {
        create: (model) => createGoogleModel(model, settings),
        list: () => listGoogleModels(settings),
      };
    case "openai":
    case "local":
      return {
        create: (model) => createOpenAiCompatibleModel(id, model, settings),
        list: () => listOpenAiCompatibleModels(id, settings),
      };
  }
}
