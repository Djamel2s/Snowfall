ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Une conversation ne peut référencer qu'un agent de sa propre organisation.
-- À la suppression de l'agent, seule agent_id passe à NULL (PostgreSQL 15+) :
-- l'historique reste, rattaché au modèle par défaut.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_fk"
  FOREIGN KEY ("agent_id", "organization_id")
  REFERENCES "agents" ("id", "organization_id")
  ON DELETE SET NULL ("agent_id");--> statement-breakpoint
CREATE INDEX "conversations_agent_idx" ON "conversations" ("agent_id");--> statement-breakpoint

ALTER TABLE "agents" ADD CONSTRAINT "agents_profile_encrypted_check"
  CHECK ("profile_enc" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
