-- Phase 3: richer tool_call_logs (no rows exist yet: nothing wrote to it before this phase),
-- drop the never-written output column and the unused usage_rollups table.
-- CreateEnum
CREATE TYPE "LogKind" AS ENUM ('TOOL_CALL', 'AUTH_FAILURE');

-- DropForeignKey
ALTER TABLE "usage_rollups" DROP CONSTRAINT "usage_rollups_project_id_fkey";

-- DropForeignKey
ALTER TABLE "usage_rollups" DROP CONSTRAINT "usage_rollups_tool_id_fkey";

-- AlterTable
ALTER TABLE "tool_call_logs" DROP COLUMN "output",
ADD COLUMN     "error_class" TEXT,
ADD COLUMN     "kind" "LogKind" NOT NULL DEFAULT 'TOOL_CALL',
ADD COLUMN     "response_bytes" INTEGER,
ADD COLUMN     "tool_name" TEXT;

-- DropTable
DROP TABLE "usage_rollups";

-- CreateIndex
CREATE INDEX "tool_call_logs_project_id_tool_name_created_at_idx" ON "tool_call_logs"("project_id", "tool_name", "created_at");

-- CreateIndex
CREATE INDEX "tool_call_logs_created_at_idx" ON "tool_call_logs"("created_at");

-- CreateIndex
CREATE INDEX "tool_call_logs_tool_id_idx" ON "tool_call_logs"("tool_id");

-- CreateIndex
CREATE INDEX "tool_call_logs_api_key_id_idx" ON "tool_call_logs"("api_key_id");

