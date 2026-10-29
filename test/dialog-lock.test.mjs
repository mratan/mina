import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oneDialog, serialUi } from '../lib/dialog-lock.mjs';
import minaSandbox from '../extensions/sandbox/index.js';
import { createMinaGoal } from '../extensions/goal/mina-goal.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pi's single dialog slot (pi 1.3.0): a dialog opened while another is shown hides it, and the hidden one never settles.
function piSlot({ answer = (kind, args) => (kind === 'select' ? args[1][0] : true), ms = 15 } = {}) {
  const log = { order: [], overlaps: 0 };
  let open = null;
  const show = (kind) => (...args) => {
    if (open) { log.overlaps++; open.orphaned = true; }
    const me = { orphaned: false };
    open = me;
    log.order.push(kind === 'select' || kind === 'confirm' ? String(args[0]).split('\n')[0] : kind);
    return new Promise((resolve) => setTimeout(() => { if (open === me) open = null; if (!me.orphaned) resolve(answer(kind, args)); }, ms));
  };
  const ui = { notify: () => {}, setWidget: () => {}, select: show('select'), confirm: show('confirm'), input: show('input'), editor: show('editor') };
  return { ui, log };
}

test('oneDialog: one flow at a time in arrival order; a failing flow releases the lock', async () => {
  let open = 0, most = 0;
  const order = [];
  const flow = (name, fail) => oneDialog(async () => {
    open++; most = Math.max(most, open); order.push(name); await sleep(10); open--;
    if (fail) throw new Error('dialog failed');
    return name;
  });
  const results = await Promise.allSettled([flow('a'), flow('b', true), flow('c')]);
  assert.deepEqual(results.map((r) => r.value ?? r.reason.message), ['a', 'dialog failed', 'c']);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(most, 1);
});

test('oneDialog: a flow opens its later dialogs without waiting for itself; a stale context from an ended flow waits', async () => {
  const order = [];
  let late;
  await oneDialog(async () => {
    order.push('outer');
    assert.equal(await oneDialog(async () => 'inner'), 'inner');                   // reentrant, no deadlock
    late = new Promise((r) => setTimeout(() => r(oneDialog(async () => order.push('late'))), 20));   // inherits the context
  });
  const other = oneDialog(async () => { order.push('other start'); await sleep(40); order.push('other end'); });
  await Promise.all([late, other]);
  assert.deepEqual(order, ['outer', 'other start', 'other end', 'late']);
});

test('oneDialog: an abort while waiting returns undefined without running; the line keeps moving; the lock is not stolen at hand-over', async () => {
  const ac = new AbortController();
  const ran = [];
  let open = 0, most = 0;
  const hold = (name, ms) => async () => { open++; most = Math.max(most, open); ran.push(name); await sleep(ms); open--; return name; };
  const first = oneDialog(hold('first', 20));
  const aborted = oneDialog(hold('aborted', 1), ac.signal);
  const third = oneDialog(hold('third', 1)).then(async (v) => v);
  ac.abort();
  assert.equal(await aborted, undefined);
  await first;
  const newcomer = oneDialog(hold('newcomer', 1));                                 // arrives right as third is woken
  assert.deepEqual([await third, await newcomer], ['third', 'newcomer']);
  assert.deepEqual(ran, ['first', 'third', 'newcomer']);
  assert.equal(most, 1);
  assert.equal(await oneDialog(hold('x', 1), AbortSignal.abort()), undefined);   // already aborted: never runs
});

test('serialUi: dialog methods take the lock; everything else passes through', async () => {
  const { ui, log } = piSlot();
  let notes = 0;
  const ctx = { get cwd() { return '/p'; }, hasUI: true, ui: { ...ui, notify: () => { notes++; } } };
  const s = serialUi(ctx);
  assert.equal(s.cwd, '/p');
  s.ui.notify('x');
  assert.equal(notes, 1);
  const answers = await Promise.all([s.ui.confirm('one', 'm'), s.ui.select('two', ['b']), oneDialog(() => ui.input('three'))]);
  assert.deepEqual(answers, [true, 'b', true]);
  assert.equal(log.overlaps, 0);
});

test('extensions share the lock: a sandbox request, a question to the user and /goal from pi-goal never open two dialogs', { timeout: 5000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), 'mina-dialog-project-'));
  const data = mkdtempSync(join(tmpdir(), 'mina-dialog-data-'));
  const env = { MINA_SANDBOX: '1', MINA_SANDBOX_PROJECT: project, MINA_SANDBOX_WRITE: JSON.stringify([project]), MINA_SANDBOX_READ: '[]',
    MINA_SANDBOX_HIDE: '[]', MINA_SANDBOX_NET: 'offline', MINA_SANDBOX_PRIVATE: '[]', MINA_INSTANCE_ID: `dialog-${project}` };
  const tools = {}, commands = {};
  const pi = { on: () => {}, registerTool: (t) => { tools[t.name] = t; }, registerCommand: (n, o) => { commands[n] = o; },
    appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ code: 0, stdout: '', stderr: '' }) };
  minaSandbox(pi, { env, available: true, grantWaitMs: 1000 });
  const upstream = [];
  const fakeGoal = (api) => api.registerCommand('goal', { description: 'upstream', handler: async (args, ctx) => {
    upstream.push(await ctx.ui.confirm('Replace goal?', args));                    // pi-goal's own dialog
  } });
  createMinaGoal(pi, { goalExtension: fakeGoal, env, sandboxAvailable: true });
  const { ui, log } = piSlot();
  const ctx = { cwd: project, hasUI: true, ui };
  const ask = { question: 'Which arm?', options: [{ label: 'A' }, { label: 'B' }], recommended: 0, why: 'cheaper' };
  const [read, answer] = await Promise.all([
    tools.mina_sandbox_request.execute('r', { path: data, reason: 'inputs' }, undefined, null, ctx),
    tools.mina_ask_user.execute('q', ask, undefined, null, ctx),
    commands.goal.handler('pass three', ctx),
  ]);
  assert.equal(log.overlaps, 0, log.order.join(' | '));
  assert.equal(log.order.length, 3);
  assert.match(read.content[0].text, /allowed/);
  assert.match(answer.content[0].text, /1\. A/);
  assert.deepEqual(upstream, [true]);
});
