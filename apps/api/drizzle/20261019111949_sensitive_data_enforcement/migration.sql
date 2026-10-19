-- Données sensibles : réglage limité à deux valeurs, et drapeau de conversation
-- à sens unique (une conversation sensible ne redevient jamais ordinaire).
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_sensitive_data_check"
  CHECK ("sensitive_data" IN ('local', 'off'));--> statement-breakpoint

CREATE FUNCTION "conversations_sensitive_sticky"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.sensitive AND NOT NEW.sensitive THEN
    RAISE EXCEPTION 'conversation sensitivity cannot be cleared' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "conversations_sensitive_sticky" BEFORE UPDATE OF "sensitive" ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION "conversations_sensitive_sticky"();
