import { McpError, type McpServerSettings, type McpToolDefinition } from "./client.js";

// Connecteur OpenAPI : une API interne décrite par sa spécification (OpenAPI 3)
// devient un ensemble d'outils, sans écrire de serveur MCP. Il réutilise toute
// la chaîne des connecteurs MCP : examen et approbation par un administrateur
// (empreinte par outil), choix par agent, validation des écritures, règle de
// deux, marquage des résultats, audit. Seul le transport change : HTTP direct.
//
// Sécurité :
// - la spécification est fournie par l'administrateur et figée (rien n'est
//   téléchargé à l'exécution) ; seules les références internes (#/…) sont suivies ;
// - l'adresse finale reste sur l'hôte de base (paramètres encodés, contrôle d'origine) ;
// - aucune redirection suivie, réponse bornée, délai court ; adresses publiques seulement.

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
type Method = (typeof METHODS)[number];
const MAX_OPERATIONS = 100;
const MAX_SPEC_BYTES = 1024 * 1024;
const MAX_RESPONSE_CHARS = 50_000;
const TIMEOUT_MS = 20_000;

export type ApiOperation = {
  name: string;
  method: Method;
  path: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  definition: McpToolDefinition;
};

export class OpenApiError extends Error {
  constructor(readonly code: "invalid_spec" | "too_large") {
    super(`OPENAPI_${code.toUpperCase()}`);
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Remplace les références internes (#/components/…), profondeur bornée ; une référence externe est refusée. */
function resolve(spec: Json, value: unknown, depth = 0): unknown {
  if (depth > 20) throw new OpenApiError("invalid_spec");
  if (Array.isArray(value)) return value.map((item) => resolve(spec, item, depth + 1));
  if (!isObject(value)) return value;
  if (typeof value.$ref === "string") {
    const ref = value.$ref;
    if (!ref.startsWith("#/")) throw new OpenApiError("invalid_spec");
    let target: unknown = spec;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      target = isObject(target) ? target[key] : undefined;
    }
    if (target === undefined) throw new OpenApiError("invalid_spec");
    return resolve(spec, target, depth + 1);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(spec, item, depth + 1)]));
}

const slug = (text: string) => text.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "operation";

/** Lit une spécification OpenAPI 3 (JSON) et en tire les opérations proposables. */
export function parseOpenApi(input: unknown): ApiOperation[] {
  if (JSON.stringify(input ?? null).length > MAX_SPEC_BYTES) throw new OpenApiError("too_large");
  if (!isObject(input) || typeof input.openapi !== "string" || !input.openapi.startsWith("3.") || !isObject(input.paths)) throw new OpenApiError("invalid_spec");
  const spec = input;
  const operations: ApiOperation[] = [];
  for (const [path, rawItem] of Object.entries(spec.paths as Json)) {
    if (!path.startsWith("/") || !isObject(rawItem)) continue;
    const item = resolve(spec, rawItem) as Json;
    const shared = Array.isArray(item.parameters) ? (item.parameters as unknown[]) : [];
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const parameters = [...shared, ...(Array.isArray(operation.parameters) ? (operation.parameters as unknown[]) : [])].filter(isObject);
      const properties: Json = {};
      const required: string[] = [];
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      let unsupported = false;
      for (const parameter of parameters) {
        const name = typeof parameter.name === "string" ? parameter.name : "";
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) continue;
        if (parameter.in === "path") pathParams.push(name);
        else if (parameter.in === "query") queryParams.push(name);
        else {
          // En-tête ou cookie obligatoire : non pris en charge (l'outil n'est pas proposable).
          if (parameter.required === true) unsupported = true;
          continue;
        }
        properties[name] = { ...(isObject(parameter.schema) ? parameter.schema : { type: "string" }), ...(typeof parameter.description === "string" ? { description: parameter.description.slice(0, 500) } : {}) };
        if (parameter.required === true || parameter.in === "path") required.push(name);
      }
      const content = isObject(operation.requestBody) && isObject(operation.requestBody.content) ? operation.requestBody.content : null;
      const body = content && isObject(content["application/json"]) ? content["application/json"].schema : undefined;
      if (content && !body) unsupported = true;
      if (body !== undefined) {
        properties.body = body;
        if (isObject(operation.requestBody) && operation.requestBody.required === true) required.push("body");
      }
      const name = slug(typeof operation.operationId === "string" ? operation.operationId : `${method}_${path}`);
      const summary = typeof operation.summary === "string" ? operation.summary : "";
      const description = [summary, typeof operation.description === "string" ? operation.description : ""].filter(Boolean).join(" — ").slice(0, 1_000);
      operations.push({
        name,
        method,
        path,
        pathParams,
        queryParams,
        hasBody: body !== undefined,
        definition: {
          name,
          ...(summary ? { title: summary.slice(0, 120) } : {}),
          description: `${method.toUpperCase()} ${path}${description ? ` : ${description}` : ""}`,
          // Schéma non pris en charge : rendu illisible pour que l'outil ne soit pas proposable.
          inputSchema: unsupported ? { type: "unsupported" } : { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
          readOnlyHint: method === "get",
        },
      });
      if (operations.length > MAX_OPERATIONS) throw new OpenApiError("too_large");
    }
  }
  return operations;
}

/** Même interface que le client MCP : la chaîne d'outils ne voit pas la différence. */
export class OpenApiClient {
  private readonly operations: ApiOperation[];

  constructor(
    private readonly settings: McpServerSettings,
    spec: unknown,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.operations = parseOpenApi(spec);
  }

  async listTools(): Promise<McpToolDefinition[]> {
    return this.operations.map((operation) => operation.definition);
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const operation = this.operations.find((item) => item.name === name);
    if (!operation) throw new McpError("tool_error");
    const values = isObject(args) ? args : {};
    const base = new URL(this.settings.url);
    let path = operation.path;
    for (const param of operation.pathParams) {
      const value = values[param];
      if (value === undefined || value === null || typeof value === "object") throw new McpError("tool_error");
      path = path.replaceAll(`{${param}}`, encodeURIComponent(String(value)));
    }
    if (/[{}]/.test(path)) throw new McpError("tool_error");
    const url = new URL(`${base.pathname.replace(/\/$/, "")}${path}`, base.origin);
    // L'adresse ne quitte jamais l'hôte déclaré par l'administrateur.
    if (url.origin !== base.origin) throw new McpError("invalid_url");
    for (const param of operation.queryParams) {
      const value = values[param];
      if (value === undefined || value === null) continue;
      url.searchParams.set(param, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    await this.settings.checkAddress?.(url.hostname);
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.settings.token) headers.authorization = `Bearer ${this.settings.token}`;
    if (operation.hasBody) headers["content-type"] = "application/json";
    const response = await this.fetcher(url, {
      method: operation.method.toUpperCase(),
      headers,
      ...(operation.hasBody && values.body !== undefined ? { body: JSON.stringify(values.body) } : {}),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    }).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      throw new McpError("http_error");
    });
    const text = (await response.text().catch(() => "")).slice(0, MAX_RESPONSE_CHARS);
    return response.ok ? { text: text || `HTTP ${response.status}`, isError: false } : { text: `HTTP ${response.status}${text ? ` : ${text}` : ""}`, isError: true };
  }
}
