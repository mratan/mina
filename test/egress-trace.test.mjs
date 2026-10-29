// The privacy e2e tests (test/e2e/) are only as good as their detector: these feed it synthetic strace output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientHelloSni, parseDns, parseTrace, violations } from './e2e/egress-trace.mjs';

const x = (buf) => `"${[...buf].map((b) => `\\x${b.toString(16).padStart(2, '0')}`).join('')}"`;
const xs = (s) => x(Buffer.from(s, 'latin1'));
const name = (n) => Buffer.concat([...n.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
function dns(host, answers = []) {
  const head = Buffer.from([0x12, 0x34, answers.length ? 0x81 : 0x01, 0x00, 0, 1, 0, answers.length, 0, 0, 0, 0]);
  const rr = answers.map((ip) => {
    const v6 = ip.includes(':');
    const rd = v6 ? Buffer.from(ip.split(':').flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; })) : Buffer.from(ip.split('.').map(Number));
    return Buffer.concat([Buffer.from([0xc0, 12, 0, v6 ? 28 : 1, 0, 1, 0, 0, 0, 60, 0, rd.length]), rd]);
  });
  return Buffer.concat([head, name(host), Buffer.from([0, 1, 0, 1]), ...rr]);
}
function hello(host) {
  const sni = Buffer.concat([Buffer.from([0, 0]), u16(host.length + 5), u16(host.length + 3), Buffer.from([0]), u16(host.length), Buffer.from(host)]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]), u16(sni.length), sni]);
  const hs = Buffer.concat([Buffer.from([1, 0]), u16(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(hs.length), hs]);
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }

test('DNS and ClientHello decoding', () => {
  assert.deepEqual(parseDns(dns('api.anthropic.com')).questions, ['api.anthropic.com']);
  assert.deepEqual(parseDns(dns('api.anthropic.com', ['160.79.104.10', '2607:6bc0:0:0:0:0:0:10'])).answers, ['160.79.104.10', '2607:6bc0:0:0:0:0:0:10']);
  assert.equal(clientHelloSni(hello('pi.dev')), 'pi.dev');
  assert.equal(clientHelloSni(Buffer.from('GET / HTTP/1.1\r\n')), null);
});

test('a trace: names from DNS and TLS, addresses attributed, split calls joined, telemetry denied', () => {
  const trace = [
    `100 connect(5, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr(${xs('100.100.100.100')})}, 16) = 0`,
    `100 sendmmsg(5, [{msg_hdr={msg_name=NULL, msg_namelen=0, msg_iov=[{iov_base=${x(dns('mobile.events.data.microsoft.com'))}, iov_len=40}]}}], 1, MSG_NOSIGNAL) = 1`,
    `100 recvfrom(5,  <unfinished ...>`,
    `101 write(9, ${xs('unrelated')}, 9) = 9`,
    `100 <... recvfrom resumed>${x(dns('mobile.events.data.microsoft.com', ['13.69.239.72']))}, 2048, 0, {sa_family=AF_INET, sin_port=htons(53)}, [16]) = 80`,
    `100 connect(7, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(${xs('13.69.239.72')})}, 16) = -1 EINPROGRESS (Operation now in progress)`,
    `102 connect(8, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, ${xs('2607:6bc0::10')}, &sin6_addr), sin6_scope_id=0}, 28) = 0`,
    `102 sendto(8, ${x(hello('api.anthropic.com'))}, 100, MSG_NOSIGNAL, NULL, 0) = 100`,
    `103 connect(9, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(${xs('203.0.113.9')})}, 16) = 0`,
    `104 connect(4, {sa_family=AF_INET, sin_port=htons(8190), sin_addr=inet_addr(${xs('100.64.0.7')})}, 16) = 0`,
    `105 connect(6, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(${xs('198.51.100.1')})}, 16) = -1 ECONNREFUSED (Connection refused)`,
  ].join('\n');
  const e = parseTrace(trace);
  assert.deepEqual(Object.keys(e.hosts).sort(), ['api.anthropic.com', 'mobile.events.data.microsoft.com']);
  assert.equal(e.connections.find((c) => c.ip === '13.69.239.72').name, 'mobile.events.data.microsoft.com', 'DNS answer from a resumed call');
  assert.equal(e.connections.find((c) => c.ip === '2607:6bc0:0:0:0:0:0:10').name, 'api.anthropic.com', 'named by the server name on the socket');
  assert.ok(e.connections.find((c) => c.ip === '100.64.0.7').local, 'tailnet addresses are local');
  assert.deepEqual(e.unattributed, ['203.0.113.9:443'], 'a public address nobody looked up is reported; refused connections are not traffic');
  const v = violations(e, ['api.anthropic.com']);
  assert.deepEqual(v.denied, ['mobile.events.data.microsoft.com']);
  assert.deepEqual(v.unexpected, ['mobile.events.data.microsoft.com']);
  assert.deepEqual(violations(parseTrace(trace.split('\n').slice(6, 8).join('\n')), ['api.anthropic.com']), { denied: [], unexpected: [], unattributed: [], hosts: ['api.anthropic.com'] });
});
