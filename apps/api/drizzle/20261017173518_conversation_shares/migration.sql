CREATE TABLE "conversation_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token" text NOT NULL,
	"title" text NOT NULL,
	"snapshot" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_shares_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversation_shares_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '31 days')
);
--> statement-breakpoint
ALTER TABLE "conversation_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_shares_token_idx" ON "conversation_shares" ("token_hash");--> statement-breakpoint
CREATE INDEX "conversation_shares_conversation_idx" ON "conversation_shares" ("conversation_id");--> statement-breakpoint
ALTER TABLE "conversation_shares" ADD CONSTRAINT "conversation_shares_conversation_owner_fk" FOREIGN KEY ("conversation_id","organization_id","user_id") REFERENCES "conversations"("id","organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "conversation_shares_read" ON "conversation_shares" AS PERMISSIVE FOR SELECT TO public USING ("conversation_shares"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "conversation_shares_owner" ON "conversation_shares" AS PERMISSIVE FOR ALL TO public USING ("conversation_shares"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "conversation_shares"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("conversation_shares"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "conversation_shares"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);