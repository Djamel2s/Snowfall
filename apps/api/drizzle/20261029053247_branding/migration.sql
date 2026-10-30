CREATE TABLE "organization_branding" (
	"organization_id" uuid PRIMARY KEY,
	"logo" text,
	"logo_type" text,
	"color" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_branding_logo_check" CHECK (("logo" IS NULL AND "logo_type" IS NULL) OR ("logo_type" IN ('image/png', 'image/jpeg') AND length("logo") BETWEEN 1 AND 700000)),
	CONSTRAINT "organization_branding_color_check" CHECK ("color" IS NULL OR "color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "organization_branding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;