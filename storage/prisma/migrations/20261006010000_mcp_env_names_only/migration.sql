-- MCP stdio env values out of storage.
--
-- `data.connections[*].env` held each stdio connection's environment — API
-- keys, in practice — in plain text. Bridges now sync the variable *names* only,
-- as `envKeys`, the way header names have always travelled as `headerKeys`, and
-- the route drops any value a bridge still sends. This scrubs the rows written
-- before that: every `env` map becomes the list of its names, and its values
-- are gone. A row with no `env` in it is not touched.
--
-- A scrubbed row's `_linesSig` covered the values, so it stops verifying. That
-- is expected and heals on its own: the bridge refuses the row, treats the
-- resource as empty, and pushes its own names-only copy, signed, on the same
-- sync.
--
-- Scrubbing is not un-leaking: a key that was ever synced should be rotated.

UPDATE "mcp_connections" AS m
   SET "data" = jsonb_set(
         m."data",
         '{connections}',
         (
           SELECT coalesce(
                    jsonb_agg(
                      CASE
                        -- Not a connection object, or nothing to scrub: as it was.
                        WHEN jsonb_typeof(c.value) <> 'object' OR NOT (c.value ? 'env')
                          THEN c.value
                        -- A non-empty map: its names become `envKeys`.
                        WHEN jsonb_typeof(c.value -> 'env') = 'object' AND c.value -> 'env' <> '{}'::jsonb
                          THEN (c.value - 'env') || jsonb_build_object(
                                 'envKeys',
                                 (SELECT jsonb_agg(n.name ORDER BY n.name)
                                    FROM jsonb_object_keys(c.value -> 'env') AS n(name))
                               )
                        -- Empty or malformed: there is no name worth keeping.
                        ELSE c.value - 'env'
                      END
                      ORDER BY c.ordinality
                    ),
                    '[]'::jsonb
                  )
             FROM jsonb_array_elements(m."data" -> 'connections') WITH ORDINALITY AS c(value, ordinality)
         )
       )
 WHERE jsonb_typeof(m."data" -> 'connections') = 'array'
   AND EXISTS (
         -- CASE, not a bare `AND`: Postgres does not promise to evaluate the type
         -- check first, and expanding a non-array would abort the migration.
         SELECT 1
           FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(m."data" -> 'connections') = 'array'
                       THEN m."data" -> 'connections'
                       ELSE '[]'::jsonb
                  END
                ) AS e(value)
          WHERE jsonb_typeof(e.value) = 'object' AND e.value ? 'env'
       );
