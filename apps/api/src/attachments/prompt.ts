import type { ChatTurn, ModelImage } from "../graph/chat-graph.js";
import type { StoredMessage } from "../conversations/store.js";
import type { ModelAttachment } from "./store.js";
import { stripTags } from "../security/neutralize.js";

/** Texte de documents transmis au modèle pour une requête (tous tours confondus). */
export const DOCUMENT_CHAR_BUDGET = 150_000;
/** Plafond par document, pour qu'un seul fichier ne prenne pas tout le budget. */
export const DOCUMENT_CHAR_CAP = 60_000;
/** Images transmises par requête (les plus récentes d'abord). */
export const IMAGE_BUDGET = 4;

const escapeAttribute = (value: string) => value.replace(/[&"<>]/g, (char) => `&#${char.charCodeAt(0)};`);

type Budget = { chars: number; images: number };

function renderTurn(
  content: string,
  attachments: ModelAttachment[],
  budget: Budget,
): { text: string; images: ModelImage[] } {
  const documents: string[] = [];
  const images: ModelImage[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      if (budget.images > 0) {
        images.push(attachment.image);
        budget.images--;
      }
      continue;
    }
    const allowed = Math.min(DOCUMENT_CHAR_CAP, budget.chars);
    const text = attachment.text.length > allowed
      ? `${attachment.text.slice(0, allowed)}\n[… document tronqué]`
      : attachment.text;
    budget.chars -= Math.min(attachment.text.length, allowed);
    // Le texte reste une donnée : les balises éventuelles du document sont neutralisées.
    const safe = stripTags(text, /<\/?\s*document\b[^>]*>/gi);
    documents.push(`<document name="${escapeAttribute(attachment.name)}">\n${safe || "[document sans texte lisible]"}\n</document>`);
  }

  const body = content.trim() || "Analyse les fichiers joints.";
  return { text: documents.length ? `${documents.join("\n\n")}\n\n${body}` : body, images };
}

/**
 * Prépare l'historique et le message courant avec leurs pièces jointes, dans
 * les budgets ci-dessus : le message courant d'abord, puis les tours récents.
 */
export function buildModelInput(
  history: StoredMessage[],
  current: { content: string; attachmentIds: string[] },
  files: Map<string, ModelAttachment>,
): { history: ChatTurn[]; message: string; images: ModelImage[] } {
  const budget: Budget = { chars: DOCUMENT_CHAR_BUDGET, images: IMAGE_BUDGET };
  const pick = (ids: string[]) => ids.map((id) => files.get(id)).filter((file): file is ModelAttachment => !!file);

  const now = renderTurn(current.content, pick(current.attachmentIds), budget);

  const turns: ChatTurn[] = [];
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.role === "assistant" || !message.attachments?.length) {
      turns.unshift({ role: message.role, content: message.content });
      continue;
    }
    const rendered = renderTurn(message.content, pick(message.attachments.map((file) => file.id)), budget);
    turns.unshift({
      role: "user",
      content: rendered.text,
      ...(rendered.images.length ? { images: rendered.images } : {}),
    });
  }

  return { history: turns, message: now.text, images: now.images };
}

/** Estimation prudente (≈ 4 caractères par token) quand le fournisseur ne compte pas. */
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}
