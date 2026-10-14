CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_user_id" uuid,
	"organization_id" uuid,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"request_id" text,
	"details" jsonb DEFAULT '{}' NOT NULL,
	CONSTRAINT "audit_events_outcome_check" CHECK ("outcome" IN ('success', 'failure', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "organization_keys" (
	"organization_id" uuid,
	"version" integer,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_keys_pkey" PRIMARY KEY("organization_id","version"),
	CONSTRAINT "organization_keys_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
ALTER TABLE "organization_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"id_token_enc" text NOT NULL,
	"profile_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "title" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_org_occurred_idx" ON "audit_events" ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" ("expires_at");--> statement-breakpoint
ALTER TABLE "organization_keys" ADD CONSTRAINT "organization_keys_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "conversations_owner" ON "conversations" AS PERMISSIVE FOR ALL TO public USING ("conversations"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "conversations"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("conversations"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "conversations"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "messages_owner" ON "messages" AS PERMISSIVE FOR ALL TO public USING ("messages"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "messages"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("messages"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "messages"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_keys_tenant" ON "organization_keys" AS PERMISSIVE FOR ALL TO public USING ("organization_keys"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_keys"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);