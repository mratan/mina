// Configuration and credential loading. Keys are read, never logged; describeKeys() reports presence only.
//
// Key resolution (first wins), per provider:
//   1. process env: EXA_API_KEY, BRAVE_SEARCH_API_KEY
//   2. key files in PI_RESEARCH_KEYS_DIR (default: <repo>/keys, the keys/ folder of the Mina checkout):
//      `exa` and `brave`, each one line `KEY=value` or `export KEY=value` (quotes allowed)
//   3. legacy @bytetrue/pi-web-search config: <agent dir>/pi-pkg-cfg/pi-web-search/config.json apiKeys.{exa,brave}
// SearXNG URL: SEARXNG_URL env, then legacy config baseUrls.searxng, then http://127.0.0.1:18080.
// Keyless Exa (Exa's hosted MCP endpoint, used only when there is no EXA_API_KEY) is opt-in: MINA_EXA_KEYLESS=1 in the
// environment, or exaKeyless: true in the config. Without a key and without the opt-in, Exa is skipped as unconfigured.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:18080';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_KEYS_DIR = resolve(HERE, '..', '..', '..', 'keys');

export const DEFAULT_CONFIG = Object.freeze({
  searxngUrl: DEFAULT_SEARXNG_URL,
  exaKeyless: false, // opt-in: use Exa's keyless MCP endpoint when no EXA_API_KEY is available (MINA_EXA_KEYLESS=1)
  literatureEngines: null, // null = providers/searxng.js LITERATURE_ENGINES
  timeouts: { exa: 25_000, brave: 12_000, searxng: 25_000, fetch: 20_000 },
  braveMinIntervalMs: 1_100, // Brave's base plans allow about 1 request per second
  // Gap between SearXNG literature calls. Each call makes 2 NCBI E-utilities requests (PubMed esearch + efetch); NCBI allows
  // 3 per second without an API key, and on HTTP 429 SearXNG suspends the PubMed engine for the following queries.
  searxngMinIntervalMs: 1_100,
  defaultMaxResults: 10, // results shown per backend when max_results is not given (Exa itself is not sent a count)
  // userAgent: 'mina' (default; Mina's own identity) or 'browser' (a desktop Chrome string, see user-agent.js)
  fetch: { maxBytes: 5 * 1024 * 1024, maxChars: 30_000, maxRedirects: 5, allowHosts: [], userAgent: 'mina' },
});

/** Parse one key file line: `export NAME=value`, `NAME=value`, optional quotes. Returns the value for `name`. */
export function parseKeyFile(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] !== name) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v || undefined;
  }
  return undefined;
}

function readIf(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : undefined; } catch { return undefined; }
}

function legacyConfig(env) {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  const root = env.PI_PKG_CFG_DIR?.trim() || join(agentDir, 'pi-pkg-cfg');
  try { return JSON.parse(readIf(join(root, 'pi-web-search', 'config.json')) ?? '{}'); } catch { return {}; }
}

/** Returns { exa?: string, brave?: string } plus non-enumerable `sources` (where each came from; no values). */
export function loadKeys({ env = process.env, keysDir = env.PI_RESEARCH_KEYS_DIR || REPO_KEYS_DIR } = {}) {
  const legacy = legacyConfig(env);
  const keys = {};
  const sources = {};
  for (const [id, name] of [['exa', 'EXA_API_KEY'], ['brave', 'BRAVE_SEARCH_API_KEY']]) {
    const fromEnv = env[name]?.trim();
    const fromFile = fromEnv ? undefined : parseKeyFile(readIf(join(keysDir, id)) ?? '', name);
    const fromLegacy = fromEnv || fromFile ? undefined : legacy.apiKeys?.[id]?.trim();
    const value = fromEnv || fromFile || fromLegacy;
    if (value) { keys[id] = value; sources[id] = fromEnv ? `env ${name}` : fromFile ? `file ${join(keysDir, id)}` : 'legacy pi-web-search config'; }
  }
  Object.defineProperty(keys, 'sources', { value: sources, enumerable: false });
  return keys;
}

export function describeKeys(keys) {
  return { exa: keys.exa ? 'present' : 'absent', brave: keys.brave ? 'present' : 'absent', sources: keys.sources ?? {} };
}

/** MINA_EXA_KEYLESS: '1'/'true'/'yes'/'on' → true, '0'/'false'/'no'/'off' → false, unset or anything else → undefined. */
export function envFlag(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

export function loadConfig({ env = process.env, overrides = {} } = {}) {
  const legacy = legacyConfig(env);
  const searxngUrl = overrides.searxngUrl || env.SEARXNG_URL?.trim() || legacy.baseUrls?.searxng?.trim() || DEFAULT_SEARXNG_URL;
  const exaKeyless = overrides.exaKeyless ?? envFlag(env.MINA_EXA_KEYLESS) ?? DEFAULT_CONFIG.exaKeyless;
  return mergeConfig({ ...overrides, searxngUrl, exaKeyless });
}

export function mergeConfig(partial = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    timeouts: { ...DEFAULT_CONFIG.timeouts, ...(partial.timeouts ?? {}) },
    fetch: { ...DEFAULT_CONFIG.fetch, ...(partial.fetch ?? {}) },
  };
}
