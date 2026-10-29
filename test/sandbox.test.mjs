import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outerArgs, innerArgs, wrapCommand, scrubEnv, insideAny, projectProblem, settings, loadConfig, claudeState, defaultWritable, defaultHidden, REPO, minaCode, validateTrustedResources, validateWritableRoots, validateReadableRoots, projectRoot, checkReadGrant } from '../sandbox/sandbox.mjs';
import minaSandbox, { sandboxNote } from '../extensions/sandbox/index.js';
import { createServer } from 'node:net';
import { runWorker } from '../sandbox/worker-client.mjs';
import minaIdentity from '../extensions/identity/index.js';
import { needsSandbox } from './capabilities.mjs';

const box = (over = {}) => ({ project: '/p', cwd: '/p', writable: ['/p'], hidden: [], network: 'open', ...over });

test('outer layer: read-only root, private /tmp, then the writable binds that exist', () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-home-'));
  const a = outerArgs(box({ writable: [home, '/does/not/exist'] }), { uid: 99999, env: {} });
  assert.deepEqual(a.slice(0, 2), ['--ro-bind', '/']);
  assert.ok(a.indexOf('--tmpfs') < a.indexOf(home));
  assert.ok(a.includes(home) && !a.includes('/does/not/exist'));
  assert.ok(a.includes('--die-with-parent'));
});

test('Claude state (~/.claude, ~/.claude.json, ~/.claude-*): writable for the trusted controller, absent from workers', () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-claude-home-'));
  mkdirSync(join(home, '.claude')); writeFileSync(join(home, '.claude.json'), '{}');
  mkdirSync(join(home, '.claude-work'));
  const cwd = join(home, 'project'); mkdirSync(cwd);
  const s = settings({ cwd, home, env: {}, config: { file: null } });
  const outer = outerArgs(s, { uid: 99999, env: {} }).join(' ');
  const inner = innerArgs({ ...s, network: 'offline', env: {} });
  const state = ['.claude', '.claude.json', '.claude-work'].map((name) => join(home, name));
  assert.deepEqual(claudeState(home, {}), state);
  for (const path of state) {
    assert.ok(defaultWritable(home, {}).includes(path));
    assert.ok(defaultHidden(home, {}).includes(path) && s.hidden.includes(path));
    assert.ok(outer.includes(`--bind ${path} ${path}`));
    assert.ok(!s.writable.includes(path) && !s.readable.includes(path) && !s.readOnly.includes(path));
    assert.ok(!inner.includes(path)); // The positive-mount worker never imports controller state.
  }
  const missing = mkdtempSync(join(tmpdir(), 'mina-noclaude-home-'));
  assert.doesNotMatch(outerArgs(box({ home: missing }), { uid: 99999, env: {} }).join(' '), /\.claude/);
});

test('a second Claude account\'s state masks its symlink target if a worker data mount contains it', () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-second-link-'));
  const data = join(home, 'data'); mkdirSync(data);
  const target = join(data, 'profile'); mkdirSync(target);
  symlinkSync(target, join(home, '.claude-work'));
  const a = innerArgs({ cwd: '/p', readable: [data], hidden: defaultHidden(home, {}), env: {} });
  const j = a.join(' ');
  assert.ok(j.includes(`--tmpfs ${target}`) && j.includes(`--remount-ro ${target}`));
  assert.ok(!a.includes(join(home, '.claude-work')));
});

test('root validation denies a second Claude account\'s writable/readable grants, ancestors, descendants and symlink aliases', () => {
  for (const linkedProfile of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'mina-second-roots-'));
    const home = join(root, 'home'); mkdirSync(home);
    const profile = join(home, '.claude-work');
    const target = linkedProfile ? join(root, 'profile-target') : profile;
    mkdirSync(target);
    if (linkedProfile) symlinkSync(target, profile);
    const child = join(profile, 'projects'); mkdirSync(child);
    const alias = join(root, 'profile-alias'); symlinkSync(profile, alias);
    const homeAlias = join(root, 'home-alias'); symlinkSync(home, homeAlias);
    // These are the same trusted-state lists used by launch preflight.
    for (const path of [root, home, homeAlias, profile, target, child, alias, join(alias, 'projects')]) {
      assert.throws(() => validateWritableRoots([path], { trustedRoots: defaultWritable(home, {}) }), /overlaps trusted runtime\/state/);
      assert.throws(() => validateReadableRoots([path], { trustedRoots: claudeState(home, {}) }), /overlaps private controller state/);
    }
    // A name that only starts like Claude's is not Claude state; every ~/.claude-* entry is.
    const sibling = join(home, '.claudette'); mkdirSync(sibling);
    assert.equal(validateWritableRoots([sibling], { trustedRoots: defaultWritable(home, {}) }), true);
    assert.equal(validateReadableRoots([sibling], { trustedRoots: claudeState(home, {}) }), true);
    const other = join(home, '.claude-other-account'); mkdirSync(other);
    assert.ok(defaultHidden(home, {}).includes(other));
    assert.throws(() => validateReadableRoots([other], { trustedRoots: claudeState(home, {}) }), /overlaps private controller state/);
  }
});

function writeClaudeProfiles(agent, profiles) {
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'claude-sdk.json'), JSON.stringify({ profiles }), { mode: 0o600 });
}

test('owner-configured Claude directories are controller-writable, worker-private and denied as data roots', () => {
  for (const override of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), 'mina-custom-claude-'));
    const agent = join(home, override ? 'owner-agent' : '.pi/agent');
    const env = override ? { PI_CODING_AGENT_DIR: agent } : {};
    const parent = join(home, 'accounts'); mkdirSync(parent);
    const custom = join(parent, 'work'); mkdirSync(custom);
    const child = join(custom, 'projects'); mkdirSync(child);
    const alias = join(home, 'work-alias'); symlinkSync(custom, alias);
    const profiles = [
      { id: 'default', name: 'Default', configDir: join(home, '.claude') },
      { id: 'second', name: 'Second', configDir: join(home, '.claude-second') },
      { id: 'work', name: 'Work', configDir: custom },
    ];
    if (override) writeClaudeProfiles(join(home, '.pi/agent'), [{ configDir: '/' }]); // Must not read the default agent dir.
    writeClaudeProfiles(agent, profiles);
    assert.deepEqual(claudeState(home, env), [...['.claude', '.claude.json', '.claude-second'].map((p) => join(home, p)), custom]);
    assert.ok(defaultWritable(home, env).includes(custom));
    assert.ok(defaultHidden(home, env).includes(custom));
    const cwd = join(home, 'project'); mkdirSync(cwd);
    const s = settings({ cwd, home, env, config: { file: null } });
    assert.ok(s.hidden.includes(custom));
    assert.ok(!s.writable.includes(custom) && !s.readable.includes(custom));
    assert.ok(outerArgs(s, { env }).join(' ').includes(`--bind ${custom} ${custom}`));
    // Synthetic home: worker defaults use the real OS home, so pass the resolved hidden paths explicitly.
    assert.ok(!innerArgs({ ...s, network: 'offline', env: {} }).includes(custom));
    const masked = innerArgs({ cwd, readable: [parent], hidden: s.hidden, env: {} }).join(' ');
    assert.ok(masked.includes(`--tmpfs ${custom}`) && masked.includes(`--remount-ro ${custom}`));
    for (const path of [parent, custom, child, alias, join(alias, 'projects')]) {
      assert.throws(() => validateWritableRoots([path], { trustedRoots: defaultWritable(home, env) }), /overlaps trusted runtime\/state/);
      assert.throws(() => validateReadableRoots([path], { trustedRoots: claudeState(home, env) }), /overlaps private controller state/);
    }
  }
});

test('Claude profile configuration never comes from the project or sandbox configuration', () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-claude-spoof-'));
  const cwd = join(home, 'project'); mkdirSync(cwd);
  writeClaudeProfiles(join(cwd, '.pi'), [{ id: 'spoof', name: 'Spoof', configDir: '/' }]);
  const s = settings({ cwd, home, env: {}, config: { file: null, profiles: [{ configDir: '/' }] } });
  assert.deepEqual(claudeState(home, {}), ['.claude', '.claude.json'].map((p) => join(home, p)));
  assert.ok(!s.hidden.includes('/') && !defaultWritable(home, {}).includes('/'));
  assert.doesNotThrow(() => outerArgs(s, { env: {} }));
  // Even an owner-file symlink cannot route profile discovery through a writable project.
  const agent = join(home, '.pi/agent'); mkdirSync(agent, { recursive: true });
  symlinkSync(join(cwd, '.pi/claude-sdk.json'), join(agent, 'claude-sdk.json'));
  assert.throws(() => settings({ cwd, home, env: {}, config: { file: null } }), /traverses a writable root/);
});

test('custom Claude state rejects broad roots, runtime overlaps and symlink escapes, including missing targets', () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-claude-unsafe-'));
  const agent = join(home, '.pi/agent');
  const outside = mkdtempSync(join(tmpdir(), 'mina-claude-outside-'));
  symlinkSync(outside, join(home, 'escape'));
  symlinkSync(home, join(home, 'home-alias'));
  symlinkSync(REPO, join(home, 'runtime-alias'));
  symlinkSync(agent, join(home, 'agent-alias'));
  for (const configDir of ['/', home, '/usr', '/etc', '/dev', '/proc', '/sys', '/run', outside, REPO,
    join(home, 'home-alias'), join(home, 'runtime-alias'), join(home, 'runtime-alias/new-profile'),
    agent, join(home, '.pi'), join(home, 'agent-alias'), join(home, 'escape'), join(home, 'escape/not-created')]) {
    writeClaudeProfiles(agent, [{ id: 'unsafe', name: 'Unsafe', configDir }]);
    assert.throws(() => claudeState(home, {}), /unsafe Claude profile configDir/);
    assert.throws(() => defaultWritable(home, {}), /unsafe Claude profile configDir/);
    assert.throws(() => defaultHidden(home, {}), /unsafe Claude profile configDir/);
  }
  const missing = join(home, 'private/not-created');
  writeClaudeProfiles(agent, [{ id: 'safe', name: 'Safe', configDir: missing }]);
  assert.ok(claudeState(home, {}).includes(missing));
  assert.ok(!outerArgs(box({ home }), { env: {} }).includes(missing));
  const privateDir = join(home, 'private'); mkdirSync(privateDir);
  const privateAlias = join(home, 'private-alias'); symlinkSync(privateDir, privateAlias);
  writeClaudeProfiles(agent, [{ id: 'safe', name: 'Safe', configDir: join(privateAlias, 'not-created') }]);
  assert.ok(claudeState(home, {}).includes(missing)); // Canonicalize through the existing symlink ancestor.
  assert.throws(() => validateWritableRoots([privateDir], { trustedRoots: defaultWritable(home, {}) }), /overlaps trusted runtime\/state/);
  assert.throws(() => validateReadableRoots([privateDir], { trustedRoots: claudeState(home, {}) }), /overlaps private controller state/);
  const dangling = join(home, 'dangling'); symlinkSync(join(outside, 'missing'), dangling);
  writeClaudeProfiles(agent, [{ id: 'unsafe', name: 'Unsafe', configDir: dangling }]);
  assert.throws(() => claudeState(home, {}), /cannot resolve Claude profile state root/);
});

test('fixed Claude profile symlinks cannot grant broad or runtime roots either', () => {
  for (const destination of ['/', '/usr', REPO, 'home']) {
    const home = mkdtempSync(join(tmpdir(), 'mina-fixed-claude-unsafe-'));
    symlinkSync(destination === 'home' ? home : destination, join(home, '.claude-work'));
    assert.throws(() => defaultWritable(home, {}), /unsafe Claude profile state root/);
  }
});

test('malformed owner Claude profiles fail closed', () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-claude-invalid-'));
  const agent = join(home, '.pi/agent');
  for (const profiles of [null, {}, [null], [{}], [{ configDir: 'relative' }], [{ configDir: '/bad\0path' }]]) {
    writeClaudeProfiles(agent, profiles);
    assert.throws(() => claudeState(home, {}), /mina sandbox: Claude/);
  }
  writeFileSync(join(agent, 'claude-sdk.json'), '{');
  assert.throws(() => claudeState(home, {}), /invalid Claude profile configuration/);
  assert.throws(() => claudeState(home, { PI_CODING_AGENT_DIR: '.pi' }), /owner agent directory must be absolute/);
});

test('inner layer: hidden paths masked (dirs as read-only tmpfs, files as /dev/null); network levels', () => {
  const d = mkdtempSync(join(tmpdir(), 'mina-hide-'));
  mkdirSync(join(d, '.ssh')); writeFileSync(join(d, 'auth.json'), '{}');
  const a = innerArgs({ cwd: '/p', readable: [d], hidden: [join(d, '.ssh'), join(d, 'auth.json'), join(d, 'missing')] });
  assert.ok(a.join(' ').includes(`--tmpfs ${join(d, '.ssh')}`) && a.join(' ').includes(`--remount-ro ${join(d, '.ssh')}`));
  assert.ok(a.join(' ').includes(`--ro-bind /dev/null ${join(d, 'auth.json')}`));
  assert.ok(!a.includes(join(d, 'missing')) && a.includes('--unshare-net'));
  assert.ok(innerArgs({ cwd: '/p', network: 'offline' }).includes('--unshare-net'));
  assert.throws(() => innerArgs({ cwd: '/p', network: 'packages' }), /egress proxy/);
});

test('wrapped command keeps the original command as one quoted argument', () => {
  const w = wrapCommand(`echo "it's" && ls`, { cwd: '/p', hidden: [], network: 'offline' });
  assert.match(w, /^exec \/usr\/bin\/env -i PATH=\/usr\/bin:\/bin \/usr\/bin\/bwrap /); assert.ok(w.endsWith(`'/bin/bash' '--noprofile' '--norc' '-c' 'echo "it'\\''s" && ls'`));
});

test('trusted configuration cannot traverse a writable project alias', () => {
  const root = mkdtempSync(join(tmpdir(), 'mina-config-alias-'));
  const project = join(root, 'project'); mkdirSync(project);
  const config = join(root, 'real.json'); writeFileSync(config, '{}');
  symlinkSync(config, join(project, 'alias.json'));
  symlinkSync(join(project, 'alias.json'), join(root, 'models.json'));
  assert.throws(() => validateTrustedResources([join(root, 'models.json')], [project]), /writable/);
  assert.equal(validateTrustedResources([config], [project]), true);
});

test('project discovery never executes a workspace git from inherited PATH', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-discovery-path-'));
  const marker = join(cwd, 'escaped');
  writeFileSync(join(cwd, 'git'), `#!/bin/sh\nprintf escaped > '${marker}'\nprintf '%s' '${cwd}'`, { mode: 0o755 });
  const before = process.env.PATH; process.env.PATH = `${cwd}:${before}`;
  try { assert.equal(projectRoot(cwd), cwd); assert.equal(existsSync(marker), false); }
  finally { process.env.PATH = before; }
});

test('secret-like variables are dropped from the commands environment', () => {
  assert.deepEqual(scrubEnv({ PATH: '/usr/bin', EXA_API_KEY: 'x', GITHUB_TOKEN: 'y', HOME: '/h', AWS_SECRET_ACCESS_KEY: 'z' }), { PATH: '/usr/bin', HOME: '/h' });
});

test('insideAny follows symlinks through the nearest existing ancestor', () => {
  const d = mkdtempSync(join(tmpdir(), 'mina-in-'));
  mkdirSync(join(d, 'proj')); symlinkSync('/etc', join(d, 'proj', 'escape'));
  assert.ok(insideAny('new/file.txt', [join(d, 'proj')], join(d, 'proj')));
  assert.ok(!insideAny('escape/passwd', [join(d, 'proj')], join(d, 'proj')));
  assert.ok(!insideAny('/etc/hosts', [join(d, 'proj')], join(d, 'proj')));
});

test('the sandbox refuses a project that is or contains the home folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-h-')); mkdirSync(join(home, 'proj'));
  assert.match(projectProblem(home, home), /home folder/);
  assert.equal(projectProblem(join(home, 'proj'), home), null);
});

test('settings: config file write/hide/network, flags win, hidden defaults include credentials', () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-cfg-'));
  const cwd = join(home, 'project'); mkdirSync(cwd);
  const s = settings({ cwd, home, env: {}, write: ['~/out'], network: 'packages', config: { file: 'x', write: ['~/data'], network: 'offline', hide: ['~/secret'] } });
  assert.equal(s.network, 'packages');
  assert.ok(s.writable.includes(join(home, 'out')) && s.writable.includes(join(home, 'data')));
  assert.ok(s.hidden.includes(join(home, 'secret')) && defaultHidden(home, {}).includes(join(home, '.ssh')));
});

test('the "hide" list of ~/.config/mina/sandbox.json (or MINA_SANDBOX_CONFIG) adds hidden paths; the built-in list is generic', () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-cfg-hide-'));
  const cwd = join(home, 'project'); mkdirSync(cwd);
  mkdirSync(join(home, '.config', 'mina'), { recursive: true });
  const legacy = ['~/.config/old-tool', '~/.local/share/old-tool/auth.json'];
  writeFileSync(join(home, '.config', 'mina', 'sandbox.json'), JSON.stringify({ hide: legacy }));
  const s = settings({ cwd, home, env: {} , config: loadConfig(home, {}) });
  for (const p of legacy) assert.ok(s.hidden.includes(p.replace('~', home)), p);
  const other = join(home, 'other.json');
  writeFileSync(other, JSON.stringify({ hide: ['~/elsewhere'] }));
  assert.ok(settings({ cwd, home, env: {}, config: loadConfig(home, { MINA_SANDBOX_CONFIG: other }) }).hidden.includes(join(home, 'elsewhere')));
  const builtIn = defaultHidden(home, {});
  for (const p of ['.ssh', '.gnupg', '.aws', '.config/gh', '.config/mina/keys', '.pi/agent/auth.json', '.claude', '.claude.json']) assert.ok(builtIn.includes(join(home, p)), p);
  assert.ok(builtIn.includes(join(REPO, 'keys')));
});

function fakePi() {
  const tools = {}, handlers = {};
  return { tools, handlers, pi: { registerTool: (t) => { tools[t.name] = t; }, on: (e, f) => { (handlers[e] ??= []).push(f); } } };
}

test('extension: bash is replaced and wraps commands; refuses (fail closed) without bwrap; write guard', async () => {
  const env = { MINA_SANDBOX: '1', MINA_SANDBOX_WRITE: JSON.stringify(['/p']), MINA_SANDBOX_HIDE: '[]', MINA_SANDBOX_NET: 'open' };
  const f = fakePi(); minaSandbox(f.pi, { env, available: true });
  assert.ok(f.tools.bash);
  const off = fakePi(); minaSandbox(off.pi, { env: {}, available: true });
  assert.equal(off.tools.bash, undefined);
  const call = (e) => f.handlers.tool_call[0](e, { cwd: '/p' });
  assert.equal(call({ toolName: 'write', input: { path: '/p/a.txt' } }), undefined);
  assert.equal(call({ toolName: 'write', input: { path: '/home/x/.bashrc' } }).block, true);
});

test('effective identity distinguishes standing autonomy from new authority and unsafe retries', () => {
  let hook; minaIdentity({ on: (_event, fn) => { hook = fn; } }, { env: { MINA_SANDBOX: '1' } });
  const event = { systemPromptOptions: { sections: {} } }; hook(event);
  const prompt = event.systemPromptOptions.sections.identity;
  assert.match(prompt, /ordinary authorized work.*without asking/s);
  assert.match(prompt, /read-only discovery.*output recovery.*local edits.*tests/s);
  assert.match(prompt, /explicit.*attempt.*limits/s);
  assert.match(prompt, /uncertain.*status.*before.*retry/s);
  assert.match(prompt, /protected checks.*new privileges.*material.*scope/s);
});

test('identity: an <identity> section, with the sandbox note only when the sandbox is on', () => {
  for (const [env, note] of [[{ MINA_SANDBOX: '1' }, true], [{}, false]]) {
    const f = fakePi(); minaIdentity(f.pi, { env });
    const event = { systemPromptOptions: { sections: {} } };
    f.handlers.before_agent_start[0](event);
    assert.match(event.systemPromptOptions.sections.identity, /You are mina/);
    assert.equal(/mina's sandbox/.test(event.systemPromptOptions.sections.identity), note);
  }
});

test('a hidden symlink hides its target (bwrap cannot mount on a symlink)', () => {
  const d = mkdtempSync(join(tmpdir(), 'mina-link-'));
  writeFileSync(join(d, 'real-auth.json'), '{}'); symlinkSync(join(d, 'real-auth.json'), join(d, 'auth.json'));
  const a = innerArgs({ cwd: '/p', readable: [d], hidden: [join(d, 'auth.json'), join(d, 'real-auth.json')] });
  assert.equal(a.filter((x) => x === join(d, 'real-auth.json')).length, 1);
  assert.ok(!a.includes(join(d, 'auth.json')));
});

test("mina's own code is hidden from the agent, except its skills and Pi's docs; not when the project is mina itself", () => {
  // The live run read ~/projects/mina to learn how a gate decides, then wrote what would pass it (2026-10-07).
  const home = mkdtempSync(join(tmpdir(), 'mina-cfg-'));
  const cwd = join(home, 'project'); mkdirSync(cwd);
  const s = settings({ cwd, home, env: {}, config: { file: null } });
  assert.ok(s.hidden.includes(REPO));
  assert.ok(s.exposed.includes(join(REPO, 'skills')) && s.exposed.includes(join(REPO, 'node_modules/@earendil-works/pi-coding-agent/docs')));
  assert.deepEqual(minaCode(REPO), { hidden: [], exposed: [] });
  assert.deepEqual(minaCode(join(REPO, 'test')), { hidden: [], exposed: [] });
  const a = innerArgs({ cwd: '/p', readable: [REPO], hidden: [REPO], exposed: [join(REPO, 'skills'), join(REPO, 'missing')] });
  const j = a.join(' ');
  const bound = j.lastIndexOf(`--ro-bind ${join(REPO, 'skills')} ${join(REPO, 'skills')}`);
  assert.ok(j.indexOf(`--tmpfs ${REPO}`) < bound && bound < j.indexOf(`--remount-ro ${REPO}`));   // mount points made before read-only
  assert.ok(!a.includes(join(REPO, 'missing')));
});

test("the read tool refuses mina's code with its own reason, and reads a skill", () => {
  const env = { MINA_SANDBOX: '1', MINA_SANDBOX_WRITE: JSON.stringify(['/p']), MINA_SANDBOX_HIDE: JSON.stringify([REPO, '/h/.ssh']),
    MINA_SANDBOX_EXPOSE: JSON.stringify([join(REPO, 'skills')]), MINA_SANDBOX_NET: 'open' };
  const f = fakePi(); minaSandbox(f.pi, { env, available: true });
  const call = (e) => f.handlers.tool_call[0](e, { cwd: '/p' });
  const r = call({ toolName: 'read', input: { path: join(REPO, 'extensions/goal/checks.mjs') } });
  assert.equal(r.block, true); assert.match(r.reason, /mina's own code[^]*not part of the task/);
  assert.equal(call({ toolName: 'read', input: { path: join(REPO, 'skills/mina-research/SKILL.md') } }), undefined);
  assert.match(call({ toolName: 'read', input: { path: '/h/.ssh/id' } }).reason, /credential/);
});

test("Pi's agent folder is read-only to the agent: bound read-only before the credential masks, and refused to write and edit", () => {
  // The live run could write ~/.pi/agent (agents/*.md hold max_turns; settings.json the default model).
  const home = mkdtempSync(join(tmpdir(), 'mina-cfg-'));
  const agent = join(home, '.pi', 'agent'); mkdirSync(agent, { recursive: true }); writeFileSync(join(agent, 'auth.json'), '{}');
  const cwd = join(home, 'project'); mkdirSync(cwd);
  const s = settings({ cwd, home, env: {}, config: { file: null } });
  assert.deepEqual(s.readOnly, []);
  assert.ok(!s.writable.includes(agent));
  const j = innerArgs({ cwd: '/p', hidden: [join(agent, 'auth.json')], readOnly: [agent] }).join(' ');
  assert.ok(j.indexOf(`--ro-bind ${agent} ${agent}`) < j.indexOf(`--ro-bind /dev/null ${join(agent, 'auth.json')}`));  // or the bind would show auth.json again
  const env = { MINA_SANDBOX: '1', MINA_SANDBOX_WRITE: JSON.stringify(['/p', agent]), MINA_SANDBOX_HIDE: '[]', MINA_SANDBOX_READONLY: JSON.stringify([agent]), MINA_SANDBOX_NET: 'open' };
  const f = fakePi(); minaSandbox(f.pi, { env, available: true });
  const call = (e) => f.handlers.tool_call[0](e, { cwd: '/p' });
  assert.match(call({ toolName: 'edit', input: { path: join(agent, 'agents', 'delegate.md') } }).reason, /read-only/);
  assert.equal(call({ toolName: 'write', input: { path: '/p/a.txt' } }), undefined);
  assert.equal(call({ toolName: 'read', input: { path: join(agent, 'settings.json') } }), undefined);   // still readable
});

test('read grants: the --sandbox-read rules, no broad roots, no hidden credentials, canonical paths, already-visible paths', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mina-grant-home-'));
  const data = join(home, 'envs', 'seq'); mkdirSync(join(data, 'bin'), { recursive: true });
  const ssh = join(home, '.ssh'); mkdirSync(ssh);
  const priv = join(home, '.pi', 'agent'); mkdirSync(priv, { recursive: true });
  symlinkSync(data, join(home, 'seq-link'));
  const opts = { writable: [join(home, 'project')], hidden: [ssh], privateRoots: [priv], home };
  assert.deepEqual(checkReadGrant(join(home, 'seq-link'), opts), { path: data, already: false });      // symlink resolved
  assert.equal(checkReadGrant(join(data, 'bin'), { ...opts, readable: [data] }).already, true);
  for (const [path, why] of [[join(home, 'missing'), /does not exist/], ['/', /too broad/], [home, /too broad/],
    [join(home, '..'), /too broad/], ['/proc', /too broad/], [join(ssh), /hidden credential/], [priv, /private controller state/]]) {
    assert.throws(() => checkReadGrant(path, opts), why, path);
  }
  const sock = join(data, 'agent.sock');
  const server = createServer().listen(sock);
  await new Promise((r) => server.once('listening', r));
  try { assert.throws(() => checkReadGrant(data, opts), /Unix socket/); } finally { server.close(); }
});

function grantPi() {
  const tools = {}, handlers = {}, commands = {}, entries = [], messages = [];
  return { tools, handlers, commands, entries, messages, pi: { registerTool: (t) => { tools[t.name] = t; }, on: (e, f) => { (handlers[e] ??= []).push(f); },
    registerCommand: (n, o) => { commands[n] = o; }, appendEntry: (type, data) => entries.push({ type, data }), sendMessage: (m, o) => messages.push({ m, o }) } };
}
const grantEnv = (project) => ({ MINA_SANDBOX: '1', MINA_SANDBOX_PROJECT: project, MINA_SANDBOX_WRITE: JSON.stringify([project]), MINA_SANDBOX_READ: '[]',
  MINA_SANDBOX_HIDE: '[]', MINA_SANDBOX_NET: 'offline', MINA_SANDBOX_PRIVATE: '[]' });

test('mina_sandbox_request: the user allows or denies in the dialog; invalid requests never reach the user; the prompt lists grants', async () => {
  const project = mkdtempSync(join(tmpdir(), 'mina-grant-project-'));
  const data = mkdtempSync(join(tmpdir(), 'mina-grant-data-'));
  const env = grantEnv(project);
  const f = grantPi(); minaSandbox(f.pi, { env, available: true });
  const asked = [];
  let answer = 'Allow read-only access until mina exits';
  const ctx = { cwd: project, hasUI: true, ui: { notify: () => {}, select: async (title, options) => { asked.push({ title, options }); return answer; } } };
  const call = (params) => f.tools.mina_sandbox_request.execute('id', params, null, null, ctx);
  const prompt = () => { const e = { systemPromptOptions: { sections: {} } }; for (const h of f.handlers.before_agent_start) h(e, ctx); return e.systemPromptOptions.sections.sandbox; };
  assert.match(prompt(), /read-only none/);
  assert.match(prompt(), /mina_sandbox_request[^]*--sandbox-write PATH/);
  const bad = await call({ path: '/', reason: 'everything' });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /too broad[^]*not shown to the user/);
  assert.equal(asked.length, 0);
  const ok = await call({ path: data, reason: 'the micromamba env with pandas' });
  assert.match(asked[0].title, new RegExp(`read ${data}[^]*micromamba env with pandas[^]*--sandbox-read ${data}`));
  assert.match(ok.content[0].text, /allowed read-only access/);
  assert.deepEqual(JSON.parse(env.MINA_SANDBOX_READ), [data]);
  assert.match(prompt(), new RegExp(`read-only ${data}`));
  assert.deepEqual(f.entries.map((e) => [e.type, e.data.decision]), [['mina-sandbox', 'allowed']]);
  assert.match((await call({ path: data, reason: 'again' })).content[0].text, /already visible/);
  assert.equal(asked.length, 1);
  answer = 'Deny';
  const other = mkdtempSync(join(tmpdir(), 'mina-grant-other-'));
  assert.match((await call({ path: other, reason: 'more' })).content[0].text, /denied[^]*Do not work around it/);
  assert.deepEqual(JSON.parse(env.MINA_SANDBOX_READ), [data]);
});

test('mina_sandbox_request: unanswered or without a terminal, the request waits for /mina-sandbox, which applies it and tells the agent', async () => {
  const project = mkdtempSync(join(tmpdir(), 'mina-grant-project-'));
  const data = mkdtempSync(join(tmpdir(), 'mina-grant-data-'));
  const env = grantEnv(project);
  const f = grantPi(); minaSandbox(f.pi, { env, available: true, grantWaitMs: 60 });
  const notes = [];
  const away = { cwd: project, hasUI: true, ui: { notify: (m) => notes.push(m), select: (_t, _o, opts) => new Promise((r) => setTimeout(() => r(undefined), opts?.timeout ?? 0)) } };
  const out = await f.tools.mina_sandbox_request.execute('id', { path: data, reason: 'input data' }, null, null, away);
  assert.match(out.content[0].text, /Nobody answered[^]*\/mina-sandbox/);
  assert.match(notes.at(-1), /Decide with \/mina-sandbox/);
  const headless = await f.tools.mina_sandbox_request.execute('id', { path: data, reason: 'input data' }, null, null, { cwd: project, hasUI: false });
  assert.match(headless.content[0].text, /no interactive user/);
  assert.deepEqual(JSON.parse(env.MINA_SANDBOX_READ), []);                                      // nothing granted yet
  await f.commands['mina-sandbox'].handler('', { cwd: project, hasUI: true, ui: { notify: () => {}, select: async () => 'Allow read-only access until mina exits' } });
  assert.deepEqual(JSON.parse(env.MINA_SANDBOX_READ), [data]);                                  // queued once, applied once
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].m.content, /allowed read-only access/);
  assert.equal(f.messages[0].o.triggerTurn, true);
  const shown = [];
  await f.commands['mina-sandbox'].handler('', { cwd: project, hasUI: true, ui: { notify: (m) => shown.push(m) } });
  assert.match(shown[0], new RegExp(`no request is waiting[^]*read-only ${data}`));
});

test('mina_sandbox_request: parallel requests and /mina-sandbox show one dialog at a time; each gets its own timeout; abort closes it', async () => {
  // Pi has one dialog slot: a second select() replaces the first, whose countdown later closes the other one (2026-10-28 stall).
  const project = mkdtempSync(join(tmpdir(), 'mina-grant-project-'));
  const [a, b, c] = [1, 2, 3].map(() => mkdtempSync(join(tmpdir(), 'mina-grant-data-')));
  const env = grantEnv(project);
  const f = grantPi(); minaSandbox(f.pi, { env, available: true, grantWaitMs: 200 });
  let open = 0, most = 0;
  const shown = [], timeouts = [];
  const select = (title, _o, opts) => {
    open++; most = Math.max(most, open); shown.push(title.match(/read (\S+)/)[1]); timeouts.push(opts?.timeout);
    return new Promise((r) => setTimeout(() => { open--; r(title.includes(c) ? undefined : 'Allow read-only access until mina exits'); }, 20));
  };
  const ctx = { cwd: project, hasUI: true, ui: { notify: () => {}, select } };
  const call = (path) => f.tools.mina_sandbox_request.execute('id', { path, reason: 'r' }, undefined, null, ctx);
  const [ra, rb] = await Promise.all([call(a), call(b)]);
  assert.match(ra.content[0].text, /allowed/); assert.match(rb.content[0].text, /allowed/);
  assert.deepEqual(shown, [a, b]); assert.equal(most, 1); assert.deepEqual(timeouts, [200, 200]);
  assert.deepEqual(JSON.parse(env.MINA_SANDBOX_READ), [a, b]);

  // A queued request decided with /mina-sandbox while the agent asks again: still one dialog at a time.
  const away = { cwd: project, hasUI: true, ui: { notify: () => {}, select: (_t, _o, opts) => new Promise((r) => setTimeout(() => r(undefined), opts.timeout)) } };
  await f.tools.mina_sandbox_request.execute('id', { path: c, reason: 'r' }, undefined, null, away);   // times out: queued
  shown.length = 0; most = 0;
  const d = mkdtempSync(join(tmpdir(), 'mina-grant-data-'));
  await Promise.all([f.commands['mina-sandbox'].handler('', ctx), call(d)]);
  assert.deepEqual(shown.sort(), [c, d].sort()); assert.equal(most, 1);

  // Esc in Pi aborts the turn: the dialog gets the signal and the tool returns.
  const ac = new AbortController();
  const e = mkdtempSync(join(tmpdir(), 'mina-grant-data-'));
  const held = { cwd: project, hasUI: true, ui: { notify: () => {}, select: (_t, _o, opts) => new Promise((r) => opts.signal.addEventListener('abort', () => r(undefined))) } };
  const pending = f.tools.mina_sandbox_request.execute('id', { path: e, reason: 'r' }, ac.signal, null, held);
  ac.abort();
  assert.match((await pending).content[0].text, /cancelled[^]*Nothing changed/);
  assert.deepEqual(JSON.parse(env.MINA_SANDBOX_READ), [a, b, d]);
});

test('real worker: a read grant applies to the next command without a restart', { skip: needsSandbox }, async () => {
  const project = mkdtempSync(join(tmpdir(), 'mina-grant-project-'));
  const data = mkdtempSync(join(tmpdir(), 'mina-grant-data-'));
  writeFileSync(join(data, 'counts.tsv'), 'gene\t42\n');
  const env = grantEnv(project);
  const f = grantPi(); minaSandbox(f.pi, { env, available: true });
  const cat = () => runWorker(['/bin/bash', '-c', `cat ${join(data, 'counts.tsv')} 2>&1`], { cwd: project, env, network: 'offline', timeout: 10 });
  assert.match((await cat()).stdout.toString(), /No such file/);                                // not visible before
  const ctx = { cwd: project, hasUI: true, ui: { notify: () => {}, select: async () => 'Allow read-only access until mina exits' } };
  await f.tools.mina_sandbox_request.execute('id', { path: data, reason: 'counts' }, null, null, ctx);
  assert.equal((await cat()).stdout.toString(), 'gene\t42\n');                              // visible at the next call
  const write = await runWorker(['/bin/bash', '-c', `{ echo x > ${join(data, 'new')}; } 2>&1; echo rc=$?`], { cwd: project, env, network: 'offline', timeout: 10 });
  assert.match(write.stdout.toString(), /Read-only file system[^]*rc=1/);                      // and read-only
});
