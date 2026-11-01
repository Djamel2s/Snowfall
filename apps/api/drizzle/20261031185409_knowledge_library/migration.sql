CREATE TABLE "agent_knowledge_bases" (
	"agent_id" uuid,
	"organization_id" uuid NOT NULL,
	"base_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_knowledge_bases_pkey" PRIMARY KEY("agent_id","base_id")
);
--> statement-breakpoint
ALTER TABLE "agent_knowledge_bases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_folders_id_base_unique" UNIQUE("id","base_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_knowledge_bases" (
	"project_id" uuid,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"base_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_knowledge_bases_pkey" PRIMARY KEY("project_id","base_id")
);
--> statement-breakpoint
ALTER TABLE "project_knowledge_bases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
CREATE INDEX "agent_knowledge_bases_base_idx" ON "agent_knowledge_bases" ("base_id");--> statement-breakpoint
CREATE INDEX "knowledge_folders_base_idx" ON "knowledge_folders" ("base_id","parent_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_folder_idx" ON "knowledge_sources" ("base_id","folder_id");--> statement-breakpoint
CREATE INDEX "project_knowledge_bases_base_idx" ON "project_knowledge_bases" ("base_id");--> statement-breakpoint
ALTER TABLE "agent_knowledge_bases" ADD CONSTRAINT "agent_knowledge_bases_agent_fk" FOREIGN KEY ("agent_id","organization_id") REFERENCES "agents"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_knowledge_bases" ADD CONSTRAINT "agent_knowledge_bases_base_fk" FOREIGN KEY ("base_id","organization_id") REFERENCES "knowledge_bases"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_folders" ADD CONSTRAINT "knowledge_folders_base_fk" FOREIGN KEY ("base_id","organization_id") REFERENCES "knowledge_bases"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_folders" ADD CONSTRAINT "knowledge_folders_parent_fk" FOREIGN KEY ("parent_id","base_id") REFERENCES "knowledge_folders"("id","base_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_folder_fk" FOREIGN KEY ("folder_id","base_id") REFERENCES "knowledge_folders"("id","base_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_knowledge_bases" ADD CONSTRAINT "project_knowledge_bases_project_fk" FOREIGN KEY ("project_id","organization_id","user_id") REFERENCES "projects"("id","organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_knowledge_bases" ADD CONSTRAINT "project_knowledge_bases_base_fk" FOREIGN KEY ("base_id","organization_id") REFERENCES "knowledge_bases"("id","organization_id") ON DELETE CASCADE;