-- CreateTable
CREATE TABLE "recipe_versions" (
    "user_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_versions_pkey" PRIMARY KEY ("user_id","id","version")
);

-- CreateTable
CREATE TABLE "recipe_stats" (
    "user_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMP(3),

    CONSTRAINT "recipe_stats_pkey" PRIMARY KEY ("user_id","id")
);

-- CreateIndex
CREATE INDEX "recipe_versions_user_id_id_version_idx" ON "recipe_versions"("user_id", "id", "version" DESC);

-- CreateIndex
CREATE INDEX "recipe_versions_published_user_id_id_version_idx" ON "recipe_versions"("published", "user_id", "id", "version" DESC);

-- CreateIndex
CREATE INDEX "recipe_versions_user_id_updated_at_idx" ON "recipe_versions"("user_id", "updated_at" DESC);
