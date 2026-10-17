ALTER TABLE "conversations" ADD COLUMN "current_leaf_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_id_conversation_key" UNIQUE("id","conversation_id");--> statement-breakpoint
CREATE INDEX "messages_parent_idx" ON "messages" ("conversation_id","parent_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_fk" FOREIGN KEY ("parent_id","conversation_id") REFERENCES "messages"("id","conversation_id") ON DELETE CASCADE;