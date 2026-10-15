ALTER TABLE "conversations" ADD COLUMN "model_provider" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_model_check" CHECK (("model_provider" IS NULL AND "model_id" IS NULL) OR (
        "model_provider" IN ('mistral', 'openai', 'anthropic', 'google', 'local')
        AND length("model_id") BETWEEN 1 AND 120
        AND "agent_id" IS NULL));