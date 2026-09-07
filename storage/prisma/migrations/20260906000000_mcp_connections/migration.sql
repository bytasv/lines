-- CreateTable
CREATE TABLE "mcp_connections" (
    "user_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_connections_pkey" PRIMARY KEY ("user_id")
);
