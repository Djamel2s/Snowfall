-- Mémoire : RLS imposée (propriétaire compris) ; contenu toujours chiffré.
ALTER TABLE "user_memories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_encrypted_check"
  CHECK ("content" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
