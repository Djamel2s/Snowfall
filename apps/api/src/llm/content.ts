import type { ChatRequest, ChatTurn, ModelImage } from "../graph/chat-graph.js";

export function imageDataUrl(image: ModelImage) {
  return `data:${image.mediaType};base64,${image.data}`;
}

/** Historique puis message courant, sous une forme commune aux adaptateurs. */
export function conversationTurns(request: ChatRequest): ChatTurn[] {
  return [
    ...request.history,
    { role: "user", content: request.message, ...(request.images?.length ? { images: request.images } : {}) },
  ];
}
