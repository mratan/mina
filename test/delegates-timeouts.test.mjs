import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, body, fauxAssistantMessage } from './delegates-fixture.mjs';
import { needsSandbox } from './capabilities.mjs';

async function requestTimeouts(settings) {
  let seen;
  const f = await fixture([(_context, options) => {
    seen = [options.timeoutMs, options.websocketConnectTimeoutMs];
    return fauxAssistantMessage('done');
  }], { settings });
  try {
    const out = body(await f.call('Agent', { prompt: 'x', description: 'x', run_in_background: false }));
    assert.equal(out.status, 'completed', out.error);
    return seen;
  } finally { await f.shutdown(); }
}

test('child model requests use the timeout from the parent Pi session', { skip: needsSandbox }, async () => {
  assert.deepEqual(await requestTimeouts({ httpIdleTimeoutMs: 3_600_000, websocketConnectTimeoutMs: 15_001 }), [3_600_000, 15_001]);
});

test('the parent Pi provider timeout override takes precedence over the HTTP idle timeout', { skip: needsSandbox }, async () => {
  assert.deepEqual(await requestTimeouts({ httpIdleTimeoutMs: 1_234, retry: { provider: { timeoutMs: 3_456 } } }), [3_456, undefined]);
});

test('a zero HTTP idle timeout uses the same effective timeout as Pi', { skip: needsSandbox }, async () => {
  assert.deepEqual(await requestTimeouts({ httpIdleTimeoutMs: 0 }), [2_147_483_647, undefined]);
});
