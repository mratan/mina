#!/usr/bin/env python3
"""The push gate against real git repositories and the real gitleaks. Run: python3 host/test_git_push_gate.py -v"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, 'git-push-gate.py')
# A GitHub token shape (detected by gitleaks' default rules); not a real credential.
TOKEN = 'ghp_' + 'Zq9Xr2Lm4Tv8Nb6Kw1Hs3Jd5Fg7Pc0Ya2Ue'


def git(cwd, *args):
    return subprocess.run(['git', '-C', cwd, *args], check=True, capture_output=True, text=True,
                          env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't',
                               'GIT_COMMITTER_EMAIL': 't@t'}).stdout.strip()


class GateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='mina-push-gate-')
        self.addCleanup(self.tmp.cleanup)
        self.remote = os.path.join(self.tmp.name, 'remote.git')
        self.repo = os.path.join(self.tmp.name, 'repo')
        subprocess.run(['git', 'init', '-q', '--bare', '-b', 'work', self.remote], check=True)
        subprocess.run(['git', 'init', '-q', '-b', 'work', self.repo], check=True)
        git(self.repo, 'remote', 'add', 'origin', self.remote)
        self.commit('README.md', 'start\n')
        git(self.repo, 'push', '-q', 'origin', 'work')

    def commit(self, name, content, mode='w'):
        with open(os.path.join(self.repo, name), mode) as f:
            f.write(content)
        git(self.repo, 'add', name)
        git(self.repo, 'commit', '-q', '-m', f'add {name}')
        return git(self.repo, 'rev-parse', 'HEAD')

    def gate(self, *extra, branch='work', url=None):
        r = subprocess.run([sys.executable, GATE, '--remote-url', url or self.remote, '--branches', '^work$', '--max-mb', '1',
                            *extra, self.repo, branch], capture_output=True, text=True, timeout=120)
        decision = json.loads(r.stdout.strip().splitlines()[-1])
        return r.returncode, decision, r.stdout + r.stderr

    def remote_head(self):
        return subprocess.run(['git', '--git-dir', self.remote, 'rev-parse', 'work'], capture_output=True, text=True).stdout.strip()

    def test_clean_commits_are_pushed(self):
        head = self.commit('code.py', 'print("ok")\n')
        rc, d, _ = self.gate()
        self.assertEqual((rc, d['decision'], d['commits']), (0, 'pushed', 1))
        self.assertEqual(self.remote_head(), head)
        rc, d, _ = self.gate()
        self.assertEqual((rc, d['decision']), (0, 'up_to_date'))

    def test_check_only_scans_without_pushing(self):
        before = self.remote_head()
        self.commit('code.py', 'print("ok")\n')
        rc, d, _ = self.gate('--check-only')
        self.assertEqual((rc, d['decision']), (0, 'checked'))
        self.assertEqual(self.remote_head(), before)

    def test_a_secret_in_any_outgoing_commit_refuses_and_is_never_printed(self):
        before = self.remote_head()
        self.commit('config.py', f'TOKEN = "{TOKEN}"\n')
        self.commit('config.py', 'TOKEN = None\n')          # removing it later does not unpublish the earlier commit
        rc, d, out = self.gate()
        self.assertNotEqual(rc, 0)
        self.assertEqual(d['decision'], 'refused')
        self.assertTrue(d['findings'] and d['findings'][0]['file'] == 'config.py' and d['findings'][0]['rule'])
        self.assertNotIn(TOKEN, out)
        self.assertNotIn(TOKEN[4:20], out)
        self.assertEqual(self.remote_head(), before)

    def test_the_repository_cannot_allowlist_its_own_secret(self):
        before = self.remote_head()
        with open(os.path.join(self.repo, '.gitleaks.toml'), 'w') as f:
            f.write('[extend]\nuseDefault = true\n[allowlist]\npaths = [".*"]\n')
        self.commit('config.py', f'TOKEN = "{TOKEN}"  # gitleaks:allow\n')
        fingerprint = git(self.repo, 'rev-parse', 'HEAD') + ':config.py:github-pat:1'
        self.commit('.gitleaksignore', fingerprint + '\n')
        rc, d, _ = self.gate()
        self.assertEqual((rc != 0, d['decision']), (True, 'refused'))
        self.assertEqual(self.remote_head(), before)

    def test_oversized_outgoing_files_refuse(self):
        self.commit('tensor.bin', 'x' * (1024 * 1024 + 1))
        rc, d, _ = self.gate()
        self.assertEqual((rc != 0, d['decision']), (True, 'refused'))
        self.assertIn('tensor.bin', d['reason'])

    def test_non_fast_forward_wrong_remote_and_unlisted_branch_refuse(self):
        other = os.path.join(self.tmp.name, 'other')
        subprocess.run(['git', 'clone', '-q', self.remote, other], check=True)
        with open(os.path.join(other, 'theirs.txt'), 'w') as f:
            f.write('remote-only\n')
        git(other, 'add', 'theirs.txt'); git(other, 'commit', '-q', '-m', 'theirs'); git(other, 'push', '-q', 'origin', 'work')
        self.commit('mine.txt', 'local-only\n')
        rc, d, _ = self.gate()
        self.assertEqual((rc != 0, d['decision']), (True, 'refused'))
        self.assertIn('fast-forward', d['reason'])
        self.assertEqual(self.gate(url='git@example.com:someone/else.git')[1]['decision'], 'refused')
        git(self.repo, 'branch', 'main')
        rc, d, _ = self.gate(branch='main')
        self.assertEqual((rc != 0, d['decision']), (True, 'refused'))


class BrokerPushTest(unittest.TestCase):
    """The gate as a registered, pinned broker workload: it runs on the host, outside the sandbox, from a real isolated
    broker and systemd unit (the path the agent uses). No GitHub: the remote is a local bare repository."""

    def test_registered_gate_pushes_clean_commits_and_refuses_secrets(self):
        import hashlib
        sys.path.insert(0, HERE)
        from test_hostd import Broker, wait_for
        b = Broker()
        self.addCleanup(b.cleanup)
        remote = os.path.join(b.tmp, 'remote.git')
        subprocess.run(['git', 'init', '-q', '--bare', '-b', 'work', remote], check=True)
        subprocess.run(['git', 'init', '-q', '-b', 'work', b.project], check=True)
        git(b.project, 'remote', 'add', 'origin', remote)
        def commit(name, content):
            with open(os.path.join(b.project, name), 'w') as f:
                f.write(content)
            git(b.project, 'add', name); git(b.project, 'commit', '-q', '-m', name)
            return git(b.project, 'rev-parse', 'HEAD')
        commit('README.md', 'start\n')
        pin = {p: hashlib.sha256(open(p, 'rb').read()).hexdigest() for p in (GATE, os.path.join(HERE, 'gitleaks.toml'))}
        b.config({'classes': {'observe': 'allow', 'workload': 'allow'}, 'workloads': {'git-push': {
            'argv': [sys.executable, GATE, '--remote-url', remote, '--branches', '^work$', '{project}', '{branch}'],
            'params': {'branch': '^[A-Za-z0-9._/-]{1,100}$'}, 'max_s': 120, 'pin': pin}}})
        b.start()
        grant = b.open_session()
        def push(branch='work'):
            out = b.raw({'op': 'mutate_v2', 'action': 'workload_run', 'grant': grant,
                         'args': {'workload': 'git-push', 'params': {'branch': branch}}})
            self.assertTrue(out['ok'], out)
            wid = out['result']['id']
            end = wait_for(lambda: (lambda s: s if s['state'] not in ('launching', 'starting', 'running') else None)(
                b.raw({'op': 'workload_status', 'grant': grant, 'id': wid})['result']), timeout=60)
            return end['result']['rc'], json.loads(end['output_tail'][-1])
        head = commit('code.py', 'print("ok")\n')
        rc, d = push()
        self.assertEqual((rc, d['decision']), (0, 'pushed'))
        self.assertEqual(subprocess.run(['git', '--git-dir', remote, 'rev-parse', 'work'], capture_output=True, text=True).stdout.strip(), head)
        commit('config.py', f'TOKEN = "{TOKEN}"\n')
        rc, d = push()
        self.assertEqual((rc, d['decision']), (1, 'refused'))
        self.assertEqual(subprocess.run(['git', '--git-dir', remote, 'rev-parse', 'work'], capture_output=True, text=True).stdout.strip(), head)
        self.assertEqual(push('main')[1]['decision'], 'refused')


if __name__ == '__main__':
    unittest.main()
