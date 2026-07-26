-- CreateTable
CREATE TABLE "agent_memory_files" (
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_memory_files_pkey" PRIMARY KEY ("user_id","key")
);

-- CreateIndex
CREATE INDEX "agent_memory_files_user_id_updated_at_idx" ON "agent_memory_files"("user_id", "updated_at" DESC);

-- Backfill from the single-blob table so the cutover is invisible to clients.
-- `updatedAt` inside the blob is ms since epoch, written by the bridge.
INSERT INTO "agent_memory_files" ("user_id", "key", "content", "deleted", "updated_at")
SELECT
    m."user_id",
    e.key,
    COALESCE(e.value ->> 'content', ''),
    COALESCE((e.value ->> 'deleted')::boolean, false),
    to_timestamp(((e.value ->> 'updatedAt')::bigint) / 1000.0)
FROM "agent_memory" m, jsonb_each(m."data") AS e(key, value)
WHERE jsonb_typeof(m."data") = 'object'
  AND e.value ? 'updatedAt'
ON CONFLICT ("user_id", "key") DO NOTHING;
