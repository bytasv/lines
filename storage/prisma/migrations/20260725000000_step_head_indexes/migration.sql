-- DropIndex
DROP INDEX "step_versions_published_idx";

-- CreateIndex
CREATE INDEX "step_versions_user_id_id_version_idx" ON "step_versions"("user_id", "id", "version" DESC);

-- CreateIndex
CREATE INDEX "step_versions_published_user_id_id_version_idx" ON "step_versions"("published", "user_id", "id", "version" DESC);
