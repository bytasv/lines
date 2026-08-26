-- The collaborator address book: who this account has shared with, so the share
-- overlay can offer them again instead of asking for the address from memory.
--
-- Deliberately decoupled from grant state. Grants and invites are tombstoned or
-- expire; this table is not touched by either, because retyping the address of
-- someone whose access you revoked is the exact case that hurts. Removal here is
-- a hard delete, not a tombstone — it is a convenience list, not an audit trail.
--
-- No foreign keys, matching every other table here.

-- CreateTable
CREATE TABLE "share_contacts" (
    "owner_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_contacts_pkey" PRIMARY KEY ("owner_id","email")
);

-- CreateIndex
CREATE INDEX "share_contacts_owner_id_last_used_at_idx" ON "share_contacts"("owner_id", "last_used_at");
