-- RLS imposée y compris au propriétaire des tables. organization_invitations
-- reste en RLS simple : seule la fonction de provisionnement (propriétaire)
-- doit pouvoir y retrouver une invitation par e-mail, hors contexte tenant.
ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "token_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_preferences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Une conversation ne peut être rangée que dans un projet du même membre ;
-- supprimer le projet garde la conversation (project_id passe à NULL).
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_fk"
  FOREIGN KEY ("project_id", "organization_id", "user_id")
  REFERENCES "projects" ("id", "organization_id", "user_id")
  ON DELETE SET NULL ("project_id");--> statement-breakpoint
CREATE INDEX "conversations_project_idx" ON "conversations" ("project_id");--> statement-breakpoint

-- Aucun contenu en clair : format "<version>:v1.<iv>.<chiffré>".
ALTER TABLE "projects" ADD CONSTRAINT "projects_name_encrypted_check"
  CHECK ("name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_encrypted_check"
  CHECK (
    "name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND "content" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND ("extracted_text" IS NULL OR "extracted_text" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
  );--> statement-breakpoint

-- Journal d'audit : toujours en ajout seul, sauf purge explicite des lignes
-- de plus de 90 jours par un rôle disposant de DELETE (jamais l'application)
-- et ayant activé snowfall.audit_purge dans sa transaction.
CREATE OR REPLACE FUNCTION "audit_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('snowfall.audit_purge', true) = 'on'
     AND OLD.occurred_at < now() - interval '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events est en ajout seul';
END;
$$;--> statement-breakpoint

-- Première connexion : rattache une identité Keycloak inconnue si son e-mail
-- (vérifié par Keycloak) a une invitation en attente, ou si le jeton porte
-- l'alias d'une organisation Keycloak liée en SSO. Sans l'un ou l'autre,
-- l'identité reste refusée (pas de provisioning ouvert).
CREATE FUNCTION "snowfall_provision_identity"(
  p_issuer text,
  p_subject text,
  p_email text,
  p_email_verified boolean,
  p_sso_aliases text[],
  OUT user_id uuid,
  OUT joined integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_verified boolean := coalesce(p_email_verified, false) AND v_email <> '';
  v_aliases text[] := coalesce(p_sso_aliases, '{}');
  v_user uuid;
  v_row record;
BEGIN
  joined := 0;

  SELECT ei.user_id INTO v_user
  FROM external_identities ei
  WHERE ei.issuer = p_issuer AND ei.subject = p_subject;

  IF v_user IS NULL THEN
    IF NOT (
      (v_verified AND EXISTS (
        SELECT 1 FROM organization_invitations i
        WHERE lower(i.email) = v_email AND i.accepted_at IS NULL AND i.expires_at > now()
      ))
      OR EXISTS (SELECT 1 FROM organizations o WHERE o.sso_alias = ANY (v_aliases))
    ) THEN
      RETURN;
    END IF;
    -- Le rattachement par e-mail exige un e-mail vérifié, SSO compris.
    IF NOT v_verified THEN
      RETURN;
    END IF;

    SELECT u.id INTO v_user FROM users u WHERE lower(u.email) = v_email;
    IF v_user IS NULL THEN
      INSERT INTO users (email) VALUES (v_email) RETURNING id INTO v_user;
    ELSIF EXISTS (SELECT 1 FROM external_identities ei WHERE ei.user_id = v_user) THEN
      -- Compte déjà lié à une autre identité : jamais de reliaison silencieuse.
      RETURN;
    END IF;

    INSERT INTO external_identities (issuer, subject, user_id)
    VALUES (p_issuer, p_subject, v_user);
  END IF;

  IF v_verified THEN
    FOR v_row IN
      SELECT i.id, i.organization_id, i.role
      FROM organization_invitations i
      WHERE lower(i.email) = v_email AND i.accepted_at IS NULL AND i.expires_at > now()
      FOR UPDATE
    LOOP
      INSERT INTO organization_members (organization_id, user_id, role)
      VALUES (v_row.organization_id, v_user, v_row.role)
      ON CONFLICT (organization_id, user_id) DO NOTHING;
      UPDATE organization_invitations
      SET accepted_at = now(), accepted_by = v_user
      WHERE id = v_row.id;
      joined := joined + 1;
    END LOOP;
  END IF;

  FOR v_row IN
    SELECT o.id, o.sso_default_role FROM organizations o WHERE o.sso_alias = ANY (v_aliases)
  LOOP
    INSERT INTO organization_members (organization_id, user_id, role)
    VALUES (v_row.id, v_user, v_row.sso_default_role)
    ON CONFLICT (organization_id, user_id) DO NOTHING;
    IF FOUND THEN
      joined := joined + 1;
    END IF;
  END LOOP;

  user_id := v_user;
END;
$$;--> statement-breakpoint

-- Gestion des membres dans l'organisation du contexte tenant uniquement.
-- Règles : owner/admin seulement ; personne ne modifie son propre rôle ;
-- seul un owner touche à un owner ou nomme un owner.
CREATE FUNCTION "snowfall_member_guard"(p_target uuid, p_new_role text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_actor_role text;
  v_target_role text;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_actor_role FROM organization_members m
  WHERE m.organization_id = v_org AND m.user_id = v_actor;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_target = v_actor THEN
    RAISE EXCEPTION 'SELF_CHANGE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_target_role FROM organization_members m
  WHERE m.organization_id = v_org AND m.user_id = p_target
  FOR UPDATE;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF (v_target_role = 'owner' OR p_new_role = 'owner') AND v_actor_role <> 'owner' THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN v_org;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "snowfall_set_member_role"(p_target uuid, p_role text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid;
BEGIN
  IF p_role NOT IN ('owner', 'admin', 'member', 'reader') THEN
    RAISE EXCEPTION 'INVALID_ROLE' USING ERRCODE = '22023';
  END IF;
  v_org := snowfall_member_guard(p_target, p_role);
  UPDATE organization_members SET role = p_role
  WHERE organization_id = v_org AND user_id = p_target;
END;
$$;--> statement-breakpoint

-- Retirer un membre supprime aussi ses conversations, projets et préférences
-- dans cette organisation (clés étrangères en cascade) : droit à l'effacement.
CREATE FUNCTION "snowfall_remove_member"(p_target uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid;
BEGIN
  v_org := snowfall_member_guard(p_target, NULL);
  DELETE FROM organization_members WHERE organization_id = v_org AND user_id = p_target;
END;
$$;--> statement-breakpoint

-- Liaison SSO de l'organisation courante : réservé aux owners.
CREATE FUNCTION "snowfall_set_organization_sso"(p_alias text, p_role text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.organization_id = v_org AND m.user_id = v_actor AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE organizations
  SET sso_alias = nullif(lower(btrim(coalesce(p_alias, ''))), ''),
      sso_default_role = p_role
  WHERE id = v_org;
END;
$$;--> statement-breakpoint

-- Les fonctions sont exécutables par PUBLIC par défaut : on retire ce droit,
-- db:grants l'accorde au seul rôle applicatif.
REVOKE EXECUTE ON FUNCTION "snowfall_provision_identity"(text, text, text, boolean, text[]) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_member_guard"(uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_set_member_role"(uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_remove_member"(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_set_organization_sso"(text, text) FROM PUBLIC;
