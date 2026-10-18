CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prompts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "prompts_organization_idx" ON "prompts" ("organization_id");--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "prompts_read" ON "prompts" AS PERMISSIVE FOR SELECT TO public USING ("prompts"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND ("prompts"."shared" OR "prompts"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "prompts_owner" ON "prompts" AS PERMISSIVE FOR ALL TO public USING ("prompts"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "prompts"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("prompts"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "prompts"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);