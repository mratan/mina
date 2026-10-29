import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from '../bin/mina.mjs';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { needsLauncher } from './capabilities.mjs';

// Slow hosts (small single-board computers start mina in about 15 s) set MINA_TEST_TIMEOUT_SCALE, for example 3.
// It scales the instance wall-time limit and the test timeouts together.
const SCALE = Math.max(1, Number(process.env.MINA_TEST_TIMEOUT_SCALE) || 1);

async function launch(body, prompt = 'Run the fixture.', prepare = () => {}, complete = null, after = null, extraArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'mina-cli-control-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mina-cli-project-'));
  const agent = join(root, 'agent'); mkdirSync(agent);
  prepare({ root, cwd, agent });
  const config = join(root, 'sandbox.json');
  writeFileSync(config, JSON.stringify({ network: 'offline', limits: { maxWallS: 15 * SCALE, memoryBytes: 768 * 1024 ** 2, maxProcesses: 128, cpuPercent: 100 } }));
  const plugin = join(root, 'provider.mjs');
  writeFileSync(plugin, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(pathToFileURL(join(REPO, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href)};
export default function(pi) { ${typeof body === 'function' ? body({ root, cwd, agent }) : body} }`);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, MINA_HOST: '0', MINA_SANDBOX_CONFIG: config,
    XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), RAW_PRIVATE_VALUE: 'PRIVATE_ENV_CANARY' };
  let output;
  if (complete) {
    const client = new RpcClient({ cliPath: join(REPO, 'bin/mina.mjs'), cwd, env,
      args: ['--full', '--model', 'mina-fixture/fixture', '-e', plugin, ...extraArgs] });
    const records = [];
    let finish;
    const done = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('RPC fixture did not complete.')), 12_000 * SCALE);
      finish = () => { clearTimeout(timer); resolve(); }; });
    client.onEvent((event) => { records.push(event); if (complete(event, records)) finish(); });
    try {
      await client.start(); await client.prompt(prompt); await done;
      if (after) await after(client);
      output = { error: null, stdout: records.map((r) => JSON.stringify(r)).join('\n'), stderr: client.getStderr() };
    } catch (error) { output = { error, stdout: records.map((r) => JSON.stringify(r)).join('\n'), stderr: client.getStderr() }; }
    finally { finish(); await client.stop(); }
  } else output = await new Promise((resolve) => {
    const child = execFile(process.execPath, [join(REPO, 'bin/mina.mjs'), '--full', '--model', 'mina-fixture/fixture', '-e', plugin, ...extraArgs, '--mode', 'json', '-p', prompt], {
      cwd, timeout: 25_000 * SCALE, maxBuffer: 8 * 1024 ** 2,
      env,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end(); // Pi waits for piped stdin EOF before starting the session.
  });
  return { root, cwd, agent, output, close: () => { rmSync(root, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); } };
}
const success = (f) => assert.equal(f.output.error, null, `${f.output.stderr}\n${f.output.stdout.slice(-5000)}`);
function entries(dir) {
  const out = [];
  for (const file of readdirSync(dir, { recursive: true })) if (file.endsWith('.jsonl')) {
    for (const line of readFileSync(join(dir, file), 'utf8').trim().split('\n')) if (line) out.push(JSON.parse(line));
  }
  return out;
}

test('real launcher blocks executable discovery and credential symlinks while its native tools work', { skip: needsLauncher }, async () => {
  const f = await launch(`
 const f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
 f.setResponses([fauxAssistantMessage(fauxToolCall('bash', {command: 'test -z "\${RAW_PRIVATE_VALUE:-}" && printf isolated > smoke.txt'}), {stopReason:'toolUse'}), fauxAssistantMessage('Fixture completed.')]);
 pi.registerProvider(f.provider);`, undefined, ({ root, cwd }) => {
    mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'extensions', 'evil.js'), `throw new Error('UNTRUSTED_EXTENSION_LOADED');`);
    writeFileSync(join(root, 'private.md'), 'PRIVATE_GUIDANCE_CANARY');
    symlinkSync(join(root, 'private.md'), join(cwd, 'AGENTS.md'));
  });
  try {
    success(f);
    assert.equal(readFileSync(join(f.cwd, 'smoke.txt'), 'utf8'), 'isolated');
    assert.doesNotMatch(f.output.stdout, /PRIVATE_GUIDANCE_CANARY|PRIVATE_ENV_CANARY|UNTRUSTED_EXTENSION_LOADED/);
    assert.match(f.output.stdout, /Fixture completed/);
    assert.doesNotMatch(f.output.stderr, /local limit|explicit local stop/);
  } finally { f.close(); }
});

test('Pi built-in extensions stay off: no MCP servers start in the controller and no codemode or tool_search tools load', { skip: needsLauncher }, async () => {
  const f = await launch(({ root }) => `
 const f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
 pi.on('before_agent_start', () => {
   const tools = pi.getAllTools().map((t) => t.name), commands = pi.getCommands().map((c) => c.name);
   for (const name of ['codemode', 'tool_search']) if (tools.includes(name)) throw Error('BUILTIN_TOOL_LOADED ' + name);
   if (tools.some((n) => n.startsWith('mcp__')) || commands.includes('mcp')) throw Error('BUILTIN_MCP_LOADED');
 });
 f.setResponses([fauxAssistantMessage('Builtins absent.')]);
 pi.registerProvider(f.provider);`, undefined, ({ root, cwd, agent }) => {
    const server = (name) => ({ mcpServers: { [name]: { command: '/bin/sh', args: ['-c', `printf started > ${join(root, `${name}-canary`)}; sleep 2`] } } });
    writeFileSync(join(agent, 'mcp.json'), JSON.stringify(server('user')));
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'mcp.json'), JSON.stringify(server('project')));
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultTools: ['+codemode', '+tool_search'] }));
  });
  try {
    success(f);
    assert.match(f.output.stdout, /Builtins absent/);
    assert.deepEqual(readdirSync(f.root).filter((n) => n.endsWith('-canary')), [], 'an MCP server started in the controller');
  } finally { f.close(); }
});

test('the host manifest does not force the system prompt over a provider prompt (claude-sdk billing)', { skip: needsLauncher }, async () => {
  // pi-claude-subscription sets systemPromptOptions.customPrompt for claude-sdk models. Anthropic bills a request with
  // pi's default prompt as third-party extra usage (400 when the account has none). A layer that returns a whole
  // systemPrompt forces pi's default prompt and discards the Claude preamble.
  const saved = process.env.MINA_HOST_UNAVAILABLE;
  process.env.MINA_HOST_UNAVAILABLE = 'fixture broker down';
  let f;
  try {
    f = await launch(`
 pi.on('before_agent_start', (event) => { event.systemPromptOptions.customPrompt = 'CLAUDE_PREAMBLE_CANARY'; });
 const f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
 f.setResponses([(context) => {
   // Pi 1.3 sends the system prompt as a system message: rendered sections, or forced plain content.
   const sys = context.messages.find((m) => m.role === 'system') ?? {};
   const text = [sys.content ?? '', ...Object.values(sys.sections ?? {})].join('\\n');
   if (sys.sections?.preamble !== 'CLAUDE_PREAMBLE_CANARY') return fauxAssistantMessage('PROVIDER_PROMPT_DISCARDED ' + text.slice(0, 60));
   if (!/Host broker: BLOCKED/.test(text)) return fauxAssistantMessage('HOST_MANIFEST_MISSING');
   if (/You are an expert coding assistant operating inside pi/.test(text)) return fauxAssistantMessage('PI_DEFAULT_PROMPT_SENT');
   return fauxAssistantMessage('Prompt preserved.');
 }]);
 pi.registerProvider(f.provider);`);
  } finally { if (saved === undefined) delete process.env.MINA_HOST_UNAVAILABLE; else process.env.MINA_HOST_UNAVAILABLE = saved; }
  try {
    success(f);
    assert.match(f.output.stdout, /Prompt preserved/);
    assert.doesNotMatch(f.output.stdout, /PROVIDER_PROMPT_DISCARDED|HOST_MANIFEST_MISSING|PI_DEFAULT_PROMPT_SENT/);
  } finally { f.close(); }
});

test('worker commits use the owner\'s git identity without per-command configuration', { skip: needsLauncher }, async (t) => {
  const { execFileSync } = await import('node:child_process');
  const get = (key) => { try { return execFileSync('/usr/bin/git', ['config', '--global', '--get', key], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  const name = get('user.name'), email = get('user.email');
  if (!name || !email) return t.skip('no global git identity on this host');
  const f = await launch(`
 const f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
 f.setResponses([fauxAssistantMessage(fauxToolCall('bash', { command: 'git init -q . && git commit -q --allow-empty -m probe && git log -1 --format=%an/%ae/%cn/%ce > who.txt' }), { stopReason: 'toolUse' }),
   fauxAssistantMessage('Committed.')]);
 pi.registerProvider(f.provider);`);
  try {
    success(f);
    assert.equal(readFileSync(join(f.cwd, 'who.txt'), 'utf8').trim(), `${name}/${email}/${name}/${email}`);
  } finally { f.close(); }
});

test('verbose startup retains instance and stop diagnostics on explicit request', { skip: needsLauncher }, async () => {
  const f = await launch(`const f = fauxProvider({provider:'mina-fixture',models:[{id:'fixture'}]}); f.setResponses([fauxAssistantMessage('Verbose fixture complete.')]); pi.registerProvider(f.provider);`, undefined, undefined, null, null, ['--verbose']);
  try { success(f); assert.match(f.output.stderr, /mina: instance [a-f0-9-]+; local limit/); assert.match(f.output.stderr, /explicit local stop/); }
  finally { f.close(); }
});

test('full mode loads configured Pi skills and gives workers read-only access to their helpers', { skip: needsLauncher }, async () => {
  const f = await launch(({ root }) => `
 const skill = ${JSON.stringify(join(root, 'shared', 'fixture', 'SKILL.md'))};
 const helper = ${JSON.stringify(join(root, 'shared', 'fixture', 'helper.sh'))};
 const f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
 pi.on('before_agent_start', () => { for (const name of ['fixture-skill','default-skill','package-skill']) if (!pi.getCommands().some(c => c.name === 'skill:'+name)) throw Error('Pi skill missing: '+name); });
 f.setResponses([fauxAssistantMessage(fauxToolCall('read', {path:skill}), {stopReason:'toolUse'}),
  ctx => { if (!JSON.stringify(ctx.messages.at(-1)).includes('SKILL_REFERENCE_CANARY')) throw Error('Skill cannot be read'); return fauxAssistantMessage(fauxToolCall('bash',{command:'bash '+JSON.stringify(helper)+'; test ! -w '+JSON.stringify(skill)}), {stopReason:'toolUse'}); },
  ctx => { if (!JSON.stringify(ctx.messages.at(-1)).includes('SKILL_HELPER_OK') || ctx.messages.at(-1).isError) throw Error('Skill helper failed'); return fauxAssistantMessage('Configured skill completed.'); }]);
 pi.registerProvider(f.provider);`, undefined, ({ root, agent }) => {
    const folder = join(root, 'shared', 'fixture'); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Skill discovery regression fixture.\n---\nSKILL_REFERENCE_CANARY\n');
    writeFileSync(join(folder, 'helper.sh'), 'printf SKILL_HELPER_OK');
    const globalDir = join(root, 'linked-default'); mkdirSync(globalDir);
    writeFileSync(join(globalDir, 'SKILL.md'), '---\nname: default-skill\ndescription: Default skill directory fixture.\n---\nDefault skill.\n');
    mkdirSync(join(agent, 'skills')); symlinkSync(globalDir, join(agent, 'skills', 'linked-default'));
    const pkg = join(root, 'skill-package'); mkdirSync(join(pkg, 'skills', 'fixture'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'skill-fixture', pi: { skills: ['skills'], extensions: ['evil.js'] } }));
    writeFileSync(join(pkg, 'skills', 'fixture', 'SKILL.md'), '---\nname: package-skill\ndescription: Packaged skill fixture.\n---\nPackage skill.\n');
    writeFileSync(join(pkg, 'evil.js'), "throw Error('PACKAGED_EXTENSION_EXECUTED');");
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ skills: [join(root, 'shared')], packages: [pkg] }));
  });
  try { success(f); assert.match(f.output.stdout, /Configured skill completed/); }
  finally { f.close(); }
});

test('real launcher gives the session the read-grant tool and the private roots that grants are checked against', { skip: needsLauncher }, async () => {
  const f = await launch(`
 const f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
 pi.on('before_agent_start', (e) => {
   const tool = pi.getAllTools().some((t) => t.name === 'mina_sandbox_request');
   const note = e.systemPromptOptions?.sections?.sandbox ?? '';
   f.setResponses([fauxAssistantMessage('PROBE ' + JSON.stringify({ tool, note: note.includes('mina_sandbox_request'), priv: JSON.parse(process.env.MINA_SANDBOX_PRIVATE ?? 'null') }))]);
 });
 pi.registerProvider(f.provider);`);
  try {
    success(f);
    const probe = JSON.parse(/PROBE ({.*?})(?:\\n|")/.exec(f.output.stdout)[1].replace(/\\"/g, '"'));
    assert.equal(probe.tool, true);
    assert.equal(probe.note, true);
    assert.ok(probe.priv.includes(f.agent), JSON.stringify(probe.priv));
  } finally { f.close(); }
});

test('real launcher hides the unreachable display sockets from Pi and copies through OSC 52', { skip: needsLauncher }, async () => {
  const saved = { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, DISPLAY: process.env.DISPLAY, PI_CLIPBOARD_OSC52: process.env.PI_CLIPBOARD_OSC52 };
  Object.assign(process.env, { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' });
  delete process.env.PI_CLIPBOARD_OSC52;
  try {
    const f = await launch(`
 const f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
 pi.on('before_agent_start', () => {
   f.setResponses([fauxAssistantMessage('PROBE ' + JSON.stringify({ wl: process.env.WAYLAND_DISPLAY ?? null, x: process.env.DISPLAY ?? null, osc52: process.env.PI_CLIPBOARD_OSC52 ?? null }))]);
 });
 pi.registerProvider(f.provider);`);
    try {
      success(f);
      const probe = JSON.parse(/PROBE ({.*?})(?:\\n|")/.exec(f.output.stdout)[1].replace(/\\"/g, '"'));
      assert.deepEqual(probe, { wl: null, x: null, osc52: '1' });
    } finally { f.close(); }
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('real goal completion retains checks-only policy and an honest UNVERIFIED label', { skip: needsLauncher }, async () => {
  const f = await launch(`
 const f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
 let goalId;
 pi.on('before_agent_start', (_e, ctx) => { goalId = ctx.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'goal-state').at(-1)?.data?.goal?.id; });
 f.setResponses([() => fauxAssistantMessage(fauxToolCall('goal_complete', {goal_id: goalId, summary: 'Fixture finished with no checks.'}), {stopReason:'toolUse'}), fauxAssistantMessage('Finished without independent verification.')]);
 pi.registerProvider(f.provider);`, '/goal --no-check --no-research Fixture objective', ({ agent }) => {
      writeFileSync(join(agent, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 32, reserveTokens: 32 } }));
      writeFileSync(join(agent, 'hot-compact.json'), JSON.stringify({ semantic: false }));
    }, (event, records) => event.type === 'agent_settled' && records.some((r) => r.type === 'entry_appended' && r.entry.customType === 'mina-goal' && r.entry.data.status === 'complete'),
    async (client) => { const result = await client.compact(); assert.ok(result.summary); assert.equal(result.details.hotCompact, true); });
  try {
    success(f);
    const goals = entries(f.agent).filter((e) => e.customType === 'mina-goal').map((e) => e.data);
    assert.equal(goals.at(-1).status, 'complete', f.output.stdout.slice(-5000));
    assert.equal(goals.at(-1).completionPolicy, 'checks-only');
    assert.equal(goals.at(-1).unverified, true);
    assert.match(f.output.stdout, /UNVERIFIED/);
  } finally { f.close(); }
});

test('real no-effect guard: pi-goal pauses after three automatic runs that only read, and no continuation follows', { skip: needsLauncher }, async () => {
  const f = await launch(`
 const f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
 const responses = [];
 for (let i = 0; i < 12; i++) responses.push(fauxAssistantMessage(fauxToolCall('read', {path: 'notes.txt'}), {stopReason:'toolUse'}), fauxAssistantMessage('Checked the notes, pass ' + i + '.'));
 f.setResponses(responses);
 pi.registerProvider(f.provider);`, '/goal --no-check --no-research Fixture objective that never changes anything', ({ cwd }) => writeFileSync(join(cwd, 'notes.txt'), 'nothing new\n'),
    (event, records) => event.type === 'agent_settled' && records.some((r) => r.type === 'entry_appended' && r.entry.customType === 'mina-goal' && r.entry.data.stall?.paused_at),
    async () => { await new Promise((r) => setTimeout(r, 1500)); });
  try {
    success(f);
    const all = entries(f.agent);
    const goal = all.filter((e) => e.customType === 'goal-state').at(-1).data.goal;
    assert.equal(goal.status, 'paused', f.output.stdout.slice(-5000));
    assert.equal(goal.automaticModelTurns >= 3, true);
    const paused = all.findIndex((e) => e.customType === 'mina-goal' && e.data?.stall?.paused_at);
    assert.ok(all.slice(paused).some((e) => e.type === 'custom_message' && e.customType === 'mina-goal' && /^mina paused this goal: 3 automatic runs/.test(e.content)));
    assert.equal(all.slice(paused).filter((e) => e.type === 'message' && e.message.role === 'assistant').length, 0, 'no model call after the pause');
  } finally { f.close(); }
});

test('real handoff keeps one instance, links sessions, and retains all research and continuity tools', { skip: needsLauncher }, async () => {
  const f = await launch(`
 const key = Symbol.for('mina:fixture-provider');
 let f = globalThis[key];
 if (!f) {
   globalThis[key] = f = fauxProvider({ provider: 'mina-fixture', models: [{ id: 'fixture' }] });
   f.setResponses([fauxAssistantMessage(fauxToolCall('mina_handoff_note', {state:'Saved fixture state.', next_actions:['Finish the fixture.']}), {stopReason:'toolUse'}), () => fauxAssistantMessage(fauxToolCall('goal_complete', {goal_id:f.currentGoalId, summary:'Successor fixture completed.'}), {stopReason:'toolUse'})]);
 }
 pi.registerProvider(f.provider);
 pi.on('before_agent_start', (_e, ctx) => {
   f.currentGoalId = ctx.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'goal-state').at(-1)?.data?.goal?.id;
   const expected = ['research_search','web_fetch','literature_search','paper_resolve','paper_get','citation_expand','literature_db','supplement_get','Agent','mina_recall','context_recall'];
   for (const name of expected) if (!pi.getAllTools().some(t => t.name === name)) throw new Error('Missing preserved tool: ' + name);
 });`, '/goal --no-check --no-research Handoff fixture objective', undefined,
   (event, records) => event.type === 'agent_settled' && records.some((r) => r.type === 'entry_appended' && r.entry.customType === 'mina-goal' && r.entry.data.status === 'complete'));
  try {
    success(f);
    const all = entries(f.agent);
    assert.ok(all.some((e) => e.customType === 'mina-handoff'), 'successor must contain the native handoff marker');
    assert.ok(all.some((e) => e.type === 'session' && e.parentSession), 'successor must link its parent');
    assert.match(f.output.stdout, /Successor fixture completed/);
    assert.equal(readdirSync(join(f.root, 'state', 'mina', 'instances')).filter(name => name.endsWith('.json')).length, 1);
  } finally { f.close(); }
});
