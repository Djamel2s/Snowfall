-- Exécution durable : RLS imposée y compris au propriétaire des tables.
ALTER TABLE "agent_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_checkpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_checkpoint_writes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Aucun contenu en clair : format "<version>:v1.<iv>.<chiffré>".
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_encrypted_check"
  CHECK (
    "request" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND ("progress" IS NULL OR "progress" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
  );--> statement-breakpoint
ALTER TABLE "agent_checkpoints" ADD CONSTRAINT "agent_checkpoints_encrypted_check"
  CHECK (
    "checkpoint" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND "metadata" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  );--> statement-breakpoint
ALTER TABLE "agent_checkpoint_writes" ADD CONSTRAINT "agent_checkpoint_writes_encrypted_check"
  CHECK ("value" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint

-- Reprise des runs : interrompus (bail expiré, instance tombée) ou en attente
-- de validation depuis trop longtemps (refus). La RLS imposée sur agent_runs
-- s'applique aussi à son propriétaire : la reprise lit donc une file
-- d'identifiants et d'états (aucun contenu), tenue à jour par trigger ; le
-- rôle applicatif n'y a aucun droit et ne la lit que par la fonction
-- ci-dessous, puis reprend chaque run sous la RLS de son propriétaire.
CREATE TABLE "agent_run_leases" (
  "run_id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "status" text NOT NULL,
  "lease_until" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "agent_run_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "agent_run_leases_due_idx" ON "agent_run_leases" ("status", "lease_until", "updated_at");--> statement-breakpoint

CREATE FUNCTION "agent_runs_lease"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM agent_run_leases WHERE run_id = OLD.id;
    RETURN NULL;
  END IF;
  INSERT INTO agent_run_leases (run_id, organization_id, user_id, status, lease_until, updated_at)
  VALUES (NEW.id, NEW.organization_id, NEW.user_id, NEW.status, NEW.lease_until, NEW.updated_at)
  ON CONFLICT (run_id) DO UPDATE SET
    status = EXCLUDED.status, lease_until = EXCLUDED.lease_until, updated_at = EXCLUDED.updated_at;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "agent_runs_lease"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "agent_runs_lease" AFTER INSERT OR UPDATE OF "status", "lease_until", "updated_at" OR DELETE
  ON "agent_runs" FOR EACH ROW EXECUTE FUNCTION "agent_runs_lease"();--> statement-breakpoint

CREATE FUNCTION "snowfall_stale_runs"(p_waiting_ttl interval)
RETURNS TABLE (run_id uuid, organization_id uuid, user_id uuid, status text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.run_id, l.organization_id, l.user_id, l.status
  FROM agent_run_leases l
  WHERE (l.status = 'running' AND (l.lease_until IS NULL OR l.lease_until < now()))
     OR (l.status = 'waiting' AND l.updated_at < now() - p_waiting_ttl)
  ORDER BY l.updated_at
  LIMIT 100;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_stale_runs"(interval) FROM PUBLIC;
