#!/usr/bin/env bash
# Blocks auto-deploy if a migration ADDED in this push contains a
# data-destroying statement. DROP INDEX / DROP CONSTRAINT are fine (no data
# loss); DROP TABLE, DROP COLUMN, TRUNCATE, DELETE FROM are not, and get a
# human to look before this pipeline can push storage's next state to prod.
set -euo pipefail

BASE="${1:?base ref required}"
HEAD="${2:?head ref required}"
DANGEROUS='DROP[[:space:]]+TABLE|DROP[[:space:]]+COLUMN|TRUNCATE|DELETE[[:space:]]+FROM'

if ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  echo "Base ref ${BASE} not found (first push to this branch) — skipping."
  exit 0
fi

NEW_FILES=$(git diff --name-only --diff-filter=A "$BASE" "$HEAD" -- 'storage/prisma/migrations/*/migration.sql' || true)

if [ -z "$NEW_FILES" ]; then
  echo "No new migrations in this push."
  exit 0
fi

fail=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "Checking $f"
  if grep -Eiq "$DANGEROUS" "$f"; then
    echo "::error file=$f::destructive statement found (DROP TABLE / DROP COLUMN / TRUNCATE / DELETE FROM) — needs manual review before this can auto-deploy"
    fail=1
  fi
done <<< "$NEW_FILES"

exit $fail
