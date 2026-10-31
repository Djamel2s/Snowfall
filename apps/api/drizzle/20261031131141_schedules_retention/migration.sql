-- Conservation : la conversation d'une tâche planifiée n'échoit jamais tant que la
-- tâche existe. Sans cela, une tâche en pause (ou un déclencheur sans nouveau
-- document) voyait sa conversation effacée, et la tâche avec elle (clé étrangère
-- en cascade). La purge ne lit pas agent_schedules (RLS imposée, auteur seul) :
-- la file d'échéances, déjà sans contenu, porte désormais la conversation.
ALTER TABLE "agent_schedule_queue" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint

ALTER TABLE "agent_schedules" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "agent_schedule_queue" q SET "conversation_id" = s."conversation_id"
  FROM "agent_schedules" s WHERE s."id" = q."schedule_id";--> statement-breakpoint
ALTER TABLE "agent_schedules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Ligne de file sans tâche correspondante : impossible (cascade), mais jamais de NULL ensuite.
DELETE FROM "agent_schedule_queue" WHERE "conversation_id" IS NULL;--> statement-breakpoint
ALTER TABLE "agent_schedule_queue" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_schedule_queue_conversation_idx" ON "agent_schedule_queue" ("conversation_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION "agent_schedules_queue"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO agent_schedule_queue (schedule_id, organization_id, user_id, conversation_id, kind, enabled, next_run_at, checked_at, claimed_until, created_at)
  VALUES (NEW.id, NEW.organization_id, NEW.user_id, NEW.conversation_id, NEW.kind, NEW.enabled, NEW.next_run_at, NEW.checked_at, NEW.claimed_until, NEW.created_at)
  ON CONFLICT (schedule_id) DO UPDATE SET
    conversation_id = EXCLUDED.conversation_id,
    enabled = EXCLUDED.enabled, next_run_at = EXCLUDED.next_run_at, checked_at = EXCLUDED.checked_at,
    claimed_until = CASE WHEN TG_OP = 'UPDATE' AND NEW.claimed_until IS DISTINCT FROM OLD.claimed_until
      THEN EXCLUDED.claimed_until ELSE agent_schedule_queue.claimed_until END;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "snowfall_retention_expired"()
RETURNS TABLE (conversation_id uuid, organization_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.conversation_id, a.organization_id, a.user_id
  FROM conversation_activity a
  JOIN organization_retention r ON r.organization_id = a.organization_id
  WHERE r.conversation_days IS NOT NULL
    AND a.last_activity < now() - make_interval(days => r.conversation_days)
    AND NOT EXISTS (SELECT 1 FROM agent_schedule_queue q WHERE q.conversation_id = a.conversation_id)
  ORDER BY a.last_activity
  LIMIT 200;
$$;
