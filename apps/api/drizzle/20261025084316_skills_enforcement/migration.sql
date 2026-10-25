-- Compétences : lecture par l'auteur, par une autorisation (personne, groupe,
-- organisation), ou par qui voit un agent qui l'utilise (la RLS des agents
-- s'applique dans la sous-requête) ; écriture par l'auteur ou un éditeur.
-- Rotation des clés : dans le contexte de l'auteur (comme les prompts).
CREATE POLICY "skills_read" ON "skills" AS PERMISSIVE FOR SELECT TO public
  USING (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND (
      "user_id" = nullif(current_setting('app.user_id', true), '')::uuid
      OR snowfall_access('skill', "id") IS NOT NULL
      OR EXISTS (SELECT 1 FROM agent_skills x JOIN agents a ON a.id = x.agent_id AND a.organization_id = x.organization_id WHERE x.skill_id = "skills"."id")
    )
  );--> statement-breakpoint
CREATE POLICY "skills_owner_insert" ON "skills" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skills_editor_update" ON "skills" AS PERMISSIVE FOR UPDATE TO public
  USING (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND ("user_id" = nullif(current_setting('app.user_id', true), '')::uuid OR snowfall_access('skill', "id") = 'edit')
  )
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skills_owner_delete" ON "skills" AS PERMISSIVE FOR DELETE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

-- Fichiers et versions : visibles avec leur compétence ; ajoutés par qui peut la modifier.
CREATE POLICY "skill_files_read" ON "skill_files" AS PERMISSIVE FOR SELECT TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND EXISTS (SELECT 1 FROM skills s WHERE s.id = "skill_files"."skill_id"));--> statement-breakpoint
CREATE POLICY "skill_files_editor_insert" ON "skill_files" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM skills s WHERE s.id = "skill_files"."skill_id" AND s.user_id = "skill_files"."user_id"
      AND (s.user_id = nullif(current_setting('app.user_id', true), '')::uuid OR snowfall_access('skill', s.id) = 'edit'))
  );--> statement-breakpoint
CREATE POLICY "skill_files_editor_delete" ON "skill_files" AS PERMISSIVE FOR DELETE TO public
  USING (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM skills s WHERE s.id = "skill_files"."skill_id"
      AND (s.user_id = nullif(current_setting('app.user_id', true), '')::uuid OR snowfall_access('skill', s.id) = 'edit'))
  );--> statement-breakpoint
-- Rotation des clés : rechiffrement en place, dans le contexte de l'auteur.
CREATE POLICY "skill_files_rotation_update" ON "skill_files" AS PERMISSIVE FOR UPDATE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "user_id" = nullif(current_setting('app.user_id', true), '')::uuid AND EXISTS (SELECT 1 FROM skills s WHERE s.id = "skill_files"."skill_id" AND s.user_id = "skill_files"."user_id"))
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skill_versions_read" ON "skill_versions" AS PERMISSIVE FOR SELECT TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND EXISTS (SELECT 1 FROM skills s WHERE s.id = "skill_versions"."skill_id"));--> statement-breakpoint
CREATE POLICY "skill_versions_editor_insert" ON "skill_versions" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND "edited_by" = nullif(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM skills s WHERE s.id = "skill_versions"."skill_id" AND s.user_id = "skill_versions"."user_id"
      AND (s.user_id = nullif(current_setting('app.user_id', true), '')::uuid OR snowfall_access('skill', s.id) = 'edit'))
  );--> statement-breakpoint
CREATE POLICY "skill_versions_rotation_update" ON "skill_versions" AS PERMISSIVE FOR UPDATE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND "user_id" = nullif(current_setting('app.user_id', true), '')::uuid AND EXISTS (SELECT 1 FROM skills s WHERE s.id = "skill_versions"."skill_id" AND s.user_id = "skill_versions"."user_id"))
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint

-- Lien agent ↔ compétence : lisible dans l'organisation (identifiants) ; posé
-- seulement sur un agent et une compétence que l'on voit (l'API vérifie le droit
-- de modifier l'agent).
CREATE POLICY "agent_skills_read" ON "agent_skills" AS PERMISSIVE FOR SELECT TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_skills_insert" ON "agent_skills" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM agents a WHERE a.id = "agent_skills"."agent_id")
    AND EXISTS (SELECT 1 FROM skills s WHERE s.id = "agent_skills"."skill_id"
      AND (s.user_id = nullif(current_setting('app.user_id', true), '')::uuid OR snowfall_access('skill', s.id) IS NOT NULL))
  );--> statement-breakpoint
CREATE POLICY "agent_skills_delete" ON "agent_skills" AS PERMISSIVE FOR DELETE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND EXISTS (SELECT 1 FROM agents a WHERE a.id = "agent_skills"."agent_id"));--> statement-breakpoint

-- Partage : le propriétaire d'une compétence pose et retire ses autorisations.
DROP POLICY "resource_grants_owner_insert" ON "resource_grants";--> statement-breakpoint
DROP POLICY "resource_grants_owner_delete" ON "resource_grants";--> statement-breakpoint
CREATE POLICY "resource_grants_owner_insert" ON "resource_grants" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND "created_by" = nullif(current_setting('app.user_id', true), '')::uuid
    AND (
      snowfall_is_admin()
      OR ("resource_type" = 'agent' AND EXISTS (SELECT 1 FROM agents a WHERE a.id = "resource_grants"."resource_id" AND a.organization_id = "resource_grants"."organization_id" AND a.created_by = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'prompt' AND EXISTS (SELECT 1 FROM prompts p WHERE p.id = "resource_grants"."resource_id" AND p.organization_id = "resource_grants"."organization_id" AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'skill' AND EXISTS (SELECT 1 FROM skills k WHERE k.id = "resource_grants"."resource_id" AND k.organization_id = "resource_grants"."organization_id" AND k.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
    )
  );--> statement-breakpoint
CREATE POLICY "resource_grants_owner_delete" ON "resource_grants" AS PERMISSIVE FOR DELETE TO public
  USING (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND (
      snowfall_is_admin()
      OR ("resource_type" = 'agent' AND EXISTS (SELECT 1 FROM agents a WHERE a.id = "resource_grants"."resource_id" AND a.organization_id = "resource_grants"."organization_id" AND a.created_by = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'prompt' AND EXISTS (SELECT 1 FROM prompts p WHERE p.id = "resource_grants"."resource_id" AND p.organization_id = "resource_grants"."organization_id" AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'skill' AND EXISTS (SELECT 1 FROM skills k WHERE k.id = "resource_grants"."resource_id" AND k.organization_id = "resource_grants"."organization_id" AND k.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
    )
  );--> statement-breakpoint

-- Contenu toujours chiffré ; noms et tailles bornés.
ALTER TABLE "skills" ADD CONSTRAINT "skills_encrypted_check"
  CHECK (
    "name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND "description" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND "instructions" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  );--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_encrypted_check"
  CHECK ("name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND "content" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_size_check" CHECK ("size_bytes" BETWEEN 1 AND 10485760);--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_encrypted_check"
  CHECK ("description" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND "instructions" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint

ALTER TABLE "skills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_skills" FORCE ROW LEVEL SECURITY;
