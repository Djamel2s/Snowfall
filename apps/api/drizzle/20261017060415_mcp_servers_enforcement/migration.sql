-- Serveurs MCP : RLS imposée, adresse, jeton et outils approuvés chiffrés.
ALTER TABLE "mcp_servers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_encrypted_check"
  CHECK (
    "url" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND ("token" IS NULL OR "token" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
    AND ("tools" IS NULL OR "tools" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
  );