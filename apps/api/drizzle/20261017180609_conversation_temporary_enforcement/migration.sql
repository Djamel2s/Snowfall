-- Conversation temporaire : jamais rangée dans un projet.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_temporary_project_check"
  CHECK (NOT ("temporary" AND "project_id" IS NOT NULL));--> statement-breakpoint

-- Échéances des conversations temporaires. La RLS imposée sur conversations
-- s'applique aussi à son propriétaire : la purge lit donc une file
-- d'identifiants (aucun contenu), remplie par trigger à la création ; le rôle
-- applicatif n'y a aucun droit et ne la lit que par la fonction ci-dessous,
-- puis efface chaque conversation sous la RLS de son auteur. La ligne
-- disparaît avec la conversation (ON DELETE CASCADE).
CREATE TABLE "temporary_conversations" (
  "conversation_id" uuid PRIMARY KEY REFERENCES "conversations" ("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "temporary_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "temporary_conversations_expires_idx" ON "temporary_conversations" ("expires_at");--> statement-breakpoint

CREATE FUNCTION "conversations_temporary_expiry"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO temporary_conversations (conversation_id, organization_id, user_id, expires_at)
  VALUES (NEW.id, NEW.organization_id, NEW.user_id, NEW.created_at + interval '24 hours');
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "conversations_temporary_expiry"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "conversations_temporary_expiry" AFTER INSERT ON "conversations"
  FOR EACH ROW WHEN (NEW."temporary") EXECUTE FUNCTION "conversations_temporary_expiry"();--> statement-breakpoint

-- Le drapeau est fixé à la création : une conversation ne devient ni ne cesse d'être temporaire.
CREATE FUNCTION "conversations_temporary_immutable"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."temporary" IS DISTINCT FROM OLD."temporary" THEN
    RAISE EXCEPTION 'conversations.temporary is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "conversations_temporary_immutable" BEFORE UPDATE OF "temporary" ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION "conversations_temporary_immutable"();--> statement-breakpoint

CREATE FUNCTION "snowfall_expired_temporary"()
RETURNS TABLE (conversation_id uuid, organization_id uuid, user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.conversation_id, t.organization_id, t.user_id
  FROM temporary_conversations t
  WHERE t.expires_at < now()
  ORDER BY t.expires_at
  LIMIT 200;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "snowfall_expired_temporary"() FROM PUBLIC;
