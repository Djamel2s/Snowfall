-- Clés d'API des fournisseurs de modèles (organisation, personnelles) : chiffrées
-- (contrainte ci-dessous, comme les autres colonnes chiffrées), RLS forcée.
CREATE TABLE "organization_model_keys" (
	"organization_id" uuid,
	"provider" text,
	"api_key" text NOT NULL,
	"hint" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_model_keys_pkey" PRIMARY KEY("organization_id","provider"),
	CONSTRAINT "organization_model_keys_provider_check" CHECK ("provider" IN ('mistral', 'openai', 'anthropic', 'google')),
	CONSTRAINT "organization_model_keys_hint_check" CHECK ("hint" ~ '^[A-Za-z0-9_-]{0,4}$')
);
--> statement-breakpoint
ALTER TABLE "organization_model_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_model_keys" (
	"organization_id" uuid,
	"user_id" uuid,
	"provider" text,
	"api_key" text NOT NULL,
	"hint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_model_keys_pkey" PRIMARY KEY("organization_id","user_id","provider"),
	CONSTRAINT "user_model_keys_provider_check" CHECK ("provider" IN ('mistral', 'openai', 'anthropic', 'google')),
	CONSTRAINT "user_model_keys_hint_check" CHECK ("hint" ~ '^[A-Za-z0-9_-]{0,4}$')
);
--> statement-breakpoint
ALTER TABLE "user_model_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "personal_key_providers" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_model_keys" ADD CONSTRAINT "organization_model_keys_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_model_keys" ADD CONSTRAINT "user_model_keys_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "organization_members"("organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_personal_keys_check" CHECK ("personal_key_providers" <@ ARRAY['mistral', 'openai', 'anthropic', 'google']::text[]);--> statement-breakpoint
CREATE POLICY "organization_model_keys_tenant" ON "organization_model_keys" AS PERMISSIVE FOR ALL TO public USING ("organization_model_keys"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_model_keys"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "user_model_keys_owner" ON "user_model_keys" AS PERMISSIVE FOR ALL TO public USING ("user_model_keys"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "user_model_keys"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("user_model_keys"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "user_model_keys"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "organization_model_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_model_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_model_keys" ADD CONSTRAINT "organization_model_keys_encrypted_check"
  CHECK ("api_key" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "user_model_keys" ADD CONSTRAINT "user_model_keys_encrypted_check"
  CHECK ("api_key" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
