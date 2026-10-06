-- Tool names must be unique per project (MCP clients address tools by name).
-- Rename any existing duplicates first (keep the oldest, suffix the rest), so the
-- constraint can be added to data that predates it.
UPDATE "tools" t
SET "name" = left(t."name", 57) || '_dup' || d.rn
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "project_id", "name" ORDER BY "created_at", "id") AS rn
  FROM "tools"
) d
WHERE t."id" = d."id" AND d.rn > 1;

-- CreateIndex
CREATE UNIQUE INDEX "tools_project_id_name_key" ON "tools"("project_id", "name");
