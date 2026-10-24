import type { ChatModel, ChatRequest, ChatTurn } from "../graph/chat-graph.js";
import { identifierSpans } from "../security/sensitive.js";
import { FIRST_NAMES } from "./first-names.js";

// Pseudonymisation réversible avant un envoi à un fournisseur externe : les
// données personnelles repérées (e-mails, téléphones, adresses, noms,
// identifiants) deviennent des jetons stables ([PERSONNE_1], [EMAIL_1]…), le
// modèle répond avec ces jetons, et la plateforme remet les vraies valeurs avant
// l'affichage et avant d'exécuter un outil. La correspondance ne vit que le temps
// d'un appel, en mémoire : jamais stockée, jamais envoyée.
//
// Repérage par règles : efficace pour ce qui a une forme (e-mail, téléphone,
// identifiant, adresse), partiel pour les noms (civilité ou prénom connu). Ce
// n'est PAS une anonymisation : un nom non repéré part en clair. Pour des données
// vraiment sensibles, la plateforme bascule sur un modèle local.

export type PersonalKind = "PERSONNE" | "EMAIL" | "TEL" | "ADRESSE" | "IDENTIFIANT";
type Span = { start: number; end: number; kind: PersonalKind; value: string };

const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Téléphones : français (0X ou +33/0033) et internationaux (+indicatif).
const PHONE = /(?<![\d+])(?:(?:\+|00)33[\s.-]?[1-9]|0[1-9])(?:[\s.-]?\d{2}){4}(?!\d)|(?<![\d+])\+(?!33)\d{1,3}(?:[\s.-]?\d){6,12}(?!\d)/g;
const STREET = /(?<!\w)\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|av\.|boulevard|bd|place|chemin|all[ée]e|impasse|quai|route|cours|square|passage|faubourg)\s+[^\n,.;:()]{2,50}/giu;
const POSTAL = /(?<!\d)\d{5}\s+[A-ZÉÈ][\p{L}'-]+(?:[ -][A-ZÉÈ][\p{L}'-]+)*/gu;
// Civilité + nom : on garde la civilité (le modèle reste correct), le nom devient un jeton.
const CIVILITY = /\b(?:M\.|Mme|Mlle|Monsieur|Madame|Mademoiselle|Dr\.?|Docteure?|Ma[iî]tre|Me|Pr\.?|Professeure?)\s+((?:(?:de|du|des|d'|van|von|le|la)\s+)?[A-ZÉÈÀ][\p{L}'-]+(?:[ -][A-ZÉÈÀ][\p{L}'-]+)?)/gu;
const WORD = /[A-ZÉÈÀÂÎÔ][\p{L}'-]*/gu;
const SURNAME = /^(?:[A-ZÉÈÀ][\p{Ll}'-]+(?:-[A-ZÉÈÀ][\p{Ll}'-]+)?|[A-ZÉÈÀ]{2,}(?:-[A-ZÉÈÀ]{2,})?)$/u;

/**
 * Données personnelles repérées, sans chevauchement (les plus sûres d'abord).
 * known : noms de famille déjà repérés ailleurs (autres messages du même appel) ;
 * complété par ceux trouvés ici.
 */
export function detectPersonal(text: string, known: Set<string> = new Set()): Span[] {
  const spans: Span[] = [];
  // Caractères déjà pris : contrôle de chevauchement linéaire (pas de comparaison deux à deux).
  const taken = new Uint8Array(text.length);
  const free = (start: number, end: number) => {
    for (let index = start; index < end; index++) if (taken[index]) return false;
    return true;
  };
  const add = (start: number, end: number, kind: PersonalKind) => {
    if (end <= start || !free(start, end)) return;
    taken.fill(1, start, end);
    spans.push({ start, end, kind, value: text.slice(start, end) });
  };
  for (const span of identifierSpans(text)) add(span.start, span.end, "IDENTIFIANT");
  for (const match of text.matchAll(EMAIL)) add(match.index, match.index + match[0].length, "EMAIL");
  for (const match of text.matchAll(PHONE)) add(match.index, match.index + match[0].length, "TEL");
  for (const match of text.matchAll(STREET)) add(match.index, match.index + match[0].trimEnd().length, "ADRESSE");
  for (const match of text.matchAll(POSTAL)) add(match.index, match.index + match[0].length, "ADRESSE");
  for (const match of text.matchAll(CIVILITY)) {
    const name = match[1]!;
    const start = match.index + match[0].length - name.length;
    add(start, start + name.length, "PERSONNE");
    // Indice fiable : ce nom sera reconnu seul ensuite (« Mme Leroy… Leroy part »).
    const last = name.split(/[ ]/).at(-1)!;
    if (SURNAME.test(last)) known.add(last);
  }
  // Prénom connu (+ nom de famille s'il suit) ; puis ces noms de famille seuls.
  const surnames = known;
  const words = [...text.matchAll(WORD)];
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (!FIRST_NAMES.has(word[0])) continue;
    const next = words[index + 1];
    // « Julie Martin » : un seul nom, même quand le nom de famille est aussi un prénom
    // (Martin, Bernard, Thomas… sont des noms de famille très courants).
    const adjacent = next && /^[ ]$/.test(text.slice(word.index + word[0].length, next.index)) && SURNAME.test(next[0]);
    const end = adjacent ? next.index + next[0].length : word.index + word[0].length;
    add(word.index, end, "PERSONNE");
    if (adjacent) {
      surnames.add(next[0]);
      index++;
    }
  }
  for (const span of spans.filter((item) => item.kind === "PERSONNE")) {
    const last = span.value.split(/[ ]/).at(-1)!;
    if (span.value.includes(" ") && SURNAME.test(last)) surnames.add(last);
  }
  for (const surname of surnames) {
    for (const match of text.matchAll(new RegExp(`(?<![\\p{L}'-])${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}'-])`, "gu"))) add(match.index, match.index + surname.length, "PERSONNE");
  }
  return spans.sort((a, b) => a.start - b.start);
}

const TOKEN = /\[(PERSONNE|EMAIL|TEL|ADRESSE|IDENTIFIANT)_(\d{1,4})\]/g;

/** Correspondance valeurs ↔ jetons pour UN appel au modèle. */
export class Pseudonymizer {
  private readonly tokens = new Map<string, string>();
  private readonly values = new Map<string, string>();
  private readonly counts = new Map<PersonalKind, number>();
  /** Nom de famille seul → jeton de la personne déjà rencontrée (« Martin » après « Julie Martin »). */
  private readonly people = new Map<string, string>();

  private key(kind: PersonalKind, value: string) {
    const compact = kind === "TEL" || kind === "IDENTIFIANT" ? value.replace(/[\s.-]/g, "") : value.replace(/\s+/g, " ").toLowerCase();
    return `${kind}:${compact}`;
  }

  private tokenFor(kind: PersonalKind, value: string) {
    const key = this.key(kind, value);
    const known = this.tokens.get(key) ?? (kind === "PERSONNE" ? this.people.get(value.toLowerCase()) : undefined);
    if (known) return known;
    const count = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, count);
    const token = `[${kind}_${count}]`;
    this.tokens.set(key, token);
    this.values.set(token, value);
    if (kind === "PERSONNE" && value.includes(" ")) this.people.set(value.split(" ").at(-1)!.toLowerCase(), token);
    return token;
  }

  get size() {
    return this.values.size;
  }

  /** Noms de famille repérés pendant cet appel : reconnus seuls dans les textes suivants. */
  private readonly surnames = new Set<string>();

  mask(input: string) {
    // Un texte qui contient déjà « [PERSONNE_1] » (document pseudonymisé collé…) ne
    // doit pas être pris pour un jeton au retour : son tiret bas devient insécable.
    const text = input.replace(TOKEN, (token) => token.replace("_", "‗"));
    let result = "";
    let last = 0;
    for (const span of detectPersonal(text, this.surnames)) {
      result += text.slice(last, span.start) + this.tokenFor(span.kind, span.value);
      last = span.end;
    }
    return result + text.slice(last);
  }

  unmask(text: string) {
    return text.replace(TOKEN, (token) => this.values.get(token) ?? token);
  }

  /** Restitution au fil d'un flux : un jeton coupé entre deux morceaux est attendu. */
  unmasker() {
    let buffer = "";
    return {
      push: (chunk: string) => {
        buffer += chunk;
        const open = buffer.lastIndexOf("[");
        // Un « [ » sans « ] » à moins de 20 caractères de la fin : peut-être un jeton en cours.
        const hold = open !== -1 && !buffer.includes("]", open) && buffer.length - open <= 20 ? open : buffer.length;
        const ready = buffer.slice(0, hold);
        buffer = buffer.slice(hold);
        return this.unmask(ready);
      },
      flush: () => {
        const rest = this.unmask(buffer);
        buffer = "";
        return rest;
      },
    };
  }
}

function deep<T>(value: T, transform: (text: string) => string): T {
  if (typeof value === "string") return transform(value) as T;
  if (Array.isArray(value)) return value.map((item) => deep(item, transform)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item, transform)])) as T;
  return value;
}

const NOTICE =
  "Confidentialité : certaines données personnelles du contexte ont été remplacées par des jetons comme [PERSONNE_1], [EMAIL_1], [TEL_1] ou [ADRESSE_1]. " +
  "Réutilise ces jetons tels quels quand tu en parles ; ne cherche pas à deviner ce qu'ils cachent.";

function maskTurn(turn: ChatTurn, pseudonymizer: Pseudonymizer): ChatTurn {
  const mask = (text: string) => pseudonymizer.mask(text);
  if (turn.role === "assistant") {
    // providerData (ex. réflexion signée) : jamais modifié, sinon le fournisseur le rejette.
    return { ...turn, content: mask(turn.content), ...(turn.toolCalls ? { toolCalls: turn.toolCalls.map((call) => ({ ...call, arguments: deep(call.arguments, mask) })) } : {}) };
  }
  return { ...turn, content: mask(turn.content) };
}

/** Requête envoyée au fournisseur, dans un ordre fixe (la numérotation des jetons en dépend). */
export function maskRequest(request: ChatRequest, pseudonymizer: Pseudonymizer): ChatRequest {
  const mask = (text: string) => pseudonymizer.mask(text);
  return {
    ...request,
    instructions: [NOTICE, request.instructions ? mask(request.instructions) : ""].filter(Boolean).join("\n\n"),
    ...(request.summary ? { summary: mask(request.summary) } : {}),
    ...(request.memories ? { memories: request.memories.map(mask) } : {}),
    history: request.history.map((turn) => maskTurn(turn, pseudonymizer)),
    message: mask(request.message),
    ...(request.turns ? { turns: request.turns.map((turn) => maskTurn(turn, pseudonymizer)) } : {}),
  };
}

/**
 * Modèle externe enveloppé : ce qui part est pseudonymisé, ce qui revient est
 * restitué (texte affiché, réflexion, arguments des outils exécutés en local).
 */
export function pseudonymizingModel(model: ChatModel): ChatModel {
  return {
    id: model.id,
    ...(model.supportsTools !== undefined ? { supportsTools: model.supportsTools } : {}),
    async *stream(request, signal) {
      const pseudonymizer = new Pseudonymizer();
      const masked = maskRequest(request, pseudonymizer);
      const output = pseudonymizer.unmasker();
      for await (const chunk of model.stream(masked, signal)) {
        if (chunk.type === "token") {
          const text = output.push(chunk.text);
          if (text) yield { type: "token", text };
          continue;
        }
        // Avant tout autre événement, le texte retenu sort (l'ordre est préservé).
        const rest = output.flush();
        if (rest) yield { type: "token", text: rest };
        if (chunk.type === "reasoning") yield { type: "reasoning", text: pseudonymizer.unmask(chunk.text) };
        else if (chunk.type === "tool_call") yield { type: "tool_call", call: { ...chunk.call, arguments: deep(chunk.call.arguments, (text) => pseudonymizer.unmask(text)) } };
        else yield chunk;
      }
      const rest = output.flush();
      if (rest) yield { type: "token", text: rest };
    },
  };
}
