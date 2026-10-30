import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import minaHost, { manifestText, request, UNREGISTERED_MANIFEST, wrappedLines, DIALOG_CHROME_LINES } from '../extensions/host/index.js';
import { outerArgs, innerArgs, settings, hostPaths, BWRAP_PATH } from '../sandbox/sandbox.mjs';
import { hostEnv, openHostSession, POLICY_PROTOCOL } from '../bin/mina.mjs';
import { needsSandbox } from './capabilities.mjs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

const CLAIM = Symbol.for('mina:host-claim');

// A stand-in broker: answers each JSON line with handler(req) and records the requests.
async function fakeBroker(handler) {
  const dir = mkdtempSync(join(tmpdir(), 'mina-hostd-'));
  const socket = join(dir, 'sock');
  const seen = [];
  const server = createServer((c) => {
    let data = '';
    c.on('data', (d) => { data += d; if (data.endsWith('\n')) { const req = JSON.parse(data); seen.push(req); c.end(`${JSON.stringify(handler(req))}\n`); } });
  });
  await new Promise((r) => server.listen(socket, r));
  const grantFile = join(dir, 'grant');
  writeFileSync(grantFile, 'G\n');
  return { socket, grantFile, seen, dir, close: () => new Promise((r) => server.close(r)) };
}

function fakePi() {
  const pi = { tools: {}, handlers: {}, sent: [], order: [] };
  pi.registerTool = (t) => { pi.tools[t.name] = t; };
  pi.on = (ev, fn) => { (pi.handlers[ev] ??= []).push(fn); };
  pi.sendMessage = (m, o) => { pi.sent.push({ m, o }); pi.order.push(`sent:${m.details?.id}`); };
  pi.emit = async (ev, event = {}, ctx = {}) => { let out; for (const fn of pi.handlers[ev] ?? []) out = await fn(event, ctx); return out; };
  return pi;
}

const WIRE = 'mutate_v2';
const CAPS = { confirmation_protocol: 'mina-confirmation-v1', mutation_protocol: WIRE, capabilities: [
  { capability: 'resource:GPU_A', status: 'AVAILABLE', detail: 'host locks' },
  { capability: 'service:safety-watchdog:restart', status: 'REQUIRES_AUTHORIZATION', detail: 'the user confirms each restart' },
  { capability: 'alarm_delivery_external', status: 'BLOCKED', detail: 'no external channel', remediation: 'set alarm_command' }] };

test('retained workload output is read-only, pageable and not silently clipped by the native tool', async () => {
  delete globalThis[CLAIM];
  const bytes = Buffer.alloc(4096, 0);
  const b = await fakeBroker(req => ({ ok: true, result: { kind: 'workload_output', id: req.id,
    offset: req.offset, next_offset: req.offset + bytes.length, eof: false,
    text: bytes.toString(), data_base64: bytes.toString('base64') } }));
  const pi = fakePi(); minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
  try {
    assert.ok(pi.tools.mina_host.parameters.properties.action.enum.includes('workload_output'));
    const result = await pi.tools.mina_host.execute('output-read', { action: 'workload_output', id: '20260101000000-abcdef', offset: 0, limit: 4096 }, null, null,
      { hasUI: true, ui: { confirm() { throw Error('Output retrieval must not request confirmation'); } } });
    assert.equal(result.isError, false);
    const visible = result.content[0].text;
    assert.doesNotMatch(visible, /truncated/);
    const page = JSON.parse(visible.replace(/^OK: /, ''));
    assert.deepEqual(Buffer.from(page.data_base64, 'base64'), bytes);
    assert.equal(b.seen[0].op, 'workload_output');
    assert.equal(b.seen[0].offset, 0);
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('manifest: grouped by status, stable text, remediation shown; an unreachable broker is BLOCKED', () => {
  const m = manifestText(CAPS);
  assert.match(m, /AVAILABLE:\n- resource:GPU_A/);
  assert.match(m, /REQUIRES AUTHORIZATION:\n- service:safety-watchdog:restart/);
  assert.match(m, /BLOCKED:\n- alarm_delivery_external: set alarm_command/);
  assert.match(m, /Subagents cannot use mina_host/);
  assert.ok(!/no external channel|the user confirms/.test(m), 'details stay behind mina_host capabilities');
  assert.equal(m, manifestText(CAPS));
  assert.match(manifestText(null, { message: 'down', remediation: 'start it' }), /Host broker: BLOCKED \(down\).*start it/s);
});

test('manifest lines show each workload\'s time cap, so the agent does not guess max_s (IV-1a, 2026-10-17)', () => {
  const caps = { ...CAPS, capabilities: [...CAPS.capabilities,
    { capability: 'workload:campaign-cell', status: 'AVAILABLE', detail: "the campaign runner; resources [], max 2400s, params ['exp', 'locks']; locks from GPU_A|HOST_QUIET, takes command: an argv run in a sandbox" },
    { capability: 'workload:git-push', status: 'AVAILABLE', detail: "push one branch; resources [], max 300s, params ['branch']" },
    { capability: 'workload:canary', status: 'AVAILABLE', detail: "resources ['GPU_A'], max 30s" }] };
  const m = manifestText(caps);
  assert.match(m, /- workload:campaign-cell \(max 2400s; params exp, locks; locks: comma list of GPU_A\|HOST_QUIET; takes a command\)/);
  assert.match(m, /- workload:git-push \(max 300s; params branch\)/);
  assert.match(m, /- workload:canary \(max 30s\)/);
});

test('an old broker manifest cannot advertise mutations as executable in the new client', () => {
  const m = manifestText({ ...CAPS, confirmation_protocol: undefined });
  assert.match(m, /BLOCKED:\n- resource:GPU_A/);
  assert.ok(!m.includes('AVAILABLE:\n- resource:GPU_A'));
  assert.match(m, /safe boundary/);
});

test('extension: manifest in the system prompt and .mina; a subagent instance gets nothing; a handoff successor does', async () => {
  delete globalThis[CLAIM];
  const b = await fakeBroker((req) => (req.op === 'capabilities' ? { ok: true, result: CAPS } : { ok: true, result: { pending: [], acked: [] } }));
  const env = { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile };
  const cwd = mkdtempSync(join(tmpdir(), 'mina-proj-'));
  const parent = fakePi();
  minaHost(parent, { env, pollMs: 60_000 });
  assert.ok(parent.tools.mina_host);
  await parent.emit('session_start', {}, { cwd });
  const event = { systemPrompt: 'BASE', systemPromptOptions: { customPrompt: 'PROVIDER PREAMBLE', sections: { identity: 'ID' } } };
  const out = await parent.emit('before_agent_start', event);
  assert.equal(out?.systemPrompt, undefined, 'a returned systemPrompt would force over other layers');
  assert.match(event.systemPromptOptions.sections.host, /^## Host capabilities/);
  assert.equal(event.systemPromptOptions.sections.identity, 'ID');
  assert.equal(event.systemPromptOptions.customPrompt, 'PROVIDER PREAMBLE');
  assert.ok(existsSync(join(cwd, '.mina', 'host-capabilities.json')));
  assert.ok(b.seen.every((r) => r.grant === 'G'));
  const child = fakePi();
  minaHost(child, { env });                                   // a subagent loads it while the parent is live
  assert.deepEqual(child.tools, {});
  await parent.emit('session_shutdown');                      // a handoff: old instance down, then the new one loads
  const successor = fakePi();
  minaHost(successor, { env, pollMs: 60_000 });
  assert.ok(successor.tools.mina_host);
  await successor.emit('session_shutdown');
  await b.close();
});

test('the capability cache cannot overwrite a controller file through a project symlink', { skip: needsSandbox }, async () => {
  delete globalThis[CLAIM];
  const b = await fakeBroker((req) => req.op === 'capabilities' ? { ok: true, result: CAPS } : { ok: true, result: { pending: [] } });
  const cwd = mkdtempSync(join(tmpdir(), 'mina-host-cache-'));
  const victim = join(b.dir, 'private.json'), target = join(cwd, '.mina', 'host-capabilities.json');
  writeFileSync(victim, 'PRIVATE_CAPABILITY_CANARY'); mkdirSync(join(cwd, '.mina')); symlinkSync(victim, target);
  const originalCwd = process.cwd();
  const values = { MINA_SANDBOX: '1', MINA_SANDBOX_PROJECT: cwd, MINA_SANDBOX_WRITE: JSON.stringify([cwd]), MINA_SANDBOX_READ: '[]', MINA_SANDBOX_NET: 'offline' };
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  const pi = fakePi();
  try {
    Object.assign(process.env, values); process.chdir(cwd);
    minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile }, pollMs: 60_000 });
    await pi.emit('session_start', {}, { cwd });
    assert.equal(readFileSync(victim, 'utf8'), 'PRIVATE_CAPABILITY_CANARY');
    unlinkSync(target);
    await pi.emit('session_start', {}, { cwd });
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).mutation_protocol, WIRE);
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await pi.emit('session_shutdown'); await b.close(); rmSync(cwd, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true });
  }
});

test('alarms: put into the conversation first, acknowledged after; a pending alarm reaches the successor at session_start', async () => {
  delete globalThis[CLAIM];
  let pending = [{ id: 'a-1', label: 'beat', message: 'stale', at: 1760000000 }];
  const order = [];
  const pi = fakePi();
  const b = await fakeBroker((req) => {
    if (req.op === 'alarms' && req.ack) { order.push(`ack:${req.ack.join(',')}`); pending = []; return { ok: true, result: { pending: [], acked: req.ack } }; }
    if (req.op === 'alarms') return { ok: true, result: { pending, acked: [] } };
    return { ok: true, result: CAPS };
  });
  pi.sendMessage = (m, o) => { pi.sent.push({ m, o }); order.push(`sent:${m.details.id}`); };
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile }, pollMs: 60_000 });
  await pi.emit('session_start', {}, { cwd: mkdtempSync(join(tmpdir(), 'mina-proj-')) });
  assert.deepEqual(order, ['sent:a-1', 'ack:a-1']);
  assert.equal(pi.sent[0].o.triggerTurn, true);
  assert.match(pi.sent[0].m.content, /mina host alarm \(beat/);
  await pi.emit('session_shutdown');
  await b.close();
});

test('alarms stay pending at the broker while a handoff is under way', async () => {
  delete globalThis[CLAIM];
  const HANDOFF = Symbol.for('mina:handoff'), saved = globalThis[HANDOFF];
  let handingOff = true;
  globalThis[HANDOFF] = { pending: () => handingOff };
  const pi = fakePi();
  const b = await fakeBroker((req) => {
    if (req.op === 'alarms' && req.ack) return { ok: true, result: { pending: [], acked: req.ack } };
    if (req.op === 'alarms') return { ok: true, result: { pending: [{ id: 'a-1', label: 'beat', message: 'stale', at: 1760000000 }], acked: [] } };
    return { ok: true, result: CAPS };
  });
  pi.sendMessage = (m, o) => pi.sent.push({ m, o });
  try {
    minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile }, pollMs: 60_000 });
    const ctx = { cwd: mkdtempSync(join(tmpdir(), 'mina-proj-')) };
    await pi.emit('session_start', {}, ctx);
    assert.equal(pi.sent.length, 0);
    assert.ok(!b.seen.some((r) => r.op === 'alarms'));
    handingOff = false;                                                                    // the successor's session_start
    await pi.emit('session_start', {}, ctx);
    assert.equal(pi.sent.length, 1);
  } finally {
    if (saved === undefined) delete globalThis[HANDOFF]; else globalThis[HANDOFF] = saved;
    await pi.emit('session_shutdown'); await b.close();
  }
});

test('approval: the model cannot pass one; the user confirms, and only then is it sent', async () => {
  delete globalThis[CLAIM];
  const b = await fakeBroker((req) => {
    if (req.op !== WIRE || req.action !== 'service_restart') return { ok: true, result: CAPS };
    return req.args.approval ? { ok: true, result: { verified: true } }
      : { ok: false, error: { code: 'REQUIRES_AUTHORIZATION', message: 'needs confirmation', approval_needed: true, approval_prompt: 'Restart x?',
        approval_request: { protocol: 'mina-confirmation-v1', challenge: 'restart-token' } } };
  });
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile }, pollMs: 60_000 });
  const tool = pi.tools.mina_host;
  const noUi = await tool.execute('1', { action: 'service_restart', service: 'x', approval: { granted: true } }, null, null, { hasUI: false, cwd: tmpdir() });
  assert.equal(noUi.isError, true);
  assert.match(noUi.content[0].text, /No one can confirm/);
  assert.ok(b.seen.filter((r) => r.action === 'service_restart').every((r) => !r.args.approval), 'the model\'s approval was dropped');
  let asked = null;
  const yes = await tool.execute('2', { action: 'service_restart', service: 'x' }, null, null,
    { hasUI: true, cwd: tmpdir(), ui: { confirm: async (_t, p) => { asked = p; return true; } } });
  assert.equal(asked, 'Restart x?');
  assert.equal(yes.isError, false);
  assert.equal(b.seen.filter((r) => r.action === 'service_restart').at(-1).args.approval.by, 'user');
  await pi.emit('session_shutdown');
  await b.close();
});

test('confirmation freezes arguments, uses the versioned envelope, and keeps its token out of model output', async () => {
  delete globalThis[CLAIM];
  const b = await fakeBroker((req) => {
    const action = req.op === WIRE ? req.action : req.op;
    const args = req.op === WIRE ? req.args : req;
    if (action !== 'workload_run') return { ok: true, result: CAPS };
    return args.approval ? { ok: true, result: { started: true } } : { ok: false, error: {
      code: 'REQUIRES_AUTHORIZATION', message: 'needs confirmation', approval_needed: true, approval_prompt: 'Run fixture?',
      approval_request: { protocol: 'mina-confirmation-v1', challenge: 'private-token', request_digest: 'a'.repeat(64) },
    } };
  });
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
  try {
    const params = { action: 'workload_run', workload: 'fixture', command: ['echo', 'original'], params: { exp: 'first' } };
    const out = await pi.tools.mina_host.execute('frozen', params, null, null, { cwd: b.dir, hasUI: true, ui: {
      confirm: async () => { params.command[1] = 'changed'; params.params.exp = 'changed'; return true; },
    } });
    assert.equal(out.isError, false);
    const sent = b.seen.filter((r) => r.op !== 'capabilities');
    assert.equal(sent.length, 2);
    assert.ok(sent.every((r) => r.op === WIRE && r.action === 'workload_run'));
    assert.deepEqual(sent[1].args.command, ['echo', 'original']);
    assert.deepEqual(sent[1].args.params, { exp: 'first' });
    assert.equal(sent[1].args.approval.challenge, 'private-token');
    const headless = await pi.tools.mina_host.execute('headless', { action: 'workload_run' }, null, null, { cwd: b.dir, hasUI: false });
    assert.equal(headless.isError, true);
    assert.ok(!JSON.stringify(headless).includes('private-token'));
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('an aborted or retired confirmation cannot start work; UI consent must be boolean true', async () => {
  for (const stop of ['abort', 'retire', 'nonboolean']) {
    delete globalThis[CLAIM];
    const b = await fakeBroker((req) => req.op === WIRE
      ? req.args.approval ? { ok: true, result: { started: true } } : { ok: false, error: {
        code: 'REQUIRES_AUTHORIZATION', message: 'needs confirmation', approval_needed: true, approval_prompt: 'Run?',
        approval_request: { protocol: 'mina-confirmation-v1', challenge: 'private-token' },
      } }
      : { ok: true, result: CAPS });
    const pi = fakePi(), controller = new AbortController();
    minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
    try {
      const out = await pi.tools.mina_host.execute(stop, { action: 'workload_run' }, controller.signal, null, {
        cwd: b.dir, hasUI: true, ui: { confirm: async () => {
          if (stop === 'abort') controller.abort();
          if (stop === 'retire') await pi.emit('session_shutdown');
          return stop === 'nonboolean' ? 'yes' : true;
        } },
      });
      assert.equal(out.isError, true, stop);
      assert.equal(b.seen.filter((r) => r.op === WIRE).length, 1, stop);
    } finally { await pi.emit('session_shutdown'); await b.close(); }
  }
});

test('every broker mutation can request confirmation; declined and headless requests never carry approval', async () => {
  delete globalThis[CLAIM];
  const mutations = ['service_restart', 'reserve', 'release', 'workload_run', 'workload_stop', 'monitor_add', 'monitor_remove'];
  const b = await fakeBroker((req) => {
    if (req.op !== WIRE || !mutations.includes(req.action)) return { ok: true, result: CAPS };
    return req.args.approval?.granted === true ? { ok: true, result: { performed: req.action } }
      : { ok: false, error: { code: 'REQUIRES_AUTHORIZATION', message: 'needs confirmation', approval_needed: true, approval_prompt: `Confirm ${req.action}`,
        approval_request: { protocol: 'mina-confirmation-v1', challenge: `token-${req.action}` } } };
  });
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile }, pollMs: 60_000 });
  try {
    const tool = pi.tools.mina_host;
    let confirmations = 0;
    for (const action of mutations) {
      const out = await tool.execute(action, { action }, null, null, { cwd: b.dir, hasUI: true, ui: {
        confirm: async (_title, prompt) => { confirmations++; assert.equal(prompt, `Confirm ${action}`); return true; },
      } });
      assert.equal(out.isError, false);
      assert.equal(b.seen.filter((r) => r.action === action).at(-1).args.approval.by, 'user');
    }
    assert.equal(confirmations, mutations.length);
    for (const hasUI of [false, true]) {
      const before = b.seen.length;
      const out = await tool.execute('declined', { action: 'workload_run', approval: { granted: true } }, null, null,
        { cwd: b.dir, hasUI, ui: { confirm: async () => false } });
      assert.equal(out.isError, true);
      assert.ok(b.seen.slice(before).filter((r) => r.action === 'workload_run').every((r) => !r.args.approval));
    }
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('an old broker or an unbound challenge cannot trigger a legacy mutation fallback', async () => {
  for (const legacy of [true, false]) {
    delete globalThis[CLAIM];
    let unsafeCalls = 0, confirmations = 0;
    const b = await fakeBroker((req) => {
      if (req.op === WIRE) return legacy
        ? { ok: false, error: { code: 'INVALID', message: "unknown operation 'mutate_v2'" } }
        : { ok: false, error: { code: 'REQUIRES_AUTHORIZATION', message: 'needs confirmation', approval_needed: true, approval_prompt: 'Run?' } };
      if (req.op === 'workload_run') unsafeCalls++;
      return { ok: true, result: CAPS };
    });
    const pi = fakePi();
    minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
    try {
      const out = await pi.tools.mina_host.execute('old', { action: 'workload_run' }, null, null, {
        cwd: b.dir, hasUI: true, ui: { confirm: async () => { confirmations++; return true; } },
      });
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /safe boundary/);
      assert.equal(unsafeCalls, 0);
      assert.equal(confirmations, 0);
      assert.equal(b.seen.filter((r) => r.op === WIRE).length, 1);
    } finally { await pi.emit('session_shutdown'); await b.close(); }
  }
});

test('abort after dispatch reports the broker result without pretending to cancel or stop the job', async () => {
  delete globalThis[CLAIM];
  const controller = new AbortController();
  const b = await fakeBroker((req) => {
    if (req.op !== WIRE) return { ok: true, result: CAPS };
    controller.abort();
    return { ok: true, result: { id: 'already-started', state: 'running' } };
  });
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
  try {
    const out = await pi.tools.mina_host.execute('inflight', { action: 'workload_run' }, controller.signal, null, { cwd: b.dir });
    assert.equal(out.isError, false);
    assert.equal(out.details.result.id, 'already-started');
    assert.deepEqual(b.seen.filter((r) => r.op === WIRE).map((r) => r.action), ['workload_run']);
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('native budget status is a read and exhaustion cannot be replaced with boolean consent', async () => {
  delete globalThis[CLAIM];
  const b = await fakeBroker((req) => req.op === 'workload_budget'
    ? { ok: true, result: { coverage: 'complete', used: { admissions: 1, reserved_s: 2 }, remaining: { admissions: 0, reserved_s: 0 } } }
    : req.op === WIRE ? { ok: false, error: { code: 'REQUIRES_AUTHORIZATION', budget_exhausted: true, message: 'instance budget exhausted' } }
      : { ok: true, result: CAPS });
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
  try {
    let confirmations = 0;
    const ctx = { cwd: b.dir, hasUI: true, ui: { confirm: async () => { confirmations++; return true; } } };
    const tool = pi.tools.mina_host;
    assert.ok(tool.parameters.properties.action.enum.includes('workload_budget'));
    const status = await tool.execute('status', { action: 'workload_budget' }, null, null, ctx);
    assert.equal(status.details.result.used.admissions, 1);
    assert.equal(b.seen[0].op, 'workload_budget');
    const denied = await tool.execute('limit', { action: 'workload_run', approval: { granted: true } }, null, null, ctx);
    assert.equal(denied.isError, true);
    assert.equal(confirmations, 0);
    assert.equal(b.seen.filter((r) => r.op === WIRE).length, 1);
    assert.equal(b.seen.find((r) => r.op === WIRE).args.approval, undefined);
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('charged admission identity survives truncation of long failure diagnostics', async () => {
  delete globalThis[CLAIM];
  const b = await fakeBroker((req) => req.op === WIRE ? { ok: false, error: {
    code: 'FAILED', message: 'fixture launch timeout', diagnostic: 'x'.repeat(13_000),
    budget_charged: true, admission_id: '20261015-abcdef',
  } } : { ok: true, result: CAPS });
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
  try {
    const out = await pi.tools.mina_host.execute('charged', { action: 'workload_run' }, null, null, { cwd: b.dir, hasUI: false });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text.slice(0, 180), /20261015-abcdef.*charged/);
    assert.match(out.content[0].text, /truncated/);
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('budget-capable clients never fall back to the older mutation protocol', async () => {
  delete globalThis[CLAIM];
  let unsafe = 0;
  const b = await fakeBroker((req) => {
    if (req.op === 'mutate_v1') { unsafe++; return { ok: true, result: { started: true } }; }
    if (req.op === 'mutate_v2') return { ok: false, error: { code: 'INVALID', message: "unknown operation 'mutate_v2'" } };
    return { ok: true, result: CAPS };
  });
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
  try {
    const out = await pi.tools.mina_host.execute('old-budget', { action: 'workload_run' }, null, null, { cwd: b.dir });
    assert.equal(out.isError, true);
    assert.equal(unsafe, 0);
    assert.match(out.content[0].text, /safe boundary/);
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('an already aborted request sends no broker mutation', async () => {
  delete globalThis[CLAIM];
  const b = await fakeBroker(() => ({ ok: true, result: CAPS }));
  const pi = fakePi(), controller = new AbortController(); controller.abort();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
  try {
    const out = await pi.tools.mina_host.execute('aborted', { action: 'workload_run' }, controller.signal, null, { cwd: b.dir });
    assert.equal(out.isError, true);
    assert.equal(b.seen.length, 0);
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('no broker: request reports BLOCKED with the remediation; no profile: the extension registers nothing', async () => {
  const out = await request(join(tmpdir(), 'no-such-hostd.sock'), { op: 'ping' });
  assert.equal(out.error.code, 'BLOCKED');
  assert.match(out.error.remediation, /systemctl --user start mina-hostd/);
  delete globalThis[CLAIM];
  const pi = fakePi();
  minaHost(pi, { env: {} });
  assert.deepEqual(pi.tools, {});
});

test('sandbox: only the broker socket folder and the grant enter the outer layer; both are hidden from commands', () => {
  const env = { XDG_RUNTIME_DIR: '/run/user/4242' };
  const hp = hostPaths({ uid: 4242, env });
  const a = outerArgs({ writable: [], cwd: '/p' }, { uid: 4242, env, host: { brokerDir: '/run/user/4242/mina-hostd', grantFile: '/run/user/4242/mina-grant-x/grant' } });
  const s = a.join(' ');
  assert.ok(s.includes(`--bind /run/user/4242/mina-hostd ${hp.inside}/hostd`));
  assert.ok(s.includes(`--ro-bind /run/user/4242/mina-grant-x/grant ${hp.grant}`));
  assert.ok(!s.includes('/run/user/4242/bus'));
  const box = settings({ cwd: tmpdir(), env });
  assert.ok(box.hidden.includes(hp.inside));
  const dir = mkdtempSync(join(tmpdir(), 'mina-host-inside-'));
  assert.ok(!innerArgs({ cwd: '/p', hidden: [dir] }).includes(dir), 'outside paths are not mounted into the empty worker root');
  assert.deepEqual(hostEnv({ brokerDir: '/b', grantFile: '/g/grant' }, { sandboxed: true, uid: 4242, env }), { MINA_HOST_SOCKET: hp.socket, MINA_HOST_GRANT_FILE: hp.grant });
  assert.deepEqual(hostEnv({ unavailable: 'down' }, { sandboxed: true, env }), { MINA_HOST_UNAVAILABLE: 'down' });
  assert.deepEqual(hostEnv(null, { sandboxed: true, env }), {});
  assert.equal(readFileSync(new URL('../extensions/host/index.js', import.meta.url), 'utf8').includes('execSync'), false);
});

test('manifest: a workload line names its params, and only non-AVAILABLE lines carry a remediation', () => {
  const m = manifestText({ confirmation_protocol: 'mina-confirmation-v1', mutation_protocol: WIRE, capabilities: [
    { capability: 'workload:campaign-cell', status: 'AVAILABLE', detail: "x; resources [], max 2400s, params ['exp', 'locks'], takes command: an argv", remediation: 'never shown' },
    { capability: 'service:s:restart', status: 'REQUIRES_AUTHORIZATION', detail: 'not approved', remediation: 'set restart' }] });
  assert.match(m, /- workload:campaign-cell \(max 2400s; params exp, locks; takes a command\)\n/);
  assert.ok(!m.includes('never shown'));
  assert.match(m, /- service:s:restart: set restart/);
});

test('manifest: a list-valued param shows its allowed names', () => {
  const m = manifestText({ confirmation_protocol: 'mina-confirmation-v1', mutation_protocol: WIRE, capabilities: [{ capability: 'workload:campaign-cell', status: 'AVAILABLE',
    detail: "x, params ['exp', 'locks'], takes command: an argv; locks from GPU_A|GPU_B_PAIR|BUILD" }] });
  assert.match(m, /- workload:campaign-cell \(params exp, locks; locks: comma list of GPU_A\|GPU_B_PAIR\|BUILD; takes a command\)/);
});

test('native workload submission IDs follow tool identity, not model fields, across confirmation and retries', async () => {
  delete globalThis[CLAIM];
  const b = await fakeBroker((req) => req.op !== WIRE ? { ok: true, result: CAPS }
    : req.args.approval ? { ok: true, result: { request_id: req.args.request_id } } : { ok: false, error: {
      code: 'REQUIRES_AUTHORIZATION', message: 'confirm', approval_needed: true, approval_prompt: 'Run?',
      approval_request: { protocol: 'mina-confirmation-v1', challenge: 'secret-challenge' },
    } });
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
  const ctx = { cwd: b.dir, hasUI: true, ui: { confirm: async () => true } };
  try {
    const args = { action: 'workload_run', workload: 'fixture', request_id: 'forged', mutation_id: 'forged',
      approval: { granted: true }, grant: 'forged', op: 'forged' };
    await pi.tools.mina_host.execute('native-call', args, null, null, ctx);
    await pi.tools.mina_host.execute('native-call', args, null, null, ctx);
    await pi.tools.mina_host.execute('different-call', args, null, null, ctx);
    const sent = b.seen.filter((r) => r.op === WIRE);
    assert.equal(sent.length, 6);
    assert.match(sent[0].args.request_id, /^wl-[0-9a-f]{64}$/);
    assert.ok(sent.slice(0, 4).every((r) => r.args.request_id === sent[0].args.request_id));
    assert.notEqual(sent[4].args.request_id, sent[0].args.request_id);
    await pi.tools.mina_host.execute('native-call', args, null, null, { ...ctx, sessionManager: { getSessionId: () => 'successor-session' } });
    assert.notEqual(b.seen.filter((r) => r.op === WIRE).at(-1).args.request_id, sent[0].args.request_id,
      'a successor can receive a reused provider tool ID without replaying a different session submission');
    assert.ok(sent.every((r) => r.request_protocol === 'mina-workload-request-v1'));
    assert.ok(sent.every((r) => !r.args.mutation_id && !r.args.grant && !r.args.op));
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('transport timeout and lost connection preserve workload identity and do not imply cancellation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mina-receipt-test-'));
  const socket = join(dir, 'sock');
  for (const drop of [false, true]) {
    const server = createServer((c) => c.on('data', () => { if (drop) c.end(); }));
    await new Promise((r) => server.listen(socket, r));
    try {
      const out = await request(socket, { op: WIRE, action: 'workload_run', args: { request_id: 'wl-native' }, grant: 'bearer-secret' }, { timeoutMs: 20 });
      assert.equal(out.error.request_id, 'wl-native');
      assert.equal(out.error.outcome, 'unknown');
      assert.match(out.error.message, /workload_status/);
      assert.ok(!JSON.stringify(out).includes('bearer-secret'));
      assert.ok(!/cancelled|canceled/.test(out.error.message));
    } finally { await new Promise((r) => server.close(r)); }
  }
});


test('a budget-capable broker without receipt support rejects the marked envelope; no legacy submission follows', async () => {
  delete globalThis[CLAIM];
  const b = await fakeBroker((req) => req.op === WIRE
    ? { ok: false, error: { code: 'INVALID', message: 'invalid versioned mutation envelope' } }
    : { ok: true, result: CAPS });
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile } });
  try {
    const out = await pi.tools.mina_host.execute('old-receipts', { action: 'workload_run' }, null, null, { cwd: b.dir });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /safe boundary/);
    assert.match(out.details.error.request_id, /^wl-/);
    const mutations = b.seen.filter((r) => r.op !== 'capabilities');
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].request_protocol, 'mina-workload-request-v1');
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

// --- host policy: policy_propose, inventory, unregistered projects -------------------------------------------------

const POLICY_CAPS = { ...CAPS, policy_protocol: 'mina-policy-v1', registered: true };
const UNREG_CAPS = { confirmation_protocol: 'mina-confirmation-v1', mutation_protocol: WIRE, policy_protocol: 'mina-policy-v1', registered: false,
  capabilities: [{ capability: 'project', status: 'REQUIRES_AUTHORIZATION', detail: 'not registered', remediation: 'Add it' },
    { capability: 'inventory', status: 'AVAILABLE', detail: 'the GPUs' },
    { capability: 'policy_propose', status: 'REQUIRES_AUTHORIZATION', detail: 'propose a registration' }] };

test('mina_host lists inventory and policy_propose; policy_propose is a mutation with changes and reason', async () => {
  delete globalThis[CLAIM];
  const b = await fakeBroker((req) => (req.op === 'inventory' ? { ok: true, result: { devices: [] } } : { ok: true, result: POLICY_CAPS }));
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile }, pollMs: 60_000 });
  try {
    const tool = pi.tools.mina_host;
    for (const a of ['inventory', 'policy_propose']) assert.ok(tool.parameters.properties.action.enum.includes(a), a);
    assert.equal(tool.parameters.properties.changes.type, 'array');
    assert.equal(tool.parameters.properties.reason.maxLength, 500);
    assert.match(tool.description, /policy_propose \(propose a change to the host policy/);
    assert.match(tool.description, /inventory \(read-only/);
    const inv = await tool.execute('i', { action: 'inventory' }, null, null, { cwd: b.dir, hasUI: false });
    assert.equal(inv.isError, false);
    assert.deepEqual(b.seen.at(-1), { op: 'inventory', grant: 'G' }, 'inventory is a read, not a mutation');
    await tool.execute('p', { action: 'policy_propose', changes: [{ kind: 'project_register' }], reason: 'GPUs' }, null, null, { cwd: b.dir, hasUI: false });
    const sent = b.seen.find((r) => r.action === 'policy_propose');
    assert.deepEqual(sent, { op: WIRE, action: 'policy_propose', grant: 'G', args: { changes: [{ kind: 'project_register' }], reason: 'GPUs' } });
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('an unregistered project with a policy-capable broker gets a one-line manifest; an older broker the full one', async () => {
  assert.equal(manifestText(UNREG_CAPS), UNREGISTERED_MANIFEST);
  assert.equal(UNREGISTERED_MANIFEST.trim().split('\n').length, 1);
  assert.match(UNREGISTERED_MANIFEST, /^Host broker: this project is not registered\. .*mina_host inventory .*mina_host policy_propose asks the user to approve a registration\.$/m);
  const old = { ...UNREG_CAPS, policy_protocol: undefined };
  assert.match(manifestText(old), /^## Host capabilities/);
  assert.match(manifestText(POLICY_CAPS), /^## Host capabilities[^]*REQUIRES AUTHORIZATION:/);
  // An old-protocol broker cannot have policy_propose shown as usable.
  const legacy = manifestText({ capabilities: [{ capability: 'policy_propose', status: 'REQUIRES_AUTHORIZATION', detail: 'x' }] });
  assert.match(legacy, /BLOCKED:\n- policy_propose/);
  delete globalThis[CLAIM];
  const b = await fakeBroker(() => ({ ok: true, result: UNREG_CAPS }));
  const pi = fakePi();
  minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile }, pollMs: 60_000 });
  try {
    await pi.emit('session_start', {}, { cwd: b.dir });
    const event = { systemPromptOptions: {} };
    await pi.emit('before_agent_start', event);
    assert.equal(event.systemPromptOptions.sections.host, UNREGISTERED_MANIFEST);
  } finally { await pi.emit('session_shutdown'); await b.close(); }
});

test('policy_propose dialog: the user sees the whole broker prompt; only a confirmed retry carries the approval', async () => {
  delete globalThis[CLAIM];
  const diff = Array.from({ length: 50 }, (_, i) => `+ "w${i}": {"argv": ["/usr/bin/tool-${i}"], "max_s": 5}`).join('\n');
  const prompt = `Change the host policy (/home/you/.config/mina/host.json) for the Mina session of /home/you/work/proj?\n\n`
    + `The agent's reason (the agent's words, not examined):\n  needs tools\n\nRisk flags:\n  ! workload "w1" runs without the broker's sandbox\n\nDiff:\n${diff}`;
  const b = await fakeBroker((req) => {
    if (req.op !== WIRE) return { ok: true, result: POLICY_CAPS };
    return req.args.approval?.granted === true ? { ok: true, result: { written: true, diff_sha256: 'd'.repeat(64), flags: [] } }
      : { ok: false, error: { code: 'REQUIRES_AUTHORIZATION', message: 'needs confirmation', approval_needed: true, approval_prompt: prompt,
        approval_request: { protocol: 'mina-confirmation-v1', challenge: 'policy-token' } } };
  });
  try {
    for (const [rows, tall] of [[200, false], [30, true], [undefined, false]]) {
      delete globalThis[CLAIM];
      const pi = fakePi();
      minaHost(pi, { env: { MINA_HOST_SOCKET: b.socket, MINA_HOST_GRANT_FILE: b.grantFile }, pollMs: 60_000, terminal: { rows, columns: 100 } });
      const asked = [], notes = [];
      const ui = { confirm: async (title, message) => { asked.push({ title, message }); return true; }, notify: (m, t) => notes.push({ m, t }) };
      const before = b.seen.length;
      const out = await pi.tools.mina_host.execute('pp', { action: 'policy_propose', changes: [{ kind: 'workload_set' }], reason: 'needs tools',
        approval: { granted: true, challenge: 'forged' } }, null, null, { cwd: b.dir, hasUI: true, ui });
      assert.equal(out.isError, false, out.content[0].text);
      assert.equal(asked.length, 1);
      assert.equal(asked[0].message, prompt, 'the dialog gets the whole prompt, unchanged');
      assert.equal(asked[0].title.startsWith('mina host: change the host policy'), true);
      assert.equal(/long: scroll up/.test(asked[0].title), tall, `rows ${rows}`);
      assert.equal(notes.length, tall ? 1 : 0, 'a prompt taller than the terminal is also put into the chat in full');
      if (tall) { assert.ok(notes[0].m.endsWith(prompt)); assert.equal(notes[0].t, 'warning'); }
      const sent = b.seen.slice(before).filter((r) => r.action === 'policy_propose');
      assert.equal(sent.length, 2);
      assert.equal(sent[0].args.approval, undefined, 'the model\'s approval is dropped');
      assert.deepEqual([sent[1].args.approval.challenge, sent[1].args.approval.by], ['policy-token', 'user']);
      assert.ok(!JSON.stringify(out.content).includes('policy-token'));
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(b.seen.slice(before).some((r) => r.op === 'capabilities'), 'the capabilities are refreshed after a change');
      await pi.emit('session_shutdown');
    }
    assert.ok(wrappedLines(prompt, 100) + 1 + DIALOG_CHROME_LINES > 30);
    assert.equal(wrappedLines('a'.repeat(250), 102), 3);
  } finally { await b.close(); }
});

test('Pi renders a long confirmation message in full: wrapped, nothing cut', async () => {
  const base = '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive';
  const { initTheme } = await import(`${base}/theme/theme.js`);
  const { ExtensionSelectorComponent } = await import(`${base}/components/extension-selector.js`);
  initTheme('dark');
  const prompt = Array.from({ length: 70 }, (_, i) => `+ "w${i}": "${'x'.repeat(i * 3)}"`).join('\n');
  // interactive-mode.js showExtensionConfirm: showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], ...)
  const src = readFileSync(new URL(`${base}/interactive-mode.js`, import.meta.url), 'utf8');
  assert.match(src, /showExtensionSelector\(`\$\{title\}\\n\$\{message\}`, \["Yes", "No"\]/);
  for (const width of [40, 80, 200]) {
    const c = new ExtensionSelectorComponent(`mina host: change the host policy\n${prompt}`, ['Yes', 'No'], () => {}, () => {});
    const lines = c.render(width).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.ok(lines.every((l) => [...l].length <= width), `width ${width}`);
    assert.ok(lines.join('').replace(/\s/g, '').includes(prompt.replace(/\s/g, '')), `width ${width}: the whole prompt`);
  }
});

test('openHostSession: an unregistered project gets a session only from a policy-capable broker; MINA_HOST=0 is off', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'mina-runtime-'));
  let result = { registered: false, grant: 'G1', session: 's1', policy_protocol: POLICY_PROTOCOL };
  const b = await fakeBroker((req) => (req.op === 'session_open' ? { ok: true, result } : { ok: false, error: { code: 'INVALID', message: 'x' } }));
  const env = { MINA_HOSTD_RUNTIME: b.dir, XDG_RUNTIME_DIR: runtime, MINA_HOST_CONFIG: join(runtime, 'none.json') };
  try {
    const host = await openHostSession('/home/you/work/new', env, { uid: 4242 });
    assert.equal(host.session, 's1');
    assert.equal(readFileSync(host.grantFile, 'utf8'), 'G1\n');
    assert.deepEqual(b.seen.at(-1).op, 'session_open');
    result = { registered: false, grant: 'G2', session: 's2' };                    // an older broker
    assert.equal(await openHostSession('/home/you/work/new', env, { uid: 4242 }), null);
    assert.equal((await openHostSession('/home/you/work/new', { ...env, MINA_HOST: '1' }, { uid: 4242 })).session, 's2');
    const n = b.seen.length;
    assert.equal(await openHostSession('/home/you/work/new', { ...env, MINA_HOST: '0' }, { uid: 4242 }), null);
    assert.equal(b.seen.length, n, 'MINA_HOST=0 sends nothing');
  } finally { await b.close(); rmSync(runtime, { recursive: true, force: true }); }
});

test('the host policy folder is never writable for the agent: not in the outer layer\'s binds, read-only in a real sandbox', { skip: needsSandbox }, () => {
  // Read-only checks of the real path: the bind list, and access(2) through `test -w`. Nothing is written there.
  const home = homedir();
  const policyDir = join(home, '.config', 'mina');
  const project = mkdtempSync(join(tmpdir(), 'mina-policy-sandbox-'));
  try {
    const scratch = mkdtempSync(join(tmpdir(), 'mina-rt-'));
    const env = { XDG_RUNTIME_DIR: scratch, PI_CODING_AGENT_DIR: join(scratch, 'agent') };
    const s = settings({ cwd: project, env, config: {} });
    const args = outerArgs(s, { env });
    const binds = args.flatMap((a, i) => (a === '--bind' ? [args[i + 1]] : []));
    const under = (root, p) => p === root || p.startsWith(`${root}/`);
    assert.ok(!binds.some((b) => under(b, join(policyDir, 'host.json'))), `writable binds: ${binds.join(' ')}`);
    assert.ok(!s.writable.some((w) => under(w, policyDir)));
    let probe = policyDir;
    while (!existsSync(probe)) probe = dirname(probe);              // the nearest folder that exists
    const r = spawnSync(BWRAP_PATH, [...args, '--', '/bin/sh', '-c', 'for d; do if test -w "$d"; then echo "$d writable"; else echo "$d read-only"; fi; done', 'sh', probe, project],
      { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${probe} read-only\n${project} writable\n`);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
