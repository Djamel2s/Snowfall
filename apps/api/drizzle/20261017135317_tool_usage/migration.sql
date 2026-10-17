CREATE TABLE "tool_usage" (
	"organization_id" uuid,
	"user_id" uuid,
	"meter" text,
	"period" date,
	"calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_usage_pkey" PRIMARY KEY("organization_id","period","meter","user_id"),
	CONSTRAINT "tool_usage_meter_check" CHECK ("meter" IN ('code', 'web', 'mcp')),
	CONSTRAINT "tool_usage_period_check" CHECK ("period" = date_trunc('month', "period")::date),
	CONSTRAINT "tool_usage_calls_check" CHECK ("calls" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tool_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "tool_limits" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_tool_limits_check" CHECK (jsonb_typeof("tool_limits") = 'object');--> statement-breakpoint
CREATE POLICY "tool_usage_tenant" ON "tool_usage" AS PERMISSIVE FOR ALL TO public USING ("tool_usage"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tool_usage"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);