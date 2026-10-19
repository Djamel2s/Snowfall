CREATE TABLE "agent_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"name_enc" text NOT NULL,
	"prompt_enc" text NOT NULL,
	"kind" text NOT NULL,
	"cadence" text,
	"hour" integer,
	"weekday" integer,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"claimed_until" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_schedules_kind_check" CHECK ("kind" IN ('schedule', 'knowledge')),
	CONSTRAINT "agent_schedules_rule_check" CHECK (("kind" = 'knowledge' AND "cadence" IS NULL) OR ("kind" = 'schedule' AND "cadence" IN ('daily', 'weekly') AND "hour" BETWEEN 0 AND 23 AND ("cadence" = 'daily' OR "weekday" BETWEEN 0 AND 6))),
	CONSTRAINT "agent_schedules_status_check" CHECK ("last_status" IS NULL OR "last_status" IN ('done', 'paused', 'error', 'skipped')),
	CONSTRAINT "agent_schedules_timezone_check" CHECK (length("timezone") BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "agent_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "agent_schedules_due_idx" ON "agent_schedules" ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "agent_schedules_owner_idx" ON "agent_schedules" ("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "agent_schedules_owner" ON "agent_schedules" AS PERMISSIVE FOR ALL TO public USING ("agent_schedules"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "agent_schedules"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("agent_schedules"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "agent_schedules"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);