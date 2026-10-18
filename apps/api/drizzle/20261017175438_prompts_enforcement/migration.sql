-- Prompts : RLS imposée ; nom et contenu toujours chiffrés.
ALTER TABLE "prompts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_encrypted_check"
  CHECK (
    "name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND "content" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  );
