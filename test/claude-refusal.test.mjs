// The carried pi-claude-subscription's refusal handling (vendor/patches/…-refusal-fallback.patch), driven by recorded
// Claude Code frame sequences: a client-side refusal retried on the fallback model, one with no fallback, and a
// server-side fallback block inside one response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const source = '../node_modules/pi-claude-subscription/src/';
const { ClaudeSdkProvider } = await jiti.import(source + 'provider.ts');
const { AnchorRegistry } = await jiti.import(source + 'anchors.ts');
const { AsyncQueue } = await jiti.import(source + 'util.ts');
const { createInitialSystemMessage } = await import('@earendil-works/pi-ai');

const model = { provider: 'claude-sdk-work', id: 'claude-opus-5-5', api: 'claude-agent-sdk', maxTokens: 1024,
  reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tools = [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }];
const context = { messages: [createInitialSystemMessage('test', tools), { role: 'user', content: 'go on', timestamp: 1 }] };

// One API response as Claude Code streams it. `blocks` are text strings or { tool } names; a { fallback } entry is the
// server's fallback block.
function response(responseModel, blocks, stop, stopDetails = null) {
  const id = randomUUID(), events = [{ type: 'message_start', message: { id, model: responseModel, usage: {} } }];
  blocks.forEach((b, index) => {
    if (typeof b === 'string') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b } });
    } else if (b.tool) {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.tool, name: 'read' } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{}' } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'fallback', from: { model: model.id },
        to: { model: b.fallback }, trigger: { type: 'refusal', category: 'bio' } } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_details: stopDetails }, usage: {} }, { type: 'message_stop' });
  return events.map((event) => ({ type: 'stream_event', event }));
}

const refused = (blocks) => response(model.id, blocks, 'refusal', { category: 'bio', explanation: null });
const notice = (subtype, extra = {}) => ({ type: 'system', subtype, original_model: model.id, request_id: null,
  api_refusal_category: 'bio', content: 'Opus 5.5\'s safeguards flagged this session.', uuid: randomUUID(), session_id: 's', ...extra });
const result = { type: 'result', subtype: 'success' };

function fakeSession(frames) {
  return (spec, chain, count) => {
    const events = new AsyncQueue();
    let resolveExit;
    const session = { spec, chain, count, systemPrompt: spec.systemPrompt, model: spec.model, sessionId: randomUUID(),
      busy: false, dead: false, lastUsed: Date.now(), awaiting: new Set(), servedByClaude: new Set(), events,
      exited: new Promise((r) => { resolveExit = r; }), stderr: '', entryUuid: async () => randomUUID(),
      setModel: async (m) => { session.model = m; }, deliver() {}, interrupt: async () => {},
      close() { session.dead = true; events.close(); resolveExit(); },
      send() { for (const f of frames) events.push(f); } };
    return session;
  };
}

async function run(frames) {
  const root = mkdtempSync(join(tmpdir(), 'mina-claude-refusal-'));
  const forwarded = [];
  const provider = new ClaudeSdkProvider({ configDir: root, cwd: () => root, registry: new AnchorRegistry(join(root, 'anchors.jsonl')),
    createSession: fakeSession(frames) });
  try {
    const message = await provider.streamSimple(model, context, { onProviderStreamEvent: (data) => { forwarded.push(data); } }).result();
    return { message, notices: forwarded.filter((d) => d.type === 'system') };
  } finally { provider.shutdown(); rmSync(root, { recursive: true, force: true }); }
}

const texts = (m) => m.content.filter((c) => c.type === 'text').map((c) => c.text);
const calls = (m) => m.content.filter((c) => c.type === 'toolCall').map((c) => c.id);

test('a refused response retried on the fallback model keeps only the fallback answer and names its model', async () => {
  const fallback = notice('model_refusal_fallback', { trigger: 'refusal', direction: 'retry', scope: 'session', fallback_model: 'claude-opus-5' });
  const { message, notices } = await run([...refused(['Let me fetch']), ...response('claude-opus-5', ['Here is the answer.'], 'end_turn'), fallback, result]);
  assert.equal(message.stopReason, 'stop', message.errorMessage);
  assert.deepEqual(texts(message), ['Here is the answer.']);
  assert.equal(message.model, 'claude-opus-5-5');
  assert.equal(message.responseModel, 'claude-opus-5');
  assert.deepEqual(notices, [fallback], 'the notice reaches extensions as the raw frame');
});

test('tool calls in the refused partial never reach pi; the fallback model\'s tool calls do', async () => {
  const { message } = await run([...refused(['Two reads', { tool: 'tu_refused' }]), ...response('claude-opus-5', [{ tool: 'tu_fallback' }], 'tool_use')]);
  assert.equal(message.stopReason, 'toolUse', message.errorMessage);
  assert.deepEqual(calls(message), ['tu_fallback']);
  assert.deepEqual(texts(message), []);
  assert.equal(message.responseModel, 'claude-opus-5');
});

test('a refusal that no fallback model answers ends the turn as an error with its category, not as a normal stop', async () => {
  const none = notice('model_refusal_no_fallback');
  const { message, notices } = await run([...refused(['Partial']), none, result]);
  assert.equal(message.stopReason, 'error');
  assert.match(message.errorMessage, /claude-opus-5-5 declined this request \(refusal, category bio\) and no fallback model answered\. Opus 5\.5's safeguards/);
  assert.deepEqual(notices, [none]);
});

test('a server-side fallback block inside one response switches the response model and keeps the content', async () => {
  const { message } = await run([...response(model.id, ['Before', { fallback: 'claude-opus-5' }, 'After'], 'end_turn'), result]);
  assert.equal(message.stopReason, 'stop', message.errorMessage);
  assert.deepEqual(texts(message), ['Before', 'After']);
  assert.equal(message.responseModel, 'claude-opus-5');
});

test('an ordinary response is unchanged', async () => {
  const { message, notices } = await run([...response(model.id, ['Hello'], 'end_turn'), result]);
  assert.equal(message.stopReason, 'stop', message.errorMessage);
  assert.deepEqual(texts(message), ['Hello']);
  assert.equal(message.responseModel, model.id);
  assert.deepEqual(notices, []);
});
