CREATE TABLE "mcp_oauth_states" (
	"state_hash" text PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mcp_oauth_states_hash_check" CHECK ("state_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mcp_user_tokens" (
	"server_id" uuid,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_user_tokens_pkey" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_user_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "auth" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_server_id_mcp_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "organization_members"("organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_user_tokens" ADD CONSTRAINT "mcp_user_tokens_server_id_mcp_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_user_tokens" ADD CONSTRAINT "mcp_user_tokens_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "organization_members"("organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_auth_check" CHECK (("auth" = 'token' AND "oauth" IS NULL) OR ("auth" = 'oauth' AND "oauth" IS NOT NULL AND "token" IS NULL));--> statement-breakpoint
CREATE POLICY "mcp_oauth_states_owner" ON "mcp_oauth_states" AS PERMISSIVE FOR ALL TO public USING ("mcp_oauth_states"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "mcp_oauth_states"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("mcp_oauth_states"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "mcp_oauth_states"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "mcp_user_tokens_owner" ON "mcp_user_tokens" AS PERMISSIVE FOR ALL TO public USING ("mcp_user_tokens"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "mcp_user_tokens"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("mcp_user_tokens"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "mcp_user_tokens"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);