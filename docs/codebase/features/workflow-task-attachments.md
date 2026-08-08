# Workflow task attachments

## Purpose

Carry image attachments the user sends alongside a workflow's task description into
step 0's prompt — staged to disk, written into the transcript `user` event, and sent to
the model as an image block — the same as any ordinary chat prompt.

## Entry points

- `server/src/index.ts` (`case 'prompt'`)
- `server/src/workflows.ts` (`WorkflowRunner.startIfPending`)

## Files

- `server/src/index.ts`
- `server/src/workflows.ts`
- `server/src/sessions.ts` (`SessionManager.prompt` — staging, transcript write, content
  blocks; unchanged)
- `shared/types.ts` (`PromptAttachment`, `ClientMessage`)

## Symbols

- `startIfPending(sessionId, userText, attachments?)`
- `runStep(sessionId, feedback?, entry?, attachments?)`
- `SessionManager.prompt`

## Data flow

A session with an attached, not-yet-started workflow treats the user's first `prompt`
message as the task description rather than normal chat. `startIfPending` stores the text
as `meta.workflow.task` and calls `runStep` for step 0 (`entry = true`); `runStep` builds
the template-substituted prompt and forwards it to `SessionManager.prompt`, which stages
attachments to disk, writes the transcript `user` event with attachment refs, and builds
the model's image content blocks — identical to a normal chat prompt or the parallel
`iterateIfWaiting` → `iterateStep` → `prompt` path used for parked steps.

## Dependencies

Reuses `SessionManager.prompt`'s existing staging/transcript/content-block logic. No new
mechanism.

## Tests

None. The fix is argument threading (no new logic); see the feature's implementation notes
for why no test was added.

## Business rules

- Attachments ride only the entry step (step 0, the task-description prompt). Later steps
  do not re-carry the original file: a non-fresh step inherits the image for free via the
  live conversation; a `freshStart` step gets only the compact `{previous}`/`{diff}`
  hand-off, never the original attachment.
- `mentions[]` are out of scope here — they are display-only and already expanded into the
  prompt text client-side (see `features/prompt-mentions.md`); nothing reaches the model
  differently for a workflow's first prompt.
- A step 0 that parks (`waiting-approval`, e.g. an unresolved step ref or a missing
  `{outputs.*}`) drops the attachment: it never gets staged and leaves no transcript trace,
  so the user must re-attach when the step is later iterated on.

## Architectural rules

- `worker.ts` is not involved; attachment handling stays entirely in
  `SessionManager.prompt`, not duplicated per caller.

## Related decisions

None recorded.
