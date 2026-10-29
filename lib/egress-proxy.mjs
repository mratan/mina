// Egress proxy for sandboxed commands at the 'packages' and 'open' network levels. The command keeps its own network
// namespace (bwrap --unshare-net): it has only its own loopback, so it cannot reach host loopback services (SearXNG,
// a local model server), the LAN, or the abstract Unix sockets of the host namespace (owner endpoint, store locks). Its only way out
// is this proxy, which runs in the supervisor and listens on a pathname Unix socket bind-mounted into the sandbox, where
// lib/netbridge.mjs relays the sandbox's 127.0.0.1:3128 to it. The proxy is the policy point: it decides on the
// hostname, resolves the name itself, refuses every non-public address, and connects to the address it vetted, so a
// DNS answer that changes between check and use (rebinding) cannot redirect the connection. Every decision is recorded.
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { mkdtempSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Package registries and source hosts. An entry '*.suffix' matches any name below suffix (not suffix itself).
export const DEFAULT_PACKAGE_HOSTS = Object.freeze([
  'registry.npmjs.org', 'registry.yarnpkg.com',
  'pypi.org', 'files.pythonhosted.org',
  'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
  'release-assets.githubusercontent.com', 'api.github.com',
  'gitlab.com',
  'crates.io', 'static.crates.io', 'index.crates.io',
  'proxy.golang.org', 'sum.golang.org',
  'repo.anaconda.com', 'conda.anaconda.org', '*.anaconda.org',
  'bioconductor.org', '*.bioconductor.org',
  'cloud.r-project.org', 'cran.r-project.org',
]);

export const EGRESS_LEVELS = Object.freeze(['packages', 'open']);
const PORTS = new Set([80, 443]);
const MAX_CONNECTIONS = 64;
const IDLE_MS = 120_000;
const CONNECT_MS = 15_000;
const LOG_MAX = 10_000;

// A lowercase hostname without a trailing dot, or null when the name is not a plausible DNS name. Anything else
// (userinfo, percent escapes, spaces) is refused before it can reach the resolver.
export function normalizeHost(host) {
  if (typeof host !== 'string') return null;
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (isIP(h)) return h;
  h = h.replace(/\.$/, '');
  if (!h || h.length > 253 || !/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/.test(h)) return null;
  return h;
}

// Exact entries match only themselves; '*.suffix' matches names strictly below suffix. Names are compared after
// normalization, so 'PyPI.org.' is pypi.org and 'evilpypi.org' is not.
export function hostAllowed(host, allow = DEFAULT_PACKAGE_HOSTS) {
  const h = normalizeHost(host);
  if (!h || isIP(h)) return false;
  return allow.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e;
  });
}

// ---- Address classification. Returns null for a public unicast address, otherwise why it is refused. ----
const v4 = (ip) => ip.split('.').map(Number);
const inV4 = (o, [a, b, c, d], bits) => {
  const n = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0, m = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (n & mask) === (m & mask);
};
const V4_BLOCKS = [
  [[169, 254, 169, 254], 32, 'cloud metadata'], [[0, 0, 0, 0], 8, 'unspecified / this network'], [[10, 0, 0, 0], 8, 'private (RFC1918)'],
  [[100, 64, 0, 0], 10, 'CGNAT (100.64/10)'], [[127, 0, 0, 0], 8, 'loopback'], [[169, 254, 0, 0], 16, 'link-local'],
  [[172, 16, 0, 0], 12, 'private (RFC1918)'], [[192, 0, 0, 0], 24, 'IETF protocol assignments'], [[192, 0, 2, 0], 24, 'documentation'],
  [[192, 168, 0, 0], 16, 'private (RFC1918)'], [[198, 18, 0, 0], 15, 'benchmarking'], [[198, 51, 100, 0], 24, 'documentation'],
  [[203, 0, 113, 0], 24, 'documentation'], [[224, 0, 0, 0], 4, 'multicast'], [[240, 0, 0, 0], 4, 'reserved / broadcast'],
];
function classifyV4(ip) {
  const o = v4(ip);
  for (const [net, bits, why] of V4_BLOCKS) if (inV4(o, net, bits)) return why;
  return null;
}
// Eight 16-bit groups, with '::' expanded and a trailing dotted quad folded in.
function v6Groups(ip) {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (quad) { const o = v4(quad[1]); s = s.slice(0, -quad[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`; }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.map((g) => parseInt(g, 16));
}
const embeddedV4 = (g, i) => `${g[i] >> 8}.${g[i] & 255}.${g[i + 1] >> 8}.${g[i + 1] & 255}`;
export function classifyAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return classifyV4(ip);
  if (family !== 6) return 'not an IP address';
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some((x) => !(x >= 0 && x <= 0xffff))) return 'not an IP address';
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 8)) return 'unspecified';
  if (zero(0, 7) && g[7] === 1) return 'loopback';
  // An IPv4 address carried in IPv6 is judged as that IPv4 address: mapped ::ffff:a.b.c.d, the deprecated compatible
  // form ::a.b.c.d, the translated ::ffff:0:a.b.c.d, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, and 6to4 2002::/16.
  const inner = (i, kind) => { const why = classifyV4(embeddedV4(g, i)); return why ? `${kind} ${why}` : null; };
  if (zero(0, 5) && g[5] === 0xffff) return inner(6, 'IPv4-mapped');
  if (zero(0, 6)) return inner(6, 'IPv4-compatible');
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return inner(6, 'IPv4-translated');
  if (g[0] === 0x64 && g[1] === 0xff9b && (zero(2, 6) || g[2] === 1)) return inner(6, 'NAT64');
  if (g[0] === 0x2002) return inner(1, '6to4');
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique local (fc00::/7)';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
  if ((g[0] & 0xffc0) === 0xfec0) return 'site-local (fec0::/10)';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation';
  if (g[0] === 0x0100 && zero(1, 4)) return 'discard-only (100::/64)';
  return null;
}

const defaultResolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

// The policy for one target, before any connection: the vetted addresses, or a refusal reason.
export async function vetTarget({ level, allow = DEFAULT_PACKAGE_HOSTS, host, port, resolve = defaultResolve }) {
  if (!EGRESS_LEVELS.includes(level)) return { allowed: false, reason: `network level ${level} has no egress` };
  if (!PORTS.has(port)) return { allowed: false, reason: `port ${port} is not 80 or 443` };
  const h = normalizeHost(host);
  if (!h) return { allowed: false, reason: 'not a valid hostname' };
  if (level === 'packages') {
    if (isIP(h)) return { allowed: false, reason: 'IP-literal targets are refused at the packages level' };
    if (!hostAllowed(h, allow)) return { allowed: false, reason: 'host is not on the package allowlist' };
  }
  let addresses;
  if (isIP(h)) addresses = [h];
  else {
    try { addresses = (await resolve(h)).map((a) => (typeof a === 'string' ? a : a.address)); } catch (error) {
      return { allowed: false, reason: `resolution failed: ${error.code ?? error.message}`, status: 502 };
    }
  }
  if (!addresses.length) return { allowed: false, reason: 'resolution returned no address', status: 502 };
  // Any non-public answer refuses the whole name: a name that resolves partly to loopback is a rebinding probe.
  for (const a of addresses) {
    const why = classifyAddress(a);
    if (why) return { allowed: false, reason: `${a} is ${why}` };
  }
  return { allowed: true, reason: 'ok', host: h, addresses };
}

export function createEgressProxy({ level, allow = DEFAULT_PACKAGE_HOSTS, socketDir = tmpdir(), onEvent = () => {}, resolve = defaultResolve,
  maxConnections = MAX_CONNECTIONS, idleMs = IDLE_MS } = {}) {
  if (!EGRESS_LEVELS.includes(level)) throw new Error(`EGRESS_INVALID: level must be one of ${EGRESS_LEVELS.join(', ')}`);
  // A private directory (mkdtemp creates it 0700) holds the socket: no other user can reach or replace it.
  mkdirSync(socketDir, { recursive: true });
  const dir = mkdtempSync(join(socketDir, 'mina-egress-'));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, 'proxy.sock');
  const log = [];
  const live = new Set();
  // Records carry `event`: 'refused' (one record, nothing was dialed), or 'open' then 'close' for an allowed connection,
  // linked by `conn`. The open record is written as soon as the upstream connection exists, so a supervisor that dies
  // mid-transfer still leaves a record that the connection was made; the close record adds the byte counts.
  let connSeq = 0;

  const record = (entry) => {
    const event = { op: 'egress', level, ...entry, at: new Date().toISOString() };
    log.push(event);
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    try { onEvent(event); } catch { /* recording must not break the relay */ }
  };

  // Connect to the vetted addresses in order; the name is never resolved again.
  function dial(addresses, port) {
    return new Promise((done, fail) => {
      let i = 0;
      const next = (lastError) => {
        if (i >= addresses.length) return fail(lastError);
        const sock = netConnect({ host: addresses[i++], port });
        const t = setTimeout(() => sock.destroy(new Error('connect timeout')), CONNECT_MS);
        sock.once('connect', () => { clearTimeout(t); sock.removeAllListeners('error'); done(sock); });
        sock.once('error', (e) => { clearTimeout(t); sock.destroy(); next(e); });
      };
      next(new Error('no address'));
    });
  }

  const track = (...socks) => {
    for (const s of socks) { live.add(s); s.once('close', () => live.delete(s)); s.setTimeout(idleMs, () => s.destroy()); }
  };

  const server = createServer({ requestTimeout: idleMs, headersTimeout: 30_000, keepAliveTimeout: 5_000 });
  server.maxConnections = maxConnections;
  server.on('connection', (s) => track(s));

  // CONNECT host:port: a TCP tunnel, normally for TLS. The proxy never sees inside it.
  server.on('connect', async (req, client, head) => {
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
    const host = m ? m[1] : String(req.url), port = m ? Number(m[2]) : 0;
    const base = { host, port, method: 'CONNECT' };
    const refuse = (status, reason) => {
      record({ ...base, event: 'refused', allowed: false, reason, bytes_up: 0, bytes_down: 0 });
      client.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nmina egress: ${reason}\n`);
    };
    client.on('error', () => {});
    const v = m ? await vetTarget({ level, allow, host, port, resolve }) : { allowed: false, reason: 'malformed CONNECT target' };
    if (!v.allowed) return refuse(v.status ?? 403, v.reason);
    let upstream;
    try { upstream = await dial(v.addresses, port); } catch (error) { return refuse(502, `connect failed: ${error.code ?? error.message}`); }
    if (client.destroyed) { upstream.destroy(); return; }
    track(upstream);
    const conn = ++connSeq, address = upstream.remoteAddress;
    record({ ...base, host: v.host, event: 'open', conn, allowed: true, reason: 'ok', address, bytes_up: 0, bytes_down: 0 });
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      record({ ...base, host: v.host, event: 'close', conn, allowed: true, reason: 'ok', address, bytes_up: upstream.bytesWritten, bytes_down: upstream.bytesRead });
      client.destroy(); upstream.destroy();
    };
    upstream.on('error', finish); client.on('error', finish); upstream.on('close', finish); client.on('close', finish);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });

  // Absolute-URI HTTP (plain port 80). The Host header is rewritten from the URL, so the request reaches the vetted name
  // and cannot be fronted to another virtual host on the same address.
  server.on('request', async (req, res) => {
    let url = null;
    try { url = /^http:\/\//i.test(req.url) ? new URL(req.url) : null; } catch { url = null; }
    const host = url?.hostname ?? '', port = url ? Number(url.port || 80) : 0;
    const base = { host, port, method: req.method };
    const refuse = (status, reason) => {
      record({ ...base, event: 'refused', allowed: false, reason, bytes_up: 0, bytes_down: 0 });
      res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' }).end(`mina egress: ${reason}\n`);
    };
    if (!url) return refuse(400, 'only absolute http:// URIs and CONNECT are proxied');
    if (url.username || url.password) return refuse(400, 'credentials in the URL are refused');
    if (port !== 80) return refuse(403, `port ${port} is not 80 for plain HTTP`);
    const v = await vetTarget({ level, allow, host, port, resolve });
    if (!v.allowed) return refuse(v.status ?? 403, v.reason);
    let upstream;
    try { upstream = await dial(v.addresses, port); } catch (error) { return refuse(502, `connect failed: ${error.code ?? error.message}`); }
    track(upstream);
    const conn = ++connSeq, address = upstream.remoteAddress;
    record({ ...base, host: v.host, event: 'open', conn, allowed: true, reason: 'ok', address, bytes_up: 0, bytes_down: 0 });
    const headers = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], lk = k.toLowerCase();
      if (lk === 'host' || lk.startsWith('proxy-') || lk === 'connection' || lk === 'keep-alive') continue;
      (headers[k] ??= []).push(req.rawHeaders[i + 1]);
    }
    headers.Host = url.host; headers.Connection = 'close';
    let done = false;
    const finish = (allowed = true, reason = 'ok') => {
      if (done) return; done = true;
      record({ ...base, host: v.host, event: 'close', conn, allowed, reason, address, bytes_up: upstream.bytesWritten, bytes_down: upstream.bytesRead });
      upstream.destroy();
    };
    const out = httpRequest({ createConnection: () => upstream, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false });
    out.on('response', (r) => {
      const back = [];
      for (let i = 0; i < r.rawHeaders.length; i += 2) if (!/^(connection|keep-alive|proxy-)/i.test(r.rawHeaders[i])) back.push(r.rawHeaders[i], r.rawHeaders[i + 1]);
      res.writeHead(r.statusCode, r.statusMessage, back);
      r.pipe(res);
      r.on('end', () => finish()); r.on('error', () => finish(true, 'upstream response error'));
    });
    out.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`mina egress: ${e.message}\n`); else res.destroy(); finish(true, `upstream error: ${e.code ?? e.message}`); });
    res.on('close', () => finish());
    req.pipe(out);
  });
  server.on('clientError', (_e, s) => { s.destroy(); });

  return {
    socketPath, log, level,
    start() {
      return new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(socketPath, () => { server.off('error', fail); chmodSync(socketPath, 0o600); done(socketPath); });
      });
    },
    async close() {
      for (const s of live) s.destroy();
      await new Promise((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
