-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "platform" TEXT,
    "secret_hash" TEXT NOT NULL,
    "pairing_code" TEXT,
    "pairing_expires_at" TIMESTAMP(3),
    "app_protocol" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devices_pairing_code_key" ON "devices"("pairing_code");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

