# Where your data goes

Lines is a web GUI for coding agents (Claude Code and Codex). The agent runs on
your machine, with your files, git and CLI login. Nothing is executed in the
cloud. The hosted service at linesapp.cloud relays live traffic between your
browser and that machine, and keeps a synced copy of some metadata so every
device you sign in from sees the same sessions.

This page lists what goes where. It covers the hosted service. If you run Lines
entirely locally (`npm run dev`), none of the hosted rows apply. If you
[self-host the server side](deploy/README.md#self-hosting), the "Lines storage"
and "Lines servers" rows move to a server you run, but Clerk still applies.

Each row is traceable to the code: `storage/prisma/schema.prisma` for what is
stored, and [end-to-end encryption](docs/codebase/features/end-to-end-encryption.md)
for what the relay can and cannot see.

## Stays on your machine

Stored only on your machine, never on Lines servers. Anything you open in a
browser reaches it live through the relay (next section), and the agent sends
what it reads to your model provider (the section after).

| Data | Notes |
|---|---|
| Source files, git, terminal, the agent process | Every agent turn runs on the paired machine. |
| Full transcripts | Kept in `~/.lines-app`. Storage holds session *metadata* only (below). |
| Claude Code and Codex logins | The Claude login and `$CODEX_HOME/auth.json` stay local. |
| MCP header values | The synced MCP list carries header *names* only. |
| Device pairing secret | Generated on the machine. Storage keeps a SHA-256 hash, never the secret. |
| End-to-end encryption keys | The machine's key and the enrolled-browser list stay in `~/.lines-app`. A browser's private key stays in that browser. |
| Voice dictation audio | Transcribed by whisper on your machine. From a phone, the audio reaches the machine through the relay. |
| Web Push subscriptions | Held by the bridge on each machine, not synced. |

## Goes to your model provider

| Data | Notes |
|---|---|
| Prompts, and the code context the agent reads | Sent to Anthropic or OpenAI under your own account and their terms, the same as using the CLI directly. Lines adds nothing to this path and sees none of it. |

## Passes through the Lines relay

| Data | Notes |
|---|---|
| Live traffic between your own enrolled browsers and your machine | End-to-end encrypted. The relay forwards ciphertext it cannot read or forge. |
| Live traffic for guests you invite into a session | **Not end-to-end encrypted yet.** Guest connections cross the relay in plaintext (TLS to the relay only), so the relay could read them. |
| Connection metadata | The relay sees which device connects, when, and how much traffic flows. It can also drop or delay traffic. |

## Stored on Lines storage (Postgres)

Stored **in plaintext** today, so sessions follow you across devices. Access is
filtered by your Clerk user id. The hosted service's database runs on
Supabase. Encrypting these blobs client-side is a possible future change, not a
current one.

| Data | Notes |
|---|---|
| Account identity | Clerk user id; email, display name and avatar URL cached for sharing. |
| Session list metadata | Names, absolute `cwd` paths, model, cost and token counts, error messages, **queued prompts**, **context compaction summaries**, **workflow step outputs**, background task descriptions, and file names (attachments, @-mentioned files, untracked files). Summaries, outputs and queued prompts can quote code. |
| Workflows, steps and recipes | Your own, including every saved version. **Anything you publish is readable by every signed-in user**, as is its run count. |
| Settings | UI settings, the auto-mode guard allowlist, and the MCP server list (no header values). |
| Agent memory | Allowlisted `~/.claude` files, such as `CLAUDE.md` and per-project memory. |
| Project path keys | A map from absolute `cwd` paths to project keys. |
| Paired devices | Device name, platform, last seen, online state, and the pairing secret's hash. |
| Sharing | Invites (including the invitee's email), grants, and your share contacts list. |

## Stored on Cloudflare R2

| Data | Notes |
|---|---|
| Recipe screenshots you upload | Kept in a **public-read** bucket. Anyone with an image's URL can load it, whether or not the recipe is published. |
| Desktop app releases | The DMG and the update feed are served from a separate public bucket. Cloudflare sees the IP address of each download and of each update check the desktop app makes. |

## Third-party services

| Service | What it sees |
|---|---|
| Clerk (sign-in) | Your account identity (user id, email, profile) and sign-in sessions. Required by the hosted service, and still required when you self-host storage. |
| Supabase (database hosting) | Hosts the Lines storage database, so it holds everything listed under "Stored on Lines storage". |
| The VPS provider hosting linesapp.cloud | Runs the relay, the storage server and the web servers, and holds their logs. Like any host, it has access to the machine. |
| Your browser's push service (Apple, Google, Mozilla or Microsoft) | Only if you turn on push alerts. Each alert carries the session name and a short status ("Task complete", "Needs approval"). The payload is encrypted to your browser; the push service sees when alerts are sent. |
| Cloudflare R2 | As above. |
| Anthropic or OpenAI | As above, under your own account. |

## Lines servers

| Data | Notes |
|---|---|
| Web access logs | IP address, URL (including any `?ref=` tag), referrer and user agent, written by nginx to the container log and dropped by log rotation. Used only for aggregate visit and download counts. There is no analytics or tracking script on any page. |
| Connection diagnostics | When a browser was stuck connecting to your machine, it uploads a record of that attempt once the link recovers, or when you press the upload button on the connecting screen: device id, user agent and timed connection events, with tokens redacted. Written to the storage log, not to the database. |
| Layout diagnostics | The installed phone app (home-screen mode only) uploads a few viewport measurements (screen and keyboard heights, safe-area insets) to debug layout, at most 20 per page load. Same storage log, same handling. |

## Self-hosting

Self-host the server side to keep the storage, relay and log rows on
infrastructure you control: your own server, with your own Supabase project or
a standalone Postgres. See [Self-hosting](deploy/README.md#self-hosting). Clerk
still holds your account identity, because sign-in depends on it.

## Deletion requests

To delete your account and everything stored for it, email
vytautas.butkus@gmail.com from the address you signed in with. Data on your own
machine is yours to delete: remove `~/.lines-app` and the desktop app.

Report security issues through [SECURITY.md](SECURITY.md), not by email.
