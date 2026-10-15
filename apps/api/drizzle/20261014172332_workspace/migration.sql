CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"kind" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"extracted_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_kind_check" CHECK ("kind" IN ('document', 'image')),
	CONSTRAINT "attachments_media_type_check" CHECK (media_type IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "attachments_size_check" CHECK (size_bytes BETWEEN 1 AND 10485760)
);
--> statement-breakpoint
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	CONSTRAINT "organization_invitations_role_check" CHECK ("role" IN ('admin', 'member', 'reader')),
	CONSTRAINT "organization_invitations_email_check" CHECK (length("email") BETWEEN 3 AND 254 AND "email" ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);
--> statement-breakpoint
ALTER TABLE "organization_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" uuid PRIMARY KEY,
	"allowed_providers" text[] DEFAULT ARRAY['mistral', 'openai', 'anthropic', 'google', 'local']::text[] NOT NULL,
	"monthly_token_limit" bigint,
	"provider_token_limits" jsonb DEFAULT '{}' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_settings_providers_check" CHECK ("allowed_providers" <@ ARRAY['mistral', 'openai', 'anthropic', 'google', 'local']::text[]),
	CONSTRAINT "organization_settings_limit_check" CHECK ("monthly_token_limit" IS NULL OR "monthly_token_limit" > 0),
	CONSTRAINT "organization_settings_provider_limits_check" CHECK (jsonb_typeof("provider_token_limits") = 'object')
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_id_org_user_unique" UNIQUE("id","organization_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "token_usage" (
	"organization_id" uuid,
	"user_id" uuid,
	"provider" text,
	"period" date,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_usage_pkey" PRIMARY KEY("organization_id","period","provider","user_id"),
	CONSTRAINT "token_usage_provider_check" CHECK ("provider" IN ('mistral', 'openai', 'anthropic', 'google', 'local', 'echo')),
	CONSTRAINT "token_usage_period_check" CHECK ("period" = date_trunc('month', "period")::date),
	CONSTRAINT "token_usage_counts_check" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "token_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"organization_id" uuid,
	"user_id" uuid,
	"locale" text,
	"send_on_enter" boolean DEFAULT true NOT NULL,
	"reduce_motion" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_pkey" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "user_preferences_locale_check" CHECK ("locale" IS NULL OR "locale" IN ('fr', 'en')),
	CONSTRAINT "user_preferences_motion_check" CHECK ("reduce_motion" IN ('system', 'on', 'off'))
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sso_alias" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sso_default_role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idp_session_id" text;--> statement-breakpoint
CREATE INDEX "attachments_conversation_idx" ON "attachments" ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitations_pending_idx" ON "organization_invitations" ("organization_id",lower("email")) WHERE "accepted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "organization_invitations_email_idx" ON "organization_invitations" (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_sso_alias_idx" ON "organizations" ("sso_alias");--> statement-breakpoint
CREATE INDEX "projects_org_user_idx" ON "projects" ("organization_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "sessions_idp_session_idx" ON "sessions" ("idp_session_id");--> statement-breakpoint
CREATE INDEX "sessions_subject_idx" ON "sessions" ("subject");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_conversation_owner_fk" FOREIGN KEY ("conversation_id","organization_id","user_id") REFERENCES "conversations"("id","organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "organization_members"("organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "organization_members"("organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_sso_alias_check" CHECK ("sso_alias" ~ '^[a-z0-9][a-z0-9-]{1,62}$');--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_sso_role_check" CHECK ("sso_default_role" IN ('member', 'reader'));--> statement-breakpoint
CREATE POLICY "attachments_owner" ON "attachments" AS PERMISSIVE FOR ALL TO public USING ("attachments"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "attachments"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("attachments"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "attachments"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_invitations_tenant" ON "organization_invitations" AS PERMISSIVE FOR ALL TO public USING ("organization_invitations"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_invitations"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_settings_tenant" ON "organization_settings" AS PERMISSIVE FOR ALL TO public USING ("organization_settings"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_settings"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_owner" ON "projects" AS PERMISSIVE FOR ALL TO public USING ("projects"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "projects"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("projects"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "projects"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "token_usage_tenant" ON "token_usage" AS PERMISSIVE FOR ALL TO public USING ("token_usage"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("token_usage"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "user_preferences_owner" ON "user_preferences" AS PERMISSIVE FOR ALL TO public USING ("user_preferences"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "user_preferences"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("user_preferences"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "user_preferences"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);