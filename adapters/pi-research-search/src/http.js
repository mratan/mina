// Derived from @bytetrue/pi-web-search 0.5.1 (MIT); see ATTRIBUTION.md.
// Default HTTP client for pi-research-search. Uses node:http / node:https directly (never globalThis.fetch), so a host
// that wraps fetch does not change its behavior; the host can observe every hop through `trace` or inject its own client.
//
// Contract (any injected client must honor it):
//   http.request({ method, url, headers?, body?, signal?, timeoutMs?, maxBytes?, overflow?, maxRedirects?, policy? })
//     -> Promise<{ status, headers, url, body: Buffer, truncated, redirects: string[] }>
//   - method: 'GET' | 'POST' only.            - url: http(s) only.
//   - policy.check(url) is awaited before EVERY hop (first request and each redirect target). It throws to refuse, or
//     returns null or { address, family }; when an address is returned the connection is made to that address (the
//     hostname is still used for Host, SNI and certificate checks), which defeats DNS rebinding between check and connect.
//   - Redirects (301/302/303/307/308) are followed manually up to maxRedirects (default 0 = a redirect is returned as is).
//     303, and 301/302 after POST, continue as GET without a body; 307/308 keep the method and body.
//   - maxBytes caps the decoded body. overflow 'truncate' (default) stops reading and sets truncated=true; 'error' throws.
//   - skipBodyFor (RegExp, optional): when the response content-type matches, the body is not read (skipped: true).
//   - timeoutMs bounds the whole request including redirects; signal aborts it.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS_LIMIT = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const METHODS = new Set(['GET', 'POST']);

function abortError(signal, fallback = 'Request aborted') {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error(reason ? String(reason) : fallback);
}

function decoderFor(encoding) {
  switch ((encoding || '').trim().toLowerCase()) {
    case '': case 'identity': return null;
    case 'gzip': case 'x-gzip': return zlib.createGunzip();
    case 'deflate': return zlib.createInflate();
    case 'br': return zlib.createBrotliDecompress();
    default: throw new Error(`Unsupported content-encoding: ${encoding}`);
  }
}

function oneHop({ method, url, headers, body, signal, maxBytes, overflow, address, skipBodyFor }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const options = {
      method, signal,
      headers: { 'accept-encoding': 'gzip, deflate, br', ...headers, ...(body != null ? { 'content-length': Buffer.byteLength(body) } : {}) },
      agent: false, // no pooling: each hop gets its own vetted connection
    };
    if (address) {
      options.lookup = (_host, opts, cb) => (opts?.all ? cb(null, [address]) : cb(null, address.address, address.family));
    }
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const req = mod.request(url, options, (res) => {
      const status = res.statusCode ?? 0;
      const resHeaders = {};
      for (const [k, v] of Object.entries(res.headers)) resHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      if (REDIRECTS.has(status)) {
        res.resume();
        done(resolve, { status, headers: resHeaders, body: Buffer.alloc(0), truncated: false });
        return;
      }
      if (skipBodyFor && skipBodyFor.test(resHeaders['content-type'] ?? '')) {
        done(resolve, { status, headers: resHeaders, body: Buffer.alloc(0), truncated: false, skipped: true });
        res.destroy();
        return;
      }
      let stream = res;
      try {
        const dec = decoderFor(resHeaders['content-encoding']);
        if (dec) { stream = res.pipe(dec); res.on('error', (e) => dec.destroy(e)); }
      } catch (e) { res.destroy(); done(reject, e); return; }
      const chunks = [];
      let bytes = 0;
      let truncated = false;
      stream.on('data', (chunk) => {
        if (settled) return;
        if (bytes + chunk.length > maxBytes) {
          // Settle first: destroying the response synchronously emits 'aborted'.
          if (overflow === 'error') {
            done(reject, new Error(`Response body exceeds the ${maxBytes}-byte limit`));
          } else {
            chunks.push(chunk.subarray(0, maxBytes - bytes));
            bytes = maxBytes;
            truncated = true;
            done(resolve, { status, headers: resHeaders, body: Buffer.concat(chunks, bytes), truncated });
          }
          res.destroy();
          if (stream !== res) stream.destroy();
          return;
        }
        chunks.push(chunk);
        bytes += chunk.length;
      });
      stream.on('end', () => done(resolve, { status, headers: resHeaders, body: Buffer.concat(chunks, bytes), truncated }));
      stream.on('error', (e) => done(reject, e));
      res.on('aborted', () => done(reject, new Error('Response aborted')));
    });
    req.on('error', (e) => done(reject, signal?.aborted ? abortError(signal) : e));
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Create the default client. `trace(event)` (optional) receives one event per hop:
 * { method, url, status?, bytes?, truncated?, ms, error?, address? } — never headers or bodies.
 */
export function createNodeHttpClient({ trace = null, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, defaultMaxBytes = DEFAULT_MAX_BYTES } = {}) {
  return {
    async request(opts) {
      const method = String(opts.method || 'GET').toUpperCase();
      if (!METHODS.has(method)) throw new Error(`HTTP method ${method} is not allowed`);
      const maxRedirects = Math.min(Math.max(0, opts.maxRedirects ?? 0), MAX_REDIRECTS_LIMIT);
      const maxBytes = opts.maxBytes ?? defaultMaxBytes;
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
      let current = new URL(opts.url);
      let curMethod = method;
      let curBody = method === 'POST' ? opts.body ?? '' : undefined;
      const redirects = [];
      for (let hop = 0; ; hop++) {
        if (signal.aborted) throw timeoutSignal.aborted && !opts.signal?.aborted ? new Error(`Request timed out after ${timeoutMs} ms`) : abortError(signal);
        if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error(`Unsupported protocol ${current.protocol}`);
        const address = opts.policy ? await opts.policy.check(current.toString()) : null;
        const started = Date.now();
        let res;
        try {
          const headers = { ...(opts.headers ?? {}) };
          if (curBody === undefined) for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
          res = await oneHop({ method: curMethod, url: current, headers, body: curBody, signal, maxBytes, overflow: opts.overflow ?? 'truncate', address, skipBodyFor: opts.skipBodyFor });
        } catch (error) {
          const timedOut = timeoutSignal.aborted && !opts.signal?.aborted;
          const err = timedOut ? new Error(`Request timed out after ${timeoutMs} ms`) : error;
          trace?.({ method: curMethod, url: current.toString(), ms: Date.now() - started, error: err.message });
          throw err;
        }
        trace?.({ method: curMethod, url: current.toString(), status: res.status, bytes: res.body.length, truncated: res.truncated,
          ms: Date.now() - started, ...(address ? { address: address.address } : {}) });
        if (!REDIRECTS.has(res.status) || maxRedirects === 0) return { ...res, url: current.toString(), redirects };
        const location = res.headers.location;
        if (!location) throw new Error(`HTTP ${res.status} redirect without Location from ${current}`);
        if (hop >= maxRedirects) throw new Error(`Too many redirects (max ${maxRedirects})`);
        const next = new URL(location, current);
        redirects.push(next.toString());
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod === 'POST')) { curMethod = 'GET'; curBody = undefined; }
        current = next;
      }
    },
  };
}
