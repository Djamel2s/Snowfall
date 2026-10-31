ALTER TABLE "messages" ADD COLUMN "activity" text;--> statement-breakpoint
-- Activité d'une réponse : chiffrée comme le contenu et les sources (jamais en clair).
ALTER TABLE "messages" ADD CONSTRAINT "messages_activity_encrypted_check"
  CHECK ("activity" IS NULL OR "activity" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
