-- Tableau de bord des administrateurs (Administration › Pilotage). Les messages
-- ne sont lisibles que par leur auteur (RLS imposée) : l'activité se compte dans
-- une table de comptage remplie par trigger, SANS contenu (organisation, jour,
-- personne, agent, nombre de messages). Le rôle applicatif n'y a aucun droit ;
-- il ne lit que la fonction ci-dessous : des TOTAUX de son organisation, pour
-- un administrateur seulement. Aucun classement par personne ; l'usage d'un
-- agent n'apparaît qu'à partir de 5 personnes distinctes.
CREATE TABLE "member_activity" (
  "organization_id" uuid NOT NULL,
  -- Jour UTC du message.
  "day" date NOT NULL,
  -- Pas de clé étrangère, comme token_usage : un départ ne réécrit pas l'historique.
  "user_id" uuid NOT NULL,
  -- NULL : conversation sans agent (modèle choisi directement).
  "agent_id" uuid,
  "messages" integer NOT NULL DEFAULT 0 CHECK ("messages" >= 0),
  CONSTRAINT "member_activity_unique" UNIQUE NULLS NOT DISTINCT ("organization_id", "day", "user_id", "agent_id")
);--> statement-breakpoint
ALTER TABLE "member_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "member_activity_org_day_idx" ON "member_activity" ("organization_id", "day");--> statement-breakpoint

-- Historique existant : repris (migration sans contexte tenant, RLS levée le temps de la lecture).
ALTER TABLE "messages" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "member_activity" ("organization_id", "day", "user_id", "agent_id", "messages")
  SELECT m.organization_id, (m.created_at AT TIME ZONE 'UTC')::date, m.user_id, c.agent_id, count(*)::int
  FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE m.role = 'user' AND m.created_at >= now() - interval '400 days'
  GROUP BY 1, 2, 3, 4;--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Un message de l'utilisateur = +1. La conversation est celle de l'auteur : sa RLS
-- (contexte de la requête) la rend lisible ici. Conservation : 400 jours (13 mois).
CREATE FUNCTION "messages_activity_count"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_agent uuid;
  v_day date := (NEW.created_at AT TIME ZONE 'UTC')::date;
BEGIN
  -- Messages recopiés (copie de conversation, import), signalés par la transaction :
  -- pas une activité. Ce drapeau ne peut que retirer du comptage, jamais en ajouter.
  IF current_setting('app.copy', true) = 'on' THEN
    RETURN NULL;
  END IF;
  SELECT agent_id INTO v_agent FROM conversations WHERE id = NEW.conversation_id AND organization_id = NEW.organization_id;
  INSERT INTO member_activity (organization_id, day, user_id, agent_id, messages)
  VALUES (NEW.organization_id, v_day, NEW.user_id, v_agent, 1)
  ON CONFLICT ON CONSTRAINT member_activity_unique DO UPDATE SET messages = member_activity.messages + 1;
  DELETE FROM member_activity WHERE organization_id = NEW.organization_id AND day < v_day - 400;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "messages_activity_count"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "messages_activity_count" AFTER INSERT ON "messages"
  FOR EACH ROW WHEN (NEW."role" = 'user') EXECUTE FUNCTION "messages_activity_count"();--> statement-breakpoint

-- Totaux de l'organisation courante sur p_days jours (1 à 366), administrateurs seulement.
CREATE FUNCTION "snowfall_admin_overview"(p_days integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_since date;
  v_result jsonb;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM organization_members WHERE organization_id = v_org AND user_id = v_user AND role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'SNOWFALL_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 366 THEN
    RAISE EXCEPTION 'SNOWFALL_INVALID_PERIOD' USING ERRCODE = '22023';
  END IF;
  v_since := v_today - (p_days - 1);

  SELECT jsonb_build_object(
    'days', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('day', d.day::date, 'users', coalesce(x.users, 0), 'messages', coalesce(x.messages, 0)) ORDER BY d.day), '[]'::jsonb)
      FROM generate_series(v_since, v_today, interval '1 day') AS d(day)
      LEFT JOIN (
        SELECT day, count(DISTINCT user_id)::int AS users, sum(messages)::int AS messages
        FROM member_activity WHERE organization_id = v_org AND day >= v_since GROUP BY day
      ) x ON x.day = d.day::date
    ),
    'active7', (SELECT count(DISTINCT user_id)::int FROM member_activity WHERE organization_id = v_org AND day > v_today - 7),
    'active30', (SELECT count(DISTINCT user_id)::int FROM member_activity WHERE organization_id = v_org AND day > v_today - 30),
    'activePeriod', (SELECT count(DISTINCT user_id)::int FROM member_activity WHERE organization_id = v_org AND day >= v_since),
    'agents', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('agentId', a.agent_id, 'messages', a.messages, 'users', a.users) ORDER BY a.messages DESC), '[]'::jsonb)
      FROM (
        SELECT agent_id, sum(messages)::int AS messages, count(DISTINCT user_id)::int AS users
        FROM member_activity
        WHERE organization_id = v_org AND day >= v_since AND agent_id IS NOT NULL
        GROUP BY agent_id
        HAVING count(DISTINCT user_id) >= 5
        ORDER BY 2 DESC
        LIMIT 20
      ) a
    )
  ) INTO v_result;
  RETURN v_result;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_admin_overview"(integer) FROM PUBLIC;
