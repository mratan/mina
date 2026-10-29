import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import delegates from '../extensions/delegates/index.js';
import { renderAgentCall, renderAgentResult, renderChildCall, renderChildResult } from '../extensions/delegates/ui.mjs';
import { needsSandbox } from './capabilities.mjs';

const theme = new Proxy({}, { get: (_t, key) => (key === 'fg' || key === 'bg' ? (_c, s) => s : key === 'getBgAnsi' ? undefined : (...a) => a.at(-1) ?? '') });
const tui = { terminal: { columns: 120, rows: 40 }, requestRender() {} };
const lines = (component) => component.render(120).map((l) => l.trimEnd()).join('\n');

// pi's ctx.ui, recording widgets, statuses, notifications, input handlers and overlays.
function fakeUI() {
  const widgets = new Map(), status = new Map(), notes = [], overlays = [];
  let input;
  const ui = {
    setWidget: (key, factory, options) => (factory ? widgets.set(key, { factory, options }) : widgets.delete(key)),
    setStatus: (key, text) => (text === undefined ? status.delete(key) : status.set(key, text)),
    onTerminalInput: (handler) => { input = handler; return () => { input = undefined; }; },
    getEditorText: () => '',
    notify: (message, level) => notes.push([message, level]),
    custom: (factory) => new Promise((resolve) => { overlays.push(factory(tui, theme, undefined, resolve)); }),
  };
  const render = (key) => { const w = widgets.get(key); return w ? w.factory(tui, theme).render(120).join('\n') : null; };
  return { ui, widgets, status, notes, overlays, render, key: (data) => input?.(data) };
}

async function fixture(responses) {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-ui-project-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'mina-ui-controller-'));
  const env = { PI_CODING_AGENT_DIR: agentDir, MINA_INSTANCE_ID: cwd, MINA_SANDBOX_PROJECT: cwd,
    MINA_SANDBOX_WRITE: JSON.stringify([cwd]), MINA_SANDBOX_NET: 'offline' };
  const faux = fauxProvider(); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ agentDir, modelsPath: null });
  runtime.registerNativeProvider(faux.provider);
  const tools = {}, handlers = {}, entries = [], events = new EventEmitter();
  const pi = { events, registerTool: (t) => { tools[t.name] = t; }, on: (e, h) => { handlers[e] = h; }, appendEntry: (type, data) => entries.push({ type, data }) };
  delegates(pi, { env });
  const view = fakeUI();
  const ctx = { cwd, model: faux.getModel(), modelRegistry: new ModelRegistry(runtime), tools: [], thinkingLevel: 'off', hasUI: true, ui: view.ui };
  return { tools, ctx, view, events, handlers, shutdown: async () => { await handlers.session_shutdown(); rmSync(cwd, { recursive: true }); rmSync(agentDir, { recursive: true }); } };
}

const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(check()); };

test('a background child shows in the agent list, status bar and fleet, and the viewer steers and stops it', { skip: needsSandbox }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let seen;
  const f = await fixture([async (context) => { seen = context; await gate; return fauxAssistantMessage('late'); }]);
  try {
    const out = await f.tools.Agent.execute('bg', { prompt: 'Long work.', description: 'QEXC \u001b[31mbaseline', subagent_type: 'delegate' }, null, null, f.ctx);
    assert.equal(out.details.background, true);
    assert.doesNotMatch(out.content[0].text, /background"|lifetimeUsage|startedAt/, 'display detail stays out of the model text');
    await until(() => seen);
    assert.equal(f.view.status.get('subagents'), '1 running agent');
    const list = f.view.render('agents');
    assert.match(list, /Agents/);
    assert.match(list, /delegate {2}QEXC baseline/);
    assert.match(list, /↻1≤100/);
    assert.doesNotMatch(list, /\u001b/);
    assert.equal(f.view.widgets.get('agents').options.placement, 'aboveEditor');
    assert.match(f.view.render('fleet'), /● main[\s\S]*delegate {2}QEXC baseline/);

    // ↓ at an empty prompt enters the fleet, ↓ selects the child, Enter opens its conversation.
    assert.deepEqual(f.view.key('\u001b[B'), { consume: true });
    f.view.key('\u001b[B');
    f.view.key('\r');
    await until(() => f.view.overlays.length === 1);
    const viewer = f.view.overlays[0];
    assert.match(viewer.render(100).join('\n'), /Long work\./);

    // Enter composes a steer; the runtime queues it on the live child.
    viewer.handleInput('\r');
    for (const ch of 'focus on timing') viewer.handleInput(ch);
    viewer.handleInput('\r');
    const steered = (await f.tools.get_subagent_result.execute('r', { agent_id: out.details.id }));
    assert.equal(steered.details.status, 'running');

    // x twice stops it; partial work is kept and the list shows it stopped.
    viewer.handleInput('x');
    viewer.handleInput('x');
    release();
    const done = await f.tools.get_subagent_result.execute('r', { agent_id: out.details.id, wait: true });
    assert.equal(done.details.status, 'failed');
    assert.equal(done.details.stopped, true);
    assert.match(f.view.render('agents'), /■ delegate {2}QEXC baseline .*stopped/);
    assert.match(lines(renderChildResult('get_subagent_result', done, {}, theme, {})), /■[\s\S]*Stopped/);
  } finally { release?.(); await f.shutdown(); }
  assert.equal(f.view.widgets.size, 0, 'shutdown removes the list and fleet');
});

test('a foreground child streams a live tool row and returns display detail', { skip: needsSandbox }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = await fixture([async () => { await gate; return fauxAssistantMessage('Report.'); }]);
  try {
    const updates = [];
    const run = f.tools.Agent.execute('fg', { prompt: 'Work.', description: 'audit', run_in_background: false }, null, (u) => updates.push(u), f.ctx);
    await until(() => updates.length >= 2);
    const partial = updates.at(-1);
    assert.equal(partial.details.status, 'running');
    assert.match(lines(renderAgentResult(partial, { isPartial: true }, theme, {})), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Faux Model · ↻1≤100\n {2}⎿ {2}thinking…/);
    release();
    const out = await run;
    assert.equal(out.details.status, 'completed');
    assert.ok(out.details.completedAt >= out.details.startedAt);
    const settled = updates.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(updates.length, settled, 'updates stop when the child settles');
    assert.match(lines(renderAgentResult(out, {}, theme, {})), /^✓ Faux Model · ↻1≤100 · \d+ token · \d+(\.\d+)?(ms|s)\n {2}⎿ {2}Done$/);
    assert.match(lines(renderAgentResult(out, { expanded: true }, theme, {})), /\n {2}Report\.$/);
  } finally { release(); await f.shutdown(); }
});

test('Agent rows show the type and description, each outcome, and no terminal controls', () => {
  assert.equal(lines(renderAgentCall({ subagent_type: 'researcher', description: 'find \u001b]8;;x\u0007papers' }, theme, {})), '▸ researcher  find papers');
  assert.equal(lines(renderAgentCall({ description: 'no type' }, theme, {})), '▸ delegate  no type');
  const base = { id: 'abc', turns: 3, maxTurns: 20, toolUses: 2, startedAt: 1000, completedAt: 3500, lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0 } };
  assert.equal(lines(renderAgentResult({ details: { ...base, status: 'running', background: true } }, {}, theme, {})), '  ⎿  Running in background (ID: abc)');
  assert.equal(lines(renderAgentResult({ details: { ...base, status: 'completed' } }, {}, theme, {})), '✓ ↻3≤20 · 2 tool uses · 1.5k token · 2.5s\n  ⎿  Done');
  assert.match(lines(renderAgentResult({ details: { ...base, status: 'failed', error: 'boom\u001b[2J' } }, {}, theme, {})), /^✗ .*\n {2}⎿ {2}Error: boom$/);
  assert.match(lines(renderAgentResult({ details: { ...base, status: 'failed', error: 'Child turn limit reached (20); partial results retained.' } }, {}, theme, {})), /Aborted \(turn limit reached\)/);
  assert.match(lines(renderAgentResult({ details: { ...base, status: 'failed', stopped: true, error: 'x' } }, {}, theme, {})), /^■.*\n {2}⎿ {2}Stopped$/);
  assert.equal(lines(renderAgentResult({ content: [{ type: 'text', text: 'Four children already run.' }], details: {} }, {}, theme, { isError: true })), 'Four children already run.');
});

test('steer and result rows name a known child and show the message', () => {
  const label = (id) => (id === 'k1' ? { type: 'delegate', description: 'QEXC timing' } : null);
  assert.equal(lines(renderChildCall('steer_subagent', { agent_id: 'k1', message: 'Parent QEXC\npath-only rerun' }, theme, label)), 'steer delegate  QEXC timing\n  ↳ Parent QEXC');
  assert.equal(lines(renderChildCall('steer_subagent', { agent_id: '2e93c952-1640-433c', message: 'x' }, theme, label)), 'steer 2e93c952\n  ↳ x');
  assert.equal(lines(renderChildCall('get_subagent_result', { agent_id: 'k1' }, theme, label)), 'result delegate  QEXC timing');
  assert.equal(lines(renderChildResult('steer_subagent', { details: { queued: true } }, {}, theme, {})), '  ⎿  Queued for the child');
  assert.equal(lines(renderChildResult('steer_subagent', { content: [{ type: 'text', text: 'No live child owned by this runtime.' }] }, {}, theme, { isError: true })), 'No live child owned by this runtime.');
});

test('result rows tolerate receipts, summaries, unchanged replies, pages and task views', () => {
  const base = { id: 'abc', status: 'completed', turns: 3, maxTurns: 20, toolUses: 2, revision: 2, requiredTools: ['literature_search'], taskId: 't1', supersedes: [],
    receipts: { calls: 2, errors: 0, tools: { literature_search: { calls: 2, ok: 2, items: 50 } }, error_samples: [] }, outcome: { lifecycle: 'completed', task: 'unknown', evidence: 'unknown' } };
  assert.equal(lines(renderAgentResult({ details: base }, {}, theme, {})), '✓ ↻3≤20 · 2 tool uses\n  ⎿  Done');
  assert.equal(lines(renderChildResult('get_subagent_result', { details: { ...base, resultChars: 10 } }, { expanded: true }, theme, {})), '✓ ↻3≤20 · 2 tool uses\n  ⎿  Done');
  assert.equal(lines(renderChildResult('get_subagent_result', { details: { id: 'abc', status: 'completed', revision: 2, resultChars: 10, unchanged: true } }, {}, theme, {})), '  ⎿  Unchanged since revision 2 (completed)');
  assert.match(lines(renderChildResult('get_subagent_result', { details: { ...base, result: 'abc', resultOffset: 4, resultChars: 10, nextOffset: 7 } }, {}, theme, {})), /\n {2}⎿ {2}Characters 4–7 of 10; more from offset 7$/);
  const task = { taskId: 't\u001b[31m1', supersedes: [], supersededBy: ['t2'], attempts: [{ id: 'a', status: 'failed' }, { id: 'b', status: 'completed' }], latest: { id: 'b', status: 'completed' } };
  assert.equal(lines(renderChildResult('get_subagent_result', { details: { task } }, {}, theme, {})), '  ⎿  Task t1: 2 attempts, latest completed · superseded by t2');
});
