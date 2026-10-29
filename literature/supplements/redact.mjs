// Redaction of credentials carried in URLs (pre-signed S3/GCS/Azure/CloudFront links, token/signature query
// parameters, userinfo) for everything supplement_get returns to the model: rendered text, details/provenance,
// redirects, refused URLs and error messages. The network always uses the original URL; only what is reported is
// redacted. Parameter names are kept so the shape of the link stays visible; values become "[redacted]".
//
// A non-secret parameter can carry a percent-encoded URL or query ("?next=https%3A%2F%2Fb%2Ff%3FX-Amz-Signature%3D...",
// "?q=%26token%3D..."). Such values are decoded at most MAX_DECODE_DEPTH times (single, double, triple encoding) and
// redacted inside; only a value that actually changed is re-encoded, so ordinary search values stay byte-for-byte.
// A value still encoded past that depth, or longer than MAX_DECODE_CHARS, is redacted whole when it mentions a
// credential-like name. Values embedded in URL paths (not query/fragment parameters) are not decoded.

const EXACT = new Set(['sig', 'signature', 'token', 'auth', 'authorization', 'key', 'apikey', 'api_key', 'api-key', 'code',
  'password', 'passwd', 'pwd', 'secret', 'policy', 'key-pair-id', 'googleaccessid', 'awsaccesskeyid', 'ossaccesskeyid',
  'x-amz-credential', 'x-goog-credential', 'skoid', 'sktid', 'jwt', 'session', 'sessionid', 'sid', 'hmac']);
const PARTIAL = /signature|token|secret|credential|password|passwd|session|api[-_]?key|access[-_]?key|private[-_]?key/i;

function sensitive(rawName) {
  let name = rawName;
  try { name = decodeURIComponent(rawName.replace(/\+/g, ' ')); } catch { /* keep raw */ }
  name = name.trim().toLowerCase();
  return EXACT.has(name) || PARTIAL.test(name);
}

const MAX_DECODE_DEPTH = 3;
const MAX_DECODE_CHARS = 4096;
const CREDENTIAL_HINT = /sig|token|secret|credential|passw|pwd|session|key|auth|policy|jwt|hmac|code|sid|skoid|sktid|accessid|%40|@/i;

/** Percent-decode once; malformed sequences are left as they are (never a throw). */
function decodeOnce(v) {
  try { return decodeURIComponent(v); } catch { return v.replace(/%([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))); }
}

function redactValue(value, depth) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  if (depth <= 0 || value.length > MAX_DECODE_CHARS) return CREDENTIAL_HINT.test(value) ? '[redacted]' : value;
  const dec = decodeOnce(value);
  if (dec === value) return value;
  // The decoded value may be a URL, a bare query ("a=1&token=x") or another encoded layer.
  let red = redactCore(`&${dec}`, depth - 1).slice(1);
  if (red === dec) red = redactValue(dec, depth - 1);
  return red === dec ? value : encodeURIComponent(red);
}

function redactCore(s, depth) {
  return s
    .replace(/(\/\/)[^/@\s?#]+@/g, '$1[redacted]@')
    .replace(/([?&;#])([^=&#;?\s]+)=([^&#;\s"'<>]*)/g, (m, sep, name, value) => {
      if (sensitive(name)) return `${sep}${name}=[redacted]`;
      const v = redactValue(value, depth);
      return v === value ? m : `${sep}${name}=${v}`;
    });
}

/** Redact credential-bearing query/fragment parameters (also inside percent-encoded values) and userinfo in `s`. */
export function redactText(s) {
  if (s === null || s === undefined) return s;
  return redactCore(String(s), MAX_DECODE_DEPTH);
}

export const redactUrl = redactText;

/** The fetch record as reported (all URL fields redacted). */
export function publicFetch(f) {
  if (!f) return f;
  return { ...f, requested_url: redactText(f.requested_url), final_url: redactText(f.final_url), redirects: (f.redirects ?? []).map(redactText) };
}
