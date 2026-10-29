// PDF extractor confinement: the parser (native PyMuPDF on untrusted bytes) runs in a bubblewrap sandbox with positive
// read-only mounts only (/usr + distro aliases, the resolved venv/runtime prefix), an empty size-capped /tmp, private
// /dev and /proc, and its own user/pid/ipc/uts/net namespaces, no capabilities and no inherited descriptors. The canary
// tests run their script through the exact same runner (same bwrap arguments, interpreter, environment and rlimit
// prelude) as the PDF script. Nothing here probes real private services: the only loopback listeners are created by
// the test itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PYTHON, PDF_SCRIPT, RLIMIT_PRELUDE, extractPdfText } from '../supplements/pdf.mjs';
import { BWRAP, pdfSandboxArgs, resolvePdfRuntime, runSandboxedPython } from '../supplements/pdf-sandbox.mjs';
import { buildPdf } from './supplement-fixtures.mjs';
import { createProviders } from '../broker/providers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PY = process.env.SUPPLEMENT_TEST_PYTHON || DEFAULT_PYTHON;
const userns = existsSync(BWRAP) && spawnSync(BWRAP, ['--unshare-user', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/', '--', '/usr/bin/true'],
  { env: { PATH: '/usr/bin' }, stdio: 'ignore' }).status === 0;
// Slow hosts (a small ARM board under load) set MINA_TEST_TIMEOUT_SCALE; teardown after an abort can take longer than 3 s there.
const SCALE = Math.max(1, Number(process.env.MINA_TEST_TIMEOUT_SCALE) || 1);
const REAL = !existsSync(PY) ? `no Python at ${PY} (set SUPPLEMENT_TEST_PYTHON)` : !userns ? `bubblewrap namespaces unavailable (${BWRAP})` : false;

const fakeChild = () => {
  const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = Object.assign(new EventEmitter(), { end() {} }); c.killed = []; c.kill = (sig) => c.killed.push(sig); return c;
};
// A fake runtime that passes the mount policy (spawn is faked, so it never runs).
function fakeVenv(home = '/usr/bin') {
  const root = mkdtempSync(join(tmpdir(), 'pdf-fake-venv-'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'python'), '#!/bin/false\n'); chmodSync(join(root, 'bin', 'python'), 0o755);
  writeFileSync(join(root, 'pyvenv.cfg'), `home = ${home}\n`);
  return { root, python: join(root, 'bin', 'python'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const markerProcesses = (marker) => readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
  try { return readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(marker); } catch { return false; }
});
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return fn(); };

// ---------------------------------------------------------------- real functionality inside the sandbox

test('real PDF: the sandboxed pinned PyMuPDF reads the injected stdin PDF', { skip: REAL }, async () => {
  const marker = `MARKER${process.pid}x${Date.now()}`;
  const before = new Set(readdirSync(tmpdir()));
  const r = await extractPdfText(buildPdf([`First ${marker}`, 'Second page']), { python: PY, offset: 1, limit: 1 });
  assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.page_count, 2);
  assert.equal(r.pymupdf, '1.28.2'); assert.match(r.pages[0].text, /Second page/);
  const all = await extractPdfText(buildPdf([`First ${marker}`]), { python: PY });
  assert.match(all.pages[0].text, new RegExp(marker));
  // No temp file with paper content: the PDF only ever travels on stdin.
  for (const e of readdirSync(tmpdir()).filter((e) => !before.has(e))) {
    try { assert.ok(!readFileSync(join(tmpdir(), e)).includes(marker), e); } catch (err) { if (err.code !== 'EISDIR' && err.code !== 'EACCES' && err.code !== 'ENOENT') throw err; }
  }
  const broken = await extractPdfText(Buffer.from('%PDF-1.4\nnot really a pdf\n%%EOF'), { python: PY });
  assert.ok(['parse_error', 'extractor_failed'].includes(broken.status), broken.status);
});

// ---------------------------------------------------------------- canary in the identical namespace

const CANARY = String.raw`
import os, sys, json, socket, resource
paths = json.loads(sys.argv[1]); res = {}
def attempt(name, fn):
    try:
        res[name] = ["ok", fn()]
    except BaseException as e:
        res[name] = ["err", type(e).__name__ + ":" + str(getattr(e, "errno", ""))]
for i, p in enumerate(paths["secrets"]):
    attempt("read%d" % i, lambda p=p: open(p).read())
for i, p in enumerate(paths["writes"]):
    def w(p=p):
        with open(p, "w") as f: f.write("x")
        return "written"
    attempt("write%d" % i, w)
def tmpw():
    fd = os.open(paths["tmpfile"], os.O_CREAT | os.O_WRONLY, 0o600)
    try: os.write(fd, b"x")
    finally: os.close(fd)
    return "wrote-bytes"
attempt("tmp_create", lambda: os.path.exists(paths["tmpfile"]) or tmpw())
attempt("tmp_exists", lambda: os.path.exists(paths["tmpfile"]))
attempt("home", lambda: os.listdir(paths["home"]))
attempt("repo", lambda: os.listdir(paths["repo"]))
attempt("etc", lambda: os.listdir("/etc"))
attempt("root", lambda: sorted(os.listdir("/")))
attempt("fds", lambda: sorted(os.listdir("/proc/self/fd")))
attempt("pids", lambda: sorted(p for p in os.listdir("/proc") if p.isdigit()))
def environs():
    out = []
    for p in os.listdir("/proc"):
        if p.isdigit():
            try: out.append(open("/proc/%s/environ" % p, "rb").read().decode("latin1"))
            except OSError: pass
    return out
attempt("environs", environs)
attempt("env", lambda: dict(os.environ))
attempt("proc_status", lambda: [l for l in open("/proc/self/status").read().splitlines() if l.startswith(("Cap", "NoNewPrivs", "Uid"))])
attempt("ifaces", lambda: [n for _, n in socket.if_nameindex()])
def tcp():
    s = socket.create_connection(("127.0.0.1", paths["port"]), timeout=2); s.close(); return "connected"
attempt("tcp", tcp)
def abstract():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(2); s.connect("\0" + paths["abstract"]); s.close(); return "connected"
attempt("abstract", abstract)
def nested():
    os.unshare(os.CLONE_NEWUSER); return "unshared"
attempt("userns", nested)
attempt("limits", lambda: [resource.getrlimit(r) for r in (resource.RLIMIT_AS, resource.RLIMIT_CPU, resource.RLIMIT_FSIZE, resource.RLIMIT_CORE)])
sys.stdout.write(json.dumps(res)); sys.stdout.flush()
`;

test('canary in the PDF namespace: no owner secrets, no writes outside /tmp, no host loopback, no caps/fds/env', { skip: REAL }, async () => {
  const token = `SECRET-CANARY-${process.pid}-${Date.now()}`;
  const hostTmp = mkdtempSync(join(tmpdir(), 'pdf-canary-'));
  const repoTmp = mkdtempSync(join(REPO, '.pdf-canary-'));
  const venvRoot = resolvePdfRuntime(PY).mounts[0];
  const secrets = [join(hostTmp, 'secret'), join(repoTmp, 'secret')];
  for (const f of secrets) writeFileSync(f, token, { mode: 0o600 });
  // Unique names, removed in finally: if confinement ever regresses, the probe must not leave debris in the venv or home.
  const probe = `pdf-canary-pwned-${process.pid}-${Date.now()}`;
  const tmpfile = `/tmp/${probe}`;
  const writes = [`/${probe}`, `/usr/${probe}`, join(venvRoot, probe), join(repoTmp, probe), join(hostTmp, probe), join(homedir(), probe)];
  process.env.MINA_PDF_CANARY_SECRET = token;
  let connections = 0, abstractConnections = 0;
  const server = net.createServer((s) => { connections++; s.destroy(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const abstract = `mina-pdf-canary-${process.pid}-${Date.now()}`;
  const aserver = net.createServer((s) => { abstractConnections++; s.destroy(); });
  await new Promise((r) => aserver.listen(`\0${abstract}`, r));
  try {
    // Sanity: the host side really is reachable without the sandbox.
    await new Promise((r, j) => { const s = net.connect(server.address().port, '127.0.0.1', () => { s.destroy(); r(); }); s.on('error', j); });
    await new Promise((r, j) => { const s = net.connect(`\0${abstract}`, () => { s.destroy(); r(); }); s.on('error', j); });
    const base = connections;
    const baseAbstract = abstractConnections;
    const out = await runSandboxedPython(Buffer.alloc(0), { python: PY, script: RLIMIT_PRELUDE + CANARY, maxMemoryBytes: 1024 ** 3, timeoutMs: 20000,
      args: [JSON.stringify({ secrets, writes, tmpfile, home: homedir(), repo: REPO, port: server.address().port, abstract })] });
    assert.ok(!out.status, JSON.stringify(out));
    assert.ok(!JSON.stringify(out).includes(token), 'secret token visible inside the sandbox');
    for (let i = 0; i < secrets.length; i++) assert.equal(out[`read${i}`][0], 'err', secrets[i]);
    for (let i = 0; i < writes.length; i++) assert.equal(out[`write${i}`][0], 'err', writes[i]);
    for (const f of writes) assert.equal(existsSync(f), false, f);
    assert.deepEqual(out.tmp_create, ['err', 'OSError:27']); // created in the private tmpfs, but RLIMIT_FSIZE=0 refuses bytes (EFBIG)
    assert.deepEqual(out.tmp_exists, ['ok', true]); assert.equal(existsSync(tmpfile), false); // private tmpfs, not the host /tmp
    // A trusted runtime below the home folder or the repo needs empty ancestor directories, never their real contents.
    const scaffold = (dir) => [...new Set(resolvePdfRuntime(PY).mounts.filter((m) => m.startsWith(`${dir}/`))
      .map((m) => m.slice(dir.length + 1).split('/')[0]))].sort();
    for (const [name, dir] of [['home', homedir()], ['repo', REPO]]) {
      const expected = scaffold(dir);
      if (expected.length) assert.deepEqual(out[name], ['ok', expected], `${name} shows more than the runtime scaffold`);
      else assert.equal(out[name][0], 'err', name);
    }
    assert.deepEqual(out.etc[0] === 'ok' ? out.etc[1] : [], out.etc[0] === 'ok' ? ['ld.so.cache'] : []); // loader index only, if present
    const top = venvRoot.split('/')[1];
    assert.deepEqual(out.root[1].filter((e) => !['usr', 'bin', 'sbin', 'lib', 'lib64', 'dev', 'proc', 'tmp', 'etc', top].includes(e)), []);
    assert.deepEqual(out.fds[1].filter((fd) => !['0', '1', '2'].includes(fd)).length, 1); // only the listing's own descriptor
    assert.ok(out.pids[1].length <= 3, `host processes visible: ${out.pids[1]}`);
    assert.deepEqual(Object.keys(out.env[1]).sort(), ['HOME', 'LANG', 'LC_ALL', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'ORT_DISABLE_TELEMETRY', 'PATH', 'PWD', 'TMPDIR'].sort());
    assert.equal(out.env[1].ORT_DISABLE_TELEMETRY, '1', 'onnxruntime telemetry is off');
    const status = Object.fromEntries(out.proc_status[1].map((l) => l.split(':\t')));
    for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.equal(Number.parseInt(status[k], 16), 0, k);
    assert.equal(status.NoNewPrivs, '1');
    assert.deepEqual(out.ifaces[1], ['lo']);
    assert.equal(out.tcp[0], 'err'); assert.equal(out.abstract[0], 'err');
    assert.equal(out.userns[0], 'err');
    assert.equal(connections, base); assert.equal(abstractConnections, baseAbstract);
    const [as, cpu, fsize, core] = out.limits[1];
    assert.equal(as[0], 1024 ** 3); assert.ok(cpu[0] >= 1 && cpu[0] <= 21, String(cpu)); assert.deepEqual(fsize, [0, 0]); assert.deepEqual(core, [0, 0]);
  } finally {
    delete process.env.MINA_PDF_CANARY_SECRET;
    for (const f of [...writes, tmpfile]) if (f.startsWith(venvRoot) || f.startsWith(homedir()) || f === tmpfile) rmSync(f, { force: true });
    server.close(); aserver.close();
    rmSync(hostTmp, { recursive: true, force: true }); rmSync(repoTmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- limits, deadline, abort

const DESCENDANT = String.raw`
import subprocess, sys, time
subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(120)", sys.argv[1]])
time.sleep(120)
`;

test('deadline and abort kill the whole sandbox, descendants included', { skip: REAL }, async () => {
  for (const mode of ['deadline', 'abort']) {
    const marker = `pdf-descendant-${mode}-${process.pid}-${Date.now()}`;
    const ac = new AbortController();
    const run = runSandboxedPython(Buffer.alloc(0), { python: PY, script: RLIMIT_PRELUDE + DESCENDANT, args: [marker],
      timeoutMs: mode === 'deadline' ? 3000 : 60000, signal: ac.signal });
    assert.ok(await waitFor(() => markerProcesses(marker).length > 0), `${mode}: descendant never started`);
    if (mode === 'abort') { ac.abort(new Error('stop-pdf')); await assert.rejects(run, /stop-pdf/); }
    else assert.equal((await run).status, 'extractor_timeout');
    assert.ok(await waitFor(() => markerProcesses(marker).length === 0, 3000 * SCALE), `${mode}: descendant survived: ${markerProcesses(marker)}`);
  }
});

test('rlimit setup failure is a typed outcome, never a silent bypass', { skip: REAL }, async () => {
  const broken = 'import resource\ndef _refuse(*a):\n    raise OSError(1, "refused")\nresource.setrlimit = _refuse\n';
  const r = await runSandboxedPython(Buffer.alloc(0), { python: PY, script: broken + RLIMIT_PRELUDE + 'print("PARSER-RAN")\n' });
  assert.equal(r.status, 'pdf_extractor_unavailable'); assert.equal(r.reason, 'rlimit_failed');
  assert.ok(!JSON.stringify(r).includes('PARSER-RAN'));
  // A value Python would read as RLIM_INFINITY is refused before anything is spawned.
  let spawned = 0;
  const r2 = await extractPdfText(buildPdf(['x']), { python: PY, maxMemoryBytes: -1, spawnImpl: () => { spawned++; return fakeChild(); } });
  assert.equal(r2.status, 'pdf_extractor_unavailable'); assert.equal(r2.reason, 'invalid_limits'); assert.equal(spawned, 0);
  assert.ok(PDF_SCRIPT.startsWith(RLIMIT_PRELUDE));
});

test('stdout cap still applies inside the sandbox', { skip: REAL }, async () => {
  const r = await runSandboxedPython(Buffer.alloc(0), { python: PY, script: `${RLIMIT_PRELUDE}import sys\nsys.stdout.write("x" * 100000); sys.stdout.flush()\nimport time; time.sleep(30)\n`,
    maxStdoutBytes: 1000, timeoutMs: 20000 });
  assert.equal(r.status, 'extractor_output_limit');
});

// ---------------------------------------------------------------- fail closed

test('missing or untrusted bubblewrap fails closed: nothing is spawned, no unsandboxed fallback', async () => {
  const calls = [];
  const spawnImpl = (cmd, args) => { calls.push([cmd, args]); return fakeChild(); };
  const v = fakeVenv();
  try {
    for (const bwrap of ['/nonexistent/bwrap', 'bwrap', v.python]) {
      const r = await extractPdfText(buildPdf(['x']), { python: v.python, bwrap, spawnImpl });
      assert.equal(r.status, 'pdf_extractor_unavailable', bwrap); assert.equal(r.reason, 'isolation_unavailable', bwrap);
    }
    assert.equal(calls.length, 0);
  } finally { v.cleanup(); }
});

test('bwrap that cannot build the namespace is isolation_unavailable; every spawn goes through bwrap', { skip: existsSync(BWRAP) ? false : `no ${BWRAP}` }, async () => {
  const v = fakeVenv();
  const calls = [];
  try {
    const spawnImpl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const c = fakeChild();
      setImmediate(() => { c.stderr.emit('data', Buffer.from('bwrap: setting up uid map: Permission denied\n')); c.emit('exit', 1, null); c.emit('close', 1, null); });
      return c;
    };
    const r = await extractPdfText(buildPdf(['x']), { python: v.python, spawnImpl });
    assert.equal(r.status, 'pdf_extractor_unavailable'); assert.equal(r.reason, 'isolation_unavailable');
    assert.equal(calls.length, 1);
    const { cmd, args, opts } = calls[0];
    assert.equal(cmd, BWRAP);
    assert.deepEqual(Object.keys(opts.env), ['PATH']); assert.equal(opts.detached, true); assert.equal(opts.shell, false);
    const sep = args.indexOf('--');
    assert.deepEqual(args.slice(sep + 1, sep + 4), [join(realpathSync(dirname(v.python)), 'python'), '-I', '-B']);
    assert.deepEqual(args.slice(0, sep), pdfSandboxArgs(resolvePdfRuntime(v.python)));
  } finally { v.cleanup(); }
});

test('unsafe or missing runtimes fail closed: / or the home folder are never mounted wholesale', async () => {
  let spawned = 0;
  const spawnImpl = () => { spawned++; return fakeChild(); };
  const cases = [];
  const root = fakeVenv('/'); cases.push([root, 'unsafe_runtime']);
  const home = fakeVenv(homedir()); cases.push([home, 'unsafe_runtime']);
  const link = mkdtempSync(join(tmpdir(), 'pdf-link-venv-'));
  mkdirSync(join(link, 'bin')); symlinkSync('/etc/hostname', join(link, 'bin', 'python')); writeFileSync(join(link, 'pyvenv.cfg'), 'home = /usr/bin\n');
  try {
    for (const [v, reason] of cases) {
      const r = await extractPdfText(buildPdf(['x']), { python: v.python, spawnImpl });
      assert.equal(r.status, 'pdf_extractor_unavailable'); assert.equal(r.reason, reason, v.python);
    }
    for (const python of [join(link, 'bin', 'python'), 'python3', '/nonexistent/python3', '']) {
      const r = await extractPdfText(buildPdf(['x']), { python, spawnImpl });
      assert.equal(r.status, 'pdf_extractor_unavailable', python); assert.ok(['unsafe_runtime', 'runtime_unavailable'].includes(r.reason), `${python}: ${r.reason}`);
    }
    assert.throws(() => resolvePdfRuntime(join(homedir(), 'python')), /runtime/);
    assert.equal(spawned, 0);
    // A system interpreter is fine: /usr is already the trusted read-only base.
    if (existsSync('/usr/bin/python3')) assert.deepEqual(resolvePdfRuntime('/usr/bin/python3').mounts, []);
  } finally { root.cleanup(); home.cleanup(); rmSync(link, { recursive: true, force: true }); }
});

test('broker pdfToText: Markdown from the sandboxed pymupdf4llm, with no write to the host home (onnxruntime telemetry)', { skip: REAL }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pdf-broker-home-'));
  const saved = process.env.HOME;
  try {
    process.env.HOME = home; // where an unconfined onnxruntime would write .cache/Microsoft/DeveloperTools/deviceid
    const p = createProviders({}, { keys: {}, researchKeys: {}, config: {}, python: PY });
    const text = await p.pdfToText(buildPdf(['Base editing restores function', 'in a sandboxed parser']));
    assert.match(text, /Base editing restores function/);
    assert.deepEqual(readdirSync(home), [], 'nothing written to the home folder');
    assert.equal(await p.pdfToText(Buffer.from('%PDF-1.4 not really')), '', 'a broken PDF is empty text, as before');
    await p.close?.();
  } finally { process.env.HOME = saved; rmSync(home, { recursive: true, force: true }); }
});
