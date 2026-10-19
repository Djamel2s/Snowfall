CREATE TABLE "agent_eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text NOT NULL,
	"origin" text NOT NULL,
	"source_message_id" uuid,
	"question_enc" text NOT NULL,
	"comment_enc" text,
	"rubric_enc" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_eval_cases_source_unique" UNIQUE("agent_id","source_message_id"),
	CONSTRAINT "agent_eval_cases_status_check" CHECK ("status" IN ('proposed', 'active')),
	CONSTRAINT "agent_eval_cases_origin_check" CHECK ("origin" IN ('feedback', 'manual')),
	CONSTRAINT "agent_eval_cases_rubric_check" CHECK ("status" = 'proposed' OR "rubric_enc" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_eval_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"instructions_enc" text NOT NULL,
	"source" text NOT NULL,
	"score" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_agent_version_unique" UNIQUE("agent_id","version"),
	CONSTRAINT "agent_versions_source_check" CHECK ("source" IN ('edit', 'improvement', 'restore')),
	CONSTRAINT "agent_versions_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "agent_eval_cases_org_agent_idx" ON "agent_eval_cases" ("organization_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_versions_org_agent_idx" ON "agent_versions" ("organization_id","agent_id");--> statement-breakpoint
ALTER TABLE "agent_eval_cases" ADD CONSTRAINT "agent_eval_cases_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_eval_cases" ADD CONSTRAINT "agent_eval_cases_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "agent_eval_cases_tenant" ON "agent_eval_cases" AS PERMISSIVE FOR ALL TO public USING ("agent_eval_cases"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("agent_eval_cases"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_versions_tenant" ON "agent_versions" AS PERMISSIVE FOR ALL TO public USING ("agent_versions"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("agent_versions"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);