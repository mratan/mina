// The only local execution transport for model-authored file operations and commands.
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { innerArgs, BWRAP_PATH, EGRESS_BRIDGE, BRIDGE_NODE_FLAGS, sandboxSettingsFromEnv, MACOS, WORKER_NODE, WORKER_FILE, macWorkerRequest } from './sandbox.mjs';
import { relaySpawn } from './macos/client.mjs';

// The process that runs one worker: bwrap on Linux; on macOS the relay to the instance's supervisor, which runs the
// call in a launchd job of its own (sandbox/macos). Both are a child process with stdio pipes, and killing it stops the
// worker and every process the worker started.
function workerCommand(argv, s) {
  if (MACOS) {
    const { command, args, env } = relaySpawn(macWorkerRequest(argv, s), s.env);
    return { command, args, env };
  }
  const args = [...innerArgs(s), '--', ...(s.network === 'offline' ? argv : [WORKER_NODE, ...BRIDGE_NODE_FLAGS, EGRESS_BRIDGE, '--', ...argv])];
  return { command: BWRAP_PATH, args, env: { PATH: '/usr/bin:/bin' } };
}

export function runWorker(argv, { cwd = process.cwd(), env = process.env, signal, input, timeout = 120,
  onData, egressSocket, network = 'offline' } = {}) {
  const s = { ...sandboxSettingsFromEnv(env, { cwd }), env, network, egressSocket };
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const w = workerCommand(argv, s);
    const child = spawn(w.command, w.args, { env: w.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = [], err = [], size = 0, timedOut = false;
    const kill = () => child.kill('SIGKILL'); // Linux: bwrap's PID namespace; macOS: the call's coalition. Descendants stop too.
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout * 1000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted) kill();
    child.on('error', (error) => { cleanup(); reject(error); });
    const capture = (chunks, data) => {
      onData?.(data);
      if (!onData) {
        size += data.length;
        if (size > 92 * 1024 ** 2) { kill(); return; }
        chunks.push(data);
      }
    };
    child.stdout.on('data', (data) => capture(out, data));
    child.stderr.on('data', (data) => capture(err, data));
    child.stdin.on('error', () => {}); // EPIPE is reported through the worker's exit/result.
    child.stdin.end(input);
    child.on('close', (code, sig) => {
      cleanup();
      if (signal?.aborted) return reject(signal.reason ?? new Error('Worker aborted.'));
      if (timedOut) return reject(new Error(`Worker deadline exceeded (${timeout}s); its local descendants stopped.`));
      if (size > 92 * 1024 ** 2) return reject(new Error('Worker output exceeded its byte limit.'));
      resolve({ exitCode: code ?? 128 + (constants.signals[sig] ?? 0), stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

export function runFileOperationSync(action, args, { cwd = process.cwd(), env = process.env } = {}) {
  const config = { ...sandboxSettingsFromEnv(env, { cwd }), env, network: 'offline' };
  const w = workerCommand([WORKER_NODE, WORKER_FILE], config);
  const child = spawnSync(w.command, w.args, {
    env: w.env, input: JSON.stringify({ action, args }), encoding: 'utf8', timeout: 15_000, maxBuffer: 92 * 1024 ** 2,
  });
  if (child.error) throw child.error;
  let out;
  try { out = JSON.parse(child.stdout); } catch { throw new Error(`File worker refused: ${child.stderr?.slice(0, 2000) || child.status}`); }
  if (!out.ok) throw Object.assign(new Error(out.error.message), { code: out.error.code });
  return action === 'read' ? Buffer.from(out.result.data, 'base64') : out.result;
}

export async function runFileOperation(action, args, options = {}) {
  const out = await runWorker([WORKER_NODE, WORKER_FILE], {
    ...options, network: 'offline', input: JSON.stringify({ action, args }),
  });
  let reply;
  try { reply = JSON.parse(out.stdout.toString()); }
  catch { throw new Error(`File worker refused: ${out.stderr.toString().slice(0, 2000) || `exit ${out.exitCode}`}`); }
  if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  if (action === 'read') return Buffer.from(reply.result.data, 'base64');
  return reply.result;
}

export function workerBashOperations({ env = process.env, getEgressSocket = () => null } = {}) {
  return { exec: (command, cwd, options) => runWorker(['/bin/bash', '--noprofile', '--norc', '-c', command], {
    ...options, cwd, env, network: env.MINA_SANDBOX_NET ?? 'open', egressSocket: getEgressSocket(),
  }) };
}
