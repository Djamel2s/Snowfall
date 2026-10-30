-- Identité de l'organisation : lue par tous ses membres (le logo s'affiche
-- partout), modifiée par ses administrateurs seulement. RLS imposée.
CREATE POLICY "organization_branding_read" ON "organization_branding" AS PERMISSIVE FOR SELECT TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_branding_admin_insert" ON "organization_branding" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND "updated_by" = nullif(current_setting('app.user_id', true), '')::uuid
    AND snowfall_is_admin()
  );--> statement-breakpoint
CREATE POLICY "organization_branding_admin_update" ON "organization_branding" AS PERMISSIVE FOR UPDATE TO public
  USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid AND snowfall_is_admin())
  WITH CHECK (
    "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid
    AND "updated_by" = nullif(current_setting('app.user_id', true), '')::uuid
    AND snowfall_is_admin()
  );--> statement-breakpoint
-- Le logo est vérifié aussi en base : en-tête PNG ou JPEG (base64), jamais du SVG ou du HTML.
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_logo_magic_check"
  CHECK ("logo" IS NULL OR ("logo_type" = 'image/png' AND "logo" LIKE 'iVBORw0KGgo%') OR ("logo_type" = 'image/jpeg' AND "logo" LIKE '/9j/%'));--> statement-breakpoint
ALTER TABLE "organization_branding" FORCE ROW LEVEL SECURITY;
