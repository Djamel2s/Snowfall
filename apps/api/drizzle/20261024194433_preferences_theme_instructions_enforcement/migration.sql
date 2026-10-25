-- Préférences : thème parmi trois valeurs, instructions personnalisées toujours chiffrées.
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_theme_check"
  CHECK ("theme" IN ('system', 'dark', 'light'));--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_instructions_encrypted_check"
  CHECK ("instructions_enc" IS NULL OR "instructions_enc" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
