# -*- mode: Python -*-
#
# Lines — local dev orchestration.
#
# No containers, no Docker, no Kubernetes: every process is a `local_resource`.
# Postgres is hosted Supabase, configured via the repo-root .env — Tilt never
# runs a database.
#
# `npm run dev` at the repo root remains a working fallback (same npm scripts,
# same ports). Tilt is the default because it adds: readiness probes, per-process
# PORT injection, the Prisma-generate step that global `ignore-scripts=true`
# silently skips, a preflight that fails loudly instead of letting the storage
# server exit(0), and one-click typecheck/test/migrate.
#
# Tilt does NOT watch source files — `tsx watch` and Vite HMR own that. Do not
# add `deps=` to the service resources; see the note on `worker` below.

version_settings(constraint='>=0.33.0')
update_settings(max_parallel_updates=8)

config.define_bool('no-storage', usage='Skip storage + Prisma (offline / no Supabase).')
config.define_bool('with-studio', usage='Start Prisma Studio on :5555 at tilt up.')
config.define_bool(
    'with-relay',
    usage='Start the relay on :8791 and point the bridge at it, so the browser ' +
          'reaches the bridge through the tunnel instead of directly. Off by ' +
          'default: the bridge only dials when RELAY_URL is set.',
)
config.define_bool(
    'no-ui-buttons',
    usage='Skip the freeze/resume reload buttons. They come from ext://uibutton, ' +
          'which is fetched from GitHub the first time it is used — pass this to ' +
          'start fully offline.',
)
config.define_string_list(
    'no-reload',
    usage='Freeze hot reload: worker | bridge | all. Runs the no-watch npm script ' +
          'so tsx never restarts the process mid-turn. Restart by hand from the Tilt ' +
          'UI (or `tilt trigger worker`). Live-togglable: `tilt args -- --no-reload worker`, ' +
          'or the Freeze/Resume reload buttons on the worker and bridge resources.',
)
cfg = config.parse()
WITH_STORAGE = not cfg.get('no-storage', False)
WITH_STUDIO = cfg.get('with-studio', False)
WITH_RELAY = cfg.get('with-relay', False)
WITH_BUTTONS = not cfg.get('no-ui-buttons', False)

# Whether the bridge reaches a hosted install is NOT a Tilt flag: it follows from
# RELAY_URL in .env, which the bridge reads itself. A flag would be a second
# source of truth for the same decision, and the version that rebuilt the whole
# resource list took `pair-device` away with it every time it was switched off.
# To run agent-only against a deployment, disable `web` and `storage` from the
# Tilt UI — per-resource enable/disable is built in.

# Accept both `--no-reload worker --no-reload bridge` and `--no-reload worker,bridge`.
NO_RELOAD = []
for entry in cfg.get('no-reload', []):
    for part in entry.split(','):
        part = part.strip()
        if part:
            NO_RELOAD.append(part)

FREEZABLE = ['worker', 'bridge']
KNOWN_RELOAD = FREEZABLE + ['all']
for name in NO_RELOAD:
    if name not in KNOWN_RELOAD:
        fail('--no-reload %s is not one of %s. (web is excluded: Vite HMR patches ' % (name, '|'.join(KNOWN_RELOAD)) +
             'modules in place and never restarts the process, so it cannot kill a turn.)')

# `all` is input sugar; everything downstream — warnings, banner, buttons — works
# off the expanded list so there is one representation of the frozen state.
FROZEN = [n for n in FREEZABLE if 'all' in NO_RELOAD or n in NO_RELOAD]

def frozen(name):
    return name in FROZEN

# tsx watch owns reload; the ONLY lever is which npm script runs. `start`/
# `start:worker` (server/package.json:9-10) are the existing no-watch entries.
WORKER_CMD = 'npm run start:worker -w server' if frozen('worker') else 'npm run dev:worker -w server'
BRIDGE_CMD = 'npm run start -w server' if frozen('bridge') else 'npm run dev -w server'

if frozen('worker'):
    warn('worker reload FROZEN — edits to server/src/worker.ts or workerProtocol.ts ' +
         'will NOT take effect until you restart the `worker` resource by hand. ' +
         'If you edit workerProtocol.ts while the bridge stays hot, the bridge will ' +
         'log a protocol-version mismatch (server/src/workerClient.ts:92-100) and keep ' +
         'retrying until you do.')
if frozen('bridge'):
    warn('bridge reload FROZEN — restart the `bridge` resource by hand to pick up ' +
         'edits to server/src/*.ts.')

# Ports: single source of truth, injected per-process via serve_env. NOT read
# from .env, because server/src/index.ts:21 and storage/src/index.ts:43 both
# read the same `PORT` key out of the same root .env file.
BRIDGE_PORT = 8787
RELAY_PORT = 8791
WORKER_PORT = 8788
STORAGE_PORT = 8790
WEB_PORT = 5173
STUDIO_PORT = 5555
ENV_FILE = '.env'

# ---- preflight -------------------------------------------------------------
# Key NAMES only. No .env value is ever printed, logged, or copied into a spec.

def shq(s):
    return "'" + s.replace("'", "'\\''") + "'"

def fail_cmd(lines):
    return '; '.join(['echo %s 1>&2' % shq(l) for l in lines] + ['exit 1'])

def dotenv_keys(path):
    if not os.path.exists(path):
        return []
    keys = []
    for raw in str(read_file(path)).splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        parts = line.split('=', 1)
        if parts[1].strip():  # present-but-empty counts as missing
            keys.append(parts[0].strip())
    return keys

watch_file(ENV_FILE)
DOTENV_KEYS = dotenv_keys(ENV_FILE)

def have(key):
    # A shell-exported var is legitimately sufficient — dotenv does not override.
    return bool(os.getenv(key, '')) or key in DOTENV_KEYS

NODE_MAJOR = int(str(local("node -p \"process.versions.node.split('.')[0]\"",
                           quiet=True, echo_off=True)).strip())
if NODE_MAJOR < 20:
    fail('Node 20+ required, found major version %d (README Requirements).' % NODE_MAJOR)

# DIRECT_URL is not optional even though only `prisma migrate` dials it: it is
# referenced by the datasource block (storage/prisma/schema.prisma:4-8), so the
# generated client refuses to initialise without it.
STORAGE_REQUIRED = ['DATABASE_URL', 'DIRECT_URL', 'CLERK_SECRET_KEY']
MISSING = [k for k in STORAGE_REQUIRED if not have(k)]

if not os.path.exists(ENV_FILE):
    preflight_cmd = fail_cmd([
        'PREFLIGHT FAILED: no .env at the repo root.',
        '',
        'The bridge (server/src/index.ts:10), the storage server',
        '(storage/src/index.ts:12) and vite (web/vite.config.ts envDir) all read',
        'this one file.',
        '',
        'Fix:  cp .env.example .env    then fill in Clerk + Supabase values.',
    ])
elif MISSING:
    preflight_cmd = fail_cmd([
        'PREFLIGHT FAILED: missing/empty in .env: ' + ', '.join(MISSING),
        '',
        'Without these the storage server calls process.exit(0) at',
        'storage/src/index.ts:14-21 -- a clean exit that looks like success.',
        'Failing here so the cause is visible.',
        '',
        'Supabase dashboard -> Settings -> Database (DATABASE_URL = pooled,',
        'DIRECT_URL = direct); Clerk dashboard -> API keys (CLERK_SECRET_KEY).',
        '',
        'Or run without storage:  tilt up -- --no-storage',
    ])
else:
    preflight_cmd = 'echo "preflight ok: .env present, %s set"' % ', '.join(STORAGE_REQUIRED)

# Warnings, not failures: the bridge/worker/web stack runs fine without these.
if not have('VITE_CLERK_PUBLISHABLE_KEY'):
    warn('VITE_CLERK_PUBLISHABLE_KEY unset — web renders without a sign-in gate.')

# RELAY_URL in .env is what makes this machine reachable from a hosted install.
# Both halves have to agree: dialling a deployed relay while syncing to a local
# storage server splits one machine's data across two databases.
RELAYED = have('RELAY_URL')
if RELAYED and not have('STORAGE_URL'):
    warn('RELAY_URL is set but STORAGE_URL is not — the bridge will dial the ' +
         'hosted relay while syncing to localhost. Set STORAGE_URL to the same ' +
         'deployment (https://api.<domain>), or unset RELAY_URL for local-only.')
# PORT used to be read by BOTH the bridge and storage out of this one .env file,
# so a single value collided. The bridge now reads LINES_BRIDGE_PORT, leaving
# PORT to storage alone — nothing to warn about.

local_resource('preflight', cmd=preflight_cmd, labels=['setup'], allow_parallel=True)

# ---- install ---------------------------------------------------------------
# `package-lock.json` is deliberately NOT in `deps`. `npm install` REWRITES the
# lockfile, and Tilt keeps file changes that land after a build started as
# pending changes for the NEXT build -- it consumes only changes older than the
# build's start time. A resource that watches a file its own cmd writes
# retriggers itself forever, which is exactly what happens the moment a new
# dependency makes the lock non-idempotent. Watch the manifests instead.
#
# Consequence: a `git pull` that moves ONLY package-lock.json triggers nothing.
# Run `tilt trigger install` by hand. Symptom if you forget is a normal
# missing/stale-module error from a service.

local_resource(
    'install',
    cmd='npm install',
    deps=['package.json', 'shared/package.json', 'server/package.json',
          'web/package.json', 'storage/package.json'],
    labels=['setup'],
    allow_parallel=True,
)

# ---- prisma generate -------------------------------------------------------
# THE trap this Tiltfile closes: global ~/.npmrc sets ignore-scripts=true, so
# storage's postinstall `prisma generate` (storage/package.json:10) never runs.
# Without it storage dies at prisma.$connect() (storage/src/index.ts:32-41).

if WITH_STORAGE:
    local_resource(
        'prisma-generate',
        cmd='npm run generate -w storage',
        deps=['storage/prisma/schema.prisma'],
        resource_deps=['install'],
        labels=['db'],
        allow_parallel=True,
    )

# ---- services --------------------------------------------------------------
# NO `deps=` here on purpose. tsx watch / vite own file watching.

local_resource(
    'worker',
    cmd='',  # serve-only; `cmd` is a required param, so pass it empty
    # `tsx watch` unless --no-reload worker; see WORKER_CMD above. Restarting this
    # resource ALWAYS kills in-flight agent turns — that is what --no-reload buys.
    serve_cmd=WORKER_CMD,
    # worker.ts loads no dotenv — this must be a real env var
    # (server/src/workerProtocol.ts). The bridge finds the worker through
    # run/<instance>/worker.json and does not need this; the pin exists so the
    # readiness probe below has a known port to dial. Unset, the worker binds an
    # ephemeral one and stays perfectly reachable — only the probe would break.
    serve_env={'LINES_WORKER_PORT': str(WORKER_PORT)},
    resource_deps=['install'],
    # WS-only, binds 127.0.0.1 (server/src/worker.ts:321) — TCP is the only
    # honest check.
    readiness_probe=probe(initial_delay_secs=2, period_secs=5,
                          tcp_socket=tcp_socket_action(port=WORKER_PORT, host='127.0.0.1')),
    labels=['services'],
    allow_parallel=True,
)

local_resource(
    'bridge',
    cmd='',
    serve_cmd=BRIDGE_CMD,
    # LINES_BRIDGE_PORT is pinned here for the same reason the worker's is: the
    # readiness probe and the status link below need a fixed target. The packaged
    # app sets neither and binds :0, publishing the result to bridge.json.
    # STORAGE_URL is injected only as a DEFAULT: an explicit value in .env means
    # this bridge syncs to a deployment, and overriding it here would silently
    # point it back at localhost. RELAY_URL is never injected unless --with-relay
    # wires up the loopback one — otherwise .env decides, and the device
    # credential comes from ~/.lines-app/device.json, so no secret reaches a spec.
    serve_env=dict(
        dict(
            {'LINES_BRIDGE_PORT': str(BRIDGE_PORT)},
            **({} if have('STORAGE_URL') else {'STORAGE_URL': 'http://localhost:%d' % STORAGE_PORT})
        ),
        **({'RELAY_URL': 'ws://127.0.0.1:%d' % RELAY_PORT,
            'LINES_DEVICE_ID': 'tilt-dev',
            'LINES_DEVICE_SECRET': 'tilt-dev'} if WITH_RELAY else {})
    ),
    # Deliberately NOT depending on worker/storage: the bridge reconnects to the
    # worker every 1s (workerClient.ts:74-79) and treats storage as best-effort
    # (sync.ts:295-308). A broken worker/storage still leaves a reachable UI.
    resource_deps=['install'],
    # GET / returns 200 {"ok":true,...}. It is the bridge's only HTTP surface now
    # that workspace reads moved onto the WebSocket (see fileRoutes.ts).
    readiness_probe=probe(initial_delay_secs=2, period_secs=15,
                          http_get=http_get_action(port=BRIDGE_PORT, host='localhost', path='/')),
    links=[link('http://localhost:%d/' % BRIDGE_PORT, 'bridge status')],
    labels=['services'],
    allow_parallel=True,
)

# The relay is opt-in (`tilt up -- --with-relay`): the bridge only dials it when
# RELAY_URL is set, so the default local stack is unchanged. Useful for exercising
# the hosted path — a browser reaching the bridge through the tunnel — locally.
if WITH_RELAY:
    local_resource(
        'relay',
        cmd='',
        serve_cmd='npm run dev -w relay',
        # Auth off: the Device table arrives in Phase 3. Dev-only, never deployed.
        serve_env={'RELAY_PORT': str(RELAY_PORT), 'RELAY_AUTH_DISABLED': '1'},
        resource_deps=['install'],
        readiness_probe=probe(initial_delay_secs=2, period_secs=15,
                              http_get=http_get_action(port=RELAY_PORT, host='localhost', path='/')),
        links=[link('http://localhost:%d/' % RELAY_PORT, 'relay status')],
        labels=['services'],
        allow_parallel=True,
    )

if WITH_STORAGE:
    local_resource(
        'storage',
        cmd='',
        serve_cmd='npm run dev -w storage',
        serve_env={'PORT': str(STORAGE_PORT)},
        resource_deps=['preflight', 'install', 'prisma-generate'],
        # /health at storage/src/index.ts:65-67, registered before the Clerk
        # middleware so it is unauthenticated.
        readiness_probe=probe(initial_delay_secs=3, period_secs=5, failure_threshold=3,
                              http_get=http_get_action(port=STORAGE_PORT, host='localhost', path='/health')),
        links=[link('http://localhost:%d/health' % STORAGE_PORT, 'storage health')],
        labels=['services'],
        allow_parallel=True,
    )

local_resource(
    'web',
    cmd='',
    # --strictPort: without it vite drifts to 5174 when a stale `npm run dev`
    # holds 5173, and the probe goes green against the STALE server.
    serve_cmd='npm run dev -w web -- --strictPort',
    resource_deps=['install'],
    readiness_probe=probe(initial_delay_secs=2, period_secs=10,
                          http_get=http_get_action(port=WEB_PORT, host='localhost', path='/')),
    links=[link('http://localhost:%d' % WEB_PORT, 'Lines UI')],
    labels=['services'],
    allow_parallel=True,
)

# ---- freeze / resume buttons ----------------------------------------------
# One button on `worker` and one on `bridge`, so the freeze is reachable without
# leaving the dashboard. `tilt args` REPLACES the whole arg list, so each button
# re-emits every flag currently in effect plus/minus its own resource; clearing
# the last one needs `--clear`, because `tilt args --` with nothing after it opens
# $EDITOR instead of clearing.
#
# Changing args re-evaluates this Tiltfile, which regenerates these buttons for
# the new state — the button on a frozen resource is always the Resume one.

def tilt_args_argv(frozen_names):
    flags = []
    if not WITH_STORAGE:
        flags.append('--no-storage')
    if WITH_RELAY:
        flags.append('--with-relay')
    if WITH_STUDIO:
        flags.append('--with-studio')
    if not WITH_BUTTONS:
        flags.append('--no-ui-buttons')
    for name in frozen_names:
        flags.extend(['--no-reload', name])
    if not flags:
        return ['tilt', 'args', '--clear']
    return ['tilt', 'args', '--'] + flags

if WITH_BUTTONS:
    # load_dynamic, not load: `load` is a top-level-only statement, so it cannot
    # sit behind --no-ui-buttons.
    cmd_button = load_dynamic('ext://uibutton')['cmd_button']
    for name in FREEZABLE:
        if frozen(name):
            cmd_button(
                '%s-resume-reload' % name,
                resource=name,
                argv=tilt_args_argv([n for n in FROZEN if n != name]),
                text='Resume hot reload',
                icon_name='local_fire_department',
            )
        else:
            cmd_button(
                '%s-freeze-reload' % name,
                resource=name,
                argv=tilt_args_argv(FROZEN + [name]),
                text='Freeze reload',
                icon_name='ac_unit',
                # Both directions swap serve_cmd, so the process restarts once the
                # moment you click — which kills any in-flight agent turn on the
                # worker. Confirm rather than one-click it.
                requires_confirmation=True,
            )

    # Pairing is reachable from the bridge too: it is the resource whose relay
    # link the code exists to establish, so that is where you look when a machine
    # will not connect.
    cmd_button(
        'bridge-pair-device',
        resource='bridge',
        argv=['tilt', 'trigger', 'pair-device'],
        text='Pair this machine',
        icon_name='link',
    )

# ---- manual tasks ----------------------------------------------------------
# auto_init=False       -> not run on `tilt up`
# TRIGGER_MODE_MANUAL   -> `deps` only light the pending-changes dot

local_resource('typecheck', cmd='npm run typecheck',
               deps=['server/src', 'web/src', 'storage/src', 'shared'],
               auto_init=False, trigger_mode=TRIGGER_MODE_MANUAL,
               resource_deps=['install'], labels=['checks'], allow_parallel=True)

local_resource('test', cmd='npm run test -w server',
               deps=['server/src'],
               auto_init=False, trigger_mode=TRIGGER_MODE_MANUAL,
               resource_deps=['install'], labels=['checks'], allow_parallel=True)

# Registers this machine with the deployment in STORAGE_URL and prints the code
# to type into the hosted web app. Always present, never automatic: it is a thing
# you do when a code has expired (15 minutes) or a machine has been revoked, not
# a step in bringing the stack up. Idempotent — once claimed it prints
# "already paired" and exits 0. Fails with one clear line if STORAGE_URL is unset.
local_resource('pair-device', cmd='npm run pair -w server',
               auto_init=False, trigger_mode=TRIGGER_MODE_MANUAL,
               resource_deps=['install'], labels=['setup'], allow_parallel=True)

# Builds the installable DMG into desktop/release. Never automatic: it is a
# minutes-long electron-builder run producing a release artifact, and nothing in
# the dev stack consumes it. Here so the packaging step is discoverable at all —
# the desktop app was otherwise invisible to Tilt.
local_resource('desktop-package', cmd='npm run package -w desktop',
               deps=['desktop/src', 'desktop/scripts', 'server/src', 'shared'],
               auto_init=False, trigger_mode=TRIGGER_MODE_MANUAL,
               resource_deps=['install'], labels=['setup'], allow_parallel=True)

if WITH_STORAGE:
    # storage/package.json:12 already wraps this in `dotenv -e ../.env`, which
    # supplies DIRECT_URL to the migrate engine. Never automatic: writes to
    # hosted Supabase.
    local_resource('prisma-migrate', cmd='npm run migrate -w storage',
                   deps=['storage/prisma/migrations'],
                   auto_init=False, trigger_mode=TRIGGER_MODE_MANUAL,
                   resource_deps=['install', 'prisma-generate'],
                   labels=['db'], allow_parallel=True)

    local_resource('prisma-studio', cmd='', serve_cmd='npm run studio -w storage',
                   auto_init=WITH_STUDIO, trigger_mode=TRIGGER_MODE_MANUAL,
                   resource_deps=['install', 'prisma-generate'],
                   readiness_probe=probe(initial_delay_secs=3, period_secs=10,
                                         http_get=http_get_action(port=STUDIO_PORT, host='localhost', path='/')),
                   links=[link('http://localhost:%d' % STUDIO_PORT, 'Prisma Studio')],
                   labels=['db'], allow_parallel=True)

print('lines: web :%d  bridge :%d  worker :%d  storage :%s%s%s' % (
    WEB_PORT, BRIDGE_PORT, WORKER_PORT,
    str(STORAGE_PORT) if WITH_STORAGE else 'disabled',
    '  [relayed: %s]' % os.getenv('RELAY_URL', 'via .env') if RELAYED else '',
    '  [reload frozen: %s]' % ','.join(FROZEN) if FROZEN else ''))
