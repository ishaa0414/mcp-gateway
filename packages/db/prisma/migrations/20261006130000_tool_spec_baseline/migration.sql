-- Track what the spec last produced for name/description so re-import can tell
-- user edits (name != spec_name) from spec-derived values.
ALTER TABLE "tools" ADD COLUMN "spec_name" TEXT;
ALTER TABLE "tools" ADD COLUMN "spec_description" TEXT;

-- Existing rows have no history; treat their current values as the baseline.
UPDATE "tools" SET "spec_name" = "name", "spec_description" = "description";

ALTER TABLE "tools" ALTER COLUMN "spec_name" SET NOT NULL;
ALTER TABLE "tools" ALTER COLUMN "spec_description" SET NOT NULL;

-- A relative base URL (e.g. "/api/v3") is never valid. Clear any that an earlier
-- import stored; the next import or the Settings page sets a proper absolute URL.
UPDATE "projects" SET "upstream_base_url" = ''
WHERE "upstream_base_url" <> '' AND "upstream_base_url" !~ '^https?://';
