DROP INDEX "users_email_idx";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_role_check" CHECK ("role" IN ('user', 'assistant'));--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_role_check" CHECK ("role" IN ('owner', 'admin', 'member', 'reader'));