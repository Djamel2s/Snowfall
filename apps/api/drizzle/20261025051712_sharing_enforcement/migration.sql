-- Droits fins : fonctions de contrôle (utilisées par la RLS), politiques des
-- groupes et des autorisations, reprise de l'existant, puis RLS imposée.

-- Administrateur de l'organisation courante (rôle lu dans organization_members).
CREATE FUNCTION "snowfall_is_admin"() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
      AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND role IN ('owner', 'admin')
  );
$$;--> statement-breakpoint

-- Droit de l'utilisateur courant sur une ressource : 'edit', 'view' ou NULL.
-- Autorisations à lui, à l'un de ses groupes, ou à toute l'organisation.
CREATE FUNCTION "snowfall_access"(rtype text, rid uuid) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN bool_or(g.permission = 'edit') THEN 'edit' WHEN count(*) > 0 THEN 'view' END
  FROM resource_grants g
  WHERE g.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    AND g.resource_type = rtype
    AND g.resource_id = rid
    AND (
      g.principal_type = 'organization'
      OR (g.principal_type = 'user' AND g.principal_id = nullif(current_setting('app.user_id', true), '')::uuid)
      OR (g.principal_type = 'group' AND EXISTS (
        SELECT 1 FROM member_group_members m
        WHERE m.group_id = g.principal_id
          AND m.organization_id = g.organization_id
          AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      ))
    );
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_is_admin"() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_access"(text, uuid) FROM PUBLIC;--> statement-breakpoint

-- Groupes : lisibles par l'organisation (choix d'un partage), modifiés par ses administrateurs.
CREATE POLICY "member_groups_read" ON "member_groups" AS PERMISSIVE FOR SELECT TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "member_groups_admin_insert" ON "member_groups" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint
CREATE POLICY "member_groups_admin_update" ON "member_groups" AS PERMISSIVE FOR UPDATE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin())
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint
CREATE POLICY "member_groups_admin_delete" ON "member_groups" AS PERMISSIVE FOR DELETE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint
CREATE POLICY "member_group_members_read" ON "member_group_members" AS PERMISSIVE FOR SELECT TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "member_group_members_admin_insert" ON "member_group_members" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint
CREATE POLICY "member_group_members_admin_delete" ON "member_group_members" AS PERMISSIVE FOR DELETE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint

-- Autorisations : lisibles dans l'organisation (aucun contenu) ; posées ou retirées
-- par le propriétaire de la ressource ou un administrateur, signées par leur auteur.
CREATE POLICY "resource_grants_read" ON "resource_grants" AS PERMISSIVE FOR SELECT TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "resource_grants_owner_insert" ON "resource_grants" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND "created_by" = nullif(current_setting('app.user_id', true), '')::uuid
    AND (
      snowfall_is_admin()
      OR ("resource_type" = 'agent' AND EXISTS (SELECT 1 FROM agents a WHERE a.id = "resource_grants"."resource_id" AND a.organization_id = "resource_grants"."organization_id" AND a.created_by = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'prompt' AND EXISTS (SELECT 1 FROM prompts p WHERE p.id = "resource_grants"."resource_id" AND p.organization_id = "resource_grants"."organization_id" AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
    )
  );--> statement-breakpoint
CREATE POLICY "resource_grants_owner_delete" ON "resource_grants" AS PERMISSIVE FOR DELETE TO public
  USING (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND (
      snowfall_is_admin()
      OR ("resource_type" = 'agent' AND EXISTS (SELECT 1 FROM agents a WHERE a.id = "resource_grants"."resource_id" AND a.organization_id = "resource_grants"."organization_id" AND a.created_by = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'prompt' AND EXISTS (SELECT 1 FROM prompts p WHERE p.id = "resource_grants"."resource_id" AND p.organization_id = "resource_grants"."organization_id" AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
    )
  );--> statement-breakpoint

-- Reprise de l'existant (avant la RLS imposée) : les agents restent visibles par
-- toute l'organisation, comme avant ; un prompt partagé le reste aussi.
INSERT INTO "resource_grants" ("organization_id", "resource_type", "resource_id", "principal_type", "permission", "created_by")
  SELECT "organization_id", 'agent', "id", 'organization', 'view', "created_by" FROM "agents";--> statement-breakpoint
INSERT INTO "resource_grants" ("organization_id", "resource_type", "resource_id", "principal_type", "permission", "created_by")
  SELECT "organization_id", 'prompt', "id", 'organization', 'view', "user_id" FROM "prompts" WHERE "shared";--> statement-breakpoint

-- Noms de groupes toujours chiffrés.
ALTER TABLE "member_groups" ADD CONSTRAINT "member_groups_name_encrypted_check"
  CHECK ("name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint

ALTER TABLE "member_groups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member_group_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resource_grants" FORCE ROW LEVEL SECURITY;
