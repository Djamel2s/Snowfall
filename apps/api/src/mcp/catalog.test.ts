import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateMcpUrl } from "./client.js";
import { catalogIdFor, CONNECTOR_CATALOG, connectorUrl } from "./catalog.js";

describe("Catalogue de connecteurs", () => {
  it("chaque entrée est cohérente : identifiant unique, HTTPS public, pas d'ancien transport SSE", () => {
    const ids = new Set<string>();
    for (const connector of CONNECTOR_CATALOG) {
      assert.match(connector.id, /^[a-z0-9-]{1,60}$/);
      assert.ok(!ids.has(connector.id), connector.id);
      ids.add(connector.id);
      const url = connectorUrl(connector, "11111111-2222-3333-4444-555555555555")!;
      assert.doesNotThrow(() => validateMcpUrl(url, false), connector.id);
      assert.ok(!/\/sse\/?$/.test(url), `${connector.id} : transport SSE non pris en charge`);
      assert.match(connector.color, /^#[0-9A-Fa-f]{6}$/);
      if (connector.docs) assert.match(connector.docs, /^https:\/\//);
    }
    assert.ok(CONNECTOR_CATALOG.length >= 50);
  });

  it("tenant Microsoft : un GUID et rien d'autre ; l'adresse retrouve son connecteur", () => {
    const sharepoint = CONNECTOR_CATALOG.find((item) => item.id === "sharepoint-onedrive")!;
    assert.equal(connectorUrl(sharepoint), null);
    assert.equal(connectorUrl(sharepoint, "../../evil"), null);
    assert.equal(connectorUrl(sharepoint, "11111111-2222-3333-4444-555555555555/../x"), null);
    const url = connectorUrl(sharepoint, "11111111-2222-3333-4444-555555555555")!;
    assert.equal(catalogIdFor(url), "sharepoint-onedrive");
    assert.equal(catalogIdFor("https://mcp.notion.com/mcp"), "notion");
    assert.equal(catalogIdFor("https://evil.example/mcp"), null);
  });
});
