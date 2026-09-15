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
# The backend supervisor owns source watching and reloads only between turns.
# Vite owns web HMR. Do not add source deps to serving resources.

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
    'relay-auth',
    usage='Run the relay with real Clerk verification instead of the dev escape ' +
          'hatch. Required to exercise session sharing: with auth off every ' +
          'client binds to one user as OWNER, so the guest gate never runs and ' +
          'no grant is ever attached. Needs CLERK_SECRET_KEY and ' +
          'RELAY_SHARED_SECRET in .env.',
)
config.define_bool(
    'no-ui-buttons',
    usage='Skip the freeze/resume reload buttons. They come from ext://uibutton, ' +
          'which is fetched from GitHub the first time it is used — pass this to ' +
          'start fully offline.',
)
config.define_string_list(
    'no-reload',
    usage='Hold automatic backend reload: worker | bridge | all. Either hold pauses ' +
          'the coordinated pair. Freeze/Resume never restarts a process. By default ' +
          'pending edits apply automatically once every session is idle.',
)
cfg = config.parse()
if config.tilt_subcommand == 'down':
    local(['node', 'server/scripts/dev-runtime.mjs', 'shutdown'], quiet=True)
WITH_STORAGE = not cfg.get('no-storage', False)
WITH_STUDIO = cfg.get('with-studio', False)
WITH_RELAY = cfg.get('with-relay', False)
# Only meaningful with --with-relay; harmless otherwise.
RELAY_AUTH = cfg.get('relay-auth', False)
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



if FROZEN:
    warn('Automatic backend reload held. Resume applies pending edits only when all sessions are idle.')

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
# Sharing needs three things agreeing, and each one fails as an unexplained
# "connecting to your machine…" spinner rather than as an error. Say so up front.
if RELAY_AUTH:
    if not have('CLERK_SECRET_KEY'):
        warn('--relay-auth needs CLERK_SECRET_KEY: with it unset the relay exits ' +
             'at startup rather than accepting unverified clients.')
    if not have('RELAY_SHARED_SECRET'):
        warn('--relay-auth needs RELAY_SHARED_SECRET: without it the relay cannot ' +
             'ask storage to authorize a guest, and every guest connection is ' +
             'refused 1008 (fail-closed).')
    if not have('VITE_BRIDGE_WS_URL'):
        warn('VITE_BRIDGE_WS_URL is unset, so the browser resolves the bridge via ' +
             '/__bridge and connects DIRECTLY, bypassing the relay — no relay means ' +
             'no grant, so a guest silently lands in a context of their own. Set ' +
             'VITE_BRIDGE_WS_URL=ws://127.0.0.1:%d/client' % RELAY_PORT)
    # With auth on, the bridge no longer gets a synthetic device id (see the
    # bridge resource): the relay verifies it against storage, so it has to be a
    # real registered device. Unpaired, the bridge is refused 1008 on every dial
    # and the browser spins on "connecting to your machine".
    if not os.path.exists(os.path.join(os.getenv('HOME', ''), '.lines-app', 'device.json')):
        warn('--relay-auth needs a paired machine: ~/.lines-app/device.json is ' +
             'missing, so the bridge has no device id storage will verify. Pair ' +
             'this machine from the web app first.')
elif WITH_RELAY and have('VITE_BRIDGE_WS_URL'):
    warn('The relay is running with auth OFF, so every client binds to one user ' +
         'as the machine owner and session sharing cannot engage. Add --relay-auth ' +
         'to exercise a guest connection.')

RELAYED = have('RELAY_URL')
if RELAYED and not have('STORAGE_URL'):
    warn('RELAY_URL is set but STORAGE_URL is not — the bridge will dial the ' +
         'hosted relay while syncing to localhost. Set STORAGE_URL to the same ' +
         'deployment (https://api.<domain>), or unset RELAY_URL for local-only.')

# One machine, one relay identity. Tilt's bridge and the packaged tray app share
# ~/.lines-app/device.json, so both dialling a *deployed* relay makes each dial
# supersede the other. server/src/index.ts enforces one holder via
# ~/.lines-app/bridge.lock; this only says out loud what that is about to do.
#
# Values, not just key names: the loopback test below needs the host to tell a
# deployment from `--with-relay`'s local relay. Never printed, and RELAY_URL is
# not a credential.
def dotenv_value(path, key):
    if not os.path.exists(path):
        return ''
    for raw in str(read_file(path)).splitlines():
        line = raw.strip()
        if line.startswith('#') or '=' not in line:
            continue
        parts = line.split('=', 1)
        if parts[0].strip() == key:
            return parts[1].strip()
    return ''

RELAY_TARGET = os.getenv('RELAY_URL', '') or dotenv_value(ENV_FILE, 'RELAY_URL')
LOOPBACK_RELAY = ('127.0.0.1' in RELAY_TARGET or 'localhost' in RELAY_TARGET or
                  '[::1]' in RELAY_TARGET)
BRIDGE_LOCK_FILE = os.path.join(os.getenv('HOME', ''), '.lines-app', 'bridge.lock')

# node rather than read_file + decode_json: decode_json fails the whole build on a
# truncated lock, and an unparseable or stale lock must be silent — a leftover file
# must never be what stops `tilt up`. Same call does the liveness test, and exits 0
# with no output for every "nothing to say" case (local() fails the build on
# nonzero). Prints: <pid> <instance> relaying|local-only.
LOCK_PROBE = ' '.join([
    'node -e',
    '\'try{var h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));',
    'try{process.kill(h.pid,0)}catch(e){if(e.code!=="EPERM"){process.exit(0)}}',
    'console.log([h.pid,h.instance||"unknown",h.deviceId?"relaying":"local-only"]',
    '.join(" "))}catch(e){}\'',
    shq(BRIDGE_LOCK_FILE),
])

if RELAYED and not LOOPBACK_RELAY and not WITH_RELAY and os.path.exists(BRIDGE_LOCK_FILE):
    HOLDER = str(local(LOCK_PROBE, quiet=True, echo_off=True)).strip().split(' ')
    if len(HOLDER) == 3:
        if HOLDER[1] == 'desktop':
            warn('the Lines tray app holds ~/.lines-app/bridge.lock (bridge pid %s, %s) — ' % (HOLDER[0], HOLDER[2]) +
                 "Tilt's bridge will take this machine over (SIGTERM) and the tray will show " +
                 '"Paused" until `tilt down`. Nothing to do; quit the tray app to avoid it.')
        else:
            warn('another bridge holds ~/.lines-app/bridge.lock (pid %s, instance "%s", %s) — ' % (HOLDER[0], HOLDER[1], HOLDER[2]) +
                 "Tilt's bridge will refuse to start (exit 78). Stop that process, or set " +
                 'LINES_ALLOW_MULTIPLE_BRIDGES=1 to share one ~/.lines-app anyway.')
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
# NO source deps: the worker runner coordinates safe reloads; Vite owns HMR.

local_resource(
    'worker', cmd='',
    serve_cmd=['node', 'server/scripts/dev-runtime.mjs', 'worker'],
    serve_env={'LINES_WORKER_PORT': str(WORKER_PORT)},
    resource_deps=['install'],
    readiness_probe=probe(initial_delay_secs=2, period_secs=5,
                          tcp_socket=tcp_socket_action(port=WORKER_PORT, host='127.0.0.1')),
    labels=['services'], allow_parallel=True,
)

# Built up before the resource: Starlark allows only one ** per call, and this
# needs three conditional groups.
BRIDGE_ENV = {'LINES_BRIDGE_PORT': str(BRIDGE_PORT)}
if not have('STORAGE_URL'):
    BRIDGE_ENV['STORAGE_URL'] = 'http://localhost:%d' % STORAGE_PORT
if WITH_RELAY:
    BRIDGE_ENV['RELAY_URL'] = 'ws://127.0.0.1:%d' % RELAY_PORT
    # The synthetic device credential is only valid against a relay with auth OFF,
    # where verifyDevice() short-circuits and accepts any secret. With --relay-auth
    # the relay asks storage to verify it, storage answers 403 for an unregistered
    # id, and the bridge is refused 1008 on every dial while every other resource
    # looks healthy. So under --relay-auth the bridge keeps its real, paired
    # identity from ~/.lines-app/device.json — which is also the device the browser
    # targets, and the only id whose hub.ownerId can match the signed-in user.
    if not RELAY_AUTH:
        BRIDGE_ENV['LINES_DEVICE_ID'] = 'tilt-dev'
        BRIDGE_ENV['LINES_DEVICE_SECRET'] = 'tilt-dev'

local_resource(
    'bridge', cmd='',
    serve_cmd=['node', 'server/scripts/dev-runtime.mjs', 'bridge'],
    serve_env=BRIDGE_ENV, resource_deps=['install'],
    readiness_probe=probe(initial_delay_secs=2, period_secs=5,
                          http_get=http_get_action(port=BRIDGE_PORT, host='localhost', path='/')),
    links=[link('http://localhost:%d/' % BRIDGE_PORT, 'bridge status')],
    labels=['services'], allow_parallel=True,
)

# Policy changes run a control command, never change the backend's serve spec.
local_resource(
    'reload-policy',
    cmd='node server/scripts/dev-runtime.mjs set ' + ' '.join(FROZEN),
    labels=['setup'], allow_parallel=True,
)

# The relay is opt-in (`tilt up -- --with-relay`): the bridge only dials it when
# RELAY_URL is set, so the default local stack is unchanged. Useful for exercising
# the hosted path — a browser reaching the bridge through the tunnel — locally.
if WITH_RELAY:
    local_resource(
        'relay',
        cmd='',
        serve_cmd='npm run dev -w relay',
        # Auth off by default (dev-only, never deployed): any device secret is
        # accepted and every client binds to one user.
        #
        # That also disables the *sharing* gate — with AUTH_DISABLED the /client
        # handler never consults a grant and treats everyone as the machine's
        # owner. So exercising a guest connection needs `--relay-auth`, which
        # leaves Clerk verification on.
        serve_env=(
            {'RELAY_PORT': str(RELAY_PORT)}
            if RELAY_AUTH
            else {'RELAY_PORT': str(RELAY_PORT), 'RELAY_AUTH_DISABLED': '1'}
        ),
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

# ---- reload controls -------------------------------------------------------
# Buttons change the supervisor's policy directly. They never invoke tilt args
# or replace a serving command. A resume still waits for an idle boundary.
if WITH_BUTTONS:
    cmd_button = load_dynamic('ext://uibutton')['cmd_button']
    for resource in FREEZABLE:
        for action in ['freeze', 'resume']:
            cmd_button(
                '%s-%s-reload' % (resource, action), resource=resource,
                argv=['node', 'server/scripts/dev-runtime.mjs', action, 'all'],
                text='Freeze reload' if action == 'freeze' else 'Resume reload',
                icon_name='ac_unit' if action == 'freeze' else 'play_arrow',
            )
    cmd_button(
        'bridge-pair-device', resource='bridge',
        argv=['tilt', 'trigger', 'pair-device'], text='Pair this machine', icon_name='link',
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
