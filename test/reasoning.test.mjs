import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripOldReasoning } from '../extensions/handoff/reasoning.mjs';

// Seen in a test run: Pi sends every earlier turn's reasoning back to llama.cpp as reasoning_content, and the
// model's chat template put it in the prompt: about 15k of 70k context tokens were old reasoning, and compaction freed only 9k.
const a = (n, extra = []) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: `think ${n}`, thinkingSignature: 'reasoning_content' }, ...extra] });
const tool = (n) => ({ type: 'toolCall', id: `t${n}`, name: 'bash', arguments: {} });
const msgs = () => [{ role: 'user', content: 'go' }, a(1, [tool(1)]), { role: 'toolResult', content: [] }, a(2, [tool(2)]), { role: 'toolResult', content: [] },
  a(3, [{ type: 'text', text: 'ok' }]), a(4, [tool(4)]), { role: 'toolResult', content: [] }];

test('reasoning is kept in the last N assistant messages and dropped from older ones; nothing else changes', () => {
  const input = msgs();
  const before = JSON.stringify(input);
  const { messages, dropped } = stripOldReasoning(input, 2);
  assert.equal(JSON.stringify(input), before);                                         // the session's messages are not mutated
  const thinks = messages.filter((m) => m.role === 'assistant').map((m) => m.content.filter((b) => b.type === 'thinking').length);
  assert.deepEqual(thinks, [0, 0, 1, 1]);
  assert.deepEqual(messages[1].content.map((b) => b.type), ['toolCall']);             // the tool call stays
  assert.equal(messages.length, input.length); assert.equal(dropped, 2);
});

test('a message that is only reasoning keeps it (an empty assistant message could break the request); N=0 or off keeps all', () => {
  const only = [a(1), a(2), a(3)];
  assert.deepEqual(stripOldReasoning(only, 1).messages.map((m) => m.content.length), [1, 1, 1]);
  assert.equal(stripOldReasoning(msgs(), null).dropped, 0);
  assert.equal(stripOldReasoning(msgs(), 0).dropped, 4);                              // 0 = keep none (except reasoning-only ones)
});
