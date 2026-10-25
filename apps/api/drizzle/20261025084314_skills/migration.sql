CREATE TABLE "agent_skills" (
	"agent_id" uuid,
	"skill_id" uuid,
	"organization_id" uuid NOT NULL,
	CONSTRAINT "agent_skills_pkey" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"skill_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"skill_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"edited_by" uuid NOT NULL,
	"version" integer NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"confidential" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_id_org_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "agent_skills_skill_idx" ON "agent_skills" ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_files_skill_idx" ON "skill_files" ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_unique" ON "skill_versions" ("skill_id","version");--> statement-breakpoint
CREATE INDEX "skills_organization_idx" ON "skills" ("organization_id");--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_fk" FOREIGN KEY ("agent_id","organization_id") REFERENCES "agents"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_fk" FOREIGN KEY ("skill_id","organization_id") REFERENCES "skills"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skill_fk" FOREIGN KEY ("skill_id","organization_id") REFERENCES "skills"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_fk" FOREIGN KEY ("skill_id","organization_id") REFERENCES "skills"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resource_grants" DROP CONSTRAINT "resource_grants_type_check", ADD CONSTRAINT "resource_grants_type_check" CHECK ("resource_type" IN ('agent', 'prompt', 'skill'));