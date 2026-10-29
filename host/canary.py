#!/usr/bin/env python3
"""A harmless service for qualifying mina's host broker: restart, deployment verification and failed-restart handling.

usage: canary.py LOG [FAIL_FLAG]
Writes 'START canary pid=<pid> sha=<its own source hash>' to LOG, then a HEARTBEAT line every 60 s. If FAIL_FLAG exists
it exits 1 at start, so a restart fails the way a broken deployment would. If FAIL_FLAG.degrade exists it starts
normally and then logs an ENFORCEMENT_FAILED line, the way the 2026-10-13 watchdog deployment did.
"""
import hashlib, os, sys, time

log, flag = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else None)
if flag and os.path.exists(flag):
    print(f'canary: {flag} exists: failing at start', file=sys.stderr)
    sys.exit(1)
sha = hashlib.sha256(open(__file__, 'rb').read()).hexdigest()[:16]
with open(log, 'a', buffering=1) as f:
    f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%S")} START canary pid={os.getpid()} sha={sha}\n')
    if flag and os.path.exists(f'{flag}.degrade'):
        time.sleep(0.5)
        f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%S")} ENFORCEMENT_FAILED canary degraded after start\n')
    while True:
        time.sleep(60)
        f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%S")} HEARTBEAT canary pid={os.getpid()}\n')
