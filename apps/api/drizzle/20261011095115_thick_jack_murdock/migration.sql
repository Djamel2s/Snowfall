CREATE TABLE "external_identities" (
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_identities_issuer_subject_unique" UNIQUE("issuer","subject")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_user_idx" ON "external_identities" ("user_id");--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;