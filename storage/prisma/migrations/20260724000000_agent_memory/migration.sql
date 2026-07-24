-- CreateTable
CREATE TABLE "agent_memory" (
    "user_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memory_pkey" PRIMARY KEY ("user_id")
);
