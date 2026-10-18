// Voix locale : dictée (parole → texte) et lecture à voix haute (texte → parole),
// par des services auto-hébergés compatibles avec l'API audio d'OpenAI
// (ex. Speaches : faster-whisper pour la dictée, Kokoro ou Piper pour la voix).
// L'audio ne quitte pas la plateforme et n'est jamais conservé.

export type AudioConfig = { baseUrl: string; model: string; voice?: string | undefined };

export class AudioError extends Error {
  constructor(readonly code: "unavailable" | "too_large" | "invalid") {
    super(`AUDIO_${code.toUpperCase()}`);
  }
}

/** Formats acceptés pour la dictée (ce qu'enregistrent les navigateurs). */
export const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_SPEECH_CHARS = 4_000;
const TIMEOUT_MS = 120_000;

/** Signature du fichier : le type annoncé doit correspondre au contenu. */
export function audioMatches(mediaType: string, bytes: Buffer) {
  const head = bytes.subarray(0, 12);
  switch (mediaType) {
    case "audio/webm":
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    case "audio/ogg":
      return head.toString("latin1", 0, 4) === "OggS";
    case "audio/mp4":
      return head.toString("latin1", 4, 8) === "ftyp";
    case "audio/mpeg":
      return head.toString("latin1", 0, 3) === "ID3" || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);
    case "audio/wav":
    case "audio/x-wav":
      return head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WAVE";
    default:
      return false;
  }
}

export interface SpeechService {
  transcribe(audio: Buffer, mediaType: string, language?: string): Promise<string>;
  speak(text: string): Promise<Buffer>;
}

export class OpenAiCompatibleSpeech implements SpeechService {
  constructor(
    private readonly stt: AudioConfig | undefined,
    private readonly tts: AudioConfig | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get canTranscribe() {
    return Boolean(this.stt);
  }

  get canSpeak() {
    return Boolean(this.tts);
  }

  async transcribe(audio: Buffer, mediaType: string, language?: string) {
    if (!this.stt) throw new AudioError("unavailable");
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(audio)], { type: mediaType }), `dictee.${AUDIO_TYPES[mediaType] ?? "webm"}`);
    form.set("model", this.stt.model);
    form.set("response_format", "json");
    if (language) form.set("language", language);
    const response = await this.fetcher(`${this.stt.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!response?.ok) throw new AudioError("unavailable");
    const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof body?.text !== "string") throw new AudioError("invalid");
    return body.text.trim().slice(0, 20_000);
  }

  async speak(text: string) {
    if (!this.tts) throw new AudioError("unavailable");
    const response = await this.fetcher(`${this.tts.baseUrl.replace(/\/$/, "")}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.tts.model, input: text.slice(0, MAX_SPEECH_CHARS), ...(this.tts.voice ? { voice: this.tts.voice } : {}), response_format: "mp3" }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    if (!response?.ok) throw new AudioError("unavailable");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_AUDIO_BYTES) throw new AudioError("too_large");
    if (!audioMatches("audio/mpeg", bytes)) throw new AudioError("invalid");
    return bytes;
  }
}

/** Texte lu à voix haute : sans Markdown ni blocs de code (on lit la réponse, pas sa syntaxe). */
export function speakable(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\d+\]/g, "")
    .replace(/[*_#>|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPEECH_CHARS);
}
