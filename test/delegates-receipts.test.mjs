// Delegation bookkeeping: required capabilities before dispatch, deterministic tool receipts kept apart from the child's
// narrative, explicit task identity and supersession on the current branch, and bounded child-result reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import delegates from '../extensions/delegates/index.js';
import { needsSandbox } from './capabilities.mjs';

const LEDGER = Symbol.for('mina:delegates');
const fakeTool = (name, run) => ({ name, label: name, description: `fake ${name}`,
  parameters: { type: 'object', properties: {}, additionalProperties: true },
  execute: async (_id, params) => run(params) });
const family = (i) => ({ family_id: `f${i}`, title: `Paper ${i}` });
const search = (n, extra = {}) => ({ content: [{ type: 'text', text: `${n} families` }],
  details: { status: 'ok', results: Array.from({ length: n }, (_, i) => family(i)), coverage: { backends_failed: [] }, ...extra } });

// A pi stand-in with a session branch: tool results and custom entries land on `state.branch`, as pi records them.
async function fixture(responses, { tools = [], files = {} } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-receipt-project-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'mina-receipt-controller-'));
  for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), body); }
  const env = { PI_CODING_AGENT_DIR: agentDir, MINA_INSTANCE_ID: cwd, MINA_SANDBOX_PROJECT: cwd,
    MINA_SANDBOX_WRITE: JSON.stringify([cwd]), MINA_SANDBOX_NET: 'offline' };
  const faux = fauxProvider(); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ agentDir, modelsPath: null });
  runtime.registerNativeProvider(faux.provider);
  const state = { branch: [], n: 0 };
  const push = (entry) => { entry.id = `e${++state.n}`; state.branch = [...state.branch, entry]; return entry; };
  const sessionManager = { getBranch: () => state.branch, getLeafId: () => state.branch.at(-1)?.id ?? null };
  const runtimes = [];
  const load = (instance = cwd) => {
    const registered = {}, handlers = {};
    const pi = { events: new EventEmitter(), registerTool: (t) => { registered[t.name] = t; }, on: (e, h) => { handlers[e] = h; },
      appendEntry: (customType, data) => push({ type: 'custom', customType, data }) };
    delegates(pi, { env: { ...env, MINA_INSTANCE_ID: instance } });
    runtimes.push(handlers);
    return registered;
  };
  const ctx = { cwd, model: faux.getModel(), modelRegistry: new ModelRegistry(runtime), tools, thinkingLevel: 'off', sessionManager };
  let registered = load();
  // A parent tool call: the assistant message anchors it, and its result (with details) follows on the branch.
  const call = async (name, args) => {
    push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name }] } });
    const out = await registered[name].execute(`call-${state.n}`, args, null, null, ctx);
    push({ type: 'message', message: { role: 'toolResult', toolName: name, content: out.content, details: out.details } });
    return out;
  };
  const reject = async (name, args, pattern) => {
    push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name }] } });
    await assert.rejects(registered[name].execute('bad', args, null, null, ctx), pattern);
  };
  return { cwd, faux, ctx, state, call, reject, ledger: () => globalThis[LEDGER],
    reload: (instance) => { registered = load(instance); },
    shutdown: async () => { for (const h of runtimes) await h.session_shutdown?.(); rmSync(cwd, { recursive: true }); rmSync(agentDir, { recursive: true }); } };
}
const body = (out) => JSON.parse(out.content[0].text);
const until = async (check) => { for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(check()); };

// ---- 1. Required capabilities ----

test('a delegate whose role grants only file tools is refused a literature task before any model request', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('must not run')], {
    tools: [fakeTool('literature_search', () => search(1))],
    files: { '.pi/agents/delegate.md': '---\ntools: read, write, edit, bash\n---\nDelegate.' } });
  try {
    const before = { admissions: f.ledger().admissions, pending: f.ledger().pending ?? 0 };
    await f.reject('Agent', { prompt: 'Survey the literature.', description: 'lit', subagent_type: 'delegate', required_tools: ['literature_search', 'paper_get'], run_in_background: false },
      (e) => /lacks required tools: literature_search, paper_get/.test(e.message) && /read, write, edit, bash/.test(e.message)
        && /researcher/.test(e.message) && /No child was started/.test(e.message));
    assert.equal(f.faux.state.callCount, 0, 'no provider request');
    assert.deepEqual({ admissions: f.ledger().admissions, pending: f.ledger().pending ?? 0 }, before, 'a refused launch is not a child start');
    assert.equal(f.ledger().records.size, 0);
  } finally { await f.shutdown(); }
});

test('a researcher with the literature tools passes the same requirement and its receipts name the actual tools', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('Done.')], { tools: [fakeTool('literature_search', () => search(1)), fakeTool('paper_get', () => ({ content: [], details: { status: 'ok' } })), fakeTool('mina_host', () => ({}))] });
  try {
    const out = await f.call('Agent', { prompt: 'Survey.', description: 'lit', subagent_type: 'researcher', required_tools: ['literature_search', 'paper_get'], run_in_background: false });
    assert.equal(out.details.status, 'completed');
    assert.deepEqual(out.details.requiredTools, ['literature_search', 'paper_get']);
    assert.ok(out.details.tools.includes('literature_search') && out.details.tools.includes('paper_get'));
    assert.ok(!out.details.tools.includes('mina_host'), 'only the research allowlist is inherited');
    const record = f.state.branch.filter((e) => e.customType === 'subagents:record').at(-1).data;
    assert.deepEqual(record.tools, out.details.tools, 'the finished receipt states the same tool set');
  } finally { await f.shutdown(); }
});

test('a role that declares a research tool the session lacks is refused, and the message says so', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('must not run')]);
  try {
    await f.reject('Agent', { prompt: 'x', description: 'x', subagent_type: 'researcher', required_tools: ['literature_search'] },
      (e) => /not available in this session: literature_search/.test(e.message));
    assert.equal(f.faux.state.callCount, 0);
  } finally { await f.shutdown(); }
});

test('an explicit allowlist is never widened, invalid requirements fail early, and supplement_get is inheritable', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('ok'), fauxAssistantMessage('ok')], {
    tools: [fakeTool('supplement_get', () => ({})), fakeTool('literature_search', () => search(1))],
    files: { '.pi/agents/reader.md': '---\ntools: read\n---\nReader.' } });
  try {
    const out = await f.call('Agent', { prompt: 'x', description: 'x', subagent_type: 'reader', run_in_background: false });
    assert.deepEqual(out.details.tools, ['read']);
    await f.reject('Agent', { prompt: 'x', description: 'x', required_tools: 'literature_search' }, /required_tools must be an array/);
    await f.reject('Agent', { prompt: 'x', description: 'x', resume: out.details.id, required_tools: ['literature_search'] }, /lacks required tools: literature_search/);
    const r = await f.call('Agent', { prompt: 'x', description: 'x', subagent_type: 'researcher', required_tools: ['supplement_get'], run_in_background: false });
    assert.ok(r.details.tools.includes('supplement_get'));
    assert.equal(f.faux.state.callCount, 2);
  } finally { await f.shutdown(); }
});

// ---- 2. Tool receipts ----

test('two successful searches stay on record when the child narrative says nothing was done', { skip: needsSandbox }, async () => {
  const f = await fixture([
    fauxAssistantMessage(fauxToolCall('literature_search', { query: 'a' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('literature_search', { query: 'b' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Work completed: none.'),
  ], { tools: [fakeTool('literature_search', () => search(25))] });
  try {
    const out = await f.call('Agent', { prompt: 'Search.', description: 'lit', subagent_type: 'researcher', run_in_background: false });
    assert.equal(out.details.status, 'completed');
    assert.equal(out.details.result, 'Work completed: none.', 'the narrative is kept verbatim');
    assert.deepEqual(out.details.receipts.tools.literature_search, { calls: 2, ok: 2, items: 50 });
    assert.equal(out.details.receipts.calls, 2);
    assert.deepEqual(out.details.outcome, { lifecycle: 'completed', task: 'unknown', evidence: 'unknown' });
    const record = f.state.branch.filter((e) => e.customType === 'subagents:record').at(-1).data;
    assert.deepEqual(record.receipts.tools.literature_search, { calls: 2, ok: 2, items: 50 }, 'durable');
  } finally { await f.shutdown(); }
});

test('receipts tell a zero-result search from a failed one, partial text from unavailable, and a missing section from a missing paper', { skip: needsSandbox }, async () => {
  const replies = {
    zero: search(0),
    degraded: search(3, { coverage: { backends_failed: [{ backend: 'openalex', reason: 'error' }] } }),
    partial: { content: [], details: { status: 'ok_partial_text', passages: [{ id: 'p1' }] } },
    unavailable: { content: [], details: { status: 'FULLTEXT_UNAVAILABLE', fulltext: { temporary: true } } },
    section: { content: [], details: { status: 'not_found', depth: 'sections', paper: { title: 'P' }, sections: [] } },
    paper: { content: [], details: { status: 'not_found', depth: 'evidence', resolve: { status: 'not_found' } } },
  };
  const calls = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
  const f = await fixture([
    calls('literature_search', { q: 'zero' }), calls('literature_search', { q: 'fail' }), calls('literature_search', { q: 'degraded' }),
    calls('paper_get', { q: 'partial' }), calls('paper_get', { q: 'unavailable' }), calls('paper_get', { q: 'section' }), calls('paper_get', { q: 'paper' }),
    calls('web_fetch', { url: 'pdf' }), calls('read', { path: 'nothing.txt' }), fauxAssistantMessage('Summary.'),
  ], { tools: [
    fakeTool('literature_search', ({ q }) => { if (q === 'fail') throw new Error('broker timeout \u001b[31m'); return replies[q]; }),
    fakeTool('paper_get', ({ q }) => replies[q]),
    fakeTool('web_fetch', () => ({ content: [], details: { status: 200, unsupported: 'pdf' } })),
  ] });
  try {
    const out = await f.call('Agent', { prompt: 'Read.', description: 'lit', subagent_type: 'researcher', run_in_background: false });
    const t = out.details.receipts.tools;
    assert.deepEqual(t.literature_search, { calls: 3, ok: 2, error: 1, items: 3, zero_items: 1, backend_failures: 1 });
    assert.deepEqual(t.paper_get, { calls: 4, partial: 1, unavailable: 1, temporary: 1, not_found: 2, missing_section: 1, missing_paper: 1, items: 1 });
    assert.deepEqual(t.web_fetch, { calls: 1, unsupported: 1 });
    assert.deepEqual(t.read, { calls: 1, error: 1 });
    assert.equal(out.details.receipts.errors, 2);
    const sample = out.details.receipts.error_samples.find((e) => e.tool === 'literature_search');
    assert.match(sample.message, /broker timeout/);
    assert.doesNotMatch(sample.message, /\u001b/);
    assert.deepEqual(out.details.outcome, { lifecycle: 'completed', task: 'unknown', evidence: 'unknown' });
  } finally { await f.shutdown(); }
});

test('receipts stay bounded: at most five error samples of at most 200 characters', { skip: needsSandbox }, async () => {
  const many = Array.from({ length: 8 }, () => fauxAssistantMessage(fauxToolCall('literature_search', {}), { stopReason: 'toolUse' }));
  const f = await fixture([...many, fauxAssistantMessage('x')], { tools: [fakeTool('literature_search', () => { throw new Error('e'.repeat(1000)); })] });
  try {
    const out = await f.call('Agent', { prompt: 'x', description: 'x', subagent_type: 'researcher', run_in_background: false });
    assert.equal(out.details.receipts.errors, 8);
    assert.equal(out.details.receipts.error_samples.length, 5);
    assert.ok(out.details.receipts.error_samples.every((e) => e.message.length <= 200));
  } finally { await f.shutdown(); }
});

// ---- 3. Task identity and supersession ----

test('an explicit newer task supersedes a stale one without rewriting its history', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('Queue: tasks 3 and 4 open.'), fauxAssistantMessage('Tasks 3 and 4 closed.')]);
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'first pass', task_id: 'lit-review', run_in_background: false });
    assert.equal(a.details.taskId, 'lit-review');
    const b = await f.call('Agent', { prompt: 'x', description: 'follow-up', task_id: 'lit-review-2', supersedes: ['lit-review'], run_in_background: false });
    assert.deepEqual(b.details.supersedes, ['lit-review']);
    const old = body(await f.call('get_subagent_result', { task_id: 'lit-review' })).task;
    assert.deepEqual(old.supersededBy, ['lit-review-2']);
    assert.equal(old.attempts.length, 1);
    assert.equal(old.attempts[0].status, 'completed', 'its own lifecycle stays');
    assert.equal(old.latest.outcome.task, 'unknown', 'superseding does not mark it done');
    assert.equal(old.latest.result, undefined, 'the task view carries no result text');
    const current = body(await f.call('get_subagent_result', { task_id: 'lit-review-2' })).task;
    assert.deepEqual(current.supersedes, ['lit-review']);
    assert.deepEqual(current.supersededBy, []);
    assert.equal(current.latest.id, b.details.id);
    // A child id also names its task; unknown ids are refused before any request.
    const calls = f.faux.state.callCount;
    await f.reject('Agent', { prompt: 'x', description: 'x', supersedes: ['no-such-task'] }, /Unknown task or child id in supersedes: no-such-task/);
    await f.reject('Agent', { prompt: 'x', description: 'x', task_id: 'bad id!' }, /task_id/);
    assert.equal(f.faux.state.callCount, calls);
  } finally { await f.shutdown(); }
});

test('a retry under the same task id keeps the failed attempt visible', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage([{ type: 'text', text: 'partial' }, fauxToolCall('read', { path: 'x' })], { stopReason: 'toolUse' }), fauxAssistantMessage('Retry report.')]);
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'try', task_id: 'qexc', max_turns: 1, run_in_background: false });
    assert.equal(a.details.status, 'failed');
    const b = await f.call('Agent', { prompt: 'x', description: 'retry', task_id: 'qexc', run_in_background: false });
    const task = body(await f.call('get_subagent_result', { task_id: 'qexc' })).task;
    assert.deepEqual(task.attempts.map((x) => [x.id, x.status]), [[a.details.id, 'failed'], [b.details.id, 'completed']]);
    assert.match(task.attempts[0].error, /turn limit/);
    assert.equal(task.latest.id, b.details.id);
  } finally { await f.shutdown(); }
});

test('an abandoned branch does not merge into the task view, and a reload reads the branch without live authority', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('first'), fauxAssistantMessage('second')]);
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'a', task_id: 'alpha', run_in_background: false });
    const fork = f.state.branch;
    await f.call('Agent', { prompt: 'x', description: 'b', task_id: 'beta', supersedes: ['alpha'], run_in_background: false });
    assert.deepEqual(body(await f.call('get_subagent_result', { task_id: 'alpha' })).task.supersededBy, ['beta']);
    f.state.branch = fork;                                                   // /tree back to before the follow-up
    assert.deepEqual(body(await f.call('get_subagent_result', { task_id: 'alpha' })).task.supersededBy, []);
    await f.reject('get_subagent_result', { task_id: 'beta' }, /No task beta on the current branch/);

    f.reload('restarted-process');                                           // a fresh runtime with no live records
    const historic = await f.call('get_subagent_result', { agent_id: a.details.id, wait: true });
    assert.equal(historic.details.historical, true);
    assert.equal(historic.details.result, 'first');
    assert.equal(body(await f.call('get_subagent_result', { task_id: 'alpha' })).task.attempts[0].status, 'completed');
    await f.reject('Agent', { prompt: 'x', description: 'x', resume: a.details.id }, /Cannot resume a historical child/);
    await f.reject('get_subagent_result', { agent_id: 'nope' }, /not found/);
    assert.equal(f.faux.state.callCount, 2);
  } finally { await f.shutdown(); }
});

// ---- 4. Bounded result reads ----

const UNICODE = 'Résumé 😀 中文 e\u0301 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 — ';

test('a result reads in full by default, as a summary, or in pages that rebuild it exactly', { skip: needsSandbox }, async () => {
  const report = UNICODE.repeat(40);
  const f = await fixture([fauxAssistantMessage(report)]);
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'x', run_in_background: false });
    const full = await f.call('get_subagent_result', { agent_id: a.details.id });
    assert.equal(body(full).result, report, 'default stays the full result');
    assert.equal(body(full).resultChars, report.length);

    const summary = body(await f.call('get_subagent_result', { agent_id: a.details.id, summary_only: true }));
    assert.equal(summary.result, undefined);
    assert.equal(summary.resultChars, report.length);
    assert.equal(summary.status, 'completed');
    assert.ok(summary.revision >= 1);
    assert.ok(summary.receipts);

    let text = '', offset = 0, pages = 0;
    while (offset !== null) {
      const page = body(await f.call('get_subagent_result', { agent_id: a.details.id, offset, max_chars: 7, revision: summary.revision }));
      assert.equal(page.resultChars, report.length);
      assert.equal(page.resultOffset, offset);
      assert.doesNotMatch(page.result, /^[\udc00-\udfff]|[\ud800-\udbff]$/, 'no page splits a surrogate pair');
      assert.ok(page.result.length > 0 && page.result.length <= 8);
      text += page.result; offset = page.nextOffset; pages++;
    }
    assert.equal(text, report);
    assert.ok(pages > 1);
    // A single astral character with max_chars 1 still advances.
    const astral = body(await f.call('get_subagent_result', { agent_id: a.details.id, offset: report.indexOf('😀'), max_chars: 1 }));
    assert.equal(astral.result, '😀');
    await f.reject('get_subagent_result', { agent_id: a.details.id, offset: report.length + 1 }, /offset .* beyond/);
    await f.reject('get_subagent_result', { agent_id: a.details.id, max_chars: 0 }, /max_chars/);
    await f.reject('get_subagent_result', { agent_id: a.details.id, summary_only: true, offset: 0 }, /summary_only/);
    await f.reject('get_subagent_result', {}, /agent_id or task_id/);
  } finally { await f.shutdown(); }
});

test('an unchanged revision returns a short reply, a resumed child changes it, and a stale page is refused', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('first report'), fauxAssistantMessage('second, longer report')]);
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'x', run_in_background: false });
    const rev = body(await f.call('get_subagent_result', { agent_id: a.details.id, summary_only: true })).revision;
    const same = await f.call('get_subagent_result', { agent_id: a.details.id, since_revision: rev });
    assert.deepEqual(body(same), { id: a.details.id, status: 'completed', revision: rev, resultChars: 12, unchanged: true });
    await f.call('Agent', { prompt: 'more', description: 'x', resume: a.details.id, run_in_background: false });
    const changed = body(await f.call('get_subagent_result', { agent_id: a.details.id, since_revision: rev }));
    assert.equal(changed.unchanged, undefined);
    assert.equal(changed.result, 'second, longer report');
    assert.ok(changed.revision > rev);
    await f.reject('get_subagent_result', { agent_id: a.details.id, offset: 5, max_chars: 5, revision: rev }, /changed .*revision/);
  } finally { await f.shutdown(); }
});

test('wait still waits for a running child, also for a summary read', { skip: needsSandbox }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = await fixture([async () => { await gate; return fauxAssistantMessage('late report'); }]);
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'bg' });
    const running = body(await f.call('get_subagent_result', { agent_id: a.details.id, summary_only: true }));
    assert.equal(running.status, 'running');
    const pending = f.call('get_subagent_result', { agent_id: a.details.id, summary_only: true, wait: true });
    setTimeout(release, 30);
    const done = body(await pending);
    assert.equal(done.status, 'completed');
    assert.equal(done.resultChars, 'late report'.length);
    assert.ok(done.revision > running.revision);
  } finally { release(); await f.shutdown(); }
});
