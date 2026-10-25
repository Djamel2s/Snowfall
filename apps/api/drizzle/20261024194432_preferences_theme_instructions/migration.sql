ALTER TABLE "user_preferences" ADD COLUMN "theme" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "instructions_enc" text;