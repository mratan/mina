#!/usr/bin/env python3
"""The main process of one registered workload's systemd unit (host/hostd.py starts it with systemd-run).

usage: lockrun.py SPEC.json

1. Takes the workload's resource locks. With queue_s 0, non-blocking. With queue_s > 0, it waits up to queue_s seconds
   in total, in the queue protocol of the host runner (hostlib.acquire), and records the state 'queued' with what it
   waits for. A conflict, or the end of queue_s, exits 75 with the holders recorded and every lock released.
2. Checks again, with the locks held, that no lockout, stopped supervisor or foreign GPU user forbids the run
   (a campaign runner should do the same re-check; a fault can arrive while the locks are being taken).
3. Runs the registered command with the lock descriptors inherited: the locks stay held while any process of the
   workload lives, so they cannot be released while a leftover child still uses the GPU.
4. Records the result. When this process exits, systemd stops the unit and kills whatever is left in its cgroup
   (KillMode=control-group); the broker then verifies that every recorded process is gone.

On macOS this process is the main process of the workload's launchd job, and launchd does not stop what is left in
the job's coalition. So this process does it itself, as systemd would (SIGTERM, SIGKILL after STOP_GRACE_S): when the
command exits, on SIGTERM or SIGHUP, and at the deadline (RuntimeMaxSec on Linux), which it enforces with SIGALRM. It
exits only when no other process of its coalition is left (or the grace time and the SIGKILL rounds are over), so
launchd's own kill of the process group never cuts the grace time short. The broker stops the coalition too, if this
process is gone (docs/host-profile.md, "macOS").
"""
import json
import os
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostlib  # noqa: E402

spec = json.load(open(sys.argv[1]))
result_path = spec['result']
record = {'pid': os.getpid(), 'boot_id': hostlib.boot_id()}
DARWIN = hostlib.DARWIN
STOP_GRACE_S = 5   # TimeoutStopSec of the Linux unit
OWN = {os.getpid()}
if DARWIN:
    import shutil
    record['coalition'] = hostlib.coalition_of(os.getpid())   # the broker finds the job's processes by it
    # The program of the job can be mina-instance (`run -- lockrun.py`, host/darwin.py via_helper): it waits for this
    # process and exits with it, so it is part of this process, not a leftover of the command.
    parent = hostlib.proc_stat(os.getppid())
    if parent and parent['ppid'] == 1 and parent['comm'] == 'mina-instance':
        OWN.add(os.getppid())


def write(state, **kw):
    record.update(kw, state=state, ts=time.time())
    hostlib.write_json(result_path, record)


def stop_rest(signal_them):
    """macOS: stop the other processes of this job's coalition, then remove the command's private TMPDIR."""
    if signal_them:
        hostlib.stop_coalition(record.get('coalition'), STOP_GRACE_S, exclude=tuple(OWN))
    else:
        wait_rest()
    if spec.get('tmpdir'):
        shutil.rmtree(spec['tmpdir'], ignore_errors=True)


def wait_rest():
    """The broker stops the coalition (it wrote spec['stop_marker'] first): wait for the others, as long as its grace."""
    end = time.monotonic() + STOP_GRACE_S + 1
    while time.monotonic() < end and [m for m in hostlib.coalition_members(record.get('coalition')) or [] if m['pid'] not in OWN]:
        time.sleep(0.1)


def on_term(signum, _frame):
    write('terminated', signal=signum)
    if DARWIN:
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGALRM):
            signal.signal(sig, signal.SIG_IGN)
        stop_rest(not os.path.exists(spec.get('stop_marker') or ''))
    os._exit(128 + signum)


def on_deadline(_signum, frame):
    """macOS: the end of max_s + queue_s. On Linux systemd sends SIGTERM at RuntimeMaxSec: the same record follows."""
    on_term(signal.SIGTERM, frame)


signal.signal(signal.SIGTERM, on_term)
signal.signal(signal.SIGHUP, on_term)

queue_s = spec.get('queue_s', 0)
queued_since = time.time()


def on_wait(path, holders):
    write('queued', waiting_for={'lock': path, 'holders': holders}, queue_s=queue_s, queued_since=queued_since,
          queue_deadline=queued_since + queue_s)


if DARWIN and spec.get('deadline') and spec['deadline'] <= time.time():
    on_deadline(signal.SIGALRM, None)
try:
    fds = hostlib.acquire(spec['locks'], wait_s=queue_s, on_wait=on_wait)
except hostlib.LockConflict as e:
    write('conflict', evidence={**e.evidence, 'waited_s': round(time.time() - queued_since, 1)} if queue_s else e.evidence)
    sys.exit(75)
problems = hostlib.resource_problems(spec['resources'], spec['resource_names'])
if problems:
    write('blocked', problems=problems)
    sys.exit(75)
record.pop('waiting_for', None)   # no longer waiting: queued_since stays as evidence of the wait
for fd in fds:
    os.set_inheritable(fd, True)
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': os.environ.get('HOME', '/'), 'LANG': 'C.UTF-8', **spec.get('env', {})}
if DARWIN:
    # Homebrew's folder on Apple silicon is where macOS keeps what Linux keeps in /usr/local.
    if 'PATH' not in spec.get('env', {}):
        env['PATH'] = '/opt/homebrew/bin:' + env['PATH']
    if spec.get('tmpdir'):
        os.makedirs(spec['tmpdir'], mode=0o700, exist_ok=True)   # the command's private TMPDIR (a tmpfs /tmp on Linux)
    # The deadline counts from the launch, as RuntimeMaxSec counts from the start of the unit. The queue wait used
    # SIGALRM (hostlib._flock); it is over now.
    signal.signal(signal.SIGALRM, on_deadline)
    if spec.get('deadline'):
        signal.setitimer(signal.ITIMER_REAL, max(0.01, spec['deadline'] - time.time()))
with open(spec['log'], 'ab') as log:
    child = subprocess.Popen(spec['argv'], cwd=spec['cwd'], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             pass_fds=fds, start_new_session=False)
write('running', leader=hostlib.identity(child.pid), locks=[e['path'] for e in spec['locks']],
      shared_locks=[e['path'] for e in spec['locks'] if hostlib.lock_mode(e) == 'shared'], started=time.time())
rc = child.wait()
# What the leader left behind: systemd kills these when this process exits; the broker verifies they are gone.
if DARWIN:
    members = hostlib.coalition_members(record.get('coalition')) or []
else:
    try:
        with open('/proc/self/cgroup') as f:
            rel = next(line[3:].strip() for line in f if line.startswith('0::'))
        members = hostlib.cgroup_members(f'/sys/fs/cgroup{rel}') or []
    except (OSError, StopIteration):
        members = []
survivors = [m for m in members if m['pid'] not in OWN]
if DARWIN:
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGALRM):   # the result is final; the stop below is systemd's part
        signal.signal(sig, signal.SIG_IGN)
    signal.setitimer(signal.ITIMER_REAL, 0)
write('exited', rc=rc, survivors=survivors, ended=time.time())
if DARWIN:
    stop_rest(True)
sys.exit(rc if rc >= 0 else 128 - rc)
