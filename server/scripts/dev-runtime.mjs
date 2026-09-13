#!/usr/bin/env node
/** Development-only supervisor. Its own code is never hot-reloaded. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const checkout = path.resolve(import.meta.dirname, '../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const names = ['worker', 'bridge'];
const log = (message) => console.log(`[dev-runtime] ${message}`);
export const pathsFor = (root) => ({
  cache: path.join(root, '.cache/dev-runtime'),
  policy: path.join(root, '.cache/dev-runtime/policy.json'),
  control: path.join(root, '.cache/dev-runtime/control.json'),
  healthy: path.join(root, '.cache/dev-runtime/healthy.json'),
});
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** Copy local runtime inputs; external installed packages remain shared, never local workspace code. */
export async function buildGeneration(root) {
  const inputs = new Map();
  function walk(relative) {
    const target = path.join(root, relative);
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git', 'dist'].includes(entry.name)) walk(child);
      else if (entry.isFile() && !entry.name.endsWith('.test.ts')) inputs.set(child, fs.readFileSync(path.join(root, child)));
    }
  }
  walk('server/src');
  walk('shared');
  for (const file of ['package.json', 'server/package.json']) inputs.set(file, fs.readFileSync(path.join(root, file)));
  const hash = createHash('sha256').update('source-generation-v1');
  for (const [file, content] of inputs) hash.update(file).update('\0').update(content).update('\0');
  const id = hash.digest('hex').slice(0, 20);
  const directory = path.join(pathsFor(root).cache, 'generations', id);
  if (fs.existsSync(path.join(directory, 'complete.json'))) return { id, directory };
  fs.mkdirSync(directory, { recursive: true });
  for (const [file, content] of inputs) {
    const destination = path.join(directory, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  const modules = path.join(directory, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  const link = (source, destination) => {
    if (!fs.existsSync(destination)) fs.symlinkSync(source, destination, 'dir');
  };
  for (const entry of fs.readdirSync(path.join(root, 'node_modules'), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const source = path.join(root, 'node_modules', entry.name);
    const destination = path.join(modules, entry.name);
    if (entry.name.startsWith('@')) {
      fs.mkdirSync(destination, { recursive: true });
      for (const item of fs.readdirSync(source)) {
        if (entry.name === '@lines') continue;
        link(path.join(source, item), path.join(destination, item));
      }
    } else link(source, destination);
  }
  fs.mkdirSync(path.join(modules, '@lines'), { recursive: true });
  link(path.join(directory, 'shared'), path.join(modules, '@lines/shared'));
  // Validate the entire reachable local graph without changing the running tree.
  // The actual runtime uses tsx so import.meta.url still identifies each helper correctly.
  await build({
    absWorkingDir: directory,
    entryPoints: ['server/src/index.ts', 'server/src/worker.ts', 'server/src/linesMcpStdio.ts'],
    outdir: 'validation', bundle: true, packages: 'external', platform: 'node', format: 'esm',
    write: false, logLevel: 'silent',
    plugins: [{ name: 'snapshot-shared', setup(plugin) {
      plugin.onResolve({ filter: /^@lines\/shared$/ }, () => ({ path: path.join(directory, 'shared/types.ts') }));
    } }],
  });
  writeJson(path.join(directory, 'complete.json'), { id });
  return { id, directory };
}

export class Supervisor {
  constructor(root, options = {}) {
    this.root = root;
    this.paths = pathsFor(root);
    this.options = { quietMs: 2000, startupMs: 15000, freshMs: 1500, ...options };
    this.children = new Map();
    this.waiters = new Map();
    this.watchers = [];
    this.frozen = readJson(this.paths.policy, { frozen: [] }).frozen;
    this.current = null;
    this.candidate = null;
    this.error = null;
    this.phase = 'starting';
    this.stopping = false;
    this.revision = 0;
    this.idleSince = null;
    this.retryAt = 0;
    this.failureCount = 0;
    this.rejected = new Set();
  }
  state() {
    return {
      phase: this.phase, generation: this.current?.id, pending: this.candidate?.id,
      frozen: this.frozen, error: this.error,
      processes: Object.fromEntries([...this.children].map(([name, child]) => [name, {
        pid: child.process.pid, ready: this.fresh(child) && child.activity.ready,
        blockers: this.fresh(child) ? child.activity.blockers : ['activity unavailable'],
      }])),
    };
  }
  fresh(child) { return !!child?.activity && child.process.exitCode === null && !child.process.signalCode && Date.now() - child.at < this.options.freshMs; }
  idle() { return names.every((name) => { const child = this.children.get(name); return this.fresh(child) && child.activity.ready && child.activity.blockers.length === 0; }); }
  publish() {
    const state = this.state();
    for (const child of this.children.values()) if (child.process.connected) child.process.send({ type: 'devControl', action: 'status', status: state }, () => {});
    const summary = JSON.stringify([state.phase, state.generation, state.pending, state.frozen, state.error,
      Object.values(state.processes).flatMap((p) => p.blockers)]);
    if (summary !== this.lastSummary) { this.lastSummary = summary; log(JSON.stringify(state)); }
  }
  async startChild(name, generation) {
    if (this.stopping) throw new Error('Supervisor is stopping');
    const entry = name === 'worker' ? 'worker.ts' : 'index.ts';
    const command = this.options.command?.(name, generation) ?? [
      '--import', path.join(this.root, 'node_modules/tsx/dist/loader.mjs'),
      path.join(generation.directory, 'server/src', entry),
    ];
    const child = { process: spawn(process.execPath, command, {
      cwd: path.join(this.root, 'server'), detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, LINES_DEV_SUPERVISED: '1', LINES_DEV_CHECKOUT: this.root,
        LINES_DEV_GENERATION: generation.id, ...this.options.env },
    }), activity: null, at: 0 };
    this.children.set(name, child);
    for (const stream of [child.process.stdout, child.process.stderr]) {
      stream.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
    }
    child.process.on('error', (error) => { this.error = `${name}: ${error.message}`; });
    child.process.on('message', (message) => {
      if (message?.type === 'devActivity' || message?.type === 'devAck') {
        if (typeof message.ready !== 'boolean' || !Array.isArray(message.blockers)) return;
        child.activity = message;
        child.at = Date.now();
        if (message.type === 'devAck') this.waiters.get(message.id)?.(message);
      }
    });
    return child;
  }
  async control(name, action) {
    const child = this.children.get(name);
    if (!child?.process.connected) throw new Error(`${name} control unavailable`);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`${name} ${action} timed out`)); }, 1500);
      this.waiters.set(id, (message) => { clearTimeout(timer); this.waiters.delete(id); resolve(message); });
      child.process.send({ type: 'devControl', action, id }, (error) => {
        if (error) { clearTimeout(timer); this.waiters.delete(id); reject(error); }
      });
    });
  }
  async ready(name, requireRelay = false) {
    const deadline = Date.now() + this.options.startupMs;
    while (!this.stopping && Date.now() < deadline) {
      const child = this.children.get(name);
      if (!child || child.process.exitCode !== null || child.process.signalCode) throw new Error(`${name} exited during startup`);
      if (this.fresh(child) && child.activity.ready && (!requireRelay || child.activity.relayConnected)) return;
      await sleep(50);
    }
    throw new Error(`${name} readiness timed out`);
  }
  async startPair(generation, requireRelay = false) {
    await this.startChild('worker', generation);
    await this.ready('worker');
    await this.startChild('bridge', generation);
    await this.ready('bridge', requireRelay);
    // Keep admission closed through validation; never replay a prompt on a failed candidate.
    await sleep(300);
    await this.ready('worker');
    await this.ready('bridge', requireRelay);
    await this.control('worker', 'activate');
    await this.control('bridge', 'activate');
  }
  async stopChild(name) {
    const child = this.children.get(name);
    if (!child) return;
    this.children.delete(name);
    const signal = (value) => {
      if (!child.process.pid) return;
      try {
        if (process.platform === 'win32') child.process.kill(value);
        else process.kill(-child.process.pid, value);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    signal('SIGTERM');
    const deadline = Date.now() + 2000;
    while (child.process.exitCode === null && !child.process.signalCode && Date.now() < deadline) await sleep(25);
    signal('SIGKILL'); // Reap remaining children in our private process group too.
  }
  async stopPair() { await this.stopChild('bridge'); await this.stopChild('worker'); }
  async reload() {
    const next = this.candidate;
    if (!next) return;
    // Bridge closes admission first. Worker then checks commands already in transit.
    try {
      if (!(await this.control('bridge', 'prepare')).ok || !(await this.control('worker', 'prepare')).ok || !this.idle() || this.frozen.length || this.candidate !== next) {
        await this.control('worker', 'activate'); await this.control('bridge', 'activate');
        this.idleSince = null; return;
      }
    } catch (error) {
      await this.control('worker', 'activate').catch(() => {});
      await this.control('bridge', 'activate').catch(() => {});
      this.error = error.message; this.idleSince = null; return;
    }
    const previous = this.current;
    const requireRelay = !!this.children.get('bridge')?.activity?.relayConnected;
    this.candidate = null;
    this.phase = 'reloading'; this.publish();
    await this.stopPair();
    try {
      await this.startPair(next, requireRelay);
      this.current = next;
      writeJson(this.paths.healthy, next);
      this.error = null;
    } catch (error) {
      this.rejected.add(next.id);
      this.error = `Rejected ${next.id}: ${error.message}; restoring ${previous.id}`;
      this.phase = 'restoring'; this.publish();
      await this.stopPair();
      // A relay outage must not prevent local recovery of the known working build.
      await this.startPair(previous);
    }
    this.phase = 'running'; this.idleSince = null;
  }
  async rebuild() {
    const revision = this.revision;
    try {
      const generation = await buildGeneration(this.root);
      if (revision !== this.revision) return;
      if (this.rejected.has(generation.id)) return;
      this.candidate = generation.id === this.current?.id ? null : generation;
      this.error = null;
    } catch (error) {
      if (revision !== this.revision) return;
      this.candidate = null;
      this.error = `Build failed; current runtime retained: ${error.message}`;
    }
    this.publish();
  }
  changed() {
    this.revision++;
    this.candidate = null;
    this.idleSince = null;
    clearTimeout(this.buildTimer);
    this.buildTimer = setTimeout(() => { this.building = (this.building ?? Promise.resolve()).then(() => this.rebuild()); }, 500);
  }
  async tick() {
    if (this.ticking || this.stopping || !this.current) return;
    this.ticking = true;
    try {
      for (const name of names) {
        const child = this.children.get(name);
        if (!child || child.process.exitCode !== null || child.process.signalCode) {
          if (Date.now() < this.retryAt) return;
          this.phase = `recovering ${name}`;
          await this.stopChild(name);
          await this.startChild(name, this.current);
          await this.ready(name);
          await this.control(name, 'activate');
          this.failureCount = 0;
          this.phase = 'running';
        }
      }
      if (this.candidate && !this.frozen.length && this.idle()) {
        this.idleSince ??= Date.now();
        if (Date.now() - this.idleSince >= this.options.quietMs) await this.reload();
      } else this.idleSince = null;
    } catch (error) {
      this.error = error.message;
      this.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(++this.failureCount, 5));
      this.phase = 'recovery pending';
    } finally { this.ticking = false; this.publish(); }
  }
  async startControl() {
    const prior = readJson(this.paths.control);
    if (prior?.pid && alive(prior.pid)) throw new Error('Another dev supervisor is running for this checkout.');
    this.token = randomBytes(32).toString('hex');
    this.http = http.createServer((req, res) => {
      const provided = Buffer.from(String(req.headers.authorization ?? ''));
      const expected = Buffer.from(`Bearer ${this.token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(403); res.end(); return; }
      if (req.method === 'POST' && req.url === '/policy') {
        this.frozen = readJson(this.paths.policy, { frozen: [] }).frozen;
        this.idleSince = null;
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(this.state()));
      this.publish();
    });
    await new Promise((resolve, reject) => { this.http.once('error', reject); this.http.listen(0, '127.0.0.1', resolve); });
    writeJson(this.paths.control, { pid: process.pid, port: this.http.address().port, token: this.token });
  }
  async start() {
    await this.startControl();
    const previous = readJson(this.paths.healthy);
    try { this.current = await buildGeneration(this.root); }
    catch (error) {
      if (!previous || !fs.existsSync(path.join(previous.directory, 'complete.json'))) throw error;
      this.current = previous; this.error = `Build failed; using ${previous.id}: ${error.message}`;
    }
    try { await this.startPair(this.current); }
    catch (error) {
      if (!previous || previous.id === this.current.id) throw error;
      this.rejected.add(this.current.id);
      await this.stopPair(); this.current = previous;
      this.error = `Startup failed; restored ${previous.id}: ${error.message}`;
      await this.startPair(previous);
    }
    writeJson(this.paths.healthy, this.current);
    this.phase = 'running';
    for (const relative of ['server/src', 'shared']) {
      this.watchers.push(fs.watch(path.join(this.root, relative), { recursive: true }, (_, file) => {
        if (!String(file).endsWith('.test.ts')) this.changed();
      }));
    }
    this.changed(); // Catch edits made while the initial generation was starting.
    this.timer = setInterval(() => { void this.tick(); }, 250);
    this.publish();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer); clearTimeout(this.buildTimer);
    for (const watcher of this.watchers) watcher.close();
    await this.stopPair();
    this.http?.close();
    if (readJson(this.paths.control)?.pid === process.pid) fs.rmSync(this.paths.control, { force: true });
  }
}

export async function policyCommand(root, action, targets = []) {
  const paths = pathsFor(root);
  const current = readJson(paths.policy, { frozen: [] });
  if (action !== 'status') {
    const expanded = targets.includes('all') ? names : targets;
    if (expanded.some((name) => !names.includes(name))) throw new Error('Expected worker, bridge, or all.');
    const frozen = action === 'set' ? expanded : action === 'freeze' ? [...new Set([...current.frozen, ...expanded])] : current.frozen.filter((name) => !expanded.includes(name));
    writeJson(paths.policy, { frozen });
  }
  const control = readJson(paths.control);
  if (!control || !alive(control.pid)) return { ...readJson(paths.policy), phase: 'stopped' };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: control.port, path: action === 'status' ? '/' : '/policy',
      method: action === 'status' ? 'GET' : 'POST', headers: { authorization: `Bearer ${control.token}` }, timeout: 2000 }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => {
        try { if (res.statusCode !== 200) throw new Error(`Control HTTP ${res.statusCode}`); resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Control timed out'))); req.end();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] ?? 'start';
  if (action === 'start') {
    const supervisor = new Supervisor(checkout);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void supervisor.stop().then(() => process.exit(0)); });
    supervisor.start().catch(async (error) => { console.error(`[dev-runtime] ${error.message}`); await supervisor.stop(); process.exitCode = 1; });
  } else if (action === 'legacy-running') {
    // Keep an already running tsx-owned Tilt stack intact during migration.
    // This process inspection happens only when Tilt evaluates its file.
    const commands = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' });
    const executable = path.join(checkout, 'node_modules/.bin/tsx');
    console.log(commands.split('\n').some((line) => line.includes(executable) && /(?:watch )?src\/worker\.ts(?:$|\s)/.test(line)) ? 'yes' : 'no');
  } else if (['freeze', 'resume', 'set', 'status'].includes(action)) {
    policyCommand(checkout, action, process.argv.slice(3)).then((state) => log(JSON.stringify(state))).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } else { console.error('Usage: dev-runtime.mjs [start|status|freeze|resume|set] [worker|bridge|all]'); process.exitCode = 1; }
}
