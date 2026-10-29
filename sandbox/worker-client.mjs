// The only local execution transport for model-authored file operations and commands.
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { innerArgs, BWRAP_PATH, EGRESS_BRIDGE, BRIDGE_NODE_FLAGS, sandboxSettingsFromEnv } from './sandbox.mjs';

export function runWorker(argv, { cwd = process.cwd(), env = process.env, signal, input, timeout = 120,
  onData, egressSocket, network = 'offline' } = {}) {
  const s = { ...sandboxSettingsFromEnv(env, { cwd }), env, network, egressSocket };
  const args = [...innerArgs(s), '--', ...(network === 'offline' ? argv : ['/run/mina-node', ...BRIDGE_NODE_FLAGS, EGRESS_BRIDGE, '--', ...argv])];
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(BWRAP_PATH, args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = [], err = [], size = 0, timedOut = false;
    const kill = () => child.kill('SIGKILL'); // bwrap's PID namespace kills detached descendants too.
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
  const child = spawnSync(BWRAP_PATH, [...innerArgs(config), '--', '/run/mina-node', '/run/mina-file-worker.mjs'], {
    env: { PATH: '/usr/bin:/bin' }, input: JSON.stringify({ action, args }), encoding: 'utf8', timeout: 15_000, maxBuffer: 92 * 1024 ** 2,
  });
  if (child.error) throw child.error;
  let out;
  try { out = JSON.parse(child.stdout); } catch { throw new Error(`File worker refused: ${child.stderr?.slice(0, 2000) || child.status}`); }
  if (!out.ok) throw Object.assign(new Error(out.error.message), { code: out.error.code });
  return action === 'read' ? Buffer.from(out.result.data, 'base64') : out.result;
}

export async function runFileOperation(action, args, options = {}) {
  const out = await runWorker(['/run/mina-node', '/run/mina-file-worker.mjs'], {
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
