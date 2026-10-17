-- Fichiers produits par l'interpréteur de code : RLS imposée, aucun clair.
ALTER TABLE "generated_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generated_files" ADD CONSTRAINT "generated_files_encrypted_check"
  CHECK (
    "name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND "content" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  );