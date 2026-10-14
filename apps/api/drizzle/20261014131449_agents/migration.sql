CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"created_by" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"profile_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "agents_provider_check" CHECK ("provider" IN ('mistral', 'openai', 'anthropic', 'local')),
	CONSTRAINT "agents_model_check" CHECK (length("model") BETWEEN 1 AND 120)
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
CREATE INDEX "agents_org_idx" ON "agents" ("organization_id","updated_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "agents_tenant" ON "agents" AS PERMISSIVE FOR ALL TO public USING ("agents"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("agents"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);