/** Own one service process group, including when its runner is killed abruptly. */
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  env: process.env,
});
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  // This guard leads a private group; the service and its ordinary descendants
  // inherit it. Keep the guard alive until the final sweep, even if service exits.
  if (process.platform === 'win32') child.kill('SIGTERM');
  else process.kill(-process.pid, 'SIGTERM');
  setTimeout(() => {
    if (process.platform === 'win32') {
      const reap = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      reap.once('exit', () => process.exit(code));
    } else process.kill(-process.pid, 'SIGKILL');
  }, 2000);
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
process.on('disconnect', () => stop());
child.on('exit', (code) => stop(code ?? 1));
child.on('error', () => stop(1));
process.on('message', (message) => {
  if (child.connected && !stopping) child.send(message, () => {});
});
child.on('message', (message) => {
  if (process.connected && !stopping) process.send(message, () => {});
});
