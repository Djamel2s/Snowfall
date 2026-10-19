-- Routage des modèles : forme minimale garantie en base (l'API valide le détail).
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_model_routing_shape"
  CHECK (model_routing IS NULL OR (jsonb_typeof(model_routing) = 'object'
    AND jsonb_typeof(model_routing -> 'fast') = 'object'
    AND jsonb_typeof(model_routing -> 'strong') = 'object'
    AND pg_column_size(model_routing) < 2048));
