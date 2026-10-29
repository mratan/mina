import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, linkSync, existsSync, rmSync, mkdirSync, lstatSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createEgressProxy } from '../lib/egress-proxy.mjs';
import { runFileOperation, runWorker } from '../sandbox/worker-client.mjs';
import { createSandboxTools } from '../extensions/sandbox/tools.mjs';
import { validateWritableRoots } from '../sandbox/sandbox.mjs';
import { needsSandbox } from './capabilities.mjs';
const fixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mina-worker-'));
  return { cwd, env: { MINA_SANDBOX_PROJECT: cwd, MINA_SANDBOX_WRITE: JSON.stringify([cwd]), MINA_SANDBOX_NET: 'offline' } };
};

test('real worker reads and writes project bytes without exposing unrelated files', { skip: needsSandbox }, async () => {
  const f = fixture();
  const secret = join(mkdtempSync(join(tmpdir(), 'mina-secret-')), 'unknown-name');
  writeFileSync(secret, 'not-for-the-agent');
  try {
    await runFileOperation('write', { path: join(f.cwd, 'image.png'), data: 'iVBORw0KGgo=' }, f);
    assert.equal((await runFileOperation('read', { path: join(f.cwd, 'image.png') }, f)).toString('base64'), 'iVBORw0KGgo=');
    await assert.rejects(runFileOperation('read', { path: secret }, f));
    await assert.rejects(runFileOperation('write', { path: secret, data: 'dGFtcGVy' }, f));
    assert.equal(readFileSync(secret, 'utf8'), 'not-for-the-agent');
  } finally { rmSync(f.cwd, { recursive: true }); rmSync(join(secret, '..'), { recursive: true }); }
});

test('worker cannot signal a separate disposable same-user process or inherit arbitrary secrets', { skip: needsSandbox }, async () => {
  const f = fixture();
  const victim = spawn('/bin/sleep', ['30']);
  const closed = new Promise((done) => victim.on('close', done));
  try {
    const out = await runWorker(['/bin/bash', '-c', `kill -KILL ${victim.pid} 2>/dev/null; printf '%s' "\${ODDLY_NAMED_VALUE:-}"`], {
      ...f, env: { ...f.env, ODDLY_NAMED_VALUE: 'private-canary' }, timeout: 3,
    });
    assert.equal(out.stdout.toString(), '');
    assert.equal(victim.exitCode, null);
    assert.equal(victim.signalCode, null);
    process.kill(victim.pid, 0);
    const devices = await runWorker(['/bin/bash', '-c', `test ! -e /dev/kfd && test ! -e /dev/nvidia0 && test ! -e /sys/fs/cgroup && test ! -e /proc/${process.pid}/environ`], f);
    assert.equal(devices.exitCode, 0, devices.stderr.toString());
  } finally { victim.kill('SIGKILL'); await closed; rmSync(f.cwd, { recursive: true }); }
});

test('startup rejects a pre-existing hardlink, and a readonly data mount cannot import an outside inode', { skip: needsSandbox }, async () => {
  const f = fixture(), data = mkdtempSync(join(tmpdir(), 'mina-worker-data-'));
  writeFileSync(join(data, 'source'), 'unchanged');
  linkSync(join(data, 'source'), join(f.cwd, 'alias'));
  try {
    assert.throws(() => validateWritableRoots([f.cwd]), /hardlink/);
    rmSync(join(f.cwd, 'alias'));
    validateWritableRoots([f.cwd]);
    const out = await runWorker(['/bin/bash', '-c', `ln '${data}/source' '${f.cwd}/alias' && printf changed > '${f.cwd}/alias'`], {
      ...f, env: { ...f.env, MINA_SANDBOX_READ: JSON.stringify([data]) },
    });
    assert.notEqual(out.exitCode, 0);
    assert.equal(readFileSync(join(data, 'source'), 'utf8'), 'unchanged');
  } finally { rmSync(f.cwd, { recursive: true }); rmSync(data, { recursive: true }); }
});

// A `git clone` from a local path hard-links .git/objects to the source repository. The preflight refuses the clone
// (the agent could rewrite a shared object) and says how to repair it; `mina sandbox unlink-git-objects` repairs it.
const MINA = join(import.meta.dirname, '..', 'bin', 'mina.mjs');
const noGit = spawnSync('git', ['--version']).status === 0 ? false : 'git is not installed';
const GIT_ENV = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const objectFiles = (repo) => readdirSync(join(repo, '.git', 'objects'), { recursive: true })
  .map((r) => join(repo, '.git', 'objects', r)).filter((p) => lstatSync(p).isFile());
const fileState = (p) => { const st = lstatSync(p); return { ino: st.ino, nlink: st.nlink, mode: st.mode, sha: createHash('sha256').update(readFileSync(p)).digest('hex') }; };
const unlinkCmd = (...args) => spawnSync(process.execPath, [MINA, 'sandbox', 'unlink-git-objects', ...args], { encoding: 'utf8' });
// A source repository with a pack (40 files, then git gc) and 30 more loose objects; then a local clone on a new branch.
function localClone() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mina-clone-')));
  const src = join(base, 'src'), dest = join(base, 'dest');
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  for (let i = 0; i < 40; i++) writeFileSync(join(src, `a${i}.txt`), `packed ${i}\n`);
  git(src, 'add', '.'); git(src, 'commit', '-q', '-m', 'packed'); git(src, 'gc', '-q');
  for (let i = 0; i < 28; i++) writeFileSync(join(src, `b${i}.txt`), `loose ${i}\n`);
  git(src, 'add', '.'); git(src, 'commit', '-q', '-m', 'loose');
  git(base, 'clone', '-q', src, dest);
  git(dest, 'checkout', '-q', '-b', 'feature');
  return { base, src, dest, linked: objectFiles(dest).filter((p) => lstatSync(p).nlink > 1) };
}
const NO_LINKS = 'this filesystem gave the local clone no hard links (git copies instead), so there is nothing to test';

test('a local git clone: the preflight names the cause and both fixes, with a bounded list of examples', { skip: noGit }, (t) => {
  const f = localClone();
  try {
    if (!f.linked.length) return t.skip(NO_LINKS);
    assert.ok(f.linked.length > 20, `expected many linked objects, got ${f.linked.length}`);
    assert.ok(f.linked.some((p) => p.includes('/pack/')) && f.linked.some((p) => /\/objects\/[0-9a-f]{2}\//.test(p)));
    let message = '';
    assert.throws(() => validateWritableRoots([f.dest]), (e) => { message = e.message; return true; });
    assert.match(message, /^mina sandbox: writable hardlink: \d+ files/);
    assert.match(message, new RegExp(`${f.linked.length} files`));
    assert.match(message, /All of them are git objects in .*\/dest\/\.git\/objects\. This is almost certainly a `git clone` from a local path/);
    assert.ok(message.includes(`  mina sandbox unlink-git-objects ${f.dest}\n`), message);
    assert.ok(message.includes('  git clone --no-hardlinks <source> <destination>'), message);
    assert.ok(message.includes(`  ... and ${f.linked.length - 5} more`), message);
    assert.equal(message.split('\n').filter((l) => / \(nlink=\d+\)$/.test(l)).length, 5);
    assert.ok(message.split('\n').length <= 16, message);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('mina sandbox unlink-git-objects repairs a local clone; the source repository keeps its objects', { skip: noGit }, (t) => {
  const f = localClone();
  try {
    if (!f.linked.length) return t.skip(NO_LINKS);
    const head = git(f.dest, 'rev-parse', 'HEAD'), branch = git(f.dest, 'symbolic-ref', 'HEAD');
    const srcBefore = new Map(objectFiles(f.src).map((p) => [p, fileState(p)]));
    const destBefore = new Map(f.linked.map((p) => [p, fileState(p)]));
    const dry = unlinkCmd('--dry-run', f.dest);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, new RegExp(`would replace with own copies: ${f.linked.length}\n`));
    for (const [p, st] of destBefore) assert.deepEqual(fileState(p), st);
    const run = unlinkCmd(f.dest);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`replaced with own copies: ${f.linked.length}\n  skipped \\(only one link at the time of the copy\\): 0\n  refused \\(not changed\\): 0\n  failed: 0`));
    assert.deepEqual(objectFiles(f.dest).filter((p) => lstatSync(p).nlink > 1), []);
    for (const [p, st] of destBefore) {
      const now = fileState(p);
      assert.notEqual(now.ino, st.ino);
      assert.deepEqual({ sha: now.sha, mode: now.mode, nlink: now.nlink }, { sha: st.sha, mode: st.mode, nlink: 1 });
    }
    assert.ok(validateWritableRoots([f.dest]));
    for (const repo of [f.dest, f.src]) assert.equal(git(repo, 'fsck', '--full', '--strict'), '');
    assert.equal(git(f.dest, 'rev-parse', 'HEAD'), head);
    assert.equal(git(f.dest, 'symbolic-ref', 'HEAD'), branch);
    for (const [p, st] of srcBefore) {
      const now = fileState(p);
      assert.deepEqual({ ino: now.ino, sha: now.sha }, { ino: st.ino, sha: st.sha });
      assert.equal(now.nlink, st.nlink > 1 ? st.nlink - 1 : st.nlink, p);
    }
    const again = unlinkCmd(f.dest);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /replaced with own copies: 0\n/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a hard link that is not a git object is reported, not repaired', { skip: noGit }, (t) => {
  const f = localClone(), data = join(f.base, 'outside.bin');
  writeFileSync(data, 'outside data');
  linkSync(data, join(f.dest, 'data.bin'));
  try {
    if (!f.linked.length) return t.skip(NO_LINKS);
    assert.throws(() => validateWritableRoots([f.dest]), (e) => {
      assert.match(e.message, new RegExp(`${f.linked.length} of them are git objects in .*, probably from a \`git clone\` from a local path\\. The other 1 are not git objects\\.`));
      assert.match(e.message, /Examples:\n  .*\/dest\/data\.bin \(nlink=2\)/);
      assert.ok(e.message.includes(`mina sandbox unlink-git-objects ${f.dest}`) && e.message.includes('git clone --no-hardlinks'));
      assert.match(e.message, /For the files that are not git objects: remove them, or give each file its own copy/);
      return true;
    });
    const before = [fileState(data), fileState(join(f.dest, 'data.bin'))];
    const run = unlinkCmd(f.dest);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /1 other hard-linked file in .* did not change\. This command repairs only .*\/\.git\/objects\./);
    assert.match(run.stdout, /\/dest\/data\.bin \(nlink=2\)/);
    assert.deepEqual([fileState(data), fileState(join(f.dest, 'data.bin'))], before);
    assert.deepEqual(objectFiles(f.dest).filter((p) => lstatSync(p).nlink > 1), []);
    assert.throws(() => validateWritableRoots([f.dest]), /writable hardlink: 1 file in the writable folders has/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('unlink-git-objects refuses a symlinked or gitfile .git and does not follow symlinks in .git/objects', { skip: noGit }, (t) => {
  const f = localClone();
  try {
    if (!f.linked.length) return t.skip(NO_LINKS);
    const before = new Map(f.linked.map((p) => [p, fileState(p)]));
    const viaLink = join(f.base, 'via-link'), viaFile = join(f.base, 'via-file');
    mkdirSync(viaLink); symlinkSync(join(f.dest, '.git'), join(viaLink, '.git'));
    mkdirSync(viaFile); writeFileSync(join(viaFile, '.git'), `gitdir: ${join(f.dest, '.git')}\n`);
    const a = unlinkCmd(viaLink), b = unlinkCmd(viaFile), c = unlinkCmd(join(f.dest, 'missing'));
    assert.equal(a.status, 1); assert.match(a.stderr, /\.git is a symbolic link\. Mina repairs only a \.git that is a real directory/);
    assert.equal(b.status, 1); assert.match(b.stderr, /\.git is a file \(the \.git of a git worktree or a submodule\)/);
    assert.equal(c.status, 1);
    for (const [p, st] of before) assert.deepEqual(fileState(p), st);
    // Symbolic links inside .git/objects, to a file and to a folder outside the tree, each with a second link.
    const outside = join(f.base, 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, 'target'), 'outside'); linkSync(join(outside, 'target'), join(outside, 'target-2'));
    symlinkSync(join(outside, 'target'), join(f.dest, '.git', 'objects', 'file-link'));
    symlinkSync(outside, join(f.dest, '.git', 'objects', 'dir-link'));
    const outsideBefore = [fileState(join(outside, 'target')), fileState(join(outside, 'target-2'))];
    const run = unlinkCmd(f.dest);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /refused \(not changed\): 2\n/);
    assert.match(run.stdout, /objects\/file-link: a symbolic link \(not followed\)/);
    assert.match(run.stdout, /objects\/dir-link: a symbolic link \(not followed\)/);
    assert.deepEqual([fileState(join(outside, 'target')), fileState(join(outside, 'target-2'))], outsideBefore);
    assert.equal(lstatSync(join(f.dest, '.git', 'objects', 'file-link')).isSymbolicLink(), true);
    assert.equal(lstatSync(join(f.dest, '.git', 'objects', 'dir-link')).isSymbolicLink(), true);
    assert.equal(spawnSync(process.execPath, [MINA, 'sandbox', 'unlink-git-objects'], { encoding: 'utf8' }).status, 2);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

// Git data from elsewhere: a `git clone --shared` (objects/info/alternates) or a git worktree (a .git file). If the
// sandbox does not show that data, git in the sandbox fails ("bad object HEAD"), so the preflight refuses with the fixes.
test('a --shared clone whose source the sandbox does not show is refused with the fixes; each fix works', { skip: noGit }, async () => {
  const f = localClone(), shared = join(f.base, 'shared'), srcObjects = join(f.src, '.git', 'objects');
  git(f.base, 'clone', '-q', '--shared', f.src, shared);
  const alternates = join(shared, '.git', 'objects', 'info', 'alternates');
  try {
    let message = '';
    assert.throws(() => validateWritableRoots([shared]), (e) => { message = e.message; return true; });
    assert.match(message, /^mina sandbox: git will fail in the sandbox: .* Mina does not start\./);
    assert.ok(message.includes(`  ${alternates} borrows objects from ${srcObjects}\n`), message);
    assert.match(message, /`git clone --shared` or `--reference`.*"bad object HEAD"/);
    assert.ok(message.includes(`add --sandbox-read ${srcObjects}\n`), message);
    assert.ok(message.includes(`    git --git-dir=${join(shared, '.git')} repack -a -d && rm ${alternates}`), message);
    // Fix 1: show the borrowed objects read-only. The preflight accepts, and git works in a real sandbox.
    assert.ok(validateWritableRoots([shared], { readable: [srcObjects] }));
    assert.throws(() => validateWritableRoots([shared], { readable: [f.src], hidden: [f.src] }), /git will fail in the sandbox/);
    if (!needsSandbox) {
      const env = { MINA_SANDBOX_PROJECT: shared, MINA_SANDBOX_WRITE: JSON.stringify([shared]), MINA_SANDBOX_NET: 'offline' };
      const cmd = ['/bin/bash', '-c', `git -C '${shared}' cat-file -t HEAD 2>&1`];
      assert.match((await runWorker(cmd, { cwd: shared, env })).stdout.toString(), /bad object|unable to normalize|not a valid/);
      const out = await runWorker(cmd, { cwd: shared, env: { ...env, MINA_SANDBOX_READ: JSON.stringify([srcObjects]) } });
      assert.equal(out.stdout.toString().trim(), 'commit', out.stderr.toString());
    }
    // Fix 2: the printed repack command. The clone then has its own objects.
    execFileSync('/bin/sh', ['-c', message.split('\n').find((l) => l.includes('repack -a -d')).trim()], { env: GIT_ENV });
    assert.ok(validateWritableRoots([shared]));
    assert.equal(git(shared, 'fsck', '--full', '--strict'), '');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a git worktree whose git data the sandbox does not show is refused; a missing target is not', { skip: noGit }, () => {
  const f = localClone(), wt = join(f.base, 'wt');
  git(f.src, 'worktree', 'add', '-q', '-b', 'side', wt);
  try {
    let message = '';
    assert.throws(() => validateWritableRoots([wt]), (e) => { message = e.message; return true; });
    assert.ok(message.includes(`  ${join(wt, '.git')} points to ${join(f.src, '.git', 'worktrees', 'wt')}\n`), message);
    assert.match(message, /This folder is a git worktree \(or a submodule\).*"not a git repository"/);
    assert.ok(message.includes(`  Use a separate clone: git clone --no-hardlinks ${f.src} <destination>`), message);
    assert.ok(message.includes(`  Or show the git data: --sandbox-read ${join(f.src, '.git')} (git can read, but not stage or commit),`), message);
    assert.equal(message.split('\n').filter((l) => l.includes(' points to ')).length, 1);
    assert.ok(validateWritableRoots([wt], { readable: [join(f.src, '.git')] }));
    // A link whose target is gone: git fails outside the sandbox too, so the preflight does not report it.
    writeFileSync(join(wt, '.git'), `gitdir: ${join(f.base, 'gone')}\n`);
    assert.ok(validateWritableRoots([wt]));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('host sockets are refused by preflight and detached descendants do not keep a worker alive', { skip: needsSandbox }, async () => {
  const f = fixture(), server = createServer();
  try {
    await new Promise((done) => server.listen(join(f.cwd, 'host.sock'), done));
    assert.throws(() => validateWritableRoots([f.cwd]), /Unix socket/);
    await new Promise((done) => server.close(done));
    const started = Date.now();
    const out = await runWorker(['/bin/bash', '-c', 'sleep 30 & printf finished'], { ...f, timeout: 3 });
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout.toString(), 'finished');
    assert.ok(Date.now() - started < 2500, 'background descendants must die with the PID namespace');
  } finally { server.close(); rmSync(f.cwd, { recursive: true }); }
});

test('open networking still cannot dial a host loopback service directly', { skip: needsSandbox }, async () => {
  const f = fixture(), server = createServer((socket) => socket.end('host-visible'));
  const proxy = createEgressProxy({ level: 'open' });
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    await proxy.start();
    const script = `const s=require('net').connect(${server.address().port},'127.0.0.1'); s.on('connect',()=>{console.log('ESCAPED');s.destroy()});s.on('error',()=>console.log('blocked'))`;
    const out = await runWorker(['/run/mina-node', '-e', script], { ...f, network: 'open', egressSocket: proxy.socketPath, timeout: 3 });
    assert.equal(out.exitCode, 0, out.stderr.toString());
    assert.equal(out.stdout.toString().trim(), 'blocked');
  } finally { await proxy.close(); await new Promise((done) => server.close(done)); rmSync(f.cwd, { recursive: true }); }
});

test('the network bridge adds no Node proxy-agent warning to a sandboxed command (Node 22)', { skip: needsSandbox }, async () => {
  const f = fixture(), proxy = createEgressProxy({ level: 'open' });
  try {
    await proxy.start();
    const out = await runWorker(['/bin/bash', '-c', 'printf quiet'], { ...f, network: 'open', egressSocket: proxy.socketPath, timeout: 5 });
    assert.equal(out.exitCode, 0, out.stderr.toString());
    assert.equal(out.stdout.toString(), 'quiet');
    assert.doesNotMatch(out.stderr.toString(), /EnvHttpProxyAgent|UNDICI-EHPA/);
  } finally { await proxy.close(); rmSync(f.cwd, { recursive: true }); }
});

test('the real read tool preserves image bytes through worker operations', { skip: needsSandbox }, async () => {
  const f = fixture();
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  writeFileSync(join(f.cwd, 'pixel.png'), bytes);
  try {
    const read = createSandboxTools(f).find((t) => t.name === 'read');
    const out = await read.execute('image', { path: 'pixel.png' });
    assert.ok(out.content.some((c) => c.type === 'image' && c.mimeType === 'image/png'));
  } finally { rmSync(f.cwd, { recursive: true }); }
});

test('truncated model bash output remains readable from a later worker and persists outside temporary storage', { skip: needsSandbox }, async () => {
  const f = fixture(), outputs = mkdtempSync(join(tmpdir(), 'mina-command-output-'));
  f.env.MINA_WORKER_OUTPUTS = outputs;
  try {
    const bash = createSandboxTools(f).find((t) => t.name === 'bash');
    const out = await bash.execute('large', { command: "head -c 60000 /dev/zero | tr '\\0' x; printf '\\nTHE_END'" });
    assert.ok(out.details.fullOutputPath);
    const bytes = await runFileOperation('read', { path: out.details.fullOutputPath }, f);
    assert.ok(bytes.toString().endsWith('THE_END'));
    assert.ok(out.details.retainedOutput.startsWith(outputs));
    assert.equal(readFileSync(out.details.retainedOutput).length, bytes.length);
  } finally { rmSync(f.cwd, { recursive: true }); rmSync(outputs, { recursive: true }); }
});
