import http from "node:http";
import type { DecisionEngine } from "./routing.js";
import type { Confusion, DecisionHead } from "./workshop.js";

// Service de décision local (apps/decision) : aucun réseau, socket Unix.

const DECIDE_TIMEOUT_MS = 3_000;
const TRAIN_TIMEOUT_MS = 120_000;

export type TrainInput = {
  labels: { positive: string; negative: string };
  train: { text: string; label: string }[];
  test: { text: string; label: string }[];
  baseline: { kind: "zero_shot"; instructions: string; options: Record<string, string>; threshold: number } | { kind: "head"; head: DecisionHead };
};
export type TrainResult = { head: DecisionHead; candidate: Confusion; baseline: Confusion; cv: number };

/** Entraînement d'une tête (atelier) : en plus de la décision. */
export interface DecisionTrainer {
  train(input: TrainInput, signal?: AbortSignal): Promise<TrainResult>;
}

export class UnixSocketDecision implements DecisionEngine, DecisionTrainer {
  constructor(private readonly socketPath: string) {}

  private post<T>(path: string, payload: unknown, options: { timeout: number; maxResponse: number; signal?: AbortSignal | undefined }) {
    const body = JSON.stringify(payload);
    return new Promise<T>((resolve, reject) => {
      const request = http.request(
        { socketPath: this.socketPath, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: options.timeout, ...(options.signal ? { signal: options.signal } : {}) },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          // Réponse démesurée : on coupe et on rejette (le flux ne doit jamais lever hors de la promesse).
          response.on("error", reject);
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= options.maxResponse) return void chunks.push(chunk);
            reject(new Error("DECISION_RESPONSE_TOO_LARGE"));
            response.destroy();
            request.destroy();
          });
          response.on("end", () => {
            if (size > options.maxResponse) return;
            if (response.statusCode !== 200) return reject(new Error(`DECISION_${response.statusCode}`));
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
            } catch {
              reject(new Error("DECISION_INVALID_RESPONSE"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("DECISION_TIMEOUT")));
      request.on("error", reject);
      request.end(body);
    });
  }

  async decide(text: string, question: { instructions: string; options: Record<string, string> }, signal?: AbortSignal, head?: DecisionHead) {
    const value = await this.post<{ choice?: unknown; probabilities?: unknown; confidence?: unknown }>(
      "/decide",
      { text, instructions: question.instructions, options: question.options, ...(head ? { head } : {}) },
      { timeout: DECIDE_TIMEOUT_MS, maxResponse: 16_384, signal },
    );
    if (typeof value.choice !== "string" || typeof value.confidence !== "number" || typeof value.probabilities !== "object" || !value.probabilities) throw new Error("DECISION_INVALID_RESPONSE");
    return { choice: value.choice, probabilities: value.probabilities as Record<string, number>, confidence: value.confidence };
  }

  async train(input: TrainInput, signal?: AbortSignal) {
    const value = await this.post<TrainResult>("/train", input, { timeout: TRAIN_TIMEOUT_MS, maxResponse: 128 * 1024, signal });
    const counts = (c: unknown) => typeof c === "object" && c !== null && ["tp", "fn", "tn", "fp"].every((key) => Number.isInteger((c as Record<string, unknown>)[key]));
    if (!value.head || !Array.isArray(value.head.weights) || !counts(value.candidate) || !counts(value.baseline) || typeof value.cv !== "number") throw new Error("DECISION_INVALID_RESPONSE");
    return value;
  }
}
