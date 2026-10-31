import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { declaredIcon, faviconDomain, FaviconService, imageType } from "./favicon.js";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const ico = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16)]);

describe("Icônes des sites cités", () => {
  it("domaine public seulement : ni IP, ni port, ni chemin, ni nom interne", () => {
    assert.equal(faviconDomain("LeMonde.fr."), "lemonde.fr");
    for (const bad of ["127.0.0.1", "[::1]", "localhost", "intranet", "a.fr:443", "a.fr/x", "a..fr", "-a.fr", "a.fr?x", "é.fr"]) {
      assert.equal(faviconDomain(bad), null, bad);
    }
  });

  it("image reconnue par ses octets : PNG, ICO, JPEG, GIF, WebP ; jamais SVG ni HTML", () => {
    assert.equal(imageType(png), "image/png");
    assert.equal(imageType(ico), "image/x-icon");
    assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(12)])), "image/jpeg");
    assert.equal(imageType(Buffer.from("GIF89a......")), "image/gif");
    assert.equal(imageType(Buffer.from("RIFF....WEBPVP8 ")), "image/webp");
    assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')), null);
    assert.equal(imageType(Buffer.from("<!doctype html><html>")), null);
  });

  it("icône déclarée par la page : https seulement, SVG ignoré, adresse relative résolue", () => {
    const html = '<link rel="icon" href="/i.svg"><link rel="icon" href="http://x.example/i.png"><link rel="shortcut icon" href="/static/i.png?v=2">';
    assert.equal(declaredIcon(html, "https://a.example/"), "https://a.example/static/i.png?v=2");
    assert.equal(declaredIcon('<link rel="stylesheet" href="/s.css">', "https://a.example/"), null);
  });

  it("repli sur l'icône déclarée ; cache par organisation ; échec gardé un temps (pas de rafale)", async () => {
    const asked: string[] = [];
    const service = new FaviconService(async (url, options) => {
      asked.push(url);
      assert.ok(options.maxBytes <= 512 * 1024);
      if (url === "https://a.example/favicon.ico") throw new Error("404");
      if (url === "https://a.example/") return { url, contentType: "text/html", fileName: null, bytes: Buffer.from('<link rel="icon" href="/i.ico">') };
      if (url === "https://a.example/i.ico") return { url, contentType: "image/x-icon", fileName: null, bytes: ico };
      throw new Error("introuvable");
    });
    assert.equal((await service.get("org-1", "a.example"))!.type, "image/x-icon");
    await service.get("org-1", "a.example");
    assert.equal(asked.length, 3);
    // Autre organisation : sa propre récupération (aucune déduction croisée par le cache).
    await service.get("org-2", "a.example");
    assert.equal(asked.length, 6);
    assert.equal(await service.get("org-1", "b.example"), null);
    const misses = asked.length;
    assert.equal(await service.get("org-1", "b.example"), null);
    assert.equal(asked.length, misses);
  });

  it("domaines autorisés de l'organisation transmis à chaque récupération", async () => {
    const seen: string[][] = [];
    const service = new FaviconService(async (url, options) => {
      seen.push(options.domains);
      return { url, contentType: "image/png", fileName: null, bytes: png };
    });
    await service.get("org-1", "a.example", ["a.example"]);
    assert.deepEqual(seen, [["a.example"]]);
  });
});
