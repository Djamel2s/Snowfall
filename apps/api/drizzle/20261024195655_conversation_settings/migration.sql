CREATE TABLE "conversation_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"creativity" text,
	"length" text,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_presets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "creativity" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "length" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "tags" text;--> statement-breakpoint
CREATE INDEX "conversation_presets_owner_idx" ON "conversation_presets" ("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "conversation_presets" ADD CONSTRAINT "conversation_presets_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "organization_members"("organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "conversation_presets_owner" ON "conversation_presets" AS PERMISSIVE FOR ALL TO public USING ("conversation_presets"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "conversation_presets"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("conversation_presets"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "conversation_presets"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);