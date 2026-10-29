#!/usr/bin/env python3
"""Push one branch to origin after checks: mina's only push path (docs/host-profile.md, "Pushing").

Runs as a registered broker workload on the host, outside every sandbox, so git uses the owner's SSH setup; the agent
never sees credentials. It refuses another remote URL, a branch outside the allowlist, a non-fast-forward push (so no
force push or history rewrite), gitleaks findings in any outgoing commit, and outgoing files over the size limit.
gitleaks runs offline with mina's own config: the repository's .gitleaks.toml, .gitleaksignore and gitleaks:allow
comments are ignored, because the agent can edit them. Prints one JSON line; findings name file, line and rule, never
the secret. This reduces accidental disclosure; it does not prove that nothing sensitive is pushed.

usage: git-push-gate.py --remote-url URL --branches REGEX [--max-mb N] [--check-only] PROJECT BRANCH
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, 'gitleaks.toml')
ENV = {'PATH': '/usr/bin:/bin', 'HOME': os.environ.get('HOME', ''), 'GIT_TERMINAL_PROMPT': '0', 'LANG': 'C.UTF-8',
       **{k: os.environ[k] for k in ('SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR') if k in os.environ}}


def git(repo, *args, check=True):
    r = subprocess.run(['/usr/bin/git', '-C', repo, *args], capture_output=True, text=True, env=ENV, timeout=240)
    if check and r.returncode:
        raise RuntimeError(f'git {args[0]} failed: {r.stderr.strip()[:300]}')
    return r


def main():
    a = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    a.add_argument('--remote-url', required=True)
    a.add_argument('--branches', required=True, help='regular expression the branch must match in full')
    a.add_argument('--max-mb', type=float, default=20)
    a.add_argument('--check-only', action='store_true')
    a.add_argument('project')
    a.add_argument('branch')
    args = a.parse_args()
    out = {'branch': args.branch}

    def done(decision, code=0, **fields):
        print(json.dumps({'decision': decision, **out, **fields}))
        sys.exit(code)

    def refuse(reason, **fields):
        done('refused', 1, reason=reason, **fields)

    try:
        repo, branch = os.path.realpath(args.project), args.branch
        if not re.fullmatch(args.branches, branch) or git(repo, 'check-ref-format', '--branch', branch, check=False).returncode:
            refuse(f'branch {branch!r} is not allowlisted for pushing')
        url = git(repo, 'remote', 'get-url', 'origin', check=False).stdout.strip()
        if url != args.remote_url:
            refuse(f'origin is {url!r}, not the registered remote')
        head = git(repo, 'rev-parse', '--verify', f'refs/heads/{branch}^{{commit}}').stdout.strip()
        fetched = git(repo, 'fetch', '--no-tags', '-q', 'origin', f'+refs/heads/{branch}:refs/remotes/origin/{branch}', check=False)
        base = git(repo, 'rev-parse', '--verify', '-q', f'refs/remotes/origin/{branch}', check=False).stdout.strip() if not fetched.returncode else ''
        if fetched.returncode and "couldn't find remote ref" not in fetched.stderr:
            refuse(f'fetch failed: {fetched.stderr.strip()[:300]}')
        if base == head:
            done('up_to_date', commits=0, to=head)
        if base and git(repo, 'merge-base', '--is-ancestor', base, head, check=False).returncode:
            refuse('not a fast-forward of the remote branch; mina never force-pushes')
        span = [f'{base}..{head}'] if base else [head, '--not', '--remotes=origin']
        commits = int(git(repo, 'rev-list', '--count', *span).stdout.strip())
        out.update({'from': base or None, 'to': head, 'commits': commits})
        # Outgoing blobs over the limit (raw data, tensors).
        objects = git(repo, 'rev-list', '--objects', *span).stdout
        sizes = subprocess.run(['/usr/bin/git', '-C', repo, 'cat-file', '--batch-check=%(objecttype) %(objectsize) %(rest)'],
                               input=objects, capture_output=True, text=True, env=ENV, check=True).stdout
        big = [f'{p} ({int(s) / 2**20:.1f} MiB)' for t, s, p in (l.split(' ', 2) for l in sizes.splitlines() if l.count(' ') >= 2)
               if t == 'blob' and int(s) > args.max_mb * 2**20]
        if big:
            refuse(f'outgoing files over {args.max_mb:g} MiB: {", ".join(big[:10])}')
        # Secrets in every outgoing commit, with mina's config only.
        with tempfile.TemporaryDirectory(prefix='mina-push-gate-') as tmp:
            report = os.path.join(tmp, 'report.json')
            log_opts = ' '.join(span)
            r = subprocess.run(['/usr/bin/gitleaks', 'git', repo, '--log-opts', log_opts, '-c', CONFIG, '-i', tmp,
                                '--ignore-gitleaks-allow', '--redact', '--no-banner', '--log-level', 'error', '--exit-code', '7',
                                '-f', 'json', '-r', report], capture_output=True, text=True, env=ENV, timeout=240)
            if r.returncode not in (0, 7):
                refuse(f'gitleaks failed (exit {r.returncode}): {r.stderr.strip()[-300:]}')
            leaks = json.load(open(report)) if os.path.exists(report) and os.path.getsize(report) else []
        if r.returncode == 7 or leaks:
            refuse('possible secrets in outgoing commits; remove them from history before pushing',
                   findings=[{'file': f.get('File'), 'line': f.get('StartLine'), 'rule': f.get('RuleID'), 'commit': f.get('Commit', '')[:12]}
                             for f in leaks[:20]])
        if args.check_only:
            done('checked')
        pushed = git(repo, 'push', '--porcelain', 'origin', f'refs/heads/{branch}:refs/heads/{branch}', check=False)
        if pushed.returncode:
            refuse(f'push failed: {pushed.stderr.strip()[:300]}')
        done('pushed')
    except SystemExit:
        raise
    except Exception as e:  # fail closed
        refuse(f'{type(e).__name__}: {e}')


if __name__ == '__main__':
    main()
