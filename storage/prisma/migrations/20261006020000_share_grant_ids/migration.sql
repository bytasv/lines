-- The guest grant a host's machine minted for each share.
--
-- A guest is admitted by the host's own bridge, on a grant it minted and keeps
-- itself (server/src/guestGrants.ts). Storage keeps only the grant's id — an
-- opaque value, never the token that redeems it — beside the invite and the
-- grant row it turns into, so the bridge can drop a grant whose share is gone
-- from here: revoked from a phone while the machine was asleep, or an invite
-- cancelled from another browser. Nothing here can create or widen a grant.
--
-- Columns only: the tables already have row level security
-- (20261006000000_row_level_security).

ALTER TABLE "share_invites" ADD COLUMN IF NOT EXISTS "grant_id" TEXT;
ALTER TABLE "device_members" ADD COLUMN IF NOT EXISTS "grant_id" TEXT;
ALTER TABLE "session_shares" ADD COLUMN IF NOT EXISTS "grant_id" TEXT;
