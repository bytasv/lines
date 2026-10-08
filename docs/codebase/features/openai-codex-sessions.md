# OpenAI Codex sessions

Covers: `openai-account-login`, `codex-turn-engine`, `provider-capabilities`.

## Purpose

A second agent provider. A session whose model is an OpenAI one runs its turns through the
`codex` CLI instead of the Claude one, and a **Connect** row beside the Claude sign-in in
Settings → Account is how the account gets there.

Everything that makes a session a session is at parity: token streaming, permission cards,
plan mode (codex's own collaboration mode, with its clarifying questions routed into the
`AskUserQuestion` card), Send now, compaction, the context ring, rewind, the user's MCP connections and
workflow steps all work on a codex session and go through the *same* bridge machinery a Claude
session does — including Lines' own workflow tools, served to codex by a real stdio MCP server
(see [workflow-mcp-tools](workflow-mcp-tools.md)) since codex cannot host one in-process. Those
tools are the one deliberate gap: codex gets their reads only, because nothing on that path can
raise the approval card a write needs. `cost`
is the only capability still false, and permanently: codex reports tokens and never a price. That
no longer means a codex session shows no dollar figure — one is computed from a static per-model
price table and shown marked with a `~`, since `cost: false` is exactly the signal that decides
"this turn's money is estimated, not provider-reported" (see
[usage-and-cost](usage-and-cost.md)).

Two decisions shape the whole feature.

**Codex events are normalized into Claude SDK message shapes on the bridge**, rather than given
a transcript kind of their own. The bridge's turn machinery — not just the renderer — is keyed
to those shapes: the `msg.type === 'result'` settle pass alone drives status, token accounting,
spend, the queue flush, the workflow advance, the turn summary and the review diff, and
`markTurnLive`, `collectTurns`, `scanTurnActivity`, `collectChangedPaths` and the rewind anchor
scan all read `assistant`/`user` content blocks. A distinct kind would silently no-op every one
of them. Normalization also buys streaming for free: a delta wearing the `stream_event`
envelope is droppable under backpressure and collapsible on the client without a line of new
code.

**Capabilities are a table, not a vendor check.** `shared/providers.ts` answers "what can this
engine do", and the composer, transcript, queue, context chip and workflow guard ask it rather
than asking whether the provider is OpenAI. This is why flipping one flag has repeatedly
restored a control everywhere at once, and why a third provider would not mean hunting for
scattered `=== 'openai'` checks.

## Entry points

- `web/src/components/AccountSection.tsx` — the Account pane's OpenAI row and its **Connect…**
  button.
- `web/src/components/OpenaiLoginModal.tsx` — the device-code modal.
- `server/src/openaiAuth.ts` — the login flow and the connected/disconnected state.
- `server/src/workerCodex.ts` — the worker's codex half: threads, turns, approvals.
- `server/src/codexAppServer.ts` — the JSON-RPC client over the long-lived `codex app-server`.
- `shared/codex.ts` — notification → SDK-shape normalization.
- `shared/providers.ts` — the capability table.

## Files

- `server/src/openaiAuth.ts` — device-code login, account metadata, logout.
- `server/src/openaiUsage.ts` — ChatGPT plan-usage poller. Reads from `/wham/usage`: both windows,
  per-model caps (`additional_rate_limits[].rate_limit`), live `plan_type` (wins over the plan
  stored at login), `credits`, limit-reached, and the reset-credit count. Redeems a reset credit
  through a short-lived codex app-server, so codex stays the only writer of `auth.json`.
- `server/src/codexCli.ts` — `codex` binary discovery and the version floor.
- `server/src/codexAppServer.ts` — spawn, handshake, request/notification demux.
- `server/src/workerCodex.ts` — thread binding, turns, steering, compaction, forking.
- `server/src/codexPlanMode.ts` — the `collaborationMode` a turn runs with; a chosen
  effort rides it verbatim, and `applyModePreset` fills it from codex's own preset only
  when the user chose none. See [reasoning-effort-selection](reasoning-effort-selection.md).
- `server/src/helperQuery.ts` — the bridge's own one-shot queries, on either provider.
- `shared/codex.ts` — the normalizer.
- `shared/providers.ts` — `ProviderCapabilities` and the per-provider table.
- `shared/codexProtocol/` — generated protocol types; see its README.
- `web/src/lib/capabilities.ts` — `sessionCaps()` and `agentLabel()`.
- `web/src/components/ProviderMark.tsx` — the Anthropic and OpenAI marks.

## Data flow

A turn: `prompt()` → `pushTurn` sees an OpenAI model and routes to `pushCodexTurn` → the worker
binds the session to a thread (`thread/start`, or `thread/resume` from `meta.codexThreadId`) →
`turn/start`. Notifications come back verbatim in a `CodexNotificationEnvelope`, the bridge
normalizes them, and everything downstream is the ordinary SDK path.

An approval: codex asks (`item/commandExecution/requestApproval`) → the worker routes it down
the *existing* `canUseTool` RPC → the bridge's auto-guard, allowlist and permission card decide
→ `accept` or `decline` goes back. None of the decision logic was ever Claude-specific; only
the transport was.

## Business rules

- `$CODEX_HOME/auth.json` is the only store of OpenAI secrets. Lines writes it exactly once at
  login and never again — OpenAI rotates the refresh token on every refresh, so a second writer
  would clobber tokens fresher than its own. Logout deletes it.
- Reading that file is allowed; writing it twice is not. The usage poller reads the access
  token per request and never caches it. Only codex can refresh it, so a stale token empties the
  usage chip (it shows no data until codex refreshes the token) rather than being refreshed here.
- A codex turn carries no credential. It carries a `CODEX_HOME`.
- `CODEX_HOME` is `~/.lines-app/users/<id>/codex/`, which **shadows the user's own
  `~/.codex/config.toml`**: their terminal codex configuration does not apply inside Lines.
- A cross-provider `setModel` is refused once a session has run, and that refusal stays strict.
  Nothing carries a conversation between a `claudeSessionId` and a `codexThreadId`, and the
  alternative is a continuous transcript in front of a model that knows none of it.
  `SessionManager.switchProvider` is the deliberate way past it — it drops the stranded
  conversation, summarizes it, and seeds the new provider with the summary. See
  [cross-provider-model-switching](cross-provider-model-switching.md).
- Workflow steps run on Claude models only, refused on both the client (the pickers offer no
  OpenAI models) and the server (`validateStepContent`, and a pre-run park).
- Lines' own workflow tools are read-only in a codex session. A codex call reaches the bridge as
  a plain HTTP request on `POST /lines-mcp`, with no permission card anywhere on its path, so that
  route serves `LINES_READ_ONLY_MANIFEST` and dispatches through
  `createMcpDispatcher(ctx, undefined, { allowWrites: false })`, which refuses a write even when
  one is called unlisted. A Claude session keeps the writes, each behind its card
  (`allowWrites: true`). Codex's own approvals are unaffected: commands and file changes still
  reach the card through `canUseTool`.
- `output_tokens` means exactly what the provider called output. Reasoning tokens ride beside
  it in `reasoning_output_tokens` and the spend accumulator adds them explicitly.
- A turn's usage is every model request it made. `thread/tokenUsage/updated` names the latest
  request (`last`) and the thread's running sum of them (`total`, across turns), so the bridge
  sums the growth of `total` over the turn (`codexUsageStep`) — `last` alone is one request.
- Codex reports tokens and never a price. A codex row shows tokens with an *estimated* `$` instead
  — computed from `ModelOption.price` and always marked with a `~` — never a bare `$`, which is
  reserved for a provider-reported figure. See [usage-and-cost](usage-and-cost.md) for the
  estimator, the marker, and why the estimation gate reads `capabilitiesFor(provider).cost`
  rather than "did this particular result carry a cost".
- A stopped codex turn settles as stopped, never as a failure with a Retry.
- A session-scoped helper query (auto-name, turn summary, step consolidation, provider-switch
  hand-off) prefers that session's own provider — a codex session is titled by codex, a Claude
  session by Claude — and falls back to the other provider when the preferred one is absent or
  answers null. A helper with no session (the MCP judge) has no provider to prefer and stays
  Claude-first.
- Every helper query runs in an empty scratch directory (`helperQuery.ts`'s `helperCwd()`), never
  the session's own `cwd`. Both CLIs pull ambient context from their working directory — Claude's
  auto-memory, codex's `AGENTS.md` — and a helper answering a narrow question (a title, a
  summary) must not fold in a project's memory or agent instructions.
- Auto-naming never strands a session on "New session". A helper that answers null or throws
  still writes a title cut from the prompt (`localSessionName`), and the session is retried on
  its next prompt until a real summary lands.

## Architectural rules

- Normalize codex into SDK message shapes on the **bridge**. The worker forwards notifications
  verbatim and interprets nothing, so changing how a codex item renders cannot restart the
  worker and kill every live turn.
- Deltas must wear the `stream_event` envelope. `isDroppable` and the client's supersede rule
  both key off it; any other shape would be undroppable and pile up client-side.
- Ask `shared/providers.ts` about a capability, never a component about a vendor.
- Engine dispatch is the first thing `handleBridgeMessage` does. The Claude control cases are
  `sessions.get(id)?.query.foo(...)`, where the `?.` guards only the lookup — a codex session
  reaching one would throw a synchronous TypeError past the attached `.catch()`.
- Protocol types are generated by the installed CLI, never hand-written, and
  `codexAppServer.contract.test.ts` asserts everything this app reaches for still exists. The
  protocol is experimental, so drift has to fail a test naming the missing method rather than
  parking a turn.
- Nothing in `shared/` may import a server dependency. The protocol types are `export type`
  only, so the browser bundle pays nothing for them.
- `forkCodex(sessionId, lastTurnId, threadId?)` normally forks the session's own live thread
  binding; `threadId` is only supplied when a rewind crosses back into an earlier codex era the
  current worker holds no binding for (see [session-rewind](session-rewind.md)) — the caller
  names the thread explicitly rather than the worker guessing at one.

## Tests

- `server/src/openaiAuth.test.ts` — the device-code flow, including the exact poll body, the
  403-means-pending rule, and the form-encoded PKCE exchange.
- `server/src/codexEvents.test.ts` — the normalizer, including the streaming envelope.
- `server/src/codexCli.test.ts` — discovery order and refusal copy.
- `server/src/sessions.codex.test.ts` — routing, the permission-mode mapping, settle and
  interjection.
- `server/src/codexAppServer.contract.test.ts` — the protocol canary.
- `server/src/openaiUsage.test.ts` — the `/wham/usage` parser.
- `server/src/helperQuery.test.ts` — provider selection for the bridge's own queries, including
  the preferred-provider fallback.
- `server/src/sessions.autoName.test.ts` — a dead helper still names a session from its prompt,
  a failed attempt is retried on the next one, and `nameAuto` still spends on the first try.
- `server/src/mcpConnections.test.ts` — the codex translation of a connection, including the
  bearer-token boundary and the two connection kinds codex cannot express.
- `server/src/workflows.providers.test.ts` — a step that changes provider.
- `server/src/linesMcpStdio.test.ts` — the spawn recipe codex is given for Lines' own tools.
- `server/src/mcpWorkflowTools.test.ts` — the read-only manifest and the no-writes dispatcher the
  codex door uses: every write refused with nothing changed, every read still answered.
- `server/src/codexExperimental.contract.test.ts` — asks the installed binary for a Plan
  collaboration mode, covering what `generate-ts` cannot: the experimental surface is absent
  from its output with or without `--enable collaboration_modes`.
- `server/src/sessions.codexMcpStatus.test.ts` — the connection-status mapping, including the
  null `runtimeStatus` a working server reports.
- `server/src/sessions.switchProvider.test.ts` — `switchProvider` as the deliberate way past
  `setModel`'s refusal; see [cross-provider-model-switching](cross-provider-model-switching.md).

## Related decisions

- **Claude's message shape is the internal model, deliberately.** It is ~80% neutral — the
  places it is not are `ApplyPatch` (a tool name invented so a `fileChange` is not paired into
  a diff card that has no before/after), faked `signature`/`stop_reason` fields, and the
  `_engine`/`_codex` provenance channel that exists because the envelope cannot express
  everything. Of codex's 19 item variants, the ones still unmapped are those with genuinely no
  Claude-shaped home: review-mode markers, multi-agent collab calls, sleep, image generation.
  A neutral event model is deferred until a **third provider** is real — designing one against
  two providers that agree is a two-sample average, not neutrality.
- **Device code, not a redirect.** The bridge binds ephemeral ports and the browser finishing a
  login is frequently not on its machine — the same constraint
  [mcp-connections](mcp-connections.md) documents for its loopback callback.
- **`acceptForSession` is never sent to codex.** Lines keeps its own allowlist; a second copy
  inside codex would split one decision across two stores that cannot be kept in step, and that
  the user can only see one of.
- **Helper queries stay on `codex exec`.** They are genuinely one-shot, so the app-server would
  mean a long-lived child on the bridge for no gain.
- **Provider selection for a helper query is a preference, not a hard route.** A session-scoped
  call passes its own provider; the other one is still tried when the preferred provider is
  disconnected or comes back null, because a degraded title beats no title.
- **Codex is the only writer of its own `config.toml`.** MCP connections reach a codex session
  through codex's `config/batchWrite` RPC rather than Lines editing the file. Same single-writer
  rule `auth.json` follows, and for the same reason.
- **The sandbox carries the permission gate, not the approval policy.** The first cut ran
  `untrusted` believing the auto-guard would approve safe calls; it cannot, because every codex
  command arrives as `Bash` and `isSafeReadOnly` only knows `Read`/`Glob`/`Grep`. Measured, the
  Claude CLI calls `canUseTool` zero times for a read-only Bash command — so codex runs
  `on-request`, and `default` uses a read-only sandbox to make writes escalate. See
  [permissions-and-plan-mode](permissions-and-plan-mode.md).
- **A provider change inside a workflow forces a fresh start.** Nothing links a
  `claudeSessionId` to a `codexThreadId`, so the conversation is dropped rather than handed to a
  model that cannot read it. See [workflow-step-lifecycle](workflow-step-lifecycle.md).
- **A manual provider switch is a distinct, deliberate operation from the workflow-step
  refusal above**, not a loophole in it. `setModel`'s cross-provider refusal is unconditional;
  `SessionManager.switchProvider` is a second entry point that summarizes and drops the
  conversation on purpose, gated on its own capability and CLI/account checks. See
  [cross-provider-model-switching](cross-provider-model-switching.md).
- **The handshake declares `experimentalApi`, and the vendored types do not describe everything.**
  `initialize` sends `capabilities: { experimentalApi: true, requestAttestation: false }`. Plan
  mode lives behind that flag: `collaborationMode/list` and `turn/start`'s `collaborationMode`
  field exist only for a client that declares it, and `generate-ts` runs *without* it — so
  `shared/codexProtocol` omits them, with or without `--enable collaboration_modes` (verified).
  Treating those types as the complete API is what cost this integration a working plan mode for
  several iterations; `codexExperimental.contract.test.ts` covers the part they cannot describe by
  asking the installed binary. `requestAttestation` stays false deliberately — it opts into a
  server→client request Lines does not implement, and an unanswered request parks the turn.
- **An estimated cost must never look identical to a provider-reported one.** Codex's usage
  numbers are real; its price is not. Rather than leave a codex spend row blank of `$`, or worse
  render it exactly like a Claude row, every figure computed from the price table wears a `~` —
  the single rule the whole estimation design turns on. See [usage-and-cost](usage-and-cost.md).
- **A manually chosen reasoning effort rides `collaborationMode`, not `turn/start.effort`** — the
  typed field exists, but the collaboration mode is already sent on every turn for plan mode, so
  this is one code path instead of two dials with no documented precedence. See
  [reasoning-effort-selection](reasoning-effort-selection.md), including the measured fact that
  drove its vocabulary: codex rejects `minimal` outright, despite OpenAI's own docs listing it.
