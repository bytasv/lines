# OpenAI Codex sessions

Covers: `openai-account-login`, `codex-turn-engine`, `provider-capabilities`.

## Purpose

A second agent provider. A session whose model is an OpenAI one runs its turns through the
`codex` CLI instead of the Claude one, and a **Connect** row beside the Claude sign-in in
Settings → Account is how the account gets there.

Everything that makes a session a session is at parity: token streaming, permission cards,
plan mode, Send now, compaction, the context ring, and rewind all work on a codex session and
go through the *same* bridge machinery a Claude session does. What is not at parity is tools —
Lines' own workflow tools and the user's MCP connections do not reach a codex session yet, and
workflows are refused on both the client and the server because of it.

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

- `web/src/components/SettingsModal.tsx` — the Account pane's OpenAI row and its **Connect…**
  button.
- `web/src/components/OpenaiLoginModal.tsx` — the device-code modal.
- `server/src/openaiAuth.ts` — the login flow and the connected/disconnected state.
- `server/src/workerCodex.ts` — the worker's codex half: threads, turns, approvals.
- `server/src/codexAppServer.ts` — the JSON-RPC client over the long-lived `codex app-server`.
- `shared/codex.ts` — notification → SDK-shape normalization.
- `shared/providers.ts` — the capability table.

## Files

- `server/src/openaiAuth.ts` — device-code login, account metadata, logout.
- `server/src/openaiUsage.ts` — ChatGPT plan-usage poller.
- `server/src/codexCli.ts` — `codex` binary discovery and the version floor.
- `server/src/codexAppServer.ts` — spawn, handshake, request/notification demux.
- `server/src/workerCodex.ts` — thread binding, turns, steering, compaction, forking.
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
  token per request and never caches it. Only codex can refresh it, so a stale token hides the
  usage chip rather than being refreshed here.
- A codex turn carries no credential. It carries a `CODEX_HOME`.
- `CODEX_HOME` is `~/.lines-app/users/<id>/codex/`, which **shadows the user's own
  `~/.codex/config.toml`**: their terminal codex configuration does not apply inside Lines.
- A cross-provider `setModel` is refused once a session has run. Nothing carries a conversation
  between a `claudeSessionId` and a `codexThreadId`, and the alternative is a continuous
  transcript in front of a model that knows none of it.
- Workflow steps run on Claude models only, refused on both the client (the pickers offer no
  OpenAI models) and the server (`validateStepContent`, and a pre-run park).
- `output_tokens` means exactly what the provider called output. Reasoning tokens ride beside
  it in `reasoning_output_tokens` and the spend accumulator adds them explicitly.
- Codex reports tokens and never a price, so a codex row shows tokens with no `$`.
- A stopped codex turn settles as stopped, never as a failure with a Retry.

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

## Tests

- `server/src/openaiAuth.test.ts` — the device-code flow, including the exact poll body, the
  403-means-pending rule, and the form-encoded PKCE exchange.
- `server/src/codexEvents.test.ts` — the normalizer, including the streaming envelope.
- `server/src/codexCli.test.ts` — discovery order and refusal copy.
- `server/src/sessions.codex.test.ts` — routing, the permission-mode mapping, settle and
  interjection.
- `server/src/codexAppServer.contract.test.ts` — the protocol canary.
- `server/src/openaiUsage.test.ts` — the `/wham/usage` parser.
- `server/src/helperQuery.test.ts` — provider selection for the bridge's own queries.

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
