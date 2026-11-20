// Recovery and evidence for children: a transport failure is retried a bounded number of times without replaying a tool
// call; each run records how it ended (termination); and each bash run leaves a command receipt whose output is readable by run_id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import delegates from '../extensions/delegates/index.js';
import { fixture, body, until, fauxAssistantMessage, fauxToolCall } from './delegates-fixture.mjs';
import { needsSandbox } from './capabilities.mjs';

const FAST = { retry: { baseDelayMs: 1 } };
const done = () => fauxAssistantMessage('done');
const failed = (errorMessage) => fauxAssistantMessage([], { stopReason: 'error', errorMessage });
const bash = (command, id) => fauxAssistantMessage(fauxToolCall('bash', { command }, { id }), { stopReason: 'toolUse' });
const failedReply = (ctx) => ctx.messages.some((m) => m.role === 'assistant' && m.stopReason === 'error');

test('a connection error is retried once the child has kept its tool result, and the tool call is not replayed', { skip: needsSandbox }, async () => {
  const contexts = [];
  const f = await fixture([bash('echo ran >> once.txt', 'run-1'), failed('Connection error.'),
    (ctx) => { contexts.push(ctx); return done(); }], { settings: FAST });
  try {
    const out = body(await f.call('Agent', { prompt: 'x', description: 'x', run_in_background: false }));
    assert.equal(out.status, 'completed', out.error);
    assert.deepEqual(out.outcome, { lifecycle: 'completed', termination: 'normal', task: 'unknown', evidence: 'unknown' });
    assert.deepEqual(out.retries, [{ attempt: 1, error: 'Connection error.' }]);
    assert.equal(f.faux.state.callCount, 3);
    assert.equal(out.turns, 2, 'the retried request does not use a turn');
    assert.equal(readFileSync(join(f.cwd, 'once.txt'), 'utf8'), 'ran\n', 'the tool ran once');
    assert.ok(contexts[0].messages.some((m) => m.role === 'toolResult' && m.toolCallId === 'run-1'), 'the completed tool result stays');
    assert.ok(!failedReply(contexts[0]), 'the failed reply is not sent again');
  } finally { await f.shutdown(); }
});

test('transport retries stop at two; the child fails as transport and keeps the error', { skip: needsSandbox }, async () => {
  const f = await fixture([failed('Connection error.'), failed('Request timed out.'), failed('Connection error.'), done()], { settings: FAST });
  try {
    const out = body(await f.call('Agent', { prompt: 'x', description: 'x', run_in_background: false }));
    assert.equal(out.status, 'failed');
    assert.equal(out.outcome.termination, 'transport');
    assert.equal(out.error, 'Connection error.');
    assert.deepEqual(out.retries.map((r) => r.error), ['Connection error.', 'Request timed out.']);
    assert.equal(f.faux.state.callCount, 3);
  } finally { await f.shutdown(); }
});

test('a usage limit is not retried, and retry.enabled false turns retries off', { skip: needsSandbox }, async () => {
  const f = await fixture([failed("You've hit your session limit · resets 10:50am"), done()], { settings: FAST });
  try {
    const out = body(await f.call('Agent', { prompt: 'x', description: 'x', run_in_background: false }));
    assert.equal(out.outcome.termination, 'provider_error');
    assert.equal(out.retries, undefined);
    assert.equal(f.faux.state.callCount, 1);
  } finally { await f.shutdown(); }
  const g = await fixture([failed('Connection error.'), done()], { settings: { retry: { enabled: false, baseDelayMs: 1 } } });
  try {
    const out = body(await g.call('Agent', { prompt: 'x', description: 'x', run_in_background: false }));
    assert.equal(out.outcome.termination, 'transport');
    assert.equal(g.faux.state.callCount, 1);
  } finally { await g.shutdown(); }
});

test('termination names an output limit and a turn limit, and neither is retried', { skip: needsSandbox }, async () => {
  const f = await fixture([fauxAssistantMessage('Partial', { stopReason: 'length' }), done()], { settings: FAST });
  try {
    const out = body(await f.call('Agent', { prompt: 'x', description: 'x', run_in_background: false }));
    assert.equal(out.outcome.termination, 'output_limit');
    assert.equal(f.faux.state.callCount, 1);
  } finally { await f.shutdown(); }
  const g = await fixture([bash('true'), done()], { settings: FAST });
  try {
    const out = body(await g.call('Agent', { prompt: 'x', description: 'x', max_turns: 1, run_in_background: false }));
    assert.equal(out.outcome.termination, 'turn_limit');
    assert.match(out.error, /turn limit reached/);
    assert.equal(out.retries, undefined);
    assert.equal(g.faux.state.callCount, 1);
  } finally { await g.shutdown(); }
});

test('a shutdown during the retry backoff ends the child at once', { skip: needsSandbox }, async () => {
  const f = await fixture([failed('Connection error.'), done()], { settings: { retry: { baseDelayMs: 60_000 } } });
  const a = body(await f.call('Agent', { prompt: 'x', description: 'x' }));
  const r = f.ledger().records.get(a.id);
  await until(() => r.retries?.length === 1);
  const t = Date.now();
  await f.shutdown();
  assert.ok(Date.now() - t < 5_000, 'the backoff did not hold the shutdown');
  assert.equal(r.status, 'failed');
  assert.equal(r.termination, 'shutdown');
  assert.equal(f.faux.state.callCount, 1);
});

test('bash runs leave command receipts; run_id returns the output, live and from the transcript', { skip: needsSandbox }, async () => {
  const f = await fixture([bash('echo checked-output; exit 3', 'run-a'), bash('true', 'run-b'), done()]);
  try {
    const out = body(await f.call('Agent', { prompt: 'x', description: 'x', run_in_background: false }));
    const c = out.commands;
    assert.equal(c.cwd, f.cwd);
    assert.deepEqual([c.total, c.exited_0, c.exited_nonzero, c.no_exit], [2, 1, 1, 0]);
    assert.deepEqual(c.runs.map((x) => [x.run_id, x.command, x.status, x.exit_code]),
      [['run-a', 'echo checked-output; exit 3', 'exited', 3], ['run-b', 'true', 'exited', 0]]);
    assert.equal(typeof c.runs[0].seconds, 'number');
    const run = body(await f.call('get_subagent_result', { agent_id: out.id, run_id: 'run-a' }));
    assert.equal(run.command, 'echo checked-output; exit 3');
    assert.equal(run.exit_code, 3);
    assert.match(run.output, /checked-output/);
    assert.match(run.output, /exited with code 3/);
    // A later runtime reads the same run from the child's transcript.
    f.reload(`${f.cwd}-later`);
    const old = body(await f.call('get_subagent_result', { agent_id: out.id, run_id: 'run-a', max_chars: 5 }));
    assert.equal(old.output, 'check');
    assert.equal(old.nextOffset, 5);
    await f.reject('get_subagent_result', { agent_id: out.id, run_id: 'run-zzz' }, /No command run run-zzz/);
    await f.reject('get_subagent_result', { agent_id: out.id, run_id: 'run-a', summary_only: true }, /drop summary_only/);
  } finally { await f.shutdown(); }
});

test('an interrupted command is receipted as interrupted, not as an exit', { skip: needsSandbox }, async () => {
  const f = await fixture([bash('sleep 30', 'run-s'), done()]);
  const a = body(await f.call('Agent', { prompt: 'x', description: 'x' }));
  const r = f.ledger().records.get(a.id);
  await until(() => r.commands.runs[0]?.status === 'running');
  r.stopped = true; r.agent.abort(); // what a stop from the viewer does
  await r.run;
  try {
    const run = r.commands.runs[0];
    assert.equal(run.status, 'interrupted');
    assert.equal(run.exit_code, undefined);
    assert.deepEqual([r.commands.exited_0, r.commands.no_exit], [0, 1]);
    assert.equal(r.termination, 'stopped');
    assert.equal(r.retries.length, 0, 'a stopped child is not retried');
  } finally { await f.shutdown(); }
});

test('every child is told to use its own judgment and to report a conflict with an operator constraint', { skip: needsSandbox }, async () => {
  const f = await fixture([done()]);
  try {
    const out = body(await f.call('Agent', { prompt: 'x', description: 'x', run_in_background: false }));
    const system = f.ledger().records.get(out.id).agent.state.systemPrompt;
    assert.match(system, /own technical judgment/);
    assert.match(system, /assumption in the brief is wrong/);
    assert.match(system, /constraint that the brief gives as the operator's: report the conflict/);
  } finally { await f.shutdown(); }
});

test('the Agent description tells the parent how to brief, what termination means, and that exit 0 is not a test pass', () => {
  const tools = {};
  delegates({ events: new EventEmitter(), registerTool: (t) => { tools[t.name] = t; }, on: () => {}, appendEntry: () => {} },
    { env: { MINA_INSTANCE_ID: 'schema-probe-recovery' } });
  const d = tools.Agent.description;
  assert.match(d, /objective, the constraints/);
  assert.match(d, /may disagree/);
  assert.match(d, /termination/);
  assert.match(d, /exit 0 is not a verified test pass/);
  assert.ok(tools.get_subagent_result.parameters.properties.run_id);
});
