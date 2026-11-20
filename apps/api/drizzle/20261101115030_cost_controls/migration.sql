ALTER TABLE "organization_settings" ADD COLUMN "prices" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "monthly_budget_cents" bigint;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "member_budget_cents" bigint;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "member_tool_limits" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "response_max_tokens" integer;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "response_max_seconds" integer;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "model" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage" DROP CONSTRAINT "token_usage_pkey";--> statement-breakpoint
ALTER TABLE "token_usage" ADD PRIMARY KEY ("organization_id","period","provider","model","user_id");--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_prices_check" CHECK (jsonb_typeof("prices") = 'object' AND pg_column_size("prices") <= 65536);--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_member_tool_limits_check" CHECK (jsonb_typeof("member_tool_limits") = 'object');--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_budgets_check" CHECK (("monthly_budget_cents" IS NULL OR "monthly_budget_cents" > 0) AND ("member_budget_cents" IS NULL OR "member_budget_cents" > 0));--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_response_limits_check" CHECK (("response_max_tokens" IS NULL OR "response_max_tokens" BETWEEN 1000 AND 5000000) AND ("response_max_seconds" IS NULL OR "response_max_seconds" BETWEEN 10 AND 3600));--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_model_check" CHECK (length("model") <= 120);