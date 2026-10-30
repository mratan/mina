#!/usr/bin/env python3
"""Qualification of mina's host broker against the real host: systemd user units, cgroups, flocks and process trees.

An isolated broker instance runs with its own config, state, socket, slice and lock directory, so nothing here touches
production locks or services. Each test has a positive and a negative control. Run: python3 -I host/test_hostd.py -v
The broker tests need a systemd user session (systemctl --user) and some need bubblewrap with unprivileged user
namespaces; without them they are skipped, with the reason.
"""
import hashlib
import base64
import json
import re
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hostlib  # noqa: E402
import hostd  # noqa: E402

CLIENT = r'''
import json, socket, sys
sock = sys.argv[1]
for line in sys.stdin:
    s = socket.socket(socket.AF_UNIX); s.connect(sock); s.sendall(line.encode())
    data = b''
    while not data.endswith(b'\n'):
        c = s.recv(65536)
        if not c: break
        data += c
    sys.stdout.write(data.decode()); sys.stdout.flush()
'''


def _works(argv):
    try:
        return subprocess.run(argv, capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


SYSTEMD_USER = _works(['systemctl', '--user', 'show-environment']) and shutil.which('systemd-run') is not None
BWRAP = _works(['bwrap', '--ro-bind', '/', '/', '--unshare-net', 'true'])
NEEDS_SYSTEMD = 'needs a systemd user session (systemctl --user)'
NEEDS_BWRAP = 'needs bubblewrap with unprivileged user namespaces'


def put(path, text):
    with open(path, 'w') as f:
        f.write(text)


def wait_for(fn, timeout=15, step=0.1):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return fn()


class Broker:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix='mina-hostd-test-')
        self.tag = secrets.token_hex(3)
        self.project = os.path.join(self.tmp, 'project')
        self.locks = os.path.join(self.tmp, 'locks')
        self.kfd = os.path.join(self.tmp, 'kfd')
        for d in (self.project, self.locks, self.kfd, os.path.join(self.tmp, 'lockout'), os.path.join(self.tmp, 'telemetry')):
            os.makedirs(d)
        self.client = os.path.join(self.tmp, 'client.py')
        open(self.client, 'w').write(CLIENT)
        self.env = {**os.environ, 'MINA_HOST_CONFIG': os.path.join(self.tmp, 'host.json'), 'MINA_HOST_STATE': os.path.join(self.tmp, 'state'),
                    'MINA_HOST_RUNTIME': os.path.join(self.tmp, 'run'), 'MINA_HOST_SLICE': f'minatest{self.tag}.slice',
                    'MINA_HOST_UNIT_PREFIX': f'minatest-wl-{self.tag}', 'MINA_HOST_TICK_S': '0.3', 'MINA_HOST_AUTO_HOLD_S': '3', 'MINA_HOST_KFD_PROC': self.kfd,
                    # The owner's sandbox and Claude configuration stay out of the test broker.
                    'MINA_SANDBOX_CONFIG': os.path.join(self.tmp, 'sandbox.json'), 'PI_CODING_AGENT_DIR': os.path.join(self.tmp, 'agent')}
        self.sock = os.path.join(self.tmp, 'run', 'sock')
        self.units = []
        self.proc = None

    def start(self):
        self.proc = subprocess.Popen([sys.executable, os.path.join(HERE, 'hostd.py'), 'serve'], env=self.env,
                                     stdout=open(os.path.join(self.tmp, 'hostd.log'), 'a'), stderr=subprocess.STDOUT)
        assert wait_for(lambda: os.path.exists(self.sock)), 'broker did not start'

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(10)
        if os.path.exists(self.sock):
            os.unlink(self.sock)

    def config(self, project_cfg, **top):
        hostlib.write_json(self.env['MINA_HOST_CONFIG'], {'version': 1, 'projects': {self.project: project_cfg}, **top})

    def unit(self, name, *argv, props=()):
        unit = f'minatest-{name}-{self.tag}.service'
        subprocess.run(['systemd-run', '--user', '--quiet', f'--unit={unit}', *[f'--property={p}' for p in props], '--', *argv], check=True)
        self.units.append(unit)
        return unit

    def raw(self, req, via=None):
        """One request from a child process of this test (the 'launcher'), or through `via` (a wrapper argv)."""
        argv = [*(via or []), sys.executable, self.client, self.sock]
        r = subprocess.run(argv, input=json.dumps(req) + '\n', capture_output=True, text=True, timeout=120)
        assert r.stdout, r.stderr
        return json.loads(r.stdout)

    def open_session(self, project=None, full=False):
        # This test process is the launcher: outside any sandbox, in the broker's mount namespace.
        s = __import__('socket').socket(__import__('socket').AF_UNIX)
        s.connect(self.sock)
        s.sendall((json.dumps({'op': 'session_open', 'project': project or self.project}) + '\n').encode())
        data = b''
        while not data.endswith(b'\n'):
            data += s.recv(65536)
        s.close()
        out = json.loads(data)
        assert out['ok'], out
        return out['result'] if full else out['result']['grant']

    def cleanup(self):
        self.stop()
        for u in self.units:
            subprocess.run(['systemctl', '--user', 'stop', u], capture_output=True)
            subprocess.run(['systemctl', '--user', 'reset-failed', u], capture_output=True)
        subprocess.run(['systemctl', '--user', 'stop', f'minatest{self.tag}.slice'], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)


def flock_holder(path, seconds=60):
    """A stand-in for a production campaign runner holding a lock (flock(1), as a campaign runner's fcntl.flock would)."""
    p = subprocess.Popen(['flock', '-x', path, 'sleep', str(seconds)], start_new_session=True)
    p.kill = lambda: os.killpg(p.pid, signal.SIGKILL)   # flock's sleep child inherits the lock: end both
    assert wait_for(lambda: any(h['pid'] == p.pid and not h['waiting'] for h in hostlib.lock_holders(path)))
    return p


def free(path):
    return subprocess.run(['flock', '-n', '-x', path, 'true']).returncode == 0


class ApprovalTest(unittest.TestCase):
    """Exercise the real dispatcher and handlers without a broker, units or host locks."""

    mutations = {
        'reserve': ('reserve', {'resources': ['gpu']}),
        'release': ('reserve', {'reservation': 'r-owned'}),
        'workload_run': ('workload', {'workload': 'test'}),
        'workload_stop': ('workload', {'id': '20260101000000-abcdef'}),
        'monitor_add': ('monitor', {'kind': 'unit_active', 'params': {'service': 'test'}}),
        'monitor_remove': ('monitor', {'id': 'm-owned'}),
        'service_restart': ('restart', {'service': 'test'}),
    }
    invalid_approvals = ({}, {'approval': None}, {'approval': False}, {'approval': True},
                         {'approval': 'yes'}, {'approval': []}, {'approval': ['granted']},
                         {'approval': {}}, {'approval': {'granted': False}},
                         {'approval': {'granted': None}}, {'approval': {'granted': 'true'}},
                         {'approval': {'granted': 1}}, {'approval': {'granted': []}})

    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.tmp = stack.enter_context(tempfile.TemporaryDirectory(prefix='mina-approval-test-'))
        self.project = os.path.join(self.tmp, 'project')
        self.cfg = {'classes': dict.fromkeys(hostd.CLASSES, 'ask'),
                    'resources': {'gpu': {'locks': []}},
                    'services': {'test': {'unit': 'never-real.service', 'restart': 'allow'}},
                    'workloads': {'test': {'argv': ['true'], 'resources': [], 'max_s': 1}}}
        for key, value in {'STATE': self.tmp, 'WL': os.path.join(self.tmp, 'workloads'),
                           'MONITORS': os.path.join(self.tmp, 'monitors.json'),
                           'ALARMS': os.path.join(self.tmp, 'alarms.json'),
                           'SESSIONS': os.path.join(self.tmp, 'sessions.json'),
                           'CONFIG': os.path.join(self.tmp, 'host.json'),
                           'confirmations': hostd.Confirmations(), 'budgets': hostd.AdmissionBudgets(),
                           'reservations': {}, 'service_locks': {}}.items():
            stack.enter_context(patch.object(hostd, key, value))
        hostd.budgets.open((self.project, 'session'))
        self.real_project_config = hostd.project_config
        stack.enter_context(patch.object(hostd, 'project_config', side_effect=lambda p: self.cfg if p == self.project else None))
        stack.enter_context(patch.object(hostd, 'session_for', side_effect=lambda *args: ('session', {'project': self.project})))
        stack.enter_context(patch.object(hostd.time, 'sleep'))
        self.audit = stack.enter_context(patch.object(hostd, 'audit'))
        self.acquire = stack.enter_context(patch.object(hostlib, 'acquire', return_value=[]))
        stack.enter_context(patch.object(hostlib, 'resource_problems', return_value=[]))
        self.run = stack.enter_context(patch.object(hostd.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')))
        self.systemctl = stack.enter_context(patch.object(hostd, 'systemctl', side_effect=self.stop_unit))
        self.restart = stack.enter_context(patch.object(hostd, 'restart_verified', return_value={'verified': True}))
        self.evaluate = stack.enter_context(patch.object(hostd, 'evaluate', return_value=None))
        self.reconcile = stack.enter_context(patch.object(hostd, 'reconcile_workload', side_effect=self.reconcile_record))
        self.write = stack.enter_context(patch.object(hostlib, 'write_json', wraps=hostlib.write_json))
        self.seed()

    def stop_unit(self, *args, **kwargs):
        self.stopped = True
        return subprocess.CompletedProcess([], 0, '', '')

    def reconcile_record(self, rec):
        if self.stopped or rec['state'] == 'launching':
            rec['state'] = 'stopped' if self.stopped else 'exited'
        return rec

    def seed(self):
        self.stopped = False
        hostd.reservations.clear()
        hostd.reservations['r-owned'] = {'id': 'r-owned', 'project': self.project, 'session': 'session',
                                       'resources': ['gpu'], 'fds': []}
        hostlib.write_json(hostd.MONITORS, {'m-owned': {'id': 'm-owned', 'project': self.project}})
        wid = '20260101000000-abcdef'
        hostlib.write_json(os.path.join(hostd.WL, wid, 'record.json'),
                           {'id': wid, 'project': self.project, 'workload': 'test', 'state': 'running',
                            'unit': 'never-real.service', 'launched': 1})
        for spy in self.effects():
            spy.reset_mock()

    def effects(self):
        return (self.write, self.audit, self.acquire, self.run, self.systemctl,
                self.restart, self.evaluate, self.reconcile)

    def call(self, op, approval=None, direct=False, **extra):
        req = {'op': op, 'grant': 'test-grant', **self.mutations[op][1], **(approval or {}), **extra}
        if direct:
            return hostd.OPS[op][1](self.project, 'session', req)
        return hostd.handle(req, 123, hostd.UID)

    def approved(self, op, direct=False, **extra):
        with self.assertRaises(hostd.Refusal) as cm:
            self.call(op, direct=direct, **extra)
        challenge = cm.exception.detail.get('approval_request')
        return {'approval': {'granted': True, 'challenge': challenge['challenge']}} if challenge else {}

    def refused(self, op, approval, direct=False, code='REQUIRES_AUTHORIZATION', interactive=True, **extra):
        with self.assertRaises(hostd.Refusal) as cm:
            self.call(op, approval, direct, **extra)
        self.assertEqual(cm.exception.code, code)
        if interactive:
            self.assertIs(cm.exception.detail.get('approval_needed'), True)
            self.assertIn(self.project, cm.exception.detail['approval_prompt'])
        else:
            self.assertNotIn('approval_needed', cm.exception.detail)
        for spy in self.effects():
            spy.assert_not_called()
        self.assertIn('r-owned', hostd.reservations)

    def test_ask_through_handle_requires_exact_true_before_effects(self):
        for op in self.mutations:
            for approval in self.invalid_approvals:
                with self.subTest(op=op, approval=approval):
                    self.seed()
                    self.refused(op, approval)

    def test_request_retry_is_observation_even_after_budget_exhaustion(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 1}
        first = self.call('workload_run', request_id='lost-reply')
        again = self.call('workload_run', request_id='lost-reply')
        self.assertEqual(first['id'], again['id'])
        self.assertTrue(again['replayed'])
        self.run.assert_called_once()
        self.assertEqual(self.budget_status()['used']['admissions'], 1)
        lookup = hostd.handle({'op': 'workload_status', 'grant': 'test-grant', 'request_id': 'lost-reply'}, 123, hostd.UID)
        self.assertEqual(lookup['id'], first['id'])
        self.assertFalse(lookup['recovery_history_is_authority'])
        with self.assertRaises(hostd.Refusal) as cm:
            self.call('workload_run', request_id='lost-reply', max_s=1)
        self.assertEqual(cm.exception.code, 'CONFLICT')  # exact args, not merely equivalent defaults
        self.cfg['classes']['workload'] = 'deny'
        with self.assertRaises(hostd.Refusal):
            self.call('workload_run', request_id='lost-reply')

    def test_parallel_request_repeats_admit_once(self):
        from concurrent.futures import ThreadPoolExecutor
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 1}
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.call('workload_run', request_id='parallel'), range(8)))
        self.assertEqual(len({r['id'] for r in results}), 1)
        self.assertEqual(sum(not r['replayed'] for r in results), 1)
        self.run.assert_called_once()
        self.assertEqual(self.budget_status()['used']['admissions'], 1)

    def test_intent_is_after_confirmation_and_before_charge_or_launch(self):
        self.approved('workload_run', request_id='pending')
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'request-intents')))
        approval = self.approved('workload_run', request_id='pending')
        self.audit.side_effect = OSError('lost journal')
        with self.assertRaises(hostd.Refusal):
            self.call('workload_run', approval, request_id='pending')
        self.run.assert_not_called()
        self.audit.side_effect = None
        with patch.object(hostd, 'budgets', hostd.AdmissionBudgets()):
            again = self.call('workload_run', request_id='pending')
            self.assertEqual(again['receipt_state'], 'pending_unknown')
            self.assertTrue(again['replayed'])
            self.assertEqual(self.budget_status()['coverage'], 'unknown')
        self.run.assert_not_called()

    def test_partial_or_unsynced_receipt_never_becomes_a_retry_allowance(self):
        self.cfg['classes']['workload'] = 'allow'
        with patch.object(hostd.os, 'fsync', side_effect=OSError('fixture durability failure')):
            with self.assertRaises(OSError):
                self.call('workload_run', request_id='unsynced')
        replay = self.call('workload_run', request_id='unsynced')
        self.assertEqual(replay['receipt_state'], 'pending_unknown')
        self.assertEqual(self.budget_status()['used']['admissions'], 0)
        self.run.assert_not_called()
        directory = os.path.join(self.tmp, 'request-intents')
        for name in os.listdir(directory):
            with open(os.path.join(directory, name), 'w'):
                pass  # simulate death during exclusive receipt creation
        with self.assertRaises(hostd.Refusal) as cm:
            self.call('workload_run', request_id='unsynced')
        self.assertEqual(cm.exception.code, 'BLOCKED')
        self.assertEqual(cm.exception.detail['receipt_state'], 'pending_unknown')
        self.run.assert_not_called()

    def test_instance_budget_refuses_a_second_launch_before_effects(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 1}
        self.assertTrue(self.call('workload_run'))
        for spy in self.effects():
            spy.reset_mock()
        self.refused('workload_run', {}, interactive=False)

    def test_invalid_runtime_is_not_silently_defaulted_or_rounded(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['workloads']['test']['max_s'] = 10
        for value in (0, -1, True, 1.5, '2', None):
            with self.subTest(max_s=value):
                self.seed()
                self.refused('workload_run', {}, max_s=value, code='INVALID', interactive=False)

    def test_native_budget_status_reports_reserved_ceilings_not_measured_usage(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 2, 'max_reserved_s': 5}
        self.cfg['workloads']['test']['queue_s'] = 1
        result = self.call('workload_run')
        status = hostd.handle({'op': 'workload_budget', 'grant': 'test-grant'}, 123, hostd.UID)
        self.assertEqual(status['coverage'], 'complete')
        self.assertEqual(status['used'], {'admissions': 1, 'reserved_s': 2})
        self.assertEqual(status['remaining'], {'admissions': 1, 'reserved_s': 3})
        self.assertEqual(status['workloads']['test']['used'], {'admissions': 1, 'reserved_s': 2})
        self.assertEqual(result['admission']['reserved_s'], 2)

    def budget_status(self):
        return hostd.handle({'op': 'workload_budget', 'grant': 'test-grant'}, 123, hostd.UID)

    def test_runtime_budget_reserves_queue_and_execution_ceilings_without_refunds(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_reserved_s': 5}
        self.cfg['workloads']['test']['queue_s'] = 2
        self.call('workload_run')
        self.assertEqual(self.budget_status()['used'], {'admissions': 1, 'reserved_s': 3})
        for spy in self.effects():
            spy.reset_mock()
        self.refused('workload_run', {}, interactive=False)

    def test_instance_totals_cover_multiple_workloads_and_per_workload_caps(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 3}
        self.cfg['workloads']['other'] = {'argv': ['true'], 'max_s': 1}
        self.cfg['workloads']['test']['instance_budget'] = {'max_admissions': 1}
        self.call('workload_run')
        self.call('workload_run', workload='other')
        for spy in self.effects():
            spy.reset_mock()
        self.refused('workload_run', {}, interactive=False)
        self.call('workload_run', workload='other')
        for spy in self.effects():
            spy.reset_mock()
        self.refused('workload_run', {}, workload='other', interactive=False)
        self.assertEqual(self.budget_status()['used']['admissions'], 3)

    def test_adding_or_raising_limits_and_changing_goal_metadata_does_not_reset_spending(self):
        self.cfg['classes']['workload'] = 'allow'
        self.call('workload_run')  # admissions count before an operator enables limits
        self.cfg['instance_budget'] = {'max_admissions': 1}
        for spy in self.effects():
            spy.reset_mock()
        self.refused('workload_run', {}, goal_id='successor', instance_budget={'max_admissions': 100}, interactive=False)
        self.cfg['instance_budget']['max_admissions'] = 2
        self.call('workload_run', goal_id='another-goal')
        self.assertEqual(self.budget_status()['used']['admissions'], 2)
        self.assertEqual(self.budget_status()['remaining']['admissions'], 0)

    def test_broker_restart_has_unknown_baseline_not_a_renewed_budget(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 2}
        self.call('workload_run')
        with patch.object(hostd, 'budgets', hostd.AdmissionBudgets()):
            self.seed()  # even plausible disk records cannot establish authority
            self.refused('workload_run', {}, code='BLOCKED', interactive=False)
            status = self.budget_status()
            self.assertEqual(status['coverage'], 'unknown')
            self.assertIsNone(status['remaining']['admissions'])
            del self.cfg['instance_budget']  # explicit operator policy, not a model-provided override
            self.call('workload_run')
            self.cfg['instance_budget'] = {'max_admissions': 2}
            for spy in self.effects():
                spy.reset_mock()
            self.refused('workload_run', {}, code='BLOCKED', interactive=False)

    def test_preflight_errors_spend_nothing_but_launch_and_journal_errors_keep_the_charge(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 1}
        self.refused('workload_run', {}, command=['not-allowed'], code='INVALID', interactive=False)
        self.assertEqual(self.budget_status()['used']['admissions'], 0)
        self.run.return_value = subprocess.CompletedProcess([], 1, '', 'fixture launch refused')
        with self.assertRaises(hostd.Refusal) as cm:
            self.call('workload_run')
        self.assertEqual(cm.exception.code, 'FAILED')
        self.assertTrue(cm.exception.detail['budget_charged'])
        self.assertEqual(cm.exception.detail['admission']['instance_used']['admissions'], 1)
        self.assertEqual(cm.exception.detail['admission_id'], cm.exception.detail['admission']['id'])
        self.assertEqual(self.budget_status()['used']['admissions'], 1)
        for spy in self.effects():
            spy.reset_mock()
        self.refused('workload_run', {}, interactive=False)

    def test_journal_failure_never_launches_or_refunds_the_admission(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 1}
        self.audit.side_effect = OSError('fixture journal unavailable')
        with self.assertRaises(hostd.Refusal) as cm:
            self.call('workload_run')
        self.assertEqual(cm.exception.code, 'FAILED')
        self.run.assert_not_called()
        self.assertEqual(self.budget_status()['used']['admissions'], 1)
        for spy in self.effects():
            spy.reset_mock()
        self.refused('workload_run', {}, interactive=False)

    def test_malformed_budget_policy_refuses_instead_of_disabling_limits(self):
        self.cfg['classes']['workload'] = 'allow'
        for cap in (None, {}, True, {'unknown': 1}, {'max_admissions': True}, {'max_reserved_s': 0.5}, {'max_admissions': -1}):
            with self.subTest(cap=cap):
                self.cfg['instance_budget'] = cap
                self.seed()
                self.refused('workload_run', {}, code='INVALID', interactive=False)

    def test_concurrent_distinct_launches_share_one_atomic_instance_budget(self):
        from concurrent.futures import ThreadPoolExecutor
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 1}
        def attempt(i):
            try:
                self.call('workload_run', goal_id=f'branch-{i}')
                return True
            except hostd.Refusal:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(attempt, range(2))), [False, True])
        self.run.assert_called_once()
        self.assertEqual(self.budget_status()['used']['admissions'], 1)

    def test_pin_changes_during_preflight_are_refused_before_budget_charge(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 1}
        path = os.path.join(self.tmp, 'pinned.py')
        with open(path, 'w') as f:
            f.write('original')
        self.cfg['workloads']['test'].update(pin={path: hashlib.sha256(b'original').hexdigest()}, resources=['gpu'])
        def inspect(*args):
            with open(path, 'w') as f:
                f.write('changed')
            return []
        with patch.object(hostlib, 'resource_problems', side_effect=inspect):
            self.refused('workload_run', {}, code='BLOCKED', interactive=False)
        self.assertEqual(self.budget_status()['used']['admissions'], 0)

    def test_policy_change_after_confirmation_refuses_at_atomic_budget_admission(self):
        self.cfg['classes']['workload'] = 'allow'
        path = os.path.join(self.tmp, 'admission-pin')
        with open(path, 'w') as f:
            f.write('original')
        self.cfg['workloads']['test']['pin'] = {path: hashlib.sha256(b'original').hexdigest()}
        hostlib.write_json(hostd.CONFIG, {'projects': {self.project: self.cfg}})
        updated = json.loads(json.dumps(self.cfg))
        updated['instance_budget'] = {'max_admissions': 0}
        real_open, reads = open, [0]
        def read_file(filename, *args, **kwargs):
            if filename == path:
                reads[0] += 1
                if reads[0] == 2:  # final pin read follows confirmation, before the atomic charge
                    with real_open(hostd.CONFIG, 'w') as f:
                        json.dump({'projects': {self.project: updated}}, f)
            return real_open(filename, *args, **kwargs)
        self.seed()
        with patch.object(hostd, 'project_config', self.real_project_config), patch('builtins.open', side_effect=read_file):
            self.refused('workload_run', {}, code='BLOCKED', interactive=False)
        self.assertEqual(self.budget_status()['used']['admissions'], 0)

    def test_post_charge_filesystem_and_subprocess_errors_return_admission_evidence(self):
        self.cfg['classes']['workload'] = 'allow'
        self.cfg['instance_budget'] = {'max_admissions': 2}
        with patch.object(hostd.os, 'makedirs', side_effect=OSError('fixture output directory unavailable')):
            with self.assertRaises(hostd.Refusal) as cm:
                self.call('workload_run')
        self.assertEqual(cm.exception.code, 'FAILED')
        self.assertTrue(cm.exception.detail['budget_charged'])
        self.assertEqual(cm.exception.detail['admission']['instance_used']['admissions'], 1)
        self.run.side_effect = subprocess.TimeoutExpired(['systemd-run'], 10)
        with self.assertRaises(hostd.Refusal) as cm:
            self.call('workload_run')
        self.assertTrue(cm.exception.detail['budget_charged'])
        self.assertEqual(cm.exception.detail['admission']['instance_used']['admissions'], 2)
        self.assertIn('inspect workload_status', cm.exception.message)
        self.assertEqual(self.budget_status()['remaining']['admissions'], 0)

    def test_boolean_approval_alone_does_not_authorize_a_mutation(self):
        self.refused('reserve', {'approval': {'granted': True}})

    def test_confirmation_is_bound_to_arguments_and_is_consumed_once(self):
        approval = self.approved('reserve', ttl_s=5)
        self.refused('reserve', approval, interactive=False, ttl_s=6)
        self.refused('reserve', approval, interactive=False, ttl_s=5)
        approval = self.approved('reserve', ttl_s=5)
        self.assertTrue(self.call('reserve', approval, ttl_s=5))
        for spy in self.effects():
            spy.reset_mock()
        self.refused('reserve', approval, interactive=False, ttl_s=5)

    def test_changed_policy_cannot_reinterpret_an_outstanding_confirmation(self):
        approval = self.approved('reserve')
        self.cfg['classes']['reserve'] = 'allow'
        self.refused('reserve', approval, interactive=False)
        self.assertTrue(self.call('reserve'), 'explicit allow still works without recycling the old approval')

    def test_policy_replacement_invalidates_confirmation_even_with_preserved_mtime(self):
        hostlib.write_json(hostd.CONFIG, {'version': 1})
        before = os.stat(hostd.CONFIG)
        approval = self.approved('reserve')
        replacement = hostd.CONFIG + '.replacement'
        hostlib.write_json(replacement, {'version': 1})
        os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
        os.replace(replacement, hostd.CONFIG)
        self.seed()
        self.refused('reserve', approval, interactive=False)

    def test_expired_or_restarted_confirmation_never_authorizes_an_action(self):
        clock = [10.0]
        with patch.object(hostd, 'confirmations', hostd.Confirmations(clock=lambda: clock[0], ttl_s=5)):
            approval = self.approved('reserve')
            clock[0] = 16.0
            self.refused('reserve', approval, interactive=False)
            approval = self.approved('reserve')
            with patch.object(hostd, 'confirmations', hostd.Confirmations()):
                self.refused('reserve', approval, interactive=False)

    def test_pending_confirmation_limits_refuse_without_evicting_existing_consent(self):
        with patch.object(hostd, 'confirmations', hostd.Confirmations(max_pending=2, per_owner=1)):
            approval = self.approved('reserve', ttl_s=5)
            self.assertEqual(approval, self.approved('reserve', ttl_s=5), 'identical pending requests reuse their challenge')
            self.refused('reserve', {}, ttl_s=6, code='BLOCKED', interactive=False)
            with patch.object(hostd, 'session_for', return_value=('another', {'project': self.project})):
                self.approved('reserve', ttl_s=6)
            with patch.object(hostd, 'session_for', return_value=('third', {'project': self.project})):
                self.refused('reserve', {}, ttl_s=6, code='BLOCKED', interactive=False)
            self.assertTrue(self.call('reserve', approval, ttl_s=5))

    def test_versioned_mutation_envelope_uses_the_authenticated_request(self):
        req = {'op': 'mutate_v1', 'action': 'reserve', 'args': {'resources': ['gpu']}, 'grant': 'test-grant'}
        with self.assertRaises(hostd.Refusal) as cm:
            hostd.handle(req, 123, hostd.UID)
        self.assertEqual(cm.exception.code, 'REQUIRES_AUTHORIZATION')
        challenge = cm.exception.detail['approval_request']
        self.assertEqual(challenge['protocol'], 'mina-confirmation-v1')
        req['args']['approval'] = {'granted': True, 'challenge': challenge['challenge']}
        self.assertTrue(hostd.handle(req, 123, hostd.UID))
        for args in ({'op': 'release'}, {'grant': 'forged'}, []):
            with self.subTest(args=args), self.assertRaises(hostd.Refusal) as bad:
                hostd.handle({**req, 'args': args}, 123, hostd.UID)
            self.assertEqual(bad.exception.code, 'INVALID')
        with self.assertRaises(hostd.Refusal) as bad:
            hostd.handle({**req, 'action': 'alarms'}, 123, hostd.UID)
        self.assertEqual(bad.exception.code, 'INVALID')

    def test_confirmation_does_not_cross_sessions_or_operations(self):
        approval = self.approved('reserve')
        with patch.object(hostd, 'session_for', return_value=('other-session', {'project': self.project})):
            self.refused('reserve', approval, interactive=False)
        self.assertTrue(self.call('reserve', approval), 'another session cannot burn the original session token')
        for spy in self.effects():
            spy.reset_mock()
        approval = self.approved('reserve')
        self.refused('release', approval, interactive=False)

    def test_concurrent_confirmation_replay_admits_at_most_one_action(self):
        from concurrent.futures import ThreadPoolExecutor
        approval = self.approved('reserve')
        def attempt(_):
            try:
                self.call('reserve', approval)
                return True
            except hostd.Refusal:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            admitted = list(pool.map(attempt, range(2)))
        self.assertEqual(sorted(admitted), [False, True])
        self.acquire.assert_called_once()

    def test_policy_change_while_authenticating_refuses_before_admission(self):
        self.cfg['classes']['reserve'] = 'allow'
        hostlib.write_json(hostd.CONFIG, {'projects': {self.project: self.cfg}})
        updated = json.loads(json.dumps(self.cfg))
        updated['classes']['reserve'] = 'deny'
        def authenticate(*args):
            with open(hostd.CONFIG, 'w') as f:
                json.dump({'projects': {self.project: updated}}, f)
            return 'session', {'project': self.project}
        self.seed()
        with patch.object(hostd, 'project_config', self.real_project_config), patch.object(hostd, 'session_for', side_effect=authenticate):
            self.refused('reserve', {}, code='BLOCKED', interactive=False)

    def test_inflight_policy_edit_does_not_broaden_an_admitted_workload(self):
        hostlib.write_json(hostd.CONFIG, {'projects': {self.project: self.cfg}})
        updated = json.loads(json.dumps(self.cfg))
        updated['classes']['monitor'] = 'allow'
        def launch(*args, **kwargs):
            hostlib.write_json(hostd.CONFIG, {'projects': {self.project: updated}})
            return subprocess.CompletedProcess([], 0, '', '')
        with patch.object(hostd, 'project_config', self.real_project_config):
            approval = self.approved('workload_run')
            self.run.side_effect = launch
            result = self.call('workload_run', approval)
            self.assertNotIn('monitor', result, 'the launch uses its admitted policy, not a later widening')
            self.evaluate.assert_not_called()
            self.assertTrue(self.call('monitor_add'), 'a subsequent request can use the newly allowed policy')

    def test_confirmation_is_not_cached_or_broadened(self):
        self.call('reserve', self.approved('reserve'))
        for op in ('reserve', 'release', 'workload_run', 'monitor_add', 'service_restart'):
            with self.subTest(op=op):
                for spy in self.effects():
                    spy.reset_mock()
                self.refused(op, {})
        result = self.call('workload_run', self.approved('workload_run'))
        self.assertNotIn('monitor', result)  # workload approval must not approve an automatic ask-level monitor
        self.cfg['classes']['monitor'] = 'allow'
        result = self.call('workload_run', self.approved('workload_run'))
        self.assertIn('monitor', result)     # preserve the existing allow-level automatic monitor

    def test_direct_mutation_handlers_cannot_bypass_ask(self):
        for op in self.mutations:
            with self.subTest(op=op):
                self.seed()
                self.refused(op, {}, direct=True)

    def test_ask_confirmed_and_allow_keep_mutation_capabilities(self):
        for level, approval in [('ask', {'approval': {'granted': True}}), ('allow', {})]:
            for op, (cls, _) in self.mutations.items():
                for direct in (False, True):
                    with self.subTest(level=level, op=op, direct=direct):
                        self.cfg['classes'] = dict.fromkeys(hostd.CLASSES, 'ask')
                        self.cfg['classes'][cls] = level
                        self.seed()
                        bound = self.approved(op, direct) if level == 'ask' else approval
                        result = self.call(op, bound, direct)
                        self.assertTrue(result)
                        if op == 'reserve':
                            self.acquire.assert_called_once()
                        elif op == 'release':
                            self.assertNotIn('r-owned', hostd.reservations)
                        elif op == 'workload_run':
                            self.run.assert_called_once()
                        elif op == 'workload_stop':
                            self.systemctl.assert_called_once_with('stop', 'never-real.service', timeout=60)
                        elif op == 'monitor_add':
                            self.evaluate.assert_called_once()
                        elif op == 'monitor_remove':
                            self.assertEqual(hostlib.read_json(hostd.MONITORS), {})
                        else:
                            self.restart.assert_called_once()

    def test_deny_is_not_overridden_by_confirmation(self):
        for op, (cls, _) in self.mutations.items():
            for direct in (False, True):
                with self.subTest(op=op, direct=direct):
                    self.cfg['classes'][cls] = 'deny'
                    self.seed()
                    self.refused(op, {'approval': {'granted': True}}, direct, interactive=False)

    def test_restart_combines_class_and_service_levels(self):
        for cls in ('allow', 'ask', 'deny'):
            for svc in ('allow', 'ask', 'deny'):
                self.cfg['classes']['restart'] = cls
                self.cfg['services']['test']['restart'] = svc
                for approval in (*self.invalid_approvals, {'approval': {'granted': True}}):
                    with self.subTest(cls=cls, service=svc, approval=approval):
                        self.seed()
                        denied = 'deny' in (cls, svc)
                        needs_confirmation = 'ask' in (cls, svc)
                        if denied or needs_confirmation:
                            self.refused('service_restart', approval, interactive=not denied)
                        else:
                            self.assertTrue(self.call('service_restart', approval)['verified'])
                if 'deny' not in (cls, svc) and 'ask' in (cls, svc):
                    self.assertTrue(self.call('service_restart', self.approved('service_restart'))['verified'])

    def test_confirmation_does_not_replace_preconditions_or_project_ownership(self):
        for op, extra, code in [('reserve', {'resources': ['unknown']}, 'REQUIRES_AUTHORIZATION'),
                                ('workload_run', {'workload': 'unknown'}, 'REQUIRES_AUTHORIZATION'),
                                ('monitor_add', {'kind': 'unknown'}, 'INVALID'),
                                ('service_restart', {'service': 'unknown'}, 'REQUIRES_AUTHORIZATION')]:
            with self.subTest(op=op):
                self.seed()
                self.refused(op, self.approved(op, **extra), code=code, interactive=False, **extra)
        for op in ('release', 'workload_stop', 'monitor_remove'):
            with self.subTest(op=op):
                self.seed()
                self.project += '/other'  # records still belong to the original project
                self.refused(op, self.approved(op), code='NOT_FOUND', interactive=False)
                self.project = self.project.removesuffix('/other')

    def test_real_observe_handlers_remain_noninteractive(self):
        hostlib.write_json(hostd.MONITORS, {})
        hostlib.write_json(hostd.ALARMS, {'a-test': {'project': self.project, 'delivered': None, 'at': 1}})
        with patch.object(hostd, 'show', return_value={}), patch.object(hostd, 'deployment', return_value={}), \
                patch.object(hostd, 'config', return_value={}), patch.object(hostd, 'capabilities', return_value={'capabilities': []}):
            for op, extra in [('capabilities', {}), ('service_status', {'service': 'test'}),
                              ('service_logs', {'service': 'test'}), ('workload_status', {}),
                              ('monitor_list', {}), ('alarms', {'ack': ['a-test']})]:
                with self.subTest(op=op):
                    result = hostd.handle({'op': op, 'grant': 'test-grant', **extra}, 123, hostd.UID)
                    self.assertIsInstance(result, dict)
                    if op == 'alarms':
                        self.assertEqual(result['acked'], ['a-test'])

    def test_observe_ask_stays_noninteractive_and_deny_still_refuses(self):
        # Check dispatcher admission for every observe operation, without altering the observe ask semantics.
        for op, (cls, fn) in hostd.OPS.items():
            if cls != 'observe':
                continue
            with self.subTest(op=op):
                observed = unittest.mock.Mock(return_value={'observed': True})
                with patch.dict(hostd.OPS, {op: (cls, observed)}):
                    req = {'op': op, 'grant': 'test-grant'}
                    self.assertEqual(hostd.handle(req, 123, hostd.UID), {'observed': True})
                    observed.assert_called_once_with(self.project, 'session', req)
                    self.cfg['classes']['observe'] = 'deny'
                    with self.assertRaises(hostd.Refusal) as cm:
                        hostd.handle(req, 123, hostd.UID)
                    self.assertNotIn('approval_needed', cm.exception.detail)
                    self.cfg['classes']['observe'] = 'ask'


@unittest.skipUnless(SYSTEMD_USER, NEEDS_SYSTEMD)
class RequestBrokerTest(unittest.TestCase):
    """Public native/socket interfaces against a private broker, never production state or units."""

    def setUp(self):
        self.b = b = Broker()
        self.addCleanup(b.cleanup)
        self.marker = os.path.join(b.tmp, 'executions')
        self.cfg = {'classes': {'observe': 'allow', 'workload': 'allow'},
                    'instance_budget': {'max_admissions': 1},
                    'workloads': {'once': {'argv': ['sh', '-c', f'echo run >> {self.marker}'], 'max_s': 2}}}
        b.config(self.cfg)
        b.start()
        self.grant = b.open_session()

    def native(self, discard=False):
        b = self.b
        grant_file = os.path.join(b.tmp, 'grant')
        with open(grant_file, 'w') as f:
            f.write(self.grant)
        r = subprocess.run(['node', os.path.join(HERE, 'client_fixture.mjs'), b.sock, grant_file, b.project],
                           input=json.dumps({'action': 'workload_run', 'workload': 'once'}), text=True,
                           stdout=subprocess.DEVNULL if discard else subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return None if discard else json.loads(r.stdout)['result']['details']

    def test_native_output_survives_restart_without_confirmation_or_new_admission(self):
        self.cfg['workloads']['once']['argv'] = [sys.executable, '-c', "import os; os.write(1,b'\\x00'*4096+b'END')"]
        self.b.config(self.cfg)
        result = self.native(); self.assertTrue(result['ok'], result)
        wid = result['result']['id']
        self.assertTrue(wait_for(lambda: self.b.raw({'op': 'workload_status', 'grant': self.grant, 'id': wid})['result']['state'] == 'exited'))
        self.b.stop(); self.b.start(); self.grant = self.b.open_session()
        grant_file = os.path.join(self.b.tmp, 'output-grant')
        with open(grant_file, 'w') as f: f.write(self.grant)
        r = subprocess.run(['node', os.path.join(HERE, 'client_fixture.mjs'), self.b.sock, grant_file, self.b.project],
                           input=json.dumps({'action': 'workload_output', 'id': wid, 'limit': 8192}), text=True, capture_output=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        reply = json.loads(r.stdout)
        self.assertEqual(reply['confirmations'], 0)
        self.assertFalse(reply['result']['isError'])
        visible = reply['result']['content'][0]['text']
        self.assertNotIn('(truncated)', visible)
        page = json.loads(visible.removeprefix('OK: '))
        self.assertEqual(base64.b64decode(page['data_base64']), b'\x00'*4096+b'END')
        self.assertTrue(page['eof'])
        budget = self.b.raw({'op': 'workload_budget', 'grant': self.grant})['result']
        self.assertEqual(budget['used']['admissions'], 0, 'historical output grants no new admission and makes no charge')

    def test_lost_native_reply_and_parallel_retries_execute_and_charge_once(self):
        self.native(discard=True)  # launcher loses the entire tool result
        replay = self.native()
        self.assertTrue(replay['ok'], replay)
        out = replay['result']
        self.assertTrue(out['replayed'])
        request_id = out['request_id']
        req = {'op': 'mutate_v2', 'request_protocol': hostd.REQUEST_PROTOCOL, 'action': 'workload_run',
               'args': {'workload': 'once', 'request_id': request_id}, 'grant': self.grant}
        repeats = self.parallel(req)
        self.assertTrue(all(r['ok'] and r['result']['id'] == out['id'] for r in repeats), repeats)
        with open(self.marker) as f:
            self.assertEqual(f.read().splitlines(), ['run'])
        status = self.b.raw({'op': 'workload_budget', 'grant': self.grant})['result']
        self.assertEqual(status['used']['admissions'], 1)
        changed = {**req, 'args': {**req['args'], 'max_s': 2}}
        self.assertEqual(self.b.raw(changed)['error']['code'], 'CONFLICT')
        other = self.b.open_session()
        lookup = {'op': 'workload_status', 'grant': other, 'request_id': request_id}
        self.assertEqual(self.b.raw(lookup)['error']['code'], 'NOT_FOUND')

    def parallel(self, req):
        # The native session is bound to one live Pi process; parallel sockets share that process.
        script = r"""
import json, socket, sys
from concurrent.futures import ThreadPoolExecutor
request = sys.stdin.read().encode() + b'\n'
def call(_):
    with socket.socket(socket.AF_UNIX) as s:
        s.connect(sys.argv[1]); s.sendall(request)
        data = b''
        while not data.endswith(b'\n'):
            data += s.recv(65536)
        return json.loads(data)
with ThreadPoolExecutor(max_workers=8) as pool:
    print(json.dumps(list(pool.map(call, range(8)))))
"""
        r = subprocess.run([sys.executable, '-c', script, self.b.sock], input=json.dumps(req),
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_parallel_first_submissions_have_one_admission(self):
        results = self.parallel({'op': 'mutate_v2', 'request_protocol': hostd.REQUEST_PROTOCOL, 'action': 'workload_run',
                                 'args': {'workload': 'once', 'request_id': 'parallel-first'}, 'grant': self.grant})
        self.assertTrue(all(r['ok'] for r in results), results)
        self.assertEqual(len({r['result']['id'] for r in results}), 1)
        self.assertEqual(sum(not r['result']['replayed'] for r in results), 1)
        with open(self.marker) as f:
            self.assertEqual(f.read().splitlines(), ['run'])
        status = self.b.raw({'op': 'workload_budget', 'grant': self.grant})['result']
        self.assertEqual(status['used']['admissions'], 1)

    def test_durable_pending_intent_after_real_restart_is_not_an_allowance(self):
        b = self.b
        workloads = os.path.join(b.env['MINA_HOST_STATE'], 'workloads')
        with open(workloads, 'w') as f:
            f.write('fixture: fail after receipt and charge, before job record or launch')
        req = {'op': 'mutate_v2', 'request_protocol': hostd.REQUEST_PROTOCOL, 'action': 'workload_run',
               'args': {'workload': 'once', 'request_id': 'pending-restart'}, 'grant': self.grant}
        first = b.raw(req)
        self.assertFalse(first['ok'])
        self.assertTrue(first['error']['budget_charged'])
        directory = os.path.join(b.env['MINA_HOST_STATE'], 'request-intents')
        self.assertEqual(os.stat(directory).st_mode & 0o777, 0o700)
        receipts = os.listdir(directory)
        self.assertEqual(len(receipts), 1)
        self.assertEqual(os.stat(os.path.join(directory, receipts[0])).st_mode & 0o777, 0o600)
        os.unlink(workloads)  # failure repaired, but history still cannot authorize another launch
        b.stop(); b.start()
        again = b.raw(req)
        self.assertTrue(again['ok'], again)
        self.assertEqual(again['result']['receipt_state'], 'pending_unknown')
        self.assertTrue(again['result']['replayed'])
        status = b.raw({'op': 'workload_status', 'grant': self.grant, 'request_id': 'pending-restart'})
        self.assertEqual(status['result']['receipt_state'], 'pending_unknown')
        budget = b.raw({'op': 'workload_budget', 'grant': self.grant})['result']
        self.assertEqual(budget['coverage'], 'unknown')
        self.assertIsNone(budget['remaining']['admissions'])
        fresh = {**req, 'args': {**req['args'], 'request_id': 'fresh'}}
        self.assertEqual(b.raw(fresh)['error']['code'], 'BLOCKED')
        self.assertFalse(os.path.exists(self.marker))
        self.cfg.pop('instance_budget')
        b.config(self.cfg)
        self.assertTrue(b.raw(req)['result']['replayed'])
        self.assertFalse(os.path.exists(self.marker))


@unittest.skipUnless(SYSTEMD_USER, NEEDS_SYSTEMD)
class HostBrokerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        b = cls.b = Broker()
        L = b.locks
        cls.canary_log = os.path.join(b.tmp, 'telemetry', 'canary.log')
        cls.fail_flag = os.path.join(b.tmp, 'canary.fail')
        cls.canary_src = os.path.join(b.tmp, 'canary.py')
        shutil.copy(os.path.join(HERE, 'canary.py'), cls.canary_src)
        cls.sup = b.unit('sup', 'sleep', 'infinity')
        cls.canary = b.unit('canary', sys.executable, cls.canary_src, cls.canary_log, cls.fail_flag)
        cls.resource = {'locks': [{'path': f'{L}/HOST_QUIET.lock', 'turnstile': f'{L}/TURNSTILE.lock'},
                                  {'path': f'{L}/MEASUREMENT.lock', 'turnstile': f'{L}/MTURN.lock'}, {'path': f'{L}/GPU_TEST.lock'}],
                        'lockouts': [f'{b.tmp}/lockout/GPU_TEST'], 'requires_active': [cls.sup], 'device': {'kfd': True}}
        cls.marker = os.path.join(b.tmp, 'ran')
        # A stand-in for a campaign runner's host side: it sees host state (a marker in the host /tmp), then runs the sandboxed command.
        cls.runner = os.path.join(b.project, 'runner.py')
        cls.host_marker = os.path.join(b.tmp, 'host-only-marker')
        open(cls.host_marker, 'w').write('host')
        open(cls.runner, 'w').write('import os,subprocess,sys\nprint("runner exp=%s max_s=%s host_tmp=%s" % (sys.argv[1], sys.argv[2], '
                                    f'os.path.exists({cls.host_marker!r})), flush=True)\n'
                                    'sys.exit(subprocess.call(sys.argv[sys.argv.index("--") + 1:]))\n')
        cls.control = os.path.join(b.project, 'control'); os.makedirs(cls.control)
        cls.secret = os.path.join(b.tmp, 'secret'); os.makedirs(cls.secret); open(os.path.join(cls.secret, 'key'), 'w').write('SECRETKEY')
        cls.runner_sha = __import__('hashlib').sha256(open(cls.runner, 'rb').read()).hexdigest()
        cls.cfg = {
            'classes': {'observe': 'allow', 'reserve': 'allow', 'workload': 'allow', 'monitor': 'allow', 'restart': 'allow'},
            'services': {
                'canary': {'unit': cls.canary, 'restart': 'allow', 'sources': [cls.canary_src], 'process_match': cls.canary_src,
                           'restart_requires_idle': ['GPU_TEST'], 'settle_s': 0.5, 'logs': [cls.canary_log],
                           'health': {'log': cls.canary_log, 'pattern': r'START canary pid={pid} ', 'timeout_s': 8,
                                      'fail_pattern': 'ENFORCEMENT_FAILED', 'stable_s': 1.5}},
                'canary_ask': {'unit': cls.canary, 'restart': 'ask', 'sources': [cls.canary_src]},
                'canary_deny': {'unit': cls.canary, 'sources': [cls.canary_src]},
            },
            'resources': {'GPU_TEST': cls.resource},
            'workloads': {
                'ok': {'argv': ['sh', '-c', f'echo hello; touch {cls.marker}'], 'resources': ['GPU_TEST'], 'max_s': 30},
                'hold': {'argv': ['sleep', '300'], 'resources': ['GPU_TEST'], 'max_s': 300},
                'deadline': {'argv': ['sleep', '300'], 'resources': [], 'max_s': 2},
                # The leader exits at once; its grandchild left a new session (setsid) and would otherwise run on.
                'orphan': {'argv': [sys.executable, '-c', 'import os,subprocess,sys\nsubprocess.Popen(["setsid","sleep","300"],'
                                    'start_new_session=True)\nimport time; time.sleep(0.5)\nsys.exit(3)'], 'resources': ['GPU_TEST'], 'max_s': 60},
                'fresh': {'argv': ['true'], 'resources': [], 'max_s': 10, 'requires_fresh': ['canary']},
                'cell': {'argv': [sys.executable, cls.runner, '{exp}', '{max_s}', '--', '{command}'], 'params': {'exp': '^[a-z0-9-]{1,20}$'},
                         'max_s': 30, 'pin': {cls.runner: cls.runner_sha},
                         'sandbox': {'write': ['{project}'], 'readonly': [cls.control], 'hide': [cls.secret]},
                         'env': {'CELL_EXP': 'exp-{exp}', 'CELL_MAX': '{max_s}'},
                         'cleanup': ['sh', '-c', f'echo cleaned > {b.tmp}/cleanup-ran']},
            },
            'monitor_paths': [os.path.join(b.tmp, 'telemetry')],
            'max_monitor_ttl_s': 3600,
        }
        b.config(cls.cfg)
        b.start()
        assert wait_for(lambda: os.path.exists(cls.canary_log) and 'START' in open(cls.canary_log).read())
        cls.grant = b.open_session()

    @classmethod
    def tearDownClass(cls):
        cls.b.cleanup()

    def setUp(self):
        for p in os.listdir(self.b.kfd):
            os.unlink(os.path.join(self.b.kfd, p))
        lo = f'{self.b.tmp}/lockout/GPU_TEST'
        if os.path.exists(lo):
            os.unlink(lo)
        for f in (self.fail_flag, self.fail_flag + '.degrade'):
            if os.path.exists(f):
                os.unlink(f)

    def call(self, op, **kw):
        return self.b.raw({'op': op, 'grant': self.grant, **kw})

    def ok(self, op, **kw):
        out = self.call(op, **kw)
        self.assertTrue(out['ok'], out)
        return out['result']

    def refused(self, code, op, **kw):
        out = self.call(op, **kw)
        self.assertFalse(out['ok'], out)
        self.assertEqual(out['error']['code'], code, out)
        return out['error']

    def canary_pid(self):
        return int(subprocess.run(['systemctl', '--user', 'show', '-p', 'MainPID', '--value', self.canary], capture_output=True, text=True).stdout)

    # --- who may call --------------------------------------------------------------------------------------------

    @unittest.skipUnless(BWRAP, NEEDS_BWRAP)
    def test_auth_only_the_sessions_mina_process(self):
        self.assertTrue(self.call('service_status', service='canary')['ok'])                       # the launcher's child
        via_bwrap = self.b.raw({'op': 'service_status', 'service': 'canary', 'grant': self.grant}, via=['bwrap', '--dev-bind', '/', '/', '--'])
        self.assertTrue(via_bwrap['ok'], via_bwrap)                                                # its grandchild through bwrap
        for via in (['bash', '-c', '"$@"; true', 'x'], ['bwrap', '--dev-bind', '/', '/', '--', 'bash', '-c', '"$@"; true', 'x']):
            out = self.b.raw({'op': 'service_status', 'service': 'canary', 'grant': self.grant}, via=via)
            self.assertEqual(out['error']['code'], 'UNAUTHENTICATED', (via, out))                  # a command the agent ran
        self.assertEqual(self.b.raw({'op': 'service_status', 'service': 'canary', 'grant': 'forged'})['error']['code'], 'UNAUTHENTICATED')
        self.assertEqual(self.b.raw({'op': 'reserve', 'resources': ['GPU_TEST']})['error']['code'], 'UNAUTHENTICATED')

    @unittest.skipUnless(BWRAP, NEEDS_BWRAP)
    def test_auth_sandboxed_process_cannot_open_a_session(self):
        out = self.b.raw({'op': 'session_open', 'project': self.b.project}, via=['bwrap', '--dev-bind', '/', '/', '--'])   # its own mount namespace
        self.assertEqual(out['error']['code'], 'UNAUTHENTICATED', out)
        self.assertIn('outside the sandbox', out['error']['message'])

    def test_auth_session_pins_to_one_live_process(self):
        # A long-lived first caller pins the session; a second live caller with the same grant is refused.
        a = subprocess.Popen([sys.executable, self.b.client, self.b.sock], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        a.stdin.write(json.dumps({'op': 'service_status', 'service': 'canary', 'grant': self.grant}) + '\n'); a.stdin.flush()
        self.assertTrue(json.loads(a.stdout.readline())['ok'])
        out = self.call('service_status', service='canary')
        self.assertEqual(out['error']['code'], 'UNAUTHENTICATED', out)
        a.stdin.close(); a.wait(10)
        self.assertTrue(self.call('service_status', service='canary')['ok'])                       # free again once it exits

    # --- capabilities --------------------------------------------------------------------------------------------

    def test_capabilities_report_and_cache(self):
        c = self.ok('capabilities', refresh=True)
        by = {x['capability']: x for x in c['capabilities']}
        self.assertEqual(by['resource:GPU_TEST']['status'], 'AVAILABLE')
        self.assertEqual(by['service:canary:restart']['status'], 'AVAILABLE')
        self.assertEqual(by['service:canary_ask:restart']['status'], 'REQUIRES_AUTHORIZATION')
        self.assertEqual(by['service:canary_deny:restart']['status'], 'REQUIRES_AUTHORIZATION')
        self.assertIn('restart', by['service:canary_deny:restart']['remediation'])
        self.assertEqual(by['alarm_delivery_external']['status'], 'BLOCKED')
        self.assertNotIn(' from ', by['workload:cell']['detail'])                        # exp is free text, not a list
        self.assertTrue(self.ok('capabilities')['cached'])
        open(f'{self.b.tmp}/lockout/GPU_TEST', 'w').write('test fault')                            # host state changed
        c2 = self.ok('capabilities')
        self.assertNotIn('cached', c2)
        r = {x['capability']: x for x in c2['capabilities']}['resource:GPU_TEST']
        self.assertEqual(r['status'], 'BLOCKED')
        self.assertIn('never', r['remediation'])

    def test_unregistered_project_requires_authorization(self):
        other = tempfile.mkdtemp(dir=self.b.tmp)
        out = self.b.raw({'op': 'capabilities', 'project': other})                                 # the user's shell may ask
        self.assertEqual(out['result']['capabilities'][0]['status'], 'REQUIRES_AUTHORIZATION')
        self.assertIn(other, out['result']['capabilities'][0]['remediation'])

    # --- services ------------------------------------------------------------------------------------------------

    def test_service_status_logs_and_unregistered(self):
        s = self.ok('service_status', service='canary')
        self.assertEqual(s['active'], 'active')
        self.assertIn(s['deployment']['verdict'], ('FRESH', 'STALE'))
        logs = self.ok('service_logs', service='canary', lines=5)
        self.assertTrue(any('canary' in ln for ln in logs['files'][self.canary_log]))
        e = self.refused('REQUIRES_AUTHORIZATION', 'service_status', service='sshd')
        self.assertIn('services.sshd', e['remediation'])

    def test_restart_verified_then_failed_restart_is_reported(self):
        old = self.canary_pid()
        r = self.ok('service_restart', service='canary')
        self.assertTrue(r['verified'], r)
        self.assertNotEqual(r['new_process']['pid'], old)
        self.assertEqual(r['deployment']['verdict'], 'FRESH')
        self.assertIn(f'pid={r["new_process"]["pid"]}', r['health_line'])
        self.assertTrue(free(f'{self.b.locks}/GPU_TEST.lock'))                                     # idle-gate released
        # Negative control: the new deployment fails at start. Reported as not verified, never as a success.
        open(self.fail_flag, 'w').close()
        bad = self.ok('service_restart', service='canary')
        self.assertFalse(bad['verified'], bad)
        self.assertTrue(any('unit is' in f or 'no main process' in f for f in bad['failures']), bad['failures'])
        os.unlink(self.fail_flag)
        good = self.ok('service_restart', service='canary')
        self.assertTrue(good['verified'], good)

    def test_restart_that_degrades_after_start_is_not_verified(self):
        open(self.fail_flag + '.degrade', 'w').close()
        r = self.ok('service_restart', service='canary')
        self.assertFalse(r['verified'], r)
        self.assertTrue(any('ENFORCEMENT_FAILED' in f and 'since the restart' in f for f in r['failures']), r['failures'])
        os.unlink(self.fail_flag + '.degrade')
        self.assertTrue(self.ok('service_restart', service='canary')['verified'])                   # old failure lines do not count

    def test_restart_approval_levels(self):
        e = self.refused('REQUIRES_AUTHORIZATION', 'service_restart', service='canary_ask')
        self.assertTrue(e['approval_needed'])
        old = self.canary_pid()
        self.refused('REQUIRES_AUTHORIZATION', 'service_restart', service='canary_deny')
        self.assertEqual(self.canary_pid(), old)                                                    # nothing happened
        r = self.ok('service_restart', service='canary_ask',
                    approval={'granted': True, 'challenge': e['approval_request']['challenge'], 'by': 'test'})
        self.assertNotEqual(r['new_process']['pid'], old)
        self.assertNotIn('challenge', r['approval'], 'execution receipts must not return bearer tokens')
        self.assertIn('challenge_id', r['approval'])
        with open(os.path.join(self.b.env['MINA_HOST_STATE'], 'deployments', 'canary_ask.json')) as f:
            self.assertNotIn(e['approval_request']['challenge'], f.read())

    def test_restart_refused_while_resources_busy(self):
        old = self.canary_pid()
        holder = flock_holder(f'{self.b.locks}/MEASUREMENT.lock')
        try:
            e = self.refused('CONFLICT', 'service_restart', service='canary')
            self.assertIn(holder.pid, [h['pid'] for h in e['evidence']['holders']])
        finally:
            holder.kill(); holder.wait()
        open(os.path.join(self.b.kfd, '4242'), 'w').close()                                        # a GPU user outside the protocol
        self.refused('CONFLICT', 'service_restart', service='canary')
        self.assertEqual(self.canary_pid(), old)

    def test_stale_deployment_blocks_experiments(self):
        self.ok('service_restart', service='canary')
        self.assertTrue(self.ok('workload_run', workload='fresh')['state'] in ('exited', 'running', 'starting'))
        time.sleep(1.1)
        os.utime(self.canary_src)                                                                  # the code on disk changed
        self.assertEqual(self.ok('service_status', service='canary')['deployment']['verdict'], 'STALE')
        e = self.refused('BLOCKED', 'workload_run', workload='fresh')
        self.assertEqual(e['stale'][0]['service'], 'canary')
        self.ok('service_restart', service='canary')
        self.assertEqual(self.ok('service_status', service='canary')['deployment']['verdict'], 'FRESH')

    # --- reservations ----------------------------------------------------------------------------------------------

    def test_reserve_exclusive_and_conflicts(self):
        r = self.ok('reserve', resources=['GPU_TEST'], ttl_s=60)
        self.assertFalse(free(f'{self.b.locks}/GPU_TEST.lock'))                                     # a host runner sees it
        self.assertFalse(free(f'{self.b.locks}/MEASUREMENT.lock'))
        e = self.refused('CONFLICT', 'reserve', resources=['GPU_TEST'])                             # a second Mina session
        self.assertTrue(e['evidence']['holders'])
        self.ok('release', reservation=r['reservation'])
        self.assertTrue(free(f'{self.b.locks}/GPU_TEST.lock'))
        for path in ('GPU_TEST.lock', 'TURNSTILE.lock', 'MTURN.lock'):                             # a runner holds or queues
            holder = flock_holder(f'{self.b.locks}/{path}')
            try:
                e = self.refused('CONFLICT', 'reserve', resources=['GPU_TEST'])
                self.assertIn(holder.pid, [h['pid'] for h in e['evidence']['holders']], path)
            finally:
                holder.kill(); holder.wait()
            self.assertTrue(free(f'{self.b.locks}/HOST_QUIET.lock'), f'nothing left held after the {path} conflict')

    def test_reserve_blocked_by_lockout_supervisor_and_device(self):
        open(f'{self.b.tmp}/lockout/GPU_TEST', 'w').write('Containment UNKNOWN x')
        e = self.refused('BLOCKED', 'reserve', resources=['GPU_TEST'])
        self.assertEqual(e['problems'][0]['kind'], 'lockout')
        self.assertTrue(os.path.exists(f'{self.b.tmp}/lockout/GPU_TEST'))                           # never cleared by mina
        os.unlink(f'{self.b.tmp}/lockout/GPU_TEST')
        open(os.path.join(self.b.kfd, str(os.getpid())), 'w').close()
        e = self.refused('CONFLICT', 'reserve', resources=['GPU_TEST'])
        self.assertEqual(e['problems'][0]['kind'], 'device_busy')
        self.assertTrue(free(f'{self.b.locks}/GPU_TEST.lock'))

    def test_reservation_expires(self):
        self.ok('reserve', resources=['GPU_TEST'], ttl_s=1)
        self.assertTrue(wait_for(lambda: free(f'{self.b.locks}/GPU_TEST.lock'), timeout=10))

    def test_unregistered_resource_and_class_not_approved(self):
        e = self.refused('REQUIRES_AUTHORIZATION', 'reserve', resources=['GPU_OTHER'])
        self.assertIn('resources.GPU_OTHER', e['remediation'])
        cfg = json.loads(json.dumps(self.cfg)); cfg['classes']['reserve'] = 'deny'
        self.b.config(cfg)
        try:
            e = self.refused('REQUIRES_AUTHORIZATION', 'reserve', resources=['GPU_TEST'])
            self.assertIn('classes.reserve', e['remediation'])
        finally:
            self.b.config(self.cfg)

    # --- workloads -------------------------------------------------------------------------------------------------

    def wait_end(self, wid, timeout=30):
        return wait_for(lambda: (lambda s: s if s['state'] not in ('launching', 'starting', 'running') else None)(
            self.ok('workload_status', id=wid)), timeout=timeout)

    @unittest.skipUnless(BWRAP, NEEDS_BWRAP)
    def test_retained_output_is_pageable_without_another_job_or_charge(self):
        w = self.ok('workload_run', workload='cell', params={'exp': 'output'}, command=[sys.executable, '-c',
            'import json; print("BEGIN_STRUCTURED"); print(json.dumps({"rows":list(range(1000)),"marker":"fixture"},indent=2))'])
        end = self.wait_end(w['id'])
        self.assertEqual(end['result']['rc'], 0)
        self.assertNotIn('BEGIN_STRUCTURED', '\n'.join(end['output_tail']))
        budget = self.ok('workload_budget')['used']
        data, offset = b'', 0
        while True:
            page = self.ok('workload_output', id=w['id'], offset=offset, limit=4096)
            chunk = base64.b64decode(page['data_base64'], validate=True)
            self.assertLessEqual(len(chunk), 4096)
            self.assertEqual(page['next_offset'], offset + len(chunk))
            data += chunk; offset = page['next_offset']
            if page['eof']: break
            self.assertTrue(chunk)
        self.assertIn(b'BEGIN_STRUCTURED', data)
        self.assertEqual(json.loads(data[data.index(b'{\n'):]), {'rows': list(range(1000)), 'marker': 'fixture'})
        self.assertEqual(self.ok('workload_budget')['used'], budget)
        again = self.ok('workload_output', id=w['id'], offset=0, limit=32)
        self.assertEqual(base64.b64decode(again['data_base64']), data[:32])

    def test_output_reader_refuses_foreign_paths_and_unsafe_files(self):
        wid = '20010101000000-cafe01'
        directory = os.path.join(self.b.env['MINA_HOST_STATE'], 'workloads', wid)
        os.makedirs(directory)
        rec = {'id': wid, 'project': self.b.project, 'state': 'exited'}
        record, log = os.path.join(directory, 'record.json'), os.path.join(directory, 'output.log')
        hostlib.write_json(record, rec)
        private = os.path.join(self.b.tmp, 'output-reader-private')
        with open(private, 'w') as f:
            f.write('PRIVATE_OUTPUT_CANARY')
        try:
            self.refused('NOT_FOUND', 'workload_output', id=wid)
            for args in [{'offset': -1}, {'offset': True}, {'offset': 1.5}, {'offset': 2**53},
                         {'limit': 0}, {'limit': True}, {'limit': 8193}, {'path': private}]:
                self.refused('INVALID', 'workload_output', id=wid, **args)
            self.refused('INVALID', 'workload_output', id='../output-reader-private')
            os.symlink(private, log)
            self.refused('BLOCKED', 'workload_output', id=wid)
            os.unlink(log); os.link(private, log)
            self.refused('BLOCKED', 'workload_output', id=wid)
            os.unlink(log); os.mkfifo(log)
            self.refused('BLOCKED', 'workload_output', id=wid)
            os.unlink(log)
            payload = b'\x00\xff\xe2\x82\xac\n'
            with open(log, 'wb') as f:
                f.write(payload)
            page = self.ok('workload_output', id=wid, offset=1, limit=3)
            self.assertEqual(base64.b64decode(page['data_base64']), payload[1:4])
            self.assertFalse(page['eof'])
            beyond = self.ok('workload_output', id=wid, offset=100)
            self.assertTrue(beyond['eof']); self.assertEqual(beyond['data_base64'], '')
            rec['project'] += '/foreign'; hostlib.write_json(record, rec)
            self.refused('NOT_FOUND', 'workload_output', id=wid)
            unauth = self.b.raw({'op': 'workload_output', 'id': wid, 'project': self.b.project})
            self.assertEqual(unauth['error']['code'], 'UNAUTHENTICATED')
        finally:
            shutil.rmtree(directory)
            os.unlink(private)

    def test_workload_runs_holding_locks_and_exits_verified(self):
        if os.path.exists(self.marker):
            os.unlink(self.marker)
        w = self.ok('workload_run', workload='ok')
        end = self.wait_end(w['id'])
        self.assertEqual(end['state'], 'exited', end)
        self.assertEqual(end['result']['rc'], 0)
        self.assertTrue(end['verification']['verified_exit'])
        self.assertTrue(os.path.exists(self.marker))
        self.assertIn('hello', '\n'.join(end['output_tail']))
        self.assertTrue(free(f'{self.b.locks}/GPU_TEST.lock'))

    def test_workload_conflict_runs_nothing(self):
        if os.path.exists(self.marker):
            os.unlink(self.marker)
        holder = flock_holder(f'{self.b.locks}/GPU_TEST.lock')
        try:
            w = self.ok('workload_run', workload='ok')
            end = self.wait_end(w['id'])
            self.assertEqual(end['state'], 'conflict', end)
            self.assertFalse(os.path.exists(self.marker))
        finally:
            holder.kill(); holder.wait()

    def test_leader_exit_kills_surviving_children_only(self):
        unrelated = subprocess.Popen(['sleep', '300'])                                              # same user, outside
        try:
            w = self.ok('workload_run', workload='orphan')
            end = self.wait_end(w['id'])
            self.assertEqual(end['state'], 'exited', end)
            self.assertEqual(end['result']['rc'], 3)
            self.assertTrue(end['result']['survivors'], 'the setsid grandchild outlived the leader')
            self.assertTrue(end['verification']['verified_exit'], end)
            for m in end['result']['survivors']:
                self.assertFalse(hostlib.alive(m))
            self.assertIsNone(unrelated.poll())
            self.assertTrue(free(f'{self.b.locks}/GPU_TEST.lock'))
        finally:
            unrelated.kill(); unrelated.wait()

    def test_stop_affects_only_the_workload(self):
        unrelated = subprocess.Popen(['sleep', '300'])
        try:
            w = self.ok('workload_run', workload='hold')
            self.assertTrue(wait_for(lambda: self.ok('workload_status', id=w['id'])['state'] == 'running'))
            self.assertFalse(free(f'{self.b.locks}/GPU_TEST.lock'))                                 # held while it runs
            s = self.ok('workload_stop', id=w['id'])
            self.assertEqual(s['state'], 'stopped', s)
            self.assertTrue(s['verification']['verified_exit'])
            self.assertIsNone(unrelated.poll())
            self.assertTrue(free(f'{self.b.locks}/GPU_TEST.lock'))
        finally:
            unrelated.kill(); unrelated.wait()

    def test_deadline_enforced_by_systemd(self):
        w = self.ok('workload_run', workload='deadline')
        end = self.wait_end(w['id'], timeout=20)
        self.assertEqual(end['state'], 'deadline', end)
        self.assertTrue(end['verification']['verified_exit'])

    def test_interrupted_launch_and_broker_restart(self):
        # A record written just before a crash, whose unit never started.
        d = os.path.join(self.b.env['MINA_HOST_STATE'], 'workloads', '20000101000000-abcdef')
        hostlib.write_json(os.path.join(d, 'record.json'), {'id': '20000101000000-abcdef', 'workload': 'ok', 'project': self.b.project,
                           'session': 'x', 'unit': f'minatest-wl-{self.b.tag}-never.service', 'resources': [], 'max_s': 5,
                           'state': 'launching', 'launched': time.time() - 60, 'deadline': time.time() - 55, 'members_seen': []})
        w = self.ok('workload_run', workload='hold')
        self.assertTrue(wait_for(lambda: self.ok('workload_status', id=w['id'])['state'] == 'running'))
        self.b.stop()                                                                               # broker dies mid-run
        self.assertFalse(free(f'{self.b.locks}/GPU_TEST.lock'))                                     # the workload keeps its locks
        self.b.start()
        self.assertEqual(self.ok('workload_status', id='20000101000000-abcdef')['state'], 'launch_failed')
        s = self.ok('workload_stop', id=w['id'])
        self.assertEqual(s['state'], 'stopped')
        self.assertTrue(s['verification']['verified_exit'])

    @unittest.skipUnless(BWRAP, NEEDS_BWRAP)
    def test_parameterized_cell_runs_its_command_sandboxed(self):
        script = (f'echo env=$CELL_EXP/$CELL_MAX; echo inside; touch out-file; touch {self.control}/x 2>/dev/null || echo CONTROL_READ_ONLY; '
                  f'test -e {self.host_marker} && echo SEES_HOST_TMP || echo PRIVATE_TMP; '
                  f'test -S /run/user/{os.getuid()}/bus && echo BUS || echo NO_BUS; '
                  f'cat {self.secret}/key 2>/dev/null || echo SECRET_HIDDEN; '
                  f'{sys.executable} -I -c "import socket; print(\'NET_ONLY_LO\' if [n for _, n in socket.if_nameindex()] == [\'lo\'] else \'NET_HOST\')"')
        w = self.ok('workload_run', workload='cell', params={'exp': 'probe-1'}, max_s=10, command=['bash', '-c', script])
        end = self.wait_end(w['id'])
        self.assertEqual(end['state'], 'exited', end)
        out = '\n'.join(end['output_tail'])
        self.assertIn('runner exp=probe-1 max_s=10 host_tmp=True', out)                      # the host side sees host state
        self.assertIn('env=exp-probe-1/10', out)
        for word in ('inside', 'CONTROL_READ_ONLY', 'PRIVATE_TMP', 'NO_BUS', 'SECRET_HIDDEN', 'NET_ONLY_LO'):   # offline by default
            self.assertIn(word, out)                                                          # the command does not
        self.assertNotIn('SECRETKEY', out)
        self.assertTrue(os.path.exists(os.path.join(self.b.project, 'out-file')))
        self.assertFalse(os.path.exists(os.path.join(self.control, 'x')))
        self.assertEqual(end['command'][0], 'bash')
        self.assertEqual(end['cleanup']['rc'], 0)
        self.assertTrue(os.path.exists(os.path.join(self.b.tmp, 'cleanup-ran')))

    def test_parameterized_cell_refusals(self):
        self.assertIn('must match', self.refused('INVALID', 'workload_run', workload='cell', params={'exp': 'x; rm -rf /'}, command=['true'])['message'])
        self.refused('INVALID', 'workload_run', workload='cell', params={'exp': 'a', 'locks': 'X'}, command=['true'])
        self.refused('INVALID', 'workload_run', workload='cell', params={'exp': 'a'}, max_s=31, command=['true'])
        self.refused('INVALID', 'workload_run', workload='cell', params={'exp': 'a'})
        self.refused('INVALID', 'workload_run', workload='ok', command=['true'])
        original = open(self.runner).read()
        try:
            open(self.runner, 'a').write('# changed by the agent\n')
            e = self.refused('BLOCKED', 'workload_run', workload='cell', params={'exp': 'a'}, command=['true'])
            self.assertEqual(e['approved'], self.runner_sha)
            caps = {c['capability']: c for c in self.ok('capabilities', refresh=True)['capabilities']}
            self.assertEqual(caps['workload:cell']['status'], 'BLOCKED')
        finally:
            open(self.runner, 'w').write(original)

    def test_unregistered_workload(self):
        e = self.refused('REQUIRES_AUTHORIZATION', 'workload_run', workload='rm -rf /')
        self.assertIn('workloads.', e['remediation'])

    # --- monitors, alarms and handoff -------------------------------------------------------------------------------

    def test_monitor_alarm_survives_session_handoff(self):
        beat = os.path.join(self.b.tmp, 'telemetry', 'beat')
        open(beat, 'w').close()
        m = self.ok('monitor_add', kind='file_fresh', params={'path': beat, 'max_age_s': 1}, ttl_s=120, label='beat')
        # Session A ends (its launcher exits) before the alarm. The monitor lives on in the broker.
        launcher_a = subprocess.Popen([sys.executable, '-c', f'''
import json,socket
s=socket.socket(socket.AF_UNIX); s.connect({self.b.sock!r})
s.sendall((json.dumps({{"op":"session_open","project":{self.b.project!r}}})+"\\n").encode()); print(s.recv(65536).decode())'''],
            stdout=subprocess.PIPE, text=True)
        grant_a = json.loads(launcher_a.stdout.readline())['result']['grant']
        launcher_a.wait()
        self.assertEqual(self.b.raw({'op': 'alarms', 'grant': grant_a})['error']['code'], 'UNAUTHENTICATED')
        alarm = wait_for(lambda: [a for a in self.ok('alarms')['pending'] if a['monitor'] == m['id']], timeout=10)
        self.assertTrue(alarm, 'the alarm fired with no session of A alive')
        # Session B (this one) receives it after the handoff and acknowledges it; the broker records the delivery.
        acked = self.ok('alarms', ack=[alarm[0]['id']])['acked']
        self.assertEqual(acked, [alarm[0]['id']])
        self.assertFalse([a for a in self.ok('alarms')['pending'] if a['id'] == alarm[0]['id']])
        alarms = hostlib.read_json(os.path.join(self.b.env['MINA_HOST_STATE'], 'alarms.json'))
        self.assertTrue(alarms[alarm[0]['id']]['delivered']['session'])
        self.ok('monitor_remove', id=m['id'])

    def test_alarm_goes_to_its_monitors_session_while_that_session_lives(self):
        beat = os.path.join(self.b.tmp, 'telemetry', 'beat-owner')
        open(beat, 'w').close()
        # Session B: a second live Mina session on the same project. Its launcher sends each request through a child,
        # as Pi does, and keeps running until its stdin closes.
        launcher_b = subprocess.Popen([sys.executable, '-c', f'''
import json,socket,subprocess,sys
s=socket.socket(socket.AF_UNIX); s.connect({self.b.sock!r})
s.sendall((json.dumps({{"op":"session_open","project":{self.b.project!r}}})+"\\n").encode()); print(s.recv(65536).decode().strip(), flush=True)
for line in sys.stdin:
    r=subprocess.run([sys.executable,{self.b.client!r},{self.b.sock!r}],input=line,capture_output=True,text=True)
    print(r.stdout.strip(), flush=True)'''], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            grant_b = json.loads(launcher_b.stdout.readline())['result']['grant']
            def as_b(op, **kw):
                launcher_b.stdin.write(json.dumps({'op': op, 'grant': grant_b, **kw}) + '\n'); launcher_b.stdin.flush()
                out = json.loads(launcher_b.stdout.readline())
                self.assertTrue(out['ok'], out)
                return out
            m = as_b('monitor_add', kind='file_fresh', params={'path': beat, 'max_age_s': 1}, ttl_s=120, label='beat-b')['result']
            mine = lambda out: [a for a in out['result']['pending'] if a['monitor'] == m['id']]
            alarm = wait_for(lambda: mine(as_b('alarms')), timeout=10)
            self.assertTrue(alarm, 'the owner sees its alarm')
            # Negative control: session A (this one) neither sees B's alarm nor can acknowledge it while B lives.
            self.assertFalse([a for a in self.ok('alarms')['pending'] if a['monitor'] == m['id']])
            self.assertEqual(self.ok('alarms', ack=[alarm[0]['id']])['acked'], [])
            self.assertTrue(mine(as_b('alarms')), 'still pending for its owner')
        finally:
            launcher_b.stdin.close(); launcher_b.wait(timeout=10)
        # B's launcher has exited (a restart): its alarms reach the project's remaining session.
        self.assertEqual(self.ok('alarms', ack=[alarm[0]['id']])['acked'], [alarm[0]['id']])
        self.ok('monitor_remove', id=m['id'])

    def test_monitor_log_match_expiry_and_paths(self):
        log = os.path.join(self.b.tmp, 'telemetry', 'events.log')
        open(log, 'w').write('2026 HEARTBEAT ok\n')
        m = self.ok('monitor_add', kind='log_match', params={'path': log, 'pattern': 'FAULT'}, ttl_s=2)
        open(log, 'a').write('2026 FAULT GPU0 junction 99\n')
        alarm = wait_for(lambda: [a for a in self.ok('alarms')['pending'] if a['monitor'] == m['id']], timeout=10)
        self.assertIn('FAULT GPU0', alarm[0]['message'])
        self.ok('alarms', ack=[alarm[0]['id']])
        self.assertTrue(wait_for(lambda: m['id'] not in [x['id'] for x in self.ok('monitor_list')['monitors']], timeout=10))
        e = self.refused('REQUIRES_AUTHORIZATION', 'monitor_add', kind='log_match', params={'path': os.path.expanduser('~/.ssh/id_ed25519'), 'pattern': '.'})
        self.assertIn('monitor_paths', e['remediation'])

    def test_log_match_alarms_are_rate_limited(self):
        log = os.path.join(self.b.tmp, 'telemetry', 'flood.log')
        open(log, 'w').close()
        m = self.ok('monitor_add', kind='log_match', params={'path': log, 'pattern': 'FAILED', 'min_interval_s': 3}, ttl_s=60)
        mine = lambda: [a for a in hostlib.read_json(os.path.join(self.b.env['MINA_HOST_STATE'], 'alarms.json'), {}).values() if a['monitor'] == m['id']]
        for _ in range(6):                                                          # a line every 0.4 s, like the watchdog's
            open(log, 'a').write('ENFORCEMENT_FAILED again\n'); time.sleep(0.4)
        self.assertEqual(len(mine()), 1, mine())
        open(log, 'a').write('ENFORCEMENT_FAILED later\n')
        later = wait_for(lambda: len(mine()) == 2 and mine(), timeout=8)
        self.assertTrue(later)
        self.assertTrue(any(re.search('more.*since the last alarm', a['message']) for a in later), later)
        self.ok('alarms', ack=[a['id'] for a in later])
        self.ok('monitor_remove', id=m['id'])

    def test_short_run_end_alarm_is_dropped_only_if_the_agent_read_the_result(self):
        mine = lambda w: [a for a in self.ok('alarms')['pending'] if a['monitor'] == w['monitor']]
        seen = self.ok('workload_run', workload='ok')                               # ends in about a second
        self.assertEqual(self.wait_end(seen['id'])['state'], 'exited')             # the agent reads the result
        time.sleep(4.5)
        self.assertFalse(mine(seen))                                                # so no alarm
        unseen = self.ok('workload_run', workload='ok')                             # the agent waits instead (goal_wait)
        alarm = wait_for(lambda: mine(unseen), timeout=15)
        self.assertTrue(alarm, 'an agent waiting for the end gets the alarm')
        self.ok('alarms', ack=[a['id'] for a in alarm])
        w = seen
        m = self.ok('monitor_add', kind='workload', params={'id': w['id']}, ttl_s=60)  # an explicit monitor still reports it
        alarm = wait_for(lambda: [a for a in self.ok('alarms')['pending'] if a['monitor'] == m['id']], timeout=15)
        self.assertIn('ended: exited', alarm[0]['message'])
        self.ok('alarms', ack=[a['id'] for a in alarm])

    def test_budget_survives_client_replacement_and_capability_cache_is_instance_scoped(self):
        cfg = json.loads(json.dumps(self.cfg))
        cfg['instance_budget'] = {'max_admissions': 1, 'max_reserved_s': 2}
        cfg['workloads']['budget-fixture'] = {'argv': ['true'], 'resources': [], 'max_s': 1}
        self.b.config(cfg)
        grant = self.b.open_session()
        grant_file = os.path.join(self.b.tmp, 'budget-client-grant')
        with open(grant_file, 'w') as f:
            f.write(grant)
        def client():
            r = subprocess.run(['node', os.path.join(HERE, 'client_fixture.mjs'), self.b.sock, grant_file, self.b.project],
                               input=json.dumps({'action': 'workload_run', 'workload': 'budget-fixture'}),
                               capture_output=True, text=True, timeout=30)
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.loads(r.stdout)['result']
        try:
            first = client()
            self.assertFalse(first['isError'], first)
            self.assertEqual(first['details']['result']['admission']['instance_used']['admissions'], 1)
            second = client()  # same native tool identity after client replacement is now an observation
            self.assertFalse(second['isError'], second)
            self.assertTrue(second['details']['result']['replayed'])
            self.assertEqual(second['details']['result']['id'], first['details']['result']['id'])
            fresh_request = self.b.raw({'op': 'mutate_v2', 'request_protocol': hostd.REQUEST_PROTOCOL,
                                        'grant': grant, 'action': 'workload_run',
                                        'args': {'workload': 'budget-fixture', 'request_id': 'new-after-replacement'}})
            self.assertFalse(fresh_request['ok'])
            self.assertTrue(fresh_request['error']['budget_exhausted'])
            denied = self.b.raw({'op': 'mutate_v1', 'grant': grant, 'action': 'workload_run', 'args': {'workload': 'budget-fixture'}})
            self.assertFalse(denied['ok'], 'older wire envelopes cannot bypass the native budget')
            caps = self.b.raw({'op': 'capabilities', 'grant': grant})['result']
            cap = next(c for c in caps['capabilities'] if c['capability'] == 'workload:budget-fixture')
            self.assertTrue(cap['budget_limited'])
            self.assertEqual(caps['admission_budget']['used']['admissions'], 1)
            fresh = self.b.open_session()
            other = self.b.raw({'op': 'capabilities', 'grant': fresh})['result']
            self.assertEqual(other['admission_budget']['used']['admissions'], 0)
            cap = next(c for c in other['capabilities'] if c['capability'] == 'workload:budget-fixture')
            self.assertEqual(cap['status'], 'AVAILABLE', 'another instance must not inherit cached exhaustion')
        finally:
            self.b.config(self.cfg)
            os.unlink(grant_file)

    def test_budgeted_session_is_blocked_after_real_broker_restart_instead_of_reset(self):
        b = Broker()
        try:
            b.config({'classes': {'observe': 'allow', 'workload': 'allow'},
                      'instance_budget': {'max_admissions': 2},
                      'workloads': {'budgeted': {'argv': ['true'], 'max_s': 1}}})
            b.start()
            grant = b.open_session()
            self.assertTrue(b.raw({'op': 'workload_run', 'grant': grant, 'workload': 'budgeted'})['ok'])
            b.stop(); b.start()
            status = b.raw({'op': 'workload_budget', 'grant': grant})['result']
            self.assertEqual(status['coverage'], 'unknown')
            self.assertIsNone(status['remaining']['admissions'])
            out = b.raw({'op': 'workload_run', 'grant': grant, 'workload': 'budgeted'})
            self.assertFalse(out['ok'])
            self.assertEqual(out['error']['code'], 'BLOCKED')
        finally:
            b.cleanup()

    def test_native_client_and_real_broker_complete_a_bound_confirmation(self):
        cfg = json.loads(json.dumps(self.cfg))
        cfg['classes']['monitor'] = 'ask'
        grant_file = os.path.join(self.b.tmp, 'native-client-grant')
        with open(grant_file, 'w') as f:
            f.write(self.grant)
        self.b.config(cfg)
        mid = None
        try:
            r = subprocess.run(['node', os.path.join(HERE, 'client_fixture.mjs'), self.b.sock, grant_file, self.b.project],
                               input=json.dumps({'action': 'monitor_add', 'kind': 'unit_active', 'params': {'service': 'canary'},
                                                 'label': 'native-client-fixture', 'ttl_s': 5}),
                               capture_output=True, text=True, timeout=30)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(out['confirmations'], 1)
            self.assertFalse(out['result']['isError'], out)
            mid = out['result']['details']['result']['id']
            self.assertEqual(out['result']['details']['result']['label'], 'native-client-fixture')
        finally:
            self.b.config(self.cfg)
            if mid:
                self.call('monitor_remove', id=mid)
            os.unlink(grant_file)

    def test_audit_log_records_without_grants_or_confirmation_tokens(self):
        self.ok('service_status', service='canary')
        e = self.refused('REQUIRES_AUTHORIZATION', 'service_restart', service='canary_ask')
        token = e['approval_request']['challenge']
        self.refused('REQUIRES_AUTHORIZATION', 'service_restart', service='canary_ask', changed=True,
                     approval={'granted': True, 'challenge': token})
        with open(os.path.join(self.b.env['MINA_HOST_STATE'], 'audit.jsonl')) as f:
            text = f.read()
        self.assertIn('"service_status"', text)
        self.assertNotIn(self.grant, text)
        self.assertNotIn(token, text)
        self.assertIn(hashlib.sha256(token.encode()).hexdigest()[:24], text)


@unittest.skipUnless(SYSTEMD_USER, NEEDS_SYSTEMD)
class MachineResourceTest(unittest.TestCase):
    """Machine-level resources: one lock protocol for every project on this machine. Temporary lock files only."""

    def setUp(self):
        self.b = b = Broker()
        self.addCleanup(b.cleanup)
        self.other = os.path.join(b.tmp, 'other-project')
        os.makedirs(self.other)
        L = b.locks
        self.gpu = f'{L}/GPU_M.lock'
        self.turn = f'{L}/GPU_M.turn'
        self.first = f'{L}/FIRST.lock'
        self.own = f'{L}/OWN_GPU.lock'
        self.lockout = f'{b.tmp}/lockout/GPU_M'
        self.ran = os.path.join(b.tmp, 'waiter-ran')
        gpu_entry = {'path': self.gpu, 'turnstile': self.turn}
        self.machine = {'GPU': {'locks': [gpu_entry], 'lockouts': [self.lockout]},
                        'PAIR': {'locks': [{'path': self.first}, gpu_entry]}}
        classes = {'observe': 'allow', 'reserve': 'allow', 'workload': 'allow', 'monitor': 'allow'}
        self.cfg = {'version': 1, 'resources': self.machine, 'projects': {
            b.project: {'classes': classes, 'workloads': {
                'hold': {'argv': ['sleep', '300'], 'resources': ['GPU'], 'max_s': 300},
                'quick': {'argv': ['true'], 'resources': ['GPU'], 'max_s': 30}}},
            self.other: {'classes': classes, 'workloads': {
                'quick': {'argv': ['true'], 'resources': ['GPU'], 'max_s': 30},
                'wait': {'argv': ['touch', self.ran], 'resources': ['GPU'], 'max_s': 30, 'queue_s': 60},
                'wait-pair': {'argv': ['true'], 'resources': ['PAIR'], 'max_s': 30, 'queue_s': 60},
                'short-wait': {'argv': ['touch', self.ran], 'resources': ['PAIR'], 'max_s': 30, 'queue_s': 2}}}}}
        self.write()
        b.start()
        self.grant_a = b.open_session()
        self.grant_b = b.open_session(self.other)

    def write(self):
        hostlib.write_json(self.b.env['MINA_HOST_CONFIG'], self.cfg)

    def call(self, grant, op, **kw):
        return self.b.raw({'op': op, 'grant': grant, **kw})

    def ok(self, grant, op, **kw):
        out = self.call(grant, op, **kw)
        self.assertTrue(out['ok'], out)
        return out['result']

    def end(self, grant, wid, timeout=30):
        live = ('launching', 'starting', 'queued', 'running')
        return wait_for(lambda: (lambda s: s if s['state'] not in live else None)(self.ok(grant, 'workload_status', id=wid)), timeout=timeout)

    def test_machine_resource_is_shared_by_two_projects(self):
        for grant in (self.grant_a, self.grant_b):
            caps = {c['capability']: c for c in self.ok(grant, 'capabilities', refresh=True)['capabilities']}
            self.assertEqual(caps['resource:GPU']['status'], 'AVAILABLE')
            self.assertEqual(caps['resource:GPU']['source'], 'machine')
        w = self.ok(self.grant_a, 'workload_run', workload='hold')
        self.assertTrue(wait_for(lambda: self.ok(self.grant_a, 'workload_status', id=w['id'])['state'] == 'running'))
        try:
            e = self.call(self.grant_b, 'reserve', resources=['GPU'])['error']
            self.assertEqual(e['code'], 'CONFLICT', e)
            self.assertEqual(e['evidence']['lock'], self.gpu)
            self.assertTrue(any('lockrun.py' in ' '.join(h['argv']) for h in e['evidence']['holders']), e)
            b_run = self.ok(self.grant_b, 'workload_run', workload='quick')                           # queue_s 0: no wait
            self.assertEqual(self.end(self.grant_b, b_run['id'])['state'], 'conflict')
        finally:
            self.ok(self.grant_a, 'workload_stop', id=w['id'])
        self.assertTrue(free(self.gpu))
        r = self.ok(self.grant_b, 'reserve', resources=['GPU'], ttl_s=30)
        self.assertFalse(free(self.gpu))
        self.ok(self.grant_b, 'release', reservation=r['reservation'])
        self.assertTrue(free(self.gpu))

    def queued(self, grant, wid):
        return wait_for(lambda: (lambda s: s if s['state'] == 'queued' else None)(self.ok(grant, 'workload_status', id=wid)))

    def test_a_waiting_workload_holds_its_place_and_runs_after_the_release(self):
        w = self.ok(self.grant_a, 'workload_run', workload='hold')
        self.assertTrue(wait_for(lambda: self.ok(self.grant_a, 'workload_status', id=w['id'])['state'] == 'running'))
        try:
            waiter = self.ok(self.grant_b, 'workload_run', workload='wait')
            q = self.queued(self.grant_b, waiter['id'])
            self.assertTrue(q, 'workload_status shows queued')
            self.assertEqual(q['waiting_for']['lock'], self.gpu)
            self.assertTrue(any('lockrun.py' in ' '.join(h['argv']) and not h['waiting'] for h in q['waiting_for']['holders']), q)
            self.assertFalse(free(self.turn), 'the waiter holds the turnstile while it waits')
            self.assertEqual(self.call(self.grant_a, 'reserve', resources=['GPU'])['error']['code'], 'CONFLICT')   # no jumping the queue
            time.sleep(1.5)                                                                     # several broker ticks
            self.assertEqual(self.ok(self.grant_b, 'workload_status', id=waiter['id'])['state'], 'queued')
            self.assertFalse([a for a in self.ok(self.grant_b, 'alarms')['pending'] if a['monitor'] == waiter['monitor']],
                             'a queued workload has not ended')
            self.assertFalse(os.path.exists(self.ran))
        finally:
            self.ok(self.grant_a, 'workload_stop', id=w['id'])
        end = self.end(self.grant_b, waiter['id'])
        self.assertEqual(end['state'], 'exited', end)
        self.assertTrue(end['verification']['verified_exit'])
        self.assertTrue(os.path.exists(self.ran))
        self.assertTrue(free(self.gpu) and free(self.turn))

    def test_the_end_of_queue_s_is_a_conflict_that_releases_every_lock(self):
        holder = flock_holder(self.gpu)
        try:
            w = self.ok(self.grant_b, 'workload_run', workload='short-wait')
            end = self.end(self.grant_b, w['id'])
            self.assertEqual(end['state'], 'conflict', end)
            evidence = end['result']['evidence']
            self.assertEqual(evidence['lock'], self.gpu)
            self.assertIn(holder.pid, [h['pid'] for h in evidence['holders']])
            self.assertGreaterEqual(evidence['waited_s'], 1.5)
            self.assertIn('queue_s', evidence['why'])
            self.assertFalse(os.path.exists(self.ran))
            self.assertTrue(free(self.first), 'the lock taken before the wait is released')
            self.assertTrue(free(self.turn), 'the turnstile is released')
        finally:
            holder.kill(); holder.wait()

    def test_workload_stop_stops_a_queued_job_and_releases_what_it_holds(self):
        holder = flock_holder(self.gpu)
        try:
            w = self.ok(self.grant_b, 'workload_run', workload='wait-pair')
            self.assertTrue(self.queued(self.grant_b, w['id']))
            self.assertFalse(free(self.first))
            s = self.ok(self.grant_b, 'workload_stop', id=w['id'])
            self.assertEqual(s['state'], 'stopped', s)
            self.assertTrue(s['verification']['verified_exit'])
            self.assertTrue(free(self.first) and free(self.turn))
        finally:
            holder.kill(); holder.wait()

    def test_the_recheck_runs_after_a_wait(self):
        holder = flock_holder(self.gpu)
        try:
            w = self.ok(self.grant_b, 'workload_run', workload='wait')
            self.assertTrue(self.queued(self.grant_b, w['id']))
            put(self.lockout, 'fault while queued')
        finally:
            holder.kill(); holder.wait()
        end = self.end(self.grant_b, w['id'])
        self.assertEqual(end['state'], 'blocked', end)
        self.assertEqual(end['result']['problems'][0]['kind'], 'lockout')
        self.assertFalse(os.path.exists(self.ran))
        self.assertTrue(free(self.gpu))

    def test_project_resource_with_the_same_name_replaces_the_machine_one(self):
        self.cfg['projects'][self.other]['resources'] = {'GPU': {'locks': [{'path': self.own}]}}
        self.write()
        caps = {c['capability']: c for c in self.ok(self.grant_b, 'capabilities', refresh=True)['capabilities']}
        self.assertEqual(caps['resource:GPU']['source'], 'project')
        self.assertIn(self.own, caps['resource:GPU']['detail'])
        self.assertNotIn(self.gpu, caps['resource:GPU']['detail'])
        holder = flock_holder(self.gpu)                                    # the machine lock is busy
        try:
            r = self.ok(self.grant_b, 'reserve', resources=['GPU'], ttl_s=30)    # the project's own lock is not
            self.assertEqual(r['locks'], [self.own])
            self.assertFalse(free(self.own))
            self.ok(self.grant_b, 'release', reservation=r['reservation'])
            self.assertEqual(self.call(self.grant_a, 'reserve', resources=['GPU'])['error']['code'], 'CONFLICT')
        finally:
            holder.kill(); holder.wait()
        caps = {c['capability']: c for c in self.ok(self.grant_a, 'capabilities', refresh=True)['capabilities']}
        self.assertEqual(caps['resource:GPU']['source'], 'machine')


class DefaultsResolutionTest(unittest.TestCase):
    """Which folders get the defaults, without a broker. HOME and the policy file are temporary."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='mina-defaults-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, 'home')
        self.work = os.path.join(self.home, 'work')
        for d in ('work/a/deep', '.config/mina', '.ssh/x', 'elsewhere'):
            os.makedirs(os.path.join(self.home, d))
        os.symlink(self.work, os.path.join(self.tmp, 'link-to-work'))
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.dict(os.environ, {'HOME': self.home}))
        self.config = os.path.join(self.tmp, 'host.json')
        stack.enter_context(patch.object(hostd, 'CONFIG', self.config))

    def source(self, project, roots, projects=None, **extra):
        hostlib.write_json(self.config, {'version': 1, 'projects': projects or {},
                                         'defaults': {'roots': roots, 'classes': {'workload': 'ask'}, **extra}})
        return hostd.policy_source(os.path.realpath(project))

    def test_only_strictly_inside_a_root(self):
        a = os.path.join(self.work, 'a')
        self.assertEqual(self.source(a, ['~/work']), 'defaults')                         # ~ expanded
        self.assertEqual(self.source(os.path.join(a, 'deep'), [self.work]), 'defaults')
        self.assertEqual(self.source(a, [os.path.join(self.tmp, 'link-to-work')]), 'defaults')   # roots are realpath'd
        self.assertIsNone(self.source(self.work, ['~/work']), 'never for a root itself')
        self.assertIsNone(self.source(os.path.join(self.home, 'elsewhere'), ['~/work']), 'outside the roots')
        self.assertIsNone(self.source(self.work + '-sibling', ['~/work']), 'a name prefix is not a subfolder')
        self.assertIsNone(self.source(self.home, [self.tmp]), 'never for $HOME')
        self.assertIsNone(self.source('/', ['/']), 'never for /')
        self.assertIsNone(self.source(a, ['/']), 'a root of / is ignored')
        self.assertIsNone(self.source(a, ['work']), 'a relative root is ignored')
        self.assertIsNone(self.source(a, '~/work'), 'roots must be a list')
        self.assertIsNone(self.source(os.path.join(self.home, '.config', 'mina'), ['~']), "never for mina's configuration")
        self.assertIsNone(self.source(os.path.join(self.home, '.ssh', 'x'), ['~']), 'never inside a credential folder')
        self.assertEqual(self.source(os.path.join(self.home, 'elsewhere'), ['~']), 'defaults')

    def test_a_registered_project_never_gets_the_defaults(self):
        a = os.path.join(self.work, 'a')
        self.assertEqual(self.source(a, ['~/work'], projects={a: {'classes': {}}}), 'project')
        policy = hostd.project_config(a)
        self.assertEqual(policy['classes'], {}, 'no merging with the defaults')

    def test_services_and_roots_are_not_part_of_the_policy(self):
        a = os.path.join(self.work, 'a')
        self.source(a, ['~/work'], services={'svc': {'unit': 'x.service'}}, max_reserve_s=60,
                    resources={'BUILD': {'locks': []}})
        policy = hostd.project_config(a)
        self.assertNotIn('services', policy)
        self.assertNotIn('roots', policy)
        self.assertEqual(policy['max_reserve_s'], 60)
        self.assertEqual(hostd.resource_origins(a), {'BUILD': 'defaults'})
        with self.assertRaises(hostd.Refusal) as cm:
            hostd.service_config(a, 'svc')
        self.assertEqual(cm.exception.code, 'REQUIRES_AUTHORIZATION')
        self.assertIn('defaults.', hostd.snippet(a, 'classes.workload', 'allow'))


@unittest.skipUnless(SYSTEMD_USER, NEEDS_SYSTEMD)
class DefaultsBrokerTest(unittest.TestCase):
    """An unregistered project under a root of "defaults" gets the template, with {project} expanded for it."""

    def setUp(self):
        self.b = b = Broker()
        self.addCleanup(b.cleanup)
        self.root = os.path.join(b.tmp, 'work')
        self.proj = os.path.join(self.root, 'proj')
        self.registered = os.path.join(self.root, 'registered')
        self.outside = os.path.join(b.tmp, 'outside')
        for d in (self.proj, self.registered, self.outside):
            os.makedirs(d)
        put(os.path.join(self.proj, 'tool.sh'), 'echo tool-ran\n')
        self.tool_sha = hashlib.sha256(b'echo tool-ran\n').hexdigest()
        self.gpu = f'{b.locks}/GPU_D.lock'
        self.cfg = {'version': 1,
                    'resources': {'GPU': {'locks': [{'path': self.gpu}]}},
                    'projects': {self.registered: {'classes': {'observe': 'allow'}}},
                    'defaults': {
                        'roots': [self.root],
                        'classes': {'observe': 'allow', 'reserve': 'allow', 'workload': 'allow'},
                        'services': {'svc': {'unit': 'never-real.service'}},
                        'workloads': {
                            'where': {'argv': ['sh', '-c', 'echo at={project} > {project}/where.out'], 'max_s': 30},
                            'tool': {'argv': ['sh', '{project}/tool.sh'], 'max_s': 30, 'pin': {'{project}/tool.sh': self.tool_sha}},
                            'gpu-cell': {'argv': ['{command}'], 'resources': ['GPU'], 'max_s': 30,
                                         'sandbox': {'write': ['{project}'], 'network': 'offline'}}}}}
        hostlib.write_json(b.env['MINA_HOST_CONFIG'], self.cfg)
        b.start()

    def end(self, grant, wid):
        live = ('launching', 'starting', 'queued', 'running')
        return wait_for(lambda: (lambda s: s if s['state'] not in live else None)(
            self.b.raw({'op': 'workload_status', 'grant': grant, 'id': wid})['result']), timeout=30)

    def test_session_and_capabilities_name_the_policy_source(self):
        opened = self.b.open_session(self.proj, full=True)
        self.assertEqual((opened['registered'], opened['policy_source']), (True, 'defaults'))
        caps = self.b.raw({'op': 'capabilities', 'grant': opened['grant'], 'refresh': True})['result']
        self.assertEqual(caps['policy_source'], 'defaults')
        by = {c['capability']: c for c in caps['capabilities']}
        self.assertEqual(by['resource:GPU']['source'], 'machine')
        self.assertEqual(by['services']['status'], 'BLOCKED', 'services in the defaults are ignored, and the agent is told')
        self.assertFalse([c for c in by if c.startswith('service:')])
        self.assertEqual(self.b.raw({'op': 'service_status', 'grant': opened['grant'], 'service': 'svc'})['error']['code'],
                         'REQUIRES_AUTHORIZATION')
        mine = self.b.open_session(self.registered, full=True)
        self.assertEqual((mine['registered'], mine['policy_source']), (True, 'project'))
        caps = self.b.raw({'op': 'capabilities', 'grant': mine['grant'], 'refresh': True})['result']
        self.assertEqual(caps['policy_source'], 'project')
        self.assertFalse([c for c in caps['capabilities'] if c['capability'].startswith('workload:')], 'no merging')
        for project in (self.root, self.outside, os.path.expanduser('~'), '/'):
            with self.subTest(project=project):
                opened = self.b.open_session(project, full=True)
                self.assertEqual((opened['registered'], opened['policy_source']), (False, None))
                out = self.b.raw({'op': 'workload_run', 'grant': opened['grant'], 'workload': 'where'})
                self.assertEqual(out['error']['code'], 'REQUIRES_AUTHORIZATION')

    def test_project_placeholders_expand_and_audit_names_the_defaults(self):
        grant = self.b.open_session(self.proj)
        w = self.b.raw({'op': 'workload_run', 'grant': grant, 'workload': 'where'})['result']
        self.assertEqual(self.end(grant, w['id'])['state'], 'exited')
        with open(os.path.join(self.proj, 'where.out')) as f:
            self.assertEqual(f.read().strip(), f'at={self.proj}')
        w = self.b.raw({'op': 'workload_run', 'grant': grant, 'workload': 'tool'})['result']   # a {project} pin
        end = self.end(grant, w['id'])
        self.assertEqual(end['state'], 'exited', end)
        self.assertIn('tool-ran', end['output_tail'])
        put(os.path.join(self.proj, 'tool.sh'), 'echo changed\n')
        e = self.b.raw({'op': 'workload_run', 'grant': grant, 'workload': 'tool'})['error']
        self.assertEqual(e['code'], 'BLOCKED')
        self.assertIn('defaults.workloads.tool.pin["{project}/tool.sh"]', e['remediation'])
        with open(os.path.join(self.b.env['MINA_HOST_STATE'], 'audit.jsonl')) as f:
            records = [json.loads(line) for line in f]
        mine = [r for r in records if r.get('project') == self.proj]
        self.assertTrue({'session_open', 'workload_admission', 'workload_end', 'workload_run'} <= {r['op'] for r in mine}, mine)
        self.assertTrue(all(r.get('policy_source') == 'defaults' for r in mine), mine)
        self.assertFalse([r for r in records if r.get('policy_source') and r.get('project') != self.proj])

    @unittest.skipUnless(BWRAP, NEEDS_BWRAP)
    def test_command_sandbox_writes_the_project(self):
        grant = self.b.open_session(self.proj)
        w = self.b.raw({'op': 'workload_run', 'grant': grant, 'workload': 'gpu-cell',
                        'command': ['sh', '-c', 'pwd; touch made-in-sandbox']})['result']
        end = self.end(grant, w['id'])
        self.assertEqual(end['state'], 'exited', end)
        self.assertIn(self.proj, end['output_tail'])
        self.assertTrue(os.path.exists(os.path.join(self.proj, 'made-in-sandbox')))
        self.assertTrue(free(self.gpu))

    def test_launcher_opens_a_session_for_a_defaults_project(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node is not installed')
        runtime, cwd = os.path.join(self.b.tmp, 'xdg'), os.path.join(self.b.tmp, 'node-cwd')   # mina.mjs examines its cwd on import
        os.makedirs(runtime); os.makedirs(cwd)
        env = {'MINA_HOSTD_RUNTIME': os.path.dirname(self.b.sock), 'XDG_RUNTIME_DIR': runtime,
               'MINA_HOST_CONFIG': self.b.env['MINA_HOST_CONFIG']}
        script = ("const m = await import(process.argv[1]); const out = {};"
                  "for (const p of process.argv.slice(2)) out[p] = await m.openHostSession(p, JSON.parse(process.env.FIXTURE_ENV));"
                  "process.stdout.write(`\\nFIXTURE ${JSON.stringify(out)}\\n`); process.exit(0);")
        r = subprocess.run([node, '--input-type=module', '-e', script, os.path.join(hostd.REPO, 'bin', 'mina.mjs'), self.proj, self.outside],
                           env={**os.environ, 'FIXTURE_ENV': json.dumps(env)}, cwd=cwd, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(next(line for line in r.stdout.splitlines() if line.startswith('FIXTURE '))[8:])
        self.assertTrue(out[self.proj] and out[self.proj]['grantFile'], out)
        self.assertIsNone(out[self.outside], 'an unregistered project outside the roots gets no host session')


class WorkloadSandboxPolicyTest(unittest.TestCase):
    """The workload command sandbox's hidden paths and network, and the broker's private state, without a broker."""

    def setUp(self):
        self.home = os.path.realpath(tempfile.mkdtemp(prefix='mina-hostd-home-'))
        self.addCleanup(shutil.rmtree, self.home, True)
        self.agent = os.path.join(self.home, '.pi', 'agent')
        os.makedirs(self.agent)
        for d in ('.ssh', '.claude', '.claude-second', 'accounts/work', '.config/mina/keys', 'project'):
            os.makedirs(os.path.join(self.home, d))
        put(os.path.join(self.home, '.claude.json'), '{}')
        put(os.path.join(self.home, '.claude.json.backup'), '{}')
        with open(os.path.join(self.agent, 'claude-sdk.json'), 'w') as f:
            json.dump({'profiles': [{'id': 'work', 'name': 'Work', 'configDir': os.path.join(self.home, 'accounts/work')}]}, f)
        self.env = {'HOME': self.home, 'PATH': os.environ.get('PATH', '/usr/bin:/bin')}

    def sandbox(self, sb=None, **env):
        with patch.dict(os.environ, {**self.env, **env}, clear=True):
            return hostd.command_sandbox(os.path.join(self.home, 'project'), sb or {})

    def test_hidden_paths_match_the_agent_sandbox(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node is not installed')
        script = ("import('./sandbox/sandbox.mjs').then((m) => process.stdout.write(JSON.stringify("
                  "m.defaultHidden(process.argv[1], { PI_CODING_AGENT_DIR: process.argv[2] }))))")
        r = subprocess.run([node, '--input-type=module', '-e', script, self.home, self.agent], cwd=hostd.REPO,
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        js = json.loads(r.stdout)
        py = hostd.default_hidden(self.home, {'PI_CODING_AGENT_DIR': self.agent})
        self.assertEqual(sorted(set(py)), sorted(set(js)))
        for p in ('.claude', '.claude.json', '.claude-second', '.claude.json.backup', 'accounts/work', '.config/mina/keys', '.ssh'):
            self.assertIn(os.path.join(self.home, p), py)

    def test_workload_sandbox_hides_mina_and_owner_paths(self):
        legacy = os.path.join(self.home, '.config', 'old-tool')
        os.makedirs(legacy)
        with open(os.path.join(self.home, 'sandbox.json'), 'w') as f:
            json.dump({'hide': ['~/.config/old-tool']}, f)
        a = self.sandbox(MINA_SANDBOX_CONFIG=os.path.join(self.home, 'sandbox.json'), PI_CODING_AGENT_DIR=self.agent)
        hidden = {a[i + 1] for i, x in enumerate(a) if x == '--tmpfs'} | {a[i + 2] for i, x in enumerate(a) if x == '--ro-bind' and a[i + 1] == '/dev/null'}
        for p in ('.ssh', '.claude', '.claude-second', '.claude.json', '.claude.json.backup', 'accounts/work', '.config/old-tool', '.config/mina'):
            self.assertIn(os.path.join(self.home, p), hidden, p)
        # The owner's "hide" list comes from ~/.config/mina/sandbox.json by default.
        os.replace(os.path.join(self.home, 'sandbox.json'), os.path.join(self.home, '.config', 'mina', 'sandbox.json'))
        a = self.sandbox(PI_CODING_AGENT_DIR=self.agent)
        self.assertIn(legacy, a)
        # A configuration mina cannot read is not guessed around.
        put(os.path.join(self.home, '.config', 'mina', 'sandbox.json'), '{')
        with self.assertRaises(hostd.Refusal) as e:
            self.sandbox(PI_CODING_AGENT_DIR=self.agent)
        self.assertEqual(e.exception.code, 'BLOCKED')

    def test_workload_network_is_offline_unless_open(self):
        self.assertIn('--unshare-net', self.sandbox({}))
        self.assertIn('--unshare-net', self.sandbox({'network': 'offline'}))
        self.assertNotIn('--unshare-net', self.sandbox({'network': 'open'}))
        with self.assertRaises(hostd.Refusal) as e:
            self.sandbox({'network': 'packages'})
        self.assertEqual(e.exception.code, 'INVALID')

    def test_state_dir_and_audit_log_are_private(self):
        state = os.path.join(self.home, 'state')
        os.makedirs(state, mode=0o755)
        os.chmod(state, 0o755)
        log = os.path.join(state, 'audit.jsonl')
        put(log, '')
        os.chmod(log, 0o644)
        with patch.object(hostd, 'STATE', state):
            hostd.audit({'op': 'test'})
        self.assertEqual(os.stat(state).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(log).st_mode & 0o777, 0o600)
        fresh = os.path.join(self.home, 'fresh', 'state')
        with patch.object(hostd, 'STATE', fresh):
            hostd.audit({'op': 'test'})
        self.assertEqual(os.stat(fresh).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(os.path.join(fresh, 'audit.jsonl')).st_mode & 0o777, 0o600)
        with open(os.path.join(fresh, 'audit.jsonl')) as f:
            self.assertEqual(json.loads(f.read())['op'], 'test')
        # Never through a symlink planted in place of the log.
        os.unlink(log); os.symlink(os.path.join(self.home, 'elsewhere'), log)
        with patch.object(hostd, 'STATE', state), self.assertRaises(OSError):
            hostd.audit({'op': 'test'})
        self.assertFalse(os.path.exists(os.path.join(self.home, 'elsewhere')))


if __name__ == '__main__':
    unittest.main()
