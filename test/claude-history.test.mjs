// The carried pi-claude-subscription's history fidelity (vendor/patches/…-history-fidelity.patch). When pi rewrites
// an earlier message (pi-hot-compact's tool-output collapse), the provider cannot continue its live Claude Code
// process. Resuming from an older anchor sent the rest of the transcript as one user turn and silently dropped the
// model's own later replies, so the model answered old questions again and repeated its calls ("looping").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const source = '../node_modules/pi-claude-subscription/src/';
const { ClaudeSdkProvider } = await jiti.import(source + 'provider.ts');
const { AnchorRegistry } = await jiti.import(source + 'anchors.ts');
const { AsyncQueue } = await jiti.import(source + 'util.ts');
const { userTurnBlocks } = await jiti.import(source + 'convert.ts');

const model = { provider: 'claude-sdk', id: 'claude-haiku-5-5', api: 'claude-agent-sdk', maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const system = { role: 'system', content: 'SYS', timestamp: 0,
  toolsAdded: [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } }] };

// A Claude Code stand-in: each send or tool result streams the next scripted reply, a tool call or a text answer.
function harness(root) {
  const replies = [], sends = [];
  let n = 0;
  const createSession = (spec, chain, count) => {
    const events = new AsyncQueue();
    const s = { spec, chain, count, sessionId: spec.resume?.sessionId ?? `s${++n}`, systemPrompt: spec.systemPrompt, model: spec.model,
      awaiting: new Set(), servedByClaude: new Set(), dead: false, busy: false, lastUsed: Date.now(), events,
      exited: Promise.resolve(), stderr: '', entryUuid: async (id) => `uuid-${id}`, setModel: async (m) => { s.model = m; },
      interrupt: async () => {}, close() { s.dead = true; events.close(); } };
    const emit = () => {
      const r = replies.shift(), id = `msg_${Math.random().toString(36).slice(2, 8)}`;
      const ev = (event) => events.push({ type: 'stream_event', event });
      ev({ type: 'message_start', message: { id, model: s.model, usage: {} } });
      if (r.tool) {
        s.awaiting.add(r.tool);
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: r.tool, name: 'mcp__pi__bash' } });
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } });
        ev({ type: 'content_block_stop', index: 0 });
        ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }); ev({ type: 'message_stop' });
      } else {
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: r.text } });
        ev({ type: 'content_block_stop', index: 0 });
        ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }); ev({ type: 'message_stop' });
        events.push({ type: 'result', subtype: 'success' });
      }
    };
    s.send = (content) => { sends.push({ session: s.sessionId, resume: spec.resume, content }); emit(); };
    s.deliver = (result) => { s.awaiting.delete(result.toolCallId); emit(); };
    return s;
  };
  const provider = new ClaudeSdkProvider({ configDir: root, cwd: () => root, registry: new AnchorRegistry(join(root, 'anchors.jsonl')),
    createSession, forkSession: async (id) => ({ sessionId: `${id}-fork` }) });
  return { provider, replies, sends };
}

const user = (text) => ({ role: 'user', content: text, timestamp: 1 });
const result = (id, text) => ({ role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text }], isError: false, timestamp: 1 });
const sentText = (send) => send.content.map((b) => (b.type === 'text' ? b.text : `${b.type}:${b.tool_use_id}`));

async function conversation(fn) {
  const root = mkdtempSync(join(tmpdir(), 'mina-claude-history-'));
  const h = harness(root), messages = [system];
  const call = async (reply) => {
    h.replies.push(reply);
    const message = await h.provider.streamSimple(model, { messages }, {}).result();
    assert.equal(message.stopReason === 'error' ? message.errorMessage : 'ok', 'ok');
    messages.push(message);
    return h.provider.lastRoute;
  };
  try { return await fn({ ...h, root, messages, call }); } finally { h.provider.shutdown(); rmSync(root, { recursive: true, force: true }); }
}

test('a collapsed tool output earlier in the session never hides the model\'s later replies from Claude Code', async () => {
  await conversation(async ({ messages, call, sends, root }) => {
    messages.push(user('Q1: why does it expire?'));
    await call({ tool: 'toolu_a1' });
    messages.push(result('toolu_a1', 'BIG OUTPUT '.repeat(500)));
    await call({ text: 'A1: it is capped at 24 h. Option A, B or C?' });
    messages.push(user('Q2: C'));
    await call({ tool: 'toolu_b1' });
    messages.push(result('toolu_b1', 'out2'));
    await call({ text: 'A2: done. Check the qualification first?' });

    // pi-hot-compact replaces the turn-1 tool output in place (a context_edit entry).
    const i = messages.findIndex((m) => m.toolCallId === 'toolu_a1');
    messages[i] = { ...messages[i], content: [{ type: 'text', text: '[tool output collapsed: bash, 5500 chars]' }] };
    messages.push(user('Q3: yes'));
    sends.length = 0;
    const route = await call({ text: 'A3' });

    // Before the fix: route "resume" at A1's anchor, sending Q2, out2 and Q3 as one user turn without A2's call and answer.
    assert.equal(route, 'synth');
    assert.deepEqual(sends.map(sentText), [['Q3: yes']]);
    const dir = join(root, 'projects', readdirSync(join(root, 'projects'))[0]);
    const history = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8');
    for (const reply of ['A1: it is capped', 'A2: done', 'toolu_b1', 'tool output collapsed']) assert.ok(history.includes(reply), reply);

    // With no further rewrite, the next turn continues the same Claude Code process.
    messages.push(user('Q4'));
    sends.length = 0;
    assert.equal(await call({ text: 'A4' }), 'live');
    assert.deepEqual(sends.map(sentText), [['Q4']]);
  });
});

test('a pi session that diverges right after the last reply still resumes Claude Code\'s own session', async () => {
  await conversation(async ({ provider, messages, call, sends }) => {
    messages.push(user('Q1'));
    await call({ text: 'A1' });
    // A restart: the provider has no live process, only the anchor at A1.
    provider.shutdown();
    messages.push(user('Q2'));
    sends.length = 0;
    assert.equal(await call({ text: 'A2' }), 'resume');
    assert.deepEqual(sends.map(sentText), [['Q2']]);
  });
});

test('a user turn cannot silently carry an assistant message', () => {
  assert.deepEqual(userTurnBlocks([user('hi')]), [{ type: 'text', text: 'hi' }]);
  assert.throws(() => userTurnBlocks([user('hi'), { role: 'assistant', content: [{ type: 'text', text: 'lost' }] }]), /assistant message/);
});

test('anchors recorded before the fix are not resumed', () => {
  const root = mkdtempSync(join(tmpdir(), 'mina-claude-anchors-'));
  try {
    const file = join(root, 'anchors.jsonl');
    mkdirSync(root, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ k: 'old', s: 's1', m: 'msg', c: root })}\n`);
    const registry = new AnchorRegistry(file);
    assert.equal(registry.get('old'), undefined);
    registry.put('new', { sessionId: 's2', messageId: 'msg2', cwd: root });
    assert.equal(new AnchorRegistry(file).get('new')?.sessionId, 's2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('closing a Claude Code process that waits on pi\'s tool results interrupts its turn first', async () => {
  const { LiveSession } = await jiti.import(source + 'session.ts');
  const calls = [];
  const fake = (parked) => Object.assign(Object.create(LiveSession.prototype), { dead: false, parked: new Map(parked),
    input: { close: () => calls.push('input.close') }, q: { interrupt: async () => calls.push('interrupt'), close: () => calls.push('q.close') } });
  fake([]).close();
  assert.deepEqual(calls, ['input.close', 'q.close']);
  calls.length = 0;
  fake([['toolu_1', {}]]).close();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['interrupt', 'input.close', 'q.close']);
});
