import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDecisionStore, instanceDecisions } from '../lib/instance-decisions.mjs';
import { operatorProcedure, validateOperatorAction } from '../extensions/goal/ask.mjs';

const action = () => ({ option_index: 0, target: 'fixture / stable-device-id', effect: 'Change fixture mode; no live device', reason: 'Operator privilege required',
  preconditions: ['Device idle'], commands: 'printf "action\\n"', expected_output: 'Paste output and readback', stop_on_error: 'Stop and return the error',
  restoration: { when: 'After the owned job ends', commands: 'printf "restore\\n"' } });
const scope = () => ({ project: '/fixture', question: 'Do the manual step?', options: [{ label: 'I will do it' }, { label: 'Stop' }], recommended: 0, operator_action: action() });
const answer = '1. I will do it (recommended)';

test('the pinned Pi loader accepts native question and operator schemas', async () => {
  const { loadExtensions } = await import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
  const { validateToolArguments } = await import('../node_modules/@earendil-works/pi-ai/dist/utils/validation.js');
  const cwd = mkdtempSync(join(tmpdir(), 'mina-question-loader-'));
  try {
    const loaded = await loadExtensions([resolve('extensions/goal/index.js')], cwd);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    assert.ok(extension.commands.has('goal'));
    const tool = extension.tools.get('mina_ask_user').definition;
    const args = { request_id: 'operator-step', ...scope(), why: 'Only the operator has authority.' };
    delete args.project;
    assert.ok(validateToolArguments(tool, { name: tool.name, arguments: args }).operator_action);
    assert.throws(() => validateToolArguments(tool, { name: tool.name, arguments: { ...args, operator_action: { ...action(), commands: undefined } } }));
    assert.ok(extension.tools.has('mina_operator_status'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('concurrent identical requests share one interaction and one native receipt', async () => {
  const store = createDecisionStore();
  let calls = 0, persisted = 0, release;
  const wait = new Promise((r) => { release = r; });
  const ask = async () => { calls++; await wait; return answer; };
  const first = store.ask('setup', scope(), ask, () => persisted++);
  const second = store.ask('setup', scope(), ask, () => persisted++);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(persisted, 1);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(a.record.operatorStatus, 'awaiting_execution');
  assert.equal(store.get('setup').status, 'answered');
});

test('closed dialogs and UI errors do not grant an answer or prevent a later decision', async () => {
  const store = createDecisionStore();
  await store.ask('setup', scope(), async () => undefined);
  assert.equal(store.get('setup').status, 'pending');
  await assert.rejects(store.ask('setup', scope(), async () => { throw new Error('UI disconnected'); }), /UI disconnected/);
  const result = await store.ask('setup', scope(), async () => answer);
  assert.equal(result.reused, false);
  assert.equal(result.record.answer, answer);
});

test('identity includes complete scope, is independent of key order, and cannot silently broaden a decision', async () => {
  const store = createDecisionStore();
  const spec = scope();
  await store.ask('setup', spec, async () => answer);
  const reordered = Object.fromEntries(Object.entries(spec).reverse());
  assert.equal((await store.ask('setup', reordered, () => assert.fail('already answered'))).reused, true);
  await assert.rejects(store.ask('setup', { ...spec, project: '/another-project' }, async () => answer), /different decision/);
  await assert.rejects(store.ask('setup', { ...spec, operator_action: { ...spec.operator_action, commands: 'new command' } }, async () => answer), /different decision/);
  const exported = store.get('setup'); exported.answer = 'forged';
  assert.equal(store.get('setup').answer, answer);
});

test('instance state survives factory replacement; new instances and recovered history cannot reuse approvals', async () => {
  const id = randomUUID(), store = instanceDecisions(id);
  await store.ask('setup', scope(), async () => answer);
  assert.equal(instanceDecisions(id), store);
  const fresh = instanceDecisions(randomUUID());
  fresh.recover(store.snapshot());
  assert.equal(fresh.get('setup'), null);
  assert.equal(fresh.operators()[0].historical, true);
  let asked = 0;
  await fresh.ask('setup', scope(), async () => { asked++; return answer; });
  assert.equal(asked, 1);
  assert.equal(fresh.operators().length, 2, 'a new request must not discard an old restoration record with the same id');
  assert.notEqual(instanceDecisions(), instanceDecisions());
  fresh.recover({ records: {}, recovered: 'invalid' });
});

test('operator output reports cannot grant authority or claim independent verification', async () => {
  const store = createDecisionStore();
  await store.ask('setup', scope(), async () => answer);
  assert.throws(() => store.reportOperator('setup', 'verified', 'looks right'), /Give output_received/);
  assert.throws(() => store.reportOperator('setup', 'output_received', ''), /supporting evidence/);
  assert.throws(() => store.reportOperator('missing', 'output_received', 'output'), /No accepted operator action/);
  const report = store.reportOperator('setup', 'output_received', 'Readback pasted in the conversation');
  assert.equal(report.operatorReport.verified, false);
  assert.equal(report.operatorReport.by, 'agent');
  assert.equal(report.answer, answer);
  assert.ok(report.scope.operator_action.restoration, 'receiving setup output does not erase restoration instructions');
});

test('operator instructions require complete fields, reject terminal controls, and preserve exact command text', () => {
  validateOperatorAction(action(), 2);
  assert.throws(() => validateOperatorAction({ ...action(), commands: '' }, 2), /commands/);
  assert.throws(() => validateOperatorAction({ ...action(), restoration: undefined }, 2), /restoration/);
  assert.throws(() => validateOperatorAction({ ...action(), option_index: 2 }, 2), /option_index/);
  assert.throws(() => validateOperatorAction({ ...action(), commands: '\x1b[2J' }, 2), /control characters/);
  const p = { ...action(), commands: 'printf "```\\n"\n# exact second line' };
  const text = operatorProcedure(p);
  assert.ok(text.includes(p.commands));
  assert.match(text, /````sh\n/);
  assert.match(text, /Restoration — later, not now/);
  validateOperatorAction({ ...action(), restoration: null }, 2);
});
