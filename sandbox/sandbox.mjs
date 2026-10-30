// Trusted outer control plane, positive-mount inner command/file workers.
// No source-hiding rule is a security boundary. The kernel mount/PID/network namespaces are.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, readdirSync, readlinkSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NETWORK_LEVELS = ['open', 'packages', 'offline'];
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NETBRIDGE_PATH = join(REPO, 'lib', 'netbridge.mjs');
// Under the outer layer's private /tmp: the read-only root cannot take a new mount point under /run.
export const EGRESS_DIR = '/tmp/.mina-egress';
export const EGRESS_SOCKET = `${EGRESS_DIR}/proxy.sock`;
export const EGRESS_BRIDGE = `${EGRESS_DIR}/netbridge.mjs`;
// Node 22 warns at start-up that the EnvHttpProxyAgent behind NODE_USE_ENV_PROXY is experimental; the warning is noise in
// every sandboxed command's output. The bridge runs on mina's own Node (22 or newer), which accepts this flag.
export const BRIDGE_NODE_FLAGS = Object.freeze(['--disable-warning=UNDICI-EHPA']);
const PROXY_URL = 'http://127.0.0.1:3128';
export const EGRESS_ENV = Object.freeze({ HTTP_PROXY: PROXY_URL, HTTPS_PROXY: PROXY_URL, http_proxy: PROXY_URL, https_proxy: PROXY_URL,
  ALL_PROXY: PROXY_URL, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', NODE_USE_ENV_PROXY: '1' });

const expand = (p, home) => resolve(String(p).replace(/^~(?=$|\/)/, home));

// Writable outside the project by default: Pi's agent folder (sessions, sign-in refresh) and the usual caches.
// Claude Code state belongs to the trusted controller, never workers. Only the owner's SDK configuration can add
// profiles; project .pi/claude-sdk.json is deliberately not consulted. Mina accepts narrower roots than plain Pi.
const claudeConfigFile = (home, env) => {
  const agent = env.PI_CODING_AGENT_DIR?.trim() || join(home, '.pi', 'agent');
  if (!isAbsolute(agent)) throw new Error('mina sandbox: Claude owner agent directory must be absolute');
  return join(agent, 'claude-sdk.json');
};
// Claude Code's state: ~/.claude and ~/.claude.json, every ~/.claude-* or ~/.claude.* entry (other accounts' config
// folders, backups of .claude.json), and the configDir of every profile in the owner's claude-sdk.json.
export function claudeState(home, env = process.env) {
  let siblings = [];
  try { siblings = readdirSync(home).filter((name) => /^\.claude[-.]./.test(name)).sort().map((name) => join(home, name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = [...new Set([join(home, '.claude'), join(home, '.claude.json'), ...siblings])];
  const file = claudeConfigFile(home, env);
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') config = {};
    else throw new Error(`mina sandbox: invalid Claude profile configuration: ${file}`, { cause: error });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.profiles !== undefined && !Array.isArray(config.profiles))) {
    throw new Error('mina sandbox: Claude profiles must be an array');
  }
  const h = profileCanonical(home);
  const reserved = ['/usr', '/etc', '/dev', '/proc', '/sys', '/run', REPO, ...runtimeFiles, dirname(file)].map(profileCanonical);
  const unsafe = (p) => contains(p, h) || reserved.some((r) => contains(p, r) || contains(r, p));
  // Fixed profiles may already be symlinked to a separate private volume, but never to broad/runtime roots.
  for (const path of state) {
    if (unsafe(profileCanonical(path))) throw new Error(`mina sandbox: unsafe Claude profile state root: ${path}`);
  }
  for (const profile of config.profiles ?? []) {
    const path = profile?.configDir;
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
      throw new Error('mina sandbox: Claude profile configDir must be absolute');
    }
    const p = profileCanonical(path);
    if (!contains(h, p) || unsafe(p)) {
      throw new Error(`mina sandbox: unsafe Claude profile configDir (use a private home subdirectory): ${path}`);
    }
    state.push(p); // Preserve the resolved ancestor even before this directory exists (root overlap checks need it).
  }
  return [...new Set(state)];
}

// Resolve missing profile directories through their existing ancestors too; a symlink must not smuggle in an
// out-of-home target merely because its final directory has not been created yet. Dangling links fail closed.
function profileCanonical(path) {
  let p = resolve(path);
  const tail = [];
  while (true) {
    try { lstatSync(p); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(p) === p) throw new Error(`mina sandbox: cannot resolve Claude profile state root: ${path}`, { cause: error });
      tail.unshift(basename(p)); p = dirname(p);
    }
  }
  try { return join(realpathSync(p), ...tail); }
  catch (error) { throw new Error(`mina sandbox: cannot resolve Claude profile state root: ${path}`, { cause: error }); }
}

export function defaultWritable(home, env = process.env) {
  return [env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), env.XDG_CACHE_HOME || join(home, '.cache'), join(home, '.npm'), join(home, '.cargo'),
    ...claudeState(home, env)];
}

// Hidden from the agent's commands (the inner layer). Pi itself still reads its own sign-in. Other locations: "hide" in
// ~/.config/mina/sandbox.json. host/hostd.py hides the same paths from workload commands (HIDDEN there; a test compares).
export function defaultHidden(home, env = process.env) {
  const agent = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
  return [join(home, '.ssh'), join(home, '.gnupg'), join(home, '.aws'), join(home, '.netrc'), join(home, '.git-credentials'),
    join(home, '.docker'), join(home, '.config', 'gh'), join(home, '.config', 'mina', 'keys'),
    join(agent, 'auth.json'), join(agent, 'mcp-auth.json'), join(agent, 'mcp-oauth'), join(agent, 'pi-pkg-cfg', 'pi-web-search'),
    join(REPO, 'keys'), ...claudeState(home, env)];
}

// mina's own code is hidden from the agent's commands and its read tool too: in the live test run the agent read the
// gates' source to learn what would pass them, and once forged a closure that the parser accepted. The parts the agent
// is meant to read stay visible: mina's skills, and Pi's docs and examples (named in Pi's system prompt). When the
// project is mina itself (or inside it), nothing is hidden.
const PI_PKG = join(REPO, 'node_modules', '@earendil-works', 'pi-coding-agent');
export function minaCode(project) {
  const p = resolve(project);
  if (p === REPO || p.startsWith(`${REPO}${sep}`) || REPO.startsWith(`${p}${sep}`)) return { hidden: [], exposed: [] };
  return { hidden: [REPO], exposed: [join(REPO, 'skills'), join(PI_PKG, 'README.md'), join(PI_PKG, 'docs'), join(PI_PKG, 'examples')] };
}

// Environment variables the agent's commands do not get.
export const SECRET_ENV = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)/i;

// ~/.config/mina/sandbox.json: { "write": ["~/data/out"], "hide": [...], "network": "open" }
export function loadConfig(home = homedir(), env = process.env) {
  const file = env.MINA_SANDBOX_CONFIG || join(home, '.config', 'mina', 'sandbox.json');
  try { return { file, ...JSON.parse(readFileSync(file, 'utf8')) }; }
  catch (error) { if (error.code === 'ENOENT') return { file: null }; throw new Error(`mina: invalid sandbox configuration: ${file}`, { cause: error }); }
}

// The project: the git top level of the folder, else the folder itself.
export function projectRoot(cwd) {
  const r = spawnSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: homedir() } });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
}

// Why the sandbox cannot start here (null = it can): a project that is / or contains the home folder would make the home
// folder writable, which defeats the point.
export function projectProblem(project, home = homedir()) {
  const p = realpathSync(project), h = realpathSync(home);
  if (p === '/' || p === h || h.startsWith(p === '/' ? '/' : `${p}${sep}`)) {
    return `the project folder ${p} is or contains your home folder; cd into a project, or run mina --nosandbox`;
  }
  return null;
}

export const BWRAP_PATH = existsSync('/usr/bin/bwrap') ? '/usr/bin/bwrap' : '/bin/bwrap';
export const bwrapAvailable = () => spawnSync(BWRAP_PATH, ['--version'], { env: { PATH: '/usr/bin:/bin' } }).status === 0;

// The resolved sandbox settings, from flags, the config file and defaults.
export function settings({ cwd, home = homedir(), env = process.env, write = [], read = [], network = null, config = loadConfig(home, env) }) {
  const project = projectRoot(cwd);
  const level = network ?? config.network ?? 'open';
  if (!NETWORK_LEVELS.includes(level)) throw new Error(`mina: --sandbox-net must be one of ${NETWORK_LEVELS.join(', ')}, not ${level}`);
  const writable = [...new Set([project, ...(config.write ?? []).map((p) => expand(p, home)), ...write.map((p) => expand(p, home))])];
  validateTrustedResources([claudeConfigFile(home, env)], writable);
  const code = minaCode(project);
  const hidden = [...new Set([...defaultHidden(home, env), ...code.hidden, hostPaths({ env }).inside, ...(config.hide ?? []).map((p) => expand(p, home))])];
  const readable = [...new Set([...(config.read ?? []).map((p) => expand(p, home)), ...read.map((p) => expand(p, home))])];
  const problem = projectProblem(project, home);
  if (problem) throw new Error(`mina sandbox: ${problem}`);
  return { project, cwd, home, network: level, writable, readable, hidden, exposed: code.exposed, readOnly: [], config: config.file };

}

// The host broker (host/hostd.py, docs/host-profile.md): its socket folder on the host, and where the Pi process sees it
// and its session grant inside the outer layer. The agent's commands never see either (hidden in the inner layer).
export function hostPaths({ uid = process.getuid(), env = process.env } = {}) {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const inside = join(runtime, 'mina-host');
  return { brokerDir: env.MINA_HOSTD_RUNTIME || join(runtime, 'mina-hostd'), inside, socket: join(inside, 'hostd', 'sock'), grant: join(inside, 'grant') };
}

// Outer layer: bwrap arguments for the Pi process. Read-only root, private /tmp and runtime folder, then the writable
// binds (a project under /tmp is bound after the tmpfs, so it stays visible). With a host session, only the broker's
// socket folder and this launch's grant file come back into the private runtime folder: not the user bus, not the rest.
export function outerArgs(s, { uid = process.getuid(), env = process.env, host = null } = {}) {
  validateTrustedResources([claudeConfigFile(s.home || homedir(), env)], s.writable);
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const hp = hostPaths({ uid, env });
  return ['--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    ...(existsSync(runtime) ? ['--tmpfs', runtime] : []),
    ...(s.trustedPaths ?? []).filter(existsSync).flatMap((p) => ['--ro-bind', p, p]),
    ...[...new Set([...s.writable, ...defaultWritable(s.home || homedir(), env), ...(env.MINA_WORKER_HOME ? [env.MINA_WORKER_HOME] : []), ...(env.MINA_WORKER_OUTPUTS ? [env.MINA_WORKER_OUTPUTS] : [])])].filter((p) => existsSync(p)).flatMap((p) => ['--bind', p, p]),
    ...(host ? ['--bind', host.brokerDir, join(hp.inside, 'hostd'), '--ro-bind', host.grantFile, hp.grant] : []),
    '--die-with-parent', '--chdir', s.cwd];
}

// Explicit roots are owner declarations, not model-controlled configuration. A project cannot
// encompass the controller or its state. Symlink aliases are resolved before overlap checks.
const contains = (root, p) => root === p || p.startsWith(root === '/' ? '/' : `${root}/`);
const canonical = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const runtimeFiles = [fileURLToPath(import.meta.url), join(REPO, 'sandbox/worker.mjs'), NETBRIDGE_PATH, process.execPath];
export function validateRootPolicy(roots, trustedRoots = []) {
  const reserved = ['/usr', '/etc', '/dev', '/proc', '/sys', '/run', '/home/mina', ...runtimeFiles, ...trustedRoots].map(canonical);
  for (const root of roots.map(canonical)) {
    if (reserved.some((p) => contains(root, p) || contains(p, root))) {
      throw new Error(`mina sandbox: unsafe writable root overlaps trusted runtime/state: ${root}`);
    }
  }
}

// Follow each symlink step, not only its final target: an intermediate project link
// must not control a trusted resource that eventually points back outside the project.
export function validateTrustedResources(paths, writable) {
  const roots = writable.map(canonical);
  const visit = (path, depth = 0) => {
    if (depth > 40) throw new Error('mina sandbox: trusted resource symlink loop');
    const parts = resolve(path).split('/').filter(Boolean);
    let current = '/';
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      if (roots.some((root) => contains(root, current))) throw new Error(`mina sandbox: trusted resource traverses a writable root: ${path}`);
      let st;
      try { st = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (st.isSymbolicLink()) return visit(resolve(dirname(current), readlinkSync(current), ...parts.slice(i + 1)), depth + 1);
    }
  };
  for (const path of paths.filter(Boolean)) visit(path);
  return true;
}

// Startup preflight. Runtime calls validate mount policy without rescanning every file. Never follows directory symlinks,
// never mutates files, never scans outside declared roots. Host changes concurrent with
// execution are trusted and OUTSIDE the hardlink/socket guarantee. A new in-sandbox
// hardlink cannot cross from a read-only mount into a writable mount (Linux EXDEV).
// A hard-linked file in a writable root is refused: the agent owns the file, so it can chmod it and rewrite it in place,
// and that changes every other link to the inode, also one outside the sandbox (a local `git clone` links the source
// repository's objects). The scan finishes and reports all of them, bounded: counts and a few example paths.
// The same scan finds repositories whose git data is partly elsewhere (objects/info/alternates of a `git clone --shared`,
// the .git file of a git worktree). If that data exists but the sandbox does not show it (not in a writable or `readable`
// root, or `hidden`), git fails in the sandbox with errors that do not name the cause, so Mina refuses with the fixes.
export function validateWritableRoots(roots, { trustedRoots = [], readable = [], hidden = [] } = {}) {
  validateRootPolicy(roots, trustedRoots);
  const found = hardlinkFindings();
  for (const root of [...new Set(roots.map(canonical))]) scanRoot(root, true, found);
  if (found.total) throw new Error([
    `mina sandbox: writable hardlink: ${found.total} file${found.total === 1 ? '' : 's'} in the writable folders ${found.total === 1 ? 'has' : 'have'} more than one link (nlink > 1).`,
    'A change through a link in the sandbox also changes the other links, which can be outside the sandbox. Mina does not start.',
    ...hardlinkDetails(found)].join('\n'));
  const outside = gitDataOutside(found.gitRefs, { visible: [...roots, ...readable], hidden });
  if (outside.length) throw new Error(gitDataMessage(outside));
  return true;
}
// A read-only mount does not stop connect(2) to a Unix socket or a write to a FIFO, so either one in a data root is a channel
// to a process outside the sandbox. Device nodes are refused too. `st` is a Stats or a Dirent: both have these methods.
function refuseSpecial(p, st) {
  if (st.isSocket()) throw new Error(`mina sandbox: Unix socket in declared root; remove it or choose a narrower root: ${p}`);
  if (st.isBlockDevice() || st.isCharacterDevice() || st.isFIFO()) throw new Error(`mina sandbox: unsupported special file in declared root: ${p}`);
}
function scanRoot(root, writable, found = null) {
  const visit = (p, entry = null) => {
    // A readable root needs only the type of each entry, which the folder listing gives (Node runs lstat for an entry
    // whose filesystem does not report the type). A writable root also needs the link count, so lstat.
    const st = entry && !writable ? entry : lstatSync(p); // Errors (including permissions) fail closed.
    if (st.isSymbolicLink()) return;
    refuseSpecial(p, st);
    if (writable && st.isFile() && st.nlink > 1) addHardlink(found, p, st.nlink);
    if (writable && found && st.isFile() && (basename(p) === '.git' || p.endsWith(`${sep}objects${sep}info${sep}alternates`))) found.gitRefs.push(p);
    if (st.isDirectory()) for (const e of readdirSync(p, { withFileTypes: true })) visit(join(p, e.name), e);
  };
  visit(root);
}

// The scan of a read grant during a session (checkReadGrant): the refusals of scanRoot for a readable root, without blocking
// Pi. On a network mount (rclone, sshfs) each folder listing waits for the remote, so several listings run at once. They
// use the libuv thread pool (4 threads unless UV_THREADPOOL_SIZE), which Pi also needs for files and DNS: all scans together
// hold at most LISTING_SLOTS threads. No size or time limit: onProgress reports the counts, and the signal stops the scan.
const LISTING_SLOTS = 3;
let listingsActive = 0;
const listingWaiters = [];
async function listFolder(dir) {
  if (listingsActive < LISTING_SLOTS) listingsActive++;
  else await new Promise((r) => listingWaiters.push(r));                       // the slot passes directly to a waiter
  try { return await readdir(dir, { withFileTypes: true }); } finally {
    const next = listingWaiters.shift();
    if (next) next(); else listingsActive--;
  }
}
export async function scanReadableRoot(root, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const progress = { root, folders: 0, files: 0, current: root };
  onProgress(progress);
  const st = await lstat(root);                                                  // Errors (including permissions) fail closed.
  refuseSpecial(root, st);
  if (!st.isDirectory()) { progress.files = 1; onProgress(progress); return progress; }
  const folders = [root];
  let active = 0, failure = null;
  const list = async (dir) => {
    progress.current = dir;
    for (const e of await listFolder(dir)) {
      if (failure) return;
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      refuseSpecial(p, e);
      if (e.isDirectory()) folders.push(p); else progress.files++;
    }
    progress.folders++;
    onProgress(progress);
  };
  await new Promise((done, fail) => {
    // On abort or a refusal, return at once; a listing still waiting for the remote finishes in the background and is ignored.
    const finish = (error) => { signal?.removeEventListener('abort', stop); if (error) fail(error); else done(); };
    const stop = () => { failure ??= signal.reason; finish(failure); };
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop, { once: true });
    const pump = () => {
      if (failure) return finish(failure);
      if (!folders.length && !active) return finish();
      while (active < LISTING_SLOTS && folders.length) {
        active++;
        list(folders.pop()).then(() => { active--; pump(); }, (error) => { active--; failure ??= error; pump(); });
      }
    };
    pump();
  });
  return progress;
}

export const UNLINK_GIT_OBJECTS = 'mina sandbox unlink-git-objects';
const EXAMPLES = 5, REPOS_SHOWN = 3;
const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
// The working tree whose git object store holds this path (<repo>/.git/objects/**), else null.
export function gitObjectRepo(path) {
  const i = path.indexOf(`${sep}.git${sep}objects${sep}`);
  return i < 0 ? null : path.slice(0, i) || sep;
}
// Git data that a repository in the writable roots uses from elsewhere, which exists but is not visible in the sandbox.
// alternates: one object folder per line ('#' comments; relative to the objects folder). A .git file: "gitdir: PATH"
// (relative to its folder), and that folder's commondir for a git worktree. Missing targets are not reported: git fails
// on them outside the sandbox too.
export function gitDataOutside(files, { visible = [], hidden = [] } = {}) {
  const roots = visible.map(canonical), hide = hidden.map(canonical), out = [];
  const shown = (t) => roots.some((r) => contains(r, t)) && !hide.some((h) => contains(h, t));
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const targets = [];
    if (basename(file) === 'alternates') {
      for (const line of text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
        let path = line;
        if (line.startsWith('"')) try { path = JSON.parse(line); } catch { continue; }
        targets.push(resolve(dirname(dirname(file)), path));
      }
    } else {
      const m = /^gitdir: (.+)$/m.exec(text);
      if (!m) continue;
      const gitdir = resolve(dirname(file), m[1].trim());
      targets.push(gitdir);
      try { targets.push(resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim())); } catch { /* not a worktree */ }
    }
    for (const t of targets) {
      if (!existsSync(t)) continue;
      const target = canonical(t);
      if (!shown(target)) out.push({ kind: basename(file) === 'alternates' ? 'alternates' : 'gitfile', file, target });
    }
  }
  return out;
}
// The folders to show: each target once, without one that another target contains.
const outermost = (paths) => [...new Set(paths)].filter((p, _i, all) => !all.some((q) => q !== p && contains(q, p)));
export function gitDataMessage(outside) {
  const lines = ['mina sandbox: git will fail in the sandbox: a repository in the writable folders uses git data from a folder that the sandbox does not show. Mina does not start.'];
  const alt = outside.filter((o) => o.kind === 'alternates'), wt = outside.filter((o) => o.kind === 'gitfile');
  if (alt.length) {
    lines.push(...alt.slice(0, EXAMPLES).map((o) => `  ${o.file} borrows objects from ${o.target}`),
      ...(alt.length > EXAMPLES ? [`  ... and ${alt.length - EXAMPLES} more`] : []),
      'This is a clone made with `git clone --shared` or `--reference`. In the sandbox, git cannot read the borrowed objects and fails with errors such as "bad object HEAD".',
      'Fix one of these:',
      `  Show the borrowed objects read-only: add ${outermost(alt.map((o) => o.target)).slice(0, REPOS_SHOWN).map((t) => `--sandbox-read ${shellQuote(t)}`).join(' ')}`,
      '  Or copy them into the clone (outside Mina), then remove the link:',
      ...[...new Set(alt.map((o) => o.file))].slice(0, REPOS_SHOWN).map((f) => `    git --git-dir=${shellQuote(dirname(dirname(dirname(f))))} repack -a -d && rm ${shellQuote(f)}`));
  }
  if (wt.length) {
    const common = (o) => (basename(o.target) === '.git' ? o.target : null);
    lines.push(...wt.filter((o, i) => wt.findIndex((x) => x.file === o.file) === i).slice(0, EXAMPLES).map((o) => `  ${o.file} points to ${o.target}`),
      ...(wt.length > EXAMPLES ? [`  ... and ${wt.length - EXAMPLES} more`] : []),
      'This folder is a git worktree (or a submodule) whose git data is in another repository. In the sandbox, git fails with errors such as "not a git repository".',
      'Fix one of these:');
    const src = wt.map(common).find(Boolean);
    lines.push(`  Use a separate clone: git clone --no-hardlinks ${src ? shellQuote(dirname(src)) : '<source>'} <destination>`,
      `  Or show the git data: ${outermost(wt.map((o) => o.target)).slice(0, REPOS_SHOWN).map((t) => `--sandbox-read ${shellQuote(t)}`).join(' ')} (git can read, but not stage or commit),`,
      '    or --sandbox-write for the same folders (git can also commit, and the agent can then change that repository)');
  }
  return lines.join('\n');
}

// Hard-linked regular files, grouped by git object store, with a few examples of each kind. Memory stays bounded.
export function hardlinkFindings() {
  return { total: 0, repos: new Map(), other: 0, gitExamples: [], otherExamples: [], gitRefs: [] };
}
export function addHardlink(found, path, nlink) {
  found.total++;
  const repo = gitObjectRepo(path);
  if (repo) found.repos.set(repo, (found.repos.get(repo) ?? 0) + 1); else found.other++;
  const examples = repo ? found.gitExamples : found.otherExamples;
  if (examples.length < EXAMPLES) examples.push(`${path} (nlink=${nlink})`);
}
// The explanation, the examples, and the fixes for a set of findings (one line each; about 15 lines at most).
export function hardlinkDetails(found) {
  const git = found.total - found.other, repos = [...found.repos.keys()];
  const where = repos.length === 1 ? `${repos[0]}/.git/objects` : `the object stores of ${repos.length} git repositories`;
  const lines = [];
  if (git && !found.other) lines.push(`All of them are git objects in ${where}. This is almost certainly a \`git clone\` from a local path, which links the objects to the source repository.`);
  else if (git) lines.push(`${git} of them are git objects in ${where}, probably from a \`git clone\` from a local path. The other ${found.other} are not git objects.`);
  const examples = [...found.otherExamples, ...found.gitExamples].slice(0, EXAMPLES);
  lines.push('Examples:', ...examples.map((e) => `  ${e}`));
  if (found.total > examples.length) lines.push(`  ... and ${found.total - examples.length} more`);
  if (git) {
    lines.push('To repair an existing clone (this copies only its linked git objects; the source repository does not change):',
      ...repos.slice(0, REPOS_SHOWN).map((r) => `  ${UNLINK_GIT_OBJECTS} ${shellQuote(r)}`));
    if (repos.length > REPOS_SHOWN) lines.push(`  ... and ${repos.length - REPOS_SHOWN} more repositories`);
    lines.push('For a new clone from a local path:', '  git clone --no-hardlinks <source> <destination>');
  }
  if (found.other) lines.push(`${git ? 'For the files that are not git objects: remove' : 'Remove'} them, or give each file its own copy, for example: cp -p FILE FILE.copy && mv FILE.copy FILE`);
  return lines;
}

// Positive command environment. In particular, no ambient application variables,
// credentials, shell startup hooks, dynamic-loader hooks, or Node/Python options.
export const COMMAND_ENV = /^(PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TZ|CC|CXX|CPP|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|AR|AS|LD|FC|MAKEFLAGS|CMAKE_BUILD_PARALLEL_LEVEL|SOURCE_DATE_EPOCH|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL))$/;
function refusePrivateOverlap(p, trustedRoots) {
  if (trustedRoots.map(canonical).some((r) => contains(p, r) || contains(r, p))) throw new Error(`mina sandbox: readable root overlaps private controller state: ${p}`);
}
export function validateReadableRoots(roots, { trustedRoots = [] } = {}) {
  for (const root of roots) {
    const p = canonical(root);
    refusePrivateOverlap(p, trustedRoots);
    scanRoot(p, false);
  }
  return true;
}

// Read access the owner grants during a session (mina_sandbox_request in extensions/sandbox): the rules of --sandbox-read
// at launch, plus no broad roots and no hidden credential path. Returns { path } (canonical) and whether it is already
// visible; rejects with the reason otherwise. Write access cannot be granted this way: the outer layer's mounts are fixed.
// The scan (scanReadableRoot) reports through onProgress and stops at the signal. A path inside one in `scanned` (a scan
// that passed earlier in the session) is not scanned again: like the launch scan, a scan covers the moment it ran.
// The result's `scan` is the counts of the scan, or null without one.
export async function checkReadGrant(path, { readable = [], writable = [], hidden = [], privateRoots = [], home = homedir(),
  scanned = [], signal, onProgress } = {}) {
  const p = canonical(path);
  if (!existsSync(p)) throw new Error(`mina sandbox: ${p} does not exist as mina sees the host`);
  if ([...writable, ...readable].some((r) => contains(canonical(r), p))) return { path: p, already: true };
  const broad = ['/', '/dev', '/proc', '/sys', '/run', '/tmp', home].find((r) => contains(p, canonical(r)));
  if (broad) throw new Error(`mina sandbox: ${p} is too broad: it is or contains ${broad}`);
  // Hidden paths inside p stay masked by innerArgs; p inside one is refused.
  if (hidden.some((h) => contains(canonical(h), p))) throw new Error(`mina sandbox: ${p} is inside a hidden credential path`);
  refusePrivateOverlap(p, privateRoots);
  if (scanned.some((r) => contains(canonical(r), p))) return { path: p, already: false, scan: null };
  return { path: p, already: false, scan: await scanReadableRoot(p, { signal, onProgress }) };
}

export function scrubEnv(env = {}) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => COMMAND_ENV.test(k) && !SECRET_ENV.test(k) && typeof v === 'string'));
}

const listEnv = (env, key) => {
  if (env[key] === undefined) return [];
  let value;
  try { value = JSON.parse(env[key]); } catch { throw new Error(`mina sandbox: invalid ${key}`); }
  if (!Array.isArray(value) || value.some((p) => typeof p !== 'string' || !p.startsWith('/'))) throw new Error(`mina sandbox: invalid ${key}`);
  return value;
};
// Shared by hooks, checks and file clients. Configuration stays in the controller;
// none of the MINA_* fields are copied to the command environment.
export function sandboxSettingsFromEnv(env = process.env, { cwd = process.cwd() } = {}) {
  const network = env.MINA_SANDBOX_NET ?? 'open';
  if (!NETWORK_LEVELS.includes(network)) throw new Error('mina sandbox: invalid MINA_SANDBOX_NET');
  const project = env.MINA_SANDBOX_PROJECT || cwd;
  return { cwd, project, writable: env.MINA_SANDBOX_WRITE === undefined ? [project] : listEnv(env, 'MINA_SANDBOX_WRITE'),
    readable: listEnv(env, 'MINA_SANDBOX_READ'), hidden: listEnv(env, 'MINA_SANDBOX_HIDE'),
    exposed: listEnv(env, 'MINA_SANDBOX_EXPOSE'), readOnly: listEnv(env, 'MINA_SANDBOX_READONLY'), network };
}

// Every worker has an empty root. /usr is trusted OS/runtime software, not a host
// filesystem passthrough. Legacy distro aliases are reproduced, with old non-merged
// /bin and /lib directories mounted read-only when necessary.
export function innerArgs({ cwd, project = cwd, writable = [project], readable = [], hidden = [], exposed = [], readOnly = [],
  network = 'offline', egressSocket = null, env = process.env, protectedChecksSnapshot = null, projectionMounts = [] }) {
  if (!NETWORK_LEVELS.includes(network)) throw new Error('mina sandbox: invalid network level');
  if (network !== 'offline' && !egressSocket) throw new Error(`mina sandbox: ${network} network needs the egress proxy`);
  if (!cwd || !project) throw new Error('mina sandbox: cwd and project required');
  const writes = [...new Set(writable.map(canonical))];
  const reads = [...new Set([...readable, ...readOnly.filter(existsSync), ...exposed.filter(existsSync)].map(canonical))];
  validateTrustedResources([claudeConfigFile(homedir(), env)], writes);
  validateRootPolicy(writes, defaultWritable(homedir(), env));
  // Refuse broad data mounts that would import host control sockets or runtime paths.
  for (const p of reads) {
    if (['/', '/dev', '/proc', '/sys', '/run', '/tmp', homedir()].some((r) => contains(p, canonical(r)))) {
      throw new Error(`mina sandbox: unsafe readable root: ${p}`);
    }
  }
  const a = ['--unshare-user', '--disable-userns', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net',
    '--cap-drop', 'ALL', '--new-session', '--die-with-parent', '--hostname', 'mina-worker',
    '--ro-bind', '/usr', '/usr'];
  for (const p of ['/bin', '/sbin', '/lib', '/lib64']) {
    if (!existsSync(p)) continue;
    if (lstatSync(p).isSymbolicLink()) {
      const target = canonical(p);
      if (!contains('/usr', target)) throw new Error(`mina sandbox: unsupported system alias ${p}`);
      a.push('--symlink', readlinkSync(p), p);
    } else a.push('--ro-bind', p, p);
  }
  // No /etc tree, passwd/shadow, machine-id, host services, cgroups, or user bus.
  for (const p of ['/etc/ld.so.cache', '/etc/nsswitch.conf', '/etc/hosts', '/etc/resolv.conf', '/etc/localtime',
    '/etc/ssl/certs', '/etc/ca-certificates/extracted', '/etc/pki/tls/certs']) {
    if (existsSync(p)) a.push('--ro-bind', p, p);
  }
  a.push('--dev', '/dev', '--proc', '/proc', '--size', String(1024 ** 3), '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/home/mina',
    '--ro-bind', process.execPath, '/run/mina-node', '--ro-bind', join(REPO, 'sandbox/worker.mjs'), '/run/mina-file-worker.mjs');
  // Parents before children, read-only overrides last. Distinct bind mounts prevent
  // link(2) from importing an inode from a read-only data root into a write root.
  const mounts = [...writes.map((p) => [p, '--bind']), ...reads.map((p) => [p, '--ro-bind'])]
    .sort((a, b) => a[0].split('/').length - b[0].split('/').length || (a[1] === '--ro-bind' ? 1 : -1));
  for (const [p, flag] of mounts) a.push(flag, p, p);
  a.push(...projectionMounts);
  if (projectionMounts.length) for (const p of reads.filter((p) => contains(canonical(project), p))) a.push('--ro-bind', p, p);
  if (protectedChecksSnapshot) a.push('--ro-bind', protectedChecksSnapshot.source, protectedChecksSnapshot.target);
  const visible = [...writes, ...reads];
  const targets = [...new Set(hidden.filter(existsSync).map(canonical))]
    .filter((p) => visible.some((r) => contains(r, p)));
  for (const p of targets) a.push(...(statSync(p).isDirectory() ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p]));
  for (const p of exposed.filter(existsSync).map(canonical)) a.push('--ro-bind', p, p);
  for (const p of targets.filter((p) => statSync(p).isDirectory())) a.push('--remount-ro', p);
  if (env.MINA_WORKER_HOME) a.push('--bind', env.MINA_WORKER_HOME, '/home/mina');
  if (env.MINA_WORKER_OUTPUTS) a.push('--ro-bind', env.MINA_WORKER_OUTPUTS, '/run/mina-outputs');
  const commandEnv = { ...scrubEnv(env), PATH: env.MINA_WORKER_PATH || env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: '/home/mina', TMPDIR: '/tmp',
    XDG_CACHE_HOME: '/home/mina/.cache', XDG_CONFIG_HOME: '/home/mina/.config', XDG_DATA_HOME: '/home/mina/.local/share',
    XDG_STATE_HOME: '/home/mina/.local/state', XDG_RUNTIME_DIR: '/run' };
  if (network !== 'offline') {
    if (!lstatSync(egressSocket).isSocket()) throw new Error('mina sandbox: egress endpoint is not a Unix socket');
    a.push('--dir', EGRESS_DIR, '--ro-bind', egressSocket, EGRESS_SOCKET, '--ro-bind', NETBRIDGE_PATH, EGRESS_BRIDGE);
    Object.assign(commandEnv, EGRESS_ENV, { MINA_EGRESS_SOCKET: EGRESS_SOCKET });
  }
  a.push('--clearenv', ...Object.entries(commandEnv).flatMap(([k, v]) => ['--setenv', k, v]), '--remount-ro', '/', '--chdir', canonical(cwd));
  return a;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function wrapCommand(command, options) {
  const { shell = '/bin/bash', node = process.execPath, network = 'offline' } = options;
  if (options.protectedChecksSnapshot) {
    const source = options.env ?? process.env;
    const env = { ...scrubEnv(source) };
    for (const key of ['MINA_WORKER_HOME', 'MINA_WORKER_PATH', 'MINA_WORKER_OUTPUTS', 'PI_CODING_AGENT_DIR', 'XDG_CACHE_HOME']) if (source[key]) env[key] = source[key];
    const data = Buffer.from(JSON.stringify({ command, options: { ...options, env } })).toString('base64');
    return `exec /usr/bin/env -i PATH=/usr/bin:/bin ${q(process.execPath)} ${q(join(REPO, 'sandbox/check-runner.mjs'))} ${q(data)}`;
  }
  const args = innerArgs(options);
  const run = network !== 'offline' ? ['/run/mina-node', ...BRIDGE_NODE_FLAGS, EGRESS_BRIDGE, '--', shell, '--noprofile', '--norc', '-c', command] : [shell, '--noprofile', '--norc', '-c', command];
  return `exec /usr/bin/env -i PATH=/usr/bin:/bin ${BWRAP_PATH} ${args.map(q).join(' ')} -- ${run.map(q).join(' ')}`;
}

// Whether `path` (absolute, or relative to cwd) is inside one of `roots`, resolving symlinks through the nearest
// existing ancestor, so a link inside the project cannot point a write outside it.
export function insideAny(path, roots, cwd) {
  let p = resolve(cwd, String(path));
  let probe = p, tail = '';
  while (!existsSync(probe) && dirname(probe) !== probe) { tail = join(basename(probe), tail); probe = dirname(probe); }
  try { p = join(realpathSync(probe), tail); } catch { /* keep the lexical path */ }
  return roots.some((r) => { let root = r; try { root = realpathSync(r); } catch { /* missing */ } return p === root || p.startsWith(`${root}${sep}`); });
}
