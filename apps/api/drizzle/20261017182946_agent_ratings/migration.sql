-- Taux de réponses utiles par agent (catalogue). Chaque retour n'est lisible
-- que par son auteur (RLS imposée) : l'agrégat se tient dans une table de
-- comptage remplie par trigger, sans commentaire (message, agent, auteur,
-- note). Le rôle applicatif n'y a aucun droit ; il ne lit que la fonction
-- ci-dessous : les totaux de SON organisation, à partir de 5 personnes
-- distinctes (un seul utilisateur ne peut pas fabriquer un taux).
CREATE TABLE "agent_feedback" (
  "message_id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents" ("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "rating" integer NOT NULL CHECK ("rating" IN (-1, 1))
);--> statement-breakpoint
ALTER TABLE "agent_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "agent_feedback_org_agent_idx" ON "agent_feedback" ("organization_id", "agent_id");--> statement-breakpoint

-- Retours existants : repris (migration exécutée sans contexte tenant, RLS levée le temps de la lecture).
ALTER TABLE "message_feedback" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "agent_feedback" ("message_id", "organization_id", "agent_id", "user_id", "rating")
  SELECT f.message_id, f.organization_id, c.agent_id, f.user_id, f.rating
  FROM message_feedback f JOIN conversations c ON c.id = f.conversation_id
  WHERE c.agent_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "message_feedback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- La conversation est celle de l'auteur du retour : sa RLS (contexte de la
-- requête) la rend lisible ici. L'agent d'une conversation commencée ne change plus.
CREATE FUNCTION "message_feedback_agent_count"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_agent uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM agent_feedback WHERE message_id = OLD.message_id;
    RETURN NULL;
  END IF;
  SELECT agent_id INTO v_agent FROM conversations WHERE id = NEW.conversation_id AND organization_id = NEW.organization_id;
  IF v_agent IS NULL THEN
    DELETE FROM agent_feedback WHERE message_id = NEW.message_id;
  ELSE
    INSERT INTO agent_feedback (message_id, organization_id, agent_id, user_id, rating)
    VALUES (NEW.message_id, NEW.organization_id, v_agent, NEW.user_id, NEW.rating)
    ON CONFLICT (message_id) DO UPDATE SET rating = EXCLUDED.rating, agent_id = EXCLUDED.agent_id;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "message_feedback_agent_count"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "message_feedback_agent_count" AFTER INSERT OR UPDATE OF "rating" OR DELETE
  ON "message_feedback" FOR EACH ROW EXECUTE FUNCTION "message_feedback_agent_count"();--> statement-breakpoint

-- Seuil de 5 personnes distinctes : en dessous, un taux désignerait presque
-- quelqu'un, ou serait fabriqué par un seul utilisateur.
CREATE FUNCTION "snowfall_agent_ratings"()
RETURNS TABLE (agent_id uuid, up integer, total integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.agent_id, count(*) FILTER (WHERE a.rating = 1)::int, count(*)::int
  FROM agent_feedback a
  WHERE a.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  GROUP BY a.agent_id
  HAVING count(DISTINCT a.user_id) >= 5;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_agent_ratings"() FROM PUBLIC;
