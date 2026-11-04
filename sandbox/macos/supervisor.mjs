#!/usr/bin/env node
// The supervisor of one Mina instance on macOS (docs/macos.md, "Linux parity design"). The instance job runs it:
// launchd starts build/macos/mina-instance, which takes the user's terminal and starts this process in the instance's
// coalition. The supervisor does what bwrap and the systemd scope do on Linux:
// - It starts Pi under the outer Seatbelt profile (the outer bwrap layer of Linux).
// - It runs each sandboxed call that Pi (or a child of Pi) requests: a relay (mina-instance relay) sends the request on
//   the supervisor's socket; the supervisor builds the Seatbelt profile from the request, refuses a write root that is
//   not a root of the launch (on Linux the mounts of the outer layer are fixed), and runs the call as a launchd job with
//   its own coalition. When the call's main process exits, mina-instance stops every other process of that coalition, as
//   the end of a PID namespace does on Linux.
// - It passes the signals of the terminal on to Pi, and exits with Pi's exit status.
// Usage: node supervisor.mjs SPEC_FILE (the launcher writes the file; this process reads it and deletes it).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { constants } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerRoots } from '../sandbox.mjs';
import { HELPER, bootout, bootstrap, callLabelPrefix, coalitionOf, members, plist, sweep } from './launchd.mjs';
import { SAMPLE_MS, cpuDelta, decide, infrastructure } from './watchdog.mjs';
import { nodeRuntime, outerProfile, sandboxExecArgs, serviceProfile, visiblePath, workerProfile } from './profile.mjs';
import { decodeFrames, encodeFrame } from './frames.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILE_WORKER = join(REPO, 'sandbox', 'worker.mjs');
// ps, pgrep and pkill for workers (sandbox/macos/mina-ps.c): first in a worker's PATH.
export const WORKER_TOOLS = join(REPO, 'build', 'macos', 'bin');
const SPARES = 2;
const HELLO_MS = 20_000;
const contains = (root, p) => root === p || p.startsWith(root === '/' ? '/' : `${root}/`);
const canonical = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

// Why a write root is refused (null = allowed): it must be inside a root of the launch.
export function writeRefusal(writes, allowed) {
  const bad = writes.find((w) => !allowed.some((a) => contains(a, w)));
  return bad ? `mina sandbox: ${bad} is not a writable root of this launch` : null;
}

// The hashes of a .mina/checks folder, keyed as extensions/goal/check-files.mjs keys them ('.mina/checks/NAME'); bytecode
// is left out. `unsafe` names a symlink, a special file, or a file with more than one hard link: such a folder does not run.
export function checkHashes(checks) {
  const base = dirname(dirname(checks)), hashes = {};
  let unsafe = null;
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir).sort(); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      if (name === '__pycache__' || name.endsWith('.pyc')) continue;
      const p = join(dir, name), st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.nlink === 1) hashes[relative(base, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
      else unsafe ??= p;
    }
  };
  walk(checks);
  return { hashes, unsafe };
}
const differ = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].some((k) => a[k] !== b[k]);

// Moves an entry to another folder, also across volumes.
function moveEntry(from, to) {
  try { renameSync(from, to); } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

// The arguments frame for mina-instance call: CWD\0ARGC\0ARGV...\0ENV...\0
export function argumentsFrame(cwd, argv, env) {
  const parts = [cwd, String(argv.length), ...argv, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  for (const p of parts) if (p.includes('\0')) throw new Error('mina sandbox: an argument or variable contains a NUL byte');
  return Buffer.from(`${parts.join('\0')}\0`);
}

// The environment of a worker: the caller's command environment (already scrubbed, sandbox/sandbox.mjs scrubEnv), with
// HOME, TMPDIR and the XDG folders of this instance and call, and a PATH of folders that the worker can read.
// macOS specifics: Apple's /usr/bin/git, python3, make and clang are xcrun shims that write a cache in the user's
// temporary folder (a shared file that a worker must not change), so the real tools of the active developer folder come
// first; the developer folder's system gitconfig (credential.helper=osxkeychain) is not read, as a Linux worker reads no
// /etc/gitconfig; SDKROOT spares xcrun its SDK lookup.
export function workerEnv(env, { home, tmp, sdkroot, developerDir, visible }) {
  const out = { ...env, HOME: home, TMPDIR: `${tmp}/`, TMPPREFIX: `${tmp}/zsh`,
    XDG_CACHE_HOME: join(home, '.cache'), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'), XDG_RUNTIME_DIR: tmp, GIT_CONFIG_NOSYSTEM: '1' };
  let dirs = visiblePath(env.PATH, visible).split(':');
  if (existsSync(WORKER_TOOLS)) dirs = [WORKER_TOOLS, ...dirs.filter((d) => d !== WORKER_TOOLS)];
  if (developerDir) {
    const tools = join(developerDir, 'usr', 'bin');
    dirs = dirs.filter((d) => d !== tools);
    const at = dirs.indexOf('/usr/bin');
    dirs.splice(at < 0 ? dirs.length : at, 0, tools);
  }
  out.PATH = dirs.join(':');
  if (sdkroot) out.SDKROOT = sdkroot;
  return out;
}

export async function main(specFile) {
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  rmSync(specFile, { force: true });                                     // it contains Pi's environment
  const uid = process.getuid();
  const runDir = spec.runDir;
  mkdirSync(join(runDir, 'jobs'), { recursive: true, mode: 0o700 });
  mkdirSync(join(runDir, 'calls'), { recursive: true, mode: 0o700 });
  // MINA_SUPERVISOR_DEBUG=FILE: a log of the calls, and the stderr files of the call jobs are kept.
  const debugFile = process.env.MINA_SUPERVISOR_DEBUG || null;
  const debug = (...a) => { if (debugFile) try { appendFileSync(debugFile, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch { /* diagnostic only */ } };
  const coalitions = new Set();                                          // the instance's own (in a real job) and its calls'
  const record = (line) => {
    const cid = Number(line);
    if (Number.isSafeInteger(cid) && cid > 0) coalitions.add(cid);
    try { appendFileSync(spec.coalitionsFile, `${line}\n`, { mode: 0o600 }); } catch { /* stop finds them by label too */ }
  };
  // The coalition of the instance job (mina stop stops it). Only in a real instance job: a supervisor that a test starts
  // is in the coalition of the test's terminal.
  if (process.env.MINA_INSTANCE_JOB === '1') record(coalitionOf(process.pid));
  const allowedWrites = spec.allowedWrites.map(canonical);
  const prefix = callLabelPrefix(spec.instanceId);
  let seq = 0, closing = false;
  const waiting = new Map();                                             // token -> resolve(helper)
  const spares = [];
  const jobs = new Map();                                                // label -> plist file

  const startJob = () => {
    const n = ++seq, token = randomBytes(16).toString('hex'), label = `${prefix}${n}`;
    const file = join(runDir, 'jobs', `${n}.plist`);
    writeFileSync(file, plist(label, [HELPER, 'call', spec.socket, token], { stderr: join(runDir, 'jobs', `${n}.err`) }), { mode: 0o600 });
    jobs.set(label, file);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { waiting.delete(token); fail(new Error(`the call job ${label} did not start`)); }, HELLO_MS);
      waiting.set(token, (helper) => { clearTimeout(timer); done({ ...helper, label, n }); });
      bootstrap(file, uid).then((r) => { if (!r.ok) { clearTimeout(timer); waiting.delete(token); fail(new Error(`launchctl bootstrap ${label}: ${r.stderr.trim()}`)); } });
    });
  };
  const finishJob = (label) => {
    const file = jobs.get(label);
    jobs.delete(label);
    debug('bootout', label);
    bootout(label, uid).then(() => { if (file) rmSync(file, { force: true }); if (!debugFile) rmSync(file?.replace(/\.plist$/, '.err') ?? '', { force: true }); });
  };
  const refill = () => {
    while (!closing && spares.length < SPARES) {
      const p = startJob();
      p.catch(() => {});
      spares.push(p);
    }
  };
  // A spare whose job has gone (its connection closed) is skipped.
  const takeHelper = async () => {
    while (spares.length) {
      const p = spares.shift();
      refill();
      const helper = await p.catch(() => null);
      if (helper && !helper.socket.destroyed && !helper.closed) return helper;
      if (helper) finishJob(helper.label);
    }
    const helper = await startJob();
    refill();
    return helper;
  };

  const sdkroot = spec.sdkroot || null;
  const activeChecks = new Map();                                        // .mina/checks folder -> number of runs
  const runCall = async (relay, req, rest) => {
    const fail = (message, code = 126) => {
      relay.write(encodeFrame('F', `${message}\n`));
      relay.end(encodeFrame('X', `${code} 0`));
    };
    let helper, check = null;
    // After a protected check: verify the bytes again, and move the new top-level entries of the project to the staging
    // folder of the check (on Linux they are created there). Returns a message when the result does not count.
    const endCheck = () => {
      if (!check) return null;
      const c = check; check = null;
      let problem = null;
      try { if (c.staging) for (const name of readdirSync(c.project)) if (!c.before.has(name)) moveEntry(join(c.project, name), join(c.staging, name)); }
      catch (error) { problem = `mina: protected check: cannot move its new files to ${c.staging}: ${error.message}`; }
      const after = checkHashes(c.checks);
      if (!problem && (after.unsafe || differ(c.hashes, after.hashes))) problem = 'mina: protected check bytes changed during the run; the result does not count.';
      if (c.stash) {                                                     // the project's own copy (or its absence) comes back
        rmSync(c.checks, { recursive: true, force: true });
        if (c.stash.existed) cpSync(c.stash.path, c.checks, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
        rmSync(c.stash.path, { recursive: true, force: true });
      }
      const left = (activeChecks.get(c.checks) ?? 1) - 1;
      if (left) activeChecks.set(c.checks, left); else activeChecks.delete(c.checks);
      return problem;
    };
    try {
      let profile, env, argv = req.argv, n;
      if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) throw new Error('mina sandbox: malformed call');
      if (req.kind === 'worker') {
        const roots = workerRoots({ ...req.roots, network: req.network, egress: req.egressPort, env: req.env ?? {} });
        const refused = writeRefusal(roots.writes, allowedWrites);
        if (refused) throw new Error(refused);
        if (req.frozen) {
          // A protected check (extensions/goal/check-execution.mjs): the accepted bytes, verified now and after the run.
          const checks = canonical(req.frozen.checks), project = canonical(req.roots.project);
          // From now on no new call can change the folder; then the accepted bytes are put in place if the project's copy
          // differs (on Linux the accepted snapshot is mounted over it), and the project's copy comes back after the run.
          activeChecks.set(checks, (activeChecks.get(checks) ?? 0) + 1);
          check = { checks, project, hashes: req.frozen.hashes, stash: null, before: new Set(readdirSync(project)) };
          let now = checkHashes(checks);
          if ((now.unsafe || differ(req.frozen.hashes, now.hashes)) && req.frozen.source) {
            const stash = join(runDir, `stash-${randomBytes(6).toString('hex')}`);
            let existed = true;
            try { lstatSync(checks); } catch { existed = false; }
            if (existed) cpSync(checks, stash, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
            check.stash = { path: stash, existed };
            rmSync(checks, { recursive: true, force: true });
            cpSync(req.frozen.source, checks, { recursive: true, preserveTimestamps: true });
            now = checkHashes(checks);
          }
          if (now.unsafe || differ(req.frozen.hashes, now.hashes)) throw new Error('mina: protected check refused: Protected check bytes changed before execution; no check ran.');
          mkdirSync(req.frozen.staging, { recursive: true, mode: 0o700 });
          check.staging = mkdtempSync(join(req.frozen.staging, 'check-'));
        }
        // The home and the output store of the caller's instance (MINA_WORKER_HOME, MINA_WORKER_OUTPUTS), as innerArgs
        // binds them on Linux; the home must be a writable root of the launch.
        const home = req.home ? canonical(req.home) : spec.workerHome, outputs = req.outputs ? canonical(req.outputs) : spec.workerOutputs;
        const homeRefused = home && writeRefusal([home], allowedWrites);
        if (homeRefused) throw new Error(homeRefused);
        helper = await takeHelper();
        n = helper.n;
        const tmp = join(runDir, 'calls', String(n));
        mkdirSync(tmp, { mode: 0o700 });
        profile = workerProfile(roots, { network: req.network, egressPort: req.egressPort, home, tmp,
          outputs, runtime: [FILE_WORKER, ...nodeRuntime(), ...(existsSync(WORKER_TOOLS) ? [WORKER_TOOLS] : [])], frozen: [...activeChecks.keys()] });
        env = workerEnv(req.env ?? {}, { home: home ?? tmp, tmp, sdkroot, developerDir: spec.developerDir, visible: [...roots.writes, ...roots.reads, ...nodeRuntime(), WORKER_TOOLS] });
      } else if (req.kind === 'service') {
        const writes = (req.writes ?? []).map(canonical);
        const refused = writeRefusal(writes, allowedWrites);
        if (refused) throw new Error(refused);
        helper = await takeHelper();
        n = helper.n;
        const tmp = join(runDir, 'calls', String(n));
        mkdirSync(tmp, { mode: 0o700 });
        // A memory bound: mina-instance limit starts the program with a kernel limit, inside the sandbox.
        const bound = req.limits?.memoryBytes ? Math.max(1, Math.floor(req.limits.memoryBytes / (1024 * 1024))) : 0;
        if (bound) argv = [HELPER, 'limit', String(bound), '--', ...argv];
        profile = serviceProfile({ reads: [...(req.reads ?? []), ...(bound ? [HELPER] : [])], writes: [...writes, tmp], egressPort: req.egressPort ?? null });
        env = { ...(req.env ?? {}), TMPDIR: `${tmp}/`, ...(req.homeIsTmp ? { HOME: tmp } : {}) };
      } else throw new Error(`mina sandbox: unknown call kind ${req.kind}`);
      const file = join(runDir, 'calls', `${n}.sb`);
      writeFileSync(file, profile.text, { mode: 0o600 });
      helper.socket.write(encodeFrame('A', argumentsFrame(req.cwd || '/', sandboxExecArgs(file, profile.params, argv), env)));
      if (check) relay.write(encodeFrame('E', `mina: protected-check new root artifacts: ${check.staging} (retained host path: ${check.staging})\n`));
      // From here the relay and the call job speak to each other: stdin, stdout, stderr, exit.
      if (rest.length) helper.socket.write(rest);
      relay.pipe(helper.socket);
      // The TMPDIR of the call is removed before the relay gets the exit status, as a Linux worker's /tmp is gone when
      // bwrap exits. So the frames from the call job are read here, not only piped.
      let pending = Buffer.alloc(0), cleaned = false;
      const clean = () => {
        if (cleaned) return; cleaned = true;
        rmSync(join(runDir, 'calls', String(n)), { recursive: true, force: true });
        rmSync(file, { force: true });
      };
      debug('call', n, helper.label, req.kind, argv[0]);
      helper.socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        const { frames, rest: left } = decodeFrames(pending);
        pending = Buffer.from(left);
        for (const f of frames) {
          let frame = encodeFrame(f.type, f.data);
          if (f.type === 'X') {
            debug('exit', n, f.data.toString());
            clean();
            const void_ = endCheck();
            if (void_) frame = Buffer.concat([encodeFrame('E', `${void_}\n`), encodeFrame('X', '126 0')]);
          }
          if (!relay.write(frame)) { helper.socket.pause(); relay.once('drain', () => helper.socket.resume()); }
        }
      });
      relay.resume(); helper.socket.resume();
      const done = () => {
        relay.end(); helper.socket.destroy();
        finishJob(helper.label);
        clean();
        endCheck();
      };
      // A memory bound for this call (the PDF converter: RLIMIT_AS on Linux). The kernel enforces it for the program
      // (mina-instance limit); this sampler also stops the call when all its processes together pass it.
      if (req.limits?.memoryBytes) {
        const bound = req.limits.memoryBytes;
        const timer = setInterval(() => {
          let live;
          try { live = members([helper.cid]).filter((m) => !m.zombie && m.comm !== 'mina-instance'); } catch { return; }
          if (live.reduce((sum, m) => sum + m.footprint, 0) <= bound) return;
          debug('call memory', n, bound);
          for (const m of live) { try { process.kill(m.pid, 'SIGKILL'); } catch { /* gone */ } }
        }, 100);
        timer.unref();
        helper.socket.once('close', () => clearInterval(timer));
      }
      relay.once('close', () => { debug('relay closed', n); relay.destroy(); done(); });
      helper.socket.once('close', () => { debug('job closed', n); done(); });
      relay.on('error', () => {}); helper.socket.on('error', () => {});
    } catch (error) {
      if (helper) { helper.socket.destroy(); finishJob(helper.label); }
      endCheck();
      fail(error.message);
    }
  };

  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('error', () => {});
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer, 1);
      if (!frames.length) return;
      socket.off('data', onData);
      socket.pause();
      const [{ type, data }] = frames;
      if (type === 'H') {
        const [token, cid, pid] = data.toString().split('\n');
        const resolveHelper = waiting.get(token);
        if (!resolveHelper) { socket.destroy(); return; }
        waiting.delete(token);
        record(cid);
        const helper = { socket, cid: Number(cid), pid: Number(pid), closed: false };
        socket.once('close', () => { helper.closed = true; });
        resolveHelper(helper);
        // A spare that loses its supervisor connection is gone; the next call starts another one.
      } else if (type === 'R') {
        let req;
        try { req = JSON.parse(data.toString()); } catch { socket.destroy(); return; }
        if (closing) { socket.end(Buffer.concat([encodeFrame('F', 'mina: the instance is stopping\n'), encodeFrame('X', '125 0')])); return; }
        runCall(socket, req, rest).finally(() => socket.resume());
      } else socket.destroy();
    };
    socket.on('data', onData);
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(spec.socket, done); });
  chmodSync(spec.socket, 0o600);
  refill();

  // Pi, under the outer profile.
  const piTmp = join(runDir, 'tmp');
  mkdirSync(piTmp, { recursive: true, mode: 0o700 });
  const outer = outerProfile({ writable: [...spec.allowedWrites, ...spec.piWrites ?? []], tmp: piTmp, sockets: [spec.socket, ...(spec.sockets ?? [])],
    hiddenDirs: spec.piHidden ?? [], readable: spec.piReadable ?? [], stdio: spec.piStdio ?? [] });
  const outerFile = join(runDir, 'outer.sb');
  writeFileSync(outerFile, outer.text, { mode: 0o600 });
  // Pi's private temporary folder is the counterpart of its private /tmp on Linux. Claude Code writes to /tmp/claude-UID
  // unless CLAUDE_CODE_TMPDIR names another folder (/private/tmp is hidden from Pi).
  const env = { ...spec.pi.env, TMPDIR: `${piTmp}/`, CLAUDE_CODE_TMPDIR: piTmp, MINA_SUPERVISOR_SOCKET: spec.socket, MINA_HELPER: HELPER };
  // Pi leads its own process group, as the terminal's job on Linux: its suspend (kill(0, SIGTSTP)) stops Pi and its
  // children, not the supervisor; the terminal's signals go to the whole group. mina-instance pgrp sets the group and
  // execs sandbox-exec (the pid stays Pi's).
  const pi = spawn(HELPER, ['pgrp', '--', ...sandboxExecArgs(outerFile, outer.params, spec.pi.argv)], { stdio: 'inherit', env, cwd: spec.pi.cwd });
  const toPi = (sig) => { try { process.kill(-pi.pid, sig); } catch { try { pi.kill(sig); } catch { /* gone */ } } };
  for (const sig of ['SIGWINCH', 'SIGHUP', 'SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGCONT', 'SIGTSTP']) process.on(sig, () => toPi(sig));

  // The local limits (sandbox/macos/watchdog.mjs): the macOS replacement for the cgroup limits of the systemd scope.
  const limits = spec.limits ?? null;
  const signalAll = (live, sig) => { for (const m of live) { try { process.kill(m.pid, sig); } catch { /* gone */ } } };
  let stopping = false;
  const stopInstance = (why) => {
    if (stopping) return; stopping = true;
    debug('stop', why);
    toPi('SIGTERM'); toPi('SIGCONT');                                     // as systemd: a stopped process gets SIGCONT too
    for (const label of jobs.keys()) bootout(label, uid);
    setTimeout(() => { sweep([...coalitions]); toPi('SIGKILL'); }, 2000).unref();
  };
  const deadline = limits?.maxWallS ? setTimeout(() => stopInstance(`deadline ${limits.maxWallS} s`), limits.maxWallS * 1000) : null;
  let previous = new Map(), last = Date.now(), pausedUntil = 0, throttledUntil = 0, piStopped = false;
  const watch = limits ? setInterval(() => {
    const now = Date.now();
    if (stopping || now < pausedUntil) return;
    let all;
    try { all = members([...coalitions]); } catch { return; }
    // Pi suspended itself (Ctrl+Z): the terminal's job stops too (mina-instance passes it on to attach). A pause of the
    // CPU quota (below) is not a suspend: Pi is stopped then too, until the pause ends.
    const piState = all.find((m) => m.pid === pi.pid);
    if (piState?.stopped && now < throttledUntil) return;
    if (piState?.stopped && !piStopped) debug('pi stopped', pi.pid, process.env.MINA_INSTANCE_JOB);
    if (piState?.stopped && !piStopped && process.env.MINA_INSTANCE_JOB === '1') { piStopped = true; try { process.kill(process.ppid, 'SIGUSR1'); } catch { /* gone */ } }
    else if (piState && !piState.stopped) piStopped = false;
    const live = all.filter((m) => !m.zombie && !m.stopped && !infrastructure(m));
    const cpu = cpuDelta(previous, live);
    previous = cpu.next;
    const action = decide(all, limits, { cpuNs: cpu.used, intervalMs: now - last });
    last = now;
    if (!action) return;
    debug('limit', action.reason);
    if (action.kill) for (const pid of action.kill) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    else if (action.pauseMs) {
      pausedUntil = now + action.pauseMs;
      throttledUntil = pausedUntil + 2 * SAMPLE_MS;
      signalAll(live, 'SIGSTOP');
      setTimeout(() => signalAll(live, 'SIGCONT'), action.pauseMs);
    }
  }, SAMPLE_MS) : null;
  watch?.unref();

  const code = await new Promise((done) => pi.on('exit', (c, s) => done(c ?? 128 + (constants.signals[s] ?? 0))));
  if (deadline) clearTimeout(deadline);
  if (watch) clearInterval(watch);
  closing = true;
  server.close();
  await Promise.all([...jobs.keys()].map((label) => bootout(label, uid)));
  rmSync(runDir, { recursive: true, force: true });
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then((code) => process.exit(code), (e) => { process.stderr.write(`mina supervisor: ${e.stack ?? e.message}\n`); process.exit(125); });
}
