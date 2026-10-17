CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"token" text,
	"tools" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_status_check" CHECK ("status" IN ('pending', 'approved', 'disabled')),
	CONSTRAINT "mcp_servers_name_check" CHECK (length("name") BETWEEN 1 AND 60)
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "mcp_servers_organization_idx" ON "mcp_servers" ("organization_id");--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "mcp_servers_tenant" ON "mcp_servers" AS PERMISSIVE FOR ALL TO public USING ("mcp_servers"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("mcp_servers"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);