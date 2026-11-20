ALTER TABLE "generated_files" ADD COLUMN "review" text;--> statement-breakpoint
-- Nombres à vérifier (contrôle de fidélité) : chiffrés, comme le nom et le contenu.
ALTER TABLE "generated_files" ADD CONSTRAINT "generated_files_review_encrypted_check"
  CHECK ("review" IS NULL OR "review" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
