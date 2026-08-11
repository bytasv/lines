# Codebase documentation

Start with `architecture.md` for the shape of the system, then `index.json` — the
machine-readable navigation index (features, entry points, symbols, tests) — and follow it into
`features/`.

`feature-index.md` is the human-readable list of the same features, with a `Covers` column naming
the older, narrower feature ids each document absorbed.

There is no `decisions/` directory. `.ai/specs/documentation-system.md` lists one, but no
standalone decision records have been written — the non-derivable "why" lives in each feature
document's **Architectural rules** and **Related decisions** sections instead. Create the
directory when there is a real cross-cutting decision to record, not before; a `relatedDecisions`
entry in `index.json` currently names a sibling feature, not a decision file.

Source code is authoritative. This documents only areas touched by completed tasks — it is not,
and is not intended to become, full repository coverage.
