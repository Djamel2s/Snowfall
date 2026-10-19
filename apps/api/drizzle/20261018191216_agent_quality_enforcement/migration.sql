-- Qualité des agents : RLS imposée, contenus toujours chiffrés, et une version
-- ou un cas ne peut viser que l'agent de SA propre organisation (effacé avec lui).
ALTER TABLE "agent_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_eval_cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_encrypted_check"
  CHECK ("instructions_enc" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "agent_eval_cases" ADD CONSTRAINT "agent_eval_cases_encrypted_check"
  CHECK (
    "question_enc" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND ("comment_enc" IS NULL OR "comment_enc" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
    AND ("rubric_enc" IS NULL OR "rubric_enc" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
  );--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_score_shape"
  CHECK ("score" IS NULL OR (jsonb_typeof("score") = 'object' AND pg_column_size("score") < 512));--> statement-breakpoint

ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_org_fk"
  FOREIGN KEY ("agent_id", "organization_id") REFERENCES "agents" ("id", "organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_eval_cases" ADD CONSTRAINT "agent_eval_cases_agent_org_fk"
  FOREIGN KEY ("agent_id", "organization_id") REFERENCES "agents" ("id", "organization_id") ON DELETE CASCADE;
