# Feature index

| ID | Feature | Doc |
|----|---------|-----|
| `model-selector` | Model selection dropdowns (composer, settings, workflow steps) | [features/model-selector.md](features/model-selector.md) |
| `permission-mode-selector` | Permission mode pickers (composer, settings, workflow steps) with shared labels/descriptions | [features/permission-mode-selector.md](features/permission-mode-selector.md) |
| `session-sidebar-usage` | Sidebar session cost/token spend display, EU date format | [features/session-sidebar-usage.md](features/session-sidebar-usage.md) |
| `workflow-step-update-popover` | Warning popover diffing a pinned step against its latest published version, with scrollable diff list | [features/workflow-step-update-popover.md](features/workflow-step-update-popover.md) |
| `workflow-stop-advances` | Manual Stop during a running workflow step marks it done and auto-advances to the next step | [features/workflow-stop-advances.md](features/workflow-stop-advances.md) |
| `composer-focus-new-session` | Auto-focus the prompt textarea when a brand-new session is created | [features/composer-focus-new-session.md](features/composer-focus-new-session.md) |
| `workflow-draft-selection` | Governs which workflow the editor draft reflects across open/broadcast/save-reconciliation races | [features/workflow-draft-selection.md](features/workflow-draft-selection.md) |
| `workflow-step-cost` | Per-step USD spend shown in the workflow stepper | [features/workflow-step-cost.md](features/workflow-step-cost.md) |
| `transcript-markdown-rendering` | User transcript bubbles render markdown via the shared renderer; code blocks wrap instead of scrolling | [features/transcript-markdown-rendering.md](features/transcript-markdown-rendering.md) |
| `workflow-step-version-history` | Browse a step's version history, preview a per-field diff, re-pin a workflow ref or restore old content as a new library version | [features/workflow-step-version-history.md](features/workflow-step-version-history.md) |
| `agent-memory-sync` | Sync `~/.claude` agent memory (user CLAUDE.md + per-project auto-memory) across machines via the storage server, disk-cached for the SDK | [features/agent-memory-sync.md](features/agent-memory-sync.md) |
| `app-data-root` | Machine-global app state root at `~/.lines-app` | [features/app-data-root.md](features/app-data-root.md) |
| `plan-file-auto-approve` | Plan-mode file reads/writes under `.claude/plans/` auto-approve instead of prompting | [features/plan-file-auto-approve.md](features/plan-file-auto-approve.md) |
| `auth-failure-recovery` | A turn rejected for a dead OAuth token refreshes or logs out on the spot (opening the login modal), and every query crash gets a Retry button | [features/auth-failure-recovery.md](features/auth-failure-recovery.md) |
