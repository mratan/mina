// Kernel-level egress observation for the privacy e2e tests. A command runs under `strace -f`; every connect(), every
// DNS query and answer (UDP port 53, and systemd-resolved's varlink socket) and every TLS ClientHello server name is
// read back from the trace. Code that ignores proxy settings is seen too. The trace holds conversation bytes, so it is
// written to a private directory and deleted after parsing; only host names, addresses and counts leave this module.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const STRACE = ['/usr/bin/strace', '/bin/strace'].find((p) => spawnSync(p, ['-V'], { stdio: 'ignore' }).status === 0) ?? null;

const SYSCALLS = 'connect,sendto,sendmsg,sendmmsg,write,writev,recvfrom,recvmsg,recvmmsg';

/** Run `command` under strace. Resolves { code, signal, stdout, stderr, egress }. `input(child)` may drive stdin. */
export function traceRun(command, args, { cwd, env, timeoutMs = 300_000, input } = {}) {
  if (!STRACE) throw new Error('strace is not installed');
  const dir = mkdtempSync(join(tmpdir(), 'mina-egress-'));
  chmodSync(dir, 0o700);
  const file = join(dir, 'trace');
  return new Promise((resolve, reject) => {
    const child = spawn(STRACE, ['-f', '-qq', '-xx', '-s', '4096', '-e', `trace=${SYSCALLS}`, '-e', 'signal=none', '-o', file, '--', command, ...args],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    if (input) input(child); else child.stdin.end();
    child.on('error', (e) => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let egress;
      try { egress = parseTrace(readFileSync(file, 'latin1')); } catch (e) { rmSync(dir, { recursive: true, force: true }); reject(e); return; }
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, signal, stdout, stderr, egress });
    });
  });
}

const hex = (s) => Buffer.from(s.replace(/\\x/g, ''), 'hex');
const payloads = (line) => [...line.matchAll(/"((?:\\x[0-9a-f]{2})+)"/g)].map((m) => hex(m[1]));

function isLocal(ip) {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isLocal(l.slice(7));
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b < 128);
}

// DNS wire format: the question name, and A/AAAA answers.
function dnsName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  while (guard++ < 64) {
    const len = buf[off];
    if (len === undefined) return null;
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true; continue; }
    labels.push(buf.subarray(off + 1, off + 1 + len).toString('latin1'));
    off += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), end };
}
export function parseDns(buf) {
  if (buf.length < 12) return null;
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6);
  let off = 12;
  const questions = [], answers = [];
  for (let i = 0; i < qd; i++) {
    const q = dnsName(buf, off); if (!q) return null;
    questions.push(q.name); off = q.end + 4;
  }
  for (let i = 0; i < an && off < buf.length; i++) {
    const n = dnsName(buf, off); if (!n) break;
    off = n.end;
    const type = buf.readUInt16BE(off), rdlen = buf.readUInt16BE(off + 8);
    const rd = buf.subarray(off + 10, off + 10 + rdlen);
    if (type === 1 && rdlen === 4) answers.push([...rd].join('.'));
    if (type === 28 && rdlen === 16) answers.push(Array.from({ length: 8 }, (_, k) => rd.readUInt16BE(k * 2).toString(16)).join(':'));
    off += 10 + rdlen;
  }
  return { questions, answers, response: Boolean(buf[2] & 0x80) };
}

// TLS ClientHello server_name extension.
export function clientHelloSni(buf) {
  if (buf.length < 50 || buf[0] !== 0x16 || buf[1] !== 0x03 || buf[5] !== 0x01) return null;
  let off = 9 + 2 + 32;
  off += 1 + buf[off];                       // session id
  off += 2 + buf.readUInt16BE(off);          // cipher suites
  off += 1 + buf[off];                       // compression
  const end = Math.min(buf.length, off + 2 + buf.readUInt16BE(off));
  off += 2;
  while (off + 4 <= end) {
    const type = buf.readUInt16BE(off), len = buf.readUInt16BE(off + 2);
    if (type === 0) {
      const nameLen = buf.readUInt16BE(off + 7);
      return buf.subarray(off + 9, off + 9 + nameLen).toString('latin1').toLowerCase();
    }
    off += 4 + len;
  }
  return null;
}

const normalizeV6 = (ip) => { // strace prints compressed IPv6; answers are expanded without zero compression
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return full.map((x) => parseInt(x, 16).toString(16)).join(':');
};

/** { hosts: {name: count}, connections: [{ip, port, local, name}], unattributed: [ip:port] } */
export function parseTrace(text) {
  const hosts = {}, ipNames = new Map(), connects = [], dnsFds = new Set(), socketIp = new Map(), pending = new Map();
  const add = (name) => { if (name) hosts[name] = (hosts[name] ?? 0) + 1; };
  for (const raw of text.split('\n')) {
    // A call interrupted by another thread is split: "<unfinished ...>", then "<... call resumed>" on the same thread.
    let line = raw;
    const resumed = /^(\d+)\s+<\.\.\. (\w+) resumed>(.*)$/.exec(raw);
    if (resumed) {
      const head = pending.get(resumed[1]);
      pending.delete(resumed[1]);
      if (!head) continue;
      line = head + resumed[3];
    } else if (/<unfinished \.\.\.>$/.test(raw)) {
      const tid = /^(\d+)/.exec(raw)?.[1];
      if (tid) pending.set(tid, raw.replace(/\s*<unfinished \.\.\.>$/, ''));
      continue;
    }
    const m = /^(\d+)\s+(\w+)\((\d+),/.exec(line);
    if (!m) continue;
    const [, tid, call, fd] = m;
    if (call === 'connect') {
      const port = Number(/htons\((\d+)\)/.exec(line)?.[1] ?? -1);
      const addr = /inet_addr\("([^"]+)"\)/.exec(line)?.[1] ?? /inet_pton\(AF_INET6, "([^"]+)"/.exec(line)?.[1];
      const ip = addr && normalizeV6(addr.startsWith('\\x') ? hex(addr).toString('latin1') : addr);
      if (ip && port === 53) dnsFds.add(`${tid}:${fd}`);
      else if (ip && port > 0 && !/= -1 E(?!INPROGRESS)/.test(line)) { connects.push({ ip, port }); socketIp.set(`${tid}:${fd}`, ip); socketIp.set(fd, ip); }
      continue;
    }
    for (const buf of payloads(line)) {
      if (call.startsWith('send') || call === 'write' || call === 'writev') {
        const sni = clientHelloSni(buf);
        if (sni) {
          add(sni);
          // The server name sent on a socket names the address it connected to (same thread, else the latest on that fd).
          const ip = socketIp.get(`${tid}:${fd}`) ?? socketIp.get(fd);
          if (ip && !ipNames.has(ip)) ipNames.set(ip, sni);
          continue;
        }
      }
      if (dnsFds.has(`${tid}:${fd}`) || /sin_port=htons\(53\)/.test(line)) {
        const d = parseDns(buf);
        if (d) { for (const q of d.questions) if (!d.response) add(q); for (const a of d.answers) for (const q of d.questions) ipNames.set(normalizeV6(a), q); }
        continue;
      }
      // systemd-resolved varlink (nss-resolve): JSON requests and replies.
      const s = buf.toString('latin1');
      if (s.includes('io.systemd.Resolve.ResolveHostname')) for (const n of s.matchAll(/"name":"([^"]+)"/g)) add(n[1].toLowerCase());
      if (s.includes('"addresses"')) {
        const name = /"name":"([^"]+)"/.exec(s)?.[1];
        for (const a of s.matchAll(/"family":(2|10),"address":\[([\d,]+)\]/g)) {
          const bytes = a[2].split(',').map(Number);
          const ip = a[1] === '2' ? bytes.join('.') : Array.from({ length: 8 }, (_, k) => ((bytes[2 * k] << 8) | bytes[2 * k + 1]).toString(16)).join(':');
          if (name) ipNames.set(ip, name.toLowerCase());
        }
      }
    }
  }
  const connections = connects.map((c) => ({ ...c, local: isLocal(c.ip), name: ipNames.get(c.ip) ?? null }));
  const unattributed = [...new Set(connections.filter((c) => !c.local && !c.name).map((c) => `${c.ip}:${c.port}`))];
  return { hosts, connections, unattributed };
}

// Telemetry, crash reporting, analytics, update checks and runtime downloads. None may ever appear.
export const DENY = [/(^|\.)pi\.dev$/, /(^|\.)microsoft\.com$/, /(^|\.)msedge\.net$/, /(^|\.)visualstudio\.com$/, /statsig/, /(^|\.)sentry\.io$/,
  /datadoghq/, /(^|\.)segment\.(io|com)$/, /google-analytics|googletagmanager|doubleclick/, /amplitude/, /mixpanel/, /posthog/,
  /(^|\.)honeycomb\.io$/, /bugsnag/, /rollbar/, /(^|\.)registry\.npmjs\.org$/, /(^|\.)npmjs\.(org|com)$/, /(^|\.)storage\.googleapis\.com$/,
  /(^|\.)github(usercontent)?\.com$/, /(^|\.)huggingface\.co$/, /(^|\.)pypi\.org$/, /(^|\.)pythonhosted\.org$/, /otel|telemetry|metrics|analytics/];

// Names that never leave the machine or the tailnet.
export const LOCAL_NAME = (h) => /(^|\.)localhost$/.test(h) || h.endsWith('.ts.net') || h.endsWith('.lan') || h.endsWith('.local') || !h.includes('.');

/** Hosts outside `allowed` (array of RegExp/string), denied hosts, and connections to unnamed public addresses. */
export function violations(egress, allowed) {
  const ok = (h) => LOCAL_NAME(h) || allowed.some((a) => (a instanceof RegExp ? a.test(h) : a === h));
  const names = Object.keys(egress.hosts);
  const connected = egress.connections.filter((c) => !c.local && c.name).map((c) => c.name);
  const all = [...new Set([...names, ...connected])].sort();
  return { denied: all.filter((h) => DENY.some((d) => d.test(h))), unexpected: all.filter((h) => !ok(h)), unattributed: egress.unattributed, hosts: all };
}
