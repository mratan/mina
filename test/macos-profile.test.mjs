// macOS: the Seatbelt profiles themselves (sandbox/macos/profile.mjs), run with sandbox-exec. Each test is the macOS
// form of a Linux guarantee in docs/sandbox.md (the probe scripts/macos-probe.py tested the rules first). Skipped elsewhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { outerProfile, sandboxExecArgs, serviceProfile, workerProfile } from '../sandbox/macos/profile.mjs';
import { workerRoots } from '../sandbox/sandbox.mjs';

const skip = process.platform !== 'darwin' ? 'macOS only' : false;
let root, project, data, outside, home, tmp, n = 0;
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(homedir(), '.mina-test-profile-')));
  for (const d of ['project', 'data', 'outside', 'home', 'tmp', 'profiles']) mkdirSync(join(root, d));
  [project, data, outside, home, tmp] = ['project', 'data', 'outside', 'home', 'tmp'].map((d) => join(root, d));
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  writeFileSync(join(data, 'table.tsv'), 'a\t1\n');
});
after(() => { if (!skip) rmSync(root, { recursive: true, force: true }); });

// Runs bash under a profile; returns { status, stdout, stderr }.
function run(profile, script, { env = {}, input } = {}) {
  const file = join(root, 'profiles', `${++n}.sb`);
  writeFileSync(file, profile.text);
  const [cmd, ...args] = sandboxExecArgs(file, profile.params, ['/bin/bash', '--noprofile', '--norc', '-c', script]);
  return spawnSync(cmd, args, { cwd: project, encoding: 'utf8', timeout: 30_000, input,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: `${tmp}/`, ...env } });
}
const worker = (extra = {}) => workerProfile(workerRoots({ cwd: project, project, writable: [project], readable: [data], hidden: [], exposed: [], readOnly: [], env: {} }),
  { home, tmp, ...extra });

test('worker: the roots, and nothing else, also not through a symlink or a hard link', { skip }, () => {
  const r = run(worker(), `cat ${join(outside, 'secret.txt')} 2>/dev/null; echo "outside=$?"
cat data-link/table.tsv >/dev/null 2>&1; echo "data-link=$?"
cat ${join(data, 'table.tsv')} >/dev/null; echo "data=$?"
echo x > ${join(data, 'new')} 2>/dev/null; echo "data-write=$?"
ln ${join(data, 'table.tsv')} hard 2>/dev/null; echo "hardlink=$?"
ls ~/.. >/dev/null 2>&1; echo "home-listing=$?"
ls ${homedir()}/.ssh >/dev/null 2>&1; echo "ssh=$?"
echo ok > own.txt; echo "project-write=$?"
mv ${project} ${project}-moved 2>/dev/null; echo "rename-root=$?"`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /outside=1\n/); assert.match(r.stdout, /data=0\n/); assert.match(r.stdout, /data-write=1\n/);
  assert.match(r.stdout, /hardlink=1\n/); assert.match(r.stdout, /home-listing=1\n/); assert.match(r.stdout, /ssh=1\n/);
  assert.match(r.stdout, /project-write=0\n/); assert.match(r.stdout, /rename-root=1\n/);
  assert.equal(existsSync(join(project, 'hard')), false);
});

test('worker: no DNS, no host loopback, no listening port, and no network at all when offline', { skip }, async () => {
  const server = createServer((s) => s.end('host'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const probe = `/usr/bin/perl -MIO::Socket::INET -e '
my $c = IO::Socket::INET->new(PeerAddr => "127.0.0.1", PeerPort => ${port}, Timeout => 2); print "loopback=", ($c ? "connected" : "refused"), "\\n";
my $l = IO::Socket::INET->new(LocalAddr => "0.0.0.0", LocalPort => 0, Listen => 1); print "listen=", ($l ? "listening" : "refused"), "\\n";
my @a = gethostbyname("example.com"); print "dns=", (@a ? "resolved" : "none"), "\\n";'`;
    for (const profile of [worker(), worker({ network: 'open', egressPort: 9 })]) {
      const r = run(profile, probe);
      assert.match(r.stdout, /loopback=refused/); assert.match(r.stdout, /listen=refused/); assert.match(r.stdout, /dns=none/);
    }
  } finally { server.close(); }
});

test('worker: the known macOS escapes are closed: open, launchctl submit, the pasteboard, the Keychain, crontab, other processes', { skip }, () => {
  const sleeper = spawn('/bin/sleep', ['30']);
  try {
    const r = run(worker(), `/usr/bin/open -a Calculator 2>/dev/null; echo "open=$?"
/bin/launchctl submit -l com.mina.test.escape -- /usr/bin/touch ${join(project, 'escaped')} 2>/dev/null; echo "submit=$?"
/usr/bin/pbpaste >/dev/null 2>&1; echo "pasteboard=$?"
/usr/bin/security list-keychains >/dev/null 2>&1; echo "keychain=$?"
/usr/bin/crontab -l >/dev/null 2>&1; echo "crontab=$?"
kill -0 ${sleeper.pid} 2>/dev/null; echo "signal=$?"`);
    for (const k of ['open', 'submit', 'pasteboard', 'keychain', 'crontab', 'signal']) assert.doesNotMatch(r.stdout, new RegExp(`${k}=0\\n`), `${k}: ${r.stdout}`);
    assert.equal(existsSync(join(project, 'escaped')), false);
  } finally { sleeper.kill(); spawnSync('/bin/launchctl', ['remove', 'com.mina.test.escape']); }
});

test('worker: no GPU device (Metal)', { skip: skip || (!existsSync('/usr/bin/swiftc') && !existsSync('/Library/Developer/CommandLineTools/usr/bin/swiftc') ? 'needs swiftc' : false) }, () => {
  const src = join(root, 'metal.swift'), bin = join(project, 'metal');
  writeFileSync(src, 'import Metal\nprint(MTLCreateSystemDefaultDevice() == nil ? "no-device" : "device")\n');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-o', bin, src], { encoding: 'utf8', timeout: 180_000 });
  if (built.status !== 0) return;                                        // no Metal SDK: nothing to test
  assert.equal(spawnSync(bin, { encoding: 'utf8' }).stdout.trim(), 'device', 'outside the sandbox there is a device');
  assert.equal(run(worker(), bin).stdout.trim(), 'no-device');
});

test('outer layer (Pi): writes only to the roots of the launch; the host policy stays read-only; /tmp and the user temporary folder are private', { skip }, () => {
  const tmpSecret = mkdtempSync('/private/tmp/mina-outer-');
  writeFileSync(join(tmpSecret, 'x'), 'host tmp');
  const policy = join(homedir(), '.config', 'mina');
  try {
    const profile = outerProfile({ writable: [project], tmp, hiddenDirs: ['/private/tmp'], sockets: [] });
    let probe = policy; while (!existsSync(probe)) probe = join(probe, '..');
    const r = run(profile, `echo ok > ${join(project, 'pi.txt')}; echo "project=$?"
echo x > ${join(outside, 'pi.txt')} 2>/dev/null; echo "outside=$?"
test -w ${realpathSync(probe)}; echo "policy-writable=$?"
cat ${join(outside, 'secret.txt')} >/dev/null; echo "read-home=$?"
cat ${join(tmpSecret, 'x')} >/dev/null 2>&1; echo "host-tmp=$?"
echo x > "$TMPDIR/pi-tmp" && echo "own-tmp=0"`);
    assert.match(r.stdout, /project=0\n/); assert.match(r.stdout, /outside=1\n/);
    assert.match(r.stdout, /read-home=0\n/, 'Pi reads the host, as the read-only root of the outer bwrap layer');
    assert.match(r.stdout, /host-tmp=1\n/); assert.match(r.stdout, /own-tmp=0/);
    assert.doesNotMatch(r.stdout, /policy-writable=0/, 'the host policy folder is not writable for Pi');
  } finally { rmSync(tmpSecret, { recursive: true, force: true }); }
});

test('outer layer (Pi): DNS works, only the named Unix sockets are reachable, no pasteboard, no launchctl', { skip }, async () => {
  const allowed = join(root, 'allowed.sock'), other = join(root, 'other.sock');
  const servers = [allowed, other].map((p) => createServer((s) => s.end('hi')).listen(p));
  await Promise.all(servers.map((s) => new Promise((r) => s.once('listening', r))));
  try {
    const profile = outerProfile({ writable: [project], tmp, sockets: [allowed] });
    const connect = (p) => `/usr/bin/perl -MIO::Socket::UNIX -e 'print IO::Socket::UNIX->new(Peer => "${p}") ? "connected" : "refused"'`;
    const r = run(profile, `echo "allowed=$(${connect(allowed)})"; echo "other=$(${connect(other)})"
/usr/bin/perl -e 'my @a = gethostbyname("example.com"); print "dns=", (@a ? "resolved" : "none"), "\\n"'
/usr/bin/pbpaste >/dev/null 2>&1; echo "pasteboard=$?"
/bin/launchctl list >/dev/null 2>&1; echo "launchctl=$?"`);
    assert.match(r.stdout, /allowed=connected/); assert.match(r.stdout, /other=refused/);
    assert.match(r.stdout, /dns=resolved/); assert.doesNotMatch(r.stdout, /pasteboard=0/);
    assert.doesNotMatch(r.stdout, /launchctl=0/, 'Pi does not control launchd jobs (on Linux the user bus is hidden)');
  } finally { for (const s of servers) s.close(); }
});

test('service (MCP server, PDF converter): its reads, its home, and one proxy port', { skip }, () => {
  const profile = serviceProfile({ reads: [data], writes: [home], egressPort: 9 });
  const r = run(profile, `cat ${join(data, 'table.tsv')} >/dev/null; echo "data=$?"
echo x > ${join(home, 'state')}; echo "home=$?"
cat ${join(outside, 'secret.txt')} >/dev/null 2>&1; echo "outside=$?"
echo x > ${join(project, 'x')} 2>/dev/null; echo "project=$?"`);
  assert.match(r.stdout, /data=0\n/); assert.match(r.stdout, /home=0\n/); assert.match(r.stdout, /outside=1\n/); assert.match(r.stdout, /project=1\n/);
});

