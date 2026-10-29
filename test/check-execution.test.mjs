import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { checkCommand } from '../extensions/goal/check-execution.mjs';
import { createHash } from 'node:crypto';
import { runFileOperation } from '../sandbox/worker-client.mjs';
import { needsSandbox } from './capabilities.mjs';

test('check execution refuses missing protection and does not silently open package networking', () => {
  // A folder of its own, not /tmp itself: a repository checked out under /tmp would overlap it (trusted runtime).
  const cwd = mkdtempSync(join(tmpdir(), 'mina-check-protection-'));
  try {
    assert.equal(checkCommand('true', cwd, { env: {} }), 'true');
    const refused = checkCommand('touch should-not-run', cwd, { env: { MINA_SANDBOX: '1' }, available: false });
    assert.match(refused, /exit 126/);
    assert.doesNotMatch(refused, /touch should-not-run/);
    const command = checkCommand('true', cwd, { env: { MINA_SANDBOX: '1', MINA_SANDBOX_NET: 'packages' }, available: true });
    assert.match(command, /--unshare-net/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('real check wrapper hides a credential fixture and scrubs inherited secret values', { skip: needsSandbox }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-check-wrapper-'));
  try {
    const secret = join(cwd, 'credential-fixture');
    writeFileSync(secret, 'fixture-only');
    const env = { MINA_SANDBOX: '1', MINA_SANDBOX_NET: 'offline', MINA_SANDBOX_HIDE: JSON.stringify([secret]), PROBE_API_KEY: 'fixture-only' };
    const command = checkCommand(`test ! -s '${secret}' && test -z "\${PROBE_API_KEY:-}" && printf 'contained'`, cwd, { env });
    const result = spawnSync('bash', ['-c', command], { cwd, env: { ...process.env, PROBE_API_KEY: 'fixture-only' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'contained');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('protected checks execute accepted immutable bytes despite a later workspace replacement', { skip: needsSandbox }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-check-snapshot-'));
  const cache = mkdtempSync(join(tmpdir(), 'mina-check-cache-'));
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true });
  const path = join(cwd, '.mina', 'checks', 'probe.sh');
  writeFileSync(path, 'printf original');
  const frozen = { '.mina/checks/probe.sh': createHash('sha256').update('printf original').digest('hex') };
  const env = { MINA_SANDBOX: '1', MINA_SANDBOX_PROJECT: cwd, MINA_SANDBOX_NET: 'offline', XDG_CACHE_HOME: cache };
  try {
    const command = checkCommand('bash .mina/checks/probe.sh; if echo tamper > .mina/checks/probe.sh; then exit 99; fi', cwd, { env, frozen });
    writeFileSync(path, 'printf forged');
    const out = spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, 'original');
    assert.match(out.stderr, /Read-only file system/);
  } finally { rmSync(cwd, { recursive: true }); rmSync(cache, { recursive: true }); }
});

test('candidate code cannot rename checker ancestors and substitute another validator', { skip: needsSandbox }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-check-ancestor-'));
  const cache = mkdtempSync(join(tmpdir(), 'mina-ancestor-cache-'));
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true });
  writeFileSync(join(cwd, '.mina', 'checks', 'probe.sh'), 'printf original');
  writeFileSync(join(cwd, 'candidate.sh'), 'mv .mina .mina-moved; mkdir -p .mina/checks; printf "printf forged" > .mina/checks/probe.sh');
  const frozen = { '.mina/checks/probe.sh': createHash('sha256').update('printf original').digest('hex') };
  const env = { MINA_SANDBOX: '1', MINA_SANDBOX_PROJECT: cwd, MINA_SANDBOX_NET: 'offline', XDG_CACHE_HOME: cache };
  try {
    const command = checkCommand('bash candidate.sh; bash .mina/checks/probe.sh', cwd, { env, frozen });
    const out = spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, 'original');
  } finally { rmSync(cwd, { recursive: true }); rmSync(cache, { recursive: true }); }
});

test('a concurrent worker cannot reroute an already running protected checker', { skip: needsSandbox }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-check-concurrent-'));
  const cache = mkdtempSync(join(tmpdir(), 'mina-concurrent-cache-'));
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true }); mkdirSync(join(cwd, 'sync'));
  writeFileSync(join(cwd, '.mina', 'checks', 'probe.sh'), 'printf original');
  const env = { MINA_SANDBOX: '1', MINA_SANDBOX_PROJECT: cwd, MINA_SANDBOX_NET: 'offline', XDG_CACHE_HOME: cache };
  const frozen = { '.mina/checks/probe.sh': createHash('sha256').update('printf original').digest('hex') };
  let child;
  try {
    const command = checkCommand('printf CHECK_READY >&2; while [ ! -e sync/proceed ]; do sleep .01; done; bash .mina/checks/probe.sh', cwd, { env, frozen });
    child = spawn('/bin/bash', ['-c', command]);
    let stdout = '', stderr = '';
    const ended = new Promise((done) => child.on('close', (code) => done(code)));
    child.stdout.on('data', (data) => { stdout += data; });
    await new Promise((done, fail) => { const timer = setTimeout(() => fail(new Error('checker did not start')), 5000);
      child.stderr.on('data', (data) => { stderr += data; if (stderr.includes('CHECK_READY')) { clearTimeout(timer); done(); } }); });
    await runFileOperation('rename', { path: join(cwd, '.mina'), target: join(cwd, '.mina-moved') }, { cwd, env });
    await runFileOperation('mkdir', { path: join(cwd, '.mina', 'checks') }, { cwd, env });
    await runFileOperation('write', { path: join(cwd, '.mina', 'checks', 'probe.sh'), data: Buffer.from('printf forged').toString('base64') }, { cwd, env });
    await runFileOperation('write', { path: join(cwd, 'sync', 'proceed'), data: '' }, { cwd, env });
    assert.equal(await ended, 0, stderr);
    assert.equal(stdout, 'original');
  } finally { child?.kill('SIGKILL'); rmSync(cwd, { recursive: true }); rmSync(cache, { recursive: true }); }
});

test('protected check projections preserve hidden paths and do not leak source directory descriptors', { skip: needsSandbox }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-check-fds-'));
  const cache = mkdtempSync(join(tmpdir(), 'mina-fd-cache-'));
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true });
  writeFileSync(join(cache, 'controller.secret'), 'PRIVATE_FD_CANARY');
  writeFileSync(join(cwd, 'hidden.txt'), 'PRIVATE_FD_CANARY');
  const cacheName = cache.split('/').at(-1);
  const script = `test ! -s hidden.txt || exit 91\nfor fd in /proc/self/fd/*; do\n for hop in .. ../.. ../../..; do\n  if test -f "$fd/$hop/${cacheName}/controller.secret"; then cat "$fd/$hop/${cacheName}/controller.secret"; fi\n done\n if test -f "$fd"; then head -c 200 "$fd" 2>/dev/null; fi\ndone\nprintf original`;
  writeFileSync(join(cwd, '.mina', 'checks', 'probe.sh'), script);
  const env = { MINA_SANDBOX: '1', MINA_SANDBOX_PROJECT: cwd, MINA_SANDBOX_NET: 'offline', XDG_CACHE_HOME: cache,
    MINA_SANDBOX_HIDE: JSON.stringify([join(cwd, 'hidden.txt')]), OPAQUE_PRIVATE_VALUE: 'PRIVATE_FD_CANARY' };
  const frozen = { '.mina/checks/probe.sh': createHash('sha256').update(script).digest('hex') };
  try {
    const command = checkCommand('test -z "${OPAQUE_PRIVATE_VALUE:-}"; bash .mina/checks/probe.sh', cwd, { env, frozen });
    const out = spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, OPAQUE_PRIVATE_VALUE: 'PRIVATE_FD_CANARY' } });
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /PRIVATE_FD_CANARY/);
    assert.ok(out.stdout.endsWith('original'));
  } finally { rmSync(cwd, { recursive: true }); rmSync(cache, { recursive: true }); }
});
