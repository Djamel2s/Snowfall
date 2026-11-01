-- Reprise de l'existant : chaque base d'agent ou de projet devient une base à
-- part entière, rattachée à son agent ou à son projet, avec son auteur (celui de
-- l'agent, ou le propriétaire du projet). Rien n'est copié ni déchiffré : le nom
-- reste vide, l'interface l'affiche d'après l'agent ou le projet.
-- Les anciens déclencheurs recopiaient user_id (supprimé à l'étape suivante).
DROP TRIGGER "knowledge_sources_scope" ON "knowledge_sources";--> statement-breakpoint
DROP TRIGGER "knowledge_chunks_scope" ON "knowledge_chunks";--> statement-breakpoint
DROP FUNCTION "knowledge_sources_scope"();--> statement-breakpoint
DROP FUNCTION "knowledge_chunks_scope"();--> statement-breakpoint
ALTER TABLE "knowledge_bases" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agents" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_knowledge_bases" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_knowledge_bases" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint

UPDATE "knowledge_bases" SET "created_by" = "user_id" WHERE "user_id" IS NOT NULL;--> statement-breakpoint
UPDATE "knowledge_bases" b SET "created_by" = a."created_by"
  FROM "agents" a WHERE a."id" = b."agent_id" AND a."organization_id" = b."organization_id" AND b."created_by" IS NULL;--> statement-breakpoint

INSERT INTO "agent_knowledge_bases" ("agent_id", "organization_id", "base_id", "position", "created_by")
  SELECT b."agent_id", b."organization_id", b."id", 0, b."created_by" FROM "knowledge_bases" b WHERE b."agent_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "project_knowledge_bases" ("project_id", "organization_id", "user_id", "base_id", "position")
  SELECT b."project_id", b."organization_id", b."user_id", b."id", 0 FROM "knowledge_bases" b WHERE b."project_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "knowledge_bases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_knowledge_bases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_knowledge_bases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Droits sur une base, pour les règles des rattachements. Une fonction (évaluée à
-- part) évite la récursion : la lecture d'une base consulte les rattachements.
CREATE FUNCTION "snowfall_knowledge_can_read"(p_base uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM knowledge_bases b WHERE b.id = p_base);
END;
$$;--> statement-breakpoint
CREATE FUNCTION "snowfall_knowledge_can_edit"(p_base uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM knowledge_bases b
    WHERE b.id = p_base
      AND (nullif(current_setting('app.user_id', true), '')::uuid IS NULL
        OR b.created_by = nullif(current_setting('app.user_id', true), '')::uuid
        OR snowfall_is_admin()
        OR snowfall_access('knowledge_base', b.id) = 'edit')
  );
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_knowledge_can_read"(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_knowledge_can_edit"(uuid) FROM PUBLIC;
