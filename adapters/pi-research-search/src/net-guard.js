// Address classification and URL vetting for web_fetch (SSRF guard).
// Ported from @bytetrue/pi-web-search 0.5.1 src/html.ts ("URL guard (SSRF)"), MIT. Changes: plain JS; 198.18.0.0/15
// is blocked (upstream allowed it for fake-ip TUN proxies); IPv4-mapped/compatible/NAT64 forms are unwrapped and 6to4/Teredo are blocked; an
// explicit host allow list is supported; the vetted address is returned so the transport can pin the connection to it.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export const MAX_URL_LENGTH = 2048;
const PROTOCOLS = new Set(['http:', 'https:']);

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['2001::', 23], ['3fff::', 20],
  ['5f00::', 16], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) NON_PUBLIC.addSubnet(net, prefix, 'ipv6');

function ipv6Words(address) {
  const [left = '', right = ''] = address.toLowerCase().split('::');
  const side = (s) => {
    if (!s) return [];
    const parts = s.split(':');
    const last = parts.at(-1);
    if (last?.includes('.')) {
      parts.pop();
      const b = last.split('.').map(Number);
      parts.push(((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16));
    }
    return parts.map((p) => Number.parseInt(p, 16));
  };
  const l = side(left);
  const r = side(right);
  const fill = address.includes('::') ? Array(Math.max(0, 8 - l.length - r.length)).fill(0) : [];
  return [...l, ...fill, ...r];
}

const v4 = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** IPv4 address embedded in an IPv4-mapped, IPv4-compatible or NAT64 (64:ff9b::/96) IPv6 address, if any. */
export function embeddedIpv4(address) {
  const w = ipv6Words(address);
  if (w.length !== 8 || w.some((x) => !Number.isInteger(x))) return undefined;
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) return v4(w[6], w[7]); // ::ffff:a.b.c.d, ::a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return v4(w[6], w[7]); // NAT64
  return undefined;
}

/** True for loopback, private (RFC 1918), link-local, CGNAT, unique-local, multicast, documentation, metadata, etc. */
export function isNonPublicAddress(address) {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const inner = embeddedIpv4(address);
    if (inner) return isNonPublicAddress(inner);
    return NON_PUBLIC.check(address, 'ipv6');
  }
  return NON_PUBLIC.check(address, 'ipv4');
}

export function normalizeHostname(hostname) {
  return String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

function hostAllowed(url, allowHosts) {
  const host = normalizeHostname(url.hostname);
  const hostPort = `${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  return (allowHosts ?? []).some((entry) => {
    const e = normalizeHostname(entry);
    return e === host || e === hostPort;
  });
}

/** Parse and statically vet a URL for web_fetch. Throws with a reason on refusal. */
export function parsePublicHttpUrl(raw, { allowHosts = [] } = {}) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('URL is required.');
  if (raw.length > MAX_URL_LENGTH) throw new Error(`URL is longer than ${MAX_URL_LENGTH} characters.`);
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL.'); }
  if (!PROTOCOLS.has(url.protocol)) throw new Error(`Unsupported URL protocol ${url.protocol}; only http and https are allowed.`);
  if (url.username || url.password) throw new Error('Refusing a URL with embedded credentials.');
  if (hostAllowed(url, allowHosts)) return url;
  const host = normalizeHostname(url.hostname);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error(`Refusing to fetch non-public host ${host}.`);
  }
  if (isIP(host) && isNonPublicAddress(host)) throw new Error(`Refusing to fetch non-public address ${host}.`);
  return url;
}

/**
 * Policy object for the http client: check(url) is called before every hop (including each redirect target). It
 * resolves the host, refuses if ANY resolved address is non-public, and returns the vetted address to connect to.
 */
export function createPublicFetchPolicy({ allowHosts = [], resolve = (h) => dnsLookup(h, { all: true, verbatim: true }) } = {}) {
  return {
    name: 'public-only',
    async check(rawUrl) {
      const url = parsePublicHttpUrl(String(rawUrl), { allowHosts });
      if (hostAllowed(url, allowHosts)) return null;
      const host = normalizeHostname(url.hostname);
      const family = isIP(host);
      const addresses = family ? [{ address: host, family }] : await resolve(host);
      if (!addresses?.length) throw new Error(`Could not resolve host ${host}.`);
      for (const { address } of addresses) {
        if (isNonPublicAddress(address)) throw new Error(`Refusing to fetch ${host}: it resolves to non-public address ${address}.`);
      }
      return { address: addresses[0].address, family: addresses[0].family };
    },
  };
}

/** Policy for fixed provider endpoints: only the listed origins are allowed; no address pinning. */
export function createOriginPolicy(origins) {
  const allowed = new Set(origins.map((o) => new URL(o).origin));
  return {
    name: 'origin-allowlist',
    async check(rawUrl) {
      const url = new URL(String(rawUrl));
      if (!allowed.has(url.origin)) throw new Error(`Request to ${url.origin} is outside the provider allow list.`);
      return null;
    },
  };
}
