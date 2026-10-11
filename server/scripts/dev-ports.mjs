#!/usr/bin/env node
// Picks a loopback port for each dev service and prints them as JSON for Tilt.
//
// Keeps the previous choice while it is free or while this checkout's dev
// supervisor is running (its own ports are busy by definition). Otherwise prefers
// the conventional port and falls back to any free one. Saved in the dev data
// root so the desktop dev window and the Vite dev server can read the same answer.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../..', import.meta.url));
const appRoot = process.env.LINES_APP_ROOT || path.join(os.homedir(), '.lines-app-dev');
const file = path.join(appRoot, 'dev-ports.json');
const control = path.join(checkout, '.cache/dev-runtime/control.json');
const DEFAULTS = { bridge: 8787, worker: 8788, storage: 8790, relay: 8791, web: 5173 };

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function supervisorRunning() {
  const pid = readJson(control)?.pid;
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function listenable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

function anyFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const saved = readJson(file) ?? {};
const running = supervisorRunning();
const chosen = {};
const used = new Set();

for (const [name, fallback] of Object.entries(DEFAULTS)) {
  const prior = saved[name];
  let port = null;
  if (Number.isInteger(prior) && !used.has(prior) && (running || (await listenable(prior)))) port = prior;
  else if (!used.has(fallback) && (await listenable(fallback))) port = fallback;
  while (port === null || used.has(port)) port = await anyFreePort();
  chosen[name] = port;
  used.add(port);
}

fs.mkdirSync(appRoot, { recursive: true });
fs.writeFileSync(file, JSON.stringify(chosen, null, 2));
process.stdout.write(JSON.stringify(chosen));
