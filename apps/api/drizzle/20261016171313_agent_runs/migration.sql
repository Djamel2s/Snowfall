CREATE TABLE "agent_checkpoint_writes" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid,
	"checkpoint_id" text,
	"task_id" text,
	"idx" integer,
	"channel" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "agent_checkpoint_writes_pk" PRIMARY KEY("run_id","checkpoint_id","task_id","idx"),
	CONSTRAINT "agent_checkpoint_writes_task_check" CHECK (length("task_id") BETWEEN 1 AND 64),
	CONSTRAINT "agent_checkpoint_writes_channel_check" CHECK (length("channel") BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "agent_checkpoint_writes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_checkpoints" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid,
	"checkpoint_id" text,
	"parent_id" text,
	"checkpoint" text NOT NULL,
	"metadata" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_checkpoints_pk" PRIMARY KEY("run_id","checkpoint_id"),
	CONSTRAINT "agent_checkpoints_id_check" CHECK (length("checkpoint_id") BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "agent_checkpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"request" text NOT NULL,
	"progress" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_id_org_user_unique" UNIQUE("id","organization_id","user_id"),
	CONSTRAINT "agent_runs_kind_check" CHECK ("kind" IN ('message', 'regenerate')),
	CONSTRAINT "agent_runs_status_check" CHECK ("status" IN ('running', 'waiting', 'done', 'failed', 'cancelled')),
	CONSTRAINT "agent_runs_lease_owner_check" CHECK ("lease_owner" IS NULL OR length("lease_owner") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_idx" ON "agent_runs" ("conversation_id") WHERE "status" IN ('running', 'waiting');--> statement-breakpoint
CREATE INDEX "agent_runs_lease_idx" ON "agent_runs" ("status","lease_until");--> statement-breakpoint
ALTER TABLE "agent_checkpoint_writes" ADD CONSTRAINT "agent_checkpoint_writes_run_fk" FOREIGN KEY ("run_id","organization_id","user_id") REFERENCES "agent_runs"("id","organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_checkpoints" ADD CONSTRAINT "agent_checkpoints_run_fk" FOREIGN KEY ("run_id","organization_id","user_id") REFERENCES "agent_runs"("id","organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_fk" FOREIGN KEY ("conversation_id","organization_id","user_id") REFERENCES "conversations"("id","organization_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "agent_checkpoint_writes_tenant" ON "agent_checkpoint_writes" AS PERMISSIVE FOR ALL TO public USING ("agent_checkpoint_writes"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "agent_checkpoint_writes"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("agent_checkpoint_writes"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "agent_checkpoint_writes"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_checkpoints_tenant" ON "agent_checkpoints" AS PERMISSIVE FOR ALL TO public USING ("agent_checkpoints"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "agent_checkpoints"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("agent_checkpoints"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "agent_checkpoints"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_runs_tenant" ON "agent_runs" AS PERMISSIVE FOR ALL TO public USING ("agent_runs"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "agent_runs"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("agent_runs"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "agent_runs"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);