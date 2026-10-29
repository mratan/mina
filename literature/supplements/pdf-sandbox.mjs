// Kernel-namespace confinement for the supplement PDF extractor. PyMuPDF is native code parsing untrusted bytes, so a
// malicious PDF must be assumed to get code execution in the parser process. rlimits bound resources; they are not
// confinement. The parser therefore runs under bubblewrap with:
// - positive read-only mounts only: /usr (+ the distro's /bin, /lib... aliases), /etc/ld.so.cache, and the resolved
//   Python runtime roots (the venv and, when it lives outside /usr, the base interpreter's prefix). No host home, no
//   project, no controller state, no /etc tree, no /run, no /sys, no sockets;
// - an empty, size-capped, private writable /tmp (and RLIMIT_FSIZE=0 from the prelude), private /dev and /proc;
// - new user (nested user namespaces disabled), pid, ipc, uts, cgroup and network namespaces: only an unconnected
//   loopback, so neither host loopback services nor abstract Unix sockets are reachable; all capabilities dropped,
//   no-new-privs, a new session (no TIOCSTI), --die-with-parent, a cleared environment; only stdin/stdout/stderr pipes.
// The PDF goes in on stdin; nothing is written to disk. There is no unsandboxed fallback: a missing/untrusted bwrap or
// an unsafe runtime is a typed pdf_extractor_unavailable outcome (reason isolation_unavailable / unsafe_runtime /
// runtime_unavailable). The interpreter path is owner configuration (never a model argument), and it is still validated
// so that a runtime root can never import /, /home, the owner's home, the repository or private state wholesale.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHidden, hostPaths } from '../../sandbox/sandbox.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BWRAP = ['/usr/bin/bwrap', '/bin/bwrap'].find((p) => existsSync(p)) ?? '/usr/bin/bwrap';
export const PDF_TMP_BYTES = 16 * 1024 * 1024;

export class PdfIsolationError extends Error {
  constructor(reason, message) { super(message); this.name = 'PdfIsolationError'; this.reason = reason; }
}

const contains = (root, p) => root === p || p.startsWith(root === '/' ? '/' : `${root}/`);
const canon = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
// A runtime root may not be, or contain, any of these.
const BROAD = ['/', '/home', '/root', '/tmp', '/var', '/var/tmp', '/run', '/etc', '/proc', '/sys', '/dev', '/mnt', '/media', '/srv', '/boot', '/opt'];

/** Why this bubblewrap cannot be trusted (null = it can): absolute, under /usr, root-owned, not group/other-writable. */
export function bwrapProblem(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return 'bubblewrap path must be absolute';
  let real;
  try { real = realpathSync(path); } catch { return `bubblewrap is not installed at ${path}`; }
  if (!contains('/usr', real)) return `bubblewrap must be a trusted /usr binary, not ${real}`;
  const st = statSync(real);
  if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) || !(st.mode & 0o111)) return `bubblewrap at ${real} is not a root-owned, non-writable executable`;
  return null;
}

/**
 * Resolve the owner-configured interpreter into { exec, mounts }: the path to execute inside the sandbox and the
 * read-only runtime roots it needs besides /usr. Throws PdfIsolationError (unsafe_runtime / runtime_unavailable).
 */
export function resolvePdfRuntime(python, { home = homedir(), env = process.env, cwd = process.cwd() } = {}) {
  if (typeof python !== 'string' || !python || python.includes('\0') || !isAbsolute(python)) {
    throw new PdfIsolationError('unsafe_runtime', 'the PDF Python runtime must be an absolute path (owner configuration)');
  }
  let bin, real;
  try { bin = realpathSync(dirname(python)); real = realpathSync(python); }
  catch { throw new PdfIsolationError('runtime_unavailable', `no PDF Python runtime at ${python}`); }
  const st = statSync(real);
  if (!st.isFile() || !(st.mode & 0o111)) throw new PdfIsolationError('runtime_unavailable', `${python} is not an executable file`);
  const roots = [];
  const venv = dirname(bin);
  const cfg = join(venv, 'pyvenv.cfg');
  if (existsSync(cfg)) {
    roots.push(venv);
    const baseBin = /^\s*home\s*=\s*(.+?)\s*$/m.exec(readFileSync(cfg, 'utf8'))?.[1];
    if (!baseBin || !isAbsolute(baseBin)) throw new PdfIsolationError('unsafe_runtime', `${cfg} names no absolute base interpreter home`);
    let base;
    try { base = realpathSync(baseBin); } catch { throw new PdfIsolationError('runtime_unavailable', `the venv's base interpreter home ${baseBin} is missing`); }
    roots.push(dirname(base));
  }
  roots.push(dirname(dirname(real))); // the interpreter's own prefix (stdlib, libpython)
  const mounts = [...new Set(roots.map(canon))].filter((m) => !contains('/usr', m)).sort((a, b) => a.length - b.length);
  let hidden;
  try { hidden = [...defaultHidden(home, env), hostPaths({ env }).brokerDir, hostPaths({ env }).inside, ...(env.PI_RESEARCH_KEYS_DIR ? [env.PI_RESEARCH_KEYS_DIR] : [])].map(canon); }
  catch (e) { throw new PdfIsolationError('unsafe_runtime', `cannot determine private controller state: ${e.message}`); }
  const forbidden = [...BROAD, home, REPO, cwd].map(canon);
  for (const m of mounts) {
    if (!statSync(m).isDirectory()) throw new PdfIsolationError('unsafe_runtime', `runtime root ${m} is not a directory`);
    const broad = forbidden.find((f) => contains(m, f));
    if (broad) throw new PdfIsolationError('unsafe_runtime', `runtime root ${m} is or contains ${broad}; refusing to mount it into the PDF sandbox`);
    const secret = hidden.find((h) => contains(m, h) || contains(h, m));
    if (secret) throw new PdfIsolationError('unsafe_runtime', `runtime root ${m} overlaps private state ${secret}`);
  }
  const covered = (p) => contains('/usr', p) || mounts.some((m) => contains(m, p));
  // Execute through the venv's bin (Python finds pyvenv.cfg from there); else the resolved interpreter itself.
  const exec = covered(bin) ? join(bin, basename(python)) : real;
  if (!covered(real)) throw new PdfIsolationError('unsafe_runtime', `interpreter ${real} is outside the runtime mounts`);
  return { exec, mounts };
}

/** bubblewrap arguments (everything before `--`) for a resolved runtime. */
export function pdfSandboxArgs({ mounts }) {
  const a = ['--unshare-user', '--disable-userns', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net', '--unshare-cgroup-try',
    '--cap-drop', 'ALL', '--new-session', '--die-with-parent', '--hostname', 'mina-pdf', '--ro-bind', '/usr', '/usr'];
  for (const p of ['/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32']) {
    if (!existsSync(p)) continue;
    if (lstatSync(p).isSymbolicLink()) {
      if (!contains('/usr', canon(p))) throw new PdfIsolationError('isolation_unavailable', `unsupported system alias ${p}`);
      a.push('--symlink', readlinkSync(p), p);
    } else if (lstatSync(p).isDirectory()) a.push('--ro-bind', p, p);
  }
  if (existsSync('/etc/ld.so.cache')) a.push('--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache'); // loader index only
  a.push('--dev', '/dev', '--proc', '/proc', '--size', String(PDF_TMP_BYTES), '--perms', '0700', '--tmpfs', '/tmp');
  for (const m of mounts) a.push('--ro-bind', m, m);
  a.push('--remount-ro', '/', '--clearenv', '--setenv', 'PATH', '/usr/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'LC_ALL', 'C.UTF-8',
    // onnxruntime (PDF layout analysis) starts Microsoft telemetry and one thread per core unless told otherwise; the
    // threads exhaust the address-space limit. There is no network here either way.
    '--setenv', 'ORT_DISABLE_TELEMETRY', '1', '--setenv', 'OPENBLAS_NUM_THREADS', '1', '--setenv', 'OMP_NUM_THREADS', '1', '--chdir', '/');
  return a;
}

const unavailable = (reason, error) => ({ status: 'pdf_extractor_unavailable', reason, error });
const positive = (n) => Number.isSafeInteger(n) && n > 0;

/**
 * Run `script` (which must start with the rlimit prelude; argv[1..2] are memory bytes and CPU seconds, the prelude
 * removes them) with `buf` on stdin, inside the sandbox. Resolves the script's JSON object, or a typed failure:
 * pdf_extractor_unavailable (reason), extractor_timeout, extractor_output_limit, extractor_failed. Rejects only on abort.
 * The whole sandbox (descendants included: the pid namespace dies with its init) is SIGKILLed on deadline, output cap
 * and abort.
 */
export function runSandboxedPython(buf, { python, script, args = [], timeoutMs = 30000, maxStdoutBytes = 4 * 1024 * 1024,
  maxMemoryBytes = 1536 * 1024 * 1024, signal, spawnImpl = spawn, bwrap = BWRAP } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    if (!positive(maxMemoryBytes) || !positive(maxStdoutBytes) || !positive(timeoutMs) || typeof script !== 'string'
      || !args.every((x) => typeof x === 'string' && !x.includes('\0'))) {
      resolvePromise(unavailable('invalid_limits', 'extractor limits must be positive integers')); return;
    }
    const problem = bwrapProblem(bwrap);
    if (problem) { resolvePromise(unavailable('isolation_unavailable', problem)); return; }
    let argv;
    try {
      const rt = resolvePdfRuntime(python);
      argv = [...pdfSandboxArgs(rt), '--', rt.exec, '-I', '-B', '-c', script, String(maxMemoryBytes), String(Math.max(1, Math.ceil(timeoutMs / 1000))), ...args];
    } catch (e) {
      resolvePromise(unavailable(e instanceof PdfIsolationError ? e.reason : 'isolation_unavailable', e.message)); return;
    }
    let child;
    try {
      // detached: bwrap leads its own process group, so the whole group can be killed; env: bwrap clears it anyway.
      child = spawnImpl(bwrap, argv, { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: true, env: { PATH: '/usr/bin:/bin' } });
    } catch (e) {
      resolvePromise(unavailable('isolation_unavailable', `cannot start bubblewrap: ${e.code ?? 'spawn_failed'}`)); return;
    }
    let settled = false, exited = false, bytes = 0, errHead = '';
    const chunks = [];
    const kill = () => {
      if (exited) return;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group gone */ } }
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    };
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      kill();
      fn(v);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(resolvePromise, { status: 'extractor_timeout', error: `PDF extraction exceeded ${timeoutMs} ms` }), timeoutMs);
    child.on('exit', () => { exited = true; });
    child.on('error', (e) => finish(resolvePromise, unavailable('isolation_unavailable', `cannot start bubblewrap: ${e.code ?? 'spawn_failed'}`)));
    child.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes > maxStdoutBytes) { finish(resolvePromise, { status: 'extractor_output_limit', error: `extractor output exceeded ${maxStdoutBytes} bytes` }); return; }
      chunks.push(c);
    });
    // Drained, never logged or returned (may echo document content); only bwrap's own setup-failure prefix is classified.
    child.stderr.on('data', (c) => { if (errHead.length < 16) errHead += c.toString('latin1').slice(0, 16); });
    child.stdin.on('error', () => {}); // EPIPE when the child exits early
    child.on('close', (code) => {
      if (settled) return;
      exited = true;
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* below */ }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && bytes) { finish(resolvePromise, parsed); return; }
      if (!bytes && errHead.startsWith('bwrap: ')) { finish(resolvePromise, unavailable('isolation_unavailable', 'bubblewrap could not build the sandbox (user namespaces unavailable?)')); return; }
      finish(resolvePromise, { status: 'extractor_failed', error: `extractor exited ${code ?? 'by signal'} without a result` });
    });
    child.stdin.end(buf);
  });
}

function abortError(signal) {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  const e = new Error(r ? String(r) : 'supplement_get aborted');
  e.name = 'AbortError';
  return e;
}
