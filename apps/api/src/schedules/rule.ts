// Prochaine exécution d'une tâche planifiée, à l'heure LOCALE de son auteur
// (fuseau IANA), changements d'heure compris. Une tâche manquée (serveur arrêté)
// ne s'exécute qu'une fois au retour : la suivante part de maintenant.

export type Cadence = { cadence: "daily"; hour: number } | { cadence: "weekly"; hour: number; weekday: number };

export function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: timezone });
    return timezone.length <= 64;
  } catch {
    return false;
  }
}

/** Date et heure locales d'un instant dans un fuseau. */
function local(instant: number, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday };
}

/** Instant UTC d'une heure locale (heure inexistante au passage à l'heure d'été : l'heure suivante). */
function toInstant(year: number, month: number, day: number, hour: number, timezone: string) {
  const wanted = Date.UTC(year, month - 1, day, hour);
  let guess = wanted;
  for (let index = 0; index < 3; index++) {
    const seen = local(guess, timezone);
    guess += wanted - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  }
  // Heure absorbée par le passage à l'heure d'été : on avance jusqu'à la première heure qui existe.
  for (;;) {
    const seen = local(guess, timezone);
    if (Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour) >= wanted) return guess;
    guess += 3_600_000;
  }
}

/** Première occurrence strictement après `after`. */
export function nextRun(rule: Cadence, timezone: string, after: Date): Date {
  const start = local(after.getTime(), timezone);
  for (let offset = 0; offset <= 8; offset++) {
    // Jour civil local (midi, pour ignorer les décalages) + offset jours.
    const noon = new Date(Date.UTC(start.year, start.month - 1, start.day + offset, 12));
    const day = { year: noon.getUTCFullYear(), month: noon.getUTCMonth() + 1, day: noon.getUTCDate(), weekday: noon.getUTCDay() };
    if (rule.cadence === "weekly" && day.weekday !== rule.weekday) continue;
    const instant = toInstant(day.year, day.month, day.day, rule.hour, timezone);
    if (instant > after.getTime()) return new Date(instant);
  }
  throw new Error("SCHEDULE_RULE_UNREACHABLE");
}
