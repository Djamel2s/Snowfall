-- Clés d'API : visibles et gérées par les administrateurs de l'organisation
-- seulement ; une clé est créée au nom de l'administrateur qui la crée.
CREATE POLICY "api_keys_admin_read" ON "api_keys" AS PERMISSIVE FOR SELECT TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint
CREATE POLICY "api_keys_admin_insert" ON "api_keys" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND "user_id" = nullif(current_setting('app.user_id', true), '')::uuid
    AND snowfall_is_admin()
  );--> statement-breakpoint
CREATE POLICY "api_keys_admin_update" ON "api_keys" AS PERMISSIVE FOR UPDATE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin())
  WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin());--> statement-breakpoint
-- Le nom n'est qu'une étiquette (« Intranet RH ») : en clair, borné, sur une ligne.
-- (La rotation des clés de chiffrement tourne sans utilisateur : elle ne pourrait
-- pas relire une table réservée aux administrateurs.)
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_name_check"
  CHECK (length("name") BETWEEN 1 AND 60 AND "name" !~ '[[:cntrl:]]');--> statement-breakpoint
-- Une clé révoquée le reste.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '366 days');--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Index de recherche par empreinte : la clé arrive AVANT que l'on connaisse
-- l'organisation. Tenu à jour par un trigger, sans politique (l'application n'y
-- lit rien) ; seule la fonction ci-dessous, propriétaire, le consulte.
CREATE TABLE "api_key_index" (
  "key_hash" text PRIMARY KEY,
  "key_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "api_key_index" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE FUNCTION "api_keys_index"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM api_key_index WHERE key_id = OLD.id;
    RETURN NULL;
  END IF;
  INSERT INTO api_key_index (key_hash, key_id, organization_id, user_id, expires_at, revoked_at)
  VALUES (NEW.key_hash, NEW.id, NEW.organization_id, NEW.user_id, NEW.expires_at, NEW.revoked_at)
  ON CONFLICT (key_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "api_keys_index"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "api_keys_index" AFTER INSERT OR UPDATE OF "revoked_at", "expires_at" OR DELETE
  ON "api_keys" FOR EACH ROW EXECUTE FUNCTION "api_keys_index"();--> statement-breakpoint

-- Recherche d'une clé valide : non révoquée, non expirée, et créée par quelqu'un
-- qui est TOUJOURS administrateur (ou propriétaire) de l'organisation.
CREATE FUNCTION "snowfall_api_key_lookup"(p_hash text)
RETURNS TABLE (key_id uuid, organization_id uuid, user_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.key_id, i.organization_id, i.user_id, m.role
  FROM api_key_index i
  JOIN organization_members m ON m.organization_id = i.organization_id AND m.user_id = i.user_id
  WHERE i.key_hash = p_hash AND i.revoked_at IS NULL AND i.expires_at > now() AND m.role IN ('owner', 'admin');
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_api_key_lookup"(text) FROM PUBLIC;
