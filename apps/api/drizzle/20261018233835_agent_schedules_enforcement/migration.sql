-- Agents planifiés : RLS imposée (auteur seul), textes chiffrés, agent de SA
-- propre organisation, et prise en charge atomique entre instances.
ALTER TABLE "agent_schedules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_encrypted_check"
  CHECK (
    "name_enc" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND "prompt_enc" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  );--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_agent_org_fk"
  FOREIGN KEY ("agent_id", "organization_id") REFERENCES "agents" ("id", "organization_id") ON DELETE CASCADE;--> statement-breakpoint

-- Comme pour la reprise des runs : la RLS imposée vaut aussi pour le propriétaire,
-- le planificateur lit donc une file d'échéances SANS contenu, tenue à jour par
-- trigger. Le rôle applicatif n'y a aucun droit : il passe par la fonction de
-- prise en charge, puis exécute chaque tâche sous la RLS de son auteur.
CREATE TABLE "agent_schedule_queue" (
  "schedule_id" uuid PRIMARY KEY REFERENCES "agent_schedules" ("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "enabled" boolean NOT NULL,
  "next_run_at" timestamp with time zone,
  "checked_at" timestamp with time zone,
  "claimed_until" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "agent_schedule_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "agent_schedule_queue_due_idx" ON "agent_schedule_queue" ("enabled", "next_run_at");--> statement-breakpoint

-- Le bail n'est rendu que si l'application le change explicitement (fin de
-- passage) : modifier la tâche pendant son exécution ne la relance pas ailleurs.
CREATE FUNCTION "agent_schedules_queue"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO agent_schedule_queue (schedule_id, organization_id, user_id, kind, enabled, next_run_at, checked_at, claimed_until, created_at)
  VALUES (NEW.id, NEW.organization_id, NEW.user_id, NEW.kind, NEW.enabled, NEW.next_run_at, NEW.checked_at, NEW.claimed_until, NEW.created_at)
  ON CONFLICT (schedule_id) DO UPDATE SET
    enabled = EXCLUDED.enabled, next_run_at = EXCLUDED.next_run_at, checked_at = EXCLUDED.checked_at,
    claimed_until = CASE WHEN TG_OP = 'UPDATE' AND NEW.claimed_until IS DISTINCT FROM OLD.claimed_until
      THEN EXCLUDED.claimed_until ELSE agent_schedule_queue.claimed_until END;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "agent_schedules_queue"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "agent_schedules_queue" AFTER INSERT OR UPDATE ON "agent_schedules"
  FOR EACH ROW EXECUTE FUNCTION "agent_schedules_queue"();--> statement-breakpoint

-- Tâches à exécuter : échues (planifiées) ou à vérifier (déclencheurs, toutes les
-- 5 minutes), dont l'auteur est TOUJOURS membre de l'organisation. Chaque ligne
-- rendue est prise à bail (p_lease) : une autre instance ne la reprend pas.
CREATE FUNCTION "snowfall_claim_schedules"(p_lease interval, p_limit integer)
RETURNS TABLE (schedule_id uuid, organization_id uuid, user_id uuid, role text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT q.schedule_id
    FROM agent_schedule_queue q
    JOIN organization_members m ON m.organization_id = q.organization_id AND m.user_id = q.user_id
    WHERE q.enabled
      AND (q.claimed_until IS NULL OR q.claimed_until < now())
      AND (
        (q.kind = 'schedule' AND q.next_run_at <= now())
        OR (q.kind = 'knowledge' AND (q.checked_at IS NULL OR q.checked_at < now() - interval '5 minutes'))
      )
    ORDER BY coalesce(q.next_run_at, q.checked_at, q.created_at)
    LIMIT least(p_limit, 50)
    FOR UPDATE OF q SKIP LOCKED
  )
  UPDATE agent_schedule_queue q SET claimed_until = now() + p_lease
  FROM due, organization_members m
  WHERE q.schedule_id = due.schedule_id AND m.organization_id = q.organization_id AND m.user_id = q.user_id
  RETURNING q.schedule_id, q.organization_id, q.user_id, m.role;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_claim_schedules"(interval, integer) FROM PUBLIC;
