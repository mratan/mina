// Turn limits: a role's max_turns is a ceiling that a call can lower but never raise. A request the ceiling reduces, or a
// max_turns on a resume (which keeps its first limit), is disclosed in the receipt instead of being dropped silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import delegates from '../extensions/delegates/index.js';
import { fixture, body, fauxAssistantMessage } from './delegates-fixture.mjs';
import { needsSandbox } from './capabilities.mjs';

const CAPPED = { '.pi/agents/capped.md': '---\nname: capped\ntools: read\nmax_turns: 3\n---\nWork.' };
const done = () => fauxAssistantMessage('done');

test('provider length cutoff fails the child, preserves partial text, and can resume the same child', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('Partial report…', { stopReason: 'length' }),
    (ctx) => {
      assert.ok(ctx.messages.some((m) => m.role === 'assistant' && m.content.some((c) => c.text === 'Partial report…')));
      return done();
    }]);
  try {
    const a = body(await f.call('Agent', { prompt: 'x', description: 'x' }));
    const cut = body(await f.call('get_subagent_result', { agent_id: a.id, wait: true }));
    assert.equal(cut.status, 'failed');
    assert.equal(cut.stopReason, 'length');
    assert.match(cut.error, /output limit/);
    assert.match(cut.error, /resume/);
    assert.equal(cut.result, 'Partial report…');
    assert.equal(f.faux.state.callCount, 1, 'no automatic retry');
    const resumed = body(await f.call('Agent', { prompt: 'finish', description: 'x', resume: a.id, run_in_background: false }));
    assert.equal(resumed.id, a.id);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.stopReason, 'stop');
    assert.equal(resumed.result, 'done');
    assert.equal(resumed.turns, 2, 'resume does not reset the turn count');
  } finally { await f.shutdown(); }
});

test('a thinking-only cutoff does not reuse a previous report, and an exhausted child cannot resume', { skip: needsSandbox }, async () => {
  const f = await fixture([done(), fauxAssistantMessage({ type: 'thinking', thinking: 'unfinished' }, { stopReason: 'length' })]);
  try {
    const a = body(await f.call('Agent', { prompt: 'x', description: 'x', task_id: 'review', max_turns: 2, run_in_background: false }));
    const cut = body(await f.call('Agent', { prompt: 'continue', description: 'x', resume: a.id, run_in_background: false }));
    assert.equal(cut.status, 'failed');
    assert.equal(cut.result, '');
    assert.match(cut.error, /No turns remain.*task_id: "review"/);
    await f.reject('Agent', { prompt: 'continue', description: 'x', resume: a.id }, /no turns remaining.*task_id: "review"/i);
    const summary = body(await f.call('get_subagent_result', { agent_id: a.id, summary_only: true }));
    assert.equal(summary.revision, cut.revision, 'the refused resume does not replace the cutoff record');
    assert.equal(summary.stopReason, 'length');
    assert.equal(f.faux.state.callCount, 2);
  } finally { await f.shutdown(); }
});

test('the Agent schema says max_turns is capped by the role', () => {
  const tools = {};
  delegates({ events: new EventEmitter(), registerTool: (t) => { tools[t.name] = t; }, on: () => {}, appendEntry: () => {} },
    { env: { MINA_INSTANCE_ID: 'schema-probe' } });
  const d = tools.Agent.parameters.properties.max_turns.description;
  assert.match(d, /ceiling/);
  assert.match(d, /default 100/);
  assert.match(d, /never raise/);
  assert.match(d, /resumed child keeps/);
});

test('a request above the role ceiling runs at the ceiling and the receipt says so', { skip: needsSandbox }, async () => {
  const f = await fixture([done()], { files: CAPPED });
  try {
    const out = await f.call('Agent', { prompt: 'x', description: 'x', subagent_type: 'capped', max_turns: 200, run_in_background: false });
    const b = body(out);
    assert.equal(b.maxTurns, 3);
    assert.equal(b.requestedMaxTurns, 200);
    assert.match(b.maxTurnsNote, /max_turns 200 was reduced to 3/);
    assert.match(b.maxTurnsNote, /max_turns in its role file/);
    assert.match(b.maxTurnsNote, /never raise/);
    const record = f.state.branch.find((e) => e.customType === 'subagents:record').data;
    assert.equal(record.requestedMaxTurns, 200);
    assert.equal(record.maxTurnsNote, b.maxTurnsNote);
  } finally { await f.shutdown(); }
});

test('a request within the ceiling is honored without a note', { skip: needsSandbox }, async () => {
  const f = await fixture([done()], { files: CAPPED });
  try {
    const b = body(await f.call('Agent', { prompt: 'x', description: 'x', subagent_type: 'capped', max_turns: 2, run_in_background: false }));
    assert.equal(b.maxTurns, 2);
    assert.equal(b.requestedMaxTurns, undefined);
    assert.equal(b.maxTurnsNote, undefined);
  } finally { await f.shutdown(); }
});

test('a role file without max_turns caps at the default of 100 and names it', { skip: needsSandbox }, async () => {
  const f = await fixture([done()]);
  try {
    const b = body(await f.call('Agent', { prompt: 'x', description: 'x', max_turns: 200, run_in_background: false }));
    assert.equal(b.maxTurns, 100);
    assert.equal(b.requestedMaxTurns, 200);
    assert.match(b.maxTurnsNote, /reduced to 100/);
    assert.match(b.maxTurnsNote, /default/);
  } finally { await f.shutdown(); }
});

test('a role above the 200-turn maximum is capped at 200 and says why', { skip: needsSandbox }, async () => {
  const f = await fixture([done()], { files: { '.pi/agents/big.md': '---\nname: big\ntools: read\nmax_turns: 500\n---\nWork.' } });
  try {
    const b = body(await f.call('Agent', { prompt: 'x', description: 'x', subagent_type: 'big', max_turns: 300, run_in_background: false }));
    assert.equal(b.maxTurns, 200);
    assert.match(b.maxTurnsNote, /200-turn maximum/);
  } finally { await f.shutdown(); }
});

test('max_turns on a resume is disclosed as ignored, and a later resume clears the note', { skip: needsSandbox }, async () => {
  const f = await fixture([done(), done(), done()], { files: CAPPED });
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'x', subagent_type: 'capped', max_turns: 3, run_in_background: false });
    const r1 = body(await f.call('Agent', { prompt: 'more', description: 'x', resume: a.details.id, max_turns: 50, run_in_background: false }));
    assert.equal(r1.maxTurns, 3);
    assert.equal(r1.requestedMaxTurns, 50);
    assert.match(r1.maxTurnsNote, /resumed child keeps the turn limit of its first launch \(3/);
    const r2 = body(await f.call('Agent', { prompt: 'more', description: 'x', resume: a.details.id, run_in_background: false }));
    assert.equal(r2.requestedMaxTurns, undefined);
    assert.equal(r2.maxTurnsNote, undefined);
  } finally { await f.shutdown(); }
});
