ALTER TABLE "mcp_servers" ADD COLUMN "kind" text DEFAULT 'mcp' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "spec" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_kind_check" CHECK (("kind" = 'mcp' AND "spec" IS NULL) OR ("kind" = 'openapi' AND "spec" IS NOT NULL AND "auth" = 'token'));