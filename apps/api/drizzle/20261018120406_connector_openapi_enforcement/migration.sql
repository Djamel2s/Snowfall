-- Connecteur OpenAPI : spécification toujours chiffrée.
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_spec_encrypted_check"
  CHECK ("spec" IS NULL OR "spec" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
