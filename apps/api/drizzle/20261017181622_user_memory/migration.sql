CREATE TABLE "user_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "memory_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "user_memories_owner_idx" ON "user_memories" ("organization_id","user_id","created_at");--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "organization_members"("organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "user_memories_owner" ON "user_memories" AS PERMISSIVE FOR ALL TO public USING ("user_memories"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "user_memories"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("user_memories"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "user_memories"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);