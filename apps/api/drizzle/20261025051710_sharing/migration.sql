CREATE TABLE "member_group_members" (
	"group_id" uuid,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	CONSTRAINT "member_group_members_pkey" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "member_group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "member_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_groups_id_org_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "member_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "resource_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid,
	"permission" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_grants_type_check" CHECK ("resource_type" IN ('agent', 'prompt')),
	CONSTRAINT "resource_grants_permission_check" CHECK ("permission" IN ('view', 'edit')),
	CONSTRAINT "resource_grants_principal_check" CHECK (("principal_type" = 'organization' AND "principal_id" IS NULL) OR ("principal_type" IN ('user', 'group') AND "principal_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "resource_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "member_group_members_user_idx" ON "member_group_members" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "member_groups_organization_idx" ON "member_groups" ("organization_id");--> statement-breakpoint
CREATE INDEX "resource_grants_resource_idx" ON "resource_grants" ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "resource_grants_principal_idx" ON "resource_grants" ("organization_id","principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_grants_unique" ON "resource_grants" ("resource_type","resource_id","principal_type",coalesce("principal_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
ALTER TABLE "member_group_members" ADD CONSTRAINT "member_group_members_group_fk" FOREIGN KEY ("group_id","organization_id") REFERENCES "member_groups"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member_group_members" ADD CONSTRAINT "member_group_members_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "organization_members"("organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member_groups" ADD CONSTRAINT "member_groups_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;