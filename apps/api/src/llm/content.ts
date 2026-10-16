import type { ChatRequest, ChatTurn, ModelImage } from "../graph/chat-graph.js";

export function imageDataUrl(image: ModelImage) {
  return `data:${image.mediaType};base64,${image.data}`;
}

/**
 * Transcription à envoyer au modèle : celle de la boucle d'agent si elle
 * existe (avec appels et résultats d'outils), sinon historique + message.
 */
export function conversationTurns(request: ChatRequest): ChatTurn[] {
  if (request.turns) return request.turns;
  return [
    ...request.history,
    { role: "user", content: request.message, ...(request.images?.length ? { images: request.images } : {}) },
  ];
}

/** Arguments d'outil reçus en texte JSON (OpenAI, Mistral) : objet, ou texte brut si invalide. */
export function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Laissé tel quel : la validation de l'outil renverra une erreur lisible au modèle.
    return raw;
  }
}
