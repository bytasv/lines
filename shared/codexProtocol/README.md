# Codex app-server protocol types

**Generated. Do not edit by hand.**

Produced by the Codex CLI itself:

```sh
npm run gen:codex-protocol -w @lines/server
```

which runs `codex app-server generate-ts` against the `codex` binary this machine
has installed, then `server/scripts/normalize-codex-protocol.mjs` over the output —
ts-rs emits extensionless relative imports, which `moduleResolution: nodenext`
rejects.

## Why these are vendored

The app-server protocol is marked experimental by the CLI and is not published as
a package. Hand-written types would drift silently; these are the CLI's own
`ts-rs` output, so a protocol change shows up as a type error the next time
someone regenerates rather than as a runtime surprise mid-turn.

They are committed (not generated at build time) so the repo typechecks on a
machine with no `codex` installed.

## Why they live in `shared/`

Every file here is `export type` only — nothing survives compilation, so the
browser bundle pays nothing for them even though `shared/` is bundled. Keeping
them here lets the normalizer in `shared/codex.ts` work against the real protocol
shapes instead of re-declaring its own copy.

## Regenerating

Regenerate whenever the `codex` floor in `server/src/codexCli.ts` is bumped.
`server/src/codexAppServer.contract.test.ts` is the canary: it asserts the method
names and payload shapes this app actually depends on still exist.
