-- CreateTable
CREATE TABLE "project_keys" (
    "user_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_keys_pkey" PRIMARY KEY ("user_id")
);
