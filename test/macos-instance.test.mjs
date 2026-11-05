// macOS: a real Mina instance as a launchd job (sandbox/macos/launch.mjs, supervisor.mjs, watchdog.mjs): the deadline,
// an explicit stop that leaves no process, and the emulated memory, process and CPU limits. The counterparts of the
// systemd scope tests in instance-runtime.test.mjs. Skipped on other systems.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from '../sandbox/sandbox.mjs';
import { createInstance, inspectInstance, stopInstance } from '../lib/instance-runtime.mjs';
import { needsLauncher } from './capabilities.mjs';

const skip = process.platform !== 'darwin' ? 'macOS only' : needsLauncher;
const LAUNCH = pathToFileURL(join(REPO, 'sandbox/macos/launch.mjs')).href;

// Starts `script` (bash) as the "Pi" of a real instance, in a child process whose stdout is a pipe (the instance's stdout).
function startInstance(script, limits) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mina-mac-instance-')));
  const instance = createInstance({ cwd: dir, stateDir: join(dir, 'state'), artifactBase: join(dir, 'artifacts'), limits });
  const runner = `import { launchInstance } from ${JSON.stringify(LAUNCH)};
const code = await launchInstance({ instance: ${JSON.stringify(instance)}, command: ['/bin/bash', '-c', ${JSON.stringify(script)}],
  runEnv: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, cwd: ${JSON.stringify(dir)}, writable: [${JSON.stringify(dir)}] });
process.exit(code);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', runner], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((done) => child.on('close', (code) => done(code)));
  return { dir, instance, child, exited, out: () => stdout, err: () => stderr,
    waitFor: async (text, ms = 15_000) => { const t0 = Date.now(); while (!stdout.includes(text)) { if (Date.now() - t0 > ms) throw new Error(`no "${text}": ${stdout} ${stderr}`); await new Promise((r) => setTimeout(r, 50)); } },
    close: () => rmSync(dir, { recursive: true, force: true }) };
}
const base = { memoryBytes: 512 * 1024 ** 2, maxProcesses: 64, cpuPercent: 400 };
const running = (marker) => spawnSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim();

test('the instance runs as a launchd job and returns the exit status of Pi', { skip }, async () => {
  const f = startInstance('printf hello; exit 7', base);
  try {
    assert.equal(await f.exited, 7, f.err());
    assert.equal(f.out(), 'hello');
    assert.equal(inspectInstance(f.instance).alive, false);
  } finally { f.close(); }
});

test('a real instance deadline stops the instance', { skip }, async () => {
  const f = startInstance('/bin/sleep 30', { ...base, maxWallS: 1 });
  const started = Date.now();
  try {
    const code = await f.exited;
    assert.notEqual(code, 0, 'the deadline interrupts Pi');
    assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
    assert.equal(inspectInstance(f.instance).alive, false);
  } finally { f.close(); }
});

test('explicit stop leaves no process of the instance, including detached descendants', { skip }, async () => {
  const marker = `mina-stop-${process.pid}`;
  const f = startInstance(`/usr/bin/perl -e 'use POSIX; exit if fork; POSIX::setsid(); exec { "/bin/sleep" } "${marker}", "300"'; printf ready; wait; /bin/sleep 300`, base);
  try {
    await f.waitFor('ready');
    assert.equal(inspectInstance(f.instance).alive, true);
    assert.notEqual(running(marker), '', 'the detached process runs');
    assert.equal((await stopInstance(f.instance)).alive, false);
    await f.exited;
    assert.equal(running(marker), '', 'no detached process remains');
    assert.equal(JSON.parse(readFileSync(f.instance.file)).status, 'stopped');
  } finally { f.child.kill('SIGKILL'); f.close(); }
});

test('the memory limit kills the largest process, as the OOM killer of a cgroup does', { skip }, async () => {
  const f = startInstance(`/usr/bin/perl -e '$x = "a" x (400*1024*1024); sleep 30'; echo "rc=$?"`, { ...base, memoryBytes: 128 * 1024 ** 2 });
  try {
    await f.waitFor('rc=', 20_000);
    assert.match(f.out(), /rc=137/, 'killed with SIGKILL');
  } finally { f.child.kill('SIGKILL'); f.close(); }
});

test('the process limit stops processes beyond it', { skip }, async () => {
  // The wait is a shell loop: a `sleep` would be one of the newest processes, which the limit stops first.
  const f = startInstance(`for i in $(seq 1 40); do /bin/sleep 30 & done; t=$SECONDS; while (( SECONDS - t < 2 )); do :; done; jobs -r | wc -l | tr -d ' '; echo done`, { ...base, maxProcesses: 16 });
  try {
    await f.waitFor('done', 20_000);
    assert.ok(Number(f.out().trim().split('\n')[0]) <= 16, f.out());
  } finally { f.child.kill('SIGKILL'); f.close(); }
});

test('the CPU quota throttles a busy instance', { skip }, async () => {
  // Two processes that each need 0.5 s of CPU time. Unthrottled they finish in about 0.5 s; under a quota of 50% the
  // instance gets 0.5 CPU seconds per second, so the 1 s of CPU time between them takes about 2 s.
  const burn = `/usr/bin/perl -MTime::HiRes=time -e 'my $s = time; 1 while (times)[0] < 0.5; printf "wall=%.2f\\n", time - $s'`;
  const f = startInstance(`${burn} & ${burn} & wait; echo done`, { ...base, cpuPercent: 50 });
  try {
    await f.waitFor('done', 30_000);
    const walls = [...f.out().matchAll(/wall=([\d.]+)/g)].map((m) => Number(m[1]));
    assert.equal(walls.length, 2, f.out());
    assert.ok(Math.max(...walls) >= 1.4, `wall times ${walls.join(', ')} s: not throttled`);
  } finally { f.child.kill('SIGKILL'); f.close(); }
});

test('Pi copies to the clipboard through the supervisor, and cannot read it (as OSC 52 on Linux)', { skip }, async () => {
  const saved = spawnSync('/usr/bin/pbpaste', { encoding: 'utf8' }).stdout;
  const marker = `mina-clipboard-${process.pid}`;
  spawnSync('/usr/bin/pbcopy', { input: 'before' });
  const f = startInstance(`printf ${marker} | pbcopy; echo "copy=$?"; /usr/bin/pbpaste >/dev/null 2>&1; echo "paste=$?"`, base);
  try {
    assert.equal(await f.exited, 0, f.err());
    assert.match(f.out(), /copy=0/);
    assert.doesNotMatch(f.out(), /paste=0/, 'Pi cannot read the clipboard');
    assert.equal(spawnSync('/usr/bin/pbpaste', { encoding: 'utf8' }).stdout, marker);
  } finally { spawnSync('/usr/bin/pbcopy', { input: saved }); f.close(); }
});
