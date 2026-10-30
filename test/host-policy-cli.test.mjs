// `mina host ...`: the owner's terminal commands for the host policy (bin/mina.mjs -> python3 -I host/policy.py).
// Each test has its own policy file, state folder and HOME; nothing touches ~/.config/mina or a running broker.
// GPU discovery uses fixtures (MINA_HOST_NVIDIA_SMI, MINA_HOST_KFD_TOPOLOGY), never this machine's devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, POLICY_PY } from '../bin/mina.mjs';

const MINA = join(REPO, 'bin', 'mina.mjs');

function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mina-host-cli-')));
  const project = join(tmp, 'work', 'proj');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(tmp, 'home'));
  mkdirSync(join(tmp, 'state'));
  const config = join(tmp, 'cfg', 'host.json');
  const env = { PATH: process.env.PATH, HOME: join(tmp, 'home'), MINA_HOST_CONFIG: config, MINA_HOST_STATE: join(tmp, 'state'),
    MINA_HOST_NVIDIA_SMI: join(tmp, 'no-nvidia-smi'), MINA_HOST_KFD_TOPOLOGY: join(tmp, 'no-topology') };
  const mina = (args, { input = '', extraEnv = {}, cwd = project } = {}) => {
    // stdin is a pipe: there is no terminal, as for an agent's command or a script.
    const r = spawnSync(process.execPath, [MINA, 'host', ...args], { cwd, input, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const policy = () => JSON.parse(readFileSync(config, 'utf8'));
  const backups = () => existsSync(join(tmp, 'cfg')) ? readdirSync(join(tmp, 'cfg')).filter((n) => /^host\.json\.bak-2\d{7}T\d{6}Z/.test(n)) : [];
  const change = (name, list) => { const f = join(tmp, name); writeFileSync(f, JSON.stringify(list)); return f; };
  return { tmp, project, config, env, mina, policy, backups, change, done: () => rmSync(tmp, { recursive: true, force: true }) };
}

const register = (project, entry = { classes: { workload: 'ask' } }) => [{ kind: 'project_register', project, entry }];

test('mina host runs host/policy.py with python3 -I; no subcommand is a usage error (exit 2)', () => {
  const t = setup();
  try {
    const src = readFileSync(MINA, 'utf8');
    assert.match(src, /spawnSync\(python, \['-I', POLICY_PY, \.\.\.args\]/);
    assert.equal(POLICY_PY, join(REPO, 'host', 'policy.py'));
    let r = t.mina([]);
    assert.equal(r.code, 2);
    assert.match(r.out, /^usage: mina host discover/);
    r = t.mina(['nope']);
    assert.equal(r.code, 2);
    assert.match(r.out, /invalid choice: 'nope'/);
    r = t.mina(['apply']);
    assert.equal(r.code, 2, 'apply needs FILE');
    r = t.mina(['--help']);
    assert.equal(r.code, 0);
  } finally { t.done(); }
});

test('apply --yes creates host.json (0600, folder 0700) from {"version": 1}; a second apply keeps a 0600 backup', () => {
  const t = setup();
  try {
    let r = t.mina(['apply', t.change('c1.json', register(t.project)), '--yes']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /does not exist yet: this change creates it/);
    assert.match(r.out, /\+ "version": 1/);
    assert.match(r.out, /Backup: none \(the file is new\)/);
    assert.match(r.out, /no restart is necessary/);
    assert.deepEqual(t.policy(), { version: 1, projects: { [t.project]: { classes: { workload: 'ask' } } } });
    assert.equal(statSync(t.config).mode & 0o777, 0o600);
    assert.equal(statSync(join(t.tmp, 'cfg')).mode & 0o777, 0o700);
    const first = readFileSync(t.config);
    // A change without "project" applies to the project of the current folder.
    r = t.mina(['apply', '-', '--yes'], { input: JSON.stringify([{ kind: 'workload_set', name: 'build', workload: { argv: ['{command}'], max_s: 600 } }]) });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /runs any command/, 'risk flags are shown');
    const [bak] = t.backups();
    assert.match(r.out, new RegExp(`Backup: .*${bak}`));
    assert.deepEqual(readFileSync(join(t.tmp, 'cfg', bak)), first);
    assert.equal(statSync(join(t.tmp, 'cfg', bak)).mode & 0o777, 0o600);
    assert.ok(t.policy().projects[t.project].workloads.build);
    const audit = readFileSync(join(t.tmp, 'state', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((a) => [a.op, a.via, a.kinds]), [['policy_change', 'mina host apply', ['project_register']],
      ['policy_change', 'mina host apply', ['workload_set']]]);
  } finally { t.done(); }
});

test('apply without a terminal refuses unless --yes; --dry-run writes nothing; an invalid result is refused', () => {
  const t = setup();
  try {
    const f = t.change('c.json', register(t.project));
    let r = t.mina(['apply', f]);
    assert.equal(r.code, 1);
    assert.match(r.out, /Refused: no terminal to confirm in\. Repeat with --yes/);
    assert.equal(existsSync(t.config), false);
    r = t.mina(['apply', f, '--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.out, /\+ "projects"/);
    assert.match(r.out, /Dry run: nothing was written/);
    assert.equal(existsSync(t.config), false);
    assert.equal(t.mina(['apply', f, '--yes']).code, 0);
    const before = readFileSync(t.config);
    r = t.mina(['apply', t.change('bad.json', [{ kind: 'workload_set', project: t.project, name: 'w', workload: { argv: ['x'], max_s: 0 } }]), '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.out, /error: projects\[".*"\]\.workloads\.w\.max_s: max_s must be a positive integer/);
    assert.match(r.out, /Nothing was written/);
    r = t.mina(['apply', t.change('kind.json', [{ kind: 'nope' }]), '--yes']);
    assert.equal(r.code, 1);
    r = t.mina(['apply', join(t.tmp, 'missing.json'), '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.out, /cannot read/);
    assert.deepEqual(readFileSync(t.config), before);
    assert.deepEqual(t.backups(), []);
  } finally { t.done(); }
});

test('validate: 0 for a good policy (warnings allowed), 1 for errors, invalid JSON or no file; show prints the effective policy', () => {
  const t = setup();
  try {
    let r = t.mina(['validate']);
    assert.equal(r.code, 1);
    assert.match(r.out, /does not exist/);
    mkdirSync(join(t.tmp, 'cfg'));
    writeFileSync(t.config, JSON.stringify({ version: 1, projects: { [t.project]: { classes: { workload: 'ask' }, someday: 1 } } }));
    r = t.mina(['validate']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /warning: projects\[".*"\]\.someday: unknown key/);
    assert.match(r.out, /0 error\(s\), 1 warning\(s\)/);
    r = t.mina(['show']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Project: ${t.project}`));
    assert.match(r.out, /workload=ask/);
    r = t.mina(['show', t.project, '--json']);
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(r.out).policy_source, 'project');
    writeFileSync(t.config, JSON.stringify({ version: 2, projects: { [t.project]: { classes: { workload: 'often' } } } }));
    r = t.mina(['validate']);
    assert.equal(r.code, 1);
    assert.match(r.out, /error: version: must be 1/);
    assert.match(r.out, /error: projects\[".*"\]\.classes\.workload: must be one of/);
    writeFileSync(t.config, '{"version": 1,');
    r = t.mina(['validate']);
    assert.equal(r.code, 1);
    assert.match(r.out, /not valid JSON/);
  } finally { t.done(); }
});

test('discover with fixture GPUs: names, bus IDs, coverage, lock files, lockouts and suggested resources', () => {
  const t = setup();
  try {
    const smi = join(t.tmp, 'nvidia-smi');
    writeFileSync(smi, '#!/bin/sh\nprintf "0, 00000000:01:00.0, NVIDIA Fixture A\\n1, 00000000:02:00.0, NVIDIA Fixture B\\n"\n');
    chmodSync(smi, 0o755);
    const topo = join(t.tmp, 'topology');
    mkdirSync(join(topo, '1'), { recursive: true });
    writeFileSync(join(topo, '1', 'properties'), 'simd_count 192\nlocation_id 768\ndomain 0\n');
    writeFileSync(join(topo, '1', 'name'), 'gfx1100\n');
    const lockFile = join(t.tmp, 'GPU_A.lock'), lockout = join(t.tmp, 'GPU_A.lockout');
    writeFileSync(lockout, '');
    assert.equal(t.mina(['apply', t.change('r.json', [{ kind: 'resource_set', scope: 'machine', name: 'GPU_A',
      resource: { locks: [{ path: lockFile }], lockouts: [lockout], device: { nvidia: ['00000000:01:00.0'] } } }]), '--yes']).code, 0);
    const extraEnv = { MINA_HOST_NVIDIA_SMI: smi, MINA_HOST_KFD_TOPOLOGY: topo };
    const before = readFileSync(t.config);
    let r = t.mina(['discover'], { extraEnv });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nvidia 0 00000000:01:00\.0 NVIDIA Fixture A: covered by machine:GPU_A/);
    assert.match(r.out, /nvidia 1 00000000:02:00\.0 NVIDIA Fixture B: NOT covered by a resource/);
    assert.match(r.out, /amd .* 0000:03:00\.0 gfx1100: NOT covered/);
    assert.match(r.out, new RegExp(`${lockFile} \\(machine:GPU_A exclusive\\): not created yet`));
    assert.match(r.out, new RegExp(`${lockout} \\(machine:GPU_A\\): EXISTS`));
    assert.match(r.out, /Suggested resources/);
    r = t.mina(['discover', '--json'], { extraEnv });
    const inv = JSON.parse(r.out);
    assert.deepEqual(inv.devices.map((d) => d.bus_id).sort(), ['00000000:01:00.0', '00000000:02:00.0', '0000:03:00.0']);
    assert.deepEqual(inv.suggestions.map((s) => [s.kind, s.scope, s.resource.device]),
      [['resource_set', 'machine', { nvidia: ['00000000:02:00.0'] }], ['resource_set', 'machine', { kfd: true }]].slice(0, inv.suggestions.length));
    assert.deepEqual(readFileSync(t.config), before, 'discover is read-only');
    // The suggestions are a valid change list for apply.
    assert.equal(t.mina(['apply', t.change('s.json', inv.suggestions), '--dry-run']).code, 0);
    r = t.mina(['discover']);
    assert.equal(r.code, 0);
    assert.match(r.out, /GPUs: none found/);
  } finally { t.done(); }
});

test('edit: $VISUAL/$EDITOR edits a copy; the result is validated, shown and written only with consent', () => {
  const t = setup();
  try {
    assert.equal(t.mina(['apply', t.change('c.json', register(t.project)), '--yes']).code, 0);
    // An "editor" that adds a workload to the copy it gets.
    const editor = join(t.tmp, 'editor.mjs');
    writeFileSync(editor, `import { readFileSync, writeFileSync } from 'node:fs';
const f = process.argv[2], c = JSON.parse(readFileSync(f, 'utf8'));
if (process.env.EDIT_MODE === 'broken') writeFileSync(f, '{"version": 1,');
else if (process.env.EDIT_MODE === 'invalid') writeFileSync(f, JSON.stringify({ ...c, version: 3 }));
else if (process.env.EDIT_MODE === 'fail') process.exit(4);
else { c.projects[${JSON.stringify(t.project)}].workloads = { t: { argv: ['/usr/bin/true'], max_s: 5 } }; writeFileSync(f, JSON.stringify(c)); }
`);
    const EDITOR = `${process.execPath} ${editor}`;
    const before = readFileSync(t.config);
    let r = t.mina(['edit'], { extraEnv: { EDITOR } });
    assert.equal(r.code, 1, 'no terminal: refused without --yes');
    assert.match(r.out, /\+ "workloads": \{"t": \{"argv": \["\/usr\/bin\/true"\], "max_s": 5\}\}/);
    assert.match(r.out, /runs without the broker's sandbox/);
    assert.deepEqual(readFileSync(t.config), before);
    for (const mode of ['broken', 'invalid', 'fail']) {
      r = t.mina(['edit', '--yes'], { extraEnv: { EDITOR, EDIT_MODE: mode } });
      assert.equal(r.code, 1, mode);
      assert.match(r.out, /Nothing was written/);
      assert.deepEqual(readFileSync(t.config), before, mode);
    }
    r = t.mina(['edit', '--yes'], { extraEnv: { VISUAL: EDITOR, EDITOR: '/bin/false' } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no restart is necessary/);
    assert.deepEqual(t.policy().projects[t.project].workloads, { t: { argv: ['/usr/bin/true'], max_s: 5 } });
    assert.equal(t.backups().length, 1);
    // Someone else changes host.json while the editor is open: the edit is refused (the SHA is fixed at the start).
    writeFileSync(editor, `import { readFileSync, writeFileSync } from 'node:fs';
const f = process.argv[2], c = JSON.parse(readFileSync(f, 'utf8'));
const cfg = ${JSON.stringify(t.config)}, other = JSON.parse(readFileSync(cfg, 'utf8'));
writeFileSync(cfg, JSON.stringify({ ...other, alarm_external_after_s: 30 }));
c.alarm_external_after_s = 60; writeFileSync(f, JSON.stringify(c));
`);
    r = t.mina(['edit', '--yes'], { extraEnv: { EDITOR } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /changed/);
    assert.equal(t.policy().alarm_external_after_s, 30, 'the other change stays');
  } finally { t.done(); }
});
