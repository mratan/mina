// mina engineering-host profile, the Mina side (docs/host-profile.md). The host broker (host/hostd.py) runs outside the
// sandbox and holds the authority; this extension is its only client in the session:
// - the mina_host tool: a fixed list of broker operations on what the user registered in ~/.config/mina/host.json;
// - the capability manifest: what is AVAILABLE, BLOCKED or REQUIRES AUTHORIZATION, in the system prompt and in
//   .mina/host-capabilities.json, so the agent neither retries what it cannot do nor asks the user to do what it can;
// - alarm delivery: the broker's monitors run on the host, independent of this session; their alarms are put into the
//   conversation here and acknowledged only after that, so an alarm raised during a handoff reaches the successor.
// - policy proposals: the agent can propose a change to host.json for its own project (policy_propose); the broker
//   computes the diff and the risk flags, and the user approves the exact change in the dialog, every time.
// The broker accepts the session grant only from this Pi process, never from a command the agent runs, and a subagent's
// copy of this extension (loaded while the parent's is live) registers nothing: subagents get no host operations.
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '../../sandbox/project-fs.mjs';
import { join } from 'node:path';
import { oneDialog } from '../../lib/dialog-lock.mjs';

const CLAIM = Symbol.for('mina:host-claim');
const POLL_MS = 10_000;
const CONFIRMATION_PROTOCOL = 'mina-confirmation-v1';
const MUTATION_PROTOCOL = 'mutate_v2';
const REQUEST_PROTOCOL = 'mina-workload-request-v1';
const POLICY_PROTOCOL = 'mina-policy-v1';
const MUTATIONS = new Set(['service_restart', 'reserve', 'release', 'workload_run', 'workload_stop', 'monitor_add', 'monitor_remove',
  'policy_propose']);
const ACTIONS = ['capabilities', 'inventory', 'service_status', 'service_logs', 'service_restart', 'reserve', 'release', 'workload_run',
  'workload_status', 'workload_budget', 'workload_output', 'workload_stop', 'monitor_add', 'monitor_list', 'monitor_remove', 'alarms',
  'policy_propose'];
// The whole manifest of a project that is not registered: one line in the system prompt of every turn.
export const UNREGISTERED_MANIFEST = 'Host broker: this project is not registered. If you need GPUs or host jobs, mina_host inventory '
  + 'shows the machine, and mina_host policy_propose asks the user to approve a registration.\n';

// One request, one connection, one JSON line each way.
export function request(socket, req, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let data = '', finished = false;
    const c = connect(socket);
    const uncertain = (message, code = 'BLOCKED') => ({ ok: false, error: { code, message,
      remediation: 'The user starts it: systemctl --user start mina-hostd (install once: python3 <mina>/host/hostd.py install).',
      ...(req.op === MUTATION_PROTOCOL && req.action === 'workload_run' && req.args?.request_id
        ? { request_id: req.args.request_id, outcome: 'unknown',
          remediation: 'Look up workload_status with this request_id. No cancellation is implied; do not invent a new submission ID.' } : {}) } });
    const done = (out) => { if (finished) return; finished = true; clearTimeout(timer); c.destroy(); resolve(out); };
    const failed = (message, code) => done(uncertain(`${message}. Outcome unknown; inspect workload_status before retrying.`, code));
    const timer = setTimeout(() => failed(`host broker did not answer in ${timeoutMs / 1000}s`), timeoutMs);
    c.on('connect', () => c.write(`${JSON.stringify(req)}\n`));
    c.on('data', (d) => { data += d; if (data.endsWith('\n')) { try { done(JSON.parse(data)); } catch { failed('host broker returned an invalid reply', 'FAILED'); } } });
    c.on('error', (e) => failed(`host broker unreachable: ${e.code ?? 'connection error'}`));
    c.on('end', () => { if (!finished) failed('host broker closed without a complete reply'); });
    c.on('close', () => { if (!finished) failed('host broker connection was lost'); });
  });
}

const UPGRADE = 'The operator must upgrade mina-hostd at a safe boundary; this client refuses legacy mutations.';
function clientCapabilities(caps) {
  if (caps.confirmation_protocol === CONFIRMATION_PROTOCOL && caps.mutation_protocol === MUTATION_PROTOCOL) return caps;
  return { ...caps, client_mutations: 'BLOCKED: unsupported mutation or confirmation protocol', capabilities: caps.capabilities.map((c) =>
    /^(resource:|workload:|process_containment$|monitoring$|policy_propose$)|^service:.*:restart$/.test(c.capability)
      ? { ...c, broker_status: c.broker_status ?? c.status, status: 'BLOCKED', remediation: UPGRADE } : c) };
}

// The manifest the planner reads: stable text (no timestamps), so it changes only when a capability does.
export function manifestText(caps, unavailable = null) {
  const head = '## Host capabilities (mina-hostd)\n';
  if (unavailable) {
    return `${head}Host broker: BLOCKED (${unavailable.message}). Service control, GPU reservations, contained workloads and `
      + 'durable monitors are not available in this session. Do not work around this with bash; tell the user once: '
      + `${unavailable.remediation ?? 'start mina-hostd'}.\n`;
  }
  // Facts only, short: it is in the system prompt of every turn (it was 3.5K characters with full details and advice).
  // The details are one mina_host capabilities call away.
  if (caps.registered === false && caps.policy_protocol === POLICY_PROTOCOL) return UNREGISTERED_MANIFEST;
  caps = clientCapabilities(caps);
  const by = (s) => caps.capabilities.filter((c) => c.status === s);
  const params = (c) => {
    // A workload's time cap is stated, so the agent does not guess max_s (IV-1a: one refused 3600 s request).
    const max = c.capability.startsWith('workload:') && /, max (\d+)s/.exec(c.detail ?? '');
    const m = /params \[([^\]]*)\]/.exec(c.detail ?? '');
    if (!m) return max ? ` (max ${max[1]}s)` : '';
    const values = [...(c.detail ?? '').matchAll(/; (\w+) from ([A-Z0-9_|]+)/g)].map((v) => `; ${v[1]}: comma list of ${v[2]}`).join('');
    return ` (${max ? `max ${max[1]}s; ` : ''}params ${m[1].replace(/'/g, '')}${values}${/takes command/.test(c.detail) ? '; takes a command' : ''})`;
  };
  const line = (c) => `- ${c.capability}${params(c)}${c.status !== 'AVAILABLE' && c.remediation ? `: ${c.remediation}` : ''}`;
  return `${head}AVAILABLE: you can do it with mina_host. REQUIRES AUTHORIZATION: it needs the user (mina_host asks where it can). `
    + 'BLOCKED: not possible now. mina_host capabilities gives the details. Subagents cannot use mina_host.\n'
    + `AVAILABLE:\n${by('AVAILABLE').map(line).join('\n') || '- none'}\n`
    + `REQUIRES AUTHORIZATION:\n${by('REQUIRES_AUTHORIZATION').map(line).join('\n') || '- none'}\n`
    + `BLOCKED:\n${by('BLOCKED').map(line).join('\n') || '- none'}\n`;
}

const text = (out) => {
  const s = JSON.stringify(out.ok ? out.result : out.error, null, 1);
  const charge = out.error?.budget_charged === true
    ? `Admission ${out.error.admission_id} remains charged. Inspect workload_status before retrying.\n` : '';
  const submission = out.error?.request_id ? `Submission ${out.error.request_id}. Inspect workload_status by request_id.\n` : '';
  // Output pages are bounded by the broker (8192 source bytes). Keep their
  // cursor and exact base64 bytes intact even when JSON escaping expands text.
  if (out.ok && out.result?.kind === 'workload_output') return s;
  return submission + charge + (s.length > 12_000 ? `${s.slice(0, 12_000)}\n... (truncated)` : s);
};

// The dialog: Pi shows the whole message (it wraps long lines and cuts nothing), in the editor slot under the chat. A
// message taller than the terminal pushes its start (the header, the agent's reason, the risk flags) into the
// scrollback, so a long one is first also put into the chat in full, and the title says so.
export const DIALOG_CHROME_LINES = 10;   // the borders, spacers, Yes/No and the key hint of Pi's selector
export function wrappedLines(message, columns) {
  const width = Math.max(10, (columns || 80) - 2);
  return message.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil([...line].length / width)), 0);
}
async function confirmPrompt(ctx, action, prompt, terminal) {
  const title = action === 'policy_propose' ? 'mina host: change the host policy' : 'mina host operation';
  const rows = terminal.rows, tall = rows > 0 && wrappedLines(prompt, terminal.columns) + 1 + DIALOG_CHROME_LINES > rows;
  if (tall) {
    try { ctx.ui.notify?.(`${title} (the full text of the dialog below)\n${prompt}`, 'warning'); } catch { /* the dialog has it too */ }
  }
  return ctx.ui.confirm(tall ? `${title} (long: scroll up for its start; the full text is also in the chat above)` : title, prompt);
}

export default function minaHost(pi, { env = process.env, pollMs = POLL_MS, terminal = process.stdout } = {}) {
  const socket = env.MINA_HOST_SOCKET;
  if (!socket && !env.MINA_HOST_UNAVAILABLE) return; // the profile is off
  // At most one live instance per process holds the session: the top-level one. A handoff shuts the old instance down
  // before the new one loads; a subagent's instance loads while the parent's is live, and so gets nothing.
  if (globalThis[CLAIM]?.live) return;
  const claim = { live: true };
  globalThis[CLAIM] = claim;
  let grant = null;
  try { grant = readFileSync(env.MINA_HOST_GRANT_FILE, 'utf8').trim(); } catch { /* reported below */ }
  const unavailable = env.MINA_HOST_UNAVAILABLE ? { message: env.MINA_HOST_UNAVAILABLE, remediation: 'systemctl --user start mina-hostd' }
    : !grant ? { message: 'no host session grant', remediation: 'restart mina with mina-hostd running' } : null;
  const call = (op, args = {}) => (unavailable ? Promise.resolve({ ok: false, error: { code: 'BLOCKED', ...unavailable } })
    : request(socket, MUTATIONS.has(op) ? { op: MUTATION_PROTOCOL, action: op, args, grant, ...(op === 'workload_run' ? { request_protocol: REQUEST_PROTOCOL } : {}) } : { ...args, op, grant }))
    .then((out) => op === 'capabilities' && out.ok ? { ...out, result: clientCapabilities(out.result) } : out);

  let manifest = unavailable ? manifestText(null, unavailable) : '## Host capabilities (mina-hostd)\nNot checked yet: call mina_host capabilities.\n';
  let timer = null, polling = false;

  async function refresh(ctx, force = false) {
    if (unavailable) return;
    const out = await call('capabilities', { refresh: force });
    if (!out.ok) { manifest = manifestText(null, out.error); return; }
    manifest = manifestText(out.result);
    try {
      mkdirSync(join(ctx.cwd, '.mina'), { recursive: true });
      writeFileSync(join(ctx.cwd, '.mina', 'host-capabilities.json'), `${JSON.stringify(out.result, null, 1)}\n`);
    } catch { /* the manifest in the prompt is enough */ }
  }

  async function deliver(ctx) {
    if (unavailable || polling || !claim.live) return;
    // During a handoff an alarm would start a run that mina stops at once: it stays pending for the new session.
    if (globalThis[Symbol.for('mina:handoff')]?.pending?.()) return;
    polling = true;
    try {
      const out = await call('alarms');
      const pending = out.ok ? out.result.pending : [];
      if (!pending.length) return;
      for (const a of pending) {
        pi.sendMessage({ customType: 'mina-host-alarm', display: true, details: a,
          content: `mina host alarm (${a.label}, ${new Date(a.at * 1000).toISOString()}): ${a.message}\n`
            + 'This comes from a host-side monitor that runs independently of this session. Check it with mina_host before continuing.' },
        { triggerTurn: true, deliverAs: 'steer' });
        try { ctx?.ui?.notify?.(`mina host alarm: ${a.label}`, 'warning'); } catch { /* no UI */ }
      }
      await call('alarms', { ack: pending.map((a) => a.id) }); // acknowledged only once they are in the conversation
    } finally { polling = false; }
  }

  pi.on('session_start', async (_event, ctx) => {
    await refresh(ctx).catch(() => {});
    await deliver(ctx).catch(() => {});
    if (!unavailable && !timer) { timer = setInterval(() => deliver(ctx).catch(() => {}), pollMs); timer.unref?.(); }
  });
  pi.on('session_shutdown', async () => { claim.live = false; if (timer) clearInterval(timer); timer = null; });
  // A section, never a returned systemPrompt: Pi forces a returned string over every other layer's prompt options,
  // which dropped pi-claude-subscription's Claude preamble and made Anthropic bill claude-sdk as extra usage.
  pi.on('before_agent_start', async (event) => {
    const o = event.systemPromptOptions;
    if (o) o.sections = { ...(o.sections ?? {}), host: manifest };
  });

  pi.registerTool({
    name: 'mina_host',
    label: 'Host',
    description: 'Operations on this host that the sandbox does not allow, through mina\'s host broker, on what the user registered '
      + 'for this project: capabilities (what you may do, with remediations), service_status / service_logs / service_restart '
      + '(restart verifies the new deployment: new process, fresh code, health), reserve / release (exclusive host-wide '
      + 'resource locks shared with the campaign runners), workload_run / workload_status / workload_stop (registered commands '
      + 'in their own contained unit, holding their resources), workload_output (read retained job output by id with byte offset/limit; use this instead of rerunning a job or asking for journal recovery; data_base64 preserves exact bytes), workload_budget (native per-instance admission counts and reserved runtime ceilings, not measured usage or scientific attempt counts), monitor_add / monitor_list / monitor_remove (host-side monitors '
      + 'that outlive this session; their alarms arrive here), alarms, inventory (read-only: the GPUs of this machine, which '
      + 'resources cover them, their lock files with holders, and lockouts), policy_propose (propose a change to the host policy '
      + 'for this project, or a new machine resource, with changes and reason; the broker shows the user the exact diff and '
      + 'its risks, and writes it only if the user approves; other projects, defaults and machine-wide settings are for the '
      + 'owner, with mina host apply). Refusals say BLOCKED, CONFLICT or REQUIRES_AUTHORIZATION '
      + 'with the evidence and the narrowest remediation.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        service: { type: 'string', description: 'A registered service name.' },
        lines: { type: 'number', description: 'service_logs: how many lines (max 500).' },
        resources: { type: 'array', items: { type: 'string' }, description: 'reserve: registered resource names, e.g. GPU_0.' },
        ttl_s: { type: 'number', description: 'reserve / monitor_add: how long it lasts, in seconds.' },
        reservation: { type: 'string', description: 'release: the reservation id.' },
        workload: { type: 'string', description: 'workload_run: a registered workload name.' },
        request_id: { type: 'string', description: 'workload_status only: look up a native submission identity after an uncertain reply. workload_run always assigns its own identity.' },
        id: { type: 'string', description: 'workload_status / workload_output / workload_stop / monitor_remove: the id.' },
        offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'workload_output: starting byte offset, default 0. Follow next_offset; EOF is only the current file end, not proof the job finished.' },
        limit: { type: 'integer', minimum: 1, maximum: 8192, description: 'workload_output: maximum source bytes, default 4096. text is a readable preview; data_base64 is exact across binary/UTF-8 boundaries.' },
        kind: { type: 'string', enum: ['unit_active', 'file_fresh', 'log_match', 'sensor_max', 'workload'], description: 'monitor_add: what to watch.' },
        params: { type: 'object', description: 'monitor_add: unit_active {service}; file_fresh {path, max_age_s}; log_match {path, pattern, min_interval_s}; '
          + 'sensor_max {path, max, scale}; workload {id}. Paths must be in the project or the registered monitor_paths. '
          + 'workload_run: the workload\'s registered params (see capabilities), e.g. {exp, locks}.' },
        label: { type: 'string', description: 'monitor_add: a short name shown with its alarms.' },
        command: { type: 'array', items: { type: 'string' }, description: 'workload_run, for a workload that takes a command: the argv to run in its sandbox (no shell unless you call one, e.g. ["bash","-c","..."]).' },
        max_s: { type: 'integer', minimum: 1, description: 'workload_run: integer seconds, at most the registered max_s. Admission reserves this ceiling plus queue_s against instance budgets.' },
        refresh: { type: 'boolean', description: 'capabilities: check again now instead of the cached answer.' },
        changes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object' }, description: 'policy_propose: the change list. '
          + 'Each item has "kind": project_register {entry?}, workload_set {name, workload}, workload_remove {name}, '
          + 'resource_set {scope: "project"|"machine", name, resource} (machine: a new name only), resource_remove {scope: "project", name}, '
          + 'classes_set {classes} (not "policy"), monitor_paths_set {paths}. "project" defaults to this project; '
          + 'the schema is in docs/host-profile.md (Change the host policy).' },
        reason: { type: 'string', maxLength: 500, description: 'policy_propose: why this project needs the change, in one or two '
          + 'sentences. The user sees it labeled as your words.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!claim.live) return { content: [{ type: 'text', text: 'mina_host is not available here: host operations are not delegated to subagents.' }], isError: true };
      if (_signal?.aborted) return { content: [{ type: 'text', text: 'BLOCKED: request aborted before broker admission; no operation was sent.' }], isError: true };
      const { action, ...input } = params ?? {};
      const args = structuredClone(input); // callbacks and session replacement cannot change the displayed request
      delete args.approval; // only the user grants an approval, below
      delete args.grant;
      delete args.op;
      delete args.mutation_id;
      delete args.submission_id;
      delete args.request_protocol;
      if (action === 'workload_run') {
        if (typeof _id !== 'string' || !_id) return { content: [{ type: 'text', text: 'BLOCKED: native tool call identity is required; no workload was submitted.' }], isError: true };
        // Same native call + launcher grant survives transport/confirmation retries and extension reloads.
        // The grant is hashed, never exposed; model-supplied IDs cannot select this control identity.
        args.request_id = `wl-${createHash('sha256').update(JSON.stringify([grant, ctx.sessionManager?.getSessionId?.() ?? null, _id])).digest('hex')}`;
      } else if (action !== 'workload_status') delete args.request_id;
      let out = await call(action, args);
      if (!out.ok && out.error?.approval_needed) {
        const challenge = out.error.approval_request;
        if (!claim.live || _signal?.aborted) {
          out = { ok: false, error: { code: 'BLOCKED', message: 'No mutation retry was sent: the session ended or the request was aborted.' } };
        } else if (challenge?.protocol !== CONFIRMATION_PROTOCOL || typeof challenge.challenge !== 'string' || !challenge.challenge) {
          out = { ok: false, error: { code: 'BLOCKED', message: 'The broker lacks request-bound confirmation. The operator must upgrade it at a safe boundary; no legacy approval was sent.' } };
        } else if (!ctx?.hasUI) {
          out.error.message += '. No one can confirm in this session (no interactive UI): ask the user to approve it in an interactive session, or to set it to "allow" in host.json.';
        } else if (await oneDialog(() => confirmPrompt(ctx, action, out.error.approval_prompt, terminal)) === true) {
          out = !claim.live || _signal?.aborted
            ? { ok: false, error: { code: 'BLOCKED', message: 'Agreement was received, but no mutation retry was sent: the session ended or the request was aborted.' } }
            : await call(action, { ...args, approval: { granted: true, challenge: challenge.challenge, by: 'user', via: 'mina confirm', at: new Date().toISOString() } });
        } else {
          out.error.message += '. The user declined.';
        }
      }
      if (!out.ok && out.error?.code === 'INVALID' && (out.error.message ?? '').includes(`unknown operation '${MUTATION_PROTOCOL}'`)) {
        out = { ok: false, error: { code: 'BLOCKED', message: 'The broker does not support budget-capable mutations. Upgrade it at a safe boundary; no legacy mutation was retried.' } };
      }
      if (action === 'workload_run' && !out.ok && out.error?.code === 'INVALID' && out.error.message === 'invalid versioned mutation envelope') {
        out = { ok: false, error: { code: 'BLOCKED', message: 'The broker does not support durable workload request identities. Upgrade it at a safe boundary; no legacy submission was retried.', request_id: args.request_id } };
      }
      if (action === 'workload_run' && !out.ok) out.error.request_id = args.request_id;
      if (out.error?.approval_request) delete out.error.approval_request.challenge; // control-plane token, not model data
      if (['service_restart', 'reserve', 'release', 'workload_run', 'policy_propose'].includes(action)) refresh(ctx).catch(() => {});
      if (action === 'capabilities' && out.ok) manifest = manifestText(out.result);
      return { content: [{ type: 'text', text: `${out.ok ? 'OK' : out.error?.code ?? 'FAILED'}: ${text(out)}` }], details: out, isError: !out.ok };
    },
  });
}
