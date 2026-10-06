-- Row Level Security on every table, with no policies, and not forced.
--
-- Supabase's Data API (PostgREST) can serve the `public` schema to its `anon`
-- and `authenticated` roles, and the anon key is public by design: without RLS,
-- a project whose API exposes `public` lets anyone holding that key read and
-- write every row here. Lines never uses that API — every query is the storage
-- server's, scoped by the verified Clerk user id — so no policy is needed, and
-- with none those roles can see and change nothing.
--
-- The storage server is unaffected. It connects as the role that runs these
-- migrations (`postgres` on Supabase; on a standalone Postgres, the user both
-- URLs share), which owns every table here, and a table's owner skips RLS
-- unless the table FORCEs it. So never FORCE it: with no policies, that would
-- shut the storage server out of its own tables. A deployment whose
-- DATABASE_URL names some other role has to give that role BYPASSRLS.
--
-- storage/src/rls.test.ts fails CI on a table without RLS, on FORCE and on a
-- policy, so a new table enables RLS in the migration that creates it.
--
-- `_prisma_migrations` is Prisma's own table, made by `migrate deploy` rather
-- than by a migration, so it may be missing where these files are replayed on
-- their own (a shadow database). Hence IF EXISTS on that one table alone.

ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "step_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recipe_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recipe_stats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_allowlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_memory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_memory_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "device_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "share_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "share_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
