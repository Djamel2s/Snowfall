CREATE TABLE "conversation_summaries" (
	"conversation_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"upto_message_id" uuid NOT NULL,
	"covered_messages" integer NOT NULL,
	"summary" text NOT NULL,
	"model" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_summaries_covered_check" CHECK ("covered_messages" > 0),
	CONSTRAINT "conversation_summaries_model_check" CHECK (length("model") BETWEEN 1 AND 160)
);
--> statement-breakpoint
ALTER TABLE "conversation_summaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_fk" FOREIGN KEY ("conversation_id","organization_id","user_id") REFERENCES "conversations"("id","organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "conversation_summaries_tenant" ON "conversation_summaries" AS PERMISSIVE FOR ALL TO public USING ("conversation_summaries"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "conversation_summaries"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("conversation_summaries"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "conversation_summaries"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);