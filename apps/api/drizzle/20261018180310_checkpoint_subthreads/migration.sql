ALTER TABLE "agent_checkpoint_writes" ADD COLUMN "thread_key" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "agent_checkpoints" ADD COLUMN "thread_key" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "agent_checkpoint_writes" DROP CONSTRAINT "agent_checkpoint_writes_pk";--> statement-breakpoint
ALTER TABLE "agent_checkpoint_writes" ADD CONSTRAINT "agent_checkpoint_writes_pk" PRIMARY KEY("run_id","thread_key","checkpoint_id","task_id","idx");--> statement-breakpoint
ALTER TABLE "agent_checkpoints" DROP CONSTRAINT "agent_checkpoints_pk";--> statement-breakpoint
ALTER TABLE "agent_checkpoints" ADD CONSTRAINT "agent_checkpoints_pk" PRIMARY KEY("run_id","thread_key","checkpoint_id");--> statement-breakpoint
ALTER TABLE "agent_checkpoint_writes" ADD CONSTRAINT "agent_checkpoint_writes_thread_key_check" CHECK ("thread_key" ~ '^[A-Za-z0-9_~-]{0,200}$');--> statement-breakpoint
ALTER TABLE "agent_checkpoints" ADD CONSTRAINT "agent_checkpoints_thread_key_check" CHECK ("thread_key" ~ '^[A-Za-z0-9_~-]{0,200}$');