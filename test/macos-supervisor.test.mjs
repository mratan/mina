// macOS: the supervisor and the call jobs (sandbox/macos/supervisor.mjs, sandbox/macos/mina-instance.c). Each test call is
// a real launchd job with its own coalition, as in a Mina instance. Skipped on other systems.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HELPER, members } from '../sandbox/macos/launchd.mjs';
import { REPO } from '../sandbox/sandbox.mjs';

const skip = process.platform !== 'darwin' ? 'macOS only'
  : !existsSync(HELPER) ? 'build the helper first: scripts/macos-helpers.sh' : false;
const SUPERVISOR = join(REPO, 'sandbox/macos/supervisor.mjs');

let root, project, outside, sup, socket, coalitions;
before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(homedir(), '.mina-test-sup-')));
  project = join(root, 'project'); outside = join(root, 'outside');
  for (const d of [project, outside, join(root, 'home'), join(root, 'outputs')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  const runDir = join(root, 'run');
  mkdirSync(runDir, { mode: 0o700 });
  socket = join(runDir, 's');
  coalitions = join(root, 'coalitions');
  const spec = join(root, 'spec.json');
  writeFileSync(spec, JSON.stringify({ instanceId: `test-${process.pid}`, runDir, socket, coalitionsFile: coalitions,
    allowedWrites: [project, join(root, 'home'), join(root, 'outputs')], workerHome: join(root, 'home'), workerOutputs: join(root, 'outputs'),
    pi: { argv: ['/bin/sleep', '3600'], env: { PATH: '/usr/bin:/bin' }, cwd: project } }), { mode: 0o600 });
  sup = spawn(process.execPath, [SUPERVISOR, spec], { stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 200 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(existsSync(socket), 'the supervisor listens');
});
after(async () => {
  if (skip) return;
  sup.kill('SIGTERM');
  await new Promise((r) => sup.once('exit', r));
  rmSync(root, { recursive: true, force: true });
});

const TOOLS = join(REPO, 'build/macos/bin');
const request = (argv, extra = {}) => ({ kind: 'worker', argv, cwd: project,
  roots: { cwd: project, project, writable: [project], readable: [], hidden: [], exposed: [], readOnly: [] },
  network: 'offline', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }, ...extra });
const call = (req, input) => spawnSync(HELPER, ['relay', socket], { env: { MINA_CALL: JSON.stringify(req) }, input, encoding: 'utf8', timeout: 60_000 });
const sh = (script, extra) => call(request(['/bin/bash', '--noprofile', '--norc', '-c', script], extra));

test('a call runs in the project and returns stdout, stderr and the exit status', { skip }, () => {
  const r = sh('pwd -P; echo err >&2; exit 3');
  assert.equal(r.stdout.trim(), project);
  assert.equal(r.stderr.trim(), 'err');
  assert.equal(r.status, 3);
});

test('stdin reaches the command, also large input', { skip }, () => {
  const big = 'x'.repeat(5 * 1024 * 1024);
  const r = call(request(['/usr/bin/wc', '-c']), big);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Number(r.stdout.trim()), big.length);
});

test('a command that a signal ends reports 128 + the signal', { skip }, () => {
  assert.equal(sh('kill -9 $$').status, 137);
});

test('the worker sees the project and its home, not other files', { skip }, () => {
  const r = sh(`echo hi > out.txt && cat out.txt && echo "$HOME" && cat ${join(outside, 'secret.txt')}; echo rc=$?`);
  assert.match(r.stdout, /^hi\n/);
  assert.match(r.stdout, new RegExp(`${join(root, 'home')}\\n`));
  assert.match(r.stdout, /rc=1/);
  assert.match(r.stderr, /Operation not permitted/);
});

test('each call has a private TMPDIR that is gone after the call', { skip }, () => {
  const a = sh('echo kept > "$TMPDIR/x"; echo "$TMPDIR"');
  const tmp = a.stdout.trim();
  assert.ok(tmp.length > 1);
  assert.equal(existsSync(join(tmp, 'x')), false, 'the TMPDIR of a call does not outlive it');
  const b = sh('ls "$TMPDIR" | wc -l');
  assert.equal(b.stdout.trim(), '0');
});

test('processes that a call detaches stop when the call ends (setsid, double fork)', { skip }, () => {
  const marker = `mina-escape-${process.pid}`;
  const r = sh(`(/bin/sleep 300 &) ; /usr/bin/python3 -c 'import os,time
if os.fork(): os._exit(0)
os.setsid()
if os.fork(): os._exit(0)
time.sleep(300)' ${marker} & /bin/sleep 0.5; echo started`);
  assert.equal(r.stdout.trim(), 'started', r.stderr);
  const left = spawnSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' });
  assert.equal(left.stdout.trim(), '', 'no process of the call remains');
});

test('a killed relay stops its call and the processes of the call', { skip }, async () => {
  const marker = `mina-relay-kill-${process.pid}`;
  const child = spawn(HELPER, ['relay', socket], { env: { MINA_CALL: JSON.stringify(request(['/bin/bash', '-c', `/bin/sleep 300 & exec -a ${marker} /bin/sleep 300`])) } });
  await new Promise((r) => setTimeout(r, 1500));
  assert.notEqual(spawnSync('/usr/bin/pgrep', ['-f', marker]).stdout.toString().trim(), '', 'the call runs');
  child.kill('SIGKILL');
  for (let i = 0; i < 100; i++) {
    if (!spawnSync('/usr/bin/pgrep', ['-f', marker]).stdout.toString().trim()) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(spawnSync('/usr/bin/pgrep', ['-f', marker]).stdout.toString().trim(), '', 'the call stopped');
});

test('the supervisor refuses a write root that is not a root of the launch', { skip }, () => {
  const r = call(request(['/usr/bin/true'], { roots: { cwd: project, project, writable: [project, outside], readable: [], hidden: [], exposed: [], readOnly: [] } }));
  assert.equal(r.status, 126);
  assert.match(r.stderr, /not a writable root of this launch/);
});

test('hidden paths inside a root are denied, exposed paths inside them stay readable', { skip }, () => {
  mkdirSync(join(project, 'keys'), { recursive: true }); writeFileSync(join(project, 'keys', 'k'), 'k');
  mkdirSync(join(project, 'keys', 'pub'), { recursive: true }); writeFileSync(join(project, 'keys', 'pub', 'p'), 'p');
  const r = call(request(['/bin/bash', '-c', 'cat keys/k; echo rc=$?; cat keys/pub/p'],
    { roots: { cwd: project, project, writable: [project], readable: [], hidden: [join(project, 'keys')], exposed: [join(project, 'keys', 'pub')], readOnly: [] } }));
  assert.match(r.stdout, /rc=1\np/);
});

test('the coalitions of the calls are recorded for mina stop', { skip }, () => {
  sh('true');
  const ids = readFileSync(coalitions, 'utf8').trim().split('\n').map(Number);
  assert.ok(ids.length >= 1);
  assert.deepEqual(members(ids).filter((m) => !m.zombie && m.comm !== 'mina-instance'), [], 'no worker process remains');
});

test('a call costs well under a second', { skip }, () => {
  sh('true');
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) sh('true');
  const ms = (Date.now() - t0) / 5;
  assert.ok(ms < 1000, `${ms} ms per call`);
  process.stderr.write(`# call latency: ${ms.toFixed(0)} ms\n`);
});

test('ps, pgrep and pkill in a worker see the processes of the call, as in a PID namespace', { skip: skip || (!existsSync(join(TOOLS, 'ps')) && 'build the helpers: scripts/macos-helpers.sh') }, () => {
  const outside = spawn('/bin/sleep', ['300']);
  try {
    const r = sh(`/bin/sleep 300 & ps -o pid,comm | tail -n +2 | wc -l | tr -d ' '; pgrep -x sleep; echo "outside=$(pgrep -f 'sleep 300' | grep -c ${outside.pid})"; pkill -x sleep; echo "pkill=$?"; wait`,
      { env: { PATH: `${TOOLS}:/usr/bin:/bin` } });
    const [count, own, seen, killed] = r.stdout.trim().split('\n');
    assert.ok(Number(count) >= 2 && Number(count) <= 8, r.stdout);          // bash, sleep, ps and the pipeline (tail, wc, tr)
    assert.match(own, /^\d+$/);
    assert.equal(seen, 'outside=0', 'a process outside the call is not listed');
    assert.equal(killed, 'pkill=0');
    assert.equal(outside.exitCode, null, 'pkill did not reach the outside process');
  } finally { outside.kill(); }
});
