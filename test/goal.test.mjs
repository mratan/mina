import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const REPO_ROOT = new URL('..', import.meta.url).pathname;
import { parseGoalArgs, upstreamArgs, goalInstructions, rejectionFeedback, isMinaPath, isCheckPath, parseCheckLines, checkScriptsIn, unusedCheckScripts, dryRunVerdict, proposalSummary } from '../extensions/goal/checks.mjs';
import { createMinaGoal, DRY_RUN_TIMEOUT_MS } from '../extensions/goal/mina-goal.mjs';
import { observeWorkload, liveWorkload, toolEffect, nextStall, gitSnapshot } from '../extensions/goal/stall.mjs';

test('protected planning requests check registration instead of falsely reporting unaccepted scripts as tampered', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-minimal-planning-'));
  const f = fakePi();
  const ctx = { cwd, hasUI: false };
  await f.commands.goal.handler('build it --protect-checks', ctx);
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true });
  writeFileSync(join(cwd, '.mina', 'checks', 'draft.sh'), 'exit 1\n');
  const refused = await f.emit('tool_call', { toolName: 'goal_complete' }, ctx);
  assert.match(refused.reason, /register the checks/);
  assert.doesNotMatch(refused.reason, /accepted|changed/);
});

test('a passing goal completes without numerical paperwork', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-minimal-goal-'));
  const f = fakePi({ execCodes: [0] });
  const ctx = { cwd, hasUI: false };
  await f.commands.goal.handler('add a command-line option --check "true" --no-research', ctx);
  assert.equal(await f.emit('tool_call', { toolName: 'goal_complete' }, ctx), undefined);
  assert.equal(existsSync(join(cwd, '.mina', 'numbers.md')), false);
  assert.equal(f.entries.at(-1).data.results[0].code, 0);
});

test('reasoning does not automatically capture or steer doubts', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-minimal-doubt-'));
  const f = fakePi();
  const ctx = { cwd, hasUI: false };
  await f.commands.goal.handler('build it --check "true"', ctx);
  const saved = f.entries.length;
  await f.emit('turn_end', { message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'A latency of -11.29 ms is implausible.' },
    { type: 'text', text: 'A latency of -11.29 ms is implausible.' },
  ] } }, ctx);
  assert.equal(existsSync(join(cwd, '.mina', 'doubts.md')), false);
  assert.equal(f.entries.length, saved);
  assert.deepEqual(f.sent, []);
  assert.equal(f.tools.mina_close_doubt, undefined);
  assert.equal(await f.emit('tool_call', { toolName: 'write', input: { path: '.mina/doubts.md' } }, ctx), undefined);
});

test('completion makes no automatic reviewer model calls even with old tuning enabled', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-minimal-review-'));
  let calls = 0;
  const f = fakePi({ tuning: { requirement_review: { enabled: true }, doubt_critic: { enabled: true } } });
  const ctx = { cwd, hasUI: false, model: { provider: 'test', id: 'test' }, modelRegistry: {
    complete: async () => { calls++; return { content: [{ type: 'text', text: 'VERDICT: COMPLETE' }] }; },
  } };
  await f.commands.goal.handler('build it --check "true"', ctx);
  writeFileSync(join(cwd, 'RESULT.md'), 'A latency of -11.29 ms is implausible.');
  await f.emit('turn_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'A latency of -11.29 ms is implausible.' }] } }, ctx);
  assert.equal(await f.emit('tool_call', { toolName: 'goal_complete' }, ctx), undefined);
  assert.equal(calls, 0);
  assert.equal(f.entries.at(-1).data.review, undefined);
});

test('fresh goals use editable working checks without an approval dialog or a pre-work write gate', async () => {
  const f = fakePi({ execCodes: [1, 0] });
  const cwd = project();
  const ctx = { cwd, hasUI: true, ui: { notify: () => {}, select: async () => { throw new Error('unexpected approval'); } } };
  await f.commands.goal.handler('build a parser --no-research', ctx);
  assert.equal(f.entries.at(-1).data.checkPolicy, 'working');
  assert.equal(await f.emit('tool_call', { toolName: 'write', input: { path: 'src/parser.js' } }, ctx), undefined);
  assert.equal((await f.emit('tool_call', { toolName: 'goal_complete' }, ctx)).block, true);
  const proposal = { restated_objective: 'build a parser', checks: [{ command: 'bash .mina/checks/parser.sh', proves: 'parser examples pass' }],
    files: [{ path: '.mina/checks/parser.sh', content: 'exit 1\n' }] };
  const first = await f.tools.mina_propose_checks.execute('p1', proposal, null, null, ctx);
  assert.match(first.content[0].text, /agent-selected|Agent-selected/);
  assert.equal(await f.emit('tool_call', { toolName: 'edit', input: { path: '.mina/checks/parser.sh' } }, ctx), undefined);
  await f.tools.mina_propose_checks.execute('p2', { ...proposal, files: [{ path: '.mina/checks/parser.sh', content: 'exit 0\n' }] }, null, null, ctx);
  assert.equal(readFileSync(join(cwd, '.mina/checks/parser.sh'), 'utf8'), 'exit 0\n');
  assert.equal(f.entries.at(-1).data.pendingAmendment, undefined);
  const failed = await f.emit('tool_call', { toolName: 'goal_complete' }, ctx);
  assert.match(failed.reason, /REFUSED/);
  assert.doesNotMatch(failed.reason, /never the checks|do not change the checks/);
  assert.equal(await f.emit('tool_call', { toolName: 'goal_complete' }, ctx), undefined);
  const notices = [];
  await f.emit('tool_result', { toolName: 'goal_complete', isError: false, content: [{ type: 'text', text: 'Goal complete: done' }] },
    { ...ctx, ui: { notify: (text) => notices.push(text) } });
  assert.match(notices.at(-1), /agent-selected/);
  assert.doesNotMatch(notices.at(-1), /goal complete, verified/);
});

test('all working-check execution paths use the inner sandbox and remove secret environment names', async () => {
  const cwd = project(), seen = [];
  const env = { MINA_SANDBOX: '1', MINA_SANDBOX_NET: 'packages', PROBE_API_KEY: 'must-not-appear-in-command' };
  const f = fakePi({ env, onExec: (args) => { if (args[0] === '-c') seen.push(args[1]); } });
  const ctx = { cwd, hasUI: false };
  await f.commands.goal.handler('build it', ctx);
  await f.tools.mina_propose_checks.execute('p', { restated_objective: 'build it', checks: [{ command: 'true', proves: 'x' }] }, null, null, ctx);
  await f.tools.mina_checks.execute('s', {}, null, null, ctx);
  await f.emit('tool_call', { toolName: 'goal_complete' }, ctx);
  assert.equal(seen.length, 3);
  for (const command of seen) {
    assert.match(command, /^exec \/usr\/bin\/env -i PATH=\/usr\/bin:\/bin/);
    assert.match(command, /--unshare-net/);
    assert.doesNotMatch(command, /must-not-appear-in-command|PROBE_API_KEY/);
  }
});

test('explicit protection retains planning approval and old contracts do not become working checks on restore', async () => {
  const f = fakePi(), cwd = project();
  const ctx = { cwd, hasUI: false };
  await f.commands.goal.handler('build it --protect-checks', ctx);
  assert.equal(f.entries.at(-1).data.checkPolicy, 'protected');
  assert.equal((await f.emit('tool_call', { toolName: 'write', input: { path: 'src/a.js' } }, ctx)).block, true);
  await f.tools.mina_propose_checks.execute('p', { restated_objective: 'build it', checks: [{ command: 'true', proves: 'x' }] }, null, null, ctx);
  assert.equal(f.entries.at(-1).data.checkApproval, 'none', 'headless selection is not user approval');
  const legacy = structuredClone(f.entries.at(-1).data);
  delete legacy.checkPolicy;
  delete legacy.checkApproval;
  const restored = fakePi();
  await restored.emit('session_start', {}, { ...ctx, sessionManager: { getBranch: () => [{ type: 'custom', customType: 'mina-goal', data: legacy }] } });
  assert.equal((await restored.emit('tool_call', { toolName: 'write', input: { path: '.mina/checks/check.py' } }, ctx)).block, true);
  await assert.rejects(restored.tools.mina_propose_checks.execute('new', { restated_objective: 'build it', checks: [{ command: 'false', proves: 'x' }] }, null, null, ctx), /with a reason/);
  assert.match(parseGoalArgs('build --protect-checks --no-check').errors.join(' '), /exclude/);
});

test('legacy active goals warn and refuse completion after the protected hash guard', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-minimal-legacy-'));
  mkdirSync(join(cwd, '.mina/checks'), { recursive: true });
  const script = join(cwd, '.mina/checks/test.sh');
  writeFileSync(script, 'exit 0\n');
  const source = fakePi();
  await source.commands.goal.handler('build it --check "bash .mina/checks/test.sh"', { cwd, hasUI: false });
  const legacy = structuredClone(source.entries.at(-1).data);
  assert.equal(legacy.completionPolicy, 'checks-only');
  delete legacy.completionPolicy;
  delete legacy.checkPolicy;
  const notices = [], runs = [];
  const restored = fakePi({ onExec: (args) => runs.push(args) });
  const ctx = { cwd, hasUI: true, ui: { notify: (text) => notices.push(text) },
    sessionManager: { getBranch: () => [{ type: 'custom', customType: 'mina-goal', data: legacy }] } };
  await restored.emit('session_start', {}, ctx);
  assert.match(notices.join(' '), /legacy runtime[^]*new goal/i);
  writeFileSync(script, 'exit 1\n');
  const tampered = await restored.emit('tool_call', { toolName: 'goal_complete' }, ctx);
  assert.match(tampered.reason, /check files changed/);
  await assert.rejects(restored.tools.mina_checks.execute('s', {}, null, null, ctx), /check files changed/);
  writeFileSync(script, 'exit 0\n');
  const refused = await restored.emit('tool_call', { toolName: 'goal_complete' }, ctx);
  assert.match(refused.reason, /legacy[^]*legacy runtime[^]*new goal/i);
  assert.equal(runs.length, 0);
  // No-check legacy contracts must not bypass the format guard either.
  await restored.emit('session_start', {}, { ...ctx, sessionManager: { getBranch: () => [
    { type: 'custom', customType: 'mina-goal', data: { ...legacy, mode: 'none', checks: [] } },
  ] } });
  assert.match((await restored.emit('tool_call', { toolName: 'goal_complete' }, ctx)).reason, /legacy/i);
});

test('continue and reopen preserve completion policy without upgrading legacy records', async () => {
  for (const completionPolicy of ['checks-only', undefined]) {
    for (const command of ['mina-continue', 'reopen a required case was missed']) {
      const cwd = project();
      const source = fakePi();
      await source.commands.goal.handler('build it --check "true"', { cwd, hasUI: false });
      const goal = structuredClone(source.entries.at(-1).data);
      if (!completionPolicy) delete goal.completionPolicy;
      goal.status = command.startsWith('reopen') ? 'complete' : 'active';
      const f = fakePi();
      const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => [
        { type: 'custom', customType: 'mina-goal', data: goal },
      ] } };
      await f.commands.goal.handler(command, ctx);
      const continued = f.entries.at(-1).data;
      assert.equal(continued.completionPolicy, completionPolicy);
      assert.equal(Object.hasOwn(continued, 'completionPolicy'), Boolean(completionPolicy));
      assert.deepEqual(continued.checks, goal.checks);
      assert.equal(continued.checkPolicy, goal.checkPolicy);
      assert.equal(continued.checkApproval, goal.checkApproval);
      const result = await f.emit('tool_call', { toolName: 'goal_complete' }, ctx);
      if (completionPolicy) assert.equal(result, undefined);
      else assert.match(result.reason, /legacy[^]*legacy runtime[^]*new goal/i);
    }
  }
});

test('a check timeout refuses completion and reports the timeout output', async () => {
  const f = fakePi({ execResults: [{ code: null, killed: true, stdout: 'partial check output', stderr: '' }] });
  const ctx = { cwd: project(), hasUI: false };
  await f.commands.goal.handler('build it --check "slow test"', ctx);
  const refused = await f.emit('tool_call', { toolName: 'goal_complete' }, ctx);
  assert.equal(refused.block, true);
  assert.match(refused.reason, /R1: `slow test` exited after a timeout[^]*partial check output/);
  assert.equal(f.entries.at(-1).data.status, 'active');
  assert.equal(f.entries.at(-1).data.results[0].killed, true);
});

test('flags: --check (quoted, repeated), --no-check, --no-research, --tokens passed on; subcommands pass through', () => {
  const p = parseGoalArgs('add a CLI --check "npm test" --tokens 200k --check \'grep -q "usage" README.md\' --no-research');
  assert.deepEqual(p.checks, ['npm test', 'grep -q "usage" README.md']);
  assert.equal(p.noResearch, true);
  assert.equal(p.objective, 'add a CLI');
  assert.equal(upstreamArgs(p), '--tokens 200k add a CLI');
  assert.deepEqual(parseGoalArgs('pause'), { pass: true });
  assert.deepEqual(parseGoalArgs(''), { pass: true });
  assert.deepEqual(parseGoalArgs('checks'), { sub: 'checks', rest: '' });
  assert.deepEqual(parseGoalArgs('add-check "pytest -q tests"'), { sub: 'add-check', rest: 'pytest -q tests' });
  assert.match(parseGoalArgs('x --no-check --check true').errors[0], /exclude/);
  assert.match(parseGoalArgs('x --bogus').errors[0], /unknown flag --bogus/);
});

test('a likely /goal command typo cannot replace the goal or archive its files without confirmation', async () => {
  const cwd = project();
  const f = fakePi();
  const notes = [], confirmations = [];
  let accept = false;
  const ctx = { cwd, hasUI: true, ui: { notify: (m) => notes.push(m), confirm: async (...args) => {
    confirmations.push(args); return accept;
  } } };
  await f.commands.goal.handler('build it --check "true"', ctx);
  writeFileSync(join(cwd, '.mina', 'plan.md'), 'current plan');
  const id = f.entries.at(-1).data.id;
  for (const typo of ['resum3', 'resuem', 'staus', 'amendmnt']) {
    await f.commands.goal.handler(typo, ctx);
    assert.equal(f.entries.at(-1).data.id, id);
    assert.equal(readFileSync(join(cwd, '.mina', 'plan.md'), 'utf8'), 'current plan');
  }
  assert.equal(confirmations.length, 4);
  assert.match(confirmations[0].join(' '), /resume/);
  assert.deepEqual(f.upstream, ['build it']);
  await f.commands.goal.handler('resum3', { cwd, hasUI: false });
  assert.equal(f.entries.at(-1).data.id, id);
  accept = true;
  await f.commands.goal.handler('resum3', ctx);  // a deliberate one-word objective remains possible
  assert.notEqual(f.entries.at(-1).data.id, id);
  assert.deepEqual(f.upstream, ['build it', 'resum3']);
  await f.commands.goal.handler('check the analysis --protect-checks', ctx); // ordinary prose does not prompt
  await f.commands.goal.handler('goal.md --protect-checks', ctx);
  assert.equal(confirmations.length, 5);
});

test('instructions name the phases that apply', () => {
  const plan = goalInstructions({ research: true, mode: 'plan', checks: [] });
  assert.match(plan, /mina-research/); assert.match(plan, /mina_propose_checks/); assert.match(plan, /from the project folder/); assert.match(plan, /reruns every check/);
  const none = goalInstructions({ research: false, mode: 'none', checks: [] });
  assert.doesNotMatch(none, /mina-research/); assert.match(none, /UNVERIFIED/);
  for (const state of [
    { checkPolicy: 'working', research: true, mode: 'working', checks: [] },
    { mode: 'plan', research: true, settled: false, checks: [] },
    { mode: 'given', checks: [{ id: 'R1', command: 'true' }] },
    { mode: 'none', checks: [] },
  ]) {
    assert.doesNotMatch(goalInstructions(state), /mina_close_doubt|numbers\.md|provenance\.md/);
  }
});

test('rejection feedback lists only failed checks, with the output tail', () => {
  assert.equal(rejectionFeedback([{ id: 'R1', command: 'true', code: 0 }]), null);
  const fb = rejectionFeedback([{ id: 'R1', command: 'true', code: 0 }, { id: 'R2', command: 'npm test', code: 1, stdout: 'x'.repeat(3000) + 'FAIL here' }]);
  assert.match(fb, /REFUSED/); assert.match(fb, /R2: `npm test` exited 1/); assert.match(fb, /FAIL here/); assert.doesNotMatch(fb, /R1/);
});

test('.mina paths and edited check lines', () => {
  assert.ok(isMinaPath('.mina/briefs/x.md', '/p')); assert.ok(isMinaPath('/p/.mina/briefs/x.md', '/p'));
  assert.ok(!isMinaPath('src/x.js', '/p')); assert.ok(!isMinaPath('/p/.minax/y', '/p'));
  assert.ok(isCheckPath('/p/.mina/checks/r2.py', '/p')); assert.ok(isCheckPath('.mina/checks/r2.py', '/p')); assert.ok(!isCheckPath('.mina/briefs/a.md', '/p'));
  assert.deepEqual(parseCheckLines('# c\nR1: npm test\n\nmake check'), [{ id: 'R1', command: 'npm test', proves: '' }, { id: 'R2', command: 'make check', proves: '' }]);
});

// A fresh project folder for goal integration tests.
const project = (cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'))) => {
  mkdirSync(join(cwd, '.mina'), { recursive: true });
  return cwd;
};
const DONE = project();

// A fake Pi with the parts the extension uses, and a fake pi-goal that registers /goal and goal_complete.
function fakePi({ execCodes = [], execResults = [], syntaxBad = [], dryRuns = [], env, onExec, tuning = null, measure, amendWaitMs, readTuning, snapshot = async () => null } = {}) {
  const handlers = {}, tools = {}, commands = {}, entries = [], messages = [], upstream = [], sent = [];
  const pi = {
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
    registerTool: (t) => { tools[t.name] = t; },
    registerCommand: (name, opts) => { commands[name] = opts; },
    appendEntry: (type, data) => entries.push({ type, data: structuredClone(data) }),
    sendMessage: (m) => messages.push(m),
    sendUserMessage: (text, opts) => sent.push({ text, opts }),
    exec: async (_cmd, args, opts) => (await onExec?.(args), args[0] === '-n'
      ? { code: syntaxBad.includes(args[2]) ? 2 : 0, killed: false, stdout: '', stderr: 'bash: syntax error near unexpected token' }
      : opts?.timeout === DRY_RUN_TIMEOUT_MS ? (dryRuns.shift() ?? { code: 1, killed: false, stdout: 'FAIL: not done yet', stderr: '' })
        : (execResults.shift() ?? { code: execCodes.shift() ?? 0, killed: false, stdout: 'out', stderr: '' })),
  };
  const fakeGoal = (api) => api.registerCommand('goal', { description: 'upstream', handler: async (args) => upstream.push(args) });
  createMinaGoal(pi, { goalExtension: fakeGoal, env, sandboxAvailable: true, tuning, measure, amendWaitMs, readTuning, snapshot });
  const emit = async (ev, event, ctx = { cwd: DONE, hasUI: false }) => { let out; for (const fn of handlers[ev] ?? []) out = (await fn(event, ctx)) ?? out; return out; };
  return { pi, tools, commands, entries, messages, upstream, emit, sent };
}

test("a new /goal moves the previous goal's working files to .mina/archive/, keeping briefs/; the agent is told where", async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true }); mkdirSync(join(cwd, '.mina', 'briefs'));
  for (const n of ['doubts.md', 'numbers.md', 'plan.md', 'provenance.md', 'reverify.py']) writeFileSync(join(cwd, '.mina', n), 'old');
  writeFileSync(join(cwd, '.mina', 'checks', 'check_a.py'), 'old'); writeFileSync(join(cwd, '.mina', 'briefs', 'b.md'), 'ledger');
  const f = fakePi();
  await f.commands.goal.handler('pass three --protect-checks', { cwd, hasUI: false });
  const left = readdirSync(join(cwd, '.mina')).sort();
  assert.deepEqual(left, ['archive', 'briefs', 'checks']);                          // old checks are offered at the next proposal
  const [dir] = readdirSync(join(cwd, '.mina', 'archive'));
  assert.deepEqual(readdirSync(join(cwd, '.mina', 'archive', dir)).sort(), ['doubts.md', 'numbers.md', 'plan.md', 'provenance.md', 'reverify.py']);
  assert.match(f.messages[0].content, new RegExp(`previous goal's working files[^]*\\.mina/archive/${dir}`));
});

test('an objective that is a path to a file: mina gives the agent the file text, and keeps the path for pi-goal', async () => {
  // A test run: a 5,719-character prompt exceeded pi-goal's 4,000-character limit, whose error says to put long
  // instructions in a file; the objective became "~/mina-goals/long-objective.md".
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  writeFileSync(join(cwd, 'goal.md'), 'Third pass. Find the best strategy.\nKill ideas quickly.\n');
  const f = fakePi();
  await f.commands.goal.handler('goal.md --protect-checks', { cwd, hasUI: false });
  assert.deepEqual(f.upstream, ['goal.md']);
  const st = f.entries.at(-1).data;
  assert.equal(st.objective_file, join(cwd, 'goal.md'));
  assert.match(f.messages[0].content, /objective is the text of the file [^]*goal\.md[^]*Third pass\. Find the best strategy\.\nKill ideas quickly\./);
  await f.commands.goal.handler('build a parser for goal.md files --protect-checks', { cwd, hasUI: false });   // prose that names a file is not a file objective
  assert.equal(f.entries.at(-1).data.objective_file, undefined);
});

test('a first /goal in a fresh project archives nothing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  const f = fakePi();
  await f.commands.goal.handler('build it --protect-checks', { cwd, hasUI: false });
  assert.ok(!existsSync(join(cwd, '.mina', 'archive')));
  assert.doesNotMatch(f.messages[0].content, /archive/);
});

test('plan mode: writes refused until checks are proposed; completion rerun refuses on failure, then accepts', async () => {
  const f = fakePi({ execCodes: [1, 0] });
  await f.commands.goal.handler('build the thing --protect-checks', { cwd: '/p', hasUI: false });
  assert.deepEqual(f.upstream, ['build the thing']);
  assert.match(f.messages[0].content, /mina_propose_checks/);
  assert.equal((await f.emit('tool_call', { toolName: 'write', input: { path: 'src/a.js' } }))?.block, true);
  assert.equal(await f.emit('tool_call', { toolName: 'write', input: { path: '.mina/briefs/a.md' } }), undefined);
  assert.equal((await f.emit('tool_call', { toolName: 'goal_complete', input: {} }))?.block, true);
  const r = await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'npm test', proves: 'tests pass' }] }, null, null, { hasUI: false });
  assert.match(r.content[0].text, /accepted/);
  assert.equal(await f.emit('tool_call', { toolName: 'write', input: { path: 'src/a.js' } }), undefined);
  const refused = await f.emit('tool_call', { toolName: 'goal_complete', input: {} });
  assert.equal(refused.block, true); assert.match(refused.reason, /R1: `npm test` exited 1/);
  assert.equal(await f.emit('tool_call', { toolName: 'goal_complete', input: {} }), undefined);
  await f.emit('tool_result', { toolName: 'goal_complete', isError: false, content: [{ type: 'text', text: 'Goal complete: done' }] });
  assert.equal(f.entries.at(-1).data.status, 'complete'); assert.equal(f.entries.at(-1).data.unverified, false);
});

test('--check skips planning; --no-check is UNVERIFIED; pi-goal refusals do not count as completion', async () => {
  const f = fakePi({ execCodes: [0] });
  await f.commands.goal.handler('x --check "make test" --no-research', { cwd: '/p', hasUI: false });
  assert.equal(f.entries.at(-1).data.checkApproval, 'user');
  assert.equal(await f.emit('tool_call', { toolName: 'write', input: { path: 'src/a.js' } }), undefined);
  assert.doesNotMatch(f.messages[0].content, /mina-research/);
  await f.emit('tool_result', { toolName: 'goal_complete', isError: false, content: [{ type: 'text', text: 'Goal completion rejected: goal is paused, not active.' }] });
  assert.equal(f.entries.at(-1).data.status, 'active');
  const g = fakePi();
  await g.commands.goal.handler('y --no-check', { cwd: '/p', hasUI: false });
  assert.equal(await g.emit('tool_call', { toolName: 'goal_complete', input: {} }), undefined);
  await g.emit('tool_result', { toolName: 'goal_complete', isError: false, content: [{ type: 'text', text: 'Goal complete: y' }] });
  assert.equal(g.entries.at(-1).data.unverified, true);
});

test('pass-through subcommands reach pi-goal unchanged; clear ends the mina goal', async () => {
  const f = fakePi();
  await f.commands.goal.handler('z --no-check', { cwd: '/p', hasUI: false });
  await f.commands.goal.handler('pause', {});
  await f.commands.goal.handler('clear', {});
  assert.deepEqual(f.upstream, ['z', 'pause', 'clear']);
  assert.equal(f.entries.at(-1).data.status, 'cleared');
});

const ui = (answers) => ({ hasUI: true, cwd: '/p', ui: { notify: () => {}, select: async () => answers.shift(), editor: async () => answers.shift() } });

test('a proposed check that is not valid shell is sent back to the model', async () => {
  const f = fakePi({ syntaxBad: ['echo "unclosed'] });
  await f.commands.goal.handler('w --protect-checks', { cwd: '/p', hasUI: false });
  await assert.rejects(f.tools.mina_propose_checks.execute('id', { restated_objective: 'w', checks: [{ command: 'echo "unclosed', proves: 'x' }] }, null, null, { hasUI: false, cwd: '/p' }), /not valid shell/);
  assert.equal(f.entries.at(-1).data.settled, false);
});

test('replacing accepted checks needs a reason and the user; keeping them leaves the checks unchanged', async () => {
  const f = fakePi();
  await f.commands.goal.handler('w --check "make test"', { cwd: '/p', hasUI: false });
  const proposal = { restated_objective: 'w', checks: [{ command: 'make check', proves: 'x' }] };
  await assert.rejects(f.tools.mina_propose_checks.execute('id', proposal, null, null, ui(['Accept the new checks'])), /with a reason/);
  const queued = await f.tools.mina_propose_checks.execute('id', { ...proposal, reason: 'R1 is broken' }, null, null, { hasUI: false, cwd: '/p' });
  assert.match(queued.content[0].text, /queued/);                                        // no user: queued for /goal amendment
  const kept = await f.tools.mina_propose_checks.execute('id', { ...proposal, reason: 'R1 is broken' }, null, null, ui(['Keep the current checks']));
  assert.match(kept.content[0].text, /kept/); assert.equal(f.entries.at(-1).data.checks[0].command, 'make test');
  assert.equal(f.entries.at(-1).data.pendingAmendment, undefined);                       // answered now: the queued one is gone
  await f.tools.mina_propose_checks.execute('id', { ...proposal, reason: 'R1 is broken' }, null, null, ui(['Accept the new checks']));
  assert.equal(f.entries.at(-1).data.checks[0].command, 'make check');
});

test('a queued check amendment stays visible until the user decides, survives resume, and clears on shutdown', async () => {
  const f = fakePi({ amendWaitMs: 1 });
  const cwd = project();
  const widgets = new Map(), notes = [];
  const ctx = { cwd, hasUI: true, ui: {
    notify: (m) => notes.push(m), setWidget: (key, lines) => widgets.set(key, lines),
    select: async () => { await new Promise((r) => setTimeout(r, 5)); return undefined; },
  } };
  await f.commands.goal.handler('build it --check "true"', ctx);
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 'build it', reason: 'R1 misses the output',
    checks: [{ command: 'test -f output', proves: 'output exists' }] }, null, null, ctx);
  const pending = structuredClone(f.entries.at(-1).data);
  const visible = () => [...widgets.values()].filter(Boolean).flat().join('\n');
  assert.match(visible(), /R1 misses the output[^]*\/goal amendment/);
  assert.match(notes.at(-1), /\/goal amendment/);
  const resumed = fakePi();
  await resumed.emit('session_start', {}, { ...ctx, sessionManager: {
    getBranch: () => [{ type: 'custom', customType: 'mina-goal', data: pending }],
  } });
  assert.match(visible(), /\/goal amendment/);
  ctx.ui.select = async () => 'Keep the current checks';
  await resumed.commands.goal.handler('amendment', ctx);
  assert.equal(visible(), '');
  assert.equal(resumed.entries.at(-1).data.pendingAmendment, undefined);
  await resumed.emit('session_start', {}, { ...ctx, sessionManager: {
    getBranch: () => [{ type: 'custom', customType: 'mina-goal', data: pending }],
  } });
  assert.match(visible(), /\/goal amendment/);
  await resumed.emit('session_shutdown', {}, ctx);
  assert.equal(visible(), '');
  const restore = () => resumed.emit('session_start', {}, { ...ctx, sessionManager: {
    getBranch: () => [{ type: 'custom', customType: 'mina-goal', data: pending }],
  } });
  await restore();
  ctx.ui.select = async () => 'Accept the new checks';
  await resumed.commands.goal.handler('amendment', ctx);
  assert.equal(resumed.entries.at(-1).data.checks[0].command, 'test -f output');
  assert.equal(visible(), '');
  await restore();
  await resumed.commands.goal.handler('clear', ctx);
  assert.equal(visible(), '');
  await restore();
  await resumed.commands.goal.handler('new objective --no-check', ctx);
  assert.equal(visible(), '');
});

test('a replacement-script amendment is not refused because the obsolete script cannot import', async () => {
  const cwd = project();
  mkdirSync(join(cwd, '.mina', 'checks'));
  writeFileSync(join(cwd, '.mina', 'checks', 'r1.py'), 'import missing_module\n');
  const f = fakePi({ dryRuns: [{ code: 1, stdout: '', stderr: 'ModuleNotFoundError: missing_module', killed: false }] });
  await f.commands.goal.handler('build it --check "python3 .mina/checks/r1.py"', { cwd, hasUI: false });
  const r = await f.tools.mina_propose_checks.execute('id', { restated_objective: 'build it', reason: 'wrong import',
    checks: [{ command: 'python3 .mina/checks/r1.py', proves: 'output exists' }],
    files: [{ path: '.mina/checks/r1.py', content: 'assert True\n' }],
    requirements: [{ requirement: 'output exists', enforced_by: 'R1' }],
  }, null, null, { cwd, hasUI: false });
  assert.equal(r.details.decision, 'queued');
  assert.equal(readFileSync(join(cwd, '.mina', 'checks', 'r1.py'), 'utf8'), 'import missing_module\n');
  const title = [];
  const ctx = { cwd, hasUI: true, ui: { notify: () => {}, select: async (text) => { title.push(text); return 'Accept the new checks'; } } };
  await f.commands.goal.handler('amendment', ctx);
  assert.match(title[0], /NOT RUN[^]*proposed replacement/);
  assert.match(title[0], /output exists -> R1/);
  assert.deepEqual(f.entries.at(-1).data.requirements, [{ requirement: 'output exists', enforced_by: 'R1' }]);
  assert.equal(readFileSync(join(cwd, '.mina', 'checks', 'r1.py'), 'utf8'), 'assert True\n');
});

test('check files are frozen at acceptance: edits refused, a changed file refuses completion', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true });
  writeFileSync(join(cwd, '.mina', 'checks', 'r1.sh'), 'test -f out.txt\n');
  const f = fakePi();
  await f.commands.goal.handler('v --protect-checks', { cwd, hasUI: false });
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 'v', checks: [{ command: 'bash .mina/checks/r1.sh', proves: 'x' }] }, null, null, { hasUI: false, cwd });
  assert.equal((await f.emit('tool_call', { toolName: 'edit', input: { path: join(cwd, '.mina/checks/r1.sh') } }, { cwd, hasUI: false }))?.block, true);
  writeFileSync(join(cwd, '.mina', 'checks', 'r1.sh'), 'true\n');
  const r = await f.emit('tool_call', { toolName: 'goal_complete', input: {} }, { cwd, hasUI: false });
  assert.equal(r.block, true); assert.match(r.reason, /changed after the user accepted/);
});

test('the user can add, withdraw and edit checks', async () => {
  const f = fakePi();
  await f.commands.goal.handler('u --check "make a"', { cwd: '/p', hasUI: false });
  await f.commands.goal.handler('add-check "make b"', { cwd: '/p', hasUI: false });
  assert.deepEqual(f.entries.at(-1).data.checks.map((c) => c.command), ['make a', 'make b']);
  await f.commands.goal.handler('withdraw-check R1', { cwd: '/p', hasUI: false });
  assert.deepEqual(f.entries.at(-1).data.checks.map((c) => [c.id, c.command]), [['R1', 'make b']]);
  await f.commands.goal.handler('edit-checks', ui(['R1: make c\nmake d']));
  assert.deepEqual(f.entries.at(-1).data.checks.map((c) => c.command), ['make c', 'make d']);
  assert.match(f.messages.at(-1).content, /The user changed the checks/);
});

test('a check that names a script not yet written is sent back before acceptance', async () => {
  assert.deepEqual(checkScriptsIn('bash .mina/checks/b.sh && python3 ./.mina/checks/sub/c.py'), ['.mina/checks/b.sh', '.mina/checks/sub/c.py']);
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  const f = fakePi();
  await f.commands.goal.handler('s --protect-checks', { cwd, hasUI: false });
  const proposal = { restated_objective: 's', checks: [{ command: 'bash .mina/checks/b.sh', proves: 'x' }] };
  await assert.rejects(f.tools.mina_propose_checks.execute('id', proposal, null, null, { hasUI: false, cwd }), /do not exist yet/);
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true }); writeFileSync(join(cwd, '.mina', 'checks', 'b.sh'), 'true\n');
  await f.tools.mina_propose_checks.execute('id', proposal, null, null, { hasUI: false, cwd });
  assert.equal(f.entries.at(-1).data.settled, true);
});

test('an amendment can replace a frozen check script, written only after the user accepts', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true });
  writeFileSync(join(cwd, '.mina', 'checks', 'r1.sh'), 'cd .. && test -f x\n');
  const f = fakePi();
  await f.commands.goal.handler('t --protect-checks', { cwd, hasUI: false });
  const checks = [{ command: 'bash .mina/checks/r1.sh', proves: 'x' }];
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 't', checks }, null, null, { hasUI: false, cwd });
  const fix = { restated_objective: 't', checks, reason: 'r1.sh cds to the wrong folder', files: [{ path: '.mina/checks/r1.sh', content: 'test -f x\n' }] };
  const asked = [];
  const keep = { ...ui(['Keep the current checks']), cwd }; let n = 0;
  keep.ui.select = async (title, opts) => (n++ === 0 ? opts.find((o) => /full proposal/.test(o)) : 'Keep the current checks');
  keep.ui.editor = async (_t, text) => { asked.push(text); return text; };
  await f.tools.mina_propose_checks.execute('id', fix, null, null, keep);
  assert.match(asked[0], /New content for .mina\/checks\/r1.sh/);
  assert.equal(readFileSync(join(cwd, '.mina', 'checks', 'r1.sh'), 'utf8'), 'cd .. && test -f x\n');
  await f.tools.mina_propose_checks.execute('id', fix, null, null, { ...ui(['Accept the new checks']), cwd });
  assert.equal(readFileSync(join(cwd, '.mina', 'checks', 'r1.sh'), 'utf8'), 'test -f x\n');
  // re-frozen with the new content: completion is not refused as tampering
  const r = await f.emit('tool_call', { toolName: 'goal_complete', input: {} }, { cwd, hasUI: false });
  assert.equal(r, undefined);
  await assert.rejects(f.tools.mina_propose_checks.execute('id', { ...fix, files: [{ path: '.mina/checks/../../src/evil.py', content: '' }] }, null, null, { ...ui(['Accept the new checks']), cwd }), /under .mina\/checks/);
});

test('a missing future deliverable fails proposal review but the unchanged checker can later pass', async () => {
  const cwd = project();
  const target = join(cwd, 'future.json');
  const command = `from pathlib import Path\nassert Path(${JSON.stringify(target)}).read_text() == 'valid'`;
  const run = () => { const r = spawnSync('/usr/bin/python3', ['-c', command], { encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const initial = run();
  assert.equal(initial.code, 1);
  const f = fakePi({ dryRuns: [initial] });
  await f.commands.goal.handler('produce and validate future data --protect-checks', { cwd, hasUI: false });
  const shown = [];
  await f.tools.mina_propose_checks.execute('proposal', { restated_objective: 'produce valid data', checks: [{ command: 'python checker.py', proves: 'valid data' }] }, null, null,
    { cwd, hasUI: true, ui: { select: async title => { shown.push(title); return 'Accept'; }, editor: async () => '', notify() {} } });
  assert.match(shown[0], /fails now \(exit 1\)/);
  assert.match(shown[0], /FileNotFoundError/);
  assert.doesNotMatch(shown[0], /cannot pass|whatever the work does|script is fixed|check\(s\) crashed/);
  writeFileSync(target, 'valid');
  assert.equal(run().code, 0, 'same checker succeeds when the work supplies the deliverable');
  assert.equal(dryRunVerdict({ code: 1, stdout: 'FAIL: No such file or directory: future.json' }).status, 'fails');
  assert.equal(dryRunVerdict({ code: 1, stderr: 'Traceback (most recent call last):\nAssertionError: wrong result' }).status, 'fails');
});

test('proposal helpers: unused scripts, proposal-time verdicts, the summary the user decides on', () => {
  const checks = [{ id: 'R1', command: './.venv/bin/python .mina/checks/a.py', proves: 'a' }];
  assert.deepEqual(unusedCheckScripts(['.mina/checks/a.py', '.mina/checks/old.py'], checks), ['.mina/checks/old.py']);
  assert.equal(dryRunVerdict({ code: 1, stdout: 'FAIL: results missing' }).status, 'fails');
  assert.equal(dryRunVerdict({ code: 0, stdout: 'OK' }).status, 'passes');
  assert.equal(dryRunVerdict({ code: 1, stderr: 'Traceback (most recent call last):\n  ...\nValueError: x' }).status, 'fails');
  assert.equal(dryRunVerdict({ code: 1, stderr: 'SyntaxError: invalid syntax' }).status, 'crashed');
  assert.equal(dryRunVerdict({ code: 127, stderr: 'bash: foo: command not found' }).status, 'crashed');
  assert.equal(dryRunVerdict({ code: null, killed: true }).status, 'timeout');
  const sum = proposalSummary({ restated: 'build', checks, dryRuns: [{ id: 'R1', text: 'fails now (exit 1)' }], uncovered: ['the DSR'], unused: ['.mina/checks/old.py'] });
  assert.match(sum, /now: fails now/); assert.match(sum, /Not covered by any check \(the agent says\):\n- the DSR/); assert.match(sum, /not run at completion[^]*old\.py/);
  assert.match(proposalSummary({ restated: 'b', checks }), /the agent listed nothing/);
  assert.match(goalInstructions({ research: false, mode: 'plan', checks: [] }), /raw inputs[^]*uncovered[^]*earlier goal do not/);
});

test('a proposal runs each check once, shows the user the runs, uncovered requirements and old scripts, and offers the scripts to read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  mkdirSync(join(dir, '.mina', 'checks'), { recursive: true });
  writeFileSync(join(dir, '.mina', 'checks', 'old_goal.py'), 'print(1)\n');
  const f = fakePi({ dryRuns: [{ code: 0, killed: false, stdout: 'OK', stderr: '' }] });
  await f.commands.goal.handler('build the thing --protect-checks', { cwd: dir, hasUI: false });
  const shown = [], selects = [];
  const ui = { select: async (title, options) => { selects.push(title); return selects.length === 1 ? 'Show the check scripts' : selects.length === 2 ? options.find((o) => /full proposal/.test(o)) : 'Accept'; },
    editor: async (title, text) => { shown.push(text); return text; }, notify: () => {} };
  const r = await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', uncovered: ['older history'],
    checks: [{ command: 'python3 .mina/checks/new.py', proves: 'p' }], files: [{ path: '.mina/checks/new.py', content: 'import sys; sys.exit("FAIL")\n' }] }, null, null, { cwd: dir, hasUI: true, ui });
  assert.match(selects[0], /now: PASSES ALREADY/);
  assert.match(shown[0], /===== \.mina\/checks\/new\.py\nimport sys/);
  assert.match(shown[1], /- older history/); assert.match(shown[1], /\.mina\/checks\/old_goal\.py/);
  assert.equal(selects.length, 3);
  assert.match(r.content[0].text, /accepted by the user/); assert.match(r.content[0].text, /PASSES ALREADY/);
  assert.match(r.content[0].text, /reruns only these checks[^]*not checks for this goal[^]*old_goal\.py/);
  assert.deepEqual(f.entries.at(-1).data.uncovered, ['older history']);
});

test('missing setup goes back to the agent while runtime exceptions reach proposal review as observed failures', async () => {
  // A test run: "python3 .mina/checks/check_outputs.py" crashed with
  // ModuleNotFoundError (pandas is in ./.venv); the user accepted it among two "fails as expected" lines.
  const dir = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  const crash = { code: 1, killed: false, stdout: '', stderr: 'Traceback (most recent call last):\n  File "x.py", line 1\nModuleNotFoundError: No module named \'pandas\'' };
  const f = fakePi({ dryRuns: [crash] });
  await f.commands.goal.handler('build it --protect-checks', { cwd: dir, hasUI: false });
  const selects = [];
  const ui = { select: async (t) => { selects.push(t); return 'Accept'; }, editor: async () => '', notify: () => {} };
  await assert.rejects(f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'python3 .mina/checks/c.py', proves: 'p' }],
    files: [{ path: '.mina/checks/c.py', content: 'import pandas\n' }] }, null, null, { cwd: dir, hasUI: true, ui }),
    /Not shown to the user[^]*cannot run[^]*R1: [^]*No module named 'pandas'[^]*interpreter/);
  assert.equal(selects.length, 0); assert.equal(f.entries.at(-1).data.settled, false);
  // A runtime exception reaches review without claiming the checker must change.
  const g = fakePi({ dryRuns: [{ code: 1, killed: false, stdout: '', stderr: 'Traceback (most recent call last):\nKeyError: \'sharpe\'' }] });
  await g.commands.goal.handler('build it --protect-checks', { cwd: dir, hasUI: false });
  const shown = [];
  const ui2 = { select: async (t) => { shown.push(t); return 'Accept'; }, editor: async () => '', notify: () => {} };
  await g.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'python3 .mina/checks/c.py', proves: 'p' }] }, null, null, { cwd: dir, hasUI: true, ui: ui2 });
  assert.match(shown[0], /fails now \(exit 1\)[^]*KeyError/);
  assert.doesNotMatch(shown[0], /cannot pass until|check\(s\) crashed/);
});

test('replacement checks are run too before the user decides, and an environment crash goes back to the agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  const f = fakePi({ dryRuns: [{ code: 1, killed: false, stdout: 'FAIL: not done', stderr: '' }, { code: 127, killed: false, stdout: '', stderr: 'bash: line 1: ./venv/bin/python: No such file or directory' }] });
  await f.commands.goal.handler('build it --protect-checks', { cwd: dir, hasUI: false });
  const ok = { select: async () => 'Accept', editor: async () => '', notify: () => {} };
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'true', proves: 'p' }] }, null, null, { cwd: dir, hasUI: true, ui: ok });
  const asked = [];
  const ui = { select: async (t) => { asked.push(t); return 'Accept the new checks'; }, editor: async () => '', notify: () => {} };
  await assert.rejects(f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', reason: 'interpreter', checks: [{ command: './venv/bin/python c.py', proves: 'p' }] },
    null, null, { cwd: dir, hasUI: true, ui }), /cannot run[^]*No such file or directory/);
  assert.equal(asked.length, 0);
});

test('a long check proposal keeps a short dialog; the full proposal opens in a scrollable view (IV-1b, 2026-10-17)', async () => {
  // The whole summary (checks, requirement map, uncovered items) was the selection title, which does not scroll:
  // the user saw nothing and could not choose.
  const dir = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  const f = fakePi({ dryRuns: [{ code: 1, killed: false, stdout: 'FAIL: receipts missing', stderr: '' }, { code: 1, killed: false, stdout: 'FAIL: no timing', stderr: '' }] });
  await f.commands.goal.handler('execute the long phase --protect-checks', { cwd: dir, hasUI: false });
  const requirements = Array.from({ length: 12 }, (_, i) => ({ requirement: `requirement ${i} ` + 'detail '.repeat(20), enforced_by: `K${i % 3}` }));
  const titles = [], viewed = [];
  const ui = { notify: () => {}, editor: async (_t, text) => { viewed.push(text); return text; },
    select: async (t, opts) => { titles.push([t, opts]); return titles.length === 1 ? opts.find((o) => /full proposal/.test(o)) : 'Accept'; } };
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 'Execute the long phase. ' + 'context '.repeat(60), requirements, uncovered: ['scientific judgement'],
    checks: [{ command: 'python3 .mina/checks/a.py', proves: 'p1' }, { command: 'python3 .mina/checks/b.py', proves: 'p2' }],
    files: [{ path: '.mina/checks/a.py', content: 'raise SystemExit("FAIL")\n' }, { path: '.mina/checks/b.py', content: 'raise SystemExit("FAIL")\n' }] }, null, null, { cwd: dir, hasUI: true, ui });
  assert.equal(titles.length, 2, 'the choice is shown again after the full view');
  for (const [t] of titles) {
    assert.ok(t.length < 1200, `short title (${t.length})`);
    assert.match(t, /R1: python3 \.mina\/checks\/a\.py[^]*fails now[^]*receipts missing/);
    assert.match(t, /R2: python3 \.mina\/checks\/b\.py[^]*no timing/);
    assert.doesNotMatch(t, /requirement 7/);
  }
  assert.match(viewed[0], /requirement 11[^]*-> K2/); assert.match(viewed[0], /scientific judgement/);
  assert.equal(f.entries.at(-1).data.checkApproval, 'user');
});

test('a check change nobody answers is queued: the agent keeps working, completion waits, the user decides with /goal amendment', async () => {
  // A test run: twice the agent worked around a broken frozen check (R3 crashed; R2 passed wrong outputs)
  // instead of asking for a fix, because the dialog would have blocked it until the user came back.
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true });
  writeFileSync(join(cwd, '.mina', 'checks', 'r1.sh'), 'exit 1  # buggy\n');
  const f = fakePi({ amendWaitMs: 30 });
  await f.commands.goal.handler('t --protect-checks', { cwd, hasUI: false });
  const checks = [{ command: 'bash .mina/checks/r1.sh', proves: 'x' }];
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 't', checks }, null, null, { hasUI: false, cwd });
  const fix = { restated_objective: 't', checks, reason: 'r1.sh exits 1 always', files: [{ path: '.mina/checks/r1.sh', content: 'exit 0\n' }] };
  const waits = [];
  const away = { cwd, hasUI: true, ui: { notify: () => {}, editor: async () => '', select: async (_t, _o, opts) => { waits.push(opts?.timeout); await new Promise((r) => setTimeout(r, 40)); return undefined; } } };
  const r = await f.tools.mina_propose_checks.execute('id', fix, null, null, away);
  assert.deepEqual(waits, [30]);
  assert.match(r.content[0].text, /queued[^]*\/goal amendment[^]*keep working[^]*do not adapt/i);
  assert.equal(readFileSync(join(cwd, '.mina', 'checks', 'r1.sh'), 'utf8'), 'exit 1  # buggy\n');      // not applied yet
  const refused = await f.emit('tool_call', { toolName: 'goal_complete', input: {} }, { cwd, hasUI: false });
  assert.equal(refused.block, true); assert.match(refused.reason, /check change[^]*waiting for the user[^]*\/goal amendment/);
  // the user comes back and accepts
  const here = { cwd, hasUI: true, ui: { notify: () => {}, editor: async () => '', select: async (t) => { assert.match(t, /r1\.sh exits 1 always[^]*exit 0/); return 'Accept the new checks'; } } };
  await f.commands.goal.handler('amendment', here);
  assert.equal(readFileSync(join(cwd, '.mina', 'checks', 'r1.sh'), 'utf8'), 'exit 0\n');
  assert.equal(f.entries.at(-1).data.pendingAmendment, undefined);
  assert.match(f.messages.at(-1).content, /user accepted the check change you asked for/);
  assert.equal(await f.emit('tool_call', { toolName: 'goal_complete', input: {} }, { cwd, hasUI: false }), undefined);
});

test('without an interactive user a check change is queued at once; keeping the current checks clears it and tells the agent', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  const f = fakePi();
  await f.commands.goal.handler('t --protect-checks', { cwd, hasUI: false });
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 't', checks: [{ command: 'true', proves: 'x' }] }, null, null, { hasUI: false, cwd });
  const r = await f.tools.mina_propose_checks.execute('id', { restated_objective: 't', reason: 'r', checks: [{ command: 'false', proves: 'y' }] }, null, null, { hasUI: false, cwd });
  assert.match(r.content[0].text, /queued/);
  await f.commands.goal.handler('amendment', { cwd, hasUI: true, ui: { notify: () => {}, editor: async () => '', select: async () => 'Keep the current checks' } });
  assert.equal(f.entries.at(-1).data.pendingAmendment, undefined);
  assert.equal(f.entries.at(-1).data.checks[0].command, 'true');
  assert.match(f.messages.at(-1).content, /kept the current checks/);
});

test('a proposal maps each requirement of the objective to the check that enforces it, and the user sees the map', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  const f = fakePi();
  await f.commands.goal.handler('beat the baseline on both test sets --protect-checks', { cwd, hasUI: false });
  const shown = []; let picks = 0;
  const ui2 = { select: async (t, opts) => (picks++ === 0 ? opts.find((o) => /full proposal/.test(o)) : 'Accept'), editor: async (_t, text) => { shown.push(text); return text; }, notify: () => {} };
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'true', proves: 'x' }],
    requirements: [{ requirement: 'paired bootstrap CI on both test sets', enforced_by: 'R1' }, { requirement: 'the legacy test set', enforced_by: 'uncovered: no data for the legacy set' }] },
    null, null, { cwd, hasUI: true, ui: ui2 });
  assert.match(shown[0], /Requirements of the objective[^]*paired bootstrap CI on both test sets -> R1[^]*the legacy test set -> uncovered: no data for the legacy set/);
  assert.equal(f.entries.at(-1).data.requirements.length, 2);
  const g = fakePi();
  await g.commands.goal.handler('b --protect-checks', { cwd, hasUI: false });
  const shown2 = [];
  await g.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'true', proves: 'x' }] }, null, null,
    { cwd, hasUI: true, ui: { select: async (t) => { shown2.push(t); return 'Accept'; }, editor: async () => '', notify: () => {} } });
  assert.match(shown2[0], /The agent mapped no requirements to checks/);
});

test('the user can send a proposal back with feedback; nothing is settled; closing the dialog declines nothing', async () => {
  const f = fakePi();
  await f.commands.goal.handler('build the thing --protect-checks', { cwd: '/p', hasUI: false });
  const answers = ['Request changes (your feedback goes back to the agent)', 'Request changes (your feedback goes back to the agent)'];
  const edits = ['', 'compare against the 60/40 at its own vol'];
  const ui = { select: async () => answers.shift(), editor: async () => edits.shift(), notify: () => {} };
  const r = await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'npm test', proves: 'p' }] }, null, null, { cwd: '/p', hasUI: true, ui });
  assert.match(r.content[0].text, /asked for changes:\ncompare against the 60\/40 at its own vol/); assert.match(r.content[0].text, /Nothing is settled/);
  assert.equal(r.details.decision, 'changes requested');
  assert.equal((await f.emit('tool_call', { toolName: 'write', input: { path: 'src/a.js' } }))?.block, true);
  const closed = await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'npm test', proves: 'p' }] }, null, null,
    { cwd: '/p', hasUI: true, ui: { select: async () => undefined, editor: async () => '', notify: () => {} } });
  assert.match(closed.content[0].text, /closed the dialog without deciding/);
  assert.equal(f.entries.filter((e) => e.data.settled).length, 0);
  const ok = await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'npm test', proves: 'p' }] }, null, null,
    { cwd: '/p', hasUI: true, ui: { select: async () => 'Accept', editor: async () => '', notify: () => {} } });
  assert.match(ok.content[0].text, /accepted by the user/);
});

test('an amendment can come from a draft file: written by the agent, copied in only when the user accepts', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true });
  writeFileSync(join(cwd, '.mina', 'checks', 'r1.py'), 'old\n');
  const f = fakePi();
  await f.commands.goal.handler('t --protect-checks', { cwd, hasUI: false });
  const checks = [{ command: 'python3 .mina/checks/r1.py', proves: 'x' }];
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 't', checks }, null, null, { hasUI: false, cwd });
  // the frozen folder refuses edits, and the refusal names the draft folder; the draft folder is writable
  const refused = await f.emit('tool_call', { toolName: 'write', input: { path: '.mina/checks/r1.py' } }, { cwd, hasUI: false });
  assert.match(refused.reason, /\.mina\/checks-proposed\/<same name>/);
  assert.equal(await f.emit('tool_call', { toolName: 'write', input: { path: '.mina/checks-proposed/r1.py' } }, { cwd, hasUI: false }), undefined);
  mkdirSync(join(cwd, '.mina', 'checks-proposed'));
  writeFileSync(join(cwd, '.mina', 'checks-proposed', 'r1.py'), 'new, long script\n');
  const fix = { restated_objective: 't', checks, reason: 'compare against its own 60/40', drafts: ['.mina/checks-proposed/r1.py'] };
  await f.tools.mina_propose_checks.execute('id', fix, null, null, { ...ui(['Keep the current checks']), cwd });
  assert.equal(readFileSync(join(cwd, '.mina', 'checks', 'r1.py'), 'utf8'), 'old\n');
  await f.tools.mina_propose_checks.execute('id', fix, null, null, { ...ui(['Accept the new checks']), cwd });
  assert.equal(readFileSync(join(cwd, '.mina', 'checks', 'r1.py'), 'utf8'), 'new, long script\n');
  assert.ok(!existsSync(join(cwd, '.mina', 'checks-proposed', 'r1.py')));
  assert.equal(await f.emit('tool_call', { toolName: 'goal_complete', input: {} }, { cwd, hasUI: false }), undefined);
  await assert.rejects(f.tools.mina_propose_checks.execute('id', { ...fix, drafts: ['src/evil.py'] }, null, null, { ...ui(['Accept the new checks']), cwd }), /under \.mina\/checks-proposed/);
  await assert.rejects(f.tools.mina_propose_checks.execute('id', { ...fix, drafts: ['.mina/checks-proposed/gone.py'] }, null, null, { ...ui(['Accept the new checks']), cwd }), /draft not found/);
});

test('mina_checks: one line per check with the reason, saved for the packet', async () => {
  const { statusLine, formatStatus } = await import('../extensions/goal/checks.mjs');
  assert.equal(statusLine({ id: 'R1', code: 0, stdout: 'OK: all\ncheck: ALL PASS\n' }), 'R1: PASS');
  assert.equal(statusLine({ id: 'R1', code: 1, stdout: 'OK: a\nFAIL: results/series/all_series.csv missing\n' }), 'R1: FAIL - FAIL: results/series/all_series.csv missing');
  assert.match(statusLine({ id: 'R2', code: 1, stderr: 'Traceback (most recent call last):\n  x\nKeyError: sharpe_excess' }), /R2: FAIL - KeyError: sharpe_excess/);
  assert.equal(statusLine({ id: 'R3', code: null, killed: true }), 'R3: did not finish');
  assert.match(formatStatus({ at: 't', lines: ['R1: PASS'] }), /Check status \(t\):\n- R1: PASS/);
  const f = fakePi({ execCodes: [1, 0] });
  await f.commands.goal.handler('build it --protect-checks', { cwd: '/p', hasUI: false });
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'a', proves: 'x' }, { command: 'b', proves: 'y' }] }, null, null, { hasUI: false });
  const r = await f.tools.mina_checks.execute('id', {}, null, null, { cwd: '/p' });
  assert.match(r.content[0].text, /- R1: FAIL - out\n- R2: PASS/);
  assert.deepEqual(f.entries.at(-1).data.lastStatus.lines, ['R1: FAIL - out', 'R2: PASS']);
  assert.match(goalInstructions({ research: false, mode: 'given', checks: [{ id: 'R1', command: 'x' }] }), /mina_checks[^]*\.mina\/plan\.md/);
});

test('/goal reopen: a completed goal becomes active again with its checks, and the agent is told why', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  const f = fakePi();
  await f.commands.goal.handler('build it --protect-checks', { cwd, hasUI: false });
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'true', proves: 'x' }] }, null, null, { hasUI: false, cwd });
  mkdirSync(join(cwd, '.mina'), { recursive: true });
  await f.emit('tool_result', { toolName: 'goal_complete', isError: false, content: [{ type: 'text', text: 'Goal complete: done' }] });
  const done = structuredClone(f.entries.at(-1).data);
  const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => [{ type: 'custom', customType: 'mina-goal', data: done }] } };
  await f.emit('session_start', {}, ctx);
  await f.commands.goal.handler('mina-continue', ctx);
  assert.equal(f.upstream.length, 1);                                                  // continue does not revive a completed goal
  await f.commands.goal.handler('reopen "a required case was missed"', ctx);
  const st = f.entries.at(-1).data;
  assert.equal(st.status, 'active'); assert.equal(st.checks.length, 1); assert.equal(st.reopened.reason, 'a required case was missed');
  assert.deepEqual(f.upstream, ['build it', 'build it']);
  assert.match(f.messages.at(-1).content, /reopened this goal: a required case was missed[^]*mina goal rules/);
  const r = await f.emit('tool_call', { toolName: 'goal_complete', input: {} }, { cwd, hasUI: false });
  assert.equal(st.completionPolicy, 'checks-only');
  assert.equal(r, undefined);
  const live = { cwd, hasUI: false, sessionManager: { getBranch: () => f.entries.map((e) => ({ type: 'custom', customType: e.type, data: e.data })) } };
  await f.commands.goal.handler('reopen', live);                                         // already active: nothing to reopen
  assert.equal(f.upstream.length, 2);
});

test('checks-only completion does not impose an mtime provenance gate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  const f = fakePi();
  await f.commands.goal.handler('build it --protect-checks', { cwd, hasUI: false });
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'true', proves: 'x' }] }, null, null, { hasUI: false, cwd });
  mkdirSync(join(cwd, '.mina'), { recursive: true }); mkdirSync(join(cwd, 'results'));
  writeFileSync(join(cwd, 'results', 'summary.csv'), 'r\n');
  const old = (Date.parse(f.entries.at(-1).data.started_at) - 3600e3) / 1000;
  utimesSync(join(cwd, 'results', 'summary.csv'), old, old);                 // written by an earlier attempt
  writeFileSync(join(cwd, 'run.py'), 'if cached("results/summary.csv"): pass\n');   // code changed during the goal
  const r = await f.emit('tool_call', { toolName: 'goal_complete', input: {} }, { cwd, hasUI: false });
  assert.equal(r, undefined);
  assert.equal(existsSync(join(cwd, '.mina', 'provenance.md')), false);
});

test('checks-only completion neither gates outliers nor rewrites numerical notes', async () => {
  const doc = ['# Results', 'Throughput 410 req/s, 395 req/s, 402 req/s and 388 req/s on the four runs.',
    'One outlier: 4.1 req/s (the debug build).', 'See doi:10.1000/example and 2016 data.'].join('\n');
  const cwd = mkdtempSync(join(tmpdir(), 'mina-goal-'));
  const f = fakePi();
  await f.commands.goal.handler('build it --protect-checks', { cwd, hasUI: false });
  writeFileSync(join(cwd, 'RESULTS.md'), doc);                                       // a deliverable changed during the goal
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'true', proves: 'x' }] }, null, null, { hasUI: false, cwd });
  mkdirSync(join(cwd, '.mina'), { recursive: true });
  writeFileSync(join(cwd, '.mina', 'numbers.md'), '| number | units | implies | range | ok |\n|---|---|---|---|---|\n| 400 | req/s | median throughput | 380-420 | yes |\n');
  const r = await f.emit('tool_call', { toolName: 'goal_complete', input: {} }, { cwd, hasUI: false });
  assert.equal(r, undefined);
  const md = readFileSync(join(cwd, '.mina', 'numbers.md'), 'utf8');
  assert.doesNotMatch(md, /Outliers mina found|4\.1/);
});

test('/goal resume in a successor continues a goal the handoff carried as blocked; a plain /goal resume still goes to pi-goal', async () => {
  const cwd = project();
  const f = fakePi();
  await f.commands.goal.handler('build it --protect-checks', { cwd, hasUI: false });
  await f.tools.mina_propose_checks.execute('id', { restated_objective: 'b', checks: [{ command: 'true', proves: 'x' }] }, null, null, { hasUI: false, cwd });
  const carried = { ...structuredClone(f.entries.at(-1).data), status: 'blocked', resume_on_request: true };
  const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => [{ type: 'custom', customType: 'mina-goal', data: carried }] } };
  await f.commands.goal.handler('mina-continue', ctx);                                 // the handoff's own continue is refused
  assert.equal(f.upstream.length, 1);
  await f.commands.goal.handler('resume', ctx);
  const st = f.entries.at(-1).data;
  assert.equal(st.status, 'active'); assert.equal(st.resumed.from, 'blocked'); assert.equal(st.resume_on_request, undefined);
  assert.equal(st.checks.length, 1);
  assert.equal(st.completionPolicy, 'checks-only');
  assert.deepEqual(f.upstream, ['build it', 'build it']);
  const plain = { cwd, hasUI: false, sessionManager: { getBranch: () => [{ type: 'custom', customType: 'mina-goal', data: st }] } };
  await f.commands.goal.handler('resume', plain);
  assert.deepEqual(f.upstream, ['build it', 'build it', 'resume']);
});

test('stripGoalPrompts: removes pi-goal prompts Pi returned to the input box, keeps the user\'s text', async () => {
  const { stripGoalPrompts } = await import('../extensions/goal/checks.mjs');
  const rules = 'Goal-mode rules:\n- Preserve the full objective across turns.\n\n- If the goal is incomplete at the end of a turn and goal_wait was not accepted, expect automatic\ncontinuation and keep working from the current state.';
  const contract = `Goal mode is active. Complete this goal fully:\n\n<goal_objective>\nExecute docs/plan.md\n</goal_objective>\n\n${rules}\n\n<!-- pi-goal-prompt:00000000-0000-4000-8000-000000000001 -->`;
  const cont = `Continue the active /goal until it is complete:\n\n<goal_objective>\nx\n</goal_objective>\n\nThis is automatic continuation #4.\n\n${rules}\n\n<!-- pi-goal-continuation:abc -->`;
  assert.deepEqual(stripGoalPrompts(contract), { text: '', removed: 1, unrecognized: false });
  // queued messages are joined with a blank line, before what the user had typed
  const r = stripGoalPrompts(`please also check the KV numbers\n\n${contract}\n\n${cont}\n\nmy unsent draft`);
  assert.equal(r.removed, 2);
  assert.equal(r.text, 'please also check the KV numbers\n\nmy unsent draft');
  assert.deepEqual(stripGoalPrompts('just my text, mentions Goal mode is active. Complete this goal fully: but no marker'),
    { text: 'just my text, mentions Goal mode is active. Complete this goal fully: but no marker', removed: 0, unrecognized: false });
  const odd = 'Some future pi-goal wording\n\n<!-- pi-goal-prompt:zzz -->';
  assert.deepEqual(stripGoalPrompts(odd), { text: odd, removed: 0, unrecognized: true });
});

test('stripGoalPrompts knows every prompt opening of the installed pi-goal (drift guard)', () => {
  const src = readFileSync(join(REPO_ROOT, 'node_modules/@narumitw/pi-goal/src/prompts.ts'), 'utf8');
  const mine = readFileSync(join(REPO_ROOT, 'extensions/goal/checks.mjs'), 'utf8').match(/GOAL_PROMPT_OPENINGS = \[([^\]]+)\]/)[1]
    .match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  for (const o of mine) assert.ok(src.includes(o), `pi-goal no longer says: ${o}`);
  // and every user-message prompt pi-goal builds starts with one of them
  const heads = [...src.matchAll(/export function build(?!GoalSystemPrompt|GoalContextPrompt)\w+Prompt[\s\S]*?\n  return `([^`$\\]{12,60})/g)].map((m) => m[1]);
  assert.ok(heads.length >= 5, heads.join(' | '));
  for (const h of heads) assert.ok(mine.some((o) => h.startsWith(o) || o.startsWith(h)), `unknown pi-goal prompt opening: ${h}`);
});

test('agent_settled: a goal prompt in the input box is removed and the user is told; the user\'s own text stays', async () => {
  const f = fakePi();
  let box = 'draft\n\nGoal mode is active. Complete this goal fully:\n\nbody\n\n<!-- pi-goal-prompt:1 -->';
  const notes = [];
  const ctx = { cwd: tmpdir(), hasUI: true, ui: { getEditorText: () => box, setEditorText: (t) => { box = t; }, notify: (m) => notes.push(m) } };
  await f.emit('agent_settled', {}, ctx);
  assert.equal(box, 'draft');
  assert.match(notes.at(-1), /removed 1 goal prompt/);
  await f.emit('agent_settled', {}, ctx);                                                      // nothing more to do
  assert.equal(box, 'draft'); assert.equal(notes.length, 1);
  await f.emit('agent_settled', {}, { cwd: tmpdir(), hasUI: false });                         // no UI: nothing happens
});

test('a new /goal leaves the host broker\'s capability report in .mina/ (it is not the old goal\'s working file)', async () => {
  const { archivePreviousGoal } = await import('../extensions/goal/mina-goal.mjs');
  const cwd = project();
  writeFileSync(join(cwd, '.mina', 'host-capabilities.json'), '{}');
  writeFileSync(join(cwd, '.mina', 'plan.md'), 'old plan');
  const rel = archivePreviousGoal(cwd);
  assert.ok(existsSync(join(cwd, '.mina', 'host-capabilities.json')));
  assert.ok(existsSync(join(cwd, rel, 'plan.md')) && !existsSync(join(cwd, '.mina', 'plan.md')));
});

// --- minimal goal prompts (tuning goal_prompt: "minimal") ------------------------------------------------------------
const realGoalRules = () => {
  const src = readFileSync(join(REPO_ROOT, 'node_modules/@narumitw/pi-goal/src/prompts.ts'), 'utf8');
  const body = src.match(/function goalModeRules[\s\S]*?return \[([\s\S]*?)\]\.join\("\\n"\)/)[1];
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
    .map((m) => (m[1] ?? m[2]).replace(/\\"/g, '"').replace(/\$\{goalLabel\}/g, 'this goal')).join('\n');
};

test('minimal goal prompts: pi-goal\'s real rule block becomes one line; objective, goal_id and markers stay', async () => {
  const { minimizeGoalRules, MINIMAL_GOAL_RULES } = await import('../extensions/goal/checks.mjs');
  const rules = realGoalRules();
  assert.match(rules, /^Goal-mode rules:\n- /);
  assert.ok(rules.length > 2500, `pi-goal's block is ${rules.length} chars`);
  const prompt = `Continue the active /goal until it is complete:\n\n<goal_objective>\nmeasure it\n</goal_objective>\n\n<goal_id>\ng-1\n</goal_id>\n\n${rules}\n\n<!-- pi-goal-continuation:abc -->`;
  const out = minimizeGoalRules(prompt);
  assert.ok(!out.includes('Goal-mode rules:') && out.includes(MINIMAL_GOAL_RULES));
  for (const keep of ['<goal_objective>\nmeasure it', '<goal_id>\ng-1', '<!-- pi-goal-continuation:abc -->']) assert.ok(out.includes(keep), keep);
  assert.ok(out.length < prompt.length - 2000);
  assert.equal(minimizeGoalRules('no rules here'), 'no rules here');
});

test('minimal goal prompts: the context handler rewrites only what the model sees, and only when tuned', async () => {
  const rules = realGoalRules();
  const msgs = [{ role: 'user', content: `Goal mode is active.\n\n${rules}\n\n<!-- pi-goal-prompt:1 -->` },
    { role: 'custom', customType: 'goal-contract', content: [{ type: 'text', text: `Active /goal context:\nx\n\n${rules}` }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'Goal-mode rules: quoted in a file' }] },
    { role: 'user', content: 'plain message' }];
  const on = fakePi({ tuning: { goal_prompt: 'minimal' } });
  const out = await on.emit('context', { messages: structuredClone(msgs) });
  assert.ok(!JSON.stringify(out.messages.slice(0, 2)).includes('Goal-mode rules:'));
  assert.deepEqual(out.messages.slice(2), msgs.slice(2));
  const off = fakePi();
  assert.equal(await off.emit('context', { messages: structuredClone(msgs) }), undefined);
});

test('minimal goal instructions: operational facts only, much shorter than the full ones', async () => {
  const { goalInstructions, goalInstructionsMinimal } = await import('../extensions/goal/checks.mjs');
  for (const state of [{ research: true, mode: 'plan', settled: false }, { mode: 'given', settled: true, checks: [{ id: 'R1', command: 'pytest -q' }] }]) {
    const full = goalInstructions(state), min = goalInstructionsMinimal(state);
    assert.ok(min.length < full.length / 2, `${min.length} vs ${full.length}`);
    for (const fact of ['goal_complete', 'mina_checks', 'plan.md', 'mina_subagents']) assert.ok(min.includes(fact), fact);
    for (const text of [full, min]) assert.doesNotMatch(text, /mina_close_doubt|numbers\.md|provenance\.md/);
  }
  assert.match(goalInstructionsMinimal({ mode: 'given', checks: [{ id: 'R1', command: 'pytest -q' }] }), /R1: pytest -q[^]*mina_checks[^]*checks-proposed/);
  assert.match(goalInstructionsMinimal({ mode: 'plan', settled: false }), /mina_propose_checks[^]*refused until the user decides/);
});

test('switching from a local model to Sol applies minimal goal prompts without restarting or replacing the goal', async () => {
  const local = { model: 'local/test-model' };
  const sol = { model: 'openai-codex/gpt-6.1-sol', goal_prompt: 'minimal' };
  const f = fakePi({ tuning: local, readTuning: () => sol });
  const ctx = { cwd: project(), hasUI: false, model: { provider: 'local', id: 'test-model' } };
  await f.commands.goal.handler('build it --check "true"', ctx);
  const original = structuredClone(f.messages);
  const id = f.entries.at(-1).data.id;
  ctx.model = { provider: 'openai-codex', id: 'gpt-6.1-sol' };
  await f.emit('model_select', { model: ctx.model }, ctx);
  const messages = original.map((m) => ({ role: 'custom', ...m }));
  messages.push({ role: 'user', content: realGoalRules() });
  const result = await f.emit('context', { messages }, ctx);
  assert.match(result?.messages[0].content ?? '', /mina goal machinery:/);
  assert.doesNotMatch(JSON.stringify(result?.messages), /mina goal rules for this goal:|Goal-mode rules:/);
  assert.equal(f.entries.at(-1).data.id, id);
  assert.match(original[0].content, /mina goal rules for this goal:/); // raw history is not rewritten
  await f.commands.goal.handler('new work --check "true"', ctx);
  assert.match(f.messages.at(-1).content, /mina goal machinery:/);
  ctx.model = { provider: 'local', id: 'test-model' };
  await f.emit('model_select', { model: ctx.model }, ctx);
  await f.commands.goal.handler('more work --check "true"', ctx);
  assert.match(f.messages.at(-1).content, /mina goal rules for this goal:/);
});

test('minimal goal prompts: a /goal with goal_prompt minimal sends the minimal instructions', async () => {
  const f = fakePi({ tuning: { goal_prompt: 'minimal' } });
  await f.commands.goal.handler('build it --check "true"', { cwd: project(), hasUI: false });
  const sent = f.messages.map((m) => m.content).join('\n');
  assert.match(sent, /mina goal machinery:/);
  assert.ok(!sent.includes('mina goal rules for this goal:'));
});

// --- asking the user (extensions/goal/ask.mjs) ---------------------------------------------------------------------
const askParams = { question: 'Fixed clocks or measure at the power caps?', context: 'details: .mina/briefs/clock-control-request.md',
  options: [{ label: 'Pin clocks (root commands)', consequence: 'results only for the reduced-clock identity' },
    { label: 'Measure at the production caps', consequence: 'new preregistration, interleaved arms' }], recommended: 1, why: 'it is the serving condition' };
const uiCtx = (answers) => {
  const ui = { widgets: [], notes: [], asked: [],
    setWidget: (k, v) => ui.widgets.push([k, v]), notify: (m) => ui.notes.push(m),
    select: async (title, opts) => { ui.asked.push([title, opts]); return answers.shift()?.(opts); }, input: async () => answers.shift()?.() };
  return { cwd: project(), hasUI: true, ui };
};

test('a native request is answered once across a handoff, but a different scope or new instance cannot reuse it', async () => {
  const cwd = project(), env = { MINA_INSTANCE_ID: `decision-${cwd}` };
  let asks = 0;
  const ctx = { cwd, hasUI: true, ui: { notify: () => {}, setWidget: () => {},
    select: async (_title, choices) => { asks++; return choices[0]; } } };
  const p = { request_id: 'retry-c2', question: 'Allow the bounded retry?', options: [{ label: 'Allow' }, { label: 'Stop' }], recommended: 0, why: 'One bounded attempt.' };
  const first = fakePi({ env });
  await first.tools.mina_ask_user.execute('first', p, null, null, ctx);
  await first.emit('session_shutdown', {}, ctx);
  const next = fakePi({ env });
  const receipt = await next.tools.mina_ask_user.execute('next', p, null, null, ctx);
  assert.equal(asks, 1);
  assert.equal(receipt.details.reused, true);
  assert.match(receipt.content[0].text, /No new authorization/);
  await assert.rejects(next.tools.mina_ask_user.execute('changed', { ...p, context: 'Also change the clock tolerance' }, null, null, ctx), /different decision/);
  assert.equal(asks, 1);
  const fresh = fakePi({ env: { MINA_INSTANCE_ID: `fresh-${cwd}` } });
  await fresh.tools.mina_ask_user.execute('fresh', p, null, null, ctx);
  assert.equal(asks, 2);
});

test('an operator agreement shows exact commands, waits for output, and never executes or verifies them', async () => {
  const f = fakePi({ env: { MINA_INSTANCE_ID: `operator-${project()}` }, onExec: () => assert.fail('operator commands must never execute') });
  const cwd = project(), statuses = new Map(), shown = [];
  const ctx = { cwd, hasUI: true, ui: { notify: () => {}, setStatus: (key, value) => statuses.set(key, value),
    setWidget: () => {}, select: async (_title, choices) => choices[0] } };
  const p = { request_id: 'clock-setup', question: 'Will you apply the settings?', options: [{ label: 'I will run them' }, { label: 'Stop' }], recommended: 0, why: 'Only the operator can do this.',
    operator_action: { option_index: 0, target: 'fixture-host / device-123', effect: 'Change only the fixture device mode', reason: 'Requires operator privilege',
      preconditions: ['The device is idle.'], commands: 'sudo do-not-run --device device-123',
      expected_output: 'Paste the command output and device readback.', stop_on_error: 'Stop and paste the error.',
      restoration: { when: 'After the workload ends and the device is idle.', commands: 'sudo do-not-run --restore device-123' } } };
  const out = await f.tools.mina_ask_user.execute('setup', p, null, null, ctx);
  const procedure = f.messages.find((m) => m.customType === 'mina-operator-action');
  assert.ok(procedure?.content.includes(p.operator_action.commands));
  assert.ok(procedure.content.includes(p.operator_action.restoration.commands));
  assert.match(procedure.content, /not now|Not now/);
  assert.equal(out.details.operator_status, 'awaiting_execution');
  assert.match([...statuses.values()].filter(Boolean).join(' '), /operator.*output/i);
  assert.match(out.content[0].text, /not executed/);
  await f.commands.goal.handler('actions', { ...ctx, ui: { ...ctx.ui,
    select: async (_title, choices) => choices[0], editor: async (_title, text) => { shown.push(text); return undefined; } } });
  assert.ok(shown.some((text) => text.includes(p.operator_action.commands)));
  const listed = await f.tools.mina_operator_status.execute('list', {}, null, null, ctx);
  assert.match(listed.content[0].text, /clock-setup: awaiting_execution/);
  const inspected = await f.tools.mina_operator_status.execute('inspect', { request_id: p.request_id }, null, null, ctx);
  assert.ok(inspected.content[0].text.includes(p.operator_action.commands));
  const report = await f.tools.mina_operator_status.execute('reported', { request_id: p.request_id, status: 'output_received', evidence: 'Operator pasted readback in the conversation.' }, null, null, ctx);
  assert.match(report.content[0].text, /not verified|not independently verified/);
  assert.equal(report.details.operatorReport.verified, false);
  assert.equal([...statuses.values()].filter(Boolean).join(''), '');
});

test('mina_ask_user shows the question, options and recommendation, waits for the choice, and returns it', async () => {
  const f = fakePi();
  const ctx = uiCtx([(opts) => opts[1]]);
  const r = await f.tools.mina_ask_user.execute('id', askParams, null, null, ctx);
  assert.equal(r.content[0].text, 'The user answered: 2. Measure at the production caps (recommended)');
  assert.deepEqual(ctx.ui.asked[0][1].at(-1), 'Other: type your own answer');
  assert.equal(ctx.ui.widgets[0][1].length, 1, 'a one-line banner: the dialog carries the question');
  assert.match(ctx.ui.widgets[0][1][0], /asks you: Fixed clocks/);
  assert.match(ctx.ui.asked[0][0], /Fixed clocks[^]*Recommended: 2\. Measure at the production caps[^]*it is the serving condition/);
  assert.deepEqual(ctx.ui.widgets.at(-1), ['mina-question', undefined]);                   // cleared after the answer
  assert.equal(f.entries.filter((e) => e.type === 'mina-question').at(-1).data.answer, r.details.answer);
  const other = uiCtx([(opts) => opts.at(-1), () => 'pin only GPU A']);
  assert.equal((await f.tools.mina_ask_user.execute('id-other', askParams, null, null, other)).content[0].text, 'The user answered: pin only GPU A');
  const none = await f.tools.mina_ask_user.execute('id-none', askParams, null, null, { cwd: project(), hasUI: false });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /No one can answer here[^]*goal_blocked/);
});


test('a long question keeps a short dialog; full details open in a scrollable view and return to the choice', async () => {
  // An operator request (~1,700 characters of procedure) overflowed the screen. The dialog title and
  // the widget held everything, and neither scrolls.
  const f = fakePi({ env: { MINA_INSTANCE_ID: `long-${project()}` } });
  const longContext = 'Evidence: ' + 'kernel page fault line; '.repeat(40);
  const p = { request_id: 'lockout-clear', question: 'Will you clear the GPU A safety lockout?', context: longContext,
    options: [{ label: 'I will clear it', consequence: 'the authorized probe runs next' }, { label: 'Keep it', consequence: 'the run closes BLOCKED' }],
    recommended: 0, why: 'the root cause is identified',
    operator_action: { option_index: 0, target: 'gpu-host / GPU A lockout file', effect: 'Moves the lockout record aside', reason: 'Only the operator may clear a safety lockout',
      preconditions: ['No GPU job is running.'], commands: 'mv /lockout/GPU_A /lockout-cleared/GPU_A.reason',
      expected_output: 'Paste the empty lockout listing.', stop_on_error: 'Stop and paste the error.', restoration: null } };
  const titles = [], viewed = [], widgets = [];
  let calls = 0;
  const ctx = { cwd: project(), hasUI: true, ui: { notify: () => {}, setStatus: () => {}, setWidget: (k, v) => widgets.push([k, v]),
    editor: async (title, text) => { viewed.push([title, text]); return text; },
    select: async (title, opts) => { titles.push([title, opts]); calls++; return calls === 1 ? opts.find((o) => /full details/i.test(o)) : opts[0]; } } };
  const out = await f.tools.mina_ask_user.execute('long', p, null, null, ctx);
  assert.equal(titles.length, 2, 'the choice is shown again after the details view');
  for (const [title] of titles) {
    assert.ok(title.length < 600, `dialog title stays short (${title.length})`);
    assert.ok(!title.includes(p.operator_action.commands), 'operator commands live in the details view');
  }
  assert.ok(titles[0][1].some((o) => /full details/i.test(o)) && titles[0][1].at(-1) === 'Other: type your own answer');
  assert.equal(viewed.length, 1);
  for (const part of [longContext.trim(), 'the authorized probe runs next', 'the run closes BLOCKED', 'the root cause is identified', p.operator_action.commands, 'Paste the empty lockout listing.'])
    assert.ok(viewed[0][1].includes(part), `details include: ${part.slice(0, 40)}`);
  assert.equal(widgets[0][1].length, 1);
  assert.match(out.content[0].text, /The user answered: 1\. I will clear it/);
  // Without a scrollable view the dialog keeps the full procedure, as before.
  const plain = fakePi({ env: { MINA_INSTANCE_ID: `plain-${project()}` } });
  let plainTitle = '';
  await plain.tools.mina_ask_user.execute('plain', p, null, null, { cwd: project(), hasUI: true, ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {},
    select: async (title, opts) => { plainTitle = title; assert.ok(!opts.some((o) => /full details/i.test(o))); return opts[0]; } } });
  assert.ok(plainTitle.includes(p.operator_action.commands));
});

test('a goal parked after exhausted provider retries is resumed with backoff; a usage limit or an agent\'s own wait is not', async () => {
  const f = fakePi({ tuning: { provider_retry: { delays_s: [0.05, 0.05] } } });
  let goal = { status: 'active', waiting: { reason: 'Provider retries exhausted: Codex error: An error occurred while processing your request.' } };
  const notes = [];
  const ctx = { cwd: project(), hasUI: true, ui: { notify: (m) => notes.push(m) },
    sessionManager: { getBranch: () => [{ type: 'custom', customType: 'goal-state', data: { goal } }] } };
  const settle = async () => { await f.emit('agent_settled', {}, ctx); await new Promise((r) => setTimeout(r, 1200)); };
  const resumes = () => f.sent.filter((x) => x.text === '/goal resume').length;
  await settle();
  assert.equal(resumes(), 1);
  assert.match(notes.at(-1), /resumes by itself in 0 min \(attempt 1 of 2\)/);
  await settle();
  assert.equal(resumes(), 2);
  await settle();                                                                              // retries used up
  assert.equal(resumes(), 2);
  assert.match(notes.at(-1), /still parked after 2 automatic resumes/);
  await f.emit('turn_end', { message: { role: 'assistant', stopReason: 'stop', content: [] } }, ctx);   // a good turn resets
  await settle();
  assert.equal(resumes(), 3);
  goal = { status: 'usage_limited' };
  await settle();
  goal = { status: 'active', waiting: { reason: 'Waiting for the benchmark to finish' } };
  await settle();
  assert.equal(resumes(), 3);
});

test('a --check goal freezes .mina/checks/ at the start, and check bytecode is not a change (2026-10-14: completion refused)', async () => {
  const cwd = project();
  mkdirSync(join(cwd, '.mina', 'checks'), { recursive: true });
  writeFileSync(join(cwd, '.mina', 'checks', 'evidence.py'), 'print("ok")\n');
  const f = fakePi();
  await f.commands.goal.handler('close it out --check "python3 .mina/checks/evidence.py"', { cwd, hasUI: false });
  assert.deepEqual(Object.keys(f.entries.at(-1).data.frozen), ['.mina/checks/evidence.py']);
  mkdirSync(join(cwd, '.mina', 'checks', '__pycache__'));
  writeFileSync(join(cwd, '.mina', 'checks', '__pycache__', 'evidence.cpython-314.pyc'), 'bytecode');
  const r = await f.emit('tool_call', { toolName: 'goal_complete', input: {} }, { cwd, hasUI: false });
  assert.ok(!/check files changed/.test(r?.reason ?? ''), r?.reason);
  writeFileSync(join(cwd, '.mina', 'checks', 'evidence.py'), 'print("weakened")\n');          // a real change still refuses
  const r2 = await f.emit('tool_call', { toolName: 'goal_complete', input: {} }, { cwd, hasUI: false });
  assert.match(r2.reason, /check files changed after the user accepted them: \.mina\/checks\/evidence\.py/);
  await assert.rejects(f.tools.mina_checks.execute('status', {}, null, null, { cwd, hasUI: false }), /Protected check files changed/);
});

test('no-effect guard helpers: a workload seen to end, liveness bounded by the broker deadline, tool effects, run classes', () => {
  let w = observeWorkload(null, { id: 'a', state: 'running', deadline: 2000 });
  assert.equal(w.finished, false);
  assert.equal(liveWorkload(w.workloads, 1000), true);
  assert.equal(liveWorkload(w.workloads, 2001), false);                                     // past its deadline: not live
  w = observeWorkload(w.workloads, { id: 'a', state: 'exited' });
  assert.equal(w.finished, true);
  assert.equal(observeWorkload(w.workloads, { id: 'a', state: 'exited' }).finished, false); // seen ended again: nothing new
  assert.equal(observeWorkload(w.workloads, { kind: 'workload_output' }).workloads, w.workloads);
  let many = null;
  for (let i = 0; i < 60; i++) many = observeWorkload(many, { id: `j${i}`, state: i === 0 ? 'running' : 'exited' }).workloads;
  assert.equal(Object.keys(many).length, 50);
  assert.ok('j59' in many && !('j0' in many));

  assert.equal(toolEffect({ toolName: 'write', input: { path: 'a.txt' }, isError: false }), 'write a.txt');
  assert.equal(toolEffect({ toolName: 'edit', input: { path: 'a.txt' }, isError: true }), null);
  assert.equal(toolEffect({ toolName: 'read', input: { path: 'a.txt' }, isError: false }), null);
  assert.equal(toolEffect({ toolName: 'mina_host', input: { action: 'workload_run' }, details: { ok: true, result: { id: 'w1' } }, isError: false }), 'workload_run w1');
  assert.equal(toolEffect({ toolName: 'mina_host', input: { action: 'workload_run' }, details: { ok: false }, isError: false }), null);
  assert.equal(toolEffect({ toolName: 'mina_host', input: { action: 'workload_status' }, details: { ok: true, result: { id: 'w1' } }, isError: false }), null);

  const g = (o = {}) => ({ id: 'g1', automaticModelTurns: 5, ...o });
  const quiet = { automatic: true, effects: [], live: false };
  let s = nextStall(null, g(), quiet);
  assert.deepEqual([s.kind, s.stall.count], ['stalled', 1]);
  s = nextStall(s.stall, g({ automaticModelTurns: 6 }), { ...quiet, effects: ['write x'] });
  assert.deepEqual([s.kind, s.stall.count], ['effect', 0]);
  s = nextStall(nextStall(s.stall, g({ automaticModelTurns: 7 }), quiet).stall, g({ automaticModelTurns: 8 }), quiet);
  assert.equal(s.stall.count, 2);
  assert.deepEqual([nextStall(s.stall, g({ automaticModelTurns: 9, waiting: { reason: 'job' } }), { ...quiet, live: true }).kind], ['neutral']);
  assert.equal(nextStall(s.stall, g({ automaticModelTurns: 9, waiting: { reason: 'job' } }), quiet).stall.count, 3);  // a wait on nothing live counts
  assert.deepEqual(Object.values(nextStall(s.stall, g({ automaticModelTurns: 8 }), { ...quiet, automatic: false })).map((x) => x.count ?? x), [2, 'uncounted']);
  assert.equal(nextStall(s.stall, g({ id: 'g2', automaticModelTurns: 9 }), quiet).stall.count, 1);          // resumed goal: new count
  assert.equal(nextStall(s.stall, g({ automaticModelTurns: 1 }), quiet).stall.count, 1);                    // the user reset pi-goal's epoch
});

test('git snapshot: HEAD and the set of changed paths count, appends to an already-changed tracked file do not', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-stall-git-'));
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
  git('init', '-q'); writeFileSync(join(cwd, 'log.jsonl'), '1\n'); git('add', '.'); git('commit', '-qm', 'a');
  const exec = async (cmd, args, opts) => { const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout }; };
  const s0 = await gitSnapshot(exec, cwd);
  writeFileSync(join(cwd, 'log.jsonl'), '1\n2\n');                                           // a broker job appends: new changed path
  const s1 = await gitSnapshot(exec, cwd);
  assert.notEqual(s1, s0);
  writeFileSync(join(cwd, 'log.jsonl'), '1\n2\n3\n');                                        // further appends: same set, no effect
  assert.equal(await gitSnapshot(exec, cwd), s1);
  git('commit', '-qam', 'b');                                                                // a commit is an effect
  assert.notEqual(await gitSnapshot(exec, cwd), s1);
  assert.equal(await gitSnapshot(exec, mkdtempSync(join(tmpdir(), 'mina-stall-nogit-'))), null);
});

test('the no-effect guard pauses a goal after automatic runs that change nothing; effects, live waits and the user do not count', async () => {
  let snap = 'A';
  const measured = [];
  const f = fakePi({ snapshot: async () => snap, measure: (m) => measured.push(m) });
  const cwd = project();
  await f.commands.goal.handler('keep the teacher downloads going --no-research', { cwd, hasUI: false });
  f.upstream.length = 0;
  let goal = { id: 'g1', status: 'active', automaticModelTurns: 0 };
  const notes = [];
  const ctx = { cwd, hasUI: true, ui: { notify: (m) => notes.push(m) },
    sessionManager: { getBranch: () => [{ type: 'custom', customType: 'goal-state', data: { goal } }] } };
  const later = Date.now() / 1000 + 3600;
  const status = (id, state) => ({ toolName: 'mina_host', input: { action: 'workload_status', id }, isError: false, details: { ok: true, result: { id, state, deadline: later } } });
  const runOnce = async ({ automatic = true, tools = [], waiting, snapAfter } = {}) => {
    await f.emit('agent_start', {}, ctx);
    for (const t of tools) await f.emit('tool_result', t, ctx);
    if (snapAfter) snap = snapAfter;
    goal = { ...goal, automaticModelTurns: goal.automaticModelTurns + (automatic ? 1 : 0), waiting };
    await f.emit('agent_end', { messages: [] }, ctx);
    await f.emit('agent_settled', {}, ctx);
  };
  const count = () => f.entries.filter((e) => e.type === 'mina-goal').at(-1).data.stall?.count ?? 0;
  await runOnce();
  assert.equal(count(), 1);
  await runOnce({ tools: [{ toolName: 'write', input: { path: 'notes.md' }, isError: false }] });
  assert.equal(count(), 0);
  await runOnce(); await runOnce();
  assert.equal(count(), 2);
  await runOnce({ automatic: false });                                                       // an alarm or user run is not counted
  await runOnce({ tools: [status('w1', 'running')], waiting: { reason: 'teacher pass w1' } });  // waits on a live job: neutral
  assert.equal(count(), 2);
  assert.deepEqual(f.upstream, []);
  await runOnce({ tools: [status('w1', 'exited')] });                                        // the job was seen to finish
  assert.equal(count(), 0);
  await runOnce({ snapAfter: 'B' });                                                         // a commit or a newly changed file
  assert.equal(count(), 0);
  await runOnce({ waiting: { reason: 'w1 again' } });                                        // w1 has ended: this wait is on nothing live
  await runOnce();
  assert.deepEqual(f.upstream, []);
  await runOnce();
  assert.deepEqual(f.upstream, ['pause']);
  assert.match(notes.at(-1), /goal paused: 3 automatic runs in a row changed nothing/);
  assert.match(f.messages.at(-1).content, /^mina paused this goal: 3 automatic runs[^]*goal_wait[^]*goal_blocked/);
  assert.deepEqual(measured.filter((m) => m.kind === 'goal_stall_pause'), [{ kind: 'goal_stall_pause', runs: 3, limit: 3 }]);
  assert.equal(count(), 0);
  assert.ok(f.entries.at(-1).data.stall.paused_at);
});

test('the no-effect guard: tuning goal_stall_runs sets the limit, null turns it off, and an inactive goal is not tracked', async () => {
  const runs = async (f, ctx, n) => { for (let i = 0; i < n; i++) {
    await f.emit('agent_start', {}, ctx); ctx.goal.automaticModelTurns++; await f.emit('agent_end', { messages: [] }, ctx); } };
  const make = async (tuning) => {
    const f = fakePi({ tuning, measure: () => {} });
    const cwd = project();
    await f.commands.goal.handler('long work --no-research', { cwd, hasUI: false });
    f.upstream.length = 0;
    const ctx = { cwd, hasUI: false, goal: { id: 'g', status: 'active', automaticModelTurns: 0 } };
    ctx.sessionManager = { getBranch: () => [{ type: 'custom', customType: 'goal-state', data: { goal: ctx.goal } }] };
    return { f, ctx };
  };
  const off = await make({ goal_stall_runs: null });
  await runs(off.f, off.ctx, 10);
  assert.deepEqual(off.f.upstream, []);
  const five = await make({ goal_stall_runs: 5 });
  await runs(five.f, five.ctx, 4);
  assert.deepEqual(five.f.upstream, []);
  await runs(five.f, five.ctx, 1);
  assert.deepEqual(five.f.upstream, ['pause']);
  const paused = await make({});
  paused.ctx.goal.status = 'paused';
  await runs(paused.f, paused.ctx, 5);
  assert.deepEqual(paused.f.upstream, []);
});
