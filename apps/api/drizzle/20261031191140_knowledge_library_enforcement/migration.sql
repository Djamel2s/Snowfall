-- Bibliothèque de connaissances : contrôles en base. RLS imposée, noms chiffrés,
-- auteur immuable, dossiers sans boucle, passages toujours dans la base de leur
-- document, partages d'une base posés par son seul auteur.
ALTER TABLE "knowledge_folders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_knowledge_bases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_knowledge_bases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_name_encrypted_check"
  CHECK ("name" IS NULL OR "name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "knowledge_folders" ADD CONSTRAINT "knowledge_folders_name_encrypted_check"
  CHECK ("name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "agent_knowledge_bases" ADD CONSTRAINT "agent_knowledge_bases_position_check" CHECK ("position" BETWEEN 0 AND 99);--> statement-breakpoint
ALTER TABLE "project_knowledge_bases" ADD CONSTRAINT "project_knowledge_bases_position_check" CHECK ("position" BETWEEN 0 AND 99);--> statement-breakpoint

-- Auteur d'une base ou d'un dossier : jamais changé (il garde la main sur le partage).
CREATE FUNCTION "knowledge_created_by_fixed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_by := OLD.created_by;
  NEW.organization_id := OLD.organization_id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "knowledge_bases_created_by_fixed" BEFORE UPDATE ON "knowledge_bases"
  FOR EACH ROW EXECUTE FUNCTION "knowledge_created_by_fixed"();--> statement-breakpoint
CREATE TRIGGER "knowledge_folders_created_by_fixed" BEFORE UPDATE ON "knowledge_folders"
  FOR EACH ROW EXECUTE FUNCTION "knowledge_created_by_fixed"();--> statement-breakpoint

-- Un document ne change pas de base (ses chiffrés sont liés à elle).
CREATE FUNCTION "knowledge_sources_base_fixed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.base_id <> OLD.base_id OR NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'knowledge source cannot change base' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "knowledge_sources_base_fixed" BEFORE UPDATE OF "base_id", "organization_id" ON "knowledge_sources"
  FOR EACH ROW EXECUTE FUNCTION "knowledge_sources_base_fixed"();--> statement-breakpoint

-- Un passage est toujours dans la base de son document : recopiée par la base de
-- données (la recherche du document passe par la RLS de l'appelant).
CREATE FUNCTION "knowledge_chunks_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_base uuid;
BEGIN
  SELECT s.base_id INTO v_base FROM knowledge_sources s
  WHERE s.id = NEW.source_id AND s.organization_id = NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge source not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.base_id := v_base;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "knowledge_chunks_scope" BEFORE INSERT OR UPDATE OF "source_id", "base_id", "organization_id"
  ON "knowledge_chunks" FOR EACH ROW EXECUTE FUNCTION "knowledge_chunks_scope"();--> statement-breakpoint

-- Dossiers : jamais dans lui-même ni dans un de ses descendants ; 8 niveaux au plus.
CREATE FUNCTION "knowledge_folders_tree"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cursor uuid := NEW.parent_id;
  v_depth integer := 1;
BEGIN
  WHILE v_cursor IS NOT NULL LOOP
    IF v_cursor = NEW.id THEN
      RAISE EXCEPTION 'knowledge folder cycle' USING ERRCODE = 'check_violation';
    END IF;
    v_depth := v_depth + 1;
    IF v_depth > 8 THEN
      RAISE EXCEPTION 'knowledge folder too deep' USING ERRCODE = 'check_violation';
    END IF;
    SELECT f.parent_id INTO v_cursor FROM knowledge_folders f WHERE f.id = v_cursor AND f.base_id = NEW.base_id;
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "knowledge_folders_tree" BEFORE INSERT OR UPDATE OF "parent_id", "base_id" ON "knowledge_folders"
  FOR EACH ROW EXECUTE FUNCTION "knowledge_folders_tree"();--> statement-breakpoint

-- Partages d'une base : son auteur seul. Pas l'administrateur : il pourrait
-- s'ouvrir lui-même une base privée (les documents d'un projet).
DROP POLICY "resource_grants_owner_insert" ON "resource_grants";--> statement-breakpoint
DROP POLICY "resource_grants_owner_delete" ON "resource_grants";--> statement-breakpoint
CREATE POLICY "resource_grants_owner_insert" ON "resource_grants" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND "created_by" = nullif(current_setting('app.user_id', true), '')::uuid
    AND (
      (snowfall_is_admin() AND "resource_type" <> 'knowledge_base')
      OR ("resource_type" = 'agent' AND EXISTS (SELECT 1 FROM agents a WHERE a.id = "resource_grants"."resource_id" AND a.organization_id = "resource_grants"."organization_id" AND a.created_by = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'prompt' AND EXISTS (SELECT 1 FROM prompts p WHERE p.id = "resource_grants"."resource_id" AND p.organization_id = "resource_grants"."organization_id" AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'skill' AND EXISTS (SELECT 1 FROM skills k WHERE k.id = "resource_grants"."resource_id" AND k.organization_id = "resource_grants"."organization_id" AND k.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'knowledge_base' AND EXISTS (SELECT 1 FROM knowledge_bases b WHERE b.id = "resource_grants"."resource_id" AND b.organization_id = "resource_grants"."organization_id" AND b.created_by = nullif(current_setting('app.user_id', true), '')::uuid))
    )
  );--> statement-breakpoint
CREATE POLICY "resource_grants_owner_delete" ON "resource_grants" AS PERMISSIVE FOR DELETE TO public
  USING (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND (
      (snowfall_is_admin() AND "resource_type" <> 'knowledge_base')
      OR ("resource_type" = 'agent' AND EXISTS (SELECT 1 FROM agents a WHERE a.id = "resource_grants"."resource_id" AND a.organization_id = "resource_grants"."organization_id" AND a.created_by = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'prompt' AND EXISTS (SELECT 1 FROM prompts p WHERE p.id = "resource_grants"."resource_id" AND p.organization_id = "resource_grants"."organization_id" AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'skill' AND EXISTS (SELECT 1 FROM skills k WHERE k.id = "resource_grants"."resource_id" AND k.organization_id = "resource_grants"."organization_id" AND k.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
      OR ("resource_type" = 'knowledge_base' AND EXISTS (SELECT 1 FROM knowledge_bases b WHERE b.id = "resource_grants"."resource_id" AND b.organization_id = "resource_grants"."organization_id" AND b.created_by = nullif(current_setting('app.user_id', true), '')::uuid))
    )
  );
