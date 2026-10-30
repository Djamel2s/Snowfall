CREATE TABLE "organization_retention" (
	"organization_id" uuid PRIMARY KEY,
	"conversation_days" integer,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_retention_days_check" CHECK ("conversation_days" IS NULL OR "conversation_days" BETWEEN 30 AND 3650)
);
--> statement-breakpoint
ALTER TABLE "organization_retention" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_retention" ADD CONSTRAINT "organization_retention_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;