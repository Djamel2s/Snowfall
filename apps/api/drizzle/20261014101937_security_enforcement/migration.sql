-- RLS appliquée aussi au propriétaire des tables (compte de migration).
-- Seuls les superutilisateurs et les rôles BYPASSRLS y échappent.
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Journal d'audit en ajout seul. Une purge de rétention exige de désactiver
-- explicitement ces triggers (action tracée et réservée à l'exploitation).
CREATE FUNCTION "audit_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events est en ajout seul';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_append_only"();--> statement-breakpoint

-- Aucun contenu en clair ne peut être écrit : format "<version>:v1.<iv>.<chiffré>".
-- NOT VALID : les lignes existantes sont chiffrées par db:encrypt-existing,
-- puis la contrainte est validée par ce même script.
ALTER TABLE "messages" ADD CONSTRAINT "messages_content_encrypted_check"
  CHECK ("content" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_title_encrypted_check"
  CHECK ("title" IS NULL OR "title" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') NOT VALID;
