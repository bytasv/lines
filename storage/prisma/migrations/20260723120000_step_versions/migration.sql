-- CreateTable
CREATE TABLE "step_versions" (
    "user_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_versions_pkey" PRIMARY KEY ("user_id","id","version")
);

-- CreateIndex
CREATE INDEX "step_versions_published_idx" ON "step_versions"("published");
