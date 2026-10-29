#!/usr/bin/env python3
"""The main process of one registered workload's systemd unit (host/hostd.py starts it with systemd-run).

usage: lockrun.py SPEC.json

1. Takes the workload's resource locks, non-blocking (a conflict exits 75 with the holders recorded).
2. Checks again, with the locks held, that no lockout, stopped supervisor or foreign GPU user forbids the run
   (a campaign runner should do the same re-check; a fault can arrive while the locks are being taken).
3. Runs the registered command with the lock descriptors inherited: the locks stay held while any process of the
   workload lives, so they cannot be released while a leftover child still uses the GPU.
4. Records the result. When this process exits, systemd stops the unit and kills whatever is left in its cgroup
   (KillMode=control-group); the broker then verifies that every recorded process is gone.
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


def write(state, **kw):
    record.update(kw, state=state, ts=time.time())
    hostlib.write_json(result_path, record)


def on_term(signum, _frame):
    write('terminated', signal=signum)
    os._exit(128 + signum)


signal.signal(signal.SIGTERM, on_term)
signal.signal(signal.SIGHUP, on_term)

try:
    fds = hostlib.acquire(spec['locks'])
except hostlib.LockConflict as e:
    write('conflict', evidence=e.evidence)
    sys.exit(75)
problems = hostlib.resource_problems(spec['resources'], spec['resource_names'])
if problems:
    write('blocked', problems=problems)
    sys.exit(75)
for fd in fds:
    os.set_inheritable(fd, True)
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': os.environ.get('HOME', '/'), 'LANG': 'C.UTF-8', **spec.get('env', {})}
with open(spec['log'], 'ab') as log:
    child = subprocess.Popen(spec['argv'], cwd=spec['cwd'], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             pass_fds=fds, start_new_session=False)
write('running', leader=hostlib.identity(child.pid), locks=[e['path'] for e in spec['locks']], started=time.time())
rc = child.wait()
# What the leader left behind: systemd kills these when this process exits; the broker verifies they are gone.
try:
    with open('/proc/self/cgroup') as f:
        rel = next(line[3:].strip() for line in f if line.startswith('0::'))
    members = hostlib.cgroup_members(f'/sys/fs/cgroup{rel}') or []
except (OSError, StopIteration):
    members = []
survivors = [m for m in members if m['pid'] != os.getpid()]
write('exited', rc=rc, survivors=survivors, ended=time.time())
sys.exit(rc if rc >= 0 else 128 - rc)
