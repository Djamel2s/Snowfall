import { LinkError, validateUrl } from "../knowledge/safe-fetch.js";

// Recherche web par SearXNG auto-hébergé : un métamoteur qui interroge les
// moteurs publics à notre place, via le proxy de sortie. Les moteurs voient la
// requête, jamais l'utilisateur (ni son adresse, ni ses cookies).

export type WebResult = { title: string; url: string; snippet: string };

export interface WebSearchEngine {
  search(query: string, options: { language?: string | undefined; signal?: AbortSignal | undefined }): Promise<WebResult[]>;
}

export const MAX_WEB_RESULTS = 6;

type SearxngResponse = { results?: { title?: unknown; url?: unknown; content?: unknown }[] };

/** Résultats bruts → liens publics http(s) uniquement, sans doublons, texte borné. */
export function cleanResults(raw: SearxngResponse["results"], limit = MAX_WEB_RESULTS): WebResult[] {
  const seen = new Set<string>();
  const results: WebResult[] = [];
  for (const item of raw ?? []) {
    if (typeof item.url !== "string" || typeof item.title !== "string") continue;
    let url: string;
    try {
      url = validateUrl(item.url).href;
    } catch (error) {
      if (error instanceof LinkError) continue;
      throw error;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: item.title.replace(/\s+/g, " ").trim().slice(0, 200) || new URL(url).hostname,
      url,
      snippet: typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim().slice(0, 500) : "",
    });
    if (results.length >= limit) break;
  }
  return results;
}

export class SearxngClient implements WebSearchEngine {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async search(query: string, options: { language?: string | undefined; signal?: AbortSignal | undefined }) {
    const params = new URLSearchParams({ q: query, format: "json", safesearch: "1", language: options.language ?? "auto" });
    const timeout = AbortSignal.timeout(15_000);
    const response = await this.fetcher(`${this.baseUrl}/search?${params}`, {
      headers: { Accept: "application/json" },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`SEARXNG_${response.status}`);
    return cleanResults(((await response.json()) as SearxngResponse).results);
  }
}
