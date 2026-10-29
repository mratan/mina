// Trusted Pi control plane. All supported local tools, including user bash, use kernel workers.
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { bwrapAvailable, insideAny, REPO, sandboxSettingsFromEnv, checkReadGrant } from '../../sandbox/sandbox.mjs';
import { createEgressProxy } from '../../lib/egress-proxy.mjs';
import { oneDialog } from '../../lib/dialog-lock.mjs';
import { runFileOperation, workerBashOperations } from '../../sandbox/worker-client.mjs';
import { createSandboxTools } from './tools.mjs';

export function sandboxSettings(env = process.env) {
  return { on: env.MINA_SANDBOX === '1', ...sandboxSettingsFromEnv(env) };
}

// How long the dialog for a read request waits before mina queues it for /mina-sandbox (the user may be away).
export const GRANT_WAIT_MS = 5 * 60 * 1000;
const ALLOW = 'Allow read-only access until mina exits';
const DENY = 'Deny';

// What the agent's commands and file tools can see, from the live settings (read grants included).
export function sandboxNote(s, readable) {
  const list = (xs) => (xs.length ? xs.join(', ') : 'none');
  return `Your commands and file tools see: writable ${list(s.writable)}; read-only ${list(readable)}; and read-only system software. `
    + 'Other host paths do not exist for them ("No such file or directory"). HOME is /home/mina and lasts only until mina exits; '
    + '/tmp is emptied after every command; environment variables you set last only for that command. Keep what must last in a writable folder.\n'
    + 'If the task needs a file or folder outside these, ask with mina_sandbox_request: read-only access, decided by the user, applied from your '
    + 'next command (subagents and checks included) until mina exits. Write access elsewhere needs the user to restart mina with '
    + '--sandbox-write PATH: say which path and why.';
}

export default function minaSandbox(pi, { env = process.env, available = bwrapAvailable(), makeProxy = createEgressProxy, grantWaitMs = GRANT_WAIT_MS } = {}) {
  const s = sandboxSettings(env);
  if (!s.on) return;
  // Read grants. Every command and file operation builds its sandbox from env (sandbox/worker-client.mjs), and subagents
  // and goal checks read the same env, so a grant applies from the next call until mina exits. Only the user grants.
  const readable = () => sandboxSettingsFromEnv(env).readable;
  const privateRoots = () => { try { return JSON.parse(env.MINA_SANDBOX_PRIVATE ?? '[]'); } catch { return []; } };
  const pending = [];
  const grant = (path) => { env.MINA_SANDBOX_READ = JSON.stringify([...readable(), path]); };
  const keep = (p) => `To keep it for later sessions: mina --sandbox-read ${p}, or add it to "read" in ~/.config/mina/sandbox.json.`;
  const ask = (ctx, req, options) => ctx.ui.select(`The agent asks to read ${req.path} (read-only).\nReason: ${req.reason}\n`
    + `It applies to the agent's commands, file tools, subagents and checks until mina exits. ${keep(req.path)}`, [ALLOW, DENY], options);
  const settle = (req, choice) => {
    pi.appendEntry?.('mina-sandbox', { at: new Date().toISOString(), kind: 'read', path: req.path, reason: req.reason, decision: choice === ALLOW ? 'allowed' : 'denied' });
    if (choice === ALLOW) grant(req.path);
    return choice === ALLOW ? `The user allowed read-only access to ${req.path}. It applies from your next command or file tool call.`
      : `The user denied read access to ${req.path}. Do not work around it; continue without it or explain what it blocks.`;
  };
  const queue = (ctx, req, why) => {
    if (!pending.some((r) => r.path === req.path)) pending.push(req);
    try { ctx?.ui?.notify?.(`mina: the agent asks to read ${req.path}. Decide with /mina-sandbox.`, 'warning'); } catch { /* no UI */ }
    return `${why} mina queued the request; the user decides with /mina-sandbox. Continue with other work meanwhile, or wait for the answer.`;
  };
  pi.registerTool({
    name: 'mina_sandbox_request',
    label: 'Request access',
    description: 'Ask the user for read-only access to a host file or folder that your commands and file tools cannot see. Give the absolute '
      + 'host path (~ is the owner\'s home, not /home/mina) and why the task needs it. If allowed, it applies from your next call until mina exits. '
      + 'Write access outside the writable folders cannot be granted here.',
    parameters: { type: 'object', additionalProperties: false, required: ['path', 'reason'],
      properties: { path: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } } },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const asked = resolve(ctx?.cwd ?? s.project, String(params.path).replace(/^~(?=$|\/)/, homedir()));
      let checked;
      try { checked = checkReadGrant(asked, { readable: readable(), writable: s.writable, hidden: s.hidden, privateRoots: privateRoots() }); }
      catch (error) { return { content: [{ type: 'text', text: `${error.message}. The request was not shown to the user.` }], isError: true }; }
      if (checked.already) return { content: [{ type: 'text', text: `${checked.path} is already visible to your commands and file tools.` }] };
      const req = { path: checked.path, reason: String(params.reason).trim() };
      if (!ctx?.hasUI || typeof ctx.ui?.select !== 'function') return { content: [{ type: 'text', text: queue(ctx, req, 'There is no interactive user.') }] };
      const { choice, waited = 0 } = await oneDialog(async () => {                     // the timeout starts when the dialog shows
        const t0 = Date.now();
        return { choice: await ask(ctx, req, { timeout: grantWaitMs, signal: signal ?? undefined }), waited: Date.now() - t0 };
      }, signal) ?? {};
      if (choice === undefined && signal?.aborted) return { content: [{ type: 'text', text: 'The request was cancelled before the user decided. Nothing changed.' }] };
      if (choice === undefined) {
        if (waited >= grantWaitMs - 50) return { content: [{ type: 'text', text: queue(ctx, req, `Nobody answered within ${Math.round(grantWaitMs / 60000) || 1} minute(s).`) }] };
        return { content: [{ type: 'text', text: 'The user closed the dialog without deciding. Nothing changed.' }] };
      }
      return { content: [{ type: 'text', text: settle(req, choice) }], details: { path: req.path, decision: choice === ALLOW ? 'allowed' : 'denied' } };
    },
  });
  pi.registerCommand?.('mina-sandbox', {
    description: 'Decide the agent\'s queued read requests, or show what its commands can read and write',
    handler: async (_args, ctx) => {
      if (!pending.length) { ctx?.ui?.notify?.(`mina sandbox: no request is waiting.\n${sandboxNote(s, readable())}`, 'info'); return; }
      if (!ctx?.hasUI) { ctx?.ui?.notify?.('mina: /mina-sandbox needs the interactive dialog.', 'error'); return; }
      while (pending.length) {
        const req = pending[0];
        const choice = await oneDialog(() => ask(ctx, req));
        if (choice === undefined) return;                                              // closed: still waiting
        pending.shift();
        pi.sendMessage({ customType: 'mina-sandbox', display: true, content: settle(req, choice) }, { triggerTurn: true });
      }
    },
  });
  pi.on('before_agent_start', (event) => {
    const o = event.systemPromptOptions;
    if (o) o.sections = { ...(o.sections ?? {}), sandbox: sandboxNote(s, readable()) };
    return undefined;
  });
  let proxy = null;
  const getEgressSocket = () => proxy?.socketPath ?? null;
  globalThis[Symbol.for('mina:worker-egress')] = getEgressSocket;
  for (const tool of createSandboxTools({ env, getEgressSocket })) {
    if (!available) tool.execute = async () => { throw new Error('mina sandbox: bubblewrap is unavailable; tool refused.'); };
    pi.registerTool(tool);
  }
  const operations = workerBashOperations({ env, getEgressSocket });
  pi.on('user_bash', () => ({ operations }));
  pi.on('session_start', async () => {
    if (s.network === 'offline' || proxy) return;
    const next = makeProxy({ level: s.network, socketDir: join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'mina', 'egress') });
    await next.start();
    proxy = next;
  });
  pi.on('session_shutdown', async () => {
    const previous = proxy; proxy = null;
    if (previous) await previous.close().catch(() => {});
    if (globalThis[Symbol.for('mina:worker-egress')] === getEgressSocket) delete globalThis[Symbol.for('mina:worker-egress')];
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (env.MINA_MODE !== 'full') return;
    const parts = [];
    for (const path of [...new Set([ctx.cwd, s.project].filter(Boolean))].flatMap((dir) => [join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md')])) {
      try {
        const content = await runFileOperation('read', { path, limit: 65536 }, { cwd: ctx.cwd, env });
        parts.push(`### ${path}\n${content.toString()}`);
      } catch (error) {
        if (error.code !== 'ENOENT') parts.push(`Project guidance unavailable through the sandbox: ${path}`);
      }
    }
    if (parts.length) event.systemPromptOptions.sections.identity = `${event.systemPromptOptions.sections.identity ?? ''}\n\n<project-guidance>\n${parts.join('\n\n')}\n</project-guidance>`;
  });
  pi.on('tool_call', (event, ctx) => {
    const path = event.input?.path;
    if (!path) return undefined;
    if (['write', 'edit'].includes(event.toolName)) {
      if (insideAny(path, s.readOnly, ctx.cwd)) return { block: true, reason: `mina sandbox: ${path} is read-only.` };
      if (!insideAny(path, s.writable, ctx.cwd)) return { block: true,
        reason: `mina sandbox: ${path} is outside the writable folders. The owner can add a folder with --sandbox-write.` };
    }
    if (event.toolName === 'read' && insideAny(path, s.hidden, ctx.cwd) && !insideAny(path, s.exposed, ctx.cwd)) {
      return { block: true, reason: insideAny(path, [REPO], ctx.cwd)
        ? `mina sandbox: ${path} is mina's own code, not part of the task. Source hiding is not an authority boundary.`
        : `mina sandbox: ${path} is a hidden credential path.` };
    }
    return undefined;
  });
}
