CREATE TABLE "message_feedback" (
	"message_id" uuid PRIMARY KEY,
	"conversation_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_feedback_rating_check" CHECK ("rating" IN (-1, 1))
);
--> statement-breakpoint
ALTER TABLE "message_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_message_fk" FOREIGN KEY ("message_id","conversation_id") REFERENCES "messages"("id","conversation_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_conversation_owner_fk" FOREIGN KEY ("conversation_id","organization_id","user_id") REFERENCES "conversations"("id","organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "message_feedback_owner" ON "message_feedback" AS PERMISSIVE FOR ALL TO public USING ("message_feedback"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "message_feedback"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("message_feedback"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "message_feedback"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);