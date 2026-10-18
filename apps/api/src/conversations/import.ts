// Import de conversations exportées ailleurs. Formats reconnus :
// - Snowfall (export JSON d'une conversation) ;
// - ChatGPT (conversations.json de l'export des données : un arbre par
//   conversation, on garde la branche affichée — current_node → racine) ;
// - LibreChat (export JSON d'une conversation : messages avec isCreatedByUser).
//
// Le fichier est une DONNÉE non fiable : tout est validé, borné, et ramené à du
// texte (rôle utilisateur ou assistant). Rien d'autre n'est conservé (ni
// identifiants, ni métadonnées des autres services).

export const IMPORT_MAX_CONVERSATIONS = 200;
export const IMPORT_MAX_MESSAGES = 500;
export const IMPORT_MAX_CHARS = 100_000;
const TITLE_CHARS = 120;

export type ImportedMessage = { role: "user" | "assistant"; content: string };
export type ImportedConversation = { title: string; messages: ImportedMessage[] };
export type ImportFormat = "snowfall" | "chatgpt" | "librechat";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : "");

function finish(title: unknown, messages: ImportedMessage[]): ImportedConversation | null {
  const kept = messages
    .map((message) => ({ role: message.role, content: message.content.replace(/\u0000/g, "").trim().slice(0, IMPORT_MAX_CHARS) }))
    .filter((message) => message.content)
    .slice(0, IMPORT_MAX_MESSAGES);
  if (!kept.length) return null;
  const name = text(title).replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS);
  return { title: name || kept[0]!.content.replace(/\s+/g, " ").slice(0, 80), messages: kept };
}

function fromSnowfall(data: Json) {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return finish(
    data.title,
    messages.filter(isObject).flatMap((message) => (message.role === "user" || message.role === "assistant" ? [{ role: message.role, content: text(message.content) }] : [])),
  );
}

/** ChatGPT : arbre « mapping » ; la branche affichée part de current_node et remonte les parents. */
function fromChatGpt(data: Json) {
  const mapping = isObject(data.mapping) ? data.mapping : {};
  const path: ImportedMessage[] = [];
  const seen = new Set<string>();
  let current = text(data.current_node);
  while (current && !seen.has(current) && seen.size < 5_000) {
    seen.add(current);
    const node = mapping[current];
    if (!isObject(node)) break;
    const message = isObject(node.message) ? node.message : null;
    const role = isObject(message?.author) ? message.author.role : null;
    const content = isObject(message?.content) ? message.content : null;
    // Seulement le texte (content_type « text ») : ni code exécuté, ni images, ni outils.
    if ((role === "user" || role === "assistant") && content?.content_type === "text" && Array.isArray(content.parts)) {
      path.unshift({ role, content: content.parts.filter((part): part is string => typeof part === "string").join("\n") });
    }
    current = text(node.parent);
  }
  return finish(data.title, path);
}

function fromLibreChat(data: Json) {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return finish(
    data.title,
    messages.filter(isObject).map((message) => ({ role: message.isCreatedByUser === true ? "user" : "assistant", content: text(message.text) || text(message.content) })),
  );
}

/** Reconnaît le format d'un fichier exporté. */
export function detectFormat(data: unknown): ImportFormat | null {
  if (isObject(data) && data.format === "snowfall.conversation") return "snowfall";
  const first = Array.isArray(data) ? data[0] : data;
  if (isObject(first) && isObject(first.mapping) && "current_node" in first) return "chatgpt";
  if (isObject(first) && Array.isArray(first.messages) && first.messages.some((message) => isObject(message) && "isCreatedByUser" in message)) return "librechat";
  return null;
}

/** Conversations lisibles d'un fichier (les vides sont écartées), bornées en nombre. */
export function parseImport(data: unknown): { format: ImportFormat; conversations: ImportedConversation[]; skipped: number } | null {
  const format = detectFormat(data);
  if (!format) return null;
  const items = (Array.isArray(data) ? data : [data]).filter(isObject).slice(0, IMPORT_MAX_CONVERSATIONS);
  const parse = format === "snowfall" ? fromSnowfall : format === "chatgpt" ? fromChatGpt : fromLibreChat;
  const conversations = items.map(parse).filter((item): item is ImportedConversation => item !== null);
  const total = Array.isArray(data) ? data.length : 1;
  return { format, conversations, skipped: total - conversations.length };
}
