-- Branches : les conversations existantes deviennent une branche unique (chaque
-- message a pour parent le précédent), affichée par défaut (feuille = dernier message).
-- La RLS imposée s'applique aussi au propriétaire du schéma : elle est suspendue
-- le temps de la reprise, dans la transaction de migration, puis rétablie.
ALTER TABLE "messages" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "messages" AS m SET "parent_id" = ordered.previous
FROM (
  SELECT "id", lag("id") OVER (PARTITION BY "conversation_id" ORDER BY "created_at", "id") AS previous
  FROM "messages"
) AS ordered
WHERE ordered."id" = m."id" AND ordered.previous IS NOT NULL;--> statement-breakpoint
UPDATE "conversations" AS c SET "current_leaf_id" = last."id"
FROM (
  SELECT DISTINCT ON ("conversation_id") "conversation_id", "id"
  FROM "messages"
  ORDER BY "conversation_id", "created_at" DESC, "id" DESC
) AS last
WHERE last."conversation_id" = c."id";--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
