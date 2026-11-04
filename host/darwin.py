"""The macOS side of mina's host broker (docs/host-profile.md, "macOS"). On Linux the broker uses /proc, cgroups,
systemd and bwrap. Here the same facts come from libproc, resource coalitions, launchd and Seatbelt. System Python
(/usr/bin/python3) and ctypes only.

A resource coalition is the macOS counterpart of a cgroup. launchd gives each job its own coalition, and no process can
leave its coalition (setsid and double forks stay in it). The kernel does not reuse a coalition ID before a reboot.
Process identity is (pid, start time in microseconds), as (pid, start ticks) on Linux.
"""
import ctypes
import fcntl
import functools
import os
import plistlib
import re
import signal
import stat
import struct
import subprocess
import time

LAUNCHCTL = '/bin/launchctl'
SANDBOX_EXEC = '/usr/bin/sandbox-exec'
ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'}
# The labels of Mina's own jobs (sandbox/macos/launchd.mjs): an instance, and the calls of an instance.
MINA_JOBS = ('com.mina.instance.', 'com.mina.call.')

_c = ctypes
_lib = _c.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
_lib.proc_pidinfo.argtypes = [_c.c_int, _c.c_int, _c.c_uint64, _c.c_void_p, _c.c_int]
_lib.proc_pidfdinfo.argtypes = [_c.c_int, _c.c_int, _c.c_int, _c.c_void_p, _c.c_int]
_lib.proc_listallpids.argtypes = [_c.c_void_p, _c.c_int]
_lib.proc_pid_rusage.argtypes = [_c.c_int, _c.c_int, _c.c_void_p]
_lib.sysctl.argtypes = [_c.POINTER(_c.c_int), _c.c_uint, _c.c_void_p, _c.POINTER(_c.c_size_t), _c.c_void_p, _c.c_size_t]
_lib.sysctlbyname.argtypes = [_c.c_char_p, _c.c_void_p, _c.POINTER(_c.c_size_t), _c.c_void_p, _c.c_size_t]
# sandbox_check(pid, operation, filter type, ...): only the fixed arguments are passed.
_lib.sandbox_check.argtypes = [_c.c_int, _c.c_char_p, _c.c_int]
_lib.sandbox_check.restype = _c.c_int
_lib.coalition_info_resource_usage.argtypes = [_c.c_uint64, _c.c_void_p, _c.c_size_t]
_lib.proc_pidpath.argtypes = [_c.c_int, _c.c_void_p, _c.c_uint32]

# <sys/proc_info.h>; PROC_PIDCOALITIONINFO is in xnu bsd/sys/proc_info_private.h (uint64 resource, jetsam, 3 reserved).
PROC_PIDLISTFDS, PROC_PIDTBSDINFO, PROC_PIDTASKINFO, PROC_PIDCOALITIONINFO = 1, 3, 4, 20
PROC_PIDFDVNODEPATHINFO, PROX_FDTYPE_VNODE = 2, 1
BSDINFO_SIZE, TASKINFO_SIZE, VNODEPATH_SIZE = 136, 96, 1200
RUSAGE_INFO_V2 = 2
# The open-file flag that the kernel sets when flock() takes a lock on the file (xnu FWASLOCKED). A waiter or a failed
# LOCK_NB attempt does not have it. LOCK_UN does not clear it: the file then looks held until it is closed.
FWASLOCKED = 0x4000
STATES = {1: 'I', 2: 'R', 3: 'S', 4: 'T', 5: 'Z'}   # SIDL SRUN SSLEEP SSTOP SZOMB, as the letters of /proc/PID/stat


def _sysctlbyname(name, size=256):
    n = _c.c_size_t(size)
    buf = _c.create_string_buffer(size)
    if _lib.sysctlbyname(name.encode(), buf, _c.byref(n), None, 0) != 0:
        raise OSError(_c.get_errno(), f'sysctl {name}')
    return buf.raw[:n.value]


def boot_id():
    return _sysctlbyname('kern.bootsessionuuid').rstrip(b'\0').decode()


def boot_time():
    """Boot time in epoch seconds, from kern.boottime (a timeval)."""
    sec, usec = struct.unpack_from('qi', _sysctlbyname('kern.boottime'))
    return sec + usec / 1e6


def all_pids():
    n = _lib.proc_listallpids(None, 0)
    cap = max(n, 0) + 1024
    buf = (_c.c_int * cap)()
    n = _lib.proc_listallpids(buf, _c.sizeof(buf))
    return [p for p in buf[:max(n, 0)] if p > 0]


def bsdinfo(pid):
    """{pid, ppid, uid, state, start, comm} of a live process of this user, or None. A zombie and another user's
    process give None (proc_pidinfo refuses both)."""
    buf = _c.create_string_buffer(BSDINFO_SIZE)
    if _lib.proc_pidinfo(int(pid), PROC_PIDTBSDINFO, 0, buf, BSDINFO_SIZE) != BSDINFO_SIZE:
        return None
    f = struct.unpack_from('12I', buf.raw, 0)
    comm = buf.raw[48:64].split(b'\0', 1)[0] or b''
    name = buf.raw[64:96].split(b'\0', 1)[0] or comm
    sec, usec = struct.unpack_from('qq', buf.raw, 120)
    return {'pid': f[3], 'ppid': f[4], 'uid': f[5], 'state': STATES.get(f[1], '?'), 'start': sec * 1000000 + usec,
            'comm': name.decode(errors='replace')}


def pidpath(pid):
    """The executable of a process, or None (gone, or not readable for this user)."""
    buf = _c.create_string_buffer(4096)
    n = _lib.proc_pidpath(pid, buf, 4096)
    return buf.value.decode(errors='replace') if n > 0 else None


def cmdline(pid):
    """argv of a process of this user (sysctl KERN_PROCARGS2), or None."""
    mib = (_c.c_int * 3)(1, 49, int(pid))     # CTL_KERN, KERN_PROCARGS2
    size = _c.c_size_t(1 << 20)
    buf = _c.create_string_buffer(size.value)
    if _lib.sysctl(mib, 3, buf, _c.byref(size), None, 0) != 0 or size.value < 4:
        return None
    raw = buf.raw[:size.value]
    argc = struct.unpack_from('i', raw)[0]
    _exe, _, rest = raw[4:].partition(b'\0')
    args = rest.lstrip(b'\0').split(b'\0')[:argc]
    return [a.decode(errors='replace') for a in args if a]


def running_threads(pid):
    """The number of threads of a process that run now (proc_taskinfo pti_numrunning), or None."""
    buf = _c.create_string_buffer(TASKINFO_SIZE)
    if _lib.proc_pidinfo(int(pid), PROC_PIDTASKINFO, 0, buf, TASKINFO_SIZE) != TASKINFO_SIZE:
        return None
    return struct.unpack_from('i', buf.raw, 88)[0]


def footprint(pid):
    buf = _c.create_string_buffer(256)
    if _lib.proc_pid_rusage(int(pid), RUSAGE_INFO_V2, buf) != 0:
        return None
    return struct.unpack_from('Q', buf.raw, 72)[0]   # ri_phys_footprint


# --- coalitions -----------------------------------------------------------------------------------------------------


def coalition_of(pid):
    """The resource coalition ID of a process, or None (gone, or a zombie). It works for other users' processes too."""
    buf = (_c.c_uint64 * 5)()
    if _lib.proc_pidinfo(int(pid), PROC_PIDCOALITIONINFO, 0, buf, _c.sizeof(buf)) != _c.sizeof(buf):
        return None
    return int(buf[0]) or None


def coalition_pids(cids, exclude=()):
    cids = {int(c) for c in cids if c}
    skip = {1, os.getpid(), *exclude}
    return [p for p in all_pids() if p not in skip and coalition_of(p) in cids] if cids else []


def members(cid):
    """The live processes of a coalition: identities, or {pid, start: None} for a process that this user cannot
    inspect (a setuid program). Such a member still counts: it is alive, and it is not verified gone."""
    out = []
    for p in coalition_pids([cid]):
        st = bsdinfo(p)
        if st and st['state'] == 'Z':
            continue
        out.append({'pid': p, 'start': st['start']} if st else {'pid': p, 'start': None})
    return out


_timebase = None


def usage(cid):
    """{memory, cpu_ns, tasks} of a coalition: the footprint of its live members, the CPU time of all its processes
    (also those that exited: coalition_info_resource_usage), the number of live members."""
    global _timebase
    if _timebase is None:
        tb = (_c.c_uint32 * 2)()
        _lib.mach_timebase_info(tb)
        _timebase = (tb[0], tb[1] or 1)
    live = members(cid)
    mem = sum(footprint(m['pid']) or 0 for m in live)
    buf = _c.create_string_buffer(1024)
    cpu = None
    if _lib.coalition_info_resource_usage(int(cid), buf, 1024) == 0:
        cpu = struct.unpack_from('Q', buf.raw, 24)[0] * _timebase[0] // _timebase[1]   # cpu_time, in mach ticks
    return {'memory': mem, 'cpu_ns': cpu, 'tasks': len(live)}


def sweep(cids, exclude=(), rounds=5000):
    """Stop every member of these coalitions, except this process: SIGSTOP (a stopped process cannot fork), then
    SIGKILL, in rounds until none remains (as `mina-instance sweep`). A member that this user cannot signal (a setuid
    program) is left out of the next rounds. Returns the members that remain."""
    stuck = set()
    for _ in range(rounds):
        pids = [p for p in coalition_pids(cids, exclude) if p not in stuck]
        if not pids:
            break
        for p in pids:
            try:
                os.kill(p, signal.SIGSTOP)
            except PermissionError:
                stuck.add(p)
            except ProcessLookupError:
                pass
        for p in pids:
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass
        time.sleep(0.002)
    return [m for c in cids if c for m in members(c) if m['pid'] not in exclude and m['pid'] != os.getpid()]


def stop(cids, grace_s, exclude=()):
    """The stop of a systemd unit (KillMode=control-group, TimeoutStopSec), on coalitions: SIGTERM and SIGCONT to every
    member, wait up to grace_s seconds for them to exit, then sweep the rest. Returns the members that remain."""
    for p in coalition_pids(cids, exclude):
        for sig in (signal.SIGTERM, signal.SIGCONT):
            try:
                os.kill(p, sig)
            except OSError:
                pass
    end = time.monotonic() + grace_s
    while time.monotonic() < end and coalition_pids(cids, exclude):
        time.sleep(0.1)
    return sweep(cids, exclude)


# --- sandboxes and peers --------------------------------------------------------------------------------------------


def sandboxed(pid):
    """Whether a process is in a Seatbelt sandbox. A process that is gone counts as sandboxed (fail closed)."""
    return _lib.sandbox_check(int(pid), None, 0) != 0


def peer(conn):
    """(pid, uid) of the peer of a Unix socket: LOCAL_PEERPID and LOCAL_PEERCRED (SOL_LOCAL = 0)."""
    pid = struct.unpack('i', conn.getsockopt(0, 2, 4))[0]
    cred = conn.getsockopt(0, 1, 76)                     # struct xucred: cr_version, cr_uid, cr_ngroups, cr_groups[16]
    version, uid = struct.unpack_from('Ii', cred)
    return pid, (uid if version == 0 else -1)


# --- launchd --------------------------------------------------------------------------------------------------------


def domain():
    return f'gui/{os.getuid()}'


def launchctl(*args, timeout=30):
    return subprocess.run([LAUNCHCTL, *args], capture_output=True, text=True, timeout=timeout, env=ENV)


def job(label):
    """What `launchctl print` says about a job: {state, pid, coalition, last_exit, runs, program, arguments, path,
    stdout, stderr}, or None when the job is not loaded."""
    r = launchctl('print', f'{domain()}/{label}')
    if r.returncode != 0:
        return None
    top = {}
    for line in r.stdout.splitlines():
        m = re.match(r'^\t([^\t].*?) = (.*)$', line)      # one tab: a property of the job itself, not of a block
        if m:
            top.setdefault(m.group(1), m.group(2))
    coal = re.search(r'^\tresource coalition = \{\n(?:\t\t.*\n)*?\t\tID = (\d+)$', r.stdout, re.M)
    args = re.search(r'^\targuments = \{\n((?:\t\t.*\n)*)\t\}$', r.stdout, re.M)
    num = lambda k: int(top[k]) if top.get(k, '').isdigit() else None
    return {'state': top.get('state'), 'pid': num('pid'), 'coalition': int(coal.group(1)) if coal else None,
            'last_exit': top.get('last exit code'), 'last_signal': top.get('last terminating signal'), 'runs': num('runs'), 'program': top.get('program'),
            'arguments': [a.strip() for a in args.group(1).splitlines()] if args else [], 'path': top.get('path'),
            'stdout': top.get('stdout path'), 'stderr': top.get('stderr path')}


def jobs():
    """{label: pid or None} of the jobs in the user's gui domain (`launchctl list`)."""
    r = launchctl('list', timeout=15)
    out = {}
    for line in r.stdout.splitlines()[1:]:
        parts = line.split('\t')
        if len(parts) == 3:
            out[parts[2]] = int(parts[0]) if parts[0].isdigit() else None
    return out


def mina_coalitions():
    """The coalitions of the running Mina instance and call jobs."""
    return {c for label, pid in jobs().items() if pid and label.startswith(MINA_JOBS) for c in [coalition_of(pid)] if c}


def write_plist(path, data):
    """A property list, 0600, written atomically. launchd does not load a file with the quarantine attribute; a file
    that this process writes has none."""
    tmp = f'{path}.tmp-{os.getpid()}'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        plistlib.dump(data, f)
    os.replace(tmp, path)


# Mina's native helper (sandbox/macos/mina-instance.c). As the program of a job (`run -- ARGV`) it starts ARGV and stays
# its parent, so that macOS gives privacy permissions (a project in ~/Documents) to mina-instance, the one program that
# the user allows for all of Mina, not to the Python of the Command Line Tools for every job that runs it.
HELPER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'build', 'macos', 'mina-instance')


def via_helper(argv):
    """argv, started by mina-instance when the helper is built (else argv itself, and macOS asks for python3)."""
    return [HELPER, 'run', '--', *argv] if os.access(HELPER, os.X_OK) else list(argv)


def job_plist(label, argv, env, log):
    """A job that runs once: RunAtLoad, LaunchOnlyOnce and no KeepAlive, so launchd never starts it again, and removes
    it when its main process exits. Interactive: launchd does not throttle it (Background jobs can be), as a Linux unit
    is not throttled."""
    return {'Label': label, 'ProgramArguments': list(argv), 'RunAtLoad': True, 'LaunchOnlyOnce': True,
            'ProcessType': 'Interactive', 'StandardInPath': '/dev/null', 'StandardOutPath': log, 'StandardErrorPath': log,
            'EnvironmentVariables': dict(env)}


@functools.lru_cache(maxsize=1)
def user_temp_dir():
    """The user's private temporary folder (getconf DARWIN_USER_TEMP_DIR), resolved, or None."""
    try:
        r = subprocess.run(['/usr/bin/getconf', 'DARWIN_USER_TEMP_DIR'], capture_output=True, text=True, timeout=10, env=ENV)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return os.path.realpath(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None


# --- locks ----------------------------------------------------------------------------------------------------------


def vnode_fds(pid):
    """The open files of a process of this user: [(fd, dev, ino, mode, open flags, path)]. [] for another user's."""
    n = _lib.proc_pidinfo(int(pid), PROC_PIDLISTFDS, 0, None, 0)
    if n <= 0:
        return []
    buf = _c.create_string_buffer(n + 8 * 64)
    n = _lib.proc_pidinfo(int(pid), PROC_PIDLISTFDS, 0, buf, len(buf))
    out = []
    info = _c.create_string_buffer(VNODEPATH_SIZE)
    for off in range(0, max(n, 0), 8):
        fd, kind = struct.unpack_from('iI', buf.raw, off)
        if kind != PROX_FDTYPE_VNODE:
            continue
        if _lib.proc_pidfdinfo(int(pid), fd, PROC_PIDFDVNODEPATHINFO, info, VNODEPATH_SIZE) != VNODEPATH_SIZE:
            continue
        flags = struct.unpack_from('I', info.raw, 0)[0]
        dev, mode, _nlink, ino = struct.unpack_from('IHHQ', info.raw, 24)
        path = info.raw[24 + 152:].split(b'\0', 1)[0].decode(errors='replace')
        out.append((fd, dev, ino, mode, flags, path))
    return out


def lock_state(path):
    """'WRITE' or 'READ' when some process holds a flock (or a POSIX lock) on this file, None when nobody does, and
    'UNKNOWN' when this process cannot open the file to ask. F_GETLK sees flock locks on macOS (with l_pid -1, so it
    cannot name the holder)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY)
    except OSError:
        return 'UNKNOWN' if os.path.isfile(path) else None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        # struct flock on macOS: off_t l_start, off_t l_len, pid_t l_pid, short l_type, short l_whence
        got = fcntl.fcntl(fd, fcntl.F_GETLK, struct.pack('qqihh', 0, 0, 0, fcntl.F_WRLCK, os.SEEK_SET))
    except OSError:
        return None
    finally:
        os.close(fd)
    kind = struct.unpack('qqihh', got)[3]
    return {fcntl.F_WRLCK: 'WRITE', fcntl.F_RDLCK: 'READ'}.get(kind)


def _own_pids():
    uid = os.getuid()
    return [(p, st) for p in all_pids() for st in [bsdinfo(p)] if st and st['uid'] == uid and st['state'] != 'Z']


def lock_holders(path, argv=cmdline):
    """Processes that hold a flock on this file, and the processes that wait for it as far as macOS shows them:
    [{pid, mode, waiting, argv}] as on Linux. Holders: an open file of the process on that file has FWASLOCKED, and
    the file is locked (lock_state). Processes that share one locked open file (a child that inherited the descriptor)
    are one holder: the topmost process, which took the lock. Waiters: see waits(). Only this user's processes can be
    examined. mode is the mode of the lock now held (READ, WRITE or UNKNOWN), also for a waiter."""
    try:
        st = os.stat(path)
    except OSError:
        return []
    mode = lock_state(path)
    if mode is None:
        return []
    procs = {}
    for pid, info in _own_pids():
        fds = [f for f in vnode_fds(pid) if f[1] == st.st_dev and f[2] == st.st_ino]
        if fds:
            procs[pid] = (info, {f[0] for f in fds if f[4] & FWASLOCKED}, fds)
    out = []
    for pid, (info, held, fds) in sorted(procs.items()):
        if held:
            parent = procs.get(info['ppid'])
            if parent and parent[1] & held:     # an inherited descriptor: the parent stands for it
                continue
            out.append({'pid': pid, 'mode': mode, 'waiting': False, 'argv': (argv(pid) or ['?'])[:6]})
        elif pid != os.getpid() and running_threads(pid) == 0:
            out.append({'pid': pid, 'mode': mode, 'waiting': True, 'argv': (argv(pid) or ['?'])[:6]})
    return out


def waits(pids, key_of):
    """The flocks that these processes seem to wait for: [{pid, lock, key, mode}]. macOS does not show a blocked flock
    (lsof and ps show no lock state and no wait channel). A process counts as waiting for a file when it has the file
    open without a lock on it, the file is locked by another open file, and none of its threads runs. mode is
    'exclusive' when the file is held shared (a shared request would not wait), else 'unknown'."""
    out = []
    for pid in sorted(set(pids)):
        if running_threads(pid) != 0:
            continue
        fds = vnode_fds(pid)
        held = {(f[1], f[2]) for f in fds if f[4] & FWASLOCKED}
        seen = set()
        for fd, dev, ino, mode, flags, path in fds:
            if not stat.S_ISREG(mode) or (dev, ino) in held or (dev, ino) in seen:
                continue
            seen.add((dev, ino))
            state = lock_state(path)
            if state is None:
                continue
            key = key_of(path)
            if key is None:
                continue
            out.append({'pid': pid, 'lock': path, 'key': key, 'mode': 'exclusive' if state == 'READ' else 'unknown'})
    return out


# --- the workload command sandbox -----------------------------------------------------------------------------------


class Profile:
    """A Seatbelt profile under construction: each path is a (param "Pn"), passed with -D, never written into the
    text. In Seatbelt the last matching rule wins."""

    def __init__(self):
        self.lines, self.params = ['(version 1)'], {}

    def param(self, path):
        if '\0' in path or '\n' in path:
            raise ValueError('a path contains a control character')
        for k, v in self.params.items():
            if v == path:
                return f'(param "{k}")'
        k = f'P{len(self.params)}'
        self.params[k] = path
        return f'(param "{k}")'

    def subpaths(self, paths):
        return ' '.join(f'(subpath {self.param(p)})' for p in paths)

    def literals(self, paths):
        return ' '.join(f'(literal {self.param(p)})' for p in paths)

    def add(self, *lines):
        self.lines += [ln for ln in lines if ln]

    def args(self):
        """sandbox-exec -p TEXT -D Pn=PATH ..."""
        out = [SANDBOX_EXEC, '-p', '\n'.join(self.lines) + '\n']
        for k, v in self.params.items():
            out += ['-D', f'{k}={v}']
        return out


def _ancestors(path):
    out, d = [], os.path.dirname(path)
    while d != os.path.dirname(d):
        out.append(d)
        d = os.path.dirname(d)
    return out


DEVICES = ('(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") '
           '(regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))')
# Apple diff copies a pipe input (diff <(...)) to /private/tmp/diff.XXXX; the worker profile has the same exception.
TMP_EXCEPTION = '(allow file-read* file-write* (regex #"^/private/tmp/diff\\.[^/]+$"))'


def workload_profile(writes, readonly, hidden, tmp, user_tmp, network, inherited=()):
    """The Seatbelt profile of a workload's command, the counterpart of hostd.command_sandbox's bwrap arguments:
    everything readable and the GPU usable (allow default); writes only to the writable roots and the private TMPDIR;
    /private/tmp and the user's temporary folder hidden (the private /tmp and runtime folder of Linux), the read-only
    folders and the hidden paths after them. No pasteboard, LaunchServices or AppleEvents, and no launchctl (on Linux
    the command has no user bus, so no systemctl). Unix sockets: syslog, and sockets inside the writable folders; open
    network adds mDNSResponder (DNS). offline: no IP network and no listening, because Seatbelt cannot give a command
    a private loopback interface as a network namespace does: a port it opened would be open to the host and the LAN.
    inherited: files that the command gets as open descriptors (its output log). Seatbelt checks fstat by path, and
    Python, for one, then loses its stdout; their metadata stays readable, their contents and paths do not.
    Paths are resolved: Seatbelt checks resolved paths."""
    p = Profile()
    own = [*writes, tmp]
    p.add('(allow default)', '(deny file-write*)', DEVICES)
    # The folder itself stays visible (stat, no listing), as /tmp exists in a sandbox on Linux; Apple diff needs it.
    p.add(f'(deny file-read* file-write* (subpath "/private/tmp"){" " + p.subpaths([user_tmp]) if user_tmp else ""})',
          '(allow file-read-metadata (literal "/private/tmp"))', TMP_EXCEPTION)
    p.add(f'(allow file-read* file-write* {p.subpaths(own)})')
    # The parent folders of the roots stay reachable (stat, no listing), as bwrap makes the parents of its mount points:
    # a shell's cd examines each one.
    parents = sorted({a for r in [*own, *readonly] for a in _ancestors(r)} - {'/'})
    if parents:
        p.add(f'(allow file-read-metadata {p.literals(parents)})')
    if readonly:
        p.add(f'(allow file-read* {p.subpaths(readonly)})', f'(deny file-write* {p.subpaths(readonly)})')
    dirs = [h for h in hidden if os.path.isdir(h)]
    files = [h for h in hidden if not os.path.isdir(h)]
    if dirs or files:
        p.add(f'(deny file-read* file-write* {p.subpaths(dirs)} {p.literals(files)})'.replace('  ', ' '))
    if inherited:
        p.add(f'(allow file-read-metadata {p.literals(inherited)})')
    # A writable root cannot be renamed or deleted, as a bind mount point cannot.
    p.add(*[f'(deny file-write-unlink (require-all (literal {p.param(w)}) (vnode-type DIRECTORY)))' for w in writes])
    sockets = '(literal "/private/var/run/syslog")' + (' (literal "/private/var/run/mDNSResponder")' if network == 'open' else '')
    if network == 'offline':
        p.add('(deny network*)', f'(allow network-outbound {sockets} {p.subpaths(own)})',
              # One path for each (local unix-socket ...): two paths in one would both have to match.
              f'(allow network-bind network-inbound {" ".join(f"(local unix-socket {p.subpaths([o])})" for o in own)})')
    else:
        p.add('(deny network-outbound (remote unix-socket))', f'(allow network-outbound {sockets} {p.subpaths(own)})')
    p.add('(deny mach-lookup (global-name "com.apple.pasteboard.1"))', '(deny lsopen)', '(deny appleevent-send)',
          '(deny process-exec (literal "/bin/launchctl"))')
    return p
