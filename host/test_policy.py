#!/usr/bin/env python3
"""Tests of the host policy (host/policy.py) and of the broker's policy_propose and inventory operations.

Every test uses its own temporary policy file, state folder and lock files; nothing touches an installed broker or
~/.config/mina. Device inventories use fixtures (a fake nvidia-smi and a fake KFD topology), never real GPUs.
Run: python3 -I host/test_policy.py -v
"""
import hashlib
import json
import os
import re
import shutil
import signal
import stat
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
import policy as P  # noqa: E402
from test_hostd import Broker, wait_for  # noqa: E402

SHA = 'a' * 64


def rb(path):
    with open(path, 'rb') as f:
        return f.read()


def put_text(path, text):
    with open(path, 'w') as f:
        f.write(text)


def lock(path, **kw):
    return {'path': path, **kw}


def good_config(tmp):
    return {
        'version': 1,
        'resources': {
            'GPU_A': {'locks': [lock(f'{tmp}/locks/GPU_A.lock', turnstile=f'{tmp}/locks/GPU_A.turn')],
                      'lockouts': [f'{tmp}/lockout-A'], 'device': {'nvidia': ['00000000:01:00.0']}},
            'QUIET': {'locks': [lock(f'{tmp}/locks/QUIET.lock')]},
            'BUILD': {'locks': [lock(f'{tmp}/locks/QUIET.lock', mode='shared')]},
        },
        'projects': {
            f'{tmp}/p1': {
                'classes': {'observe': 'allow', 'workload': 'ask', 'restart': 'ask'},
                'services': {'wd': {'unit': 'wd.service', 'restart': 'ask', 'sources': ['wd.py'],
                                    'restart_requires_idle': ['GPU_A'],
                                    'health': {'log': f'{tmp}/wd.log', 'pattern': 'START pid={pid} ', 'timeout_s': 30}}},
                'resources': {'GPU_A': {'locks': [lock(f'{tmp}/locks/GPU_A.lock')], 'requires_active': ['wd.service'],
                                        'lockouts': [f'{tmp}/lockout-A', f'{tmp}/lockout-A2'], 'device': {'kfd': True}}},
                'workloads': {
                    'smoke': {'argv': ['/usr/bin/true'], 'resources': ['GPU_A'], 'max_s': 60,
                              'pin': {'{project}/run.py': SHA}},
                    'cell': {'argv': ['{command}'], 'resources': ['QUIET', 'GPU_A'], 'max_s': 3600, 'queue_s': 900,
                             'params': {'exp': '^[a-z]{1,9}$'}, 'sandbox': {'write': ['{project}'], 'network': 'offline'},
                             'requires_fresh': ['wd'], 'env': {'X': '{exp}'}, 'instance_budget': {'max_admissions': 3}},
                },
                'monitor_paths': [f'{tmp}/logs'], 'max_monitors': 5,
            },
        },
        'defaults': {'roots': [f'{tmp}/work'], 'classes': {'workload': 'ask'},
                     'workloads': {'build': {'argv': ['{command}'], 'resources': ['BUILD'], 'max_s': 1800,
                                             'sandbox': {'write': ['{project}'], 'network': 'offline'}}}},
        'alarm_command': ['/usr/bin/true'],
    }


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='mina-policy-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        for d in ('p1', 'work/q', 'work/r', 'locks', 'logs', 'other'):
            os.makedirs(os.path.join(self.tmp, d))
        self.cfg = good_config(self.tmp)


class ValidateTest(Tmp):
    def errors(self, mutate):
        cfg = json.loads(json.dumps(self.cfg))
        mutate(cfg)
        return P.validate(cfg)

    def test_a_good_policy_with_machine_resources_defaults_and_modes(self):
        errors, warnings = P.check(self.cfg)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_each_bad_field_is_an_error_at_its_path(self):
        p = f'{self.tmp}/p1'
        cases = {
            'version': (lambda c: c.update(version=2), r'^version: must be 1'),
            'mode': (lambda c: c['resources']['BUILD']['locks'][0].update(mode='weird'), r'resources\.BUILD\.locks\[0\]\.mode: mode must be'),
            'relative lock': (lambda c: c['resources']['QUIET']['locks'][0].update(path='rel.lock'), r'QUIET\.locks\[0\]\.path: must be an absolute path'),
            'no lock path': (lambda c: c['resources']['QUIET']['locks'][0].pop('path'), r'QUIET\.locks\[0\]: needs "path"'),
            'device kind': (lambda c: c['resources']['GPU_A'].update(device={'cuda': [0]}), r'device\.cuda: unknown device kind'),
            'kfd': (lambda c: c['resources']['GPU_A'].update(device={'kfd': 1}), r'device\.kfd: must be true'),
            'lockouts': (lambda c: c['resources']['GPU_A'].update(lockouts='x'), r'lockouts: must be a list'),
            'argv': (lambda c: c['projects'][p]['workloads']['smoke'].pop('argv'), r'workloads\.smoke\.argv: needs a nonempty list'),
            'pattern': (lambda c: c['projects'][p]['workloads']['cell']['params'].update(exp='(['), r'params\.exp: the pattern does not compile'),
            'max_s': (lambda c: c['projects'][p]['workloads']['smoke'].update(max_s=0), r'smoke\.max_s: max_s must be a positive integer'),
            'max_s bool': (lambda c: c['projects'][p]['workloads']['smoke'].update(max_s=True), r'smoke\.max_s: max_s must be'),
            'queue_s': (lambda c: c['projects'][p]['workloads']['cell'].update(queue_s=-1), r'cell\.queue_s: queue_s must be a nonnegative'),
            'resource name': (lambda c: c['projects'][p]['workloads']['cell'].update(resources=['NOPE']), r"cell\.resources: names 'NOPE'"),
            'network': (lambda c: c['projects'][p]['workloads']['cell']['sandbox'].update(network='packages'), r'sandbox\.network: workload sandbox network must be'),
            'pin': (lambda c: c['projects'][p]['workloads']['smoke']['pin'].update({'{project}/run.py': 'abc'}), r'pin\["\{project\}/run\.py"\]: must be a SHA-256'),
            'requires_fresh': (lambda c: c['projects'][p]['workloads']['cell'].update(requires_fresh=['nope']), r"requires_fresh: names 'nope'"),
            'budget': (lambda c: c['projects'][p]['workloads']['cell'].update(instance_budget={'max_admissions': -1}), r'instance_budget: Instance budget limits'),
            'level': (lambda c: c['projects'][p]['classes'].update(workload='yes'), r"classes\.workload: must be one of"),
            'idle': (lambda c: c['projects'][p]['services']['wd'].update(restart_requires_idle=['NOPE']), r"restart_requires_idle: names 'NOPE'"),
            'unit': (lambda c: c['projects'][p]['services']['wd'].pop('unit'), r'services\.wd\.unit: needs the systemd unit'),
            'monitor_paths': (lambda c: c['projects'][p].update(monitor_paths=['logs']), r'monitor_paths\[0\]: must be an absolute path'),
            'max_monitors': (lambda c: c['projects'][p].update(max_monitors=-1), r'max_monitors: must be an integer of 0 or more'),
            'project key': (lambda c: c['projects'].update({'relative/p': {}}), r'projects\["relative/p"\]: the key must be an absolute path'),
            'defaults services': (lambda c: c['defaults'].update(services={'s': {'unit': 'u'}}), r'defaults\.services: the defaults cannot have services'),
            'defaults roots': (lambda c: c['defaults'].pop('roots'), r'defaults\.roots: needs a nonempty list'),
            'relative root': (lambda c: c['defaults'].update(roots=['work']), r'defaults\.roots\[0\]: must be absolute'),
            'defaults workload resource': (lambda c: c['defaults']['workloads']['build'].update(resources=['GPU_X']), r"defaults\.workloads\.build\.resources: names 'GPU_X'"),
            'alarm_command': (lambda c: c.update(alarm_command='notify'), r'alarm_command: must be a nonempty argv list'),
            'not an object': (lambda c: c['projects'].update({p: []}), r'must be an object'),
        }
        for name, (mutate, pattern) in cases.items():
            with self.subTest(name):
                errors = self.errors(mutate)
                self.assertTrue(any(re.search(pattern, e) for e in errors), errors)

    def test_unknown_keys_are_warnings_not_errors(self):
        cfg = json.loads(json.dumps(self.cfg))
        cfg['future_top'] = 1
        cfg['projects'][f'{self.tmp}/p1']['workloads']['smoke']['future_key'] = True
        cfg['projects'][f'{self.tmp}/p1']['classes'].update(policy='allow', future_class='ask')
        errors, warnings = P.check(cfg)
        self.assertEqual(errors, [])
        joined = '\n'.join(warnings)
        self.assertIn('future_top: unknown key', joined)
        self.assertIn('smoke.future_key: unknown key', joined)
        self.assertIn('classes.future_class: unknown class', joined)
        self.assertIn('"allow" is treated as "ask"', joined)

    def test_the_broker_and_the_check_use_the_same_rules(self):
        """One truth: the broker's run-time refusals and the schema check come from the same functions."""
        with self.assertRaises(hostd.Refusal) as e:
            hostd.command_sandbox(self.tmp, {'network': 'packages'})
        self.assertIn(e.exception.message, '\n'.join(self.errors(
            lambda c: c['projects'][f'{self.tmp}/p1']['workloads']['cell']['sandbox'].update(network='packages'))))
        with self.assertRaises(hostd.Refusal) as e:
            hostd.workload_argv(self.tmp, 'w', {'argv': ['true'], 'max_s': 0}, {})
        self.assertIn(P.max_s_problem(0), e.exception.message)
        self.assertIs(hostd.defaults_root, P.defaults_root)
        self.assertEqual(hostd.CLASSES, P.CLASSES)
        with patch.object(hostd, 'CONFIG', os.path.join(self.tmp, 'host.json')):
            hostlib.write_json(hostd.CONFIG, self.cfg)
            for project in (f'{self.tmp}/p1', f'{self.tmp}/work/q', f'{self.tmp}/other'):
                self.assertEqual(hostd.policy_entry(project), P.entry_for(self.cfg, project))


class ChangesTest(Tmp):
    def apply(self, changes, project=None):
        return P.apply_changes(self.cfg, changes, project)

    def test_each_change_kind(self):
        p1, q = f'{self.tmp}/p1', f'{self.tmp}/work/q'
        res = {'locks': [lock(f'{self.tmp}/locks/NEW.lock')]}
        new, _ = self.apply([{'kind': 'resource_set', 'scope': 'machine', 'name': 'NEW', 'resource': res}])
        self.assertEqual(new['resources']['NEW'], res)
        new, _ = self.apply([{'kind': 'resource_remove', 'scope': 'machine', 'name': 'QUIET'}])
        self.assertNotIn('QUIET', new['resources'])
        new, _ = self.apply([{'kind': 'resource_set', 'scope': 'project', 'project': p1, 'name': 'NEW', 'resource': res}])
        self.assertEqual(new['projects'][p1]['resources']['NEW'], res)
        new, _ = self.apply([{'kind': 'resource_remove', 'scope': 'project', 'name': 'GPU_A'}], project=p1)
        self.assertNotIn('GPU_A', new['projects'][p1]['resources'])
        new, _ = self.apply([{'kind': 'project_register', 'project': f'{self.tmp}/other', 'entry': {'classes': {}}}])
        self.assertEqual(new['projects'][f'{self.tmp}/other'], {'classes': {}})
        new, _ = self.apply([{'kind': 'project_remove', 'project': p1}])
        self.assertNotIn(p1, new['projects'])
        w = {'argv': ['/usr/bin/env'], 'max_s': 5}
        new, _ = self.apply([{'kind': 'workload_set', 'project': p1, 'name': 'env', 'workload': w}])
        self.assertEqual(new['projects'][p1]['workloads']['env'], w)
        new, _ = self.apply([{'kind': 'workload_remove', 'project': p1, 'name': 'smoke'}])
        self.assertNotIn('smoke', new['projects'][p1]['workloads'])
        new, _ = self.apply([{'kind': 'classes_set', 'project': p1, 'classes': {'reserve': 'ask'}}])
        self.assertEqual(new['projects'][p1]['classes'], {'observe': 'allow', 'workload': 'ask', 'restart': 'ask', 'reserve': 'ask'})
        new, _ = self.apply([{'kind': 'monitor_paths_set', 'project': p1, 'paths': ['/var/log']}])
        self.assertEqual(new['projects'][p1]['monitor_paths'], ['/var/log'])
        new, _ = self.apply([{'kind': 'defaults_set', 'defaults': {'roots': ['~/x']}}])
        self.assertEqual(new['defaults'], {'roots': ['~/x']})
        new, _ = self.apply([{'kind': 'defaults_remove'}])
        self.assertNotIn('defaults', new)
        new, _ = self.apply([{'kind': 'raw_set', 'path': ['alarm_external_after_s'], 'value': 60},
                             {'kind': 'raw_set', 'path': ['projects', p1, 'max_reserve_s'], 'value': 600},
                             {'kind': 'raw_remove', 'path': ['alarm_command']}])
        self.assertEqual((new['alarm_external_after_s'], new['projects'][p1]['max_reserve_s']), (60, 600))
        self.assertNotIn('alarm_command', new)
        new, _ = self.apply([{'kind': 'raw_set', 'path': [], 'value': {'version': 1}}])
        self.assertEqual(new, {'version': 1})
        self.assertNotIn('NEW', self.cfg['resources'], 'the input policy never changes')
        self.assertIn('build', self.cfg['defaults']['workloads'])
        self.assertNotIn(q, self.cfg['projects'])

    def test_refused_changes_name_the_change(self):
        p1 = f'{self.tmp}/p1'
        for changes, pattern in (
                ([{'kind': 'nope'}], r'needs "kind"'),
                ([], r'empty'),
                ([{'kind': 'workload_set', 'project': p1, 'name': 'x', 'workload': {}, 'extra': 1}], r'unknown fields'),
                ([{'kind': 'resource_remove', 'scope': 'machine', 'name': 'NOPE'}], r'change 0 \(resource_remove\): no machine resource'),
                ([{'kind': 'resource_set', 'scope': 'galaxy', 'name': 'X', 'resource': {}}], r'"scope" must be'),
                ([{'kind': 'resource_set', 'scope': 'machine', 'project': p1, 'name': 'X', 'resource': {}}], r'has no "project"'),
                ([{'kind': 'project_register', 'project': p1}], r'registered already'),
                ([{'kind': 'project_remove', 'project': f'{self.tmp}/other'}], r'not registered'),
                ([{'kind': 'workload_remove', 'project': p1, 'name': 'nope'}], r'no workload'),
                ([{'kind': 'workload_set', 'project': 'relative', 'name': 'x', 'workload': {}}], r'absolute path'),
                ([{'kind': 'workload_set', 'name': 'x', 'workload': {}}], r'needs "project"'),
                ([{'kind': 'classes_set', 'project': p1, 'classes': {}}], r'nonempty object'),
                ([{'kind': 'raw_remove', 'path': ['nope']}], r'does not exist'),
                ([{'kind': 'raw_set', 'path': [], 'value': []}], r'must be an object'),
                ([{'kind': 'defaults_remove'}, {'kind': 'defaults_remove'}], r'change 1 \(defaults_remove\): there are no defaults')):
            with self.subTest(changes=changes), self.assertRaisesRegex(P.PolicyError, pattern):
                self.apply(changes)

    def test_a_project_that_gets_the_defaults_is_registered_first(self):
        q = f'{self.tmp}/work/q'
        w = {'argv': ['{command}'], 'max_s': 60, 'sandbox': {'write': ['{project}']}}
        new, notes = self.apply([{'kind': 'workload_set', 'project': q, 'name': 'cell', 'workload': w}])
        self.assertEqual(len(notes), 1)
        self.assertIn('got the defaults', notes[0])
        self.assertIn('copy of the defaults', notes[0])
        entry = new['projects'][q]
        self.assertEqual(entry['workloads']['build'], self.cfg['defaults']['workloads']['build'], 'the copy keeps {project}')
        self.assertEqual(entry['workloads']['cell'], w)
        self.assertNotIn('roots', entry)
        self.assertEqual(new['defaults'], self.cfg['defaults'], 'the defaults do not change')
        new, notes = self.apply([{'kind': 'classes_set', 'project': f'{self.tmp}/other', 'classes': {'workload': 'ask'}}])
        self.assertEqual(new['projects'][f'{self.tmp}/other'], {'classes': {'workload': 'ask'}})
        self.assertIn('had no host policy', notes[0])

    def test_register_without_entry_copies_the_defaults_without_roots_or_services(self):
        cfg = json.loads(json.dumps(self.cfg))
        cfg['defaults']['services'] = {'s': {'unit': 'u.service'}}
        new, _ = P.apply_changes(cfg, [{'kind': 'project_register', 'project': f'{self.tmp}/other'}])
        entry = new['projects'][f'{self.tmp}/other']
        self.assertEqual(set(entry), {'classes', 'workloads'})
        self.assertEqual(entry['workloads']['build']['sandbox']['write'], ['{project}'])
        del cfg['defaults']
        new, _ = P.apply_changes(cfg, [{'kind': 'project_register', 'project': f'{self.tmp}/other'}])
        self.assertEqual(new['projects'][f'{self.tmp}/other'], {})


class FlagsTest(Tmp):
    def flags(self, changes, project=None, base=None):
        base = base or self.cfg
        new, _ = P.apply_changes(base, changes, project)
        return P.flags(base, new)

    def one(self, changes, pattern, project=None, base=None):
        fl = self.flags(changes, project, base)
        self.assertTrue(any(re.search(pattern, f) for f in fl), fl)
        return fl

    def test_each_risk_flag(self):
        p1 = f'{self.tmp}/p1'
        cmd = {'argv': ['{command}'], 'max_s': 60}
        self.one([{'kind': 'workload_set', 'project': p1, 'name': 'any', 'workload': cmd}], r'workload "any" in project ".*p1" runs any command')
        self.one([{'kind': 'workload_set', 'project': p1, 'name': 'net', 'workload': {**cmd, 'sandbox': {'network': 'open'}}}], r'"net" .* has network "open"')
        self.one([{'kind': 'workload_set', 'project': p1, 'name': 'wr', 'workload': {**cmd, 'sandbox': {'write': ['{project}/out', '/data']}}}],
                 r'"wr" .* can write outside the project: \["/data"\]')
        self.one([{'kind': 'workload_set', 'project': p1, 'name': 'host', 'workload': {'argv': ['/usr/bin/make']}}],
                 r'"host" .* runs without the broker\'s sandbox, with your full user authority')
        self.one([{'kind': 'workload_set', 'project': p1, 'name': 'pod', 'workload': {**cmd, 'command_sandbox': False}}],
                 r'"pod" .* runs any command.*|"pod" .* without the broker\'s sandbox')
        self.one([{'kind': 'classes_set', 'project': p1, 'classes': {'reserve': 'allow'}}], r'class "reserve" becomes "allow" in project')
        self.one([{'kind': 'raw_set', 'path': ['alarm_command'], 'value': ['/usr/bin/notify']}], r'alarm_command changes')
        no_alarm = {k: v for k, v in self.cfg.items() if k != 'alarm_command'}
        self.one([{'kind': 'raw_set', 'path': ['alarm_command'], 'value': ['/usr/bin/notify']}], r'alarm_command is new', base=no_alarm)
        self.one([{'kind': 'defaults_set', 'defaults': {**self.cfg['defaults'], 'classes': {'workload': 'allow'}}}],
                 rf'the defaults change: this affects every project under their roots \["{self.tmp}/work"\]')
        self.one([{'kind': 'defaults_remove'}], r'the defaults are removed')
        self.one([{'kind': 'resource_set', 'scope': 'machine', 'name': 'BUILD', 'resource': {'locks': []}}],
                 r'machine resource "BUILD" changed; it applies to every project, and these use it: the defaults')
        self.one([{'kind': 'resource_remove', 'scope': 'machine', 'name': 'QUIET'}],
                 rf'machine resource "QUIET" removed.*project "{self.tmp}/p1"')
        self.one([{'kind': 'resource_set', 'scope': 'machine', 'name': 'GPU_A', 'resource': {'locks': self.cfg['resources']['GPU_A']['locks']}}],
                 r'machine resource "GPU_A" loses lockouts')
        res = self.cfg['projects'][p1]['resources']['GPU_A']
        self.one([{'kind': 'resource_set', 'scope': 'project', 'project': p1, 'name': 'GPU_A', 'resource': {**res, 'lockouts': [res['lockouts'][0]]}}],
                 r'resource "GPU_A" of project .* loses lockouts \[".*lockout-A2"\]')
        self.one([{'kind': 'resource_set', 'scope': 'project', 'project': p1, 'name': 'GPU_A', 'resource': {**res, 'requires_active': []}}],
                 r'loses requires_active \["wd.service"\]')
        self.one([{'kind': 'resource_remove', 'scope': 'project', 'project': p1, 'name': 'GPU_A'}],
                 r'resource "GPU_A" of project .* loses lockouts \[".*lockout-A2"\] and requires_active')
        smoke = self.cfg['projects'][p1]['workloads']['smoke']
        self.one([{'kind': 'workload_set', 'project': p1, 'name': 'smoke', 'workload': {k: v for k, v in smoke.items() if k != 'pin'}}],
                 r'"smoke" .* loses its pin of "\{project\}/run.py"')
        self.one([{'kind': 'workload_set', 'project': p1, 'name': 'smoke', 'workload': {**smoke, 'pin': {'{project}/run.py': 'b' * 64}}}],
                 r'"smoke" .* pins a new version')

    def test_no_flags_for_a_copy_of_the_defaults_or_a_harmless_change(self):
        q = f'{self.tmp}/work/q'
        self.assertEqual(self.flags([{'kind': 'project_register', 'project': q}]), [])
        self.assertEqual(self.flags([{'kind': 'monitor_paths_set', 'project': f'{self.tmp}/p1', 'paths': ['/var/log']}]), [])
        self.assertEqual(self.flags([{'kind': 'resource_set', 'scope': 'machine', 'name': 'NEW', 'resource': {'locks': []}}]), [])

    def test_a_project_resource_that_shadows_a_machine_resource_names_what_it_drops(self):
        q = f'{self.tmp}/work/q'
        fl = self.one([{'kind': 'resource_set', 'scope': 'project', 'project': q, 'name': 'GPU_A',
                        'resource': {'locks': [lock(f'{self.tmp}/locks/GPU_A.lock')], 'requires_active': ['x.service']}}],
                      rf'resource "GPU_A" of project "{q}" replaces the machine resource "GPU_A" for this project; '
                      rf'the project no longer uses its locks \["{self.tmp}/locks/GPU_A.turn"\], '
                      rf'lockouts \["{self.tmp}/lockout-A"\], device checks \{{"nvidia": \["00000000:01:00.0"\]\}}$')
        self.assertFalse([f for f in fl if f.startswith('machine resource')], 'the machine resource does not change')
        self.assertEqual(len([f for f in fl if 'GPU_A' in f]), 1, fl)
        same_copy = self.flags([{'kind': 'resource_set', 'scope': 'project', 'project': q, 'name': 'GPU_A',
                                 'resource': self.cfg['resources']['GPU_A']}])
        self.assertEqual(same_copy, [f'resource "GPU_A" of project "{q}" replaces the machine resource "GPU_A" for this project '
                                     '(with the same locks, lockouts and checks)'])
        # A shadow that exists already is not flagged again when something else changes ...
        self.assertEqual(self.flags([{'kind': 'monitor_paths_set', 'project': f'{self.tmp}/p1', 'paths': ['/var/log']}]), [])
        # ... but it is when the machine resource gets a lockout that the project does not use.
        m = {**self.cfg['resources']['GPU_A'], 'lockouts': [f'{self.tmp}/lockout-A', f'{self.tmp}/lockout-new']}
        self.one([{'kind': 'resource_set', 'scope': 'machine', 'name': 'GPU_A', 'resource': m}],
                 rf'resource "GPU_A" of project "{self.tmp}/p1" replaces .* lockouts \["{self.tmp}/lockout-new"\]')


class DiffTest(Tmp):
    def test_stable_sorted_and_limited_to_the_changed_objects(self):
        p1 = f'{self.tmp}/p1'
        new, _ = P.apply_changes(self.cfg, [{'kind': 'classes_set', 'project': p1, 'classes': {'workload': 'allow'}},
                                            {'kind': 'workload_set', 'project': p1, 'name': 'b', 'workload': {'max_s': 5, 'argv': ['x']}}])
        text = P.diff(self.cfg, new)
        self.assertEqual(text, (f'@@ projects["{p1}"].classes\n- "workload": "ask"\n+ "workload": "allow"\n'
                                f'@@ projects["{p1}"].workloads\n+ "b": {{"argv": ["x"], "max_s": 5}}\n'))
        reordered = json.loads(json.dumps(new))
        reordered['projects'][p1] = dict(reversed(list(reordered['projects'][p1].items())))
        self.assertEqual(P.diff(self.cfg, reordered), text, 'key order does not change the diff')
        self.assertEqual(P.diff(self.cfg, self.cfg), '')
        self.assertNotIn('smoke', text, 'unchanged siblings are not shown')

    def test_long_values_are_split_and_text_is_escaped(self):
        p1 = f'{self.tmp}/p1'
        w = {'argv': ['/usr/bin/printf', '\x1b[2Jcleared‮'], 'description': 'x' * 120, 'max_s': 5}
        new, _ = P.apply_changes(self.cfg, [{'kind': 'workload_set', 'project': p1, 'name': 'w', 'workload': w}])
        lines = P.diff(self.cfg, new).splitlines()
        self.assertEqual(lines[1], '+ "w": {')
        self.assertEqual(lines[-1], '+ }')
        self.assertTrue(all(c.isprintable() for ln in lines for c in ln), 'no control or bidirectional characters')
        self.assertIn('\\u001b[2J', '\n'.join(lines))
        self.assertEqual(P.safe_text('a\x1b[1mb‮c\nd'), 'a\\u001b[1mb\\u202ec\\u000ad')


class WriteTest(Tmp):
    def setUp(self):
        super().setUp()
        self.dir = os.path.join(self.tmp, 'cfg')
        self.path = os.path.join(self.dir, 'host.json')

    def test_a_new_file_and_its_folder_are_private(self):
        out = P.write(self.path, self.cfg, None)
        self.assertEqual(stat.S_IMODE(os.stat(self.dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        self.assertEqual((out['sha_before'], out['backup']), (None, None))
        self.assertEqual(out['sha_after'], P.sha256_of(self.path))
        self.assertEqual(P.read(self.path)[0], self.cfg)

    def test_backup_naming_atomic_replacement_and_pruning_to_ten(self):
        P.write(self.path, self.cfg, None)
        os.chmod(self.path, 0o644)
        for name in ('host.json.bak-manual', 'host.json.bak-2020', 'other.json.bak-20200101T000000Z', 'notes.txt'):
            put_text(os.path.join(self.dir, name), 'keep')
        import datetime
        for i in range(12):
            before = rb(self.path)
            cfg = {**self.cfg, 'alarm_external_after_s': i}
            when = datetime.datetime(2026, 1, 1, 0, 0, i, tzinfo=datetime.timezone.utc)
            out = P.write(self.path, cfg, hashlib.sha256(before).hexdigest(), now=when)
            self.assertEqual(os.path.basename(out['backup']), f'host.json.bak-20260101T0000{i:02d}Z')
            self.assertEqual(rb(out['backup']), before)
            self.assertEqual(stat.S_IMODE(os.stat(out['backup']).st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        same_second = P.write(self.path, self.cfg, P.sha256_of(self.path), now=when)
        self.assertTrue(same_second['backup'].endswith('host.json.bak-20260101T000011Z-1'))
        kept = sorted(n for n in os.listdir(self.dir) if re.match(r'host\.json\.bak-2\d{7}T', n))
        self.assertEqual(len(kept), 10)
        self.assertEqual(kept[0], 'host.json.bak-20260101T000003Z')
        self.assertEqual(kept[-1], 'host.json.bak-20260101T000011Z-1')
        for name in ('host.json.bak-manual', 'host.json.bak-2020', 'other.json.bak-20200101T000000Z', 'notes.txt'):
            self.assertTrue(os.path.exists(os.path.join(self.dir, name)), f'{name} is not a backup of this scheme')
        self.assertFalse([n for n in os.listdir(self.dir) if '.tmp-' in n], 'no temporary file is left')

    def test_a_concurrent_change_is_refused_and_nothing_is_written(self):
        P.write(self.path, self.cfg, None)
        stale = P.sha256_of(self.path)
        hostlib.write_json(self.path, {**self.cfg, 'alarm_external_after_s': 5})      # someone else
        current = rb(self.path)
        with self.assertRaises(P.PolicyConflict):
            P.write(self.path, {**self.cfg, 'alarm_external_after_s': 9}, stale)
        self.assertEqual(rb(self.path), current)
        self.assertEqual(P.backups(self.path), [])
        with self.assertRaises(P.PolicyConflict):
            P.write(self.path, self.cfg, None)                                  # "new file" but it exists
        os.unlink(self.path)
        with self.assertRaises(P.PolicyConflict):
            P.write(self.path, self.cfg, stale)                                 # it was removed meanwhile
        self.assertFalse(os.path.exists(self.path))

    def test_a_new_file_starts_from_version_1(self):
        out = P.write(self.path, {'projects': {}}, None)
        self.assertEqual(P.read(self.path)[0], {'version': 1, 'projects': {}})
        self.assertEqual(out['sha_after'], P.sha256_of(self.path))
        self.assertEqual(P.check(P.read(self.path)[0]), ([], []))
        with self.assertRaises(P.PolicyConflict):
            P.write(self.path, {'projects': {}}, None)

    def test_apply_creates_a_new_file_with_version_1(self):
        change = os.path.join(self.tmp, 'change.json')
        put_text(change, json.dumps([{'kind': 'project_register', 'project': f'{self.tmp}/p1', 'entry': {'classes': {}}}]))
        env = {**os.environ, 'MINA_HOST_CONFIG': self.path, 'MINA_HOST_STATE': os.path.join(self.tmp, 'state')}
        r = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'policy.py'), 'apply', change, '--yes'],
                           env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn('warning', r.stdout)
        self.assertEqual(P.read(self.path)[0], {'version': 1, 'projects': {f'{self.tmp}/p1': {'classes': {}}}})
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)

    def test_an_invalid_policy_is_never_written(self):
        with self.assertRaisesRegex(P.PolicyError, 'version'):
            P.write(self.path, {'version': 2}, None)
        self.assertFalse(os.path.exists(self.path))


def fixture_gpus(tmp):
    """A fake nvidia-smi with two GPUs, and a KFD topology with a CPU node and one AMD GPU."""
    smi = os.path.join(tmp, 'nvidia-smi')
    with open(smi, 'w') as f:
        f.write('#!/bin/sh\nprintf "0, 00000000:01:00.0, NVIDIA Fixture A\\n1, 00000000:02:00.0, NVIDIA Fixture B\\n"\n')
    os.chmod(smi, 0o755)
    topo = os.path.join(tmp, 'topology')
    for node, props, name in (('0', 'cpu_cores_count 16\nsimd_count 0\n', ''),
                              ('1', 'simd_count 192\nlocation_id 768\ndomain 0\ngfx_target_version 110000\n', 'gfx1100\n')):
        os.makedirs(os.path.join(topo, node))
        put_text(os.path.join(topo, node, 'properties'), props)
        if name:
            put_text(os.path.join(topo, node, 'name'), name)
    return {'MINA_HOST_NVIDIA_SMI': smi, 'MINA_HOST_KFD_TOPOLOGY': topo}


class InventoryTest(Tmp):
    def test_devices_coverage_lock_holders_lockouts_and_suggestions(self):
        env = fixture_gpus(self.tmp)
        put_text(f'{self.tmp}/lockout-A', 'fault')
        held = f'{self.tmp}/locks/QUIET.lock'
        open(held, 'w').close()
        holder = subprocess.Popen(['flock', '-x', held, 'sleep', '60'], start_new_session=True)
        self.addCleanup(lambda: (os.killpg(holder.pid, signal.SIGKILL), holder.wait()))
        self.assertTrue(wait_for(lambda: hostlib.lock_holders(held)))
        inv = P.inventory(self.cfg, env=env)
        by = {g['bus_id']: g for g in inv['devices']}
        self.assertEqual(by['00000000:01:00.0']['covered_by'], ['machine:GPU_A'])
        self.assertEqual(by['00000000:02:00.0']['covered_by'], [])
        self.assertEqual((by['0000:03:00.0']['vendor'], by['0000:03:00.0']['name']), ('amd', 'gfx1100'))
        self.assertEqual(by['0000:03:00.0']['covered_by'], [f'project {self.tmp}/p1:GPU_A'])
        locks = {rec['path']: rec for rec in inv['locks']}
        self.assertEqual(sorted(locks[held]['used_by']), ['machine:BUILD shared', 'machine:QUIET exclusive'])
        self.assertEqual([h['pid'] for h in locks[held]['holders'] if not h['waiting']][:1], [holder.pid])
        self.assertTrue(all(len(h['argv']) <= 2 for rec in inv['locks'] for h in rec['holders']))
        self.assertIn('machine:GPU_A turnstile', locks[f'{self.tmp}/locks/GPU_A.turn']['used_by'])
        lockouts = {rec['path']: rec for rec in inv['lockouts']}
        self.assertTrue(lockouts[f'{self.tmp}/lockout-A']['exists'])
        self.assertFalse(lockouts[f'{self.tmp}/lockout-A2']['exists'])
        sug = P.suggestions(self.cfg, inv)
        self.assertEqual(sug, [{'kind': 'resource_set', 'scope': 'machine', 'name': 'GPU_1',
                                'resource': {'locks': [{'path': f'{self.tmp}/locks/GPU_1.lock'}], 'device': {'nvidia': ['00000000:02:00.0']}}}])
        self.assertEqual(P.validate(P.apply_changes(self.cfg, sug)[0]), [], 'a suggestion is a valid change')

    def test_a_project_view_shows_no_other_project_and_a_missing_tool_is_a_note(self):
        env = {'MINA_HOST_NVIDIA_SMI': os.path.join(self.tmp, 'no-such-smi'), 'MINA_HOST_KFD_TOPOLOGY': os.path.join(self.tmp, 'none')}
        inv = P.inventory(self.cfg, project=f'{self.tmp}/work/q', env=env)
        self.assertEqual(inv['devices'], [])
        self.assertEqual(len(inv['notes']), 2)
        used = [u for rec in inv['locks'] + inv['lockouts'] for u in rec['used_by']]
        self.assertFalse([u for u in used if 'p1' in u], used)
        self.assertNotIn(f'{self.tmp}/lockout-A2', [rec['path'] for rec in inv['lockouts']])


class AgentRulesTest(Tmp):
    def test_what_an_agent_may_propose(self):
        q = f'{self.tmp}/work/q'
        ok = [{'kind': 'resource_set', 'scope': 'machine', 'name': 'GPU_NEW', 'resource': {'locks': []}},
              {'kind': 'resource_set', 'scope': 'project', 'name': 'GPU_A', 'resource': {'locks': []}},
              {'kind': 'resource_remove', 'scope': 'project', 'project': q, 'name': 'GPU_A'},
              {'kind': 'project_register', 'project': q},
              {'kind': 'workload_set', 'name': 'w', 'workload': {'argv': ['x']}},
              {'kind': 'workload_remove', 'name': 'w'},
              {'kind': 'classes_set', 'classes': {'workload': 'allow'}},
              {'kind': 'monitor_paths_set', 'paths': ['/var/log']}]
        self.assertEqual(P.agent_refusals(self.cfg, ok, q), [])
        refused = {
            'raw': ({'kind': 'raw_set', 'path': ['alarm_command'], 'value': ['x']}, 'owner only'),
            'raw remove': ({'kind': 'raw_remove', 'path': ['version']}, 'owner only'),
            'defaults': ({'kind': 'defaults_set', 'defaults': {}}, 'every project under their roots'),
            'defaults remove': ({'kind': 'defaults_remove'}, 'every project'),
            'project remove': ({'kind': 'project_remove', 'project': q}, 'only the owner removes'),
            'existing machine': ({'kind': 'resource_set', 'scope': 'machine', 'name': 'GPU_A', 'resource': {}}, 'other projects can depend on it'),
            'machine remove': ({'kind': 'resource_remove', 'scope': 'machine', 'name': 'NEWER'}, 'only the owner changes or removes'),
            'other project': ({'kind': 'workload_set', 'project': f'{self.tmp}/p1', 'name': 'w', 'workload': {}}, 'another project'),
            'register other': ({'kind': 'project_register', 'project': f'{self.tmp}/work/r'}, 'another project'),
            'policy class': ({'kind': 'classes_set', 'classes': {'policy': 'allow'}}, '"policy" class'),
            'policy via register': ({'kind': 'project_register', 'entry': {'classes': {'policy': 'deny'}}}, '"policy" class'),
            'bad name': ({'kind': 'workload_set', 'name': '../x', 'workload': {}}, 'a name must be'),
        }
        for name, (change, text) in refused.items():
            with self.subTest(name):
                out = P.agent_refusals(self.cfg, [change], q)
                self.assertEqual(len(out), 1, out)
                self.assertIn(text, out[0])
                if name not in ('bad name',):
                    self.assertIn('mina host apply', out[0])
        twice = [{'kind': 'resource_set', 'scope': 'machine', 'name': 'GPU_NEW', 'resource': {}}] * 2
        self.assertEqual(len(P.agent_refusals(self.cfg, twice, q)), 1, 'a new machine name is set once')


class ProposeTest(unittest.TestCase):
    """policy_propose through the real dispatcher and handler, with a temporary policy and state, without a broker."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='mina-propose-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.project = os.path.join(self.tmp, 'work', 'proj')
        self.other = os.path.join(self.tmp, 'other')
        for d in (self.project, self.other, 'locks'):
            os.makedirs(os.path.join(self.tmp, d), exist_ok=True)
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.config = os.path.join(self.tmp, 'cfg', 'host.json')
        self.state = os.path.join(self.tmp, 'state')
        for key, value in {'CONFIG': self.config, 'STATE': self.state, 'SESSIONS': os.path.join(self.state, 'sessions.json'),
                           'WL': os.path.join(self.state, 'workloads'), 'MONITORS': os.path.join(self.state, 'monitors.json'),
                           'ALARMS': os.path.join(self.state, 'alarms.json'),
                           'confirmations': hostd.Confirmations(), 'budgets': hostd.AdmissionBudgets(), 'cap_cache': {}}.items():
            stack.enter_context(patch.object(hostd, key, value))
        self.session_project = self.project
        stack.enter_context(patch.object(hostd, 'session_for', side_effect=lambda *a: ('sess', {'project': self.session_project})))
        self.cfg = {'version': 1, 'resources': {'GPU_A': {'locks': [{'path': f'{self.tmp}/locks/GPU_A.lock'}],
                                                          'lockouts': [f'{self.tmp}/lockout']}},
                    'projects': {self.project: {'classes': {'observe': 'allow', 'workload': 'ask'},
                                                'workloads': {'old': {'argv': ['/usr/bin/true'], 'max_s': 5}}},
                                 self.other: {'classes': {}}},
                    'alarm_command': ['/usr/bin/true']}
        self.put(self.cfg)

    def put(self, cfg):
        P.write(self.config, cfg, P.sha256_of(self.config))

    def call(self, op, **args):
        return hostd.handle({'op': hostd.MUTATION_OP, 'action': op, 'args': args, 'grant': 'g'} if op in hostd.MUTATIONS
                            else {'op': op, 'grant': 'g', **args}, 123, hostd.UID)

    def refusal(self, op, **args):
        with self.assertRaises(hostd.Refusal) as cm:
            self.call(op, **args)
        return cm.exception

    def propose(self, changes, reason='the project needs it'):
        e = self.refusal('policy_propose', changes=changes, reason=reason)
        self.assertEqual(e.code, 'REQUIRES_AUTHORIZATION', (e.message, e.detail))
        self.assertIs(e.detail.get('approval_needed'), True, (e.message, e.detail))
        return e

    def approve(self, changes, e, reason='the project needs it'):
        return self.call('policy_propose', changes=changes, reason=reason,
                         approval={'granted': True, 'challenge': e.detail['approval_request']['challenge']})

    def audit_records(self):
        try:
            with open(os.path.join(self.state, 'audit.jsonl')) as f:
                return [json.loads(line) for line in f]
        except FileNotFoundError:
            return []

    WORKLOAD = [{'kind': 'workload_set', 'name': 'build', 'workload': {'argv': ['{command}'], 'max_s': 600,
                                                                       'sandbox': {'write': ['{project}'], 'network': 'offline'}}}]

    def test_approval_writes_audits_and_the_new_workload_is_in_capabilities_at_once(self):
        before = rb(self.config)
        caps = self.call('capabilities')
        self.assertNotIn('workload:build', [c['capability'] for c in caps['capabilities']])
        self.assertEqual(caps['policy_protocol'], P.POLICY_PROTOCOL)
        e = self.propose(self.WORKLOAD)
        self.assertEqual(rb(self.config), before, 'nothing is written before the approval')
        prompt = e.detail['approval_prompt']
        self.assertIn("The agent's reason (the agent's words, not examined):\n  the project needs it", prompt)
        self.assertIn('runs any command', prompt)
        self.assertIn(f'@@ projects["{self.project}"].workloads\n+ "build":', prompt)
        self.assertLessEqual(len(prompt), hostd.PROMPT_MAX_CHARS)
        out = self.approve(self.WORKLOAD, e)
        self.assertTrue(out['written'])
        self.assertEqual(out['sha256'], P.sha256_of(self.config))
        self.assertEqual(out['diff_sha256'], hashlib.sha256(P.diff(self.cfg, P.read(self.config)[0]).encode()).hexdigest())
        self.assertTrue(any('runs any command' in f for f in out['flags']))
        self.assertIn('build', P.read(self.config)[0]['projects'][self.project]['workloads'])
        rec = [r for r in self.audit_records() if r['op'] == 'policy_change']
        self.assertEqual(len(rec), 1)
        self.assertEqual((rec[0]['project'], rec[0]['session'], rec[0]['kinds']), (self.project, 'sess', ['workload_set']))
        self.assertEqual(rec[0]['sha_before'], hashlib.sha256(before).hexdigest())
        self.assertEqual(rb(rec[0]['backup']), before)
        self.assertNotIn(e.detail['approval_request']['challenge'], json.dumps(rec[0]), 'the secret challenge is not audited')
        caps = self.call('capabilities')
        self.assertNotIn('cached', caps)
        self.assertIn('workload:build', [c['capability'] for c in caps['capabilities']])
        after = rb(self.config)
        again = self.refusal('policy_propose', changes=self.WORKLOAD, reason='the project needs it',
                             approval={'granted': True, 'challenge': e.detail['approval_request']['challenge']})
        self.assertIn(again.code, ('INVALID', 'REQUIRES_AUTHORIZATION'), 'a replay is refused (the change is in place now)')
        self.assertEqual(rb(self.config), after)
        self.assertEqual(len([r for r in self.audit_records() if r['op'] == 'policy_change']), 1)

    def test_ask_is_required_even_with_allow_and_deny_refuses(self):
        before = rb(self.config)
        for level in ('allow', 'ask', None):
            with self.subTest(level=level):
                cfg = json.loads(json.dumps(self.cfg))
                if level:
                    cfg['projects'][self.project]['classes']['policy'] = level
                self.put(cfg)
                self.propose(self.WORKLOAD)
        cfg = json.loads(json.dumps(self.cfg))
        cfg['projects'][self.project]['classes']['policy'] = 'deny'
        self.put(cfg)
        before = rb(self.config)
        e = self.refusal('policy_propose', changes=self.WORKLOAD, reason='x')
        self.assertEqual(e.code, 'REQUIRES_AUTHORIZATION')
        self.assertNotIn('approval_needed', e.detail)
        self.assertIn('classes.policy', e.detail['remediation'])
        self.assertEqual(rb(self.config), before)
        caps = {c['capability']: c for c in self.call('capabilities')['capabilities']}
        self.assertIn('classes.policy', caps['policy_propose']['remediation'])

    def test_a_policy_change_after_approval_refuses_without_writing(self):
        e = self.propose(self.WORKLOAD)
        real = hostd.confirmations.consume
        concurrent = {**self.cfg, 'alarm_external_after_s': 7}

        def consume_then_edit(*a):
            real(*a)
            hostlib.write_json(self.config, concurrent)   # the owner edits host.json in this instant

        with patch.object(hostd.confirmations, 'consume', side_effect=consume_then_edit):
            with self.assertRaises(hostd.Refusal) as cm:
                self.approve(self.WORKLOAD, e)
        self.assertEqual(cm.exception.code, 'CONFLICT')
        self.assertIn('nothing was written', cm.exception.message)
        self.assertEqual(P.read(self.config)[0], concurrent)
        self.assertEqual(P.backups(self.config), [])
        self.assertFalse([r for r in self.audit_records() if r['op'] == 'policy_change'])

    def test_a_policy_change_before_approval_invalidates_the_challenge(self):
        e = self.propose(self.WORKLOAD)
        self.put({**self.cfg, 'alarm_external_after_s': 8})
        changed = rb(self.config)
        with self.assertRaises(hostd.Refusal) as cm:
            self.approve(self.WORKLOAD, e)
        self.assertEqual(cm.exception.code, 'REQUIRES_AUTHORIZATION')
        self.assertEqual(rb(self.config), changed)

    def test_what_the_agent_cannot_touch(self):
        before = rb(self.config)
        for name, change in {
                'another project': {'kind': 'workload_set', 'project': self.other, 'name': 'w', 'workload': {'argv': ['x']}},
                'defaults': {'kind': 'defaults_set', 'defaults': {'roots': [self.tmp]}},
                'existing machine resource': {'kind': 'resource_set', 'scope': 'machine', 'name': 'GPU_A', 'resource': {'locks': []}},
                'machine resource removal': {'kind': 'resource_remove', 'scope': 'machine', 'name': 'GPU_A'},
                'raw': {'kind': 'raw_set', 'path': ['projects', self.project, 'max_reserve_s'], 'value': 9},
                'alarm_command': {'kind': 'raw_set', 'path': ['alarm_command'], 'value': ['/usr/bin/notify']},
                'version': {'kind': 'raw_set', 'path': ['version'], 'value': 1},
                'classes.policy': {'kind': 'classes_set', 'classes': {'policy': 'allow'}},
                'project removal': {'kind': 'project_remove', 'project': self.project}}.items():
            with self.subTest(name):
                e = self.refusal('policy_propose', changes=[change], reason='x')
                self.assertEqual(e.code, 'REQUIRES_AUTHORIZATION')
                self.assertNotIn('approval_needed', e.detail)
                self.assertIn('mina host apply', e.message + e.detail['remediation'])
        self.assertEqual(rb(self.config), before)
        self.propose([{'kind': 'resource_set', 'scope': 'machine', 'name': 'GPU_B',
                       'resource': {'locks': [{'path': f'{self.tmp}/locks/GPU_B.lock'}]}}])

    def test_invalid_requests_and_results_are_refused_before_a_dialog(self):
        for args, pattern in (({'changes': self.WORKLOAD}, 'reason must be'),
                              ({'changes': self.WORKLOAD, 'reason': 'x' * 501}, 'reason must be'),
                              ({'changes': [], 'reason': 'x'}, 'changes must be'),
                              ({'changes': self.WORKLOAD, 'reason': 'x', 'extra': 1}, 'accepts only'),
                              ({'changes': [{'kind': 'workload_set', 'name': 'w', 'workload': {'argv': ['x'], 'resources': ['NOPE']}}],
                                'reason': 'x'}, 'has errors'),
                              ({'changes': [{'kind': 'workload_remove', 'name': 'nope'}], 'reason': 'x'}, 'no workload'),
                              ({'changes': [{'kind': 'workload_set', 'name': 'old', 'workload': {'argv': ['/usr/bin/true'], 'max_s': 5}}],
                                'reason': 'x'}, 'does not change')):
            with self.subTest(pattern):
                e = self.refusal('policy_propose', **args)
                self.assertEqual(e.code, 'INVALID', e.message)
                self.assertRegex(e.message, pattern)

    def test_an_oversized_prompt_is_refused_with_the_owner_alternative(self):
        big = [{'kind': 'workload_set', 'name': f'w{i}', 'workload': {'argv': [f'/usr/bin/tool-{i}', '--a', '--b'], 'max_s': 5,
                                                                      'description': 'x' * 90}} for i in range(12)]
        e = self.refusal('policy_propose', changes=big, reason='many tools')
        self.assertEqual(e.code, 'INVALID')
        self.assertIn('too large', e.message)
        self.assertIn('mina host apply', e.detail['remediation'])
        self.assertIn('.mina/host-change.json', e.detail['remediation'])
        self.assertNotIn('approval_request', e.detail)

    def test_the_reason_cannot_hide_text_in_the_dialog(self):
        e = self.propose(self.WORKLOAD, reason='ok\x1b[2K\x1b[1A‮forged\nRisk flags: none')
        prompt = e.detail['approval_prompt']
        self.assertNotIn('\x1b', prompt)
        self.assertNotIn('‮', prompt)
        self.assertEqual(prompt.count('\nRisk flags'), 1, 'the reason stays on its own line')

    def test_without_host_json_an_approved_registration_creates_it_with_version_1(self):
        os.unlink(self.config)
        change = [{'kind': 'project_register', 'entry': {'classes': {}}}]
        e = self.propose(change)
        self.assertIn('+ "version": 1', e.detail['approval_prompt'])
        self.approve(change, e)
        self.assertEqual(P.read(self.config)[0], {'version': 1, 'projects': {self.project: {'classes': {}}}})

    def test_a_defaults_project_is_registered_first(self):
        cfg = {**self.cfg, 'defaults': {'roots': [os.path.join(self.tmp, 'work')], 'classes': {'workload': 'ask'},
                                        'workloads': {'tpl': {'argv': ['{command}'], 'max_s': 5}}}}
        del cfg['projects'][self.project]
        self.put(cfg)
        e = self.propose(self.WORKLOAD)
        self.assertIn('got the defaults: this change registers it with a copy of the defaults first', e.detail['approval_prompt'])
        self.approve(self.WORKLOAD, e)
        entry = P.read(self.config)[0]['projects'][self.project]
        self.assertEqual(set(entry['workloads']), {'tpl', 'build'})
        self.assertEqual(P.read(self.config)[0]['defaults'], cfg['defaults'])

    def test_an_unregistered_project_sees_inventory_and_can_propose_its_registration(self):
        cfg = json.loads(json.dumps(self.cfg))
        del cfg['projects'][self.project]
        self.put(cfg)
        caps = self.call('capabilities')
        self.assertFalse(caps['registered'])
        self.assertEqual([(c['capability'], c['status']) for c in caps['capabilities']],
                         [('project', 'REQUIRES_AUTHORIZATION'), ('inventory', 'AVAILABLE'), ('policy_propose', 'REQUIRES_AUTHORIZATION')])
        with patch.dict(os.environ, fixture_gpus(self.tmp)):
            inv = self.call('inventory')
        self.assertFalse(inv['registered'])
        self.assertEqual(len(inv['devices']), 3)
        self.assertEqual([rec['path'] for rec in inv['lockouts']], [f'{self.tmp}/lockout'])
        for op, args in (('workload_run', {'workload': 'old'}), ('reserve', {'resources': ['GPU_A']}), ('service_status', {'service': 's'})):
            with self.subTest(op):
                self.assertEqual(self.refusal(op, **args).code, 'REQUIRES_AUTHORIZATION')
        change = [{'kind': 'project_register', 'entry': {'classes': {'workload': 'ask'}, 'workloads': {'gpu': {'argv': ['/usr/bin/true'], 'resources': ['GPU_A'], 'max_s': 5}}}}]
        e = self.propose(change, reason='this project runs GPU smoke tests')
        self.assertIn(f'+ "{self.project}": {{', e.detail['approval_prompt'])
        self.approve(change, e, reason='this project runs GPU smoke tests')
        caps = self.call('capabilities')
        self.assertTrue(caps['registered'])
        self.assertIn('workload:gpu', [c['capability'] for c in caps['capabilities']])
        self.session_project = self.other   # another project's session cannot register this one
        e = self.refusal('policy_propose', changes=[{'kind': 'project_register', 'project': os.path.join(self.tmp, 'work', 'x')}], reason='x')
        self.assertIn('another project', e.message)


class BrokerPolicyTest(unittest.TestCase):
    """The real broker over its socket: an unregistered project's session proposes its registration, the user approves,
    and the new policy applies to the next request."""

    def setUp(self):
        self.b = Broker()
        self.addCleanup(self.b.cleanup)
        self.b.config({'classes': {}})       # registers b.project; the test uses another, unregistered project
        self.proj = os.path.join(self.b.tmp, 'unregistered')
        os.makedirs(self.proj)
        self.b.start()

    def test_propose_approve_and_use(self):
        opened = self.b.open_session(self.proj, full=True)
        self.assertEqual((opened['registered'], opened['policy_protocol']), (False, P.POLICY_PROTOCOL))
        grant = opened['grant']
        self.assertEqual(self.b.raw({'op': 'ping'})['result']['policy_protocol'], P.POLICY_PROTOCOL)
        change = [{'kind': 'project_register', 'entry': {'classes': {'workload': 'allow'},
                                                         'workloads': {'hello': {'argv': ['/bin/echo', 'hello'], 'max_s': 10}}}}]
        req = {'op': 'mutate_v2', 'action': 'policy_propose', 'grant': grant, 'args': {'changes': change, 'reason': 'run hello'}}
        out = self.b.raw(req)
        self.assertEqual(out['error']['code'], 'REQUIRES_AUTHORIZATION', out)
        self.assertIn('class "workload" becomes "allow"', out['error']['approval_prompt'])
        before = rb(self.b.env['MINA_HOST_CONFIG'])
        self.assertEqual(self.b.raw({'op': 'workload_run', 'grant': grant, 'workload': 'hello'})['error']['code'], 'REQUIRES_AUTHORIZATION')
        req['args']['approval'] = {'granted': True, 'challenge': out['error']['approval_request']['challenge']}
        done = self.b.raw(req)
        self.assertTrue(done['ok'], done)
        self.assertNotEqual(rb(self.b.env['MINA_HOST_CONFIG']), before)
        caps = self.b.raw({'op': 'capabilities', 'grant': grant})['result']
        self.assertIn('workload:hello', [c['capability'] for c in caps['capabilities']])
        with open(os.path.join(self.b.env['MINA_HOST_STATE'], 'audit.jsonl')) as f:
            text = f.read()
        self.assertIn('"op": "policy_change"', text)
        self.assertNotIn(out['error']['approval_request']['challenge'], text)
        self.assertNotIn(grant, text)


if __name__ == '__main__':
    unittest.main()
