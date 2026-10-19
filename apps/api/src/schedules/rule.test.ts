import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextRun, validTimezone } from "./rule.js";

describe("Agents planifiés : prochaine exécution", () => {
  it("chaque jour à 8 h, heure de Paris (UTC+2 en octobre)", () => {
    assert.equal(nextRun({ cadence: "daily", hour: 8 }, "Europe/Paris", new Date("2026-10-19T05:00:00Z")).toISOString(), "2026-10-19T06:00:00.000Z");
    // Déjà passé aujourd'hui : demain.
    assert.equal(nextRun({ cadence: "daily", hour: 8 }, "Europe/Paris", new Date("2026-10-19T06:00:00Z")).toISOString(), "2026-10-20T06:00:00.000Z");
  });

  it("chaque lundi à 9 h, y compris à travers le passage à l'heure d'hiver", () => {
    // Dimanche 25 octobre 2026 : retour à UTC+1. Lundi 26 à 9 h = 08:00 UTC.
    assert.equal(nextRun({ cadence: "weekly", hour: 9, weekday: 1 }, "Europe/Paris", new Date("2026-10-20T10:00:00Z")).toISOString(), "2026-10-26T08:00:00.000Z");
  });

  it("heure inexistante (passage à l'heure d'été) : l'heure qui suit, jamais une boucle", () => {
    // 29 mars 2026, 2 h n'existe pas à Paris.
    const instant = nextRun({ cadence: "daily", hour: 2 }, "Europe/Paris", new Date("2026-03-28T23:00:00Z"));
    assert.equal(instant.toISOString(), "2026-03-29T01:00:00.000Z");
  });

  it("autres fuseaux, et fuseau inconnu refusé", () => {
    assert.equal(nextRun({ cadence: "daily", hour: 23 }, "America/New_York", new Date("2026-10-19T12:00:00Z")).toISOString(), "2026-10-20T03:00:00.000Z");
    assert.equal(validTimezone("Europe/Paris"), true);
    assert.equal(validTimezone("Mars/Olympus"), false);
  });
});
