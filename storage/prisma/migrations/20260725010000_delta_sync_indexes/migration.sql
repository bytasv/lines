-- CreateIndex
CREATE INDEX "sessions_user_id_updated_at_idx" ON "sessions"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "workflows_user_id_updated_at_idx" ON "workflows"("user_id", "updated_at" DESC);
