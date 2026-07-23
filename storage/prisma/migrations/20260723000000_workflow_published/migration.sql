-- AlterTable
ALTER TABLE "workflows" ADD COLUMN "published" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "workflows_published_idx" ON "workflows"("published");
