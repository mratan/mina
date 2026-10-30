#!/usr/bin/env python3
"""mina-hostd: the host broker of mina's engineering-host profile (docs/host-profile.md).

It runs as the user service mina-hostd.service, outside every Mina sandbox, and answers a short fixed list of
operations over a Unix socket, only on what the user registered for a project in ~/.config/mina/host.json:

  observe   capabilities, service status and logs, workload status and retained output, monitors and alarms
  reserve   hold a registered resource's host locks (the campaign runner's own flock files) for a bounded time
  workload  run a registered command in its own systemd unit, holding its resources; stop it; verify every process exits
  restart   restart a registered service while its resources are idle, then verify the new deployment
  monitor   register a bounded, host-side monitor whose alarms survive the Mina session and its handoffs

The fixed operations target registered capabilities, not an unrestricted host API. A workload registration can grant
broad command authority; registration itself is not a safety review. The broker runs with its user's Unix authority.
An unapproved operation class is refused with the exact host.json change that would approve it. Every request,
decision and verification is appended to audit.jsonl. The broker is deterministic: no model takes part.

Who may call: a request carries a session grant. The mina launcher (a process outside the sandbox: same mount namespace
as this broker) opens the session and passes the grant into the sandbox; the broker accepts it only from that
launcher's own Pi process (its child, or its grandchild through bwrap), never from a command the agent runs.

usage: hostd.py serve | install | status [PROJECT]
"""
import copy
import base64
import contextvars
import functools
import hashlib
import json
import os
import re
import secrets
import signal
import stat
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hostlib  # noqa: E402
from confirmations import Confirmations, PROTOCOL, MUTATION_OP  # noqa: E402
from budgets import AdmissionBudgets, BudgetExceeded, BudgetUnknown, limits as budget_limits  # noqa: E402

VERSION = '1'
UID = os.getuid()
CONFIG = os.path.expanduser(os.environ.get('MINA_HOST_CONFIG', '~/.config/mina/host.json'))
STATE = os.path.expanduser(os.environ.get('MINA_HOST_STATE', '~/.local/state/mina/hostd'))
RUNTIME = os.environ.get('MINA_HOST_RUNTIME', f'/run/user/{UID}/mina-hostd')
SOCKET = os.path.join(RUNTIME, 'sock')
SLICE = os.environ.get('MINA_HOST_SLICE', 'mina.slice')
UNIT_PREFIX = os.environ.get('MINA_HOST_UNIT_PREFIX', 'mina-wl')
LOCKRUN = os.path.join(HERE, 'lockrun.py')
LOCKRUN_ENV = ('MINA_HOST_KFD_PROC',)   # broker settings that lockrun.py (hostlib) reads too
TICK_S = float(os.environ.get('MINA_HOST_TICK_S', '2'))
CLASSES = ('observe', 'reserve', 'workload', 'restart', 'monitor')
LEVEL = {'deny': 0, 'ask': 1, 'allow': 2}
MAX_RESERVE_S = 3600
AUTO_QUIET_S = int(os.environ.get('MINA_HOST_AUTO_QUIET_S', '120'))
AUTO_HOLD_S = float(os.environ.get('MINA_HOST_AUTO_HOLD_S', '45'))

state_lock = threading.RLock()
service_locks = {}
reservations = {}  # id -> {project, resources, fds, expires, session}
cap_cache = {}     # project -> (fingerprint, result)
confirmations = Confirmations()
budgets = AdmissionBudgets()
# Bounded striped locks serialize same-request preflight/confirmation/admission, never all host work.
request_locks = [threading.RLock() for _ in range(64)]


class Refusal(Exception):
    """A deterministic 'no': code is BLOCKED, REQUIRES_AUTHORIZATION, CONFLICT, UNAUTHENTICATED, INVALID, NOT_FOUND or FAILED."""

    def __init__(self, code, message, **detail):
        super().__init__(message)
        self.code, self.message, self.detail = code, message, detail


def now():
    return time.time()


def iso(t=None):
    return time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime(t or now()))


def ensure_state_dir():
    """The broker's state (sessions, grants' records, workloads, audit) is private to the owner: 0700, also when an
    earlier version created it with the default umask."""
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    os.chmod(STATE, 0o700)


def audit(rec):
    rec = {'ts': iso(), **rec}
    if rec.get('project') and 'policy_source' not in rec:
        try:
            if policy_source(rec['project']) == 'defaults':
                rec['policy_source'] = 'defaults'   # the operation used the defaults, not a registration of its own
        except Exception:  # an unreadable policy must not stop the audit record
            pass
    ensure_state_dir()
    with state_lock:
        # 0600, and existing files are narrowed to it; never through a symlink.
        fd = os.open(os.path.join(STATE, 'audit.jsonl'), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as f:
            os.fchmod(fd, 0o600)
            f.write(json.dumps(rec, default=str) + '\n')


def log(msg):
    print(f'{iso()} {msg}', flush=True)


# --- configuration ---------------------------------------------------------------------------------------------------

_config = {'sha': None}
_policy = contextvars.ContextVar('mina_host_policy', default=None)


def read_policy():
    """Read bytes and file identity together. Preserving mtime must not preserve an old approval."""
    try:
        with open(CONFIG, 'rb') as f:
            before = os.fstat(f.fileno())
            raw = f.read()
            after = os.fstat(f.fileno())
    except OSError:
        _config['sha'] = None
        return {'data': {}, 'sha': None, 'revision': None}
    def identity(st):
        return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
    if identity(before) != identity(after):
        raise Refusal('BLOCKED', 'Host policy changed while being read; no operation was admitted.')
    sha = hashlib.sha256(raw).hexdigest()
    revision = hashlib.sha256(json.dumps([sha, identity(after)]).encode()).hexdigest()
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError('host policy must be an object')
    except ValueError as e:
        log(f'CONFIG_INVALID {CONFIG}: {e}')
        data = {'invalid': str(e)}
    _config['sha'] = sha[:16]
    return {'data': data, 'sha': sha[:16], 'revision': revision}


def config():
    return (_policy.get() or read_policy())['data']


def with_policy(fn):
    """One policy snapshot per admission, including nested handlers. Never hold a lock across host work."""
    @functools.wraps(fn)
    def invoke(*args, **kwargs):
        args, kwargs = copy.deepcopy(args), copy.deepcopy(kwargs)
        if _policy.get() is not None:
            return fn(*args, **kwargs)
        token = _policy.set(read_policy())
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            admission = _policy.get().get('workload_admission')
            if admission is None:
                raise
            detail = {'budget_charged': True, 'admission_id': admission['id'], 'admission': copy.deepcopy(admission)}
            if isinstance(e, Refusal):
                e.detail.update(detail)
                raise
            raise Refusal('FAILED', f'{type(e).__name__}: {e}. Admission remains charged; inspect workload_status before retrying.',
                          **detail) from e
        finally:
            _policy.reset(token)
    return invoke


def machine_resources():
    """The top-level "resources" of host.json: the lock protocol of this machine, shared by every project on it."""
    r = config().get('resources')
    return r if isinstance(r, dict) else {}


# Folders that never get the defaults: credentials and mina's own configuration and state (relative to the home folder).
NO_DEFAULTS = ['.ssh', '.gnupg', '.aws', '.docker', '.config/gh', '.config/mina', '.local/state/mina']


def defaults_root(project, roots):
    """The root of "defaults.roots" that holds this project strictly inside it, or None. Never for a root itself, for
    /, for the home folder, or for a folder in NO_DEFAULTS. A root must be absolute (after ~); a root of / is ignored."""
    if not isinstance(roots, list):
        return None
    home = os.path.realpath(os.path.expanduser('~'))
    project = os.path.realpath(project)
    if project in ('/', home):
        return None
    for p in NO_DEFAULTS:
        guarded = os.path.join(home, p)
        if project == guarded or project.startswith(guarded + '/'):
            return None
    for r in roots:
        if not isinstance(r, str) or not os.path.isabs(os.path.expanduser(r)):
            continue
        root = os.path.realpath(os.path.expanduser(r))
        if root != '/' and project.startswith(root.rstrip('/') + '/'):
            return root
    return None


def policy_entry(project):
    """(entry, source): the project's own entry in "projects" (source 'project'); else the "defaults" template when the
    project is strictly inside one of its roots (source 'defaults'); else (None, None). A registered project never gets
    the defaults: there is no merging. The template's "services" are ignored, because a service belongs to one project."""
    cfg = config()
    entry = (cfg.get('projects') or {}).get(project)
    if entry is not None:
        return entry, 'project'
    d = cfg.get('defaults')
    if isinstance(d, dict) and defaults_root(project, d.get('roots')):
        return {k: v for k, v in d.items() if k not in ('roots', 'services')}, 'defaults'
    return None, None


def policy_source(project):
    """'project', 'defaults', or None when no policy applies."""
    return policy_entry(project)[1]


def project_config(project):
    """The effective policy of a project, or None. Its resources are the machine resources overlaid by the policy's own
    "resources": an entry of the policy with the same name replaces the machine entry as a whole."""
    entry, _source = policy_entry(project)
    if entry is None:
        return None
    return {**entry, 'resources': {**machine_resources(), **(entry.get('resources') or {})}}


def resource_origins(project):
    """{resource name: 'machine' or the policy source} for the effective resources of a project."""
    entry, source = policy_entry(project)
    if entry is None:
        return {}
    own = entry.get('resources') or {}
    return {**{n: 'machine' for n in machine_resources()}, **{n: source for n in own}}


def snippet(project, path, value):
    """The exact host.json change that approves something, for a refusal's remediation. For a project that gets the
    defaults, the change is to the defaults (or a registration of its own, which then replaces the defaults for it)."""
    if policy_source(project) == 'defaults':
        return (f'In {CONFIG}, set defaults.{path} = {json.dumps(value)} (this changes every project under defaults.roots; '
                f'for this project only, register "{project}" under "projects": its entry then replaces the defaults)')
    return f'In {CONFIG}, set projects["{project}"].{path} = {json.dumps(value)}'


UNREGISTERED = 'Add "{project}" under "projects" in {config}, or make it a subfolder of a folder in "defaults.roots" (see docs/host-profile.md).'


def require_class(project, cls, target=None, level=None):
    """The approval level for an operation class (and a service's own restart setting). Raises REQUIRES_AUTHORIZATION
    unless approved; returns 'allow' or 'ask'."""
    p = project_config(project)
    if p is None:
        raise Refusal('REQUIRES_AUTHORIZATION', f'project {project} is not registered with the host broker',
                      remediation=UNREGISTERED.format(project=project, config=CONFIG))
    have = (p.get('classes') or {}).get(cls, 'allow' if cls == 'observe' else 'deny')
    if level is not None:
        have = min(have, level, key=lambda x: LEVEL.get(x, 0))
    if LEVEL.get(have, 0) == 0:
        class_ok = LEVEL.get((p.get('classes') or {}).get(cls, 'allow' if cls == 'observe' else 'deny'), 0) > 0
        where = f'services.{target}.restart' if class_ok else f'classes.{cls}'
        raise Refusal('REQUIRES_AUTHORIZATION', f'the "{cls}" operation class is not approved{f" for {target}" if target else ""} on {project}',
                      remediation=snippet(project, where, 'allow') + ' (or "ask": the user confirms each operation).')
    return have


def require_confirmation(project, cls, sess, req, prompt, target=None, level=None):
    """Bind a one-shot confirmation to the actual request, session, project and policy. UI remains trusted."""
    have = require_class(project, cls, target, level)
    policy = _policy.get()
    if policy is not None and not policy.get('admitted') and read_policy()['revision'] != policy['revision']:
        raise Refusal('BLOCKED', 'Host policy changed before admission; no mutation was started.')
    scope = {'project': project, 'class': cls, 'target': target, 'level': level, 'prompt': prompt,
             'request': {k: v for k, v in req.items() if k not in ('grant', 'approval')},
             'policy': config(), 'policy_revision': (_policy.get() or read_policy())['revision'],
             'project_policy': project_config(project)}
    signature = hashlib.sha256(json.dumps(scope, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    approval = req.get('approval')
    owner = (project, sess)
    if isinstance(approval, dict) and approval.get('granted') is True and approval.get('challenge'):
        try:
            confirmations.consume(approval['challenge'], owner, signature)
        except ValueError as e:
            raise Refusal('REQUIRES_AUTHORIZATION', str(e)) from e
        if policy is not None:
            policy['admitted'] = True
        return
    if have == 'allow':
        if policy is not None:
            policy['admitted'] = True
        return
    try:
        challenge = confirmations.issue(owner, signature)
    except ValueError as e:
        raise Refusal('BLOCKED', str(e)) from e
    raise Refusal('REQUIRES_AUTHORIZATION', f'the "{cls}" operation needs the user\'s confirmation for this request',
                  approval_needed=True, approval_prompt=prompt, approval_request=challenge)


# --- sessions and peers ----------------------------------------------------------------------------------------------

SESSIONS = os.path.join(STATE, 'sessions.json')


def peer_of(conn):
    pid, uid, _gid = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
    return pid, uid


def host_peer(pid):
    """A process outside every sandbox: it shares this broker's mount namespace. Sandboxed Mina processes do not."""
    ns = hostlib.mnt_ns(pid)
    return ns is not None and ns == hostlib.mnt_ns()


def session_for(grant, pid):
    sessions = hostlib.read_json(SESSIONS, {})
    sid = hashlib.sha256(grant.encode()).hexdigest()[:16] if grant else None
    s = sessions.get(sid) if sid else None
    if not s:
        raise Refusal('UNAUTHENTICATED', 'no such host session (the mina launcher opens one; restart mina to get one)')
    if not hostlib.alive(s['launcher']):
        raise Refusal('UNAUTHENTICATED', 'this host session ended: its mina launcher exited')
    st = hostlib.proc_stat(pid)
    if not st:
        raise Refusal('UNAUTHENTICATED', 'caller vanished')
    parent = hostlib.proc_stat(st['ppid'])
    lp = s['launcher']['pid']
    direct = st['ppid'] == lp
    via_bwrap = bool(parent) and parent['ppid'] == lp and parent['comm'] == 'bwrap'
    if not (direct or via_bwrap):
        raise Refusal('UNAUTHENTICATED', 'the caller is not the Mina process of this session (a command run by the agent '
                      'or by a subagent cannot use the host session)')
    me = {'pid': pid, 'start': st['start']}
    with state_lock:
        sessions = hostlib.read_json(SESSIONS, {})
        cur = sessions.get(sid)
        if cur.get('pi') and cur['pi'] != me and hostlib.alive(cur['pi']):
            raise Refusal('UNAUTHENTICATED', 'this host session is bound to another Mina process')
        if cur.get('pi') != me:
            cur['pi'] = me
            hostlib.write_json(SESSIONS, sessions)
    return sid, s


def op_session_open(req, pid):
    if not host_peer(pid):
        raise Refusal('UNAUTHENTICATED', 'only a process outside the sandbox (the mina launcher) can open a host session')
    project = os.path.realpath(req.get('project') or '')
    if not os.path.isdir(project):
        raise Refusal('INVALID', f'project {project} is not a folder')
    grant = secrets.token_urlsafe(32)
    sid = hashlib.sha256(grant.encode()).hexdigest()[:16]
    with state_lock:
        sessions = hostlib.read_json(SESSIONS, {})
        sessions = {k: v for k, v in sessions.items() if hostlib.alive(v['launcher'])}
        sessions[sid] = {'project': project, 'launcher': hostlib.identity(pid), 'opened': now(), 'label': str(req.get('label', ''))[:80]}
        hostlib.write_json(SESSIONS, sessions)
    budgets.open((project, sid))
    audit({'op': 'session_open', 'session': sid, 'project': project, 'launcher': pid})
    source = policy_source(project)
    return {'grant': grant, 'session': sid, 'project': project, 'registered': source is not None, 'policy_source': source}


# --- systemd ---------------------------------------------------------------------------------------------------------


def systemctl(*args, timeout=30):
    return subprocess.run(['systemctl', '--user', *args], capture_output=True, text=True, timeout=timeout,
                          env={**os.environ, 'XDG_RUNTIME_DIR': f'/run/user/{UID}'})


SHOW = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'ExecMainStartTimestamp', 'ExecMainStartTimestampMonotonic',
        'ControlGroup', 'MemoryCurrent', 'CPUUsageNSec', 'TasksCurrent', 'NRestarts', 'Result', 'ExecStart', 'FragmentPath']


def show(unit, props=SHOW):
    r = systemctl('show', '--property', ','.join(props), unit)
    out = {}
    for line in r.stdout.splitlines():
        k, _, v = line.partition('=')
        out[k] = v
    return out


def num(v):
    return int(v) if v and v.isdigit() and int(v) < 2 ** 63 else None


# --- services --------------------------------------------------------------------------------------------------------


def service_config(project, name):
    s = ((project_config(project) or {}).get('services') or {}).get(name)
    if not s:
        names = sorted(((project_config(project) or {}).get('services') or {}))
        raise Refusal('REQUIRES_AUTHORIZATION', f'service "{name}" is not registered for {project} (registered: {names or "none"})',
                      remediation=snippet(project, f'services.{name}', {'unit': f'{name}.service', 'sources': ['<files it runs>']}))
    return s


def source_files(project, s):
    root = s.get('source_root', project)
    return [p if os.path.isabs(p) else os.path.join(root, p) for p in s.get('sources', [])]


def boot_time():
    """Boot time (epoch seconds) to 10 ms, from /proc/uptime. /proc/stat's btime is truncated to whole seconds, which put
    a process started up to a second after a source change *before* that change: a fresh restart read as STALE."""
    with open('/proc/uptime') as f:
        return time.time() - float(f.read().split()[0])


def deployment(project, name, s, info=None):
    """What runs, against what is on disk: the process start time and each source file's hash and change time.
    STALE: a source changed after the process started, so the running code is not the code on disk."""
    info = info or show(s['unit'])
    pid = num(info.get('MainPID'))
    st = hostlib.proc_stat(pid) if pid else None
    started = None
    if st:
        started = boot_time() + st['start'] / os.sysconf('SC_CLK_TCK')
    files = []
    for path in source_files(project, s):
        try:
            data = open(path, 'rb').read()
            files.append({'path': path, 'sha256': hashlib.sha256(data).hexdigest()[:16], 'mtime': os.stat(path).st_mtime})
        except OSError as e:
            files.append({'path': path, 'error': e.strerror})
    newer = [f['path'] for f in files if started and f.get('mtime', 0) > started]
    unreadable = [f['path'] for f in files if 'error' in f]
    matching = []
    if s.get('process_match'):
        # The interpreter's script argument (or the program itself) ends with process_match; an editor or a grep that
        # merely names the file further along its arguments is not a supervisor.
        matching = sorted(p for p, argv in hostlib.own_processes().items() if any(a.endswith(s['process_match']) for a in argv[:2]))
    revision = git_revision(s.get('source_root', project), source_files(project, s))
    verdict = ('NOT_RUNNING' if not st else 'UNKNOWN' if unreadable or not files else 'STALE' if newer else 'FRESH')
    rec = hostlib.read_json(os.path.join(STATE, 'deployments', f'{name}.json'), {})
    return {'verdict': verdict, 'main_pid': pid, 'process_started': iso(started) if started else None,
            'sources_changed_after_start': newer, 'sources_unreadable': unreadable, 'sources': files,
            'git': revision, 'supervisor_processes': matching,
            'single_supervisor': (len(matching) == 1) if s.get('process_match') else None,
            'last_verified_restart': rec.get('verified_at')}


def git_revision(root, files):
    try:
        head = subprocess.run(['git', '-C', root, 'rev-parse', '--short=12', 'HEAD'], capture_output=True, text=True, timeout=10)
        rel = [os.path.relpath(f, root) for f in files]
        dirty = subprocess.run(['git', '-C', root, 'status', '--porcelain', '--', *rel], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if head.returncode != 0:
        return None
    return {'head': head.stdout.strip(), 'sources_uncommitted': [line[3:] for line in dirty.stdout.splitlines()]}


def usage(info):
    mem, cpu, tasks = num(info.get('MemoryCurrent')), num(info.get('CPUUsageNSec')), num(info.get('TasksCurrent'))
    return {'memory_mib': round(mem / 2 ** 20, 1) if mem is not None else None,
            'cpu_s': round(cpu / 1e9, 1) if cpu is not None else None, 'tasks': tasks}


def op_service_status(project, sess, req):
    name = req.get('service')
    s = service_config(project, name)
    info = show(s['unit'])
    return {'service': name, 'unit': s['unit'], 'load': info.get('LoadState'), 'active': info.get('ActiveState'),
            'sub': info.get('SubState'), 'restarts': num(info.get('NRestarts')), 'usage': usage(info),
            'deployment': deployment(project, name, s, info),
            'restart_permission': min((project_config(project).get('classes') or {}).get('restart', 'deny'),
                                      s.get('restart', 'deny'), key=lambda x: LEVEL.get(x, 0))}


def tail(path, lines):
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 256 * 1024))
            return f.read().decode(errors='replace').splitlines()[-lines:]
    except OSError as e:
        return [f'(cannot read {path}: {e.strerror})']


def op_service_logs(project, sess, req):
    name = req.get('service')
    s = service_config(project, name)
    n = max(1, min(int(req.get('lines') or 50), 500))
    r = subprocess.run(['journalctl', '--user', '-u', s['unit'], '-n', str(n), '--no-pager', '-o', 'short-iso'],
                       capture_output=True, text=True, timeout=30)
    out = {'service': name, 'journal': r.stdout.splitlines()[-n:]}
    if r.returncode != 0:
        out['journal_error'] = r.stderr.strip()[:300]
    for path in s.get('logs', []):
        out.setdefault('files', {})[path] = tail(path, n)
    return out


@with_policy
def op_service_restart(project, sess, req):
    name = req.get('service')
    s = service_config(project, name)
    require_confirmation(project, 'restart', sess, req,
                         f'Restart {s["unit"]} for {project}? Its resources must be idle; mina verifies the new '
                         'deployment afterwards and never clears a safety lockout.', name, s.get('restart', 'deny'))
    lock = service_locks.setdefault(name, threading.Lock())
    if not lock.acquire(blocking=False):
        raise Refusal('CONFLICT', f'a restart of {name} is already in progress')
    try:
        return restart_verified(project, sess, name, s, req)
    finally:
        lock.release()


def restart_verified(project, sess, name, s, req):
    resources = project_config(project).get('resources') or {}
    idle = s.get('restart_requires_idle', [])
    missing = [r for r in idle if r not in resources]
    if missing:
        raise Refusal('INVALID', f'{name}.restart_requires_idle names unregistered resources {missing}')
    before = show(s['unit'])
    old = hostlib.identity(num(before.get('MainPID'))) if num(before.get('MainPID')) else None
    # The service's resources stay reserved during the restart: no measurement runs while its supervisor is down.
    try:
        fds = hostlib.acquire(hostlib.lock_entries(resources, idle))
    except hostlib.LockConflict as e:
        raise Refusal('CONFLICT', f'{name} cannot restart now: its resources are in use', evidence=e.evidence)
    try:
        busy = [p for p in hostlib.resource_problems(resources, idle) if p['kind'] in ('device_busy', 'device_unknown')]
        if busy:
            raise Refusal('CONFLICT', f'{name} cannot restart now: a GPU it supervises is in use', problems=busy)
        t0 = now()
        hlog = (s.get('health') or {}).get('log')
        offset = os.path.getsize(hlog) if hlog and os.path.exists(hlog) else 0
        r = systemctl('restart', s['unit'], timeout=int(s.get('restart_timeout_s', 60)))
        result = {'service': name, 'unit': s['unit'], 'requested_at': iso(t0), 'systemctl_rc': r.returncode,
                  'systemctl_stderr': r.stderr.strip()[:300], 'approval': public_confirmation(req.get('approval')), 'old_process': old}
        result.update(verify_restart(project, name, s, old, t0, offset))
    finally:
        for fd in fds:
            os.close(fd)
    if result['verified']:
        hostlib.write_json(os.path.join(STATE, 'deployments', f'{name}.json'), {**result, 'verified_at': iso()})
    audit({'op': 'service_restart_result', 'project': project, 'session': sess, 'service': name, 'verified': result['verified'],
           'failures': result['failures'], 'new_process': result.get('new_process')})
    return result


def verify_restart(project, name, s, old, t0, offset=0):
    """The checks after a restart, each with its evidence. verified only if all pass, and still pass after a settling
    window: the same main process, still active, and no line matching health.fail_pattern written since the restart.
    (2026-10-13: a watchdog restart passed every start check, then logged ENFORCEMENT_FAILED every 5 s.)"""
    settle = float(s.get('settle_s', 3))
    health = s.get('health') or {}
    deadline = t0 + float(health.get('timeout_s', 30))
    failures, info, dep, health_line, new = [], {}, {}, None, None
    while True:
        time.sleep(min(settle, max(0.2, deadline - now())))
        info = show(s['unit'])
        pid = num(info.get('MainPID'))
        new = hostlib.identity(pid) if pid else None
        failures = []
        if info.get('ActiveState') != 'active':
            failures.append(f'unit is {info.get("ActiveState")}/{info.get("SubState")} (result {info.get("Result")})')
        if not new:
            failures.append('no main process')
        elif old and new == old:
            failures.append(f'main process {pid} is the old one: the service did not restart')
        dep = deployment(project, name, s, info)
        if dep['verdict'] != 'FRESH':
            failures.append(f'deployment {dep["verdict"]}: {dep["sources_changed_after_start"] or dep["sources_unreadable"] or ""}')
        if dep['single_supervisor'] is False:
            failures.append(f'{len(dep["supervisor_processes"])} supervisor processes match {s["process_match"]!r}: {dep["supervisor_processes"]}')
        if health.get('log') and new:
            pattern = re.compile(health['pattern'].replace('{pid}', str(pid)))
            health_line = next((ln for ln in reversed(tail(health['log'], 200)) if pattern.search(ln)), None)
            if not health_line:
                failures.append(f'no line matching {pattern.pattern!r} in {health["log"]} yet')
        if not failures or now() >= deadline:
            break
    stable_s = float(health.get('stable_s', 5))
    if not failures and stable_s > 0:
        time.sleep(stable_s)
        info2 = show(s['unit'])
        pid2 = num(info2.get('MainPID'))
        if info2.get('ActiveState') != 'active' or not pid2 or hostlib.identity(pid2) != new:
            failures.append(f'not stable for {stable_s:g}s: unit {info2.get("ActiveState")}, main pid {pid2} (was {new and new["pid"]})')
        if health.get('log') and health.get('fail_pattern'):
            try:
                with open(health['log'], 'rb') as f:
                    f.seek(offset)
                    since = f.read(4 << 20).decode(errors='replace').splitlines()
            except OSError as e:
                since = [f'(cannot read {health["log"]}: {e.strerror})']
            bad = [ln for ln in since if re.search(health['fail_pattern'], ln)]
            if bad:
                failures.append(f'{len(bad)} line(s) matching {health["fail_pattern"]!r} since the restart, first: {bad[0][:300]}')
        info = info2
    return {'verified': not failures, 'failures': failures, 'active': info.get('ActiveState'), 'new_process': new,
            'deployment': dep, 'health_line': health_line, 'usage': usage(info), 'checked_at': iso()}


# --- reservations ----------------------------------------------------------------------------------------------------


def check_resources(project, names):
    resources = (project_config(project) or {}).get('resources') or {}
    unknown = [n for n in names if n not in resources]
    if unknown or not names:
        raise Refusal('REQUIRES_AUTHORIZATION', f'resources {unknown or names} are not registered for {project} '
                      f'(registered: {sorted(resources) or "none"})', remediation=snippet(project, f'resources.{(unknown or ["NAME"])[0]}', {'locks': [{'path': '<the lock file the host runner uses>'}]}))
    return resources


@with_policy
def op_reserve(project, sess, req):
    require_confirmation(project, 'reserve', sess, req,
                         f'Reserve resources {req.get("resources") or []} for {project} '
                         f'for {req.get("ttl_s") or 300} seconds (subject to the configured limit)?')
    names = list(req.get('resources') or [])
    resources = check_resources(project, names)
    ttl = max(1, min(int(req.get('ttl_s') or 300), int((project_config(project) or {}).get('max_reserve_s', MAX_RESERVE_S))))
    problems = hostlib.resource_problems(resources, names)
    if problems:
        raise Refusal('BLOCKED' if any(p['kind'] in ('lockout', 'supervisor', 'device_unknown') for p in problems) else 'CONFLICT',
                      'the resources may not be used now', problems=problems)
    try:
        fds = hostlib.acquire(hostlib.lock_entries(resources, names))
    except hostlib.LockConflict as e:
        raise Refusal('CONFLICT', 'the resources are held by another process; nothing was reserved', evidence=e.evidence)
    # With the locks held, the GPUs must still be free of users outside the protocol (otherwise exclusivity is not shown).
    problems = hostlib.resource_problems(resources, names)
    if problems:
        for fd in fds:
            os.close(fd)
        raise Refusal('CONFLICT', 'locks taken, but exclusivity is not established; released again', problems=problems)
    rid = f'r-{secrets.token_hex(4)}'
    with state_lock:
        reservations[rid] = {'id': rid, 'project': project, 'session': sess, 'resources': names, 'fds': fds,
                             'locks': [e['path'] for e in hostlib.lock_entries(resources, names)], 'expires': now() + ttl}
        persist_reservations()
    return {'reservation': rid, 'resources': names, 'locks': reservations[rid]['locks'], 'expires_at': iso(now() + ttl),
            'exclusive': True, 'note': 'Held by the broker. Processes you start yourself are not contained by it; '
            'run measurements as registered workloads where you can.'}


def persist_reservations():
    hostlib.write_json(os.path.join(STATE, 'reservations.json'),
                       {k: {x: y for x, y in v.items() if x != 'fds'} for k, v in reservations.items()})


def release(rid, why):
    with state_lock:
        r = reservations.pop(rid, None)
        if r:
            for fd in r['fds']:
                os.close(fd)
            persist_reservations()
    if r:
        audit({'op': 'release', 'reservation': rid, 'project': r['project'], 'why': why})
    return r


@with_policy
def op_release(project, sess, req):
    require_confirmation(project, 'reserve', sess, req,
                         f'Release reservation {req.get("reservation")} for {project}?')
    r = reservations.get(req.get('reservation'))
    if not r or r['project'] != project:
        raise Refusal('NOT_FOUND', f'no reservation {req.get("reservation")} for this project')
    release(r['id'], 'released')
    return {'released': r['id'], 'resources': r['resources']}


# --- workloads -------------------------------------------------------------------------------------------------------

WL = os.path.join(STATE, 'workloads')


def tag(project):
    return hashlib.sha256(project.encode()).hexdigest()[:8]


REPO = os.path.dirname(HERE)
# Credential paths a workload's sandboxed command never sees: the same list as mina's own sandbox (defaultHidden in
# sandbox/sandbox.mjs; test_hostd.py compares the two), plus all of mina's configuration and state.
HIDDEN = ['~/.ssh', '~/.gnupg', '~/.aws', '~/.netrc', '~/.git-credentials', '~/.docker', '~/.config/gh', '~/.config/mina/keys']
AGENT_HIDDEN = ['auth.json', 'mcp-auth.json', 'mcp-oauth', 'pi-pkg-cfg/pi-web-search']   # in Pi's agent folder
BROKER_HIDDEN = ['~/.config/mina', '~/.local/state/mina']


class ConfigError(Exception):
    pass


def _read_owner_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise ConfigError(f'{path}: {e}') from e


def claude_state(home, env):
    """Claude Code's state, as claudeState in sandbox/sandbox.mjs: ~/.claude, ~/.claude.json, every ~/.claude-* or
    ~/.claude.* entry, and the configDir of every profile in the owner's claude-sdk.json."""
    out = [os.path.join(home, '.claude'), os.path.join(home, '.claude.json')]
    try:
        out += [os.path.join(home, n) for n in sorted(os.listdir(home)) if re.match(r'^\.claude[-.].', n)]
    except FileNotFoundError:
        pass
    agent = (env.get('PI_CODING_AGENT_DIR') or '').strip() or os.path.join(home, '.pi', 'agent')
    profiles = _read_owner_json(os.path.join(agent, 'claude-sdk.json')).get('profiles') or []
    if not isinstance(profiles, list):
        raise ConfigError('claude-sdk.json: profiles must be an array')
    for p in profiles:
        d = p.get('configDir') if isinstance(p, dict) else None
        if not isinstance(d, str) or not os.path.isabs(d):
            raise ConfigError('claude-sdk.json: each profile needs an absolute configDir')
        out.append(d)
    return list(dict.fromkeys(out))


def default_hidden(home=None, env=None):
    """The credential paths of sandbox/sandbox.mjs defaultHidden(home, env), resolved."""
    env = os.environ if env is None else env
    home = home or os.path.expanduser('~')
    agent = (env.get('PI_CODING_AGENT_DIR') or '').strip() or os.path.join(home, '.pi', 'agent')
    return ([os.path.join(home, p[2:]) for p in HIDDEN] + [os.path.join(agent, p) for p in AGENT_HIDDEN]
            + [os.path.join(REPO, 'keys')] + claude_state(home, env))


def user_hidden(home=None, env=None):
    """The "hide" list of the owner's sandbox configuration (MINA_SANDBOX_CONFIG, else ~/.config/mina/sandbox.json),
    which mina's own sandbox applies too."""
    env = os.environ if env is None else env
    home = home or os.path.expanduser('~')
    path = env.get('MINA_SANDBOX_CONFIG') or os.path.join(home, '.config', 'mina', 'sandbox.json')
    hide = _read_owner_json(path).get('hide') or []
    if not isinstance(hide, list) or not all(isinstance(p, str) for p in hide):
        raise ConfigError(f'{path}: "hide" must be a list of paths')
    return [re.sub(r'^~(?=$|/)', lambda _m: home, p) for p in hide]


def command_sandbox(project, sb):
    """bwrap arguments for a workload's command: read-only root, GPUs available, private /tmp and runtime folder (no user
    bus, no host lock files), credential paths hidden (mina's list, the owner's sandbox "hide" list, the workload's own);
    only the registered folders writable, and the registered read-only folders inside them bound back read-only (the
    campaign's lockout and run records). No network unless the workload's sandbox says "network": "open"."""
    network = sb.get('network', 'offline')
    if network not in ('offline', 'open'):
        raise Refusal('INVALID', f'workload sandbox network must be "offline" (the default) or "open", not {network!r}')
    try:
        hidden = default_hidden() + user_hidden() + [os.path.expanduser(p) for p in BROKER_HIDDEN]
    except ConfigError as e:
        raise Refusal('BLOCKED', f'cannot tell which credential paths to hide: {e}') from e
    sub_ = lambda p: os.path.expanduser(p.replace('{project}', project))
    a = ['bwrap', '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', f'/run/user/{UID}']
    for p in map(sub_, sb.get('write', ['{project}'])):
        if os.path.exists(p):
            a += ['--bind', p, p]
    for p in map(sub_, sb.get('readonly', [])):
        if os.path.exists(p):
            a += ['--ro-bind', p, p]
    for p in hidden + list(map(sub_, sb.get('hide', []))):
        if os.path.islink(p):
            p = os.path.realpath(p)
        if os.path.isdir(p):
            a += ['--tmpfs', p, '--remount-ro', p]
        elif os.path.exists(p):
            a += ['--ro-bind', '/dev/null', p]
    if network == 'offline':
        a += ['--unshare-net']
    return a + ['--die-with-parent', '--chdir', project, '--']


def sha256_file(path):
    try:
        return hashlib.sha256(open(path, 'rb').read()).hexdigest()
    except OSError:
        return None


def workload_argv(project, name, w, req):
    """The registered argv with its placeholders filled: {project}; {max_s}; {NAME} from req.params, each matching its
    registered pattern; {command} becomes the sandbox and then req.command. Pinned files must have the approved hash,
    because the host side of a workload runs outside every sandbox and the agent can edit project files."""
    max_cap = w.get('max_s', 600)
    max_s = req.get('max_s', max_cap)
    if type(max_cap) is not int or max_cap < 1:
        raise Refusal('INVALID', f'workload "{name}" max_s must be a positive integer.')
    if type(max_s) is not int or not 1 <= max_s <= max_cap:
        raise Refusal('INVALID', f'max_s must be 1..{max_cap} for workload "{name}"')
    params = dict(req.get('params') or {})
    patterns = w.get('params', {})
    unknown = sorted(set(params) - set(patterns))
    if unknown:
        raise Refusal('INVALID', f'workload "{name}" takes params {sorted(patterns)}, not {unknown}')
    for k, pat in patterns.items():
        if k not in params or not isinstance(params[k], str) or not re.fullmatch(pat, params[k]):
            raise Refusal('INVALID', f'param {k!r} must match {pat}', given=params.get(k))
    for key, want in (w.get('pin') or {}).items():
        path = key.replace('{project}', project)
        have = sha256_file(path)
        if have != want:
            raise Refusal('BLOCKED', f'{path} is not the approved version, so workload "{name}" will not run it outside the sandbox',
                          have=have, approved=want, remediation=snippet(project, f'workloads.{name}.pin["{key}"]', have) + ' after reviewing the change.')
    command = req.get('command')
    takes_command = '{command}' in w['argv']
    if takes_command:
        if not (isinstance(command, list) and command and all(isinstance(x, str) for x in command)) or len(command) > 400 \
                or sum(map(len, command)) > 64000:
            raise Refusal('INVALID', f'workload "{name}" needs command: a list of 1-400 strings (argv, no shell unless you call one)')
    elif command:
        raise Refusal('INVALID', f'workload "{name}" takes no command')
    out = []
    for tok in w['argv']:
        if tok == '{command}':
            # command_sandbox false: the command already runs in a sandbox of its own (a podman container started by a
            # pinned script); bwrap would also stop rootless podman from starting (no_new_privs blocks newuidmap).
            out += (command_sandbox(project, w.get('sandbox', {})) if w.get('command_sandbox', True) else []) + command
            continue
        out.append(fill(tok, project, max_s, params))
    env = {k: fill(str(v), project, max_s, params) for k, v in (w.get('env') or {}).items()}
    return out, max_s, params, command if takes_command else None, env


def fill(tok, project, max_s, params):
    tok = tok.replace('{project}', project).replace('{max_s}', str(max_s))
    for k, v in params.items():
        tok = tok.replace('{' + k + '}', v)
    return tok


def workload_budget_policy(project, workload):
    p = project_config(project) or {}
    w = (p.get('workloads') or {}).get(workload, {})
    try:
        return budget_limits(p), budget_limits(w)
    except ValueError as e:
        raise Refusal('INVALID', str(e)) from e


def op_workload_budget(project, sess, req):
    p = project_config(project) or {}
    status = budgets.status((project, sess))
    complete = status['coverage'] == 'complete'
    def remaining(used, cap):
        return {key: max(0, cap[limit] - used[key]) if complete and cap is not None and limit in cap else None
                for key, limit in [('admissions', 'max_admissions'), ('reserved_s', 'max_reserved_s')]}
    try:
        cap = budget_limits(p)
        workloads = {}
        for name in sorted(set(p.get('workloads', {})) | set(status['workloads'])):
            used = status['workloads'].get(name, {'admissions': 0, 'reserved_s': 0})
            local = budget_limits((p.get('workloads') or {}).get(name, {}))
            workloads[name] = {'used': used, 'limits': local, 'remaining': remaining(used, local)}
    except ValueError as e:
        raise Refusal('INVALID', str(e)) from e
    return {**status, 'session': sess, 'limits': cap, 'remaining': remaining(status['used'], cap),
            'workloads': workloads, 'accounting': 'admission reservations, not measured resource use',
            'recovery_history_is_authority': False}


def check_workload_budget(project, sess, workload, cost, admission_id=None):
    instance_limits, local_limits = workload_budget_policy(project, workload)
    def journal(receipt):
        _policy.get()['workload_admission'] = receipt
        audit({'op': 'workload_admission', 'project': project, 'session': sess,
               'workload': workload, 'admission': receipt})
    def policy_guard():
        policy = _policy.get()
        if policy is None or read_policy()['revision'] != policy['revision']:
            raise Refusal('BLOCKED', 'Host policy changed before atomic budget admission; no charge or launch was made.')
    try:
        if admission_id is None:
            budgets.check((project, sess), workload, cost, instance_limits, local_limits)
            return None
        return budgets.admit((project, sess), workload, cost, instance_limits, local_limits, admission_id, journal, policy_guard)
    except BudgetExceeded as e:
        raise Refusal('REQUIRES_AUTHORIZATION', str(e), budget_exhausted=True) from e
    except BudgetUnknown as e:
        raise Refusal('BLOCKED', str(e), budget_coverage='unknown') from e
    except ValueError as e:
        raise Refusal('INVALID', str(e)) from e
    except OSError as e:
        raise Refusal('FAILED', f'Admission was charged but its journal failed; no launch started: {e}',
                      admission_id=admission_id, budget_charged=admission_id is not None) from e


def request_path(project, sess, request_id):
    if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', request_id):
        raise Refusal('INVALID', 'request_id must be 1-160 letters, digits, underscores or hyphens.')
    key = hashlib.sha256(json.dumps([project, sess, request_id]).encode()).hexdigest()
    return os.path.join(STATE, 'request-intents', key + '.json')


def request_digest(req):
    # Transport credentials and one-use confirmation are not workload arguments.
    args = {k: v for k, v in req.items() if k not in ('grant', 'approval', 'op')}
    return hashlib.sha256(json.dumps(args, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def read_request_intent(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    try:
        with os.fdopen(fd) as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_uid != UID or st.st_mode & 0o077:
                raise ValueError('unprotected receipt')
            receipt = json.load(f)
            if not isinstance(receipt, dict) or not {'project', 'session', 'request_id', 'digest', 'id'} <= receipt.keys():
                raise ValueError('incomplete receipt')
            return receipt
    except (ValueError, OSError) as e:
        # Even an empty receipt left by a crash blocks re-admission. Never delete or repair it into permission.
        raise Refusal('BLOCKED', 'Request intent is incomplete or unreadable; outcome unknown. No retry was launched.',
                      receipt_state='pending_unknown') from e


def observe_request(project, sess, request_id, digest=None, replayed=False):
    receipt = read_request_intent(request_path(project, sess, request_id))
    if receipt is None:
        return None
    if receipt['project'] != project or receipt['session'] != sess or receipt['request_id'] != request_id:
        raise Refusal('BLOCKED', 'Request receipt ownership does not match this session.')
    if digest is not None and receipt['digest'] != digest:
        raise Refusal('CONFLICT', 'request_id was already submitted with different arguments; no launch was made.', request_id=request_id)
    rec = hostlib.read_json(os.path.join(workload_dir(receipt['id']), 'record.json'))
    if rec and (rec.get('project'), rec.get('session'), rec.get('request_id')) != (project, sess, request_id):
        raise Refusal('BLOCKED', 'Workload record does not match its request receipt.')
    # Pure observation: no reconciliation/cleanup, confirmation, grants or accounting restoration.
    return {**(describe_workload(rec) if rec else {'id': receipt['id']}), 'request_id': request_id,
            'observation': 'stored_job_record' if rec else 'intent_only',
            'replayed': replayed, 'receipt_state': 'job_recorded' if rec and rec.get('state') != 'launching' else 'pending_unknown',
            'recovery_history_is_authority': False}


def create_request_intent(project, sess, req, wid):
    path = request_path(project, sess, req['request_id'])
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    st = os.lstat(directory)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != UID or st.st_mode & 0o077:
        raise Refusal('BLOCKED', 'Request receipt directory is not protected; no launch was made.')
    # O_EXCL is the durable, cross-process admission fence. A partial write remains a blocking intent.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, 'w') as f:
        json.dump({'project': project, 'session': sess, 'request_id': req['request_id'],
                   'digest': request_digest(req), 'id': wid, 'created_at': iso()}, f)
        f.flush()
        os.fsync(f.fileno())
    for d in (directory, STATE):
        fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return True


@with_policy
def op_workload_run(project, sess, req):
    require_class(project, 'workload')
    if 'request_id' not in req:
        return launch_workload(project, sess, req)
    path = request_path(project, sess, req['request_id'])
    with request_locks[int(os.path.basename(path)[:8], 16) % len(request_locks)]:
        existing = observe_request(project, sess, req['request_id'], request_digest(req), replayed=True)
        if existing is not None:
            return existing
        return launch_workload(project, sess, req)


def launch_workload(project, sess, req):
    name = req.get('workload')
    w = ((project_config(project) or {}).get('workloads') or {}).get(name)
    if not w:
        names = sorted(((project_config(project) or {}).get('workloads') or {}))
        raise Refusal('REQUIRES_AUTHORIZATION', f'workload "{name}" is not registered for {project} (registered: {names or "none"})',
                      remediation=snippet(project, f'workloads.{name}', {'argv': ['<command>', '<args>'], 'resources': [], 'max_s': 600}))
    argv, max_s, params, command, env = workload_argv(project, name, w, req)
    queue_s = w.get('queue_s', 0)
    if type(queue_s) is not int or queue_s < 0:
        raise Refusal('INVALID', 'queue_s must be a nonnegative integer.')
    check_workload_budget(project, sess, name, max_s + queue_s)
    names = list(w.get('resources', []))
    resources = check_resources(project, names) if names else {}
    stale = []
    for svc in w.get('requires_fresh', []):
        dep = deployment(project, svc, service_config(project, svc))
        if dep['verdict'] != 'FRESH':
            stale.append({'service': svc, 'verdict': dep['verdict'], 'changed_after_start': dep['sources_changed_after_start']})
    if stale:
        raise Refusal('BLOCKED', f'workload "{name}" must run against freshly deployed services; these are not', stale=stale,
                      remediation='Restart the service through mina_host (verified deployment), then run the workload again.')
    problems = hostlib.resource_problems(resources, names) if names else []
    if problems:
        raise Refusal('BLOCKED' if any(p['kind'] in ('lockout', 'supervisor', 'device_unknown') for p in problems) else 'CONFLICT',
                      'the workload\'s resources may not be used now', problems=problems)
    require_confirmation(project, 'workload', sess, req,
                         f'Run registered workload {name} for {project} '
                         f'with params {req.get("params") or {}}, command {req.get("command")}, '
                         f'and max_s {max_s} (plus queue ceiling {queue_s}s)?')
    argv, max_s, params, command, env = workload_argv(project, name, w, req)  # retain the final pre-launch pin check
    wid = f'{time.strftime("%Y%m%d%H%M%S")}-{secrets.token_hex(3)}'
    unit = f'{UNIT_PREFIX}-{tag(project)}-{wid}.service'
    d = os.path.join(WL, wid)
    if 'request_id' in req and not create_request_intent(project, sess, req, wid):
        return observe_request(project, sess, req['request_id'], request_digest(req), replayed=True)
    admission = check_workload_budget(project, sess, name, max_s + queue_s, wid)
    os.makedirs(d, exist_ok=True)
    spec = {'argv': argv, 'cwd': w.get('cwd', project), 'env': env, 'result': os.path.join(d, 'result.json'),
            'log': os.path.join(d, 'output.log'), 'locks': hostlib.lock_entries(resources, names),
            'resources': {n: resources[n] for n in names}, 'resource_names': names}
    hostlib.write_json(os.path.join(d, 'spec.json'), spec)
    rec = {'id': wid, 'workload': name, 'project': project, 'policy_source': policy_source(project), 'session': sess, 'unit': unit, 'resources': names,
           'max_s': max_s, 'params': params, 'command': command, 'request_id': req.get('request_id'), 'admission': admission, 'state': 'launching', 'launched': now(), 'deadline': now() + max_s + queue_s, 'members_seen': []}
    hostlib.write_json(os.path.join(d, 'record.json'), rec)   # recorded before launch: an interrupted launch is found
    r = subprocess.run(['systemd-run', '--user', '--quiet', '--collect', f'--unit={unit}', f'--slice={SLICE}',
                        '--property=Type=exec', f'--property=RuntimeMaxSec={max_s + queue_s}', '--property=KillMode=control-group',
                        '--property=TimeoutStopSec=5', '--property=SendSIGKILL=yes',
                        # Delegation lets podman --cgroups=split keep its containers inside this unit, so stopping the unit
                        # stops them (by default rootless podman moves a container into a scope of its own).
                        *(['--property=Delegate=yes'] if w.get('delegate') else []), f'--description=mina workload {name} {wid}',
                        # lockrun re-checks the resources inside the unit, which does not inherit the broker's environment:
                        # a relocated GPU user list (MINA_HOST_KFD_PROC) must reach it, or the two checks disagree.
                        *[f'--setenv={k}={os.environ[k]}' for k in LOCKRUN_ENV if k in os.environ],
                        '--', sys.executable, LOCKRUN, os.path.join(d, 'spec.json')],
                       capture_output=True, text=True, timeout=30, env={**os.environ, 'XDG_RUNTIME_DIR': f'/run/user/{UID}'})
    if r.returncode != 0:
        rec.update(state='launch_failed', error=r.stderr.strip()[:500])
        hostlib.write_json(os.path.join(d, 'record.json'), rec)
        raise Refusal('FAILED', f'systemd-run refused the workload: {rec["error"]}')
    for _ in range(50):   # until lockrun has taken (or failed to take) the locks
        res = hostlib.read_json(spec['result'])
        if res:
            break
        time.sleep(0.1)
    reconcile_workload(rec)
    out = describe_workload(rec)
    if 'request_id' in req:
        out.update(request_id=req['request_id'], replayed=False,
                   receipt_state='pending_unknown' if rec.get('state') == 'launching' else 'job_recorded',
                   recovery_history_is_authority=False)
    # Its end raises an alarm in this project's Mina session, whichever session (after a handoff) is live then.
    p = project_config(project)
    if LEVEL.get((p.get('classes') or {}).get('monitor', 'deny'), 0) == 2:
        ttl = min(max_s + 900, int(p.get('max_monitor_ttl_s', 86400)))
        # Quiet for a run that ends within quiet_under_s: the agent is still waiting for it and reads the result itself.
        # (In one long run, 30 of 52 alarms were 'your few-second run ended', each a steer into the conversation.)
        out['monitor'] = op_monitor_add(project, sess, {'kind': 'workload', 'params': {'id': wid, 'quiet_under_s': AUTO_QUIET_S},
                                                        'label': f'workload {name} {wid}', 'ttl_s': ttl})['id']
    return out


def workload_dir(wid):
    if not re.fullmatch(r'[0-9]{14}-[0-9a-f]{6}', str(wid or '')):
        raise Refusal('INVALID', f'not a workload id: {wid}')
    return os.path.join(WL, wid)


def load_workload(project, wid):
    rec = hostlib.read_json(os.path.join(workload_dir(wid), 'record.json'))
    if not rec or rec['project'] != project:
        raise Refusal('NOT_FOUND', f'no workload {wid} for this project')
    return rec


def reconcile_workload(rec):
    """Bring a record up to date from systemd, the cgroup and lockrun's result. Final states: exited, conflict, blocked,
    stopped, deadline, launch_failed; containment_unknown when a recorded process still lives after the unit ended."""
    if rec['state'] in ('exited', 'conflict', 'blocked', 'stopped', 'deadline', 'launch_failed', 'terminated'):
        return rec
    d = os.path.join(WL, rec['id'])
    info = show(rec['unit'], ['LoadState', 'ActiveState', 'ControlGroup', 'MainPID'])
    res = hostlib.read_json(os.path.join(d, 'result.json'), {})
    if info.get('ControlGroup'):
        rec['cgroup'] = info['ControlGroup']
    if info.get('ActiveState') in ('active', 'activating', 'deactivating', 'reloading'):
        members = hostlib.cgroup_members(f'/sys/fs/cgroup{rec.get("cgroup", "")}') if rec.get('cgroup') else None
        seen = {(m['pid'], m['start']) for m in rec['members_seen']}
        rec['members_seen'] += [m for m in (members or []) if (m['pid'], m['start']) not in seen][:200]
        rec['state'] = 'running' if res.get('state') == 'running' else 'starting'
    else:
        # The unit has ended (collected units vanish). Every process ever seen in it, and any left in its cgroup, must be gone.
        left = hostlib.cgroup_members(f'/sys/fs/cgroup{rec["cgroup"]}') if rec.get('cgroup') else None
        known = rec['members_seen'] + res.get('survivors', []) + ([res['leader']] if res.get('leader') else [])
        living = [m for m in known if hostlib.alive(m)] + (left or [])
        if not res and rec['state'] == 'launching' and now() - rec['launched'] < 30:
            return rec
        st = res.get('state')
        if living:
            rec['state'] = 'containment_unknown'
        elif rec.get('stop_requested'):
            rec['state'] = 'stopped'
        elif st in ('exited', 'conflict', 'blocked'):
            rec['state'] = st
        elif st in ('running', 'terminated'):
            rec['state'] = 'deadline' if now() >= rec['deadline'] - 1 else 'terminated'
        else:
            rec['state'] = 'launch_failed'
        rec['verification'] = {'unit_ended': True, 'cgroup_remaining': left, 'recorded_processes': len(known),
                               'still_alive': living, 'verified_exit': not living, 'checked_at': iso()}
        rec['result'] = {k: v for k, v in res.items() if k in ('rc', 'state', 'evidence', 'problems', 'signal', 'survivors')}
        rec['ended'] = now()
        cleanup = ((project_config(rec['project']) or {}).get('workloads') or {}).get(rec['workload'], {}).get('cleanup')
        if cleanup:   # a registered host-side tidy-up, e.g. podman records of containers whose processes are gone
            try:
                c = subprocess.run(cleanup, capture_output=True, text=True, timeout=60, cwd=rec['project'])
                rec['cleanup'] = {'rc': c.returncode, 'output': (c.stdout + c.stderr)[-500:]}
            except (OSError, subprocess.TimeoutExpired) as e:
                rec['cleanup'] = {'rc': None, 'error': str(e)}
        audit({'op': 'workload_end', 'workload': rec['workload'], 'id': rec['id'], 'project': rec['project'], 'state': rec['state'],
               'verification': rec['verification'], 'rc': res.get('rc'), 'cleanup': rec.get('cleanup')})
    hostlib.write_json(os.path.join(d, 'record.json'), rec)
    return rec


def describe_workload(rec):
    out = {k: rec.get(k) for k in ('id', 'request_id', 'workload', 'unit', 'state', 'resources', 'max_s', 'params', 'command', 'admission', 'result', 'verification', 'cleanup')}
    out['launched_at'] = iso(rec['launched'])
    out['output_tail'] = tail(os.path.join(WL, rec['id'], 'output.log'), 20)
    return out


def op_workload_output(project, sess, req):
    """Bounded read of a project's retained job stream, never an arbitrary path."""
    if set(req) - {'op', 'grant', 'id', 'offset', 'limit'}:
        raise Refusal('INVALID', 'workload_output accepts only id, offset and limit')
    offset, limit = req.get('offset', 0), req.get('limit', 4096)
    if type(offset) is not int or not 0 <= offset <= 2**53 - 1 or type(limit) is not int or not 1 <= limit <= 8192:
        raise Refusal('INVALID', 'offset must be a nonnegative safe integer; limit must be 1..8192 bytes')
    rec = load_workload(project, req.get('id'))
    directory = fd = None
    try:
        directory = os.open(workload_dir(req['id']), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fd = os.open('output.log', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise Refusal('BLOCKED', 'Retained output must be a regular, unlinked-to-other-files log')
        data = os.pread(fd, limit, offset)
        return {'kind': 'workload_output', 'id': req['id'], 'state': rec.get('state'),
                'source_id': f'{info.st_dev}:{info.st_ino}', 'offset': offset, 'next_offset': offset + len(data),
                'size_bytes': info.st_size, 'eof': offset + len(data) >= info.st_size,
                'eof_scope': 'current retained file, not proof that a running job has finished',
                'text': data.decode('utf-8', errors='replace'), 'data_base64': base64.b64encode(data).decode('ascii'),
                'encoding_note': 'Offsets count bytes. data_base64 is exact; text may replace split or invalid UTF-8.'}
    except FileNotFoundError:
        raise Refusal('NOT_FOUND', 'Retained output is not available; do not rerun the workload merely to recover output')
    except OSError as e:
        raise Refusal('BLOCKED', f'Retained output could not be safely read ({e.__class__.__name__})')
    finally:
        if fd is not None:
            os.close(fd)
        if directory is not None:
            os.close(directory)


def op_workload_status(project, sess, req):
    if 'request_id' in req:
        if req.get('id'):
            raise Refusal('INVALID', 'Specify request_id or id, not both.')
        out = observe_request(project, sess, req['request_id'])
        if out is None:
            raise Refusal('NOT_FOUND', 'No request receipt for this project and launcher session.', request_id=req['request_id'])
        return out
    if req.get('id'):
        with state_lock:
            rec = reconcile_workload(load_workload(project, req['id']))
            if rec.get('ended') and not rec.get('observed_end'):
                rec['observed_end'] = now()    # the agent has the result: its short-run alarm is not needed
                hostlib.write_json(os.path.join(WL, rec['id'], 'record.json'), rec)
            return describe_workload(rec)
    out = []
    for wid in sorted(os.listdir(WL))[-20:] if os.path.isdir(WL) else []:
        rec = hostlib.read_json(os.path.join(WL, wid, 'record.json'))
        if rec and rec['project'] == project:
            out.append({k: rec.get(k) for k in ('id', 'workload', 'state')})
    return {'workloads': out}


@with_policy
def op_workload_stop(project, sess, req):
    require_confirmation(project, 'workload', sess, req,
                         f'Stop workload {req.get("id")} and its contained processes for {project}?')
    with state_lock:
        rec = reconcile_workload(load_workload(project, req.get('id')))
        if rec['state'] not in ('launching', 'starting', 'running', 'containment_unknown'):
            return describe_workload(rec)
        rec['stop_requested'] = now()
        hostlib.write_json(os.path.join(WL, rec['id'], 'record.json'), rec)
    # Only this unit's cgroup: systemd sends SIGTERM to every process in it, then SIGKILL after TimeoutStopSec.
    r = systemctl('stop', rec['unit'], timeout=60)
    for _ in range(50):
        with state_lock:
            rec = reconcile_workload(load_workload(project, rec['id']))
        if rec['state'] not in ('launching', 'starting', 'running'):
            break
        time.sleep(0.1)
    audit({'op': 'workload_stop', 'id': rec['id'], 'project': project, 'session': sess, 'systemctl_rc': r.returncode, 'state': rec['state']})
    return describe_workload(rec)


# --- monitors and alarms ---------------------------------------------------------------------------------------------

MONITORS = os.path.join(STATE, 'monitors.json')
ALARMS = os.path.join(STATE, 'alarms.json')
KINDS = {'unit_active': ['service'], 'file_fresh': ['path', 'max_age_s'], 'log_match': ['path', 'pattern'],
         'sensor_max': ['path', 'max'], 'workload': ['id']}


def allowed_path(project, path):
    real = os.path.realpath(path)
    roots = [project] + [os.path.realpath(p) for p in (project_config(project) or {}).get('monitor_paths', [])]
    return any(real == r or real.startswith(r.rstrip('/') + '/') for r in roots)


@with_policy
def op_monitor_add(project, sess, req):
    require_confirmation(project, 'monitor', sess, req,
                         f'Add {req.get("kind")} monitor for {project} with params {req.get("params") or {}} '
                         f'for {req.get("ttl_s") or 3600} seconds?')
    kind, params = req.get('kind'), dict(req.get('params') or {})
    if kind not in KINDS:
        raise Refusal('INVALID', f'monitor kind must be one of {sorted(KINDS)}')
    missing = [k for k in KINDS[kind] if k not in params]
    if missing:
        raise Refusal('INVALID', f'{kind} needs {missing}')
    if 'path' in params and not allowed_path(project, params['path']):
        raise Refusal('REQUIRES_AUTHORIZATION', f'{params["path"]} is outside the project and the registered monitor_paths',
                      remediation=snippet(project, 'monitor_paths', [os.path.dirname(params['path'])]))
    if kind == 'unit_active':
        service_config(project, params['service'])
    if kind == 'log_match':
        re.compile(params['pattern'])
    if kind == 'workload':
        load_workload(project, params['id'])
    p = project_config(project)
    ttl = int(req.get('ttl_s') or 3600)
    if ttl > int(p.get('max_monitor_ttl_s', 86400)):
        raise Refusal('INVALID', f'ttl_s {ttl} exceeds max_monitor_ttl_s {p.get("max_monitor_ttl_s", 86400)}')
    with state_lock:
        mons = hostlib.read_json(MONITORS, {})
        mine = [m for m in mons.values() if m['project'] == project]
        if len(mine) >= int(p.get('max_monitors', 20)):
            raise Refusal('BLOCKED', f'{len(mine)} monitors already registered for this project (max_monitors)')
        mid = f'm-{secrets.token_hex(4)}'
        m = {'id': mid, 'project': project, 'kind': kind, 'params': params, 'label': str(req.get('label') or kind)[:120],
             'created': now(), 'created_by': sess, 'expires': now() + ttl, 'status': 'new', 'state': {}}
        first = evaluate(m, initial=True)
        mons[mid] = m
        hostlib.write_json(MONITORS, mons)
    audit({'op': 'monitor_add', 'project': project, 'session': sess, 'monitor': mid, 'kind': kind, 'params': params, 'ttl_s': ttl})
    if first:   # already bad when registered (or the workload already ended): that is an alarm too
        raise_alarm(m, first)
    return describe_monitor(m)


def describe_monitor(m):
    return {'id': m['id'], 'label': m['label'], 'kind': m['kind'], 'params': m['params'], 'status': m['status'],
            'last_value': m['state'].get('value'), 'last_checked': iso(m['state'].get('checked')) if m['state'].get('checked') else None,
            'expires_at': iso(m['expires'])}


def op_monitor_list(project, sess, req):
    mons = hostlib.read_json(MONITORS, {})
    return {'monitors': [describe_monitor(m) for m in mons.values() if m['project'] == project],
            'delivery': delivery_status(project)}


@with_policy
def op_monitor_remove(project, sess, req):
    require_confirmation(project, 'monitor', sess, req,
                         f'Remove monitor {req.get("id")} for {project}?')
    with state_lock:
        mons = hostlib.read_json(MONITORS, {})
        m = mons.get(req.get('id'))
        if not m or m['project'] != project:
            raise Refusal('NOT_FOUND', f'no monitor {req.get("id")} for this project')
        del mons[m['id']]
        hostlib.write_json(MONITORS, mons)
    audit({'op': 'monitor_remove', 'project': project, 'session': sess, 'monitor': m['id']})
    return {'removed': m['id']}


def evaluate(m, initial=False):
    """One deterministic check. Returns an alarm message on a change to bad (and 'recovered' on a change back)."""
    k, p, s = m['kind'], m['params'], m['state']
    bad, value = None, None
    if k == 'unit_active':
        svc = service_config(m['project'], p['service'])
        info = show(svc['unit'], ['ActiveState', 'MainPID'])
        value = f'{info.get("ActiveState")} pid {info.get("MainPID")}'
        if info.get('ActiveState') != 'active':
            bad = f'{svc["unit"]} is {info.get("ActiveState")}'
        elif s.get('pid') and info.get('MainPID') != s['pid']:
            alarm = f'{svc["unit"]} restarted: main pid {s["pid"]} -> {info.get("MainPID")}'
            s['pid'] = info.get('MainPID')
            return finish(m, value, None, alarm)
        s['pid'] = info.get('MainPID')
    elif k == 'file_fresh':
        try:
            age = now() - os.stat(p['path']).st_mtime
            value = f'{age:.0f}s old'
            if age > float(p['max_age_s']):
                bad = f'{p["path"]} not updated for {age:.0f}s (limit {p["max_age_s"]}s)'
        except OSError as e:
            bad = f'{p["path"]}: {e.strerror}'
    elif k == 'log_match':
        try:
            size = os.stat(p['path']).st_size
            off = s.get('offset', size if initial else 0)
            if size < off:
                off = 0
            with open(p['path'], 'rb') as f:
                f.seek(off)
                chunk = f.read(1 << 20)
            s['offset'] = off + len(chunk)
            hits = [ln for ln in chunk.decode(errors='replace').splitlines() if re.search(p['pattern'], ln)]
            value = f'{len(hits)} new matching line(s)'
            interval = float(p.get('min_interval_s', 300))
            if not hits and s.get('suppressed') and now() - s.get('last_alarm', 0) >= interval:
                more = s.pop('suppressed')            # the flood stopped inside the window: its lines are still reported
                s['last_alarm'] = now()
                return finish(m, value, None, f'{p["path"]}: {more} more line(s) matched {p["pattern"]!r} since the last alarm')
            if hits:
                # At most one alarm per min_interval_s: a log that repeats a line every few seconds must not turn into an
                # alarm every tick in the conversation. The lines in between are counted, and reported with the next alarm.
                if now() - s.get('last_alarm', 0) < interval:
                    s['suppressed'] = s.get('suppressed', 0) + len(hits)
                    return finish(m, value, None, None)
                more = s.pop('suppressed', 0)
                s['last_alarm'] = now()
                return finish(m, value, None, f'{p["path"]}: {len(hits)} line(s) match {p["pattern"]!r}'
                              + (f' (+{more} more since the last alarm)' if more else '') + ': ' + ' | '.join(hits[-5:])[:1500])
        except OSError as e:
            bad = f'{p["path"]}: {e.strerror}'
    elif k == 'sensor_max':
        try:
            v = float(open(p['path']).read().strip()) / float(p.get('scale', 1))
            value = v
            s['unreadable'] = 0
            if v > float(p['max']):
                bad = f'{p["path"]} = {v:g} > {p["max"]}'
        except (OSError, ValueError) as e:
            s['unreadable'] = s.get('unreadable', 0) + 1
            if s['unreadable'] >= 2:    # an unreadable sensor is a fault, not permission (the watchdog's own rule)
                bad = f'{p["path"]} unreadable twice: {e}'
    elif k == 'workload':
        rec = hostlib.read_json(os.path.join(WL, p['id'], 'record.json'), {})
        value = rec.get('state')
        if value and value not in ('launching', 'starting', 'running'):
            if s.get('reported'):
                return finish(m, value, None, None)
            # A short run's end is held for AUTO_HOLD_S and dropped only if the agent read the result itself
            # (workload_status after the end). Silencing it outright left an agent that waited for this alarm waiting
            # forever (2026-10-14 09:35, a 66-second run).
            quiet = float(p.get('quiet_under_s', 0) or 0)
            ended = rec.get('ended') or now()
            if quiet and ended - rec.get('launched', 0) < quiet:
                if rec.get('observed_end'):
                    s['reported'] = True
                    return finish(m, value, None, None)
                if now() - ended < AUTO_HOLD_S:
                    return finish(m, value, None, None)
            s['reported'] = True
            v = rec.get('verification') or {}
            return finish(m, value, None, f'workload {rec.get("workload")} {p["id"]} ended: {value}'
                          f' (rc {(rec.get("result") or {}).get("rc")}, verified exit {v.get("verified_exit")})')
    return finish(m, value, bad, None)


def finish(m, value, bad, event):
    m['state'].update(value=value, checked=now())
    was = m['status']
    m['status'] = 'alarm' if bad else 'ok'
    if event:
        return event
    if bad and was != 'alarm':
        return bad
    if not bad and was == 'alarm':
        return f'recovered: {m["label"]} ({value})'
    return None


def raise_alarm(m, message):
    a = {'id': f'a-{secrets.token_hex(4)}', 'monitor': m['id'], 'label': m['label'], 'project': m['project'], 'at': now(),
         'message': message, 'delivered': None, 'external': None, 'owner': m.get('created_by')}
    with state_lock:
        alarms = hostlib.read_json(ALARMS, {})
        alarms[a['id']] = a
        hostlib.write_json(ALARMS, alarms)
    audit({'op': 'alarm', **a})
    log(f'ALARM {m["project"]} {m["label"]}: {message}')


def for_session(a, project, sess, sessions):
    """An undelivered alarm of this project that this session may take: its monitor's session while that session lives,
    otherwise any session of the project (a successor after a restart). A second Mina session on the same project took
    the main session's alarms before (2026-10-20: all 7 in an hour, while the goal session waited for them)."""
    if a['project'] != project or a['delivered']:
        return False
    owner = a.get('owner')
    if not owner or owner == sess:
        return True
    s = sessions.get(owner)
    return not (s and hostlib.alive(s['launcher']))


def op_alarms(project, sess, req):
    """Undelivered alarms this session may take (for_session); with ack, mark the given ones delivered to this session
    (the extension acks only after it has put the alarm into the conversation)."""
    sessions = hostlib.read_json(SESSIONS, {})
    with state_lock:
        alarms = hostlib.read_json(ALARMS, {})
        acked = []
        for aid in req.get('ack') or []:
            a = alarms.get(aid)
            if a and for_session(a, project, sess, sessions):
                a['delivered'] = {'session': sess, 'at': now()}
                acked.append(aid)
        if acked:
            hostlib.write_json(ALARMS, alarms)
            audit({'op': 'alarm_delivered', 'session': sess, 'alarms': acked})
    pending = [a for a in alarms.values() if for_session(a, project, sess, sessions)]
    return {'pending': sorted(pending, key=lambda a: a['at']), 'acked': acked}


def delivery_status(project):
    sessions = hostlib.read_json(SESSIONS, {})
    live = [k for k, v in sessions.items() if v['project'] == project and hostlib.alive(v['launcher'])]
    alarms = hostlib.read_json(ALARMS, {})
    pending = [a for a in alarms.values() if a['project'] == project and not a['delivered']]
    ext = config().get('alarm_command')
    return {'mina_sessions_live': len(live), 'undelivered': len(pending),
            'external_channel': 'configured' if ext else 'none: alarms reach a person only through a live Mina session, '
            'the audit log and the mina-hostd journal'}


def deliver_external():
    cmd = config().get('alarm_command')
    after = float(config().get('alarm_external_after_s', 120))
    if not cmd:
        return
    with state_lock:
        alarms = hostlib.read_json(ALARMS, {})
        todo = [a for a in alarms.values() if not a['delivered'] and not a['external'] and now() - a['at'] >= after]
    for a in todo:
        try:
            r = subprocess.run(cmd, input=json.dumps(a), capture_output=True, text=True, timeout=30)
            a['external'] = {'rc': r.returncode, 'at': now(), 'stderr': r.stderr[-300:]}
        except (OSError, subprocess.TimeoutExpired) as e:
            a['external'] = {'rc': None, 'at': now(), 'error': str(e)}
        with state_lock:
            alarms = hostlib.read_json(ALARMS, {})
            if a['id'] in alarms:
                alarms[a['id']]['external'] = a['external']
                if a['external'].get('rc') == 0:
                    alarms[a['id']]['delivered'] = {'external': True, 'at': now()}
                hostlib.write_json(ALARMS, alarms)
        audit({'op': 'alarm_external', 'alarm': a['id'], 'result': a['external']})


# --- capabilities ----------------------------------------------------------------------------------------------------


def fingerprint(project):
    p = project_config(project) or {}
    parts = [VERSION, (_policy.get() or read_policy())['sha'], hostlib.boot_id(), project]
    for name, s in sorted((p.get('services') or {}).items()):
        info = show(s['unit'], ['LoadState', 'ActiveState', 'MainPID'])
        parts.append(f'{name}:{info}')
        for f in source_files(project, s):
            try:
                parts.append(f'{f}:{os.stat(f).st_mtime_ns}')
            except OSError:
                parts.append(f'{f}:missing')
    for name, r in sorted((p.get('resources') or {}).items()):
        parts += [f'{lo}:{os.path.exists(lo)}' for lo in r.get('lockouts', [])]
        parts += [f'{e["path"]}:{os.path.exists(e["path"])}' for e in r.get('locks', [])]
        parts += [f'{u}:{hostlib.unit_active(u)}' for u in r.get('requires_active', [])]
    return hashlib.sha256('\n'.join(map(str, parts)).encode()).hexdigest()[:16]


def capabilities(project, refresh=False):
    fp = fingerprint(project)
    hit = cap_cache.get(project)
    if hit and hit[0] == fp and not refresh:
        return {**hit[1], 'cached': True}
    caps = []

    def cap(name, status, detail, missing=None, remediation=None, **extra):
        caps.append({k: v for k, v in {'capability': name, 'status': status, 'detail': detail, 'missing': missing,
                                       'remediation': remediation, **extra}.items() if v is not None})

    p = project_config(project)
    if p is None:
        cap('project', 'REQUIRES_AUTHORIZATION', f'{project} is not registered with the host broker', 'a project entry in host.json',
            UNREGISTERED.format(project=project, config=CONFIG))
        result = {'project': project, 'broker': VERSION, 'confirmation_protocol': PROTOCOL, 'mutation_protocol': MUTATION_OP, 'checked_at': iso(), 'fingerprint': fp, 'policy_source': None, 'capabilities': caps}
        cap_cache[project] = (fp, result)
        return result
    classes = p.get('classes') or {}
    if policy_source(project) == 'defaults' and 'services' in (config().get('defaults') or {}):
        cap('services', 'BLOCKED', 'host.json defaults has "services"; the broker ignores them, because a service belongs to '
            'one project', 'a registration of this project', f'Register "{project}" under "projects" with its services.')

    def approval(cls):
        lvl = classes.get(cls, 'allow' if cls == 'observe' else 'deny')
        return lvl

    # Host observation: the registered log and sensor paths.
    paths = p.get('monitor_paths', [])
    unreadable = [x for x in paths if not os.access(x, os.R_OK)]
    cap('host_observation', 'BLOCKED' if unreadable else 'AVAILABLE',
        f'{len(paths) - len(unreadable)} registered telemetry path(s) readable by the broker; other users\' open files are '
        'not visible to it (it has no root)', unreadable or None,
        'Fix the paths in monitor_paths, or the files\' permissions.' if unreadable else None)
    # Services.
    for name, s in sorted((p.get('services') or {}).items()):
        info = show(s['unit'])
        loaded = info.get('LoadState') == 'loaded'
        cap(f'service:{name}:inspect', 'AVAILABLE' if loaded else 'BLOCKED',
            f'{s["unit"]} {info.get("LoadState")}/{info.get("ActiveState")}', None if loaded else 'the unit is not loaded',
            None if loaded else f'Start or install {s["unit"]} (systemctl --user).')
        lvl = min(approval('restart'), s.get('restart', 'deny'), key=lambda x: LEVEL.get(x, 0))
        status = {'allow': 'AVAILABLE', 'ask': 'REQUIRES_AUTHORIZATION'}.get(lvl, 'REQUIRES_AUTHORIZATION')
        cap(f'service:{name}:restart', status if loaded else 'BLOCKED',
            {'allow': 'pre-approved; idle resources and deployment verification enforced',
             'ask': 'the user confirms each restart in the Mina session (mina_host asks)'}.get(lvl, 'not approved'),
            None if lvl != 'deny' else f'restart approval for {name}',
            None if lvl != 'deny' else snippet(project, f'services.{name}.restart', 'ask') + f' and classes.restart = "ask"')
        dep = deployment(project, name, s, info)
        cap(f'service:{name}:deployment', 'AVAILABLE' if dep['verdict'] in ('FRESH', 'STALE', 'NOT_RUNNING') else 'BLOCKED',
            f'verdict {dep["verdict"]}' + (f': changed after start {dep["sources_changed_after_start"]}' if dep['verdict'] == 'STALE' else '')
            + (f'; git {dep["git"]["head"]}, uncommitted {dep["git"]["sources_uncommitted"]}' if dep.get('git') else ''),
            dep['sources_unreadable'] or None)
    # Resources: the machine's own and the policy's (a policy entry replaces a machine entry of the same name).
    origins = resource_origins(project)
    for name, r in sorted((p.get('resources') or {}).items()):
        problems = []
        for lo in r.get('lockouts', []):
            if os.path.exists(lo):
                problems.append(f'safety lockout {lo}')
        for u in r.get('requires_active', []):
            if hostlib.unit_active(u) != 'active':
                problems.append(f'{u} not active')
        shared = []
        for u in r.get('requires_active', []):
            pid = num(show(u, ['MainPID']).get('MainPID'))
            if pid:
                shared.append(f'{u}:{"same" if hostlib.mnt_ns(pid) == hostlib.mnt_ns() else "DIFFERENT"}')
        if any(x.endswith('DIFFERENT') for x in shared):
            problems.append(f'the broker sees a different /tmp than {shared}: its locks would be a private lock universe')
        proto = r.get('protocol_source')
        participation = 'unverified (no protocol_source registered)'
        if proto:
            try:
                text = open(proto).read()
                names = [os.path.basename(e['path']).removesuffix('.lock') for e in r.get('locks', [])]
                dirs = {os.path.dirname(e['path']) for e in r.get('locks', [])}
                found = [n for n in names if n in text]
                participation = (f'{os.path.basename(proto)} uses the same lock names {found}' if len(found) == len(names)
                                 and any(d in text for d in dirs) else f'NOT verified in {proto}: names found {found} of {names}')
            except OSError as e:
                participation = f'protocol_source unreadable: {e.strerror}'
        lvl = approval('reserve')
        status = 'BLOCKED' if problems else 'AVAILABLE' if lvl == 'allow' else 'REQUIRES_AUTHORIZATION'
        cap(f'resource:{name}', status, f'host locks {[e["path"] for e in r.get("locks", [])]}; production runner participation: '
            f'{participation}; lock universe shared with {shared or "no supervisor checked"}', problems or (None if lvl == 'allow' else 'reserve approval'),
            ('An operator clears lockouts after investigating; mina never does.' if any('lockout' in x for x in problems) else
             'Start the supervisor unit.' if problems else None if lvl == 'allow' else snippet(project, 'classes.reserve', 'allow')),
            source=origins.get(name, 'project'))
    # Containment.
    app = show('app.slice', ['ControlGroup']).get('ControlGroup', '')
    delegated = app.startswith(f'/user.slice/user-{UID}.slice/user@{UID}.service/')
    has_kill = os.path.exists(f'/sys/fs/cgroup{app}/cgroup.kill') if app else False
    ok = delegated and has_kill
    lvl = approval('workload')
    cap('process_containment', 'BLOCKED' if not ok else 'AVAILABLE' if lvl == 'allow' else 'REQUIRES_AUTHORIZATION',
        'each registered workload runs in its own transient systemd user service (own cgroup, RuntimeMaxSec deadline, '
        'KillMode=control-group); stop affects only that cgroup and exit is verified per process identity',
        None if ok else 'a delegated cgroup v2 user manager with cgroup.kill',
        None if ok else 'Run on systemd with cgroup v2 (unified hierarchy).' if not delegated else None)
    for name, w in sorted((p.get('workloads') or {}).items()):
        changed = [path.replace('{project}', project) for path, want in (w.get('pin') or {}).items()
                   if sha256_file(path.replace('{project}', project)) != want]
        status = 'BLOCKED' if not ok or changed else 'AVAILABLE' if lvl == 'allow' else 'REQUIRES_AUTHORIZATION'
        cap(f'workload:{name}', status,
            (w.get('description', '') + '; ' if w.get('description') else '')
            + f'resources {w.get("resources", [])}, max {w.get("max_s", 600)}s'
            + (f', params {sorted(w["params"])}' if w.get('params') else '')
            + ''.join(f'; {k} from {"|".join(v)}' for k, v in sorted(param_values(w).items()))
            + ((', takes command: an argv run in a sandbox (GPUs available; writable '
                f'{w.get("sandbox", {}).get("write", ["{project}"])}, read-only {w.get("sandbox", {}).get("readonly", [])}; '
                f'network {w.get("sandbox", {}).get("network", "offline")})'
                if w.get('command_sandbox', True) else ', takes command: an argv the launcher runs in its own sandbox')
               if '{command}' in w['argv'] else '')
            + (f', requires fresh {w["requires_fresh"]}' if w.get('requires_fresh') else ''),
            (f'pinned files changed since approval: {changed}' if changed else None) or (None if lvl == 'allow' else 'workload approval'),
            ('The user reviews the change and updates the pin in host.json.' if changed else None)
            or (None if lvl == 'allow' else snippet(project, 'classes.workload', 'allow')))
    # Monitoring.
    hb = os.path.join(STATE, 'heartbeat')
    fresh = os.path.exists(hb) and now() - os.stat(hb).st_mtime < 30
    lvl = approval('monitor')
    cap('monitoring', 'BLOCKED' if not fresh else 'AVAILABLE' if lvl == 'allow' else 'REQUIRES_AUTHORIZATION',
        'host-side monitors evaluated by the broker every few seconds, independent of the Mina session; alarms are kept '
        'until a Mina session of this project acknowledges them', None if fresh else 'the broker\'s monitor loop is not running',
        None if fresh else 'systemctl --user restart mina-hostd' if lvl == 'allow' else snippet(project, 'classes.monitor', 'allow'))
    ext = config().get('alarm_command')
    cap('alarm_delivery_external', 'AVAILABLE' if ext else 'BLOCKED',
        f'command {ext[0]}' if ext else 'no external channel: with no live Mina session an alarm waits in the broker (and '
        'its journal) until one connects', None if ext else 'an alarm_command in host.json',
        None if ext else f'Set "alarm_command": ["<notifier>", ...] in {CONFIG}; it receives each alarm as JSON on stdin.')
    result = {'project': project, 'broker': VERSION, 'confirmation_protocol': PROTOCOL, 'mutation_protocol': MUTATION_OP, 'checked_at': iso(), 'fingerprint': fp, 'policy_source': policy_source(project), 'capabilities': caps}
    cap_cache[project] = (fp, result)
    hostlib.write_json(os.path.join(STATE, 'capabilities', f'{tag(project)}.json'), result)
    return result


def param_values(w):
    """The allowed names of a param whose pattern is a list of names (a campaign runner's lock names), so the agent need
    not guess them from file names (it passed a lock file's name instead of the lock's, in two sessions)."""
    out = {}
    for k, pat in (w.get('params') or {}).items():
        names = re.findall(r'[A-Z][A-Z0-9_]{2,}', pat)
        if names and re.fullmatch(r'[\^$()|,*+?A-Z0-9_]+', pat):
            out[k] = list(dict.fromkeys(names))
    return out


def op_capabilities(project, sess, req):
    result = copy.deepcopy(capabilities(project, refresh=bool(req.get('refresh'))))
    if sess == 'host-user':
        return result
    status = op_workload_budget(project, sess, {})
    result['admission_budget'] = status
    for cap in result['capabilities']:
        if not cap['capability'].startswith('workload:') or cap['status'] == 'BLOCKED':
            continue
        name = cap['capability'].removeprefix('workload:')
        w = ((project_config(project) or {}).get('workloads') or {}).get(name, {})
        queue_s = w.get('queue_s', 0)
        if type(queue_s) is not int or queue_s < 0:
            cap.update(status='BLOCKED', remediation='The operator corrects queue_s to a nonnegative integer.')
            continue
        try:
            check_workload_budget(project, sess, name, 1 + queue_s)
        except Refusal as e:
            cap.update(status=e.code if e.code == 'REQUIRES_AUTHORIZATION' else 'BLOCKED',
                       remediation=e.message, budget_limited=True)
    return result


# --- the loop --------------------------------------------------------------------------------------------------------


def loop():
    while True:
        try:
            Path(STATE, 'heartbeat').touch()
            for rid, r in list(reservations.items()):
                if now() >= r['expires']:
                    release(rid, 'expired')
            if os.path.isdir(WL):
                for wid in os.listdir(WL):
                    # Read the record under the lock: a copy read before it can miss a stop that workload_stop recorded
                    # meanwhile, and would then record the stopped workload as terminated.
                    with state_lock:
                        rec = hostlib.read_json(os.path.join(WL, wid, 'record.json'))
                        if rec and rec['state'] in ('launching', 'starting', 'running', 'containment_unknown'):
                            reconcile_workload(rec)
            fired = []
            with state_lock:
                mons = hostlib.read_json(MONITORS, {})
                for mid, m in list(mons.items()):
                    if now() >= m['expires']:
                        del mons[mid]
                        audit({'op': 'monitor_expired', 'monitor': mid, 'project': m['project']})
                        continue
                    try:
                        msg = evaluate(m)
                    except Refusal as e:
                        msg = f'monitor cannot be evaluated: {e.message}'
                    if msg:
                        fired.append((m, msg))
                hostlib.write_json(MONITORS, mons)
            for m, msg in fired:
                raise_alarm(m, msg)
            deliver_external()
        except Exception as e:  # the loop must outlive one bad record; the error is logged and audited
            log(f'LOOP_ERROR {type(e).__name__}: {e}')
            audit({'op': 'loop_error', 'error': f'{type(e).__name__}: {e}'})
        time.sleep(TICK_S)


OPS = {'capabilities': ('observe', op_capabilities), 'service_status': ('observe', op_service_status),
       'service_logs': ('observe', op_service_logs), 'service_restart': ('restart', op_service_restart),
       'reserve': ('reserve', op_reserve), 'release': ('reserve', op_release),
       'workload_run': ('workload', op_workload_run), 'workload_status': ('observe', op_workload_status),
       'workload_budget': ('observe', op_workload_budget), 'workload_output': ('observe', op_workload_output),
       'workload_stop': ('workload', op_workload_stop), 'monitor_add': ('monitor', op_monitor_add),
       'monitor_list': ('observe', op_monitor_list), 'monitor_remove': ('monitor', op_monitor_remove),
       'alarms': ('observe', op_alarms)}
REQUEST_PROTOCOL = 'mina-workload-request-v1'
_request = threading.local()   # the project of the request in this handler thread, for its audit record
MUTATIONS = frozenset(op for op, (cls, _fn) in OPS.items() if cls != 'observe')


@with_policy
def handle(req, pid, uid):
    if uid != UID:
        raise Refusal('UNAUTHENTICATED', 'another user')
    if not isinstance(req, dict):
        raise Refusal('INVALID', 'host request must be an object')
    op = req.get('op')
    if op in (MUTATION_OP, 'mutate_v1'):
        action, args = req.get('action'), req.get('args')
        if (not isinstance(action, str) or action not in MUTATIONS or not isinstance(args, dict)
                or {'grant', 'op'}.intersection(args) or set(req) - {'op', 'action', 'args', 'grant', 'request_protocol'}
                or ('request_protocol' in req and (req['request_protocol'] != REQUEST_PROTOCOL
                    or action != 'workload_run' or 'request_id' not in args))):
            raise Refusal('INVALID', 'invalid versioned mutation envelope')
        req = {**args, 'op': action, 'grant': req.get('grant')}
        op = action
    if op == 'ping':
        return {'broker': VERSION, 'pid': os.getpid(), 'confirmation_protocol': PROTOCOL, 'mutation_protocol': MUTATION_OP}
    if op == 'session_open':
        return op_session_open(req, pid)
    if op not in OPS:
        raise Refusal('INVALID', f'unknown operation {op!r}; operations: {sorted(OPS)}')
    if req.get('grant'):
        sess, s = session_for(req['grant'], pid)
        project = s['project']
    elif host_peer(pid) and op in ('capabilities', 'service_status', 'workload_status', 'monitor_list'):
        sess, project = 'host-user', os.path.realpath(req.get('project') or '')   # the user, from a shell outside the sandbox
    else:
        raise Refusal('UNAUTHENTICATED', 'a host session grant is required')
    _request.project = project
    cls, fn = OPS[op]
    # Class admission here; mutation handlers also enforce per-operation ask, including service restart policy.
    if not (op == 'capabilities' and project_config(project) is None):   # an unregistered project still learns what it lacks
        require_class(project, cls)
    return fn(project, sess, req)


def public_confirmation(value):
    value = copy.deepcopy(value)
    if isinstance(value, dict):
        token = value.pop('challenge', None)
        if isinstance(token, str):
            value['challenge_id'] = hashlib.sha256(token.encode()).hexdigest()[:24]
    return value


def audit_safe(req, error):
    """Retain correlatable challenge IDs, never bearer tokens, in both directions of the wire protocol."""
    safe = copy.deepcopy(req) if isinstance(req, dict) else {}
    safe.pop('grant', None)
    args = safe.get('args') if safe.get('op') in (MUTATION_OP, 'mutate_v1') else safe
    if isinstance(args, dict):
        args.pop('grant', None)
        if 'approval' in args:
            args['approval'] = public_confirmation(args['approval'])
    error = copy.deepcopy(error)
    if isinstance(error, dict) and 'approval_request' in error:
        error['approval_request'] = public_confirmation(error['approval_request'])
    return safe, error


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        pid, uid = peer_of(self.connection)
        line = self.rfile.readline(1 << 20)
        req, t0 = {}, now()
        _request.project = None
        try:
            req = json.loads(line)
            out = {'ok': True, 'result': handle(req, pid, uid)}
        except Refusal as e:
            out = {'ok': False, 'error': {'code': e.code, 'message': e.message, **e.detail}}
        except Exception as e:
            out = {'ok': False, 'error': {'code': 'FAILED', 'message': f'{type(e).__name__}: {e}'}}
        safe, error = audit_safe(req, None if out['ok'] else out['error'])
        rec = {'op': safe.get('op'), 'peer': pid, 'request': safe, 'ok': out['ok'], 'error': error, 'ms': round((now() - t0) * 1000)}
        try:
            if _request.project and policy_source(_request.project) == 'defaults':
                rec.update(project=_request.project, policy_source='defaults')
        except Exception:  # an unreadable policy must not stop the audit record
            pass
        audit(rec)
        self.wfile.write((json.dumps(out, default=str) + '\n').encode())


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def serve():
    os.makedirs(RUNTIME, mode=0o700, exist_ok=True)
    os.chmod(RUNTIME, 0o700)
    ensure_state_dir()
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    # Reservations do not survive the broker: the kernel released their locks with the process. Say so.
    for rid, r in (hostlib.read_json(os.path.join(STATE, 'reservations.json'), {}) or {}).items():
        audit({'op': 'release', 'reservation': rid, 'project': r.get('project'), 'why': 'broker restarted: lock released by the kernel'})
    hostlib.write_json(os.path.join(STATE, 'reservations.json'), {})
    srv = Server(SOCKET, Handler)
    os.chmod(SOCKET, 0o600)
    threading.Thread(target=loop, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: (srv.server_close(), os._exit(0)))
    log(f'START mina-hostd {VERSION} pid={os.getpid()} socket={SOCKET} config={CONFIG} state={STATE}')
    audit({'op': 'start', 'pid': os.getpid(), 'config_sha': config() and _config['sha']})
    srv.serve_forever()


UNIT = """[Unit]
Description=mina host broker (engineering-host profile, docs/host-profile.md)

[Service]
Type=simple
ExecStart={python} {script} serve
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
"""


def install():
    d = os.path.expanduser('~/.config/systemd/user')
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, 'mina-hostd.service')
    with open(path, 'w') as f:
        f.write(UNIT.format(python=sys.executable, script=os.path.abspath(__file__)))
    for args in (['daemon-reload'], ['enable', '--now', 'mina-hostd.service']):
        r = systemctl(*args)
        if r.returncode:
            sys.exit(f'systemctl --user {" ".join(args)}: {r.stderr.strip()}')
    print(f'installed {path}; mina-hostd is {systemctl("is-active", "mina-hostd").stdout.strip()}')


def request(req):
    s = socket.socket(socket.AF_UNIX)
    s.connect(SOCKET)
    s.sendall((json.dumps(req) + '\n').encode())
    data = b''
    while not data.endswith(b'\n'):
        chunk = s.recv(65536)
        if not chunk:
            break
        data += chunk
    return json.loads(data)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'serve'
    if cmd == 'serve':
        serve()
    elif cmd == 'install':
        install()
    elif cmd == 'status':
        project = os.path.realpath(sys.argv[2] if len(sys.argv) > 2 else os.getcwd())
        print(json.dumps(request({'op': 'capabilities', 'project': project, 'refresh': True}), indent=1))
    else:
        sys.exit(__doc__)
