import { createHash } from "node:crypto";
import { createChatRunner, ProviderUnavailableError, type ChatModel, type ChatRunner } from "../graph/chat-graph.js";
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

// Définie avec le graphe (les adaptateurs la lèvent aussi), réexportée ici pour les appelants.
export { ProviderUnavailableError };

export interface ModelRegistry {
  catalog(): Promise<ProviderCatalog>;
  /** Liste blanche : seul un modèle publié par un fournisseur configuré est accepté. */
  isAllowed(selection: ModelSelection): Promise<boolean>;
  /** Sans sélection : modèle par défaut de la plateforme. */
  runner(selection?: ModelSelection): ChatRunner;
  /** Fournisseur qui servira la sélection ("echo" : modèle local de développement). */
  providerFor(selection?: ModelSelection): ProviderId | "echo";
  /** Modèle des conversations sans agent ni modèle choisi. */
  defaultSelection?(): ModelSelection | undefined;
  /** Le modèle sait appeler des outils (boucle d'agent). */
  supportsTools?(selection?: ModelSelection): boolean;
  /** Origine de la clé qui sert ce fournisseur (vue d'une personne) ; absent : la plateforme. */
  keySource?(provider: ProviderId | "echo"): KeySource;
}

/** Registre vu par une personne (ou celui de la plateforme). */
export type ScopedModels = ModelRegistry;

export const isScopable = (registry: ModelRegistry): registry is ScopableRegistry => typeof (registry as Partial<ScopableRegistry>).withKeys === "function";

const CATALOG_TTL_MS = 10 * 60 * 1000;
/** Entrées gardées en mémoire par cache (une par clé et modèle) : bornées, les plus anciennes sortent. */
const CACHE_MAX = 500;

export type ProviderAdapter = {
  create(model: string): ChatModel;
  list(): Promise<ModelInfo[]>;
};

/** D'où vient la clé qui sert un fournisseur. */
export type KeySource = "platform" | "organization" | "personal";
/** Clés d'une personne (sa clé, sinon celle de son organisation), par fournisseur. */
export type ScopedKeys = Partial<Record<ProviderId, { apiKey: string; source: "organization" | "personal" }>>;

export interface ScopableRegistry extends ModelRegistry {
  /** Vue d'une personne : ses clés remplacent celles de la plateforme pour ces fournisseurs. */
  withKeys(keys: ScopedKeys): ScopedModels;
  /** Vérifie une clé auprès du fournisseur (liste ses modèles) ; lève si elle est refusée. */
  checkKey(provider: ProviderId, apiKey: string): Promise<number>;
  /** Fournisseurs configurés par la plateforme. */
  platformProviders(): ProviderId[];
}

/** Empreinte d'une clé : sépare les caches (jamais la clé elle-même en mémoire de cache ni en journal). */
const fingerprint = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex").slice(0, 32);

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_MAX) map.delete(map.keys().next().value!);
  return value;
}

/** Caches partagés par toutes les vues, rangés par fournisseur ET empreinte de clé : une clé ne sert qu'à elle-même. */
class RegistryCore {
  readonly adapters = new Map<string, ProviderAdapter>();
  readonly catalogs = new Map<string, { at: number; models: ModelInfo[] }>();
  readonly chatModels = new Map<string, ChatModel | undefined>();
  readonly runners = new Map<string, ChatRunner>();
}

type RegistryOptions = {
  /** Modèle des conversations sans agent. */
  defaultSelection?: ModelSelection | undefined;
  /** Repli de développement quand aucun modèle par défaut n'est configuré. */
  fallback?: ChatModel | undefined;
  /** Réglages d'un fournisseur servi par une clé de l'organisation ou personnelle (plafonds, délai, réflexion). */
  defaults?: Omit<ProviderSettings, "apiKey" | "baseUrl" | "tools"> | undefined;
  /** Tests : fabrique d'adaptateurs (sans réseau). */
  adapter?: ((id: ProviderId, settings: ProviderSettings) => ProviderAdapter) | undefined;
};

class RegistryView implements ModelRegistry {
  constructor(
    protected readonly core: RegistryCore,
    protected readonly platform: Partial<Record<ProviderId, ProviderSettings>>,
    protected readonly options: RegistryOptions,
    private readonly keys: ScopedKeys = {},
  ) {}

  /** Clé qui sert ce fournisseur dans cette vue : la sienne, sinon celle de la plateforme. */
  private entry(id: ProviderId): { key: string; settings: ProviderSettings; source: KeySource } | null {
    const own = id === "local" ? undefined : this.keys[id];
    if (own) {
      const base = this.platform[id] ?? { maxOutputTokens: 4096, timeoutMs: 60_000, ...this.options.defaults };
      // Adresse officielle du fournisseur : jamais celle d'un serveur configuré pour la plateforme.
      const settings: ProviderSettings = { ...base, apiKey: own.apiKey };
      delete settings.baseUrl;
      return { key: `${id}:${fingerprint(own.apiKey)}`, settings, source: own.source };
    }
    const settings = this.platform[id];
    return settings ? { key: `${id}:platform`, settings, source: "platform" } : null;
  }

  private adapter(id: ProviderId) {
    const entry = this.entry(id);
    if (!entry) return null;
    const adapter = this.core.adapters.get(entry.key) ?? remember(this.core.adapters, entry.key, (this.options.adapter ?? adapterFor)(id, entry.settings));
    return { key: entry.key, adapter };
  }

  keySource(provider: ProviderId | "echo"): KeySource {
    return provider === "echo" ? "platform" : (this.entry(provider)?.source ?? "platform");
  }

  async listModels(id: ProviderId): Promise<ModelInfo[] | null> {
    const found = this.adapter(id);
    if (!found) return null;

    const cached = this.core.catalogs.get(found.key);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;

    try {
      const models = await found.adapter.list();
      remember(this.core.catalogs, found.key, { at: Date.now(), models });
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
        const models = await this.listModels(id);
        return { id, available: models !== null && models.length > 0, models: models ?? [] };
      }),
    );
  }

  async isAllowed({ provider, model }: ModelSelection) {
    const models = await this.listModels(provider);
    return models?.some((item) => item.id === model) ?? false;
  }

  defaultSelection() {
    return this.options.defaultSelection;
  }

  providerFor(selection?: ModelSelection): ProviderId | "echo" {
    return (selection ?? this.options.defaultSelection)?.provider ?? "echo";
  }

  private model(selection?: ModelSelection) {
    const target = selection ?? this.options.defaultSelection;
    if (!target) return { key: "fallback", model: this.options.fallback };
    const found = this.adapter(target.provider);
    if (!found) return { key: `${target.provider}:none`, model: undefined };
    const key = `${found.key}:${target.model}`;
    if (!this.core.chatModels.has(key)) remember(this.core.chatModels, key, found.adapter.create(target.model));
    return { key, model: this.core.chatModels.get(key) };
  }

  supportsTools(selection?: ModelSelection) {
    return this.model(selection).model?.supportsTools ?? false;
  }

  runner(selection?: ModelSelection): ChatRunner {
    const { key, model } = this.model(selection);
    if (!model) {
      return async () => {
        throw new ProviderUnavailableError();
      };
    }
    return this.core.runners.get(key) ?? remember(this.core.runners, key, createChatRunner(model));
  }
}

/** Registre de la plateforme (clés de la configuration) ; withKeys donne la vue d'une personne. */
export class ProviderRegistry extends RegistryView implements ScopableRegistry {
  constructor(providers: Partial<Record<ProviderId, ProviderSettings>>, options: RegistryOptions = {}) {
    const platform: Partial<Record<ProviderId, ProviderSettings>> = {};
    for (const id of providerIds) if (providers[id]) platform[id] = providers[id];
    super(new RegistryCore(), platform, options);
  }

  platformProviders() {
    return providerIds.filter((id) => this.platform[id] !== undefined);
  }

  withKeys(keys: ScopedKeys) {
    return new RegistryView(this.core, this.platform, this.options, keys);
  }

  async checkKey(provider: ProviderId, apiKey: string) {
    const view = new RegistryView(new RegistryCore(), this.platform, this.options, { [provider]: { apiKey, source: "personal" } });
    const models = await view.listModels(provider);
    if (!models?.length) throw new Error("KEY_REJECTED");
    return models.length;
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
        create: (model) => createOpenAiCompatibleModel(id, model, settings, { tools: settings.tools === true }),
        list: () => listOpenAiCompatibleModels(id, settings),
      };
  }
}
