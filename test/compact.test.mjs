import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { createMinaCompact } from '../extensions/compact/mina-compact.mjs';

// Exercise the real pinned extension, without model requests or production config changes.
const { default: hotCompact } = await createJiti(import.meta.url).import('../node_modules/pi-hot-compact/index.ts');
const local = { model: 'local/test-model', context_window: 131072,
  compact_at_tokens: 60000, handoff_at_tokens: 90000, hot_compact: { startPercent: 35, hardPercent: 58 } };
const sol = { model: 'openai-codex/gpt-6.1-sol', context_window: 272000, compact_at_tokens: 160000, handoff_at_tokens: 220000 };

async function fixture(run, { managed = true, user = {}, readTuning = () => sol } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mina-compact-'));
  const keys = ['PI_HOT_COMPACT_CONFIG', 'MINA_HOT_COMPACT_MANAGED', 'PI_CODING_AGENT_DIR', 'XDG_CACHE_HOME'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const startup = join(dir, 'startup.json');
  writeFileSync(startup, JSON.stringify({ semantic: false, startPercent: 35, hardPercent: 58 }));
  writeFileSync(join(dir, 'hot-compact.json'), JSON.stringify({ semantic: false, ...user }));
  Object.assign(process.env, { PI_HOT_COMPACT_CONFIG: startup, MINA_HOT_COMPACT_MANAGED: managed ? '1' : '0',
    PI_CODING_AGENT_DIR: dir, XDG_CACHE_HOME: dir });
  const handlers = {}, commands = {}, notes = [], tools = {}, branch = [];
  const pi = {
    on: (event, fn) => { (handlers[event] ??= []).push(fn); },
    registerCommand: (name, command) => { commands[name] = command; },
    registerTool: (tool) => { tools[tool.name] = tool; },
    events: { emit: () => {} },
  };
  const ctx = { cwd: dir, hasUI: true, model: { provider: 'local', id: 'test-model', contextWindow: 131072 },
    sessionManager: { getBranch: () => branch }, getContextUsage: () => ({ tokens: 1000, percent: 1, contextWindow: ctx.model.contextWindow }),
    ui: { setStatus: () => {}, notify: (text) => notes.push(text) } };
  const emit = async (event, data = {}) => { for (const fn of handlers[event] ?? []) await fn(data, ctx); };
  createMinaCompact(pi, { hotCompact, tuning: local, readTuning });
  try {
    await emit('session_start', { reason: 'startup' });
    await run({ dir, ctx, emit, handlers, commands, tools, notes, branch, startup });
  } finally {
    await emit('session_shutdown', {});
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the real compacter follows a local model -> Sol -> the local model without restarting the session', async () => fixture(async (f) => {
  await f.commands['hot-compact'].handler('status', f.ctx);
  assert.match(f.notes.at(-1), /start 35% hard 58%/);
  f.ctx.model = { provider: 'openai-codex', id: 'gpt-6.1-sol', contextWindow: 272000 };
  await f.emit('model_select', { model: f.ctx.model });
  await f.commands['hot-compact'].handler('status', f.ctx);
  assert.match(f.notes.at(-1), /start 59% hard 70%/);
  f.ctx.model = { provider: 'local', id: 'test-model', contextWindow: 131072 };
  await f.emit('model_select', { model: f.ctx.model });
  await f.commands['hot-compact'].handler('status', f.ctx);
  assert.match(f.notes.at(-1), /start 35% hard 58%/);
  assert.deepEqual(JSON.parse(readFileSync(f.startup, 'utf8')), { semantic: false, startPercent: 35, hardPercent: 58 });
}));

test('model changes preserve manual off and explicit compaction settings', async () => {
  for (const managed of [true, false]) await fixture(async (f) => {
    await f.commands['hot-compact'].handler('off', f.ctx);
    f.ctx.model = { provider: 'openai-codex', id: 'gpt-6.1-sol', contextWindow: 272000 };
    await f.emit('model_select', { model: f.ctx.model });
    await f.commands['hot-compact'].handler('status', f.ctx);
    assert.match(f.notes.at(-1), /hot-compact: off/);
    assert.match(f.notes.at(-1), managed ? /start 59% hard 70%/ : /start 35% hard 58%/);
    await f.commands['hot-compact'].handler('on', f.ctx);
    if (!managed) writeFileSync(f.startup, JSON.stringify({ semantic: false, enabled: false, startPercent: 35, hardPercent: 58 }));
    f.ctx.model = { provider: 'local', id: 'test-model', contextWindow: 131072 };
    await f.emit('model_select', { model: f.ctx.model });
    await f.commands['hot-compact'].handler('status', f.ctx);
    assert.match(f.notes.at(-1), /hot-compact: on/);
  }, { managed });
});

test('model changes restore compaction and recall from the branch, and shutdown removes only private config', async () => fixture(async (f) => {
  f.branch.push({ type: 'message', id: 'original', timestamp: new Date().toISOString(), message: { role: 'user', content: 'unique history token 424242' } });
  f.branch.push({ type: 'compaction', id: 'checkpoint', timestamp: new Date().toISOString(), summary: 'existing checkpoint', firstKeptEntryId: 'original' });
  const file = process.env.PI_HOT_COMPACT_CONFIG;
  f.ctx.model = { provider: 'openai-codex', id: 'gpt-6.1-sol', contextWindow: 272000 };
  await f.emit('model_select', { model: f.ctx.model });
  const result = await f.tools.context_recall.execute('id', { query: '424242' }, null, null, f.ctx);
  assert.match(result.content[0].text, /unique history token/);
  await f.commands['hot-compact'].handler('status', f.ctx);
  assert.match(f.notes.at(-1), /gen checkpoint \(foreign/);
  await f.emit('session_shutdown');
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(f.startup), true);
}));

test('switching models cancels an in-flight checkpoint on the old model', async () => fixture(async (f) => {
  let request;
  f.ctx.modelRegistry = { complete: (_model, _messages, options) => {
    request = options.signal;
    return new Promise((_resolve, reject) => request.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } };
  for (let i = 0; i < 12; i++) {
    f.branch.push({ type: 'message', id: `u${i}`, timestamp: new Date().toISOString(), message: { role: 'user', content: `Question ${i}` } });
    f.branch.push({ type: 'message', id: `a${i}`, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'some previous context '.repeat(1000) }] } });
  }
  await f.commands['hot-compact'].handler('now', f.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(request, 'the real semantic compiler starts a request');
  assert.equal(request.aborted, false);
  f.ctx.model = { provider: 'openai-codex', id: 'gpt-6.1-sol', contextWindow: 272000 };
  await f.emit('model_select', { model: f.ctx.model });
  assert.equal(request.aborted, true);
}, { user: { semantic: true } }));

test('collapse_tool_outputs "with_compaction" holds old tool-output collapses until a compaction', async () => {
  const claude = { context_window: 1000000, collapse_tool_outputs: 'with_compaction' };
  await fixture(async (f) => {
    const at = new Date().toISOString(), msg = (id, message) => f.branch.push({ type: 'message', id, timestamp: at, message });
    msg('u0', { role: 'user', content: 'Q0' });
    msg('a0', { role: 'assistant', content: [{ type: 'toolCall', id: 't0', name: 'bash', arguments: {} }] });
    msg('r0', { role: 'toolResult', toolCallId: 't0', toolName: 'bash', content: [{ type: 'text', text: 'long output\n'.repeat(500) }], isError: false });
    for (let i = 1; i <= 2; i++) { msg(`u${i}`, { role: 'user', content: `Q${i}` }); msg(`a${i}`, { role: 'assistant', content: [{ type: 'text', text: `A${i}` }] }); }
    const boundary = async (entries = []) => (await f.handlers.turn_end[0]({ type: 'turn_end', entries }, f.ctx))?.entries ?? [];
    const edits = (entries) => entries.filter((e) => e.type === 'context_edit').map((e) => e.targetId);

    f.ctx.model = { provider: 'claude-sdk-home', id: 'claude-opus-5-5', contextWindow: 1000000 };
    await f.emit('model_select', { model: f.ctx.model });
    assert.deepEqual(edits(await boundary()), []); // held: no rewrite of earlier messages on its own
    const compaction = { type: 'compaction', id: 'c', timestamp: at, summary: 's', firstKeptEntryId: 'u0' };
    assert.deepEqual(edits(await boundary([compaction])), ['r0']); // with a compaction, the held collapse goes through
    f.ctx.model = { provider: 'openai-codex', id: 'gpt-6.1-sol', contextWindow: 272000 };
    await f.emit('model_select', { model: f.ctx.model });
    assert.deepEqual(edits(await boundary()), ['r0']); // other models collapse at every boundary, as upstream
  }, { readTuning: (name) => (name.startsWith('claude-sdk') ? claude : sol) });
});
