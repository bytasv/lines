# Documentation Verification

Verify documentation incrementally.

Prefer deterministic validation.

Verify:

- JSON schema
- unique IDs
- documentation paths
- referenced files
- referenced symbols
- tests
- routes
- schemas
- related feature IDs
- decision IDs

Use semantic verification only for:

- behavioural claims
- architectural ownership
- security rules
- business rules

Never perform a repository-wide audit unless explicitly requested.

Use these statuses:

PASS

WARN

STALE

FAIL
