// Regressions from the delegation audit: model-chosen names in receipt tables, same-task launch races, supersession cycles,
// branch authority, revisions during tool progress, literature_db outcomes, result-page offsets, same-process reloads and
// admission refunds. Each test fails on the delegation code before these fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyToolResult } from '../extensions/delegates/index.js';
import { fixture, fakeTool, body, until, settle, fauxAssistantMessage, fauxToolCall } from './delegates-fixture.mjs';
import { needsSandbox } from './capabilities.mjs';

const FIXTURE = pathToFileURL(fileURLToPath(new URL('./delegates-fixture.mjs', import.meta.url))).href;
const gated = () => { let open; const gate = new Promise((r) => { open = r; }); return { gate, open }; };

// ---- 1. Model-chosen tool names and tool-chosen statuses never reach a prototype ----

// Runs in a separate process: if the defect is present it pollutes Object.prototype, which must not leak into this suite.
const PROTO_SCRIPT = `
const { fixture, fakeTool, body, fauxAssistantMessage, fauxToolCall } = await import(${JSON.stringify(FIXTURE)});
const before = Object.getOwnPropertyNames(Object.prototype).sort();
const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
const statuses = [{ status: '__proto__' }, { status: 'constructor' }, { status: 'hasOwnProperty' }, { outcome: '__proto__' }, { outcome: 'constructor' }];
const f = await fixture([
  fauxAssistantMessage(names.map((n) => fauxToolCall(n, {})), { stopReason: 'toolUse' }),
  fauxAssistantMessage(statuses.map((_, i) => fauxToolCall('paper_get', { i })), { stopReason: 'toolUse' }),
  fauxAssistantMessage('done'),
], { tools: [fakeTool('paper_get', ({ i }) => ({ content: [], details: statuses[i] })), fakeTool('__proto__', () => ({ content: [], details: { status: 'ok' } }))] });
const out = await f.call('Agent', { prompt: 'x', description: 'x', subagent_type: 'researcher', run_in_background: false });
const t = out.details.receipts.tools;
const read = body(await f.call('get_subagent_result', { agent_id: out.details.id, summary_only: true }));
const record = f.state.branch.filter((e) => e.customType === 'subagents:record').at(-1).data;
const fresh = {};
const report = {
  status: out.details.status, tools: out.details.tools,
  added: Object.getOwnPropertyNames(Object.prototype).sort().filter((k) => !before.includes(k)),
  inherited: { calls: fresh.calls, error: fresh.error, other: fresh.other, ok: fresh.ok },
  nullProto: Object.getPrototypeOf(t) === null && Object.getPrototypeOf(record.receipts.tools) === null,
  own: Object.fromEntries(names.concat('paper_get').map((n) => [n, Object.getOwnPropertyDescriptor(t, n)?.value ?? null])),
  text: body(out).receipts, read: read.receipts, total: out.details.receipts.calls, errors: out.details.receipts.errors,
};
await f.shutdown();
process.stdout.write(JSON.stringify(report));
process.exit(0);
`;

test('unknown tools named __proto__, constructor, toString or hasOwnProperty are counted without touching any prototype', { skip: needsSandbox }, () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', PROTO_SCRIPT], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const r = JSON.parse(run.stdout);
  assert.deepEqual(r.added, [], 'Object.prototype gained no property');
  assert.deepEqual(r.inherited, {}, 'a fresh object inherits no counters');
  assert.equal(r.status, 'completed');
  assert.ok(r.nullProto, 'published and recorded tool tables have no prototype');
  // The child was granted none of these names; the receipts never add them to its tools.
  for (const n of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.ok(!r.tools.includes(n), `${n} is not granted`);
    assert.deepEqual(r.own[n], { calls: 1, error: 1 }, `${n} is counted as its own entry`);
    assert.deepEqual(r.text.tools[n], { calls: 1, error: 1 }, `${n} survives the JSON the model reads`);
    assert.deepEqual(r.read.tools[n], { calls: 1, error: 1 }, `${n} survives a later read`);
  }
  // Inherited names as statuses or outcomes are unfamiliar statuses, not outcome-table hits.
  assert.deepEqual(r.own.paper_get, { calls: 5, other: 5 });
  assert.equal(r.total, 9);
  assert.equal(r.errors, 4);
});

test('classifyToolResult reads only own status and outcome fields and maps inherited names to other', () => {
  for (const s of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])
    assert.deepEqual(classifyToolResult('paper_get', { details: { status: s } }, false), { outcome: 'other' }, s);
  const inherited = Object.create({ status: 'ok', outcome: 'ok', unsupported: true });
  assert.deepEqual(classifyToolResult('paper_get', { details: inherited }, false), {}, 'inherited fields are not a structured result');
  assert.equal(Object.prototype.other, undefined);
});

// ---- 2. Simultaneous launches of one task ----

test('two simultaneous launches with the same task_id start one child and make one provider request', { skip: needsSandbox }, async () => {
  const { gate, open } = gated();
  const f = await fixture([async () => { await gate; return fauxAssistantMessage('only'); }, fauxAssistantMessage('must not run')]);
  try {
    const args = { prompt: 'x', description: 'x', task_id: 'same' };
    const [a, b] = await Promise.all([settle(f.call('Agent', args)), settle(f.call('Agent', args))]);
    assert.equal([a, b].filter((x) => x.ok).length, 1, JSON.stringify([a.e, b.e]));
    assert.match([a, b].find((x) => !x.ok).e, /Task same already has a child starting/);
    // While the first runs, a resume of nothing and a third launch are refused too.
    await f.reject('Agent', args, /already has a running child/);
    open();
    await until(() => [...f.ledger().records.values()].every((r) => r.status !== 'running'));
    assert.equal(f.faux.state.callCount, 1, 'one provider request');
    assert.equal(body(await f.call('get_subagent_result', { task_id: 'same' })).task.attempts.length, 1);
    assert.equal(f.ledger().pending, 0);
  } finally { open(); await f.shutdown(); }
});

test('a resume cannot run beside a starting launch of the same task', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('first'), fauxAssistantMessage('second'), fauxAssistantMessage('must not run')]);
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'a', task_id: 'T', run_in_background: false });
    const [launched, resumed] = await Promise.all([
      settle(f.call('Agent', { prompt: 'x', description: 'b', task_id: 'T', run_in_background: false })),
      settle(f.call('Agent', { prompt: 'more', description: 'a', resume: a.details.id, run_in_background: false }))]);
    assert.ok(launched.ok, launched.e);
    assert.equal(resumed.ok, false);
    assert.match(resumed.e, /Task T already has a child starting/);
    assert.equal(f.faux.state.callCount, 2);
  } finally { await f.shutdown(); }
});

// ---- 9 (with 2). Refused launches return their admission and their task reservation ----

test('launches refused before a child exists keep admissions, pending starts and task reservations unchanged', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('valid retry')], {
    files: { '.pi/agents/reader.md': '---\ntools: read\n---\nReader.' }, dirs: ['.pi/agents/broken.md'] });
  try {
    const before = f.ledger().admissions;
    const base = { prompt: 'x', description: 'x', task_id: 'retry-me' };
    await f.reject('Agent', { ...base, subagent_type: 'nonexistent-role' }, /Unknown agent type/);
    await f.reject('Agent', { ...base, model: 'faux/nope' }, /model is unavailable/);
    await f.reject('Agent', { ...base, subagent_type: 'reader', required_tools: ['literature_search'] }, /lacks required tools/);
    await f.reject('Agent', { ...base, subagent_type: 'broken' }, (e) => e instanceof Error);
    await f.reject('Agent', { ...base, max_turns: 0 }, /max_turns/);
    assert.equal(f.ledger().admissions, before, 'no admission consumed');
    assert.equal(f.ledger().pending, 0);
    assert.equal(f.ledger().records.size, 0);
    assert.equal(f.faux.state.callCount, 0);
    const ok = await f.call('Agent', { ...base, run_in_background: false });
    assert.equal(ok.details.status, 'completed');
    assert.equal(ok.details.taskId, 'retry-me');
    assert.equal(f.ledger().admissions, before + 1, 'the valid retry counts once');
  } finally { await f.shutdown(); }
});

// ---- 3. Supersession cycles ----

test('direct and indirect supersession cycles are refused before any request; a plain retry stays valid', { skip: needsSandbox }, async () => {
  const f = await fixture(['a', 'b', 'c', 'retry'].map((t) => fauxAssistantMessage(t)));
  try {
    await f.call('Agent', { prompt: 'x', description: 'a', task_id: 'A', run_in_background: false });
    await f.call('Agent', { prompt: 'x', description: 'b', task_id: 'B', supersedes: ['A'], run_in_background: false });
    await f.reject('Agent', { prompt: 'x', description: 'a2', task_id: 'A', supersedes: ['B'] }, /Supersession cycle: A -> B -> A/);
    await f.call('Agent', { prompt: 'x', description: 'c', task_id: 'C', supersedes: ['B'], run_in_background: false });
    await f.reject('Agent', { prompt: 'x', description: 'a3', task_id: 'A', supersedes: ['C'] }, /Supersession cycle: A -> C -> B -> A/);
    const b = f.state.branch.find((e) => e.message?.details?.taskId === 'B').message.details.id;
    await f.reject('Agent', { prompt: 'x', description: 'a4', task_id: 'A', supersedes: [b] }, /Supersession cycle/);
    assert.equal(f.faux.state.callCount, 3);
    const retry = await f.call('Agent', { prompt: 'x', description: 'a retry', task_id: 'A', run_in_background: false });
    assert.equal(retry.details.status, 'completed');
    const a = body(await f.call('get_subagent_result', { task_id: 'A' })).task;
    assert.deepEqual(a.supersedes, []);
    assert.deepEqual(a.supersededBy, ['B']);
    assert.equal(a.attempts.length, 2);
  } finally { await f.shutdown(); }
});

// Launches of different tasks that each supersede the other, started together, both passed the cycle check while their
// definitions loaded and then both committed. The graph is checked again just before the child record is committed.
async function concurrentSupersession({ seeds, launches, sessionManager = true }) {
  const f = await fixture([...seeds, ...launches].map((l) => fauxAssistantMessage(l.description)), { sessionManager });
  try {
    for (const s of seeds) await f.call('Agent', { prompt: 'x', ...s, run_in_background: false });
    const before = f.ledger().admissions;
    const out = await Promise.all(launches.map((l) => settle(f.call('Agent', { prompt: 'x', ...l, run_in_background: false }))));
    const accepted = out.filter((x) => x.ok), refused = out.filter((x) => !x.ok);
    assert.equal(refused.length, 1, JSON.stringify(out.map((x) => x.e ?? x.v.details.taskId)));
    assert.equal(accepted.length, launches.length - 1);
    assert.match(refused[0].e, /Supersession cycle: .*No child was started/);
    for (const a of accepted) assert.equal(a.v.details.status, 'completed');
    assert.equal(f.faux.state.callCount, seeds.length + accepted.length, 'the refused launch made no provider request');
    assert.equal(f.ledger().admissions, before + accepted.length, 'the refused launch returned its admission');
    assert.equal(f.ledger().pending, 0);
    // No task reaches itself through supersedes.
    const graph = new Map();
    for (const s of seeds) graph.set(s.task_id, body(await f.call('get_subagent_result', { task_id: s.task_id })).task.supersedes);
    for (const root of graph.keys()) {
      const seen = new Set(), stack = [...graph.get(root)];
      while (stack.length) { const s = stack.pop(); assert.notEqual(s, root, `cycle through ${root}: ${JSON.stringify([...graph])}`);
        if (!seen.has(s)) { seen.add(s); stack.push(...(graph.get(s) ?? [])); } }
    }
    return { out, graph };
  } finally { await f.shutdown(); }
}

const AB = [{ description: 'a', task_id: 'A' }, { description: 'b', task_id: 'B' }];
const bOverA = { description: 'b2', task_id: 'B', supersedes: ['A'] }, aOverB = { description: 'a2', task_id: 'A', supersedes: ['B'] };

test('two simultaneous launches that supersede each other: exactly one starts, in either order', { skip: needsSandbox }, async () => {
  for (const launches of [[bOverA, aOverB], [aOverB, bOverA]]) {
    // Whichever commits first (definition loading decides, not call order) keeps its edge; the other adds none.
    const { out, graph } = await concurrentSupersession({ seeds: AB, launches });
    const won = launches[out.findIndex((x) => x.ok)], lost = launches[out.findIndex((x) => !x.ok)];
    assert.deepEqual(graph.get(won.task_id), won.supersedes);
    assert.deepEqual(graph.get(lost.task_id), []);
  }
});

test('simultaneous launches closing an indirect cycle, and a mutual pair without a session manager, are refused once', { skip: needsSandbox }, async () => {
  await concurrentSupersession({ seeds: [...AB, { description: 'c', task_id: 'C' }], launches: [bOverA,
    { description: 'c2', task_id: 'C', supersedes: ['B'] }, { description: 'a3', task_id: 'A', supersedes: ['C'] }] });
  await concurrentSupersession({ seeds: AB, launches: [bOverA, aOverB], sessionManager: false });
});

// ---- 4. Off-branch children have no authority ----

test('after a branch switch, an off-branch child cannot be superseded, resumed or steered, and reads say so', { skip: needsSandbox }, async () => {
  const { gate, open } = gated();
  const f = await fixture([fauxAssistantMessage('x1'), async () => { await gate; return fauxAssistantMessage('bg'); }, fauxAssistantMessage('must not run')]);
  try {
    const fork = f.state.branch;
    const x = await f.call('Agent', { prompt: 'x', description: 'x', task_id: 'X', run_in_background: false });
    const bg = await f.call('Agent', { prompt: 'x', description: 'bg', task_id: 'BG' });
    f.state.branch = fork;                                                   // /tree back before both launches
    await f.reject('get_subagent_result', { task_id: 'X' }, /No task X/);
    await f.reject('Agent', { prompt: 'x', description: 'y', task_id: 'Y', supersedes: [x.details.id] }, /Unknown task or child id in supersedes/);
    await f.reject('Agent', { prompt: 'x', description: 'y', task_id: 'Y', supersedes: ['X'] }, /Unknown task or child id in supersedes/);
    await f.reject('Agent', { prompt: 'more', description: 'x', resume: x.details.id }, /launched on another branch/);
    await f.reject('steer_subagent', { agent_id: bg.details.id, message: 'go' }, /launched on another branch/);
    const read = body(await f.call('get_subagent_result', { agent_id: x.details.id, summary_only: true }));
    assert.equal(read.historical, true);
    assert.equal(read.off_branch, true);
    assert.equal(read.status, 'completed');
    assert.equal(f.faux.state.callCount, 2, 'no resumed provider request');
  } finally { open(); await f.shutdown(); }
});

test('without a session manager every child of this runtime counts as on the branch (compatibility)', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('a'), fauxAssistantMessage('a again'), fauxAssistantMessage('b')], { sessionManager: false });
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'a', task_id: 'A', run_in_background: false });
    const again = await f.call('Agent', { prompt: 'more', description: 'a', resume: a.details.id, run_in_background: false });
    assert.equal(again.details.result, 'a again');
    const b = await f.call('Agent', { prompt: 'x', description: 'b', supersedes: [a.details.id], run_in_background: false });
    assert.deepEqual(b.details.supersedes, ['A']);
    const read = body(await f.call('get_subagent_result', { agent_id: a.details.id }));
    assert.equal(read.historical, undefined);
  } finally { await f.shutdown(); }
});

// ---- 5. Revisions follow tool progress; pages follow the result text ----

test('tool receipts move the revision while a child runs, without invalidating pages of an unchanged result', { skip: needsSandbox }, async () => {
  const { gate, open } = gated();
  const search = { content: [], details: { status: 'ok', results: [{}, {}], coverage: { backends_failed: [] } } };
  const f = await fixture([fauxAssistantMessage('first report'),
    fauxAssistantMessage(fauxToolCall('literature_search', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('paper_get', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('second report')],
  { tools: [fakeTool('literature_search', () => search), fakeTool('paper_get', async () => { await gate; return { content: [], details: { status: 'ok' } }; })] });
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'x', subagent_type: 'researcher', run_in_background: false });
    const done = body(await f.call('get_subagent_result', { agent_id: a.details.id, summary_only: true })).revision;
    const resumed = body(await f.call('Agent', { prompt: 'more', description: 'x', resume: a.details.id }));
    await until(() => f.ledger().records.get(a.details.id).receipts.calls >= 1);
    const now = body(await f.call('get_subagent_result', { agent_id: a.details.id, since_revision: resumed.revision }));
    assert.equal(now.unchanged, undefined, 'a new receipt is a change');
    assert.ok(now.revision > resumed.revision);
    assert.equal(now.receipts.tools.literature_search.ok, 1);
    assert.equal(now.receipts.unfinished, 1, 'the gated paper_get has started');
    // The result text is still the first run's; a page against the earlier revision stays valid.
    const page = body(await f.call('get_subagent_result', { agent_id: a.details.id, offset: 0, max_chars: 5, revision: done }));
    assert.equal(page.result, 'first');
    open();
    await until(() => f.ledger().records.get(a.details.id).status !== 'running');
    await f.reject('get_subagent_result', { agent_id: a.details.id, offset: 5, max_chars: 5, revision: now.revision }, /changed .*revision/);
    await f.reject('get_subagent_result', { agent_id: a.details.id, offset: 0, revision: 10 ** 6 }, /changed .*revision/);
  } finally { open(); await f.shutdown(); }
});

// ---- 6. literature_db reports `outcome` ----

test('literature_db outcomes ok, empty and not_found are counted as such and do not complete the task', { skip: needsSandbox }, async () => {
  const shape = (outcome) => ({ server: 'pubmed', tool: 'search', outcome, ms: 3, cached: false });
  assert.deepEqual(classifyToolResult('literature_db', { details: shape('ok') }, false), { outcome: 'ok' });
  assert.deepEqual(classifyToolResult('literature_db', { details: shape('empty') }, false), { outcome: 'empty' });
  assert.deepEqual(classifyToolResult('literature_db', { details: shape('not_found') }, false), { outcome: 'not_found' });
  assert.deepEqual(classifyToolResult('literature_db', { details: { server: 'openalex', tools: 3 } }, false), {}, 'list_tools has no outcome');
  const kinds = ['ok', 'empty', 'not_found'];
  const f = await fixture([fauxAssistantMessage(kinds.map((k) => fauxToolCall('literature_db', { k })), { stopReason: 'toolUse' }), fauxAssistantMessage('done')],
    { tools: [fakeTool('literature_db', ({ k }) => ({ content: [{ type: 'text', text: 'untrusted' }], details: shape(k) }))],
      files: { '.pi/agents/db.md': '---\ntools: literature_db\n---\nDB.' } });
  try {
    const out = await f.call('Agent', { prompt: 'x', description: 'x', subagent_type: 'db', run_in_background: false });
    assert.deepEqual(out.details.receipts.tools.literature_db, { calls: 3, ok: 1, empty: 1, not_found: 1 });
    assert.deepEqual(out.details.outcome, { lifecycle: 'completed', task: 'unknown', evidence: 'unknown' });
  } finally { await f.shutdown(); }
});

// ---- 7. Page offsets inside a surrogate pair ----

test('every offset either starts a well-formed page or is refused with a usable offset, and nextOffset rebuilds the rest', { skip: needsSandbox }, async () => {
  const report = 'a😀b😀😀c𝔘';
  const f = await fixture([fauxAssistantMessage(report)]);
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'x', run_in_background: false });
    const id = a.details.id;
    for (let offset = 0; offset <= report.length; offset++) {
      const inside = offset > 0 && /[\udc00-\udfff]/.test(report[offset]) && /[\ud800-\udbff]/.test(report[offset - 1]);
      if (inside) {
        await f.reject('get_subagent_result', { agent_id: id, offset, max_chars: 1 }, new RegExp(`offset ${offset} falls inside a surrogate pair.*offset ${offset - 1}`));
        continue;
      }
      for (const max of [1, 2, 3]) {
        let text = '', at = offset;
        while (at !== null) {
          const p = body(await f.call('get_subagent_result', { agent_id: id, offset: at, max_chars: max }));
          assert.doesNotMatch(p.result, /^[\udc00-\udfff]|[\ud800-\udbff]$/, `offset ${at} max ${max}`);
          text += p.result; at = p.nextOffset;
        }
        assert.equal(text, report.slice(offset), `offset ${offset} max ${max}`);
      }
    }
  } finally { await f.shutdown(); }
});

// ---- 8. A same-process reload keeps the old runtime's children historical ----

test('after a reload with the same instance id, the earlier runtime\'s child reads as historical and cannot be resumed', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('first'), fauxAssistantMessage('must not run')]);
  try {
    const a = await f.call('Agent', { prompt: 'x', description: 'a', task_id: 'alpha', run_in_background: false });
    f.reload();                                                              // same MINA_INSTANCE_ID: the ledger survives
    const read = body(await f.call('get_subagent_result', { agent_id: a.details.id, summary_only: true, wait: true }));
    assert.equal(read.historical, true);
    assert.equal(read.status, 'completed');
    await f.reject('Agent', { prompt: 'x', description: 'x', resume: a.details.id }, /Cannot resume a historical child/);
    await f.reject('steer_subagent', { agent_id: a.details.id, message: 'x' }, /No live child/);
    const t = body(await f.call('get_subagent_result', { task_id: 'alpha' })).task;
    assert.equal(t.latest.historical, true);
    assert.equal(f.faux.state.callCount, 1);
  } finally { await f.shutdown(); }
});
