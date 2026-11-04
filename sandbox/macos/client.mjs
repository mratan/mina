// The client side of a sandboxed call on macOS: Pi (or a child of Pi) spawns `mina-instance relay`, a real child process
// with stdio pipes, as it spawns bwrap on Linux. The relay sends the request to the instance's supervisor
// (sandbox/macos/supervisor.mjs), relays stdin, stdout and stderr, and exits with the exit status of the call. Killing
// the relay stops the call and every process that it started.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPER } from './launchd.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function relaySpawn(request, env = process.env) {
  // Callers may pass a narrower environment than their own; the supervisor of this process is still the one to use.
  // Without a supervisor the relay itself fails (exit 125, with the reason), as a missing bwrap fails on Linux at spawn.
  const socket = env.MINA_SUPERVISOR_SOCKET || process.env.MINA_SUPERVISOR_SOCKET || '/nonexistent/mina-supervisor';
  return { command: env.MINA_HELPER || process.env.MINA_HELPER || HELPER, args: ['relay', socket], env: { MINA_CALL: JSON.stringify(request) } };
}

/**
 * A supervisor for a process outside a Mina instance: `--nosandbox` (on Linux the literature servers and the PDF
 * converter still run in bwrap then), and the tests. It serves sandboxed calls only (its "Pi" waits for this process),
 * allows writes below `allowedWrites`, and stops with this process. It sets MINA_SUPERVISOR_SOCKET for this process.
 * Inside a sandboxed instance (MINA_SANDBOX=1) it refuses: a missing supervisor there must fail closed.
 */
let started = null;
export function ensureSupervisor({ allowedWrites = [], developerDir = '/Library/Developer/CommandLineTools', env = process.env } = {}) {
  if (env.MINA_SUPERVISOR_SOCKET && existsSync(env.MINA_SUPERVISOR_SOCKET)) return Promise.resolve(env.MINA_SUPERVISOR_SOCKET);
  if (env.MINA_SANDBOX === '1') return Promise.reject(new Error('mina sandbox: the sandbox supervisor of this instance is not available'));
  started ??= (async () => {
    const root = realpathSync(mkdtempSync(join(homedir(), '.mina-supervisor-')));
    const runDir = join(root, 'r');
    mkdirSync(runDir, { mode: 0o700 });
    for (const d of ['home', 'outputs']) mkdirSync(join(root, d));
    const socket = join(runDir, 's'), spec = join(root, 'spec.json');
    writeFileSync(spec, JSON.stringify({ instanceId: `private-${process.pid}`, runDir, socket, coalitionsFile: join(root, 'coalitions'),
      allowedWrites: allowedWrites.filter(existsSync).map((p) => realpathSync(p)), developerDir, workerHome: join(root, 'home'), workerOutputs: join(root, 'outputs'),
      pi: { argv: ['/bin/sh', '-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`], env: { PATH: '/usr/bin:/bin' }, cwd: root } }), { mode: 0o600 });
    const sup = spawn(process.execPath, [join(REPO, 'sandbox/macos/supervisor.mjs'), spec], { stdio: ['ignore', 'ignore', 'inherit'], detached: true });
    sup.unref();
    for (let i = 0; i < 400 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 25));
    if (!existsSync(socket)) throw new Error('mina sandbox: the sandbox supervisor did not start');
    process.env.MINA_SUPERVISOR_SOCKET = socket;
    process.env.MINA_HELPER ??= HELPER;
    process.on('exit', () => { try { process.kill(sup.pid, 'SIGTERM'); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); });
    return { socket, home: join(root, 'home') };
  })();
  return started.then((s) => s.socket ?? s);
}
export const privateSupervisorHome = async () => (await started)?.home ?? null;
