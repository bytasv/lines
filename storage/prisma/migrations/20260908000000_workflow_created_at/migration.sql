-- Creation time for workflows and step versions.
--
-- Nothing ever recorded one and Postgres does not track a row's insert time
-- implicitly, so existing rows derive it from `updated_at` — for a step lineage,
-- from the oldest version row. Every pre-existing row therefore reads "created"
-- at its last edit. That is the best evidence available, not a bug to correct.

-- AlterTable
ALTER TABLE "workflows" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "step_versions" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "workflows"     SET "created_at" = "updated_at";
UPDATE "step_versions" SET "created_at" = "updated_at";

-- The bridge only ever reads `rows.map(r => r.data)`, and four cross-user read
-- routes stay blob-only (no column injection), so the value has to live in the
-- jsonb too. Absent keys only — a blob that already carries `createdAt` is the
-- client's own value and wins.
UPDATE "workflows"
   SET "data" = jsonb_set(
         "data",
         '{createdAt}',
         to_jsonb((extract(epoch FROM "created_at") * 1000)::bigint)
       )
 WHERE jsonb_typeof("data") = 'object' AND NOT ("data" ? 'createdAt');

-- Step versions take the LINEAGE minimum, not their own row's value: every
-- version of one step shares one birthday (the per-row time stays in the column).
UPDATE "step_versions" AS sv
   SET "data" = jsonb_set(
         sv."data",
         '{createdAt}',
         to_jsonb((extract(epoch FROM m.created_at) * 1000)::bigint)
       )
  FROM (
        SELECT "user_id", "id", min("created_at") AS created_at
          FROM "step_versions"
         GROUP BY "user_id", "id"
       ) AS m
 WHERE sv."user_id" = m."user_id"
   AND sv."id" = m."id"
   AND jsonb_typeof(sv."data") = 'object'
   AND NOT (sv."data" ? 'createdAt');
