CREATE TABLE "organization_model_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text,
	"hint" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_model_providers_name_check" CHECK (length("name") BETWEEN 1 AND 60),
	CONSTRAINT "organization_model_providers_url_check" CHECK ("base_url" LIKE 'https://%' AND length("base_url") <= 500),
	CONSTRAINT "organization_model_providers_hint_check" CHECK ("hint" IS NULL OR "hint" ~ '^[A-Za-z0-9_-]{0,4}$'),
	CONSTRAINT "organization_model_providers_key_check" CHECK (("api_key" IS NULL) = ("hint" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "organization_model_providers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_settings" ALTER COLUMN "allowed_providers" SET DEFAULT ARRAY['mistral', 'openai', 'anthropic', 'google', 'local', 'custom']::text[];--> statement-breakpoint
CREATE INDEX "organization_model_providers_org_idx" ON "organization_model_providers" ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "organization_model_providers" ADD CONSTRAINT "organization_model_providers_mw15eRLzlQmb_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_provider_check", ADD CONSTRAINT "agents_provider_check" CHECK ("provider" IN ('mistral', 'openai', 'anthropic', 'google', 'local', 'custom'));--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_model_check", ADD CONSTRAINT "conversations_model_check" CHECK (("model_provider" IS NULL AND "model_id" IS NULL) OR (
        "model_provider" IN ('mistral', 'openai', 'anthropic', 'google', 'local', 'custom')
        AND length("model_id") BETWEEN 1 AND 120
        AND "agent_id" IS NULL));--> statement-breakpoint
ALTER TABLE "organization_settings" DROP CONSTRAINT "organization_settings_providers_check", ADD CONSTRAINT "organization_settings_providers_check" CHECK ("allowed_providers" <@ ARRAY['mistral', 'openai', 'anthropic', 'google', 'local', 'custom']::text[]);--> statement-breakpoint
ALTER TABLE "token_usage" DROP CONSTRAINT "token_usage_provider_check", ADD CONSTRAINT "token_usage_provider_check" CHECK ("provider" IN ('mistral', 'openai', 'anthropic', 'google', 'local', 'custom', 'echo'));--> statement-breakpoint
CREATE POLICY "organization_model_providers_tenant" ON "organization_model_providers" AS PERMISSIVE FOR ALL TO public USING ("organization_model_providers"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_model_providers"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "organization_model_providers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_model_providers" ADD CONSTRAINT "organization_model_providers_encrypted_check"
  CHECK ("api_key" IS NULL OR "api_key" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
-- Les fournisseurs personnalisés sont ajoutés par un administrateur : autorisés par défaut,
-- comme les autres fournisseurs (la liste blanche reste modifiable dans l'administration).
UPDATE "organization_settings" SET "allowed_providers" = array_append("allowed_providers", 'custom')
  WHERE NOT ('custom' = ANY("allowed_providers"));
