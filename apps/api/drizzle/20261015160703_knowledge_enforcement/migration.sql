-- Bases de connaissances : RLS imposée y compris au propriétaire des tables.
ALTER TABLE "knowledge_bases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- La visibilité (user_id) d'une source et de ses passages est toujours celle
-- de leur base : recopiée par la base de données, jamais fournie par
-- l'application. Une source ne peut donc pas « fuiter » d'une base de projet
-- privée vers toute l'organisation. La recherche de la base passe par la RLS
-- de l'appelant : une base invisible fait échouer l'insertion.
CREATE FUNCTION "knowledge_sources_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_user uuid;
BEGIN
  SELECT b.user_id INTO v_user FROM knowledge_bases b
  WHERE b.id = NEW.base_id AND b.organization_id = NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge base not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.user_id := v_user;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "knowledge_sources_scope" BEFORE INSERT OR UPDATE OF "base_id", "user_id", "organization_id"
  ON "knowledge_sources" FOR EACH ROW EXECUTE FUNCTION "knowledge_sources_scope"();--> statement-breakpoint

CREATE FUNCTION "knowledge_chunks_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_base uuid;
  v_user uuid;
BEGIN
  SELECT s.base_id, s.user_id INTO v_base, v_user FROM knowledge_sources s
  WHERE s.id = NEW.source_id AND s.organization_id = NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge source not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.base_id := v_base;
  NEW.user_id := v_user;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "knowledge_chunks_scope" BEFORE INSERT OR UPDATE OF "source_id", "base_id", "user_id", "organization_id"
  ON "knowledge_chunks" FOR EACH ROW EXECUTE FUNCTION "knowledge_chunks_scope"();--> statement-breakpoint

-- Aucun contenu en clair : format "<version>:v1.<iv>.<chiffré>".
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_encrypted_check"
  CHECK (
    "name" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND "content" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND ("url" IS NULL OR "url" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
  );--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_encrypted_check"
  CHECK (
    "content" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    AND ("embedding" IS NULL OR "embedding" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
  );--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sources_encrypted_check"
  CHECK ("sources" IS NULL OR "sources" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint

-- Reprise au démarrage des imports interrompus. La file ne contient que des
-- identifiants (aucun contenu), tenue à jour par trigger ; le rôle applicatif
-- n'y a aucun droit (RLS sans politique) et ne la lit que par la fonction
-- ci-dessous.
CREATE TABLE "knowledge_jobs" (
  "source_id" uuid PRIMARY KEY REFERENCES "knowledge_sources" ("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "created_by" uuid NOT NULL,
  "queued_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE FUNCTION "knowledge_sources_job"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('pending', 'processing') THEN
    INSERT INTO knowledge_jobs (source_id, organization_id, created_by)
    VALUES (NEW.id, NEW.organization_id, NEW.created_by)
    ON CONFLICT (source_id) DO NOTHING;
  ELSE
    DELETE FROM knowledge_jobs WHERE source_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "knowledge_sources_job"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "knowledge_sources_job" AFTER INSERT OR UPDATE OF "status"
  ON "knowledge_sources" FOR EACH ROW EXECUTE FUNCTION "knowledge_sources_job"();--> statement-breakpoint

CREATE FUNCTION "snowfall_pending_knowledge"()
RETURNS TABLE (source_id uuid, organization_id uuid, created_by uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT j.source_id, j.organization_id, j.created_by
  FROM knowledge_jobs j
  ORDER BY j.queued_at
  LIMIT 500;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_pending_knowledge"() FROM PUBLIC;
