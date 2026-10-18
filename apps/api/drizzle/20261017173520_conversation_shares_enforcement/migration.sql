-- Partages : RLS imposée ; jeton (pour le recopier), titre et instantané chiffrés.
ALTER TABLE "conversation_shares" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_shares" ADD CONSTRAINT "conversation_shares_encrypted_check"
  CHECK (
    "token" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND "title" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND "snapshot" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  );
