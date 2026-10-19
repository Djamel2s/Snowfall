-- Atelier d'entraînement : RLS imposée, textes et têtes toujours chiffrés,
-- un seul modèle actif par organisation et par tâche, mesures sans texte.
ALTER TABLE "decision_examples" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decision_models" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "decision_examples" ADD CONSTRAINT "decision_examples_encrypted_check"
  CHECK ("text_enc" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "decision_models" ADD CONSTRAINT "decision_models_encrypted_check"
  CHECK ("head_enc" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "decision_models" ADD CONSTRAINT "decision_models_metrics_shape"
  CHECK (jsonb_typeof("metrics") = 'object' AND pg_column_size("metrics") < 2048);--> statement-breakpoint

CREATE UNIQUE INDEX "decision_models_one_active" ON "decision_models" ("organization_id", "task") WHERE "status" = 'active';
