# Documentation System

The documentation system exists to speed up future development by providing both human-readable documentation and a machine-readable navigation index.

Maintain:

docs/codebase/

including:

- README.md
- architecture.md
- feature-index.md
- index.json
- features/
- decisions/

Document only areas affected by the current task.

Every feature should document:

- purpose
- entry points
- important files
- important symbols
- data flow
- dependencies
- tests
- business rules
- architectural rules
- related decisions

Keep documentation concise.

Never duplicate source code.

Never document line numbers.

The JSON index is intended for:

- AI context loading
- UI quick references
- feature search
- navigation

Use stable IDs.

Update only affected entries.

Validate the index with `npm run docs:validate`, which checks it against `docs/codebase/index.schema.json` plus unique feature IDs and existing `doc` paths.

The source code remains the source of truth.
