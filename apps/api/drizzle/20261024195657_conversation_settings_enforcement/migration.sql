-- Réglages de conversation : valeurs bornées, instructions et étiquettes toujours chiffrées.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_settings_check"
  CHECK (
    ("creativity" IS NULL OR "creativity" IN ('precise', 'balanced', 'creative'))
    AND ("length" IS NULL OR "length" IN ('concise', 'complete'))
  );--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_instructions_encrypted_check"
  CHECK ("instructions" IS NULL OR "instructions" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tags_encrypted_check"
  CHECK ("tags" IS NULL OR "tags" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
-- Une conversation temporaire n'est ni archivée ni étiquetée (elle disparaît en 24 h).
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_temporary_unfiled_check"
  CHECK (NOT "temporary" OR (NOT "archived" AND "tags" IS NULL));--> statement-breakpoint
-- Préréglages : RLS imposée, privés, chiffrés, bornés.
ALTER TABLE "conversation_presets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_presets" ADD CONSTRAINT "conversation_presets_settings_check"
  CHECK (
    ("creativity" IS NULL OR "creativity" IN ('precise', 'balanced', 'creative'))
    AND ("length" IS NULL OR "length" IN ('concise', 'complete'))
  );--> statement-breakpoint
ALTER TABLE "conversation_presets" ADD CONSTRAINT "conversation_presets_encrypted_check"
  CHECK (
    "name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND ("instructions" IS NULL OR "instructions" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
  );
