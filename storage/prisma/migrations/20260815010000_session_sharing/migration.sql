-- Machine- and session-scope grants, pending invites, and the display-identity
-- cache that lets a shared session name who is in it.
--
-- No foreign keys, matching every other table here: user ids are bare strings
-- from Clerk, and a device or session row disappearing must not cascade a grant
-- out of existence silently — revocation is an explicit tombstone.

-- CreateTable
CREATE TABLE "device_members" (
    "device_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "caps" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "device_members_pkey" PRIMARY KEY ("device_id","user_id")
);

-- CreateTable
CREATE TABLE "session_shares" (
    "device_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "caps" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "session_shares_pkey" PRIMARY KEY ("device_id","user_id","session_id")
);

-- CreateTable
CREATE TABLE "share_invites" (
    "code" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "session_id" UUID,
    "invitee_email" TEXT,
    "caps" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "share_invites_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "image_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "device_members_user_id_idx" ON "device_members"("user_id");

-- CreateIndex
CREATE INDEX "session_shares_user_id_idx" ON "session_shares"("user_id");

-- CreateIndex
CREATE INDEX "share_invites_owner_id_idx" ON "share_invites"("owner_id");

-- CreateIndex
CREATE INDEX "share_invites_invitee_email_idx" ON "share_invites"("invitee_email");
