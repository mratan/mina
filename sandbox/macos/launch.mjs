// The launcher's part on macOS (bin/mina.mjs; docs/macos.md, "Linux parity design"). On Linux the launcher runs
// `systemd-run --scope -- bwrap ... -- node pi`. Here it starts the instance as a launchd job: `mina-instance attach`
// (in this terminal) bootstraps the job and gives it this terminal; the job's mina-instance starts the supervisor
// (sandbox/macos/supervisor.mjs), which starts Pi under the outer profile. The exit status of Pi comes back the same way.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPER, HELPER_SOURCE, bootout, instanceLabel, plist } from './launchd.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SUPERVISOR = join(REPO, 'sandbox', 'macos', 'supervisor.mjs');
const SUN_PATH_MAX = 103;
const canonical = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

// Why the native helper cannot be used (null = it can): it must exist and be built from the current source.
export function helperProblem() {
  if (!existsSync(HELPER)) return `the macOS helper is not built (${HELPER}). Run: npm run macos:helpers`;
  let built = '';
  try { built = execFileSync(HELPER, ['version'], { encoding: 'utf8', timeout: 10_000 }).trim(); } catch { /* below */ }
  const source = createHash('sha256').update(readFileSync(HELPER_SOURCE)).digest('hex');
  if (built !== source) return 'the macOS helper is out of date for this checkout. Run: npm run macos:helpers';
  // ps, pgrep and pkill of the workers (sandbox/macos/mina-ps.c).
  const ps = join(REPO, 'build', 'macos', 'bin', 'mina-ps');
  let psBuilt = '';
  try { psBuilt = readFileSync(`${ps}.sha256`, 'utf8').trim(); } catch { /* below */ }
  const psSource = createHash('sha256').update(readFileSync(join(REPO, 'sandbox', 'macos', 'mina-ps.c'))).digest('hex');
  return existsSync(ps) && psBuilt === psSource ? null : 'the macOS worker tools (ps, pgrep, pkill) are missing or out of date. Run: npm run macos:helpers';
}

// The user's private temporary folder (getconf DARWIN_USER_TEMP_DIR): hidden from Pi, as the runtime folder is on Linux.
function userTempDir() {
  try { return canonical(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 10_000 }).trim()); } catch { return null; }
}

function developerDir() {
  try { return canonical(execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || null; } catch { return null; }
}

function sdkRoot() {
  try { return execFileSync('/usr/bin/xcrun', ['--show-sdk-path'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

// A short private folder for the sockets of the instance (a socket path has at most 103 bytes).
function runDirectory(id, env) {
  const base = join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'mina', 'run');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const n of [8, 12, 36]) {
    const dir = join(base, id.slice(0, n));
    if (existsSync(dir)) continue;
    if (Buffer.byteLength(join(dir, 's')) > SUN_PATH_MAX) break;
    mkdirSync(dir, { mode: 0o700 });
    return dir;
  }
  throw new Error(`mina: no short private folder for the instance's sockets under ${base}; set XDG_STATE_HOME to a shorter path`);
}

/**
 * Runs Pi (`command`, its environment `runEnv`) as the instance `instance`. `writable` are the outer layer's writable
 * folders and `readable` its trusted read-only folders (as outerArgs binds them on Linux), `sockets` the Unix sockets that
 * Pi may use besides the supervisor's.
 * Resolves the exit status.
 */
export async function launchInstance({ instance, command, runEnv, cwd, writable, readable = [], sockets = [], env = process.env, onExit = () => {} }) {
  const runDir = runDirectory(instance.id, env);
  const label = instanceLabel(instance.id);
  const specFile = join(runDir, 'spec.json'), plistFile = join(runDir, 'instance.plist'), attach = join(runDir, 'a');
  const allowedWrites = [...new Set([...writable, instance.workerHome, instance.workerOutputs].filter((p) => p && existsSync(p)).map(canonical))];
  const hidden = ['/private/tmp', userTempDir()].filter(Boolean);
  // The files of this terminal's standard input and output (mina -p > /tmp/out.txt). Seatbelt checks fstat(2) of an
  // inherited descriptor by its path, so Pi needs the metadata of these files, as on Linux an open descriptor works
  // whatever the mounts are.
  let stdio = [];
  try {
    const r = spawnSync(HELPER, ['fdpath', '3', '4', '5'], { stdio: ['ignore', 'pipe', 'ignore', 0, 1, 2], encoding: 'utf8', timeout: 10_000 });
    stdio = r.stdout.split('\n').filter((p) => p.startsWith('/') && !p.startsWith('/dev/'));
  } catch { /* none */ }
  writeFileSync(specFile, JSON.stringify({ instanceId: instance.id, runDir, socket: join(runDir, 's'), coalitionsFile: instance.coalitionsFile,
    allowedWrites, workerHome: canonical(instance.workerHome), workerOutputs: canonical(instance.workerOutputs), limits: instance.limits,
    sdkroot: sdkRoot(), developerDir: developerDir(), piHidden: hidden, piStdio: stdio, piReadable: readable.filter((p) => existsSync(p)).map(canonical), sockets, pi: { argv: command, env: runEnv, cwd } }), { mode: 0o600 });
  writeFileSync(plistFile, plist(label, [HELPER, 'instance', attach, '--', process.execPath, SUPERVISOR, specFile],
    { stderr: join(runDir, 'instance.err'), environment: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', MINA_INSTANCE_JOB: '1',
      ...(env.MINA_SUPERVISOR_DEBUG ? { MINA_SUPERVISOR_DEBUG: env.MINA_SUPERVISOR_DEBUG } : {}) } }), { mode: 0o600 });
  const child = spawn(HELPER, ['attach', attach, plistFile, label], { stdio: 'inherit', env: { PATH: '/usr/bin:/bin' } });
  // The terminal's process group (this launcher and mina-instance attach) gets Ctrl+C; attach passes it on. A signal to
  // this process alone (kill, a supervisor stopping mina) is passed on too, so Pi never outlives the launcher.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { if (sig !== 'SIGINT' || !process.stdin.isTTY) child.kill(sig); });
  const code = await new Promise((done) => child.on('exit', (c, s) => done(c ?? (s ? 128 : 1))));
  await bootout(label);
  let jobError = '';
  try { jobError = readFileSync(join(runDir, 'instance.err'), 'utf8').trim(); } catch { /* none */ }
  rmSync(runDir, { recursive: true, force: true });
  if (jobError) process.stderr.write(`${jobError}\n`);
  onExit(code);
  return code;
}
