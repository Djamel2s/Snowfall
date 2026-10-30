-- Administration › Sécurité : durée de conservation des conversations, et
-- lecture du journal d'audit par les administrateurs de l'organisation.

-- ---- Conservation ------------------------------------------------------------
-- Lue par tous les membres (« vos conversations sont effacées après… »),
-- modifiée par les administrateurs. RLS NON imposée au propriétaire : la purge
-- (fonction ci-dessous, sans utilisateur) lit la durée de chaque organisation.
CREATE POLICY "organization_retention_read" ON "organization_retention" AS PERMISSIVE FOR SELECT TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_retention_admin_insert" ON "organization_retention" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND "updated_by" = nullif(current_setting('app.user_id', true), '')::uuid
    AND snowfall_is_admin()
  );--> statement-breakpoint
CREATE POLICY "organization_retention_admin_update" ON "organization_retention" AS PERMISSIVE FOR UPDATE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin())
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND "updated_by" = nullif(current_setting('app.user_id', true), '')::uuid
    AND snowfall_is_admin()
  );--> statement-breakpoint

-- Dernière activité de chaque conversation : une file SANS contenu (identifiants
-- et date), tenue par trigger, comme les conversations temporaires. Les
-- conversations restent sous RLS imposée ; la purge ne lit que cette file.
CREATE TABLE "conversation_activity" (
  "conversation_id" uuid PRIMARY KEY REFERENCES "conversations" ("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "last_activity" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "conversation_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "conversation_activity_org_idx" ON "conversation_activity" ("organization_id", "last_activity");--> statement-breakpoint

ALTER TABLE "conversations" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "conversation_activity" ("conversation_id", "organization_id", "user_id", "last_activity")
  SELECT id, organization_id, user_id, updated_at FROM conversations WHERE NOT temporary;--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE FUNCTION "conversations_activity_track"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Temporaires : déjà effacées sous 24 h par leur propre purge.
  IF NEW.temporary THEN
    RETURN NULL;
  END IF;
  INSERT INTO conversation_activity (conversation_id, organization_id, user_id, last_activity)
  VALUES (NEW.id, NEW.organization_id, NEW.user_id, NEW.updated_at)
  ON CONFLICT (conversation_id) DO UPDATE SET last_activity = EXCLUDED.last_activity;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "conversations_activity_track"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "conversations_activity_track" AFTER INSERT OR UPDATE OF "updated_at" ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION "conversations_activity_track"();--> statement-breakpoint

-- Conversations échues (toutes organisations) : identifiants seulement ; la purge
-- efface chacune sous la RLS de son auteur, puis la journalise.
CREATE FUNCTION "snowfall_retention_expired"()
RETURNS TABLE (conversation_id uuid, organization_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.conversation_id, a.organization_id, a.user_id
  FROM conversation_activity a
  JOIN organization_retention r ON r.organization_id = a.organization_id
  WHERE r.conversation_days IS NOT NULL
    AND a.last_activity < now() - make_interval(days => r.conversation_days)
  ORDER BY a.last_activity
  LIMIT 200;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_retention_expired"() FROM PUBLIC;--> statement-breakpoint

-- ---- Journal d'audit -----------------------------------------------------------
-- Le rôle applicatif n'a QUE le droit d'écrire dans audit_events. Les
-- administrateurs lisent les événements de LEUR organisation par cette fonction
-- (vérification du rôle en base), page par page, du plus récent au plus ancien.
CREATE FUNCTION "snowfall_audit_log"(p_before timestamptz, p_before_id uuid, p_limit integer, p_categories text[], p_problems boolean)
RETURNS TABLE (id uuid, occurred_at timestamptz, event_type text, outcome text, actor_user_id uuid, target_type text, target_id text, ip text, details jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM organization_members m WHERE m.organization_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SNOWFALL_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'SNOWFALL_INVALID_LIMIT' USING ERRCODE = '22023';
  END IF;
  IF p_categories IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(p_categories) c WHERE c !~ '^[a-z_]{1,40}$') THEN
    RAISE EXCEPTION 'SNOWFALL_INVALID_CATEGORY' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT e.id, e.occurred_at, e.event_type, e.outcome, e.actor_user_id, e.target_type, e.target_id, e.ip, e.details
    FROM audit_events e
    WHERE e.organization_id = v_org
      AND (p_categories IS NULL OR split_part(e.event_type, '.', 1) = ANY (p_categories))
      AND (NOT coalesce(p_problems, false) OR e.outcome <> 'success')
      AND (p_before IS NULL OR (e.occurred_at, e.id) < (p_before, p_before_id))
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT p_limit;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_audit_log"(timestamptz, uuid, integer, text[], boolean) FROM PUBLIC;
