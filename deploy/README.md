# Deploying Lines on a single VPS

Runbook for running Lines on one Hostinger KVM2-class box (2 vCPU / 8 GB /
Ubuntu 24.04) behind a public HTTPS domain: three systemd units (worker, bridge,
storage), nginx serving `web/dist` and proxying the bridge WebSocket, Clerk for
multi-user auth, hosted Supabase for storage.

Replace `lines.example.com` with your domain everywhere below and in
`deploy/nginx/lines.conf`.

> **The bridge is a remote shell.** Any Clerk-authenticated user gets Bash,
> Write and Edit as the `lines` user, over any directory they can name. Lock
> Clerk sign-up to an allowlist *before* DNS goes live (step 4.6), never grant
> `lines` sudo beyond the narrow `systemctl lines-*` rule, and host nothing else
> on this box. Read [Security](#security) before exposing it.

## Files in this directory

| Path | Installs to |
|---|---|
| `systemd/lines-worker.service` | `/etc/systemd/system/lines-worker.service` |
| `systemd/lines-bridge.service` | `/etc/systemd/system/lines-bridge.service` |
| `systemd/lines-storage.service` | `/etc/systemd/system/lines-storage.service` |
| `systemd/lines-backup.service` | `/etc/systemd/system/lines-backup.service` |
| `systemd/lines-backup.timer` | `/etc/systemd/system/lines-backup.timer` |
| `nginx/lines.conf` | `/etc/nginx/sites-available/lines` |
| `env.production.example` | copy to `/home/lines/app/.env`, `chmod 600` |
| `deploy.sh` | run in place from the checkout |
| `backup-lines.sh` | run in place from the checkout |

## The five things that silently break this

1. **`proxy_pass` must have no trailing slash and no URI.** The client opens
   `wss://host/bridge/?token=…`. With `proxy_pass http://127.0.0.1:8787/;`
   nginx rewrites the URI to `//?token=…` and `new URL()` throws inside the
   bridge's connection handler — an unhandled rejection, not a 4xx, on every
   login. The bridge's `WebSocketServer` has no `path` filter, so `/bridge/`
   is accepted verbatim; no code change is needed.
2. **`VITE_BRIDGE_WS_URL` must be set at build time.** Unset, the client falls
   back to a vite-dev-only `/__bridge` probe that cannot exist in a static
   build, and parks on "reconnecting" forever. `wss://`, no trailing slash.
3. **`npm ci` with the full tree.** `tsx` and `vite` are devDependencies, so no
   `--omit=dev`. The Linux `claude` binary is an optionalDependency, so no
   `--omit=optional`. `ignore-scripts` is needed (electron's download in
   `desktop/`), which skips `prisma generate` — so run `npm run generate -w
   storage` explicitly, every time.
4. **ufw is what hides 8787 and 8790.** Both bind `0.0.0.0`; only the worker
   pins `127.0.0.1`. And a bridge running with `BRIDGE_AUTH_DISABLED=1` or no
   `CLERK_SECRET_KEY` is an unauthenticated remote shell.
5. **Migrate before starting storage.** `prisma migrate deploy` uses
   `DIRECT_URL` (`:5432`), not the pooled `:6543`. Start storage first and
   `$connect()` succeeds against an empty database, the service looks healthy,
   and P2021 is swallowed by sync's best-effort catches — a silently degraded
   app rather than a crash.

## 1. Provision the box (as root)

```bash
apt-get update && apt-get -y upgrade
apt-get -y install curl git ca-certificates gnupg ufw fail2ban unattended-upgrades \
                   nginx certbot python3-certbot-nginx gnupg rclone
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get -y install nodejs                     # v22 LTS; the repo needs >= 20

# Deploy user. Claude Code runs AS THIS USER. No sudo, no docker group.
adduser --disabled-password --gecos "" lines
install -d -o lines -g lines -m 700 /home/lines/.ssh
cp /root/.ssh/authorized_keys /home/lines/.ssh/authorized_keys
chown lines:lines /home/lines/.ssh/authorized_keys && chmod 600 /home/lines/.ssh/authorized_keys

# Swap: the vite build peaks around 1.5 GB and each claude child is a 262 MB binary.
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf && sysctl -w vm.swappiness=10

# Firewall — this is what hides 8787/8788/8790.
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
ufw status verbose                            # 8787/8788/8790 must NOT appear

sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh
```

Point `A lines.example.com` at the VPS IP **before** running certbot.

## 2. Checkout and install (as `lines`)

The repo is private, so GitHub needs a read-only deploy key.

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C lines-vps
cat ~/.ssh/id_ed25519.pub          # add under repo Settings -> Deploy keys (read-only)
ssh-keyscan github.com >> ~/.ssh/known_hosts
git clone git@github.com:bytasv/lines.git ~/app && cd ~/app

# Box-local npmrc, so behaviour does not depend on whatever global npmrc exists.
printf 'ignore-scripts=true\naudit=false\nfund=false\n' > ~/.npmrc

npm ci                             # full tree, ~1.2 GB, 3-6 min
npm run generate -w storage        # mandatory: postinstall was skipped

ls -la node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude   # ~262 MB, 755
node_modules/.bin/tsx --version && node_modules/.bin/vite --version
```

## 3. `/home/lines/app/.env`

```bash
cp ~/app/deploy/env.production.example ~/app/.env
chmod 600 ~/app/.env
$EDITOR ~/app/.env
```

Every variable is annotated in that template. Do **not** wire this file into
systemd's `EnvironmentFile=`: systemd treats `#` after whitespace as a comment
and does no shell expansion, so a Postgres password containing `#`, `$` or a
space is mangled. The bridge and the storage server dotenv-load it themselves;
the worker's two variables live in its unit file.

## 4. Clerk production instance

The web client renders `<ClerkProvider>` with no `signInUrl`/`routing`, so
Clerk's hosted Account Portal handles sign-in — that needs full production DNS,
not just an origin allowlist.

1. Clerk Dashboard: create a Production instance (or "Deploy to production" to
   clone dev settings).
2. Domains: `lines.example.com`.
3. Add the generated CNAMEs at your DNS provider — `clerk.`, `accounts.`,
   `clkmail.`, `clk._domainkey.`, `clk2._domainkey.`. Sign-in is broken until
   all of them verify.
4. Paths: after sign-in and sign-up, `https://lines.example.com/`.
5. Allowed origins: `https://lines.example.com`.
6. **Restrictions: allowlist your own addresses, or disable public sign-up.**
   Anyone who signs up gets a shell on this box.
7. Copy `pk_live` / `sk_live` into `.env`.

`VITE_CLERK_PUBLISHABLE_KEY` is baked into the bundle, so changing it needs a
rebuild, not a restart. A `pk_test` + `sk_live` mismatch shows up only as a
`1008 unauthorized` close on every socket.

## 5. Migrations (before starting storage)

```bash
cd /home/lines/app
npm run generate -w storage
npm run migrate -w storage         # dotenv -e ../.env -- prisma migrate deploy
cd storage && npx dotenv -e ../.env -- npx prisma migrate status; cd ..
# expect "Database schema is up to date!"
```

P2021 causes, in the order worth checking: (a) storage was started before the
migration ran; (b) `DATABASE_URL` and `DIRECT_URL` address different Supabase
projects — diff the `<ref>` host segment, they must match apart from
`:6543?pgbouncer=true` vs `:5432`; (c) `DIRECT_URL` unset, so Prisma falls back
to the pooled URL and `migrate deploy` hangs on the advisory lock or half
applies; (d) a mismatched `?schema=`.

## 6. systemd units

```bash
sudo cp /home/lines/app/deploy/systemd/lines-*.service \
        /home/lines/app/deploy/systemd/lines-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lines-worker lines-storage lines-bridge
sudo systemctl enable --now lines-backup.timer

journalctl -u lines-bridge | grep -i '\[auth\]' || echo "OK: the auth gate is ON"
```

If `[auth] bridge auth disabled` appears, **stop**: `CLERK_SECRET_KEY` is not
reaching the process and the bridge is a public shell.

Restarting `lines-worker` kills every in-flight turn. That is the whole point of
the split — the bridge can restart freely without doing so.

Grant the deploy user exactly the verbs the scripts need, nothing broader:

```
# /etc/sudoers.d/lines-deploy
lines ALL=(root) NOPASSWD: /usr/bin/systemctl start lines-*, \
                           /usr/bin/systemctl stop lines-*, \
                           /usr/bin/systemctl restart lines-*, \
                           /usr/bin/systemctl reload nginx
```

## 7. nginx + TLS

```bash
sudo cp /home/lines/app/deploy/nginx/lines.conf /etc/nginx/sites-available/lines
sudo sed -i 's/lines\.example\.com/YOUR.DOMAIN/g' /etc/nginx/sites-available/lines
sudo ln -sf /etc/nginx/sites-available/lines /etc/nginx/sites-enabled/lines
sudo rm -f /etc/nginx/sites-enabled/default
sudo chmod o+x /home/lines /home/lines/app /home/lines/app/web   # www-data must traverse
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d YOUR.DOMAIN --agree-tos -m you@example.com --redirect
sudo certbot renew --dry-run && systemctl status certbot.timer --no-pager
```

Certbot rewrites the `server` blocks in place; re-check `nginx -t` and the
`/bridge` block afterwards. The storage server gets no location block — the
browser never calls it.

## 8. Build and first run

```bash
cd /home/lines/app && npm run build -w web
grep -ro 'wss://[a-z0-9.-]*/bridge' web/dist/assets | head -1   # must be your domain
sudo systemctl reload nginx
```

Then, in the browser:

1. `https://lines.example.com/` → Clerk Account Portal → sign in → back to `/`.
   The connection pill should reach **connected**. Stuck on reconnecting?
   DevTools → Network → WS: `101` is good, `403`/`404` means the nginx location
   is wrong, a `1008` close means the Clerk keys mismatch.
2. **Log in to Claude.** Lines runs its own OAuth PKCE flow and does not use an
   ambient `~/.claude` login or any API key. Click *Log in to Claude*, approve
   in the new tab, copy the `code#state` string **whole, including the `#`**,
   and paste it back into the modal. The pending login expires after 30 minutes.
   Verify `~/.lines-app/users/<clerkId>/auth.json` is mode 0600. Per user, each
   burning that user's own Claude quota.
3. Sessions need a typed path — the native folder picker returns `null` on
   Linux. `git clone` your targets into `/home/lines/workspaces/` first.
4. Optional: adopt an existing store. `tar` `~/.lines-app` from your laptop
   (excluding `run/` and `plugins/`), scp it over, **stop `lines-bridge`** (the
   script refuses while it is running), then
   `npm run migrate -w server -- <clerkId> --from /home/lines/import/.lines-app`.
   Append-only, union by id, never deletes the source.

## 9. Deploying a change

```bash
/home/lines/app/deploy/deploy.sh
```

Pulls `main`, reinstalls only if `package-lock.json` moved, regenerates the
Prisma client unconditionally, migrates, rebuilds, verifies the WS URL is
actually in the bundle, then restarts storage → worker → bridge and reloads
nginx. A web-only diff short-circuits to a rebuild plus an nginx reload, so no
in-flight turn dies.

Tag each good deploy: `git tag deploy-$(date +%Y-%m-%d-%H%M)`.

**Rollback:**

```bash
cd /home/lines/app && git checkout <PREV>
npm ci && npm run generate -w storage && npm run build -w web
sudo systemctl restart lines-storage lines-worker lines-bridge
```

Migrations do **not** roll back — `migrate deploy` is forward-only, and
`migrate resolve --rolled-back` rewrites bookkeeping, not DDL. The schema is
additive (JSON blobs and indexes), so roll the code back and leave the schema
forward.

## 10. Backups

`~/.lines-app` is the source of truth; Postgres is a best-effort mirror. Losing
that directory loses transcripts, attachments, Claude OAuth tokens and guard
allowlists — **Supabase will not save you.**

`lines-backup.timer` runs `deploy/backup-lines.sh` nightly at 03:30: stop the
bridge (`sessions.json` is rewritten whole, so a mid-write snapshot is torn),
tar excluding `run/` (regenerated) and `plugins/` (re-cloned), restart the
bridge, encrypt with GPG (the archive holds live OAuth refresh tokens), push to
R2 with rclone, keep 14 days locally.

Setup:

```bash
install -d -m 700 /home/lines/.config
openssl rand -base64 48 > /home/lines/.config/lines-backup.passphrase
chmod 600 /home/lines/.config/lines-backup.passphrase    # store a copy OFF the box
rclone config                                            # remote named "r2"
sudo systemctl start lines-backup.service && journalctl -u lines-backup -n 30
```

Restore-test quarterly against a throwaway `LINES_INSTANCE`. `tar tzf` is not a
restore test.

## Verification checklist

**Infrastructure**

- [ ] `ufw status verbose` — only 22/80/443; 8787/8788/8790 absent.
- [ ] `ss -tlnp` — 8788 on `127.0.0.1` only; 8787 and 8790 on `0.0.0.0` but firewalled.
- [ ] From another host, `curl --max-time 5 http://<IP>:8787/` and `:8790/health` both time out.
- [ ] `certbot renew --dry-run` passes; `certbot.timer` is active.

**Services**

- [ ] `systemctl is-active lines-worker lines-bridge lines-storage` — three × active.
- [ ] `journalctl -u lines-bridge | grep '\[auth\] bridge auth disabled'` — no match.
- [ ] `ls -l ~/.lines-app/run/prod/` — `bridge.json` and `worker.json`, both `-rw-------`.
- [ ] `curl localhost:8790/health` → `{"ok":true}`; `curl -o /dev/null -w '%{http_code}' localhost:8790/workflows` → `401`.
- [ ] `systemctl restart lines-worker`, and `journalctl -u lines-bridge -f` shows a reconnect within ~2 s with no bridge restart.
- [ ] Reboot the VPS; all three come back and the browser reconnects.

**Web and TLS**

- [ ] `https://` loads, `http://` 301s, a deep link like `/some/route` returns the SPA (200, not 404).
- [ ] `grep -ro 'wss://[a-z0-9.-]*/bridge' web/dist/assets` — your domain.
- [ ] DevTools → Network → WS: `/bridge/?token=…` returns 101, stays open, ping/pong ~1 s.
- [ ] No mixed-content errors. `/assets/*` is `immutable`; `/index.html` is `no-store`.

**Application**

- [ ] Clerk sign-in reaches the connected pill; sign-out closes with 1008 and parks on reconnecting without spinning the CPU.
- [ ] The Claude OAuth paste completes; `auth.json` is 0600 under `users/<clerkId>/`.
- [ ] A prompt streams tokens; a Read/Edit tool call renders a card; an Allow/Deny permission prompt works.
- [ ] **Open the Monaco diff modal and FilesView** — this is what a botched CSP breaks.
- [ ] A turn longer than 90 s completes without the socket dropping.
- [ ] A multi-step workflow passes through one manual approval gate.
- [ ] No amber `StorageBanner` — bridge ↔ storage ↔ Supabase is healthy.
- [ ] A recipe with an image uploads to R2 and renders from `R2_PUBLIC_BASE_URL`.
- [ ] `ls ~/.lines-app/plugins/caveman-repo` exists (git clone and outbound HTTPS work).

**Ops**

- [ ] `systemctl start lines-backup.service` produces an encrypted artifact in R2; restore it into a scratch directory and boot a throwaway instance against it.
- [ ] `deploy/deploy.sh` runs end to end on a no-op commit.

## Security

- **The bridge is a remote shell as `lines`.** Every Clerk-authenticated user
  gets Bash/Write/Edit over any directory they name. Lock sign-up to an
  allowlist before DNS goes live; give `lines` no sudo beyond the narrow
  `systemctl lines-*` rule; treat the box as fully compromised if any user is.
- **The guard allowlist is convenience, not a boundary** — it is per-user
  opt-in, so a hostile user simply allowlists everything.
- **Agent settings are honoured from both the user and the project scope**, so
  cloning an untrusted repo and opening it on this box is arbitrary hook
  execution. The caveman plugin is `git clone`d from GitHub at runtime and
  loaded, so an upstream compromise is code execution here too.
- **No Origin check on the WS upgrade** — the bridge verifies the JWT only. The
  token travels in the query string, hence `access_log off` and the
  `$http_origin` guard in the nginx block.
- **Secrets sit in plaintext** at `/home/lines/app/.env`, readable by Claude
  Code running as `lines` — including during a prompt-injected turn. `chmod
  600` is the floor. Use a scoped Supabase role rather than the superuser and a
  bucket-scoped R2 token; rotate on suspicion.
  `~/.lines-app/users/*/auth.json` has the same exposure.

## Capacity notes

Each concurrent turn is a separate `claude` native binary — 262 MB on disk,
expect 300-600 MB RSS. Three or four parallel sessions plus bridge, storage and
nginx approach 8 GB, and two vCPUs means turns visibly queue. The 4 GB swap plus
`MemoryHigh=5G`/`MemoryMax=6G` on the worker means the OOM killer takes a Claude
child rather than sshd. Run `npm run build -w web` when no turns are active
(vite peaks around 1.5 GB), or build elsewhere and rsync `web/dist`.
`LINES_PERF=1` surfaces event-loop lag; the bridge is single-threaded, so one
large transcript parse stalls every session.
