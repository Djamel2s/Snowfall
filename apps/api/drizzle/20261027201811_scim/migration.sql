CREATE TABLE "scim_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"external_id" text,
	"user_name" text NOT NULL,
	"display_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_users_user_name_check" CHECK ("user_name" = lower("user_name") AND length("user_name") BETWEEN 3 AND 254 AND "user_name" !~ '[[:space:][:cntrl:]]'),
	CONSTRAINT "scim_users_external_check" CHECK ("external_id" IS NULL OR (length("external_id") BETWEEN 1 AND 255 AND "external_id" !~ '[[:cntrl:]]')),
	CONSTRAINT "scim_users_display_check" CHECK ("display_name" IS NULL OR (length("display_name") BETWEEN 1 AND 200 AND "display_name" !~ '[[:cntrl:]]'))
);
--> statement-breakpoint
ALTER TABLE "scim_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "kind" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "scim_users_org_user_name_unique" ON "scim_users" ("organization_id","user_name");--> statement-breakpoint
CREATE INDEX "scim_users_external_idx" ON "scim_users" ("organization_id","external_id");--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_check" CHECK ("kind" IN ('api', 'scim'));--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_prefix_check", ADD CONSTRAINT "api_keys_prefix_check" CHECK ("prefix" ~ '^snowfall_(sk|scim)_[A-Za-z0-9]{6}$');--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_agents_check", ADD CONSTRAINT "api_keys_agents_check" CHECK (("kind" = 'api' AND cardinality("agent_ids") BETWEEN 1 AND 20) OR ("kind" = 'scim' AND cardinality("agent_ids") = 0));