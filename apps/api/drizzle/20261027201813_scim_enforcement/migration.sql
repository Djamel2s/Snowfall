-- SCIM 2.0 : comptes poussés par l'annuaire de l'entreprise.

-- Lus et modifiés par les administrateurs de l'organisation (une clé SCIM agit
-- au nom de l'administrateur qui l'a créée). RLS active, SANS FORCE : la
-- fonction de connexion (propriétaire) doit les lire, comme les invitations.
CREATE POLICY "scim_users_admin_read" ON "scim_users" AS PERMISSIVE FOR SELECT TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint
CREATE POLICY "scim_users_admin_insert" ON "scim_users" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint
CREATE POLICY "scim_users_admin_update" ON "scim_users" AS PERMISSIVE FOR UPDATE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin())
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint
CREATE POLICY "scim_users_admin_delete" ON "scim_users" AS PERMISSIVE FOR DELETE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint

-- Clés : la recherche renvoie aussi leur type (une clé SCIM n'ouvre pas /v1, et inversement).
ALTER TABLE "api_key_index" ADD COLUMN "kind" text NOT NULL DEFAULT 'api';--> statement-breakpoint
UPDATE "api_key_index" i SET "kind" = k."kind" FROM "api_keys" k WHERE k."id" = i."key_id";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "api_keys_index"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM api_key_index WHERE key_id = OLD.id;
    RETURN NULL;
  END IF;
  INSERT INTO api_key_index (key_hash, key_id, organization_id, user_id, expires_at, revoked_at, kind)
  VALUES (NEW.key_hash, NEW.id, NEW.organization_id, NEW.user_id, NEW.expires_at, NEW.revoked_at, NEW.kind)
  ON CONFLICT (key_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP FUNCTION "snowfall_api_key_lookup"(text);--> statement-breakpoint
CREATE FUNCTION "snowfall_api_key_lookup"(p_hash text)
RETURNS TABLE (key_id uuid, organization_id uuid, user_id uuid, role text, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.key_id, i.organization_id, i.user_id, m.role, i.kind
  FROM api_key_index i
  JOIN organization_members m ON m.organization_id = i.organization_id AND m.user_id = i.user_id
  WHERE i.key_hash = p_hash AND i.revoked_at IS NULL AND i.expires_at > now() AND m.role IN ('owner', 'admin');
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_api_key_lookup"(text) FROM PUBLIC;--> statement-breakpoint

-- Connexion : une organisation qui a des comptes SCIM (ou une clé SCIM active)
-- est gérée par l'annuaire.
-- Seul un compte SCIM ACTIF y entre (au rôle par défaut de l'organisation) ;
-- l'entrée par le seul alias SSO ne vaut plus pour elle (sinon un compte
-- désactivé reviendrait à sa connexion suivante). Les invitations explicites
-- d'un administrateur restent possibles.
CREATE OR REPLACE FUNCTION "snowfall_provision_identity"(
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
      OR (v_verified AND EXISTS (SELECT 1 FROM scim_users s WHERE s.user_name = v_email AND s.active))
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

    -- Compte poussé par l'annuaire et actif : il rejoint son organisation.
    FOR v_row IN
      SELECT o.id, o.sso_default_role
      FROM scim_users s JOIN organizations o ON o.id = s.organization_id
      WHERE s.user_name = v_email AND s.active
    LOOP
      INSERT INTO organization_members (organization_id, user_id, role)
      VALUES (v_row.id, v_user, v_row.sso_default_role)
      ON CONFLICT (organization_id, user_id) DO NOTHING;
      IF FOUND THEN
        joined := joined + 1;
      END IF;
    END LOOP;
  END IF;

  FOR v_row IN
    SELECT o.id, o.sso_default_role FROM organizations o
    WHERE o.sso_alias = ANY (v_aliases)
      -- Gérée par l'annuaire (des comptes SCIM, ou une clé SCIM active, même si
      -- l'annuaire a tout supprimé) : l'alias SSO seul ne fait plus entrer.
      AND NOT EXISTS (SELECT 1 FROM scim_users s WHERE s.organization_id = o.id)
      AND NOT EXISTS (
        SELECT 1 FROM api_key_index k
        WHERE k.organization_id = o.id AND k.kind = 'scim' AND k.revoked_at IS NULL AND k.expires_at > now()
      )
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
REVOKE EXECUTE ON FUNCTION "snowfall_provision_identity"(text, text, text, boolean, text[]) FROM PUBLIC;
