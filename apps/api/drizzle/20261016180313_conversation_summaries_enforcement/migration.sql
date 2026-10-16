-- Résumés de compaction : RLS imposée y compris au propriétaire, aucun clair.
ALTER TABLE "conversation_summaries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_encrypted_check"
  CHECK ("summary" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
