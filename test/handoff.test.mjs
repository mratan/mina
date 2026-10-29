import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { thresholds, tuningForModel, poolBudget, poolCap, poolThresholds, spawnFits, handoffDue, hotCompactConfig, renderPacket, goalRestatement, NOTE_REQUEST } from '../extensions/handoff/policy.mjs';
import { lineage, search, readEntry } from '../extensions/handoff/recall.mjs';
process.env.MINA_METRICS_FILE = join(mkdtempSync(join(tmpdir(), 'mina-metrics-')), 'metrics.jsonl'); // tests never write the real file
import minaHandoff, { MARKER, REMIND_EVERY, RESUME_REQUEST, fallbackSummary } from '../extensions/handoff/index.js';

test('thresholds: tuning values, else 40% / 60% of the window, capped at 250K / 350K (usage economics, 2026-10-17)', () => {
  assert.deepEqual(thresholds({ compact_at_tokens: 60000, handoff_at_tokens: 90000 }, 131072), { compactAt: 60000, handoffAt: 90000, maxCompactions: 2 });
  assert.deepEqual(thresholds(null, 200000), { compactAt: 80000, handoffAt: 120000, maxCompactions: 2 });
  // Large windows: every request carries the whole context, so 40% of 1M (400K) would cost and slow each turn.
  assert.deepEqual(thresholds(null, 1000000), { compactAt: 250000, handoffAt: 350000, maxCompactions: 2 });
  assert.deepEqual(thresholds({ context_window: 500000 }), { compactAt: 200000, handoffAt: 300000, maxCompactions: 2 });
});

test('handoff due at handoff_at, or at compact_at after max compactions; unknown usage is never pressure', () => {
  const t = thresholds({ compact_at_tokens: 60000, handoff_at_tokens: 90000 });
  assert.equal(handoffDue({ tokens: 95000 }, t), 'handoff');
  assert.equal(handoffDue({ tokens: 70000, compactions: 1 }, t), null);
  assert.equal(handoffDue({ tokens: 70000, compactions: 2 }, t), 'handoff');
  assert.equal(handoffDue({ tokens: null, compactions: 5 }, t), null);
  // a successor that starts at 88K must grow by 18K (20% of 90K) first
  assert.equal(handoffDue({ tokens: 95000, baseline: 88000 }, t), null);
  assert.equal(handoffDue({ tokens: 106000, baseline: 88000 }, t), 'handoff');
});

test('hot-compact config keeps the user settings and starts compaction at compact_at', () => {
  assert.deepEqual(hotCompactConfig({ semantic: false }, { context_window: 272000, compact_at_tokens: 100000 }), { semantic: false, startPercent: 37, hardPercent: 48, debug: true });
  // a local model: the model-written checkpoint starts at 60K; a deterministic one is committed at 75K if it has not landed
  assert.deepEqual(hotCompactConfig({}, { context_window: 131072, compact_at_tokens: 60000, handoff_at_tokens: 90000 }), { startPercent: 46, hardPercent: 57, debug: true });
  assert.equal(hotCompactConfig({ hardPercent: 80 }, { context_window: 131072, compact_at_tokens: 60000, handoff_at_tokens: 90000 }).hardPercent, 80);
  assert.equal(hotCompactConfig({ startPercent: 50 }, { context_window: 272000, compact_at_tokens: 100000 }).startPercent, 50);
  assert.deepEqual(hotCompactConfig({}, { context_window: 131072, compact_at_tokens: 16000, hot_compact: { startPercent: 12, tailTokens: 6000, hardPercent: 30 } }), { startPercent: 12, tailTokens: 6000, hardPercent: 30, debug: true });
});

test('on large windows compaction starts at compact_at and must commit before handoff (IV-1a, 2026-10-17)', () => {
  // A 20% start floor and a +5 hard margin made Claude's 1M window start at 200K and commit by 250K, past the 220K
  // handoff: the first session handed off without compacting.
  const claude = hotCompactConfig({}, { context_window: 1000000, compact_at_tokens: 160000, handoff_at_tokens: 220000 });
  assert.deepEqual(claude, { startPercent: 16, hardPercent: 19, debug: true });
  assert.deepEqual(hotCompactConfig({}, { context_window: 1000000 }), { startPercent: 25, hardPercent: 30, debug: true });
  for (const w of [32768, 131072, 200000, 272000, 500000, 1000000, 2000000]) {
    const t = thresholds(null, w), c = hotCompactConfig({}, null, w);
    assert.ok(c.startPercent * w / 100 <= t.compactAt + w / 100, `${w}: start at compact_at`);
    assert.ok(c.hardPercent > c.startPercent && c.hardPercent * w / 100 < t.handoffAt, `${w}: hard point before handoff (${c.hardPercent}% of ${w})`);
  }
});

test('hot-compact writes its job log (failure reasons) unless the user turned it off', () => {
  assert.equal(hotCompactConfig({}, { context_window: 1000000 }).debug, true);
  assert.equal(hotCompactConfig({ debug: false }, { context_window: 1000000 }).debug, false);
});

test('packet: goal and next actions always stay; optional sections are dropped first when too large', () => {
  const note = { state: 'half done', next_actions: ['run tests'], facts: ['x'.repeat(5000)], decisions: ['use HLL'] };
  const goal = { objective: 'build it', status: 'active', checks: [{ id: 'R1', command: 'pytest -q' }] };
  const full = renderPacket({ note, goal, parentFile: '/s/a.jsonl' });
  assert.match(full, /## Goal\nbuild it/); assert.match(full, /goal_id .* is stale/); assert.match(full, /R1: pytest -q/); assert.match(full, /x{100}/); assert.match(full, /mina_recall/);
  const small = renderPacket({ note, goal, parentFile: '/s/a.jsonl' }, 2000);
  assert.match(small, /run tests/); assert.doesNotMatch(small, /x{100}/);
  assert.ok(Buffer.byteLength(small) <= 2000);
});

function sessionFile(dir, name, parent, entries) {
  const f = join(dir, name);
  writeFileSync(f, [{ type: 'session', id: name, ...(parent ? { parentSession: parent } : {}) }, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return f;
}

test('recall searches the current session and its parents, and reads an entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mina-recall-'));
  const a = sessionFile(dir, 'a.jsonl', null, [{ type: 'message', id: 'e1', message: { role: 'assistant', content: [{ type: 'text', text: 'the magic number is 4242' }] } }]);
  const b = sessionFile(dir, 'b.jsonl', a, [{ type: 'message', id: 'e2', message: { role: 'user', content: 'continue' } }]);
  const s = lineage(b);
  assert.deepEqual(s.map((x) => x.file), [b, a]);
  const hits = search(s, { query: 'MAGIC number' });
  assert.equal(hits[0].session, 'earlier-1'); assert.equal(hits[0].entry_id, 'e1');
  assert.match(readEntry(s, 'e1').text, /4242/);
  assert.equal(search(s, { query: 'num\\w+ is \\d+', regex: true }).length, 1);
});

// A fake Pi runtime for the extension.
function fake({ tokens = 10_000, window = 131072, branch = [], file = null, tuning = { compact_at_tokens: 60000, handoff_at_tokens: 90000, context_window: window },
  model = { provider: 'p', id: 'm' }, readTuning = () => null, measure = undefined, exec = undefined, extra = {} } = {}) {
  const handlers = {}, tools = {}, commands = {}, sent = [], entries = [], switched = [], bus = {};
  const pi = {
    events: { on: (ch, fn) => { (bus[ch] ??= []).push(fn); return () => {}; }, emit: (ch, d) => (bus[ch] ?? []).forEach((fn) => fn(d)) },
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
    registerTool: (t) => { tools[t.name] = t; },
    registerCommand: (n, o) => { commands[n] = o; },
    sendUserMessage: (text, opts) => sent.push({ text, opts }),
    appendEntry: (type, data) => entries.push({ type, data }),
    setModel: async (m) => { switched.push(m); return true; },
    setThinkingLevel: (l) => switched.push(l),
    ...(exec ? { exec } : {}),
  };
  minaHandoff(pi, { tuning, readTuning, ...(measure ? { measure } : {}), ...extra });
  const newSessions = [];
  const ctx = {
    aborted: 0, abort() { this.aborted++; },
    cwd: '/nowhere', hasUI: false, usage: { tokens, contextWindow: window }, model, thinkingLevel: 'high',
    modelRegistry: { find: (provider, id) => ({ provider, id }) },
    getContextUsage() { return this.usage; },
    sessionManager: { getBranch: () => branch, getSessionFile: () => file },
    waitForIdle: async () => {},
    newSession: async (opts) => {
      // Like Pi: once the session is replaced, the old ctx is stale and every access to it throws.
      stale = true;
      const made = { custom: [], messages: [] };
      await opts.setup({ appendCustomEntry: (t, d) => made.custom.push({ t, d }), appendMessage: (m) => made.messages.push(m) });
      const nextSent = [];
      await opts.withSession({ hasUI: false, sendUserMessage: async (text, o) => nextSent.push({ text, o }) });
      newSessions.push({ ...made, opts, nextSent });
      return { cancelled: false };
    },
  };
  let stale = false;
  const live = new Proxy(ctx, { get(target, key) {
    if (stale && key !== 'newSession') throw new Error('This extension ctx is stale after session replacement');
    return Reflect.get(target, key);
  } });
  const emit = async (ev, event) => { let out; for (const fn of handlers[ev] ?? []) out = (await fn(event, live)) ?? out; return out; };
  return { pi, tools, commands, sent, entries, ctx: live, emit, newSessions, switched, unstale: () => { stale = false; } };
}

test('handoff carries native receipts and recorded check results without executing checks', async () => {
  const goal = { id: 'g', objective: 'build', status: 'active', completionPolicy: 'checks-only', checkPolicy: 'working',
    checks: [{ id: 'R1', command: 'true' }], lastStatus: { at: '2026-10-15 10:00Z', lines: ['R1: PASS (recorded)'] } };
  const decisions = { instanceId: 'native-instance', records: [{ id: 'operator-step', operatorStatus: 'awaiting_execution' }] };
  const commands = [];
  const f = fake({ file: '/s/old.jsonl', branch: [
    { type: 'custom', customType: 'mina-goal', data: goal },
    { type: 'custom', customType: 'mina-decisions', data: decisions },
  ], extra: { env: { MINA_SANDBOX: '1', MINA_SANDBOX_NET: 'offline', PROBE_API_KEY: 'secret-value' }, sandboxAvailable: true },
  exec: async (_cmd, args) => { commands.push(args[1]); return { code: 0, stdout: '', stderr: '' }; } });
  await f.commands['mina-handoff'].handler('now', f.ctx);
  assert.deepEqual(commands, [], 'context replacement must not execute potentially effectful checks');
  const carried = f.newSessions[0].custom.find((e) => e.t === 'mina-goal').d;
  assert.equal(carried.completionPolicy, 'checks-only');
  assert.deepEqual(carried.lastStatus, goal.lastStatus);
  assert.deepEqual(f.newSessions[0].custom.find((e) => e.t === 'mina-decisions').d, decisions);
  assert.match(f.newSessions[0].messages[0].content, /Agent-selected working checks/);
  assert.match(f.newSessions[0].messages[0].content, /[Hh]andoff did not run/);
  assert.doesNotMatch(goalRestatement(goal), /is frozen|before writing files/);
});

test('handoff refuses to rerun changed protected scripts instead of carrying a misleading pass', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-handoff-check-'));
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true });
  writeFileSync(join(cwd, '.mina', 'checks', 'r.sh'), 'exit 0');
  const goal = { id: 'g', objective: 'build', status: 'active', checks: [{ id: 'R1', command: 'bash .mina/checks/r.sh' }], frozen: { '.mina/checks/r.sh': 'accepted-old-hash' } };
  let executions = 0;
  const f = fake({ file: '/s/old.jsonl', branch: [{ type: 'custom', customType: 'mina-goal', data: goal }],
    exec: async () => { executions++; return { code: 0, stdout: '', stderr: '' }; } });
  f.ctx.cwd = cwd;
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const carried = f.newSessions[0].custom.find((e) => e.t === 'mina-goal').d;
  assert.equal(executions, 0, 'changed protected script must not execute');
  assert.match(carried.lastStatus.lines[0], /NOT RUN.*protected check files changed/);
});

test('below the threshold, input passes through', async () => {
  const f = fake({ tokens: 50_000 });
  assert.equal(await f.emit('input', { source: 'interactive', text: 'hi' }), undefined);
});

test('a goal continuation past the threshold becomes the note request; the note hands off with the goal continued', async () => {
  const goal = { id: 'g1', objective: 'build it', status: 'active', checks: [{ id: 'R1', command: 'pytest -q' }] };
  const f = fake({ tokens: 95_000, branch: [{ type: 'custom', customType: 'mina-goal', data: goal }], file: '/s/old.jsonl' });
  const r = await f.emit('input', { source: 'extension', text: 'Continue the active /goal <!-- pi-goal-continuation:abc -->' });
  assert.deepEqual(r, { action: 'transform', text: NOTE_REQUEST });
  // a second continuation while the note is pending passes untouched; during the handoff, inputs are held
  const res = await f.tools.mina_handoff_note.execute('id', { state: 'tests written', next_actions: ['implement merge()'] }, null, null, f.ctx);
  assert.equal(res.terminate, true);
  assert.equal(f.sent.at(-1).text, '/mina-handoff now');
  assert.deepEqual(await f.emit('input', { source: 'interactive', text: 'also add docs' }), { action: 'handled' });
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const s = f.newSessions[0];
  assert.equal(s.opts.parentSession, '/s/old.jsonl');
  assert.equal(s.custom[0].t, MARKER); assert.equal(s.custom[1].t, 'mina-goal');
  assert.match(s.messages[0].content, /tests written/); assert.match(s.messages[0].content, /implement merge\(\)/); assert.match(s.messages[0].content, /R1: pytest -q/);
  assert.deepEqual(s.nextSent.map((x) => x.text), ['/goal mina-continue', 'also add docs']);
});

test('no note: the fallback packet uses the last compaction summary; user input that triggered it is replayed', async () => {
  const f = fake({ tokens: 95_000, branch: [{ type: 'compaction', summary: 'SUMMARY-123' }], file: '/s/old.jsonl' });
  assert.equal((await f.emit('input', { source: 'interactive', text: 'what next?' })).action, 'transform');
  await f.emit('agent_settled', {});
  assert.equal(f.sent.at(-1).text, '/mina-handoff now');
  await f.commands['mina-handoff'].handler('now', f.ctx);
  assert.match(f.newSessions[0].messages[0].content, /SUMMARY-123/);
  assert.deepEqual(f.newSessions[0].nextSent.map((x) => x.text), ['what next?']);
});

test('a session without a file cannot hand off', async () => {
  const f = fake({ tokens: 95_000, file: null });
  await f.commands['mina-handoff'].handler('now', f.ctx);
  assert.equal(f.newSessions.length, 0);
});

test('a session hands off only after growing past its first-turn size', async () => {
  const f = fake({ tokens: 92_000, file: '/s/old.jsonl' });
  await f.emit('turn_end', {});           // baseline 92K
  assert.equal(await f.emit('input', { source: 'interactive', text: 'go' }), undefined);
  f.ctx.usage = { tokens: 111_000, contextWindow: 131072 };
  assert.equal((await f.emit('input', { source: 'interactive', text: 'go' })).action, 'transform');
});

test('inside a long run, a turn past the threshold steers the note request in, once', async () => {
  const f = fake({ tokens: 9_000, file: '/s/old.jsonl' });
  await f.emit('turn_end', {});            // baseline 9K
  f.ctx.usage = { tokens: 60_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  assert.equal(f.sent.length, 0);
  f.ctx.usage = { tokens: 91_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  assert.deepEqual(f.sent.map((s) => [s.text, s.opts?.deliverAs]), [[NOTE_REQUEST, 'steer']]);
  await f.emit('turn_end', {});
  assert.equal(f.sent.length, 1);
  // the steered request itself passes the input hook untouched
  assert.equal(await f.emit('input', { source: 'extension', text: NOTE_REQUEST, streamingBehavior: 'steer' }), undefined);
});

test('after a compaction draft, the active goal is restated in the same boundary; nothing without one', async () => {
  const goal = { objective: 'build it', status: 'active', checks: [{ id: 'R1', command: 'pytest -q' }] };
  const f = fake({ tokens: 30_000, branch: [{ type: 'custom', customType: 'mina-goal', data: goal }], file: '/s/a.jsonl' });
  assert.equal(await f.emit('agent_before_settle', { entries: [] }), undefined);
  const compaction = { type: 'compaction', summary: 's', firstKeptEntryId: 'e9' };
  const r = await f.emit('agent_before_settle', { entries: [compaction] });
  assert.equal(r.entries[0], compaction);
  assert.equal(r.entries[1].type, 'custom_message'); assert.match(r.entries[1].content, /Objective: build it/); assert.match(r.entries[1].content, /R1: pytest -q/);
  const viaTurn = await f.emit('turn_end', { entries: [compaction] });
  assert.equal(viaTurn.entries.length, 2);
});

test('tuning follows the running model: another model\'s tuning file does not apply', () => {
  const sol = { model: 'openai-codex/gpt-6.1-sol', handoff_at_tokens: 160000 };
  const local = { model: 'local/test-model', handoff_at_tokens: 90000 };
  const read = (name) => (name === 'local__test-model.json' ? local : null);
  assert.equal(tuningForModel(sol, { provider: 'openai-codex', id: 'gpt-6.1-sol' }, read), sol);
  assert.equal(tuningForModel(sol, { provider: 'local', id: 'test-model' }, read), local);
  assert.equal(tuningForModel(sol, { provider: 'x', id: 'y' }, read), null);
  const experiment = { handoff_at_tokens: 5000 };
  assert.equal(tuningForModel(experiment, { provider: 'x', id: 'y' }, read), experiment);
});

test('launched on one model, switched to another: the running model\'s thresholds decide (seen in a test run)', async () => {
  // launched on sol (handoff at 160K of 272K), switched to a local model (131K window, handoff at 90K)
  const local = { model: 'local/test-model', compact_at_tokens: 60000, handoff_at_tokens: 90000, context_window: 131072 };
  const f = fake({ tokens: 10_000, file: '/s/old.jsonl', model: { provider: 'local', id: 'test-model' },
    tuning: { model: 'openai-codex/gpt-6.1-sol', compact_at_tokens: 100000, handoff_at_tokens: 160000, context_window: 272000 },
    readTuning: (n) => (n === 'local__test-model.json' ? local : null) });
  await f.emit('turn_end', {});
  f.ctx.usage = { tokens: 95_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  assert.deepEqual(f.sent.map((s) => s.text), [NOTE_REQUEST]);
});

test('a steered request the run ignores: reminded, and not handed off when the run ends (goal_complete); asked again at the next input', async () => {
  const done = { id: 'g1', objective: 'build it', status: 'complete' };
  const f = fake({ tokens: 9_000, branch: [{ type: 'custom', customType: 'mina-goal', data: done }], file: '/s/old.jsonl' });
  await f.emit('turn_end', {});
  f.ctx.usage = { tokens: 95_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  for (let i = 0; i < REMIND_EVERY; i++) await f.emit('turn_end', {});
  assert.equal(f.sent.filter((s) => s.text === NOTE_REQUEST && s.opts?.deliverAs === 'steer').length, 2);
  await f.emit('agent_settled', {});
  assert.ok(!f.sent.some((s) => s.text === '/mina-handoff now'));
  assert.equal(f.newSessions.length, 0);
  // the user writes again: that boundary asks for the note, and the message is carried to the successor
  assert.equal((await f.emit('input', { source: 'interactive', text: 'thanks, now summarize' })).action, 'transform');
  await f.emit('agent_settled', {});
  assert.equal(f.sent.at(-1).text, '/mina-handoff now');
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const p = f.newSessions[0].messages[0].content;
  assert.match(p, /## Goal \(not active\)/); assert.match(p, /Status: complete/); assert.doesNotMatch(p, /goal continues in this session/);
  assert.deepEqual(f.newSessions[0].nextSent.map((x) => x.text), ['thanks, now summarize']);
});

test('a steered request is withdrawn when a compaction frees the context', async () => {
  const f = fake({ tokens: 9_000, file: '/s/old.jsonl' });
  await f.emit('turn_end', {});
  f.ctx.usage = { tokens: 95_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  f.ctx.usage = { tokens: 40_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  f.ctx.usage = { tokens: 92_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  assert.equal(f.sent.filter((s) => s.text === NOTE_REQUEST).length, 2); // asked afresh, not left pending
});

test('the successor runs on the earlier session\'s model and thinking level', async () => {
  const f = fake({ tokens: 95_000, file: '/s/old.jsonl', model: { provider: 'local', id: 'test-model' } });
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const marker = f.newSessions[0].custom[0];
  assert.deepEqual(marker.d.model, { provider: 'local', id: 'test-model', thinkingLevel: 'high' });
  // the successor's extension instance starts on Pi's default model and switches back
  const g = fake({ model: { provider: 'openai-codex', id: 'gpt-6.1-sol' }, branch: [{ type: 'custom', customType: MARKER, data: marker.d }] });
  await g.emit('session_start', { reason: 'new' });
  assert.deepEqual(g.switched, [{ provider: 'local', id: 'test-model' }, 'high']);
  const h = fake({ model: { provider: 'openai-codex', id: 'gpt-6.1-sol' }, branch: [{ type: 'custom', customType: MARKER, data: marker.d }] });
  await h.emit('session_start', { reason: 'startup' });
  assert.deepEqual(h.switched, []);
});

test('fallback summary: the compaction summary from a line start, plus what the assistant said after it', () => {
  const said = (t) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  const branch = [said('old'), { type: 'compaction', summary: `${'a line of an earlier section\n'.repeat(1000)}SECTION start` }, said('ran checks'), said('all pass')];
  const s = fallbackSummary(branch, 1000);
  assert.match(s, /^a line of an earlier section\n/); assert.match(s, /SECTION start\n\n### Since that summary/); assert.match(s, /ran checks\n\nall pass$/); assert.doesNotMatch(s, /old/);
  assert.ok(s.length <= 1100);
  assert.equal(fallbackSummary([said('x'), said('y')]), 'x\n\ny');
});

test('a user message sent while the note is pending is held and delivered in the successor, not to the full session', async () => {
  const f = fake({ tokens: 9_000, file: '/s/old.jsonl' });
  await f.emit('turn_end', {});
  f.ctx.usage = { tokens: 97_000, contextWindow: 131072 };
  await f.emit('turn_end', {});                    // the note request is steered in
  assert.equal(await f.emit('input', { source: 'extension', text: NOTE_REQUEST, streamingBehavior: 'steer' }), undefined);
  assert.deepEqual(await f.emit('input', { source: 'interactive', text: 'amend the checks' }), { action: 'handled' });
  await f.tools.mina_handoff_note.execute('id', { state: 's', next_actions: ['n'] }, null, null, f.ctx);
  await f.commands['mina-handoff'].handler('now', f.ctx);
  assert.deepEqual(f.newSessions[0].nextSent.map((x) => x.text), ['amend the checks']);
});

test('the run ends without a note but the user wrote meanwhile: hand off and deliver the message there', async () => {
  const f = fake({ tokens: 9_000, file: '/s/old.jsonl' });
  await f.emit('turn_end', {});
  f.ctx.usage = { tokens: 97_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  await f.emit('input', { source: 'interactive', text: 'and then this' });
  await f.emit('agent_settled', {});
  assert.equal(f.sent.at(-1).text, '/mina-handoff now');
});

// IV-1g, 2026-10-19: a goal-less run was handed off mid-loop and the successor sat idle with only the packet.
async function midRunHandoff({ stopReason, branch = [] }) {
  const f = fake({ tokens: 9_000, file: '/s/old.jsonl', branch });
  await f.emit('turn_end', { message: { role: 'assistant', stopReason: 'toolUse' } });
  f.ctx.usage = { tokens: 97_000, contextWindow: 131072 };
  await f.emit('turn_end', { message: { role: 'assistant', stopReason } });
  assert.equal(f.sent.at(-1).text, NOTE_REQUEST);
  await f.tools.mina_handoff_note.execute('id', { state: 's', next_actions: ['n'] }, null, null, f.ctx);
  await f.commands['mina-handoff'].handler('now', f.ctx);
  return f.newSessions[0].nextSent.map((x) => x.text);
}

test('without a goal, a run interrupted in its tool loop is resumed in the successor', async () => {
  assert.deepEqual(await midRunHandoff({ stopReason: 'toolUse' }), [RESUME_REQUEST]);
});

test('without a goal, a run that was finishing its turn is not resumed: the successor waits for the user', async () => {
  assert.deepEqual(await midRunHandoff({ stopReason: 'stop' }), []);
});

test('with an active goal, an interrupted run continues through the goal only, not twice', async () => {
  const goal = { id: 'g', objective: 'build', status: 'active', checks: [] };
  assert.deepEqual(await midRunHandoff({ stopReason: 'toolUse', branch: [{ type: 'custom', customType: 'mina-goal', data: goal }] }), ['/goal mina-continue']);
});

test('a handoff the user starts with /mina-handoff does not resume work by itself', async () => {
  const f = fake({ tokens: 9_000, file: '/s/old.jsonl' });
  await f.emit('turn_end', { message: { role: 'assistant', stopReason: 'toolUse' } });
  await f.commands['mina-handoff'].handler('now', f.ctx);
  assert.deepEqual(f.newSessions[0].nextSent, []);
});

test('after a restart, /mina-handoff uses the note saved in the session instead of the fallback summary', async () => {
  const saved = { state: 'checks accepted, pipeline next', next_actions: ['build all_series.csv'] };
  const f = fake({ tokens: 95_000, file: '/s/old.jsonl', branch: [{ type: 'compaction', summary: 'OLD SUMMARY' }, { type: 'custom', customType: 'mina-handoff-note', data: saved }] });
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const p = f.newSessions[0].messages[0].content;
  assert.match(p, /checks accepted, pipeline next/); assert.match(p, /build all_series\.csv/); assert.doesNotMatch(p, /OLD SUMMARY/);
  assert.equal(f.newSessions[0].custom[0].d.note, true);
});

const POOL = { compact_at_tokens: 60000, handoff_at_tokens: 90000, context_window: 131072,
  pool: { tokens: 131072, reply_reserve_tokens: 20000, compaction_reserve_tokens: 20000, subagent_reserve_tokens: 20000 } };

test('pool budget: room for replies, compaction and each subagent', () => {
  const p = poolBudget(POOL);
  assert.equal(poolBudget({}), null);
  assert.deepEqual([poolCap(p, 0), poolCap(p, 1), poolCap(p, 2)], [91072, 71072, 51072]);
  const t = thresholds(POOL, 131072);
  assert.equal(poolThresholds(t, p, 0).handoffAt, 90000);
  assert.deepEqual(poolThresholds(t, p, 2), { compactAt: 51072, handoffAt: 51072, maxCompactions: 2 });
  assert.deepEqual(spawnFits(p, 56000, 0), { ok: true, projected: 116000, pool: 131072 });
  assert.equal(spawnFits(p, 56000, 1).ok, false);   // the second subagent of this run's 19:35 spawn
  assert.equal(spawnFits(null, 1e9, 9).ok, true);
});

test('a subagent that would not fit in the shared pool is refused; one that fits is allowed', async () => {
  const f = fake({ tokens: 56_000, file: '/s/a.jsonl', tuning: POOL });
  assert.equal(await f.emit('tool_call', { toolName: 'Agent', input: {} }), undefined);
  const r = await f.emit('tool_call', { toolName: 'Agent', input: {} });
  assert.equal(r.block, true); assert.match(r.reason, /136000 tokens/);
  assert.equal(await f.emit('tool_call', { toolName: 'bash', input: {} }), undefined);
  const g = fake({ tokens: 56_000, file: '/s/a.jsonl' });   // no pool in the tuning: no guard
  await g.emit('tool_call', { toolName: 'Agent', input: {} });
  assert.equal(await g.emit('tool_call', { toolName: 'Agent', input: {} }), undefined);
});

test('running subagents lower the handoff threshold', async () => {
  const f = fake({ tokens: 9_000, file: '/s/a.jsonl', tuning: POOL });
  await f.emit('turn_end', {});
  f.ctx.usage = { tokens: 75_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  assert.equal(f.sent.length, 0);                    // 75K < 90K
  f.pi.events.emit('subagents:started', { id: 'a1' });
  await f.emit('turn_end', {});
  assert.deepEqual(f.sent.map((x) => x.text), [NOTE_REQUEST]);   // cap 71K with one subagent
});

test('the handoff waits for running subagents, carries their results, then goes', async () => {
  const f = fake({ tokens: 95_000, file: '/s/a.jsonl', tuning: POOL });
  f.pi.events.emit('subagents:started', { id: 'a1' });
  await f.tools.mina_handoff_note.execute('id', { state: 's', next_actions: ['n'] }, null, null, f.ctx);
  assert.ok(!f.sent.some((x) => x.text === '/mina-handoff now'));
  f.pi.events.emit('subagents:completed', { id: 'a1', description: 'Carry strategy family delegate', status: 'completed', result: 'headline carry_z252: ExSh 0.21' });
  assert.equal(f.sent.at(-1).text, '/mina-handoff now');
  await f.commands['mina-handoff'].handler('now', f.ctx);
  assert.match(f.newSessions[0].messages[0].content, /Subagent "Carry strategy family delegate" completed: headline carry_z252/);
});

test('a manual /mina-handoff waits for running subagents unless forced', async () => {
  const f = fake({ tokens: 95_000, file: '/s/a.jsonl', tuning: POOL });
  f.pi.events.emit('subagents:started', { id: 'a1' });
  await f.commands['mina-handoff'].handler('now', f.ctx);
  assert.equal(f.newSessions.length, 0);
  f.unstale();
  await f.commands['mina-handoff'].handler('force', f.ctx);
  assert.equal(f.newSessions.length, 1);
});

// A fake pi-subagents registry with one child whose session reports `tokens` and `turns`.
function fakeChild({ id = 'a1', tokens = 5000, turns = 3, type = 'delegate', description = 'Carry strategy family delegate' } = {}) {
  const rec = { id, type, description, status: 'running', toolUses: 7, compactionCount: 0,
    session: { getContextUsage: () => ({ tokens }), messages: Array.from({ length: turns }, () => ({ role: 'assistant' })) } };
  globalThis[Symbol.for('pi-subagents:manager')] = { getRecord: (x) => (x === id ? rec : undefined) };
  return rec;
}

test('subagent status: limits from the agent file, warnings at 80%', async () => {
  const { maxTurnsFor, childStatus, nearLimits, describeChild, warningText, limitsText, reserveUnits } = await import('../extensions/handoff/subagents.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'mina-agents-'));
  writeFileSync(join(dir, 'delegate.md'), '---\nname: delegate\nmax_turns: 40\n---\nbody\n');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'agents'));
  writeFileSync(join(dir, 'agents', 'delegate.md'), '---\nname: delegate\nmax_turns: 40\n---\nbody\n');
  assert.equal(maxTurnsFor('delegate', { agentDir: dir }), 40);
  assert.equal(maxTurnsFor('other', { agentDir: dir }), null);
  const c = childStatus(fakeChild({ tokens: 17_000, turns: 33 }), { budget: 20_000, maxTurns: 40 });
  assert.deepEqual(nearLimits(c), ['tokens', 'turns']);
  assert.deepEqual(nearLimits({ ...c, tokens: 10_000, turns: 5 }), []);
  assert.match(describeChild(c), /context 17K of its 20K budget, turn 33 of 40, 7 tool calls/);
  assert.match(warningText(c, ['tokens']), /context is 17K, near its 20K share[^]*all fail[^]*let it finish/);
  assert.doesNotMatch(warningText(c, ['tokens']), /work in progress is lost/);
  assert.match(warningText(c, ['turns']), /turn 33 of 40: at the limit it stops; saved files and partial reports remain/);
  assert.match(limitsText({ budget: 20_000, maxTurns: 40 }), /without compaction, handoff[^]*20K tokens: past it the subagent keeps working[^]*after 40 turns; saved files and partial reports remain/);
  assert.equal(reserveUnits({ tokens: 45_000 }, 20_000), 3);
  assert.equal(reserveUnits({ tokens: null }, 20_000), 1);
});

test('the main agent is warned once when a subagent nears its budget, and can see every subagent', async () => {
  const f = fake({ tokens: 30_000, file: '/s/a.jsonl', tuning: POOL });
  const rec = fakeChild({ tokens: 12_000 });
  await f.emit('turn_end', {});                                  // baseline
  f.pi.events.emit('subagents:started', { id: 'a1' });
  await f.emit('turn_end', {});
  assert.equal(f.sent.length, 0);
  rec.session.getContextUsage = () => ({ tokens: 17_000 });
  await f.emit('turn_end', {});
  await f.emit('turn_end', {});
  const warnings = f.sent.filter((x) => /subagent "Carry strategy family delegate": its context is 17K, near its 20K share/.test(x.text));
  assert.equal(warnings.length, 1); assert.equal(warnings[0].opts.deliverAs, 'steer');
  const r = await f.tools.mina_subagents.execute('id', {}, null, null, f.ctx);
  assert.match(r.content[0].text, /"Carry strategy family delegate" \(delegate, running\): context 17K of its 20K budget[^]*near its limit/);
  assert.match(r.content[0].text, /Shared memory: about 47K of 131K/);
  delete globalThis[Symbol.for('pi-subagents:manager')];
});

test('an oversized subagent takes more of the pool; starting a subagent tells the main agent its limits', async () => {
  const f = fake({ tokens: 40_000, file: '/s/a.jsonl', tuning: POOL });
  fakeChild({ tokens: 45_000 });                                  // 3 reserves
  f.pi.events.emit('subagents:started', { id: 'a1' });
  const r = await f.emit('tool_call', { toolName: 'Agent', input: {} });   // 40K + 40K + 4 x 20K = 160K > 131K
  assert.equal(r?.block, true);
  const res = await f.emit('tool_result', { toolName: 'Agent', isError: false, input: { subagent_type: 'delegate' }, content: [{ type: 'text', text: 'Agent started in background.' }] });
  assert.equal(res.content.length, 2); assert.match(res.content[1].text, /without compaction, handoff or goal rules[^]*20K tokens: past it the subagent keeps working/);
  await f.emit('session_shutdown', {});
  delete globalThis[Symbol.for('pi-subagents:manager')];
});

test('measurements: a compaction with its size after, a failed job, a handoff; and the per-model summary', async () => {
  const seen = [];
  const f = fake({ tokens: 30_000, file: '/s/a.jsonl', model: { provider: 'local', id: 'test-model' }, measure: (e) => seen.push(e) });
  await f.emit('session_start', { reason: 'startup' });
  await f.emit('turn_end', {});
  f.pi.events.emit('pi-footer:update-widget', { widgetId: 'hot_compact_job', value: 'compacting…' });
  f.pi.events.emit('pi-footer:update-widget', { widgetId: 'hot_compact_job', value: 'failed' });
  f.ctx.usage = { tokens: 70_000, contextWindow: 131072 };
  await f.emit('turn_end', { entries: [{ type: 'compaction', summary: 'x [Semantic Checkpoint] y', details: { source: 'hot' } }] });   // a draft: no tokensBefore
  assert.ok(!seen.some((e) => e.kind === 'compaction'));       // not yet: its effect shows at the next turn
  f.ctx.usage = { tokens: 43_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const kinds = seen.map((e) => e.kind);
  assert.deepEqual(kinds, ['session_start', 'compaction_failed', 'compaction', 'handoff']);
  const c = seen.find((e) => e.kind === 'compaction');
  assert.deepEqual([c.tokens_before, c.tokens_after, c.semantic, c.source, c.model], [70000, 43000, true, 'hot', 'local/test-model']);
  const { summarize } = await import('../extensions/handoff/metrics.mjs');
  const [row] = summarize(seen);
  assert.equal(row.model, 'local/test-model');
  assert.deepEqual([row.compactions, row.model_written, row.failed_jobs, row.handoffs, row.median_tokens_after], [1, 1, 1, 1, 43000]);
});

test('no handoff decision at the boundary that commits a compaction: the size is from before it', async () => {
  const f = fake({ tokens: 9_000, file: '/s/a.jsonl' });
  await f.emit('turn_end', {});
  f.ctx.usage = { tokens: 91_000, contextWindow: 131072 };
  await f.emit('turn_end', { entries: [{ type: 'compaction', tokensBefore: 91_000, summary: 's' }] });
  assert.equal(f.sent.length, 0);
  f.ctx.usage = { tokens: 48_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  assert.equal(f.sent.length, 0);                       // compacted to 48K: no handoff
  f.ctx.usage = { tokens: 91_000, contextWindow: 131072 };
  await f.emit('turn_end', {});
  assert.deepEqual(f.sent.map((x) => x.text), [NOTE_REQUEST]);
});

test('after the note, a run woken in the old session (a subagent finished) is stopped; its result goes into the packet', async () => {
  const f = fake({ tokens: 95_000, file: '/s/a.jsonl', tuning: POOL });
  f.pi.events.emit('subagents:started', { id: 'b1' });
  f.pi.events.emit('subagents:started', { id: 'b2' });
  await f.emit('agent_start', {});
  assert.equal(f.ctx.aborted, 0);                                 // before the note: runs are normal
  await f.tools.mina_handoff_note.execute('id', { state: 's', next_actions: ['n'] }, null, null, f.ctx);
  f.pi.events.emit('subagents:completed', { id: 'b1', description: 'B1 overlay', status: 'completed', result: 'overlay ExSh 0.41' });
  await f.emit('agent_start', {});                                // the completion message starts a run
  assert.equal(f.ctx.aborted, 1);
  assert.ok(!f.sent.some((x) => x.text === '/mina-handoff now'));  // B2 still running
  f.pi.events.emit('subagents:completed', { id: 'b2', description: 'B2 futures', status: 'completed', result: 'futures sweep done' });
  assert.equal(f.sent.at(-1).text, '/mina-handoff now');
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const p = f.newSessions[0].messages[0].content;
  assert.match(p, /B1 overlay" completed: overlay ExSh 0\.41/); assert.match(p, /B2 futures" completed: futures sweep done/);
});

test('the packet lists the subagents that finished in the earlier session, also after a restart', async () => {
  const rec = { type: 'custom', customType: 'subagents:record', data: { id: 'x', description: 'B2 micro_futures candidate family', status: 'completed', result: 'Headline mf_vt0.08,\n pre-2016 ExSh 0.58' } };
  const f = fake({ tokens: 95_000, file: '/s/a.jsonl', branch: [rec, { type: 'custom', customType: 'mina-handoff-note', data: { state: 's', next_actions: ['n'] } }] });
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const p = f.newSessions[0].messages[0].content;
  assert.match(p, /## Subagents that finished in the earlier session\n- "B2 micro_futures candidate family" \(completed\): Headline mf_vt0\.08, pre-2016 ExSh 0\.58/);
  assert.match(p, /mina_recall/);
});

test('the packet and post-compaction restatement preserve the plan and recorded check status', async () => {
  const { mkdirSync } = await import('node:fs');
  const cwd = mkdtempSync(join(tmpdir(), 'mina-plan-'));
  mkdirSync(join(cwd, '.mina'));
  writeFileSync(join(cwd, '.mina', 'plan.md'), '- [x] carry family\n- [ ] build results/series/all_series.csv (run_all.py --series)\n');
  const goal = { objective: 'build it', status: 'active', checks: [{ id: 'R1', command: 'python r1.py' }], lastStatus: { at: 'old', lines: ['R1: FAIL - old'] } };
  const exec = async () => { throw new Error('handoff must not rerun a check'); };
  const f = fake({ tokens: 95_000, file: '/s/a.jsonl', exec, branch: [{ type: 'custom', customType: 'mina-goal', data: goal }, { type: 'custom', customType: 'mina-handoff-note', data: { state: 's', next_actions: ['n'] } }] });
  f.ctx.cwd = cwd;
  const r = await f.emit('turn_end', { entries: [{ type: 'compaction', summary: 's' }] });
  assert.match(r.entries[1].content, /Check status \(old\):\n- R1: FAIL - old/); assert.match(r.entries[1].content, /Your plan \(\.mina\/plan\.md\):\n- \[x\] carry family/);
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const p = f.newSessions[0].messages[0].content;
  assert.match(p, /Check status \(old\):\n- R1: FAIL - old/);
  assert.match(p, /Handoff did not run these checks/);
  assert.match(p, /## Plan \(\.mina\/plan\.md, kept by the agent\)\n- \[x\] carry family/);
  assert.deepEqual(f.newSessions[0].custom[1].d.lastStatus, goal.lastStatus);
  assert.equal(goal.lastStatus.at, 'old');                          // the session's own entry is not modified
});

test('a read-only subagent is described as such at launch: it returns its result, the main agent saves it', async () => {
  const { toolsFor, canWrite, limitsText } = await import('../extensions/handoff/subagents.mjs');
  const { mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'mina-agents-'));
  mkdirSync(join(dir, 'agents'));
  writeFileSync(join(dir, 'agents', 'independent.md'), '---\nname: independent\ntools: read, grep, find, ls\n---\nbody\n');
  writeFileSync(join(dir, 'agents', 'delegate.md'), '---\nname: delegate\ntools: read, bash, edit, write\nmax_turns: 40\n---\n');
  assert.deepEqual(toolsFor('independent', { agentDir: dir }), ['read', 'grep', 'find', 'ls']);
  assert.equal(canWrite(toolsFor('independent', { agentDir: dir })), false);
  assert.equal(canWrite(toolsFor('delegate', { agentDir: dir })), true);
  assert.equal(canWrite(null), true);
  const ro = limitsText({ budget: 20_000, maxTurns: null, tools: ['read', 'grep', 'find', 'ls'] });
  assert.match(ro, /can only read \(tools: read, grep, find, ls\): it cannot write files, so it returns its result to you/);
  assert.doesNotMatch(ro, /written to files it owns/);
  assert.match(limitsText({ budget: 20_000, maxTurns: 40, tools: ['read', 'write'] }), /one deliverable written to files it owns/);
});

test('context continuity carries open questions without reinstating retired doubt gates', async () => {
  const { mkdirSync } = await import('node:fs');
  const cwd = mkdtempSync(join(tmpdir(), 'mina-doubts-'));
  mkdirSync(join(cwd, '.mina'));
  writeFileSync(join(cwd, '.mina', 'doubts.md'), '# Doubts\n\n- [ ] D4 (t): "a latency of -11.29 ms is implausible"\n- [x] D5 (t): "retry rate 26%/min is too high"\n  not a result: backoff added in src/client.py\n');
  const goal = { objective: 'build it', status: 'active', checks: [{ id: 'R1', command: 'x' }] };
  const f = fake({ tokens: 95_000, file: '/s/a.jsonl', branch: [{ type: 'custom', customType: 'mina-goal', data: goal },
    { type: 'custom', customType: 'mina-handoff-note', data: { state: 's', next_actions: ['n'], open_questions: ['Why is the latency -11.29 ms?'] } }] });
  f.ctx.cwd = cwd;
  const r = await f.emit('turn_end', { entries: [{ type: 'compaction', summary: 's' }] });
  assert.doesNotMatch(r.entries[1].content, /Open doubts|close each with a test|mina_close_doubt/);
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const packet = f.newSessions[0].messages[0].content;
  assert.doesNotMatch(packet, /Open doubts|close each with a test|mina_close_doubt/);
  assert.match(packet, /Open questions[^]*Why is the latency -11\.29 ms/);
});

test('a goal whose objective is a file: the packet and the restatement name the file and say to read it again', async () => {
  const { goalRestatement } = await import('../extensions/handoff/policy.mjs');
  const goal = { status: 'active', objective: '~/g/pass3.md', objective_file: '/home/u/g/pass3.md', checks: [], settled: false };
  const r = goalRestatement(goal);
  assert.match(r, /Objective: the text of the file \/home\/u\/g\/pass3\.md[^]*read it again/);
  const p = renderPacket({ note: null, goal, fallback: 'x', parentFile: '/s/a.jsonl' });
  assert.match(p, /## Goal\nThe text of the file \/home\/u\/g\/pass3\.md[^]*read it again/);
});

test('a finished subagent result stays reachable: mina_subagents lists it and returns it by id; mina_recall finds it', async () => {
  // A test run: the cache_layer audit found a confirmed race condition. Its report was written
  // only as a `subagents:record` entry, which the model does not see; pi-subagents had removed the agent ("Agent not
  // found... cleaned up"), context_recall does not index custom entries, so the agent re-ran the audit, report unseen.
  const result = '## Audit Report: cache_layer\n**Race condition (MAJOR, confirmed empirically)**: read(t) sees write(t+2)\nVERDICT: CONCERNS';
  const branch = [{ type: 'custom', customType: 'subagents:record', id: 'r1', data: { id: 'a1b2c3d4-5e6f-4b1', type: 'delegate',
    description: 'Audit cache_layer for race conditions', status: 'completed', result } }];
  const f = fake({ branch, file: '/s/a.jsonl' });
  const list = await f.tools.mina_subagents.execute('id', {}, null, null, f.ctx);
  assert.match(list.content[0].text, /Finished in this session[^]*a1b2c3d4-5e6f-4b1[^]*Audit cache_layer for race conditions[^]*completed[^]*VERDICT: CONCERNS/);
  const one = await f.tools.mina_subagents.execute('id', { id: 'a1b2c3d4-5e6f-4b1' }, null, null, f.ctx);
  assert.match(one.content[0].text, /read\(t\) sees write\(t\+2\)\nVERDICT: CONCERNS/);
  const { entryText } = await import('../extensions/handoff/recall.mjs');
  assert.match(entryText(branch[0]), /subagent a1b2c3d4-5e6f-4b1 \(Audit cache_layer for race conditions, completed\): [^]*race condition/i);
});

test('when a subagent finishes, mina tells the agent where its result is (pi-subagents can hold a batch result forever)', async () => {
  // Two audits started as one batch; one result was taken with get_subagent_result, so the batch never completed and the
  // other report (a confirmed race condition) was never delivered.
  const f = fake({ file: '/s/a.jsonl' });
  await f.emit('turn_end', {});
  f.pi.events.emit('subagents:completed', { id: 'a1b2c3d4', description: 'Audit cache_layer for race conditions', status: 'completed',
    result: 'Race condition (MAJOR)...\nVERDICT: CONCERNS' });
  const note = f.sent.find((x) => /subagent "Audit cache_layer for race conditions" \(a1b2c3d4\) finished[^]*VERDICT: CONCERNS[^]*mina_subagents[^]*a1b2c3d4/.test(x.text));
  assert.ok(note, JSON.stringify(f.sent)); assert.equal(note.opts.deliverAs, 'steer');
  f.pi.events.emit('subagents:failed', { id: 'b2', description: 'x', status: 'error', error: 'out of turns' });
  assert.ok(f.sent.some((x) => /subagent "x" \(b2\) failed: out of turns/.test(x.text)));
});

test('with keep_reasoning_turns in the tuning, each request carries reasoning only from the last N assistant messages', async () => {
  const think = (n) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: `t${n}` }, { type: 'toolCall', id: `c${n}`, name: 'bash', arguments: {} }] });
  const messages = [{ role: 'user', content: 'go' }, think(1), think(2), think(3)];
  const on = fake({ tuning: { keep_reasoning_turns: 1, context_window: 131072 } });
  const r = await on.emit('context', { messages });
  assert.deepEqual(r.messages.map((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'thinking').length : -1)), [-1, 0, 0, 1]);
  const off = fake({});
  assert.equal(await off.emit('context', { messages }), undefined);                     // no setting: requests unchanged
});

test('a goal pi-goal blocked is handed off as blocked, not continued (blocked, then active again seconds later)', async () => {
  const goal = { id: 'g1', objective: 'build it', status: 'active', checks: [{ id: 'R1', command: 'pytest -q' }] };
  const branch = [{ type: 'custom', customType: 'mina-goal', data: goal },
    { type: 'custom', customType: 'goal-state', data: { goal: { id: 'u1', status: 'active' } } },
    { type: 'custom', customType: 'goal-state', data: { goal: { id: 'u1', status: 'blocked' } } }];
  const f = fake({ tokens: 95_000, branch, file: '/s/old.jsonl' });
  await f.tools.mina_handoff_note.execute('id', { state: 'waiting on the operator', next_actions: ['ask'] }, null, null, f.ctx);
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const s = f.newSessions[0];
  assert.ok(!s.nextSent.some((x) => x.text === '/goal mina-continue'));
  assert.match(s.messages[0].content, /## Goal \(not active\)[^]*Status: blocked in the earlier session[^]*\/goal resume/);
  assert.equal(goal.status, 'active');                                                   // the earlier session's record is untouched
});

test('carriedGoal: pi-goal blocked or paused wins over a stale active record; complete and active do not change it', async () => {
  const { carriedGoal } = await import('../extensions/handoff/policy.mjs');
  const g = { id: 'g', status: 'active' };
  assert.deepEqual(carriedGoal(g, { status: 'paused' }), { id: 'g', status: 'paused', resume_on_request: true });
  assert.deepEqual(carriedGoal(g, { status: 'active' }), g);
  assert.deepEqual(carriedGoal(g, null), g);
  assert.deepEqual(carriedGoal({ id: 'g', status: 'cleared' }, { status: 'blocked' }), { id: 'g', status: 'cleared' });
  assert.equal(carriedGoal(null, { status: 'blocked' }), null);
});

// Seen in a long run: the note was written, the handoff never ran, and every message the user typed was
// held for 40 minutes. A held message must not wait past the stall limit, nor for subagents that already finished.
test('a handoff that does not start within the stall limit is abandoned, and the held messages are delivered here', async () => {
  let t = 1_000_000;
  const f = fake({ tokens: 95_000, file: '/s/a.jsonl', extra: { now: () => t, stallMs: 120_000 } });
  await f.tools.mina_handoff_note.execute('id', { state: 's', next_actions: ['n'] }, null, null, f.ctx);
  assert.equal(f.sent.at(-1).text, '/mina-handoff now');                                  // queued, but it never runs
  t += 30_000;
  assert.deepEqual(await f.emit('input', { source: 'interactive', text: 'Stop preparing. Run the first GPU arm.' }), { action: 'handled' });
  t += 100_000;
  assert.equal(await f.emit('input', { source: 'interactive', text: 'did that go through?' }), undefined); // delivered as typed
  assert.deepEqual(f.sent.slice(-1).map((x) => [x.text, x.opts.deliverAs]), [['Stop preparing. Run the first GPU arm.', 'steer']]);
  // back to normal: with the context still full, the next message starts a fresh handoff attempt (new stall timer)
  assert.equal((await f.emit('input', { source: 'interactive', text: 'and this' }))?.action, 'transform');
});

// Seen in a long run: the note waited 12 min for a subagent. "Contiue", typed meanwhile, went to the old session, whose
// run mina stopped at once (agent_start): the message was lost and the goal blocked. A 120 s stall had also abandoned
// the handoff while the subagent still ran.
test('while the handoff waits for a running subagent, typed messages are held for the successor, past the stall limit', async () => {
  let t = 1_000_000;
  const f = fake({ tokens: 95_000, file: '/s/a.jsonl', tuning: POOL, extra: { now: () => t, stallMs: 120_000 } });
  f.pi.events.emit('subagents:started', { id: 'a1' });
  const reg = Symbol.for('pi-subagents:manager');
  let status = 'running';
  globalThis[reg] = { getRecord: (id) => ({ id, status, type: 'delegate' }) };
  try {
    await f.tools.mina_handoff_note.execute('id', { state: 's', next_actions: ['n'] }, null, null, f.ctx);
    assert.ok(!f.sent.some((x) => x.text === '/mina-handoff now'));
    t += 10 * 60_000;
    assert.deepEqual(await f.emit('input', { source: 'interactive', text: 'Contiue' }), { action: 'handled' });
    assert.equal(f.sent.length, 0);                                                        // not abandoned, nothing delivered here
    status = 'completed';
    f.pi.events.emit('subagents:completed', { id: 'a1', description: 'audit', status: 'completed', result: 'done' });
    assert.equal(f.sent.at(-1).text, '/mina-handoff now');
    t += 30_000;
    assert.deepEqual(await f.emit('input', { source: 'interactive', text: 'and this' }), { action: 'handled' }); // the stall clock restarted
    await f.commands['mina-handoff'].handler('now', f.ctx);
    assert.deepEqual(f.newSessions[0].nextSent.map((x) => x.text), ['Contiue', 'and this']);
  } finally { delete globalThis[reg]; }
});

test('without a subagent registry, a waiting handoff still stalls out (a stale running count must not hold messages forever)', async () => {
  let t = 1_000_000;
  const f = fake({ tokens: 95_000, file: '/s/a.jsonl', tuning: POOL, extra: { now: () => t, stallMs: 120_000 } });
  f.pi.events.emit('subagents:started', { id: 'a1' });                                     // never finishes, no registry to ask
  await f.tools.mina_handoff_note.execute('id', { state: 's', next_actions: ['n'] }, null, null, f.ctx);
  t += 130_000;
  assert.equal(await f.emit('input', { source: 'interactive', text: 'hello?' }), undefined);
});

test('a goal blocked only because mina stopped its run during the handoff continues in the successor', async () => {
  const goal = { id: 'g1', objective: 'build it', status: 'active' };
  const branch = [{ type: 'custom', customType: 'mina-goal', data: goal },
    { type: 'custom', customType: 'goal-state', data: { goal: { id: 'u1', status: 'active' } } }];
  const f = fake({ tokens: 95_000, branch, file: '/s/old.jsonl' });
  await f.tools.mina_handoff_note.execute('id', { state: 's', next_actions: ['n'] }, null, null, f.ctx);
  assert.equal(globalThis[Symbol.for('mina:handoff')].pending(), true);
  await f.emit('agent_start', {});                                                         // a host alarm or /goal resume run
  assert.equal(f.ctx.aborted, 1);
  branch.push({ type: 'custom', customType: 'goal-state', data: { goal: { id: 'u1', status: 'blocked' } } }); // pi-goal: "error"
  await f.commands['mina-handoff'].handler('now', f.ctx);
  const s = f.newSessions[0];
  assert.ok(s.nextSent.some((x) => x.text === '/goal mina-continue'));
  assert.doesNotMatch(s.messages[0].content, /not active/);
});

test('stoppedByMina: a later change of the goal after mina\'s stop is kept', async () => {
  const { stoppedByMina } = await import('../extensions/handoff/index.js');
  const st = (status, id = 'u1') => ({ goal: { id, status } });
  const stop = { id: 'u1', entries: 1 };
  assert.equal(stoppedByMina([st('active'), st('blocked')], stop).status, 'active');
  assert.equal(stoppedByMina([st('active'), st('blocked')], null).status, 'blocked');           // no stop by mina
  assert.equal(stoppedByMina([st('active'), st('blocked'), st('paused')], stop).status, 'paused'); // the user paused it after
  assert.equal(stoppedByMina([st('active'), st('blocked'), st('active'), st('blocked')], stop).status, 'blocked'); // resumed, then blocked again on its own
  assert.equal(stoppedByMina([st('active'), st('blocked', 'u2')], stop).status, 'blocked');     // another goal
});

test('a subagent the registry shows as finished does not hold the handoff (a missed finish event)', async () => {
  const f = fake({ tokens: 95_000, file: '/s/a.jsonl', tuning: POOL });
  f.pi.events.emit('subagents:started', { id: 'a1' });                                    // its finish event never arrives
  const reg = Symbol.for('pi-subagents:manager');
  globalThis[reg] = { getRecord: (id) => ({ id, status: 'completed', type: 'delegate' }) };
  try {
    await f.tools.mina_handoff_note.execute('id', { state: 's', next_actions: ['n'] }, null, null, f.ctx);
    assert.equal(f.sent.at(-1).text, '/mina-handoff now');
  } finally { delete globalThis[reg]; }
});


test('the handoff packet header keeps only the facts when goal_prompt is minimal', async () => {
  const { renderPacket } = await import('../extensions/handoff/policy.mjs');
  assert.match(renderPacket({ parentFile: '/s/a', minimal: true }), /^# mina handoff packet\nThis session continues an earlier one, handed off when its context was full\. mina_recall searches the earlier sessions\./);
  assert.match(renderPacket({ parentFile: '/s/a' }), /not proof/);
});

test('the handoff request pauses only the conversation: running jobs keep running and are recorded, not stopped or awaited', () => {
  // "Stop the current work" invited cancelling or idling on long broker jobs, which keep running
  // under their own supervision and report to the successor session.
  assert.doesNotMatch(NOTE_REQUEST, /Stop the current work/i);
  assert.match(NOTE_REQUEST, /do not stop, cancel or wait for/i);
  assert.match(NOTE_REQUEST, /running jobs?[^.]*IDs?/i);
  assert.match(NOTE_REQUEST, /mina_handoff_note once/);
  assert.match(NOTE_REQUEST, /500 words/);
});

test('the shipped tuning files: Claude compacts at 250K, Sol at 200K and hands off below its 272K price tier', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (f) => JSON.parse(readFileSync(new URL(`../models/${f}.json`, import.meta.url), 'utf8'));
  const claude = read('claude-sdk__claude-opus-5-5'), sol = read('openai-codex__gpt-6.1-sol');
  assert.deepEqual(thresholds(claude), { compactAt: 250000, handoffAt: 350000, maxCompactions: 2 });
  assert.deepEqual(thresholds(sol), { compactAt: 200000, handoffAt: 265000, maxCompactions: 2 });
  const c = hotCompactConfig({}, sol, sol.context_window);
  assert.ok(c.hardPercent * sol.context_window / 100 < 265000 && 265000 < 272000);
});
