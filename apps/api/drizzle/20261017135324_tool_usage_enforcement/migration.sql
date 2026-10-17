-- Appels d'outils (quotas) : RLS imposée, y compris au propriétaire du schéma.
ALTER TABLE "tool_usage" FORCE ROW LEVEL SECURITY;
