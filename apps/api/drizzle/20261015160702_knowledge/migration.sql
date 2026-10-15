CREATE TABLE "knowledge_bases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid,
	"project_id" uuid,
	"user_id" uuid,
	"confidential" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_bases_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "knowledge_bases_owner_check" CHECK (("agent_id" IS NOT NULL AND "project_id" IS NULL AND "user_id" IS NULL)
        OR ("agent_id" IS NULL AND "project_id" IS NOT NULL AND "user_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "knowledge_bases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"user_id" uuid,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" text,
	CONSTRAINT "knowledge_chunks_ordinal_check" CHECK ("ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"user_id" uuid,
	"created_by" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"media_type" text,
	"size_bytes" integer NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"content" text NOT NULL,
	"embedding_model" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_sources_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "knowledge_sources_kind_check" CHECK ("kind" IN ('file', 'link')),
	CONSTRAINT "knowledge_sources_status_check" CHECK ("status" IN ('pending', 'processing', 'ready', 'error')),
	CONSTRAINT "knowledge_sources_error_check" CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "knowledge_sources_media_check" CHECK ("media_type" IS NULL OR length("media_type") BETWEEN 3 AND 120),
	CONSTRAINT "knowledge_sources_size_check" CHECK (size_bytes BETWEEN 0 AND 26214400),
	CONSTRAINT "knowledge_sources_model_check" CHECK ("embedding_model" IS NULL OR length("embedding_model") BETWEEN 3 AND 160),
	CONSTRAINT "knowledge_sources_url_check" CHECK (("kind" = 'link') = ("url" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "use_agent_knowledge" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "use_project_knowledge" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sources" text;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "embedding_provider" text;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "links_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "link_domains" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_bases_agent_idx" ON "knowledge_bases" ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_bases_project_idx" ON "knowledge_bases" ("project_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_base_idx" ON "knowledge_chunks" ("base_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_source_idx" ON "knowledge_chunks" ("source_id","ordinal");--> statement-breakpoint
CREATE INDEX "knowledge_sources_base_idx" ON "knowledge_sources" ("base_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_sources_status_idx" ON "knowledge_sources" ("status");--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_agent_fk" FOREIGN KEY ("agent_id","organization_id") REFERENCES "agents"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_project_fk" FOREIGN KEY ("project_id","organization_id","user_id") REFERENCES "projects"("id","organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_fk" FOREIGN KEY ("source_id","organization_id") REFERENCES "knowledge_sources"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_base_fk" FOREIGN KEY ("base_id","organization_id") REFERENCES "knowledge_bases"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_embedding_check" CHECK ("embedding_provider" IS NULL OR "embedding_provider" IN ('mistral', 'openai', 'google', 'local'));--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_link_domains_check" CHECK (cardinality("link_domains") <= 200);--> statement-breakpoint
CREATE POLICY "knowledge_bases_tenant" ON "knowledge_bases" AS PERMISSIVE FOR ALL TO public USING ("knowledge_bases"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND ("knowledge_bases"."user_id" IS NULL OR "knowledge_bases"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid)) WITH CHECK ("knowledge_bases"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND ("knowledge_bases"."user_id" IS NULL OR "knowledge_bases"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "knowledge_chunks_tenant" ON "knowledge_chunks" AS PERMISSIVE FOR ALL TO public USING ("knowledge_chunks"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND ("knowledge_chunks"."user_id" IS NULL OR "knowledge_chunks"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid)) WITH CHECK ("knowledge_chunks"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND ("knowledge_chunks"."user_id" IS NULL OR "knowledge_chunks"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "knowledge_sources_tenant" ON "knowledge_sources" AS PERMISSIVE FOR ALL TO public USING ("knowledge_sources"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND ("knowledge_sources"."user_id" IS NULL OR "knowledge_sources"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid)) WITH CHECK ("knowledge_sources"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND ("knowledge_sources"."user_id" IS NULL OR "knowledge_sources"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid));