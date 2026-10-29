// End-to-end privacy tests: real `mina` launches, real models, real research services. Each test checks two things:
// the feature still works (the expected answer comes back), and no traffic left the machine except to the selected
// model provider and to the research services a tool call targets (docs/usage.md#privacy-and-network).
//
// Run: npm run test:e2e. Needs signed-in providers; scenarios for providers or models that are not set up are skipped.
// A local model scenario runs when MINA_E2E_LOCAL_MODEL names one (provider/id, a provider of models.json in Pi's agent
// folder) and its server answers.
// With strace installed every connection and name lookup is checked; without it only the research egress logs and
// the onnxruntime files are. Costs a few cents of model use and takes a few minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from '../../bin/mina.mjs';
import { mcpCacheDir } from '../../scripts/mcp-sandbox.mjs';
import { STRACE, traceRun, violations } from './egress-trace.mjs';

const MINA = join(REPO, 'bin/mina.mjs');
const SCALE = Math.max(1, Number(process.env.MINA_TEST_TIMEOUT_SCALE) || 1);
const MCP_CACHE = mcpCacheDir(process.env); // the research servers' egress logs
const ORT_FILES = [join(homedir(), '.cache/Microsoft/DeveloperTools'), join(MCP_CACHE, 'semantic_scholar/.cache/Microsoft')];

const ANTHROPIC = ['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com'];
const CODEX = ['chatgpt.com', 'auth.openai.com'];
const RESEARCH = ['api.openalex.org', 'eutils.ncbi.nlm.nih.gov', 'www.ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov',
  'api.unpaywall.org', 'www.ebi.ac.uk', 'api.biorxiv.org', 'www.biorxiv.org', 'connect.biorxiv.org', 'export.arxiv.org', 'arxiv.org',
  'ar5iv.labs.arxiv.org', 'ar5iv.org', 'api.semanticscholar.org', 'api.exa.ai', 'mcp.exa.ai', 'api.search.brave.com', 'doi.org',
  'api.crossref.org', 'search.crossref.org'];

// A user's shell: nothing of mina's own settings (the launcher must set them itself), no harness variables.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MINA_|PI_OFFLINE$|PI_TELEMETRY$|PI_SKIP_VERSION_CHECK$|ORT_|DO_NOT_TRACK$)/.test(k)));

const listing = mkdtempSync(join(tmpdir(), 'mina-e2e-models-'));
const listed = spawnSync(process.execPath, [MINA, '--list-models'], { encoding: 'utf8', env: ENV, cwd: listing, timeout: 60_000 * SCALE });
rmSync(listing, { recursive: true, force: true });
const models = new Set(`${listed.stdout}\n${listed.stderr}`.split('\n').map((l) => l.trim().split(/\s+/).slice(0, 2).join('/')));
const pick = (...ids) => ids.find((id) => models.has(id));
// Claude: each owner profile in claude-sdk.json is its own provider (claude-sdk-<id>); without profiles, claude-sdk.
// The bare claude-sdk provider is the default ~/.claude login, which a machine with profiles may not keep signed in.
const profiles = (() => {
  try { return JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'claude-sdk.json'), 'utf8')).profiles ?? []; }
  catch { return []; }
})();
const CLAUDES = (profiles.length ? profiles.map((p) => `claude-sdk-${p.id}`) : ['claude-sdk'])
  .map((provider) => pick(`${provider}/claude-haiku-5-5`, `${provider}/claude-haiku-4-5`)).filter(Boolean);
const CLAUDE = CLAUDES[0];
const CODEX_MODEL = pick('openai-codex/gpt-6.1-sol'); // the documented Codex model; older ids are refused for ChatGPT accounts
// A local model (MINA_E2E_LOCAL_MODEL=provider/id): its server is a separate service; when it is down or not configured
// there is nothing to test. The base URL comes from models.json in Pi's agent folder.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi/agent');
const LOCAL_ID = process.env.MINA_E2E_LOCAL_MODEL?.trim() || null;
const LOCAL = LOCAL_ID && LOCAL_ID.includes('/') ? pick(LOCAL_ID) : undefined;
const localSkip = await (async () => {
  if (!LOCAL_ID) return 'MINA_E2E_LOCAL_MODEL (provider/id) is not set';
  if (!LOCAL) return `${LOCAL_ID} is not in mina --list-models`;
  try {
    const base = JSON.parse(readFileSync(join(AGENT_DIR, 'models.json'), 'utf8')).providers[LOCAL.split('/')[0]].baseUrl;
    return (await fetch(`${base.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(5000) })).ok ? false : `${LOCAL_ID}: the server does not answer`;
  } catch { return `${LOCAL_ID}: no reachable baseUrl in ${join(AGENT_DIR, 'models.json')}`; }
})();
const skipUnless = (model, what) => (model ? false : `${what} is not set up on this machine`);

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'mina-e2e-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

// One mina launch. tui: a real interactive session on a pseudo-terminal, idle for `tui` seconds, then Ctrl+D.
// The literature broker gets an empty cache in the project, so research calls really go out.
function mina(args, { tui = 0, timeoutMs = 240_000 } = {}) {
  const quote = (a) => `'${a.replace(/'/g, `'\\''`)}'`;
  const input = tui ? (child) => {
    setTimeout(() => child.stdin.write('\x04'), tui * 1000 * SCALE);
    setTimeout(() => child.stdin.write('\x03\x03'), (tui + 10) * 1000 * SCALE);
    setTimeout(() => child.stdin.end(), (tui + 20) * 1000 * SCALE);
  } : undefined;
  return observe((cwd) => (tui ? ['/usr/bin/script', ['-qfe', '-E', 'always', '-c', [process.execPath, MINA, ...args].map(quote).join(' '), '/dev/null']]
    : [process.execPath, [MINA, ...args]]), { input, timeoutMs, env: (cwd) => ({ LIT_BROKER_CACHE_DIR: join(cwd, '.literature-cache') }) });
}

// Run a command in a fresh project directory and observe its egress, the research proxy logs and the onnxruntime files.
async function observe(commandFor, { input, timeoutMs = 240_000, env: extra = () => ({}) } = {}) {
  const cwd = project();
  const started = new Date();
  const env = { ...ENV, TERM: 'xterm-256color', COLUMNS: '120', LINES: '40', ...extra(cwd) };
  const [command, argv] = commandFor(cwd);
  const ortBefore = ORT_FILES.map(snapshot);
  try {
    const r = STRACE ? await traceRun(command, argv, { cwd, env, timeoutMs: timeoutMs * SCALE, input })
      : await plainRun(command, argv, { cwd, env, timeoutMs: timeoutMs * SCALE, input });
    return { ...r, research: researchEgress(started), ortChanged: ORT_FILES.filter((f, i) => snapshot(f) !== ortBefore[i]) };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

function plainRun(command, args, { cwd, env, timeoutMs, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    if (input) input(child); else child.stdin.end();
    child.on('error', reject);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, egress: null }); });
  });
}

function snapshot(path) {
  if (!existsSync(path)) return 'absent';
  const walk = (p) => { const s = statSync(p); return s.isDirectory() ? readdirSync(p).map((e) => walk(join(p, e))).join('|') : `${p}:${s.size}:${s.mtimeMs}`; };
  return walk(path);
}

// Hosts the research servers' egress proxies opened since `since` (host names only, from the proxy logs).
function researchEgress(since) {
  const hosts = {};
  if (!existsSync(MCP_CACHE)) return hosts;
  for (const f of readdirSync(MCP_CACHE).filter((n) => n.endsWith('.egress.jsonl'))) {
    for (const line of readFileSync(join(MCP_CACHE, f), 'utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.event === 'open' && Date.parse(o.at) >= since.getTime()) hosts[o.host] = (hosts[o.host] ?? 0) + 1;
    }
  }
  return hosts;
}

function assertPrivate(r, allowed, label, { targets = [] } = {}) {
  assert.deepEqual(r.ortChanged, [], `${label}: onnxruntime wrote its telemetry files`);
  const research = Object.keys(r.research);
  assert.deepEqual(research.filter((h) => !RESEARCH.includes(h) && !targets.includes(h)), [], `${label}: research servers contacted other hosts`);
  if (!r.egress) return;
  const v = violations(r.egress, [...allowed, ...targets]);
  assert.deepEqual(v.denied, [], `${label}: telemetry, update or download hosts contacted`);
  assert.deepEqual(v.unexpected, [], `${label}: hosts outside the provider and research services (all: ${v.hosts.join(' ')})`);
  assert.deepEqual(v.unattributed, [], `${label}: connections to public addresses without a looked-up name`);
}

test('machine: no onnxruntime telemetry state (device id, event queue)', () => {
  for (const f of ORT_FILES) assert.equal(existsSync(f), false, `remove ${f}`);
});

test('egress observation is available (strace); without it only the research logs and files are checked', { skip: STRACE ? false : 'strace is not installed' }, () => {});

test('interactive start, Claude: the TUI comes up; no pi.dev catalog, version check or install ping', { skip: skipUnless(CLAUDE, 'Claude') }, async () => {
  const r = await mina(['--model', CLAUDE], { tui: 25 });
  assert.equal(r.code, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /haiku/i, 'the footer shows the model');
  assertPrivate(r, ANTHROPIC, 'interactive Claude');
});

test('interactive start, Codex: the TUI and the usage poll work; nothing else', { skip: skipUnless(CODEX_MODEL, 'Codex') }, async () => {
  const r = await mina(['--model', CODEX_MODEL], { tui: 25 });
  assert.equal(r.code, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /gpt/i);
  assertPrivate(r, CODEX, 'interactive Codex');
});

for (const [label, model, allowed] of [...(CLAUDES.length ? CLAUDES : [undefined]).map((m) => [`Claude${m ? ` (${m.split('/')[0]})` : ''}`, m, ANTHROPIC]),
  ['Codex', CODEX_MODEL, CODEX], ['local model', LOCAL ?? LOCAL_ID, []]]) {
  const skip = label === 'local model' ? localSkip : skipUnless(model, label);
  test(`one turn, ${label}: the answer comes back; only the provider is contacted`, { skip }, async () => {
    const r = await mina(['--model', model, '--no-session', '-p', 'Reply with exactly the word PONG and nothing else.']);
    assert.equal(r.code, 0, r.stderr.slice(-400));
    assert.match(r.stdout, /PONG/);
    assertPrivate(r, allowed, label);
  });
}

test('sandboxed command: a worker runs it (no network of its own); only the provider is contacted', { skip: skipUnless(CLAUDE, 'Claude') }, async () => {
  const r = await mina(['--model', CLAUDE, '--no-session', '-p', 'Run the shell command `echo WORKER-$((6*7))` with the bash tool and reply with its output only.']);
  assert.equal(r.code, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /WORKER-42/);
  assertPrivate(r, ANTHROPIC, 'sandboxed command');
});

test('subagent: it runs on the session provider and its answer comes back', { skip: skipUnless(CLAUDE, 'Claude') }, async () => {
  const r = await mina(['--model', CLAUDE, '--no-session', '-p',
    'Use the Agent tool to start one subagent in the foreground (run_in_background false) with the prompt "Reply with exactly SUBPONG". Then reply with exactly what it answered.']);
  assert.equal(r.code, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /SUBPONG/);
  assertPrivate(r, ANTHROPIC, 'subagent');
});

test('research: literature search and full text work; traffic goes only to the services the tools target', { skip: skipUnless(CLAUDE, 'Claude') }, async () => {
  const r = await mina(['--model', CLAUDE, '--no-session', '-p',
    'Use literature_search to find PubMed papers on "base editing sickle cell disease", then use paper_get to read the full text of arXiv:1706.03762. '
    + 'Reply on two lines: "PMID: <the PMID of one search result>" and "TITLE: <the exact title of the arXiv paper>".'], { timeoutMs: 600_000 });
  assert.equal(r.code, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /PMID:\s*\d{6,}/);
  assert.match(r.stdout, /attention is all you need/i);
  assert.ok(Object.keys(r.research).length > 0 || r.egress, 'research traffic was observed');
  assertPrivate(r, [...ANTHROPIC, ...RESEARCH], 'research');
});

// The two paths that load onnxruntime (pymupdf4llm's layout model), run directly: a prompt cannot force them.
const PDF_PATHS = join(REPO, 'test/e2e/pdf-paths.mjs');

test('Semantic Scholar full text: the PDF converts; onnxruntime sends nothing and writes no device id', async () => {
  const r = await observe(() => [process.execPath, [PDF_PATHS, 'semantic-scholar']], { timeoutMs: 400_000 });
  assert.equal(r.code, 0, r.stderr.slice(-400));
  assert.equal(JSON.parse(r.stdout).ok, true, r.stdout);
  assert.ok(r.research['api.semanticscholar.org'], 'the request went through the Semantic Scholar proxy');
  assertPrivate(r, RESEARCH, 'Semantic Scholar full text', { targets: ['elifesciences.org', 'cdn.elifesciences.org', 'doi.org'] });
});

test('broker full text from a PDF: downloaded and converted in the PDF sandbox; same text as before; nothing else sent', async () => {
  const r = await observe(() => [process.execPath, [PDF_PATHS, 'broker']], { timeoutMs: 400_000 });
  assert.equal(r.code, 0, r.stderr.slice(-400));
  const out = JSON.parse(r.stdout);
  assert.ok(out.ok && out.title, r.stdout);
  assertPrivate(r, ['arxiv.org'], 'broker PDF');
});
