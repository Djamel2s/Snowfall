-- Retour sur les réponses : RLS imposée, commentaire toujours chiffré.
ALTER TABLE "message_feedback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_comment_encrypted_check"
  CHECK ("comment" IS NULL OR "comment" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
