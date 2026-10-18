-- Connexions OAuth aux serveurs MCP : RLS imposée, secrets toujours chiffrés,
-- et un jeton ne peut viser que le serveur de SA propre organisation.
ALTER TABLE "mcp_user_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_oauth_encrypted_check"
  CHECK ("oauth" IS NULL OR "oauth" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "mcp_user_tokens" ADD CONSTRAINT "mcp_user_tokens_encrypted_check"
  CHECK (
    "access_token" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND ("refresh_token" IS NULL OR "refresh_token" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
  );--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_encrypted_check"
  CHECK ("verifier" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint

-- Clés composites (serveur, organisation) : pas de jeton rattaché au serveur d'une autre organisation.
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_id_organization_unique" UNIQUE ("id", "organization_id");--> statement-breakpoint
ALTER TABLE "mcp_user_tokens" ADD CONSTRAINT "mcp_user_tokens_server_org_fk"
  FOREIGN KEY ("server_id", "organization_id") REFERENCES "mcp_servers" ("id", "organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_server_org_fk"
  FOREIGN KEY ("server_id", "organization_id") REFERENCES "mcp_servers" ("id", "organization_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "mcp_oauth_states_owner_idx" ON "mcp_oauth_states" ("organization_id", "user_id", "expires_at");
