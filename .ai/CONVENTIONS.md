# Shared Agent Conventions

Follow existing project architecture, naming, formatting, and testing conventions.

Keep changes focused on the requested task. Avoid unrelated refactors.

The source code, tests, schemas, and runtime configuration are authoritative. Documentation is a navigation aid and may be stale.

Use repository-relative paths. Do not expose secrets or credentials.

For repository context, always start with:

1. `docs/codebase/index.json`
2. Relevant linked feature documents
3. Listed entry points and tests
4. Targeted code search if needed

Do not read the entire documentation directory or repository unless necessary.

Clearly report assumptions, failed checks, and unresolved uncertainty.

## Before committing

The `.githooks/pre-commit` hook runs the typecheck and the docs validation; that is the baseline gate.

For UI changes, the minimal check is the typecheck plus the unit specs of the touched workspace. End-to-end and browser checks are optional and need the dev stack running; do not start it just to satisfy a commit. Say in the commit report which checks ran and which did not.
