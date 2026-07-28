-- CreateTable
CREATE TABLE "guard_allowlist" (
    "user_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guard_allowlist_pkey" PRIMARY KEY ("user_id")
);
