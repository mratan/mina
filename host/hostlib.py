"""Shared helpers of mina's host broker (host/hostd.py) and its workload lock holder (host/lockrun.py).

Process identity is (pid, kernel start ticks), never a pid alone. Locks are the host's own flock files, taken
non-blocking: a conflict is reported with the holders' evidence, never waited on. Standard library only.
"""
import fcntl
import json
import os
import subprocess
import tempfile

# --- processes -------------------------------------------------------------------------------------------------------


def boot_id():
    with open('/proc/sys/kernel/random/boot_id') as f:
        return f.read().strip()


def proc_stat(pid):
    """{ppid, start, state, comm} of a live process, or None."""
    try:
        with open(f'/proc/{pid}/stat') as f:
            raw = f.read()
    except (FileNotFoundError, ProcessLookupError):
        return None
    comm = raw[raw.index('(') + 1:raw.rindex(')')]
    fields = raw[raw.rindex(')') + 2:].split()
    return {'pid': int(pid), 'ppid': int(fields[1]), 'state': fields[0], 'start': int(fields[19]), 'comm': comm}


def identity(pid):
    st = proc_stat(pid)
    return {'pid': int(pid), 'start': st['start']} if st else None


def alive(ident):
    """Whether this exact process (pid and start ticks) still runs. A reused pid is not it."""
    st = proc_stat(ident['pid'])
    return bool(st) and st['start'] == ident['start'] and st['state'] != 'Z'


def cmdline(pid):
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f:
            return [a.decode(errors='replace') for a in f.read().split(b'\0') if a]
    except OSError:
        return None


def mnt_ns(pid='self'):
    try:
        return os.readlink(f'/proc/{pid}/ns/mnt')
    except OSError:
        return None


def own_processes():
    """Live processes of this user: {pid: argv}. Other users' processes are skipped (their /proc entries are not ours)."""
    out = {}
    uid = os.getuid()
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            if os.stat(f'/proc/{name}').st_uid != uid:
                continue
        except OSError:
            continue
        argv = cmdline(name)
        if argv:
            out[int(name)] = argv
    return out


def cgroup_members(cgroup_dir):
    """Identities of every process in a cgroup tree, or None if the cgroup does not exist."""
    if not os.path.isdir(cgroup_dir):
        return None
    out = []
    for root, _dirs, files in os.walk(cgroup_dir):
        if 'cgroup.procs' not in files:
            continue
        try:
            with open(os.path.join(root, 'cgroup.procs')) as f:
                pids = [int(x) for x in f.read().split()]
        except OSError:
            continue
        out += [i for i in (identity(p) for p in pids) if i]
    return out


# --- files -----------------------------------------------------------------------------------------------------------


def write_json(path, data):
    """Atomic: a reader sees the old or the new file, never half of one."""
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.tmp-')
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


# --- locks -----------------------------------------------------------------------------------------------------------


class LockConflict(Exception):
    def __init__(self, path, why, holders):
        super().__init__(f'{path}: {why}')
        self.evidence = {'lock': path, 'why': why, 'holders': holders}


def lock_holders(path):
    """Processes that hold (or wait for) a flock on this file, from /proc/locks: [{pid, mode, waiting, argv}]."""
    try:
        st = os.stat(path)
    except OSError:
        return []
    key = f'{os.major(st.st_dev):02x}:{os.minor(st.st_dev):02x}:{st.st_ino}'
    out = []
    with open('/proc/locks') as f:
        for line in f:
            parts = line.split()
            waiting = '->' in parts
            if waiting:
                parts.remove('->')
            if len(parts) < 6 or parts[1] != 'FLOCK' or parts[5] != key:
                continue
            pid = int(parts[4])
            out.append({'pid': pid, 'mode': parts[3], 'waiting': waiting, 'argv': (cmdline(pid) or ['?'])[:6]})
    return out


def acquire(entries):
    """Take each lock exclusively, in order, without waiting. An entry is {path, turnstile?}: a turnstile is the file that
    a waiting campaign runner holds while it queues for the lock (for example an MTURN or TURNSTILE file). A held turnstile means
    someone is queued ahead, so it is a conflict too: the broker never jumps a queue. Returns the open descriptors; on a
    conflict, closes what it took and raises LockConflict with the holders."""
    fds = []
    try:
        for e in entries:
            os.makedirs(os.path.dirname(e['path']), exist_ok=True)
            turn = None
            try:
                if e.get('turnstile'):
                    turn = os.open(e['turnstile'], os.O_RDWR | os.O_CREAT, 0o664)
                    try:
                        fcntl.flock(turn, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        raise LockConflict(e['turnstile'], 'a campaign runner is queued for this lock', lock_holders(e['turnstile']))
                fd = os.open(e['path'], os.O_RDWR | os.O_CREAT, 0o664)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    os.close(fd)
                    raise LockConflict(e['path'], 'held by another process', lock_holders(e['path']))
                fds.append(fd)
            finally:
                if turn is not None:
                    os.close(turn)
        return fds
    except BaseException:
        for fd in fds:
            os.close(fd)
        raise


def lock_entries(resources, names):
    """The ordered, de-duplicated lock list for some registered resources (a lock shared by two resources is taken once,
    where it first appears)."""
    out, seen = [], set()
    for n in names:
        for e in resources[n].get('locks', []):
            if e['path'] not in seen:
                seen.add(e['path'])
                out.append(e)
    return out


# --- devices and preconditions ---------------------------------------------------------------------------------------

KFD_PROC = '/sys/class/kfd/kfd/proc'


def device_users(device):
    """Processes that use a GPU, whoever owns them: [pid], or raises RuntimeError when that cannot be known.
    {'kfd': true}: every AMD compute user (/sys/class/kfd/kfd/proc lists them for all users).
    {'nvidia': [bus ids]}: compute apps on those NVIDIA GPUs (nvidia-smi lists them for all users)."""
    users = []
    if device.get('kfd'):
        root = os.environ.get('MINA_HOST_KFD_PROC', KFD_PROC)
        if not os.path.isdir(root):
            raise RuntimeError(f'{root} is missing: AMD GPU users cannot be listed')
        users += [int(p) for p in os.listdir(root) if p.isdigit()]
    if device.get('nvidia'):
        try:
            r = subprocess.run(['nvidia-smi', '--query-compute-apps=pid,gpu_bus_id', '--format=csv,noheader'],
                               capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise RuntimeError(f'nvidia-smi: {e}')
        if r.returncode != 0:
            raise RuntimeError(f'nvidia-smi exited {r.returncode}: {r.stderr.strip()[:200]}')
        want = {b.lower()[-12:] for b in device['nvidia']}
        for line in r.stdout.splitlines():
            parts = [p.strip() for p in line.split(',')]
            if len(parts) == 2 and parts[0].isdigit() and parts[1].lower()[-12:] in want:
                users.append(int(parts[0]))
    return users


def unit_active(unit):
    r = subprocess.run(['systemctl', '--user', 'is-active', unit], capture_output=True, text=True, timeout=15)
    return r.stdout.strip()


def resource_problems(resources, names, ignore_pids=()):
    """Why these resources may not be used now (empty: they may): a safety lockout, a required supervisor that is not
    active, or a GPU in use by a process outside the lock protocol. Unknown counts as a problem (fail closed)."""
    problems = []
    for n in names:
        r = resources[n]
        for path in r.get('lockouts', []):
            if os.path.exists(path):
                try:
                    with open(path) as f:
                        why = f.read(300).strip()
                except OSError:
                    why = ''
                problems.append({'resource': n, 'kind': 'lockout', 'path': path, 'detail': why,
                                 'remediation': 'An operator clears a safety lockout after investigating it. mina never clears one.'})
        for unit in r.get('requires_active', []):
            state = unit_active(unit)
            if state != 'active':
                problems.append({'resource': n, 'kind': 'supervisor', 'unit': unit, 'detail': f'{unit} is {state or "unknown"}'})
        if r.get('device'):
            try:
                users = [p for p in device_users(r['device']) if p not in ignore_pids]
            except RuntimeError as e:
                problems.append({'resource': n, 'kind': 'device_unknown', 'detail': str(e)})
                continue
            if users:
                problems.append({'resource': n, 'kind': 'device_busy', 'pids': users,
                                 'argv': {p: (cmdline(p) or ['?'])[:6] for p in users}})
    return problems
