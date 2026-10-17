CREATE TABLE "generated_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generated_files_media_type_check" CHECK (media_type IN ('image/png', 'image/jpeg', 'image/svg+xml', 'text/csv', 'text/plain', 'text/markdown', 'application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf')),
	CONSTRAINT "generated_files_size_check" CHECK (size_bytes BETWEEN 1 AND 5242880)
);
--> statement-breakpoint
ALTER TABLE "generated_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "generated_files_conversation_idx" ON "generated_files" ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "generated_files_message_idx" ON "generated_files" ("message_id");--> statement-breakpoint
ALTER TABLE "generated_files" ADD CONSTRAINT "generated_files_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "generated_files" ADD CONSTRAINT "generated_files_conversation_owner_fk" FOREIGN KEY ("conversation_id","organization_id","user_id") REFERENCES "conversations"("id","organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "generated_files_owner" ON "generated_files" AS PERMISSIVE FOR ALL TO public USING ("generated_files"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "generated_files"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("generated_files"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "generated_files"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);