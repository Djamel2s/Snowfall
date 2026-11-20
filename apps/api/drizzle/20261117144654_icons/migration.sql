-- Photo choisie comme icône d'une base de connaissances ou d'un connecteur :
-- toujours chiffrée (une photo peut montrer une personne), comme le nom de la base.
ALTER TABLE "knowledge_bases" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_icon_encrypted_check"
  CHECK ("icon" IS NULL OR "icon" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_icon_encrypted_check"
  CHECK ("icon" IS NULL OR "icon" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
