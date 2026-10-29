import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createInstance, scopeCommand, inspectInstance, stopInstance, instanceLimits, instanceDirectory } from '../lib/instance-runtime.mjs';
import { REPO } from '../bin/mina.mjs';
import { needsSystemd } from './capabilities.mjs';

const run = (command, options = {}) => new Promise((resolve) => execFile(command[0], command.slice(1), options,
  (error, stdout, stderr) => resolve({ error, stdout, stderr })));

test('mina status discovers instance IDs without startup diagnostics', { skip: needsSystemd }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mina-status-'));
  const env = { ...process.env, XDG_STATE_HOME: dir };
  const record = createInstance({ cwd: dir, stateDir: instanceDirectory(env) });
  const out = await run([process.execPath, join(REPO, 'bin/mina.mjs'), 'status'], { env });
  assert.equal(out.error, null, out.stderr);
  const result = JSON.parse(out.stdout);
  assert.equal(result.instances.length, 1);
  assert.equal(result.instances[0].instance, record.id);
  assert.equal(result.instances[0].alive, false);
  assert.match(result.broker_jobs, /separately supervised/);
});

test('an instance keeps a protected identity and validated limits, with no default wall-clock deadline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mina-instance-'));
  const instance = createInstance({ cwd: dir, stateDir: join(dir, 'state') });
  assert.match(instance.id, /^[a-f0-9-]{36}$/);
  assert.equal(instance.unit, `mina-${instance.id}.scope`);
  assert.equal(instance.limits.maxWallS, undefined);
  assert.ok(!scopeCommand(instance, ['/bin/true']).some((arg) => arg.startsWith('--property=RuntimeMaxSec=')));
  assert.ok(scopeCommand({ ...instance, limits: { maxWallS: 60 } }, ['/bin/true']).includes('--property=RuntimeMaxSec=60'));
  assert.ok(instance.limits.memoryBytes > 0);
  assert.ok(instance.limits.maxProcesses > 0);
  assert.equal(JSON.parse(readFileSync(instance.file)).id, instance.id);
  for (const limits of [{ maxWallS: 0 }, { memoryBytes: true }, { cpuPercent: 0.5 }, { unknown: 1 }]) {
    assert.throws(() => instanceLimits(limits), /limit/i);
  }
});

test('a real instance deadline stops only its owned scope', { skip: needsSystemd }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mina-instance-deadline-'));
  const instance = createInstance({ cwd: dir, stateDir: join(dir, 'state'), limits: {
    maxWallS: 1, memoryBytes: 128 * 1024 ** 2, maxProcesses: 32, cpuPercent: 100,
  } });
  const started = Date.now();
  try {
    const result = await run(scopeCommand(instance, ['/bin/sleep', '30']), { timeout: 10_000 });
    assert.ok(result.error, 'the deadline must interrupt the command');
    assert.ok(Date.now() - started < 8000);
    const status = inspectInstance(instance);
    assert.equal(status.alive, false, JSON.stringify(status));
  } finally { await stopInstance(instance); }
});

test('explicit stop verifies its cgroup is empty, including detached descendants', { skip: needsSystemd }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mina-instance-stop-'));
  const instance = createInstance({ cwd: dir, stateDir: join(dir, 'state'), limits: {
    maxWallS: 20, memoryBytes: 128 * 1024 ** 2, maxProcesses: 32, cpuPercent: 100,
  } });
  const command = scopeCommand(instance, ['/bin/bash', '-c', 'setsid sleep 30 & printf ready; wait']);
  const child = spawn(command[0], command.slice(1));
  const closed = new Promise((done) => child.on('close', done));
  try {
    await new Promise((done, fail) => { child.stdout.once('data', done); child.once('error', fail); });
    const before = inspectInstance(instance);
    assert.equal(before.alive, true);
    const group = join('/sys/fs/cgroup', before.cgroup);
    assert.equal(readFileSync(join(group, 'memory.max'), 'utf8').trim(), '134217728');
    assert.equal(readFileSync(join(group, 'pids.max'), 'utf8').trim(), '32');
    assert.equal((await stopInstance(instance)).alive, false);
    await closed;
    assert.equal(inspectInstance(instance).alive, false);
    assert.equal(JSON.parse(readFileSync(instance.file)).status, 'stopped');
  } finally { await stopInstance(instance); }
});
