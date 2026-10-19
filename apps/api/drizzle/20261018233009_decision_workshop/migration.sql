CREATE TABLE "decision_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"task" text NOT NULL,
	"text_enc" text NOT NULL,
	"label" text NOT NULL,
	"split" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_examples_task_check" CHECK ("task" IN ('routing')),
	CONSTRAINT "decision_examples_label_check" CHECK ("label" ~ '^[a-z0-9_-]{1,40}$'),
	CONSTRAINT "decision_examples_split_check" CHECK ("split" IN ('train', 'test'))
);
--> statement-breakpoint
ALTER TABLE "decision_examples" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "decision_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"task" text NOT NULL,
	"version" integer NOT NULL,
	"head_enc" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"deployable" boolean NOT NULL,
	"status" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "decision_models_version_unique" UNIQUE("organization_id","task","version"),
	CONSTRAINT "decision_models_task_check" CHECK ("task" IN ('routing')),
	CONSTRAINT "decision_models_status_check" CHECK ("status" IN ('candidate', 'active', 'retired')),
	CONSTRAINT "decision_models_active_check" CHECK ("status" <> 'active' OR "deployable")
);
--> statement-breakpoint
ALTER TABLE "decision_models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "decision_examples_org_task_idx" ON "decision_examples" ("organization_id","task");--> statement-breakpoint
ALTER TABLE "decision_examples" ADD CONSTRAINT "decision_examples_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "decision_examples" ADD CONSTRAINT "decision_examples_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "decision_models" ADD CONSTRAINT "decision_models_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "decision_models" ADD CONSTRAINT "decision_models_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "decision_examples_tenant" ON "decision_examples" AS PERMISSIVE FOR ALL TO public USING ("decision_examples"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("decision_examples"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "decision_models_tenant" ON "decision_models" AS PERMISSIVE FOR ALL TO public USING ("decision_models"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("decision_models"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);