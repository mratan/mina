#!/usr/bin/env python3
"""The host policy of mina's engineering-host profile (~/.config/mina/host.json, docs/host-profile.md).

One implementation of the policy's schema check, of its changes, of their diff and risk flags, and of its atomic write.
Two callers use it, so they follow the same rules:

  mina host ...           the owner's commands in a terminal (this file is their implementation; bin/mina.mjs runs it)
  policy_propose          the agent's proposal in a session: the broker (hostd.py) validates it, shows the user the diff
                          in the request-bound confirmation dialog, and writes only after the user approves

The broker reads the policy on each request, so a written change applies to the next request without a restart.
Standard library only. Run it with python3 -I.

usage: policy.py discover [--json]
       policy.py show [PROJECT] [--json]
       policy.py validate
       policy.py apply FILE|- [--project PATH] [--dry-run] [--yes]
       policy.py edit [--yes]
Exit codes: 0 ok, 1 refused or failed, 2 usage.
"""
import argparse
import copy
import datetime
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hostlib  # noqa: E402
from budgets import limits as budget_limits  # noqa: E402

POLICY_PROTOCOL = 'mina-policy-v1'
CLASSES = ('observe', 'reserve', 'workload', 'restart', 'monitor', 'policy')
LEVELS = ('allow', 'ask', 'deny')
NETWORKS = ('offline', 'open')
BACKUPS_KEPT = 10
# Folders that never get the defaults: credentials and mina's own configuration and state (relative to the home folder).
NO_DEFAULTS = ['.ssh', '.gnupg', '.aws', '.docker', '.config/gh', '.config/mina', '.local/state/mina']


def config_path(env=None):
    env = os.environ if env is None else env
    return os.path.expanduser(env.get('MINA_HOST_CONFIG', '~/.config/mina/host.json'))


def state_path(env=None):
    env = os.environ if env is None else env
    return os.path.expanduser(env.get('MINA_HOST_STATE', '~/.local/state/mina/hostd'))


class PolicyError(Exception):
    """A change or a write that is refused: nothing was written."""


class PolicyConflict(PolicyError):
    """The policy file changed after it was read: nothing was written."""


# --- shared per-field rules (the broker uses the same functions at run time) ------------------------------------------


def default_level(cls):
    """The level of a class that the policy does not set. A policy change always needs the user, so "policy" is ask."""
    return {'observe': 'allow', 'policy': 'ask'}.get(cls, 'deny')


def max_s_problem(v):
    return None if type(v) is int and v >= 1 else 'max_s must be a positive integer.'


def queue_s_problem(v):
    return None if type(v) is int and v >= 0 else 'queue_s must be a nonnegative integer.'


def network_problem(v):
    if v in NETWORKS:
        return None
    return f'workload sandbox network must be "offline" (the default) or "open", not {v!r}'


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


def template(cfg):
    """The defaults as a project entry: without "roots" and "services" (a service belongs to one project)."""
    d = cfg.get('defaults')
    return {k: copy.deepcopy(v) for k, v in d.items() if k not in ('roots', 'services')} if isinstance(d, dict) else None


def entry_for(cfg, project):
    """(entry, source): the project's own entry in "projects" (source 'project'); else the "defaults" template when the
    project is strictly inside one of its roots (source 'defaults'); else (None, None). No merging."""
    projects = cfg.get('projects')
    entry = projects.get(project) if isinstance(projects, dict) else None
    if entry is not None:
        return entry, 'project'
    d = cfg.get('defaults')
    if isinstance(d, dict) and defaults_root(project, d.get('roots')):
        return template(cfg), 'defaults'
    return None, None


def machine_resources(cfg):
    r = cfg.get('resources')
    return r if isinstance(r, dict) else {}


def effective_resources(cfg, entry):
    """The machine resources overlaid by the entry's own: an own entry with the same name replaces the machine entry."""
    own = (entry or {}).get('resources')
    return {**machine_resources(cfg), **(own if isinstance(own, dict) else {})}


def resource_sources(cfg, entry, source):
    own = (entry or {}).get('resources')
    return {**{n: 'machine' for n in machine_resources(cfg)}, **{n: source for n in (own if isinstance(own, dict) else {})}}


def _obj(v):
    return v if isinstance(v, dict) else {}


def level_of(entry, cls):
    lvl = _obj(_obj(entry).get('classes')).get(cls, default_level(cls))
    return 'ask' if cls == 'policy' and lvl == 'allow' else lvl


def canonical_project(p):
    if not isinstance(p, str) or not p or not (os.path.isabs(p) or p.startswith('~')):
        raise PolicyError(f'project must be an absolute path, not {p!r}')
    return os.path.realpath(os.path.expanduser(p))


def project_root(cwd):
    """The git top level of a folder, else the folder (as the launcher finds the project)."""
    try:
        r = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd,
                            'rev-parse', '--show-toplevel'], capture_output=True, text=True, timeout=10,
                           env={'PATH': '/usr/bin:/bin', 'HOME': os.path.expanduser('~')})
        if r.returncode == 0 and r.stdout.strip():
            return os.path.realpath(r.stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        pass
    return os.path.realpath(cwd)


# --- paths and rendering --------------------------------------------------------------------------------------------

IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_-]*\Z')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z')
WIDTH = 100


def where(path):
    out = ''
    for k in path:
        if isinstance(k, int):
            out += f'[{k}]'
        elif IDENT.match(k):
            out += ('.' if out else '') + k
        else:
            out += f'[{json.dumps(k)}]'
    return out or '(top level)'


def q(v):
    """A value quoted for a dialog or a terminal: JSON with every non-ASCII and control character escaped."""
    return json.dumps(v, sort_keys=True)


def same(a, b):
    return q(a) == q(b)


def render(v, indent=0, used=0):
    """Stable lines for a JSON value: sorted keys; a value that fits in one line stays on one line. indent is the
    indentation of the value's own lines; used is the width already taken in front of its first line."""
    one = q(v)
    if not isinstance(v, (dict, list)) or not v or indent + used + len(one) <= WIDTH:
        return [one]
    is_dict = isinstance(v, dict)
    items = sorted(v.items()) if is_dict else list(enumerate(v))
    inner = ' ' * (indent + 1)
    out = ['{' if is_dict else '[']
    for i, (k, x) in enumerate(items):
        head = f'{q(k)}: ' if is_dict else ''
        sub = render(x, indent + 1, len(head))
        sub = [inner + head + sub[0]] + sub[1:]
        if i < len(items) - 1:
            sub[-1] += ','
        out += sub
    out.append(' ' * indent + ('}' if is_dict else ']'))
    return out


def safe_text(s):
    """Text from the agent, made safe for a terminal dialog: control, format and bidirectional characters escaped."""
    return ''.join(c if c.isprintable() else f'\\u{ord(c):04x}' for c in str(s))


# --- the schema check -----------------------------------------------------------------------------------------------

TOP_KEYS = {'version', 'resources', 'projects', 'defaults', 'alarm_command', 'alarm_external_after_s'}
ENTRY_KEYS = {'classes', 'resources', 'workloads', 'services', 'monitor_paths', 'max_reserve_s', 'max_monitors',
              'max_monitor_ttl_s', 'instance_budget', 'description'}
RESOURCE_KEYS = {'locks', 'lockouts', 'requires_active', 'device', 'protocol_source', 'description'}
LOCK_KEYS = {'path', 'turnstile', 'mode'}
DEVICE_KEYS = {'nvidia', 'kfd'}
WORKLOAD_KEYS = {'argv', 'params', 'max_s', 'queue_s', 'resources', 'sandbox', 'command_sandbox', 'pin', 'env', 'cwd',
                 'delegate', 'cleanup', 'requires_fresh', 'instance_budget', 'description'}
SANDBOX_KEYS = {'write', 'readonly', 'hide', 'network'}
SERVICE_KEYS = {'unit', 'restart', 'sources', 'source_root', 'process_match', 'restart_requires_idle', 'logs', 'health',
                'restart_timeout_s', 'settle_s', 'description'}
HEALTH_KEYS = {'log', 'pattern', 'fail_pattern', 'timeout_s', 'stable_s'}
SHA256 = re.compile(r'[0-9a-f]{64}\Z')


class _Report:
    def __init__(self):
        self.errors, self.warnings = [], []

    def err(self, path, msg):
        self.errors.append(f'{where(path)}: {msg}')

    def warn(self, path, msg):
        self.warnings.append(f'{where(path)}: {msg}')

    def unknown(self, path, obj, known):
        for k in sorted(set(obj) - known, key=str):
            self.warn(path + [k], 'unknown key (ignored by this broker)')


def _strings(v):
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def _abs_paths(rep, path, v, what='an absolute path'):
    if not _strings(v):
        rep.err(path, f'must be a list of strings ({what} each)')
        return
    for i, p in enumerate(v):
        if not os.path.isabs(os.path.expanduser(p)):
            rep.err(path + [i], f'must be {what}, not {p!r}')


def _number(rep, path, v, minimum=0, integer=False):
    if isinstance(v, bool) or not isinstance(v, int if integer else (int, float)) or v < minimum:
        rep.err(path, f'must be {"an integer" if integer else "a number"} of {minimum} or more')


def _resource(rep, path, r):
    if not isinstance(r, dict):
        rep.err(path, 'a resource must be an object')
        return
    rep.unknown(path, r, RESOURCE_KEYS)
    locks = r.get('locks', [])
    if not isinstance(locks, list):
        rep.err(path + ['locks'], 'must be a list of lock entries')
        locks = []
    if not locks:
        rep.warn(path + ['locks'], 'no lock entries: the resource coordinates nothing')
    for i, e in enumerate(locks):
        lp = path + ['locks', i]
        if not isinstance(e, dict):
            rep.err(lp, 'a lock entry must be an object {path, turnstile?, mode?}')
            continue
        rep.unknown(lp, e, LOCK_KEYS)
        for k in ('path', 'turnstile'):
            if k in e and not (isinstance(e[k], str) and os.path.isabs(e[k])):
                rep.err(lp + [k], 'must be an absolute path')
        if 'path' not in e:
            rep.err(lp, 'needs "path"')
        try:
            hostlib.lock_mode(e)
        except ValueError as err:
            rep.err(lp + ['mode'], str(err).split(': ', 1)[-1])
    if 'lockouts' in r:
        _abs_paths(rep, path + ['lockouts'], r['lockouts'])
    if 'requires_active' in r and not _strings(r['requires_active']):
        rep.err(path + ['requires_active'], 'must be a list of unit names')
    if 'protocol_source' in r and not (isinstance(r['protocol_source'], str) and os.path.isabs(r['protocol_source'])):
        rep.err(path + ['protocol_source'], 'must be an absolute path')
    if 'device' in r:
        d = r['device']
        if not isinstance(d, dict):
            rep.err(path + ['device'], 'must be {"nvidia": [bus IDs]} or {"kfd": true}')
            return
        # An unknown device key would be ignored: the broker would then not examine the GPU users (false exclusivity).
        for k in sorted(set(d) - DEVICE_KEYS):
            rep.err(path + ['device', k], 'unknown device kind: the broker would not examine its users (use "nvidia" or "kfd")')
        if 'nvidia' in d and not (_strings(d['nvidia']) and d['nvidia']):
            rep.err(path + ['device', 'nvidia'], 'must be a nonempty list of PCI bus IDs')
        if 'kfd' in d and d['kfd'] is not True:
            rep.err(path + ['device', 'kfd'], 'must be true')
        if not d:
            rep.warn(path + ['device'], 'empty: no GPU users are examined')


def _resources(rep, path, rs):
    if not isinstance(rs, dict):
        rep.err(path, 'must be an object of named resources')
        return
    for name, r in rs.items():
        if not NAME.match(name):
            rep.warn(path + [name], 'unusual resource name (use letters, digits, "_", "." or "-")')
        _resource(rep, path + [name], r)


def _workload(rep, path, w, names, services, is_defaults):
    if not isinstance(w, dict):
        rep.err(path, 'a workload must be an object')
        return
    rep.unknown(path, w, WORKLOAD_KEYS)
    argv = w.get('argv')
    if not (_strings(argv) and argv):
        rep.err(path + ['argv'], 'needs a nonempty list of strings')
        argv = []
    if 'params' in w:
        params = w['params']
        if not isinstance(params, dict):
            rep.err(path + ['params'], 'must be an object {name: pattern}')
        else:
            for k, pat in params.items():
                if k in ('project', 'max_s', 'command'):
                    rep.err(path + ['params', k], 'reserved placeholder name')
                if not isinstance(pat, str):
                    rep.err(path + ['params', k], 'the pattern must be a string')
                    continue
                try:
                    re.compile(pat)
                except re.error as e:
                    rep.err(path + ['params', k], f'the pattern does not compile: {e}')
    if 'max_s' in w and max_s_problem(w['max_s']):
        rep.err(path + ['max_s'], max_s_problem(w['max_s']))
    if 'queue_s' in w and queue_s_problem(w['queue_s']):
        rep.err(path + ['queue_s'], queue_s_problem(w['queue_s']))
    if 'resources' in w:
        if not _strings(w['resources']):
            rep.err(path + ['resources'], 'must be a list of resource names')
        else:
            for n in w['resources']:
                if n not in names:
                    rep.err(path + ['resources'], f'names {n!r}, which is not in the resources of this policy (machine or own)')
    if 'sandbox' in w:
        sb = w['sandbox']
        if not isinstance(sb, dict):
            rep.err(path + ['sandbox'], 'must be an object {write, readonly, hide, network}')
        else:
            rep.unknown(path + ['sandbox'], sb, SANDBOX_KEYS)
            for k in ('write', 'readonly', 'hide'):
                if k in sb and not _strings(sb[k]):
                    rep.err(path + ['sandbox', k], 'must be a list of paths')
            if 'network' in sb and network_problem(sb['network']):
                rep.err(path + ['sandbox', 'network'], network_problem(sb['network']))
        if '{command}' not in argv:
            rep.warn(path + ['sandbox'], 'applies only to a workload that takes {command}')
    for k in ('command_sandbox', 'delegate'):
        if k in w and not isinstance(w[k], bool):
            rep.err(path + [k], 'must be true or false')
    if 'pin' in w:
        pin = w['pin']
        if not isinstance(pin, dict):
            rep.err(path + ['pin'], 'must be an object {path: sha256}')
        else:
            for f, h in pin.items():
                if not (isinstance(h, str) and SHA256.match(h)):
                    rep.err(path + ['pin', f], 'must be a SHA-256 in lowercase hex (64 characters)')
                if not os.path.isabs(f.replace('{project}', '/p')):
                    rep.err(path + ['pin', f], 'the pinned file must be an absolute path (or start with {project})')
    if 'env' in w:
        env = w['env']
        if not isinstance(env, dict) or not all(isinstance(v, (str, int, float)) and not isinstance(v, bool) for v in env.values()):
            rep.err(path + ['env'], 'must be an object of strings')
    if 'cwd' in w and not isinstance(w['cwd'], str):
        rep.err(path + ['cwd'], 'must be a path')
    if 'cleanup' in w and not (_strings(w['cleanup']) and w['cleanup']):
        rep.err(path + ['cleanup'], 'must be a nonempty argv list')
    if 'requires_fresh' in w:
        if not _strings(w['requires_fresh']):
            rep.err(path + ['requires_fresh'], 'must be a list of service names')
        elif is_defaults and w['requires_fresh']:
            rep.warn(path + ['requires_fresh'], 'cannot work in the defaults: the defaults have no services')
        else:
            for s in w['requires_fresh']:
                if s not in services:
                    rep.err(path + ['requires_fresh'], f'names {s!r}, which is not a service of this project')
    if 'instance_budget' in w:
        try:
            budget_limits(w)
        except ValueError as e:
            rep.err(path + ['instance_budget'], str(e))
    if 'description' in w and not isinstance(w['description'], str):
        rep.err(path + ['description'], 'must be a string')


def _service(rep, path, s, names):
    if not isinstance(s, dict):
        rep.err(path, 'a service must be an object')
        return
    rep.unknown(path, s, SERVICE_KEYS)
    if not isinstance(s.get('unit'), str) or not s.get('unit'):
        rep.err(path + ['unit'], 'needs the systemd unit name')
    if 'restart' in s and s['restart'] not in LEVELS:
        rep.err(path + ['restart'], f'must be one of {list(LEVELS)}')
    for k in ('sources', 'logs'):
        if k in s and not _strings(s[k]):
            rep.err(path + [k], 'must be a list of paths')
    for k in ('source_root', 'process_match'):
        if k in s and not isinstance(s[k], str):
            rep.err(path + [k], 'must be a string')
    if 'restart_requires_idle' in s:
        if not _strings(s['restart_requires_idle']):
            rep.err(path + ['restart_requires_idle'], 'must be a list of resource names')
        else:
            for n in s['restart_requires_idle']:
                if n not in names:
                    rep.err(path + ['restart_requires_idle'], f'names {n!r}, which is not in the resources of this policy')
    for k in ('restart_timeout_s', 'settle_s'):
        if k in s:
            _number(rep, path + [k], s[k])
    if 'health' in s:
        h = s['health']
        if not isinstance(h, dict):
            rep.err(path + ['health'], 'must be an object')
            return
        rep.unknown(path + ['health'], h, HEALTH_KEYS)
        if 'log' in h and not isinstance(h['log'], str):
            rep.err(path + ['health', 'log'], 'must be a path')
        if h.get('log') and 'pattern' not in h:
            rep.err(path + ['health'], 'a health log needs a "pattern"')
        for k in ('pattern', 'fail_pattern'):
            if k in h:
                try:
                    re.compile(str(h[k]).replace('{pid}', '1'))
                except re.error as e:
                    rep.err(path + ['health', k], f'does not compile: {e}')
        for k in ('timeout_s', 'stable_s'):
            if k in h:
                _number(rep, path + ['health', k], h[k])


def _entry(rep, path, entry, cfg, is_defaults=False):
    if not isinstance(entry, dict):
        rep.err(path, 'must be an object')
        return
    rep.unknown(path, entry, ENTRY_KEYS | ({'roots'} if is_defaults else set()))
    classes = entry.get('classes', {})
    if not isinstance(classes, dict):
        rep.err(path + ['classes'], 'must be an object {class: level}')
    else:
        for cls, lvl in classes.items():
            if cls not in CLASSES:
                rep.warn(path + ['classes', cls], f'unknown class (known: {list(CLASSES)})')
            if lvl not in LEVELS:
                rep.err(path + ['classes', cls], f'must be one of {list(LEVELS)}, not {lvl!r}')
            if cls == 'policy' and lvl == 'allow':
                rep.warn(path + ['classes', 'policy'], '"allow" is treated as "ask": a policy change always needs the user')
    own = entry.get('resources', {})
    if 'resources' in entry:
        _resources(rep, path + ['resources'], own)
    names = set(machine_resources(cfg)) | set(own if isinstance(own, dict) else {})
    services = entry.get('services', {})
    if 'services' in entry:
        if is_defaults:
            rep.err(path + ['services'], 'the defaults cannot have services (a service belongs to one project); register the project instead')
        elif not isinstance(services, dict):
            rep.err(path + ['services'], 'must be an object of named services')
        else:
            for name, s in services.items():
                _service(rep, path + ['services', name], s, names)
    if is_defaults or not isinstance(services, dict):
        services = {}
    workloads = entry.get('workloads', {})
    if not isinstance(workloads, dict):
        rep.err(path + ['workloads'], 'must be an object of named workloads')
    else:
        for name, w in workloads.items():
            if not NAME.match(name):
                rep.warn(path + ['workloads', name], 'unusual workload name (use letters, digits, "_", "." or "-")')
            _workload(rep, path + ['workloads', name], w, names, services, is_defaults)
    if 'monitor_paths' in entry:
        _abs_paths(rep, path + ['monitor_paths'], entry['monitor_paths'])
    for k, minimum in (('max_reserve_s', 1), ('max_monitors', 0), ('max_monitor_ttl_s', 1)):
        if k in entry:
            _number(rep, path + [k], entry[k], minimum, integer=True)
    if 'instance_budget' in entry:
        try:
            budget_limits(entry)
        except ValueError as e:
            rep.err(path + ['instance_budget'], str(e))


def check(cfg):
    """(errors, warnings) for a whole policy. An unknown key is a warning (a newer broker can know it), unless the
    broker would misbehave with it."""
    rep = _Report()
    if not isinstance(cfg, dict):
        rep.err([], 'the policy must be a JSON object')
        return rep.errors, rep.warnings
    rep.unknown([], cfg, TOP_KEYS)
    if 'version' not in cfg:
        rep.warn(['version'], 'missing (use 1)')
    elif cfg['version'] != 1 or isinstance(cfg['version'], bool):
        rep.err(['version'], f'must be 1, not {cfg["version"]!r}')
    if 'resources' in cfg:
        _resources(rep, ['resources'], cfg['resources'])
    projects = cfg.get('projects', {})
    if not isinstance(projects, dict):
        rep.err(['projects'], 'must be an object {absolute project path: entry}')
    else:
        for p, entry in projects.items():
            if not os.path.isabs(p):
                rep.err(['projects', p], 'the key must be an absolute path')
            elif os.path.realpath(p) != p:
                rep.warn(['projects', p], f'not a real path: the broker looks the project up as {os.path.realpath(p)}')
            _entry(rep, ['projects', p], entry, cfg)
    if 'defaults' in cfg:
        d = cfg['defaults']
        _entry(rep, ['defaults'], d, cfg, is_defaults=True)
        if isinstance(d, dict):
            roots = d.get('roots')
            if not _strings(roots) or not roots:
                rep.err(['defaults', 'roots'], 'needs a nonempty list of folders (absolute, or starting with ~)')
            else:
                for i, r in enumerate(roots):
                    if not os.path.isabs(os.path.expanduser(r)):
                        rep.err(['defaults', 'roots', i], f'must be absolute or start with ~, not {r!r}')
                    elif os.path.realpath(os.path.expanduser(r)) == '/':
                        rep.warn(['defaults', 'roots', i], 'a root of / is ignored')
    if 'alarm_command' in cfg and not (_strings(cfg['alarm_command']) and cfg['alarm_command']):
        rep.err(['alarm_command'], 'must be a nonempty argv list')
    if 'alarm_external_after_s' in cfg:
        _number(rep, ['alarm_external_after_s'], cfg['alarm_external_after_s'])
    return rep.errors, rep.warnings


def validate(cfg):
    """The errors of a whole policy (empty: it is valid)."""
    return check(cfg)[0]


# --- changes --------------------------------------------------------------------------------------------------------

KINDS = ('resource_set', 'resource_remove', 'project_register', 'project_remove', 'workload_set', 'workload_remove',
         'classes_set', 'defaults_set', 'defaults_remove', 'monitor_paths_set', 'raw_set', 'raw_remove')
CHANGE_KEYS = {'resource_set': {'scope', 'project', 'name', 'resource'}, 'resource_remove': {'scope', 'project', 'name'},
               'project_register': {'project', 'entry'}, 'project_remove': {'project'},
               'workload_set': {'project', 'name', 'workload'}, 'workload_remove': {'project', 'name'},
               'classes_set': {'project', 'classes'}, 'defaults_set': {'defaults'}, 'defaults_remove': set(),
               'monitor_paths_set': {'project', 'paths'}, 'raw_set': {'path', 'value'}, 'raw_remove': {'path'}}
PROJECT_SCOPED = ('resource_set', 'resource_remove', 'workload_set', 'workload_remove', 'classes_set', 'monitor_paths_set')


def parse_changes(data):
    """A change list: a JSON array of changes, or one change object."""
    changes = data if isinstance(data, list) else [data]
    if not changes:
        raise PolicyError('the change list is empty')
    for i, c in enumerate(changes):
        if not isinstance(c, dict) or c.get('kind') not in KINDS:
            raise PolicyError(f'change {i}: needs "kind", one of {list(KINDS)}')
        extra = set(c) - CHANGE_KEYS[c['kind']] - {'kind'}
        if extra:
            raise PolicyError(f'change {i} ({c["kind"]}): unknown fields {sorted(extra)}')
    return changes


def _target(c, default_project):
    p = c.get('project', default_project)
    if p is None:
        raise PolicyError(f'{c["kind"]} needs "project"')
    return canonical_project(p)


def _register(cfg, project, notes, entry=None):
    projects = cfg.setdefault('projects', {})
    if not isinstance(projects, dict):
        raise PolicyError('"projects" is not an object')
    if project in projects:
        return projects[project]
    if entry is None:
        _old, source = entry_for(cfg, project)
        if source == 'defaults':
            notes.append(f'{q(project)} got the defaults: this change registers it with a copy of the defaults first '
                         '(its own entry then replaces the defaults for it; the defaults do not change).')
            entry = template(cfg)
        else:
            notes.append(f'{q(project)} had no host policy: this change registers it with an empty entry first.')
            entry = {}
    projects[project] = entry
    return entry


def _named(container, key, what):
    obj = container.setdefault(key, {})
    if not isinstance(obj, dict):
        raise PolicyError(f'{what} is not an object')
    return obj


def apply_changes(cfg, changes, project=None):
    """(new policy, notes): the changes applied in order to a copy. project is the default for project-scoped changes
    without "project". A project-scoped change to a project that is not registered registers it first (with a copy of
    the defaults if it gets them), because a change to the defaults would change every project under their roots."""
    new = copy.deepcopy(cfg) if isinstance(cfg, dict) else {}
    notes = []
    for i, c in enumerate(parse_changes(changes)):
        kind = c['kind']
        try:
            if kind in ('resource_set', 'resource_remove'):
                scope = c.get('scope')
                if scope not in ('machine', 'project'):
                    raise PolicyError('"scope" must be "machine" or "project"')
                if not isinstance(c.get('name'), str) or not c['name']:
                    raise PolicyError('needs "name"')
                if scope == 'machine':
                    if 'project' in c:
                        raise PolicyError('a machine resource has no "project"')
                    rs = _named(new, 'resources', '"resources"')
                else:
                    entry = _register(new, _target(c, project), notes)
                    rs = _named(entry, 'resources', 'the project\'s "resources"')
                if kind == 'resource_set':
                    if not isinstance(c.get('resource'), dict):
                        raise PolicyError('needs "resource", an object')
                    rs[c['name']] = copy.deepcopy(c['resource'])
                elif c['name'] in rs:
                    del rs[c['name']]
                else:
                    raise PolicyError(f'no {scope} resource {q(c["name"])}')
            elif kind == 'project_register':
                p = _target(c, project)
                if p in (new.get('projects') or {}):
                    raise PolicyError(f'{q(p)} is registered already')
                if 'entry' in c and not isinstance(c['entry'], dict):
                    raise PolicyError('"entry" must be an object')
                entry = copy.deepcopy(c['entry']) if 'entry' in c else (template(new) or {})
                _register(new, p, notes, entry)
            elif kind == 'project_remove':
                p = _target(c, project)
                if p not in (new.get('projects') or {}):
                    raise PolicyError(f'{q(p)} is not registered')
                del new['projects'][p]
            elif kind in ('workload_set', 'workload_remove'):
                if not isinstance(c.get('name'), str) or not c['name']:
                    raise PolicyError('needs "name"')
                entry = _register(new, _target(c, project), notes)
                ws = _named(entry, 'workloads', 'the project\'s "workloads"')
                if kind == 'workload_set':
                    if not isinstance(c.get('workload'), dict):
                        raise PolicyError('needs "workload", an object')
                    ws[c['name']] = copy.deepcopy(c['workload'])
                elif c['name'] in ws:
                    del ws[c['name']]
                else:
                    raise PolicyError(f'no workload {q(c["name"])}')
            elif kind == 'classes_set':
                if not isinstance(c.get('classes'), dict) or not c['classes']:
                    raise PolicyError('needs "classes", a nonempty object {class: level}')
                entry = _register(new, _target(c, project), notes)
                _named(entry, 'classes', 'the project\'s "classes"').update(c['classes'])
            elif kind == 'monitor_paths_set':
                if not _strings(c.get('paths')):
                    raise PolicyError('needs "paths", a list of folders')
                entry = _register(new, _target(c, project), notes)
                entry['monitor_paths'] = list(c['paths'])
            elif kind == 'defaults_set':
                if not isinstance(c.get('defaults'), dict):
                    raise PolicyError('needs "defaults", an object')
                new['defaults'] = copy.deepcopy(c['defaults'])
            elif kind == 'defaults_remove':
                if 'defaults' not in new:
                    raise PolicyError('there are no defaults')
                del new['defaults']
            elif kind in ('raw_set', 'raw_remove'):
                path = c.get('path')
                if not _strings(path) or (kind == 'raw_remove' and not path):
                    raise PolicyError('"path" must be a list of keys')
                if not path:
                    if not isinstance(c.get('value'), dict):
                        raise PolicyError('the whole policy must be an object')
                    new = copy.deepcopy(c['value'])
                    continue
                obj = new
                for k in path[:-1]:
                    obj = obj.setdefault(k, {}) if kind == 'raw_set' else obj.get(k)
                    if not isinstance(obj, dict):
                        raise PolicyError(f'{where(path)}: {k} is not an object')
                if kind == 'raw_set':
                    if 'value' not in c:
                        raise PolicyError('needs "value"')
                    obj[path[-1]] = copy.deepcopy(c['value'])
                elif path[-1] in obj:
                    del obj[path[-1]]
                else:
                    raise PolicyError(f'{where(path)} does not exist')
        except PolicyError as e:
            raise PolicyError(f'change {i} ({kind}): {e}') from None
    return new, notes


def agent_refusals(cfg, changes, project):
    """Why the agent of a session on `project` may not propose these changes (empty: it may). The owner can make each
    refused change with `mina host apply`."""
    out = []
    owner = 'The owner can make this change with `mina host apply FILE` in a terminal.'
    try:
        changes = parse_changes(changes)
    except PolicyError as e:
        return [str(e)]
    machine = machine_resources(cfg)
    new_machine = set()
    for i, c in enumerate(changes):
        kind = c['kind']
        head = f'change {i} ({kind}): '
        if kind in ('raw_set', 'raw_remove'):
            out.append(head + 'raw changes (for example alarm_command, version or limits) are for the owner only. ' + owner)
            continue
        if kind in ('defaults_set', 'defaults_remove'):
            out.append(head + 'the defaults apply to every project under their roots, so only the owner changes them. ' + owner)
            continue
        if kind == 'project_remove':
            out.append(head + 'only the owner removes a project registration. ' + owner)
            continue
        if kind in ('resource_set', 'resource_remove') and c.get('scope') == 'machine':
            name = c.get('name')
            if kind == 'resource_remove' or name in machine or name in new_machine:
                out.append(head + f'the machine resource {q(name)} exists, and other projects can depend on it, so only the '
                           'owner changes or removes it. Propose a new name, or a project resource of the same name '
                           '(it replaces the machine one for this project only). ' + owner)
                continue
            if not isinstance(name, str) or not NAME.match(name):
                out.append(head + 'a new name must be 1-64 letters, digits, "_", "." or "-".')
                continue
            new_machine.add(name)
            continue
        try:
            target = _target(c, project)
        except PolicyError as e:
            out.append(head + str(e))
            continue
        if target != project:
            out.append(head + f'it changes another project ({q(target)}); a session changes only its own project. ' + owner)
            continue
        if kind in ('resource_set', 'workload_set') and not (isinstance(c.get('name'), str) and NAME.match(c['name'])):
            out.append(head + 'a name must be 1-64 letters, digits, "_", "." or "-".')
            continue
        classes = c.get('classes') if kind == 'classes_set' else ((c.get('entry') or {}).get('classes') if kind == 'project_register' else None)
        if isinstance(classes, dict) and 'policy' in classes:
            out.append(head + 'the "policy" class is the owner\'s decision. ' + owner)
            continue
    return out


# --- diff and risk flags --------------------------------------------------------------------------------------------


def diff(old, new):
    """A readable, stable, line-based diff: one "@@ path" header for each changed object, then "-" and "+" lines for
    its changed keys only. Keys are sorted; values that fit stay on one line."""
    out = []
    _diff([], old if isinstance(old, dict) else {}, new if isinstance(new, dict) else {}, out)
    return '\n'.join(out) + ('\n' if out else '')


def _diff(path, a, b, out):
    direct, nested = [], []
    for k in sorted(set(a) | set(b), key=str):
        if k not in b:
            direct.append(('-', k, a[k]))
        elif k not in a:
            direct.append(('+', k, b[k]))
        elif not same(a[k], b[k]):
            if isinstance(a[k], dict) and isinstance(b[k], dict):
                nested.append(k)
            else:
                direct += [('-', k, a[k]), ('+', k, b[k])]
    if direct:
        out.append(f'@@ {where(path)}')
        for sign, k, v in direct:
            lines = render(v, 0, len(q(k)) + 4)
            out.append(f'{sign} {q(k)}: {lines[0]}')
            out += [f'{sign} {ln}' for ln in lines[1:]]
    for k in nested:
        _diff(path + [k], a[k], b[k], out)


def _scopes(cfg_old, cfg_new):
    """[(label, old effective entry, new effective entry, old source, new source)] for every project in either policy,
    and for the defaults template."""
    out = []
    projects = set(_obj(cfg_old.get('projects'))) | set(_obj(cfg_new.get('projects')))
    for p in sorted(projects):
        (oe, os_), (ne, ns) = entry_for(cfg_old, p), entry_for(cfg_new, p)
        out.append((f'project {q(p)}', oe, ne, os_, ns))
    out.append(('the defaults', template(cfg_old), template(cfg_new), 'defaults', 'defaults'))
    return out


def _uses(entry, name):
    for w in _obj(_obj(entry).get('workloads')).values():
        if isinstance(w, dict) and isinstance(w.get('resources'), list) and name in w['resources']:
            return True
    for s in _obj(_obj(entry).get('services')).values():
        if isinstance(s, dict) and isinstance(s.get('restart_requires_idle'), list) and name in s['restart_requires_idle']:
            return True
    return False


def _lost(old_r, new_r):
    old_r, new_r = _obj(old_r), _obj(new_r)
    lost = []
    for k in ('lockouts', 'requires_active'):
        was, now = old_r.get(k), new_r.get(k)
        was, now = (was if isinstance(was, list) else []), (now if isinstance(now, list) else [])
        gone = [x for x in was if x not in now]
        if gone:
            lost.append(f'{k} {q(gone)}')
    return lost


def _locks(r):
    out = []
    for lk in _obj(r).get('locks') if isinstance(_obj(r).get('locks'), list) else []:
        if isinstance(lk, dict):
            out += [lk.get(k) for k in ('path', 'turnstile') if isinstance(lk.get(k), str)]
    return out


def _shadow_loss(machine_r, project_r):
    """What a project resource drops of the machine resource of the same name that it replaces for that project:
    the machine's locks (and turnstiles), lockouts, requires_active and device checks the project then no longer uses."""
    m, r = _obj(machine_r), _obj(project_r)
    lost = []
    locks = [x for x in _locks(m) if x not in _locks(r)]
    if locks:
        lost.append(f'locks {q(locks)}')
    for k in ('lockouts', 'requires_active'):
        was, now = m.get(k), r.get(k)
        gone = [x for x in (was if isinstance(was, list) else []) if x not in (now if isinstance(now, list) else [])]
        if gone:
            lost.append(f'{k} {q(gone)}')
    dev_m, dev_r = _obj(m.get('device')), _obj(r.get('device'))
    gone = {k: v for k, v in sorted(dev_m.items()) if not same(dev_r.get(k), v)}
    if gone:
        lost.append(f'device checks {q(gone)}')
    return lost


def _shadows(cfg, entry):
    """{name: what the project resource drops of the machine resource it replaces} for one effective entry."""
    machine = machine_resources(cfg)
    own = _obj(_obj(entry).get('resources'))
    return {name: _shadow_loss(machine[name], r) for name, r in own.items() if name in machine}


def flags(old, new):
    """Risk flags for the dialog and the terminal, from the new effective policy compared to the old."""
    old, new = (old if isinstance(old, dict) else {}), (new if isinstance(new, dict) else {})
    out = []
    # The machine resources.
    om, nm = machine_resources(old), machine_resources(new)
    for name in sorted(set(om) | set(nm)):
        if name in om and not same(om[name], nm.get(name)):
            users = [label for label, oe, _ne, _os, _ns in _scopes(old, old)
                     if isinstance(oe, dict) and name not in _obj(oe.get('resources')) and _uses(oe, name)]
            out.append(f'machine resource {q(name)} {"removed" if name not in nm else "changed"}; it applies to every project'
                       + (f', and these use it: {", ".join(users)}' if users else ''))
        if name in om and name in nm:
            lost = _lost(om[name], nm[name])
            if lost:
                out.append(f'machine resource {q(name)} loses {" and ".join(lost)}')
    for label, oe, ne, osrc, nsrc in _scopes(old, new):
        if not isinstance(ne, dict):
            continue
        # Workloads.
        ow = _obj(_obj(oe).get('workloads'))
        for name, w in sorted(_obj(ne.get('workloads')).items()):
            if not isinstance(w, dict) or same(ow.get(name), w):
                continue
            argv = w.get('argv') if isinstance(w.get('argv'), list) else []
            sb = w.get('sandbox') if isinstance(w.get('sandbox'), dict) else {}
            wl = f'workload {q(name)} in {label}'
            takes = '{command}' in argv
            if takes:
                out.append(f'{wl} runs any command (the agent\'s argv)')
            if takes and w.get('command_sandbox', True) is not False:
                if sb.get('network') == 'open':
                    out.append(f'{wl} has network "open"')
                write_ = sb.get('write') if isinstance(sb.get('write'), list) else ['{project}']
                outside = [p for p in write_ if not (p == '{project}' or str(p).startswith('{project}/'))]
                if outside:
                    out.append(f'{wl} can write outside the project: {q(outside)}')
            else:
                out.append(f'{wl} runs without the broker\'s sandbox, with your full user authority: argv {q(argv)}')
            pin = _obj(_obj(ow.get(name)).get('pin'))
            for f in sorted(pin):
                now = _obj(w.get('pin')).get(f)
                if now is None:
                    out.append(f'{wl} loses its pin of {q(f)}')
                elif now != pin[f]:
                    out.append(f'{wl} pins a new version of {q(f)}: review the file')
        # Classes.
        for cls in CLASSES:
            if cls == 'policy':
                continue
            if level_of(ne, cls) == 'allow' and level_of(oe, cls) != 'allow':
                out.append(f'class {q(cls)} becomes "allow" in {label}: no dialog for these operations')
        # A project resource that replaces (shadows) the machine resource of the same name, for this project only.
        old_shadows = _shadows(old, oe) if isinstance(oe, dict) else {}
        for name, lost in sorted(_shadows(new, ne).items()):
            if name in old_shadows and old_shadows[name] == lost:
                continue
            out.append(f'resource {q(name)} of {label} replaces the machine resource {q(name)} for this project'
                       + (f'; the project no longer uses its {", ".join(lost)}' if lost else ' (with the same locks, lockouts and checks)'))
        # Lockouts and supervisors of the project's own resources (machine ones are flagged above; shadowing just above).
        ors, nrs = effective_resources(old, oe), effective_resources(new, ne)
        osources, nsources = resource_sources(old, oe, osrc), resource_sources(new, ne, nsrc)
        for name in sorted(ors):
            if osources.get(name) == 'machine' and nsources.get(name, 'machine') in ('machine', 'project'):
                continue
            if name not in nrs:
                lost = _lost(ors[name], {})
                if lost:
                    out.append(f'resource {q(name)} of {label} is removed, with its {" and ".join(lost)}')
                continue
            lost = _lost(ors[name], nrs[name])
            if lost:
                out.append(f'resource {q(name)} of {label} loses {" and ".join(lost)}')
    if 'alarm_command' in new and not same(old.get('alarm_command'), new.get('alarm_command')):
        out.append(f'alarm_command {"changes" if "alarm_command" in old else "is new"}: the broker runs it with each alarm: {q(new["alarm_command"])}')
    if not same(old.get('defaults'), new.get('defaults')):
        if 'defaults' in new:
            out.append(f'the defaults change: this affects every project under their roots {q(_obj(new["defaults"]).get("roots"))}')
        else:
            out.append(f'the defaults are removed: projects under their roots {q(_obj(old.get("defaults")).get("roots"))} lose them')
    return list(dict.fromkeys(out))


# --- the atomic write -----------------------------------------------------------------------------------------------


def sha256_of(path):
    """The SHA-256 of the file's bytes, or None if it does not exist."""
    try:
        with open(path, 'rb') as f:
            return hashlib.sha256(f.read()).hexdigest()
    except FileNotFoundError:
        return None


def _fsync_dir(d):
    fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def backups(path):
    """The backups of this policy file, oldest first: <name>.bak-<UTC yyyymmddTHHMMSSZ>[-n] only."""
    d, base = os.path.dirname(path), os.path.basename(path)
    pattern = re.compile(re.escape(base) + r'\.bak-2\d{7}T\d{6}Z(-\d+)?\Z')
    try:
        names = [n for n in os.listdir(d) if pattern.match(n)]
    except FileNotFoundError:
        return []
    def key(n):
        stamp, _, n2 = n.rsplit('.bak-', 1)[1].partition('Z-')
        return (stamp, int(n2) if n2 else 0)
    return [os.path.join(d, n) for n in sorted(names, key=key)]


def write(path, new_cfg, expected_sha, now=None):
    """Write a new policy atomically. Refused (PolicyConflict) if the file's SHA-256 is not expected_sha (None: the
    file must not exist), and (PolicyError) if the new policy has errors. The old file is first copied to
    <name>.bak-<UTC time> (0600); the 10 newest backups are kept. The new file is 0600. Returns {sha_before,
    sha_after, backup}."""
    path = os.path.realpath(os.path.expanduser(path))
    if expected_sha is None and isinstance(new_cfg, dict) and 'version' not in new_cfg:
        new_cfg = {'version': 1, **new_cfg}     # a new host.json starts from {"version": 1}
    errors = validate(new_cfg)
    if errors:
        raise PolicyError('the new policy has errors: ' + '; '.join(errors))
    d = os.path.dirname(path)
    if not os.path.isdir(d):
        os.makedirs(d, mode=0o700)
        os.chmod(d, 0o700)
    data = (json.dumps(new_cfg, indent=1) + '\n').encode()
    dfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(dfd, fcntl.LOCK_EX)   # one writer at a time: two `mina host` commands, or one and the broker
        try:
            with open(path, 'rb') as f:
                old = f.read()
        except FileNotFoundError:
            old = None
        have = hashlib.sha256(old).hexdigest() if old is not None else None
        if have != expected_sha:
            raise PolicyConflict(f'{path} changed after it was read (sha256 {str(have)[:16]}, expected '
                                 f'{str(expected_sha)[:16]}); nothing was written. Read it again and repeat the change.')
        backup = None
        if old is not None:
            stamp = (now or datetime.datetime.now(datetime.timezone.utc)).strftime('%Y%m%dT%H%M%SZ')
            backup = f'{path}.bak-{stamp}'
            n = 0
            while True:
                try:
                    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    break
                except FileExistsError:
                    n += 1
                    backup = f'{path}.bak-{stamp}-{n}'
            with os.fdopen(fd, 'wb') as f:
                os.fchmod(f.fileno(), 0o600)
                f.write(old)
                f.flush()
                os.fsync(f.fileno())
        fd, tmp = tempfile.mkstemp(dir=d, prefix=f'.{os.path.basename(path)}.tmp-')
        try:
            with os.fdopen(fd, 'wb') as f:
                os.fchmod(f.fileno(), 0o600)
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        os.fsync(dfd)
        for old_backup in backups(path)[:-BACKUPS_KEPT]:
            os.unlink(old_backup)
    finally:
        os.close(dfd)
    return {'sha_before': have, 'sha_after': hashlib.sha256(data).hexdigest(), 'backup': backup}


NEW_POLICY = {'version': 1}


def read(path):
    """(policy, sha256) of the file; ({}, None) if it does not exist (start a new one from NEW_POLICY). Raises PolicyError if it is not a JSON object."""
    try:
        with open(path, 'rb') as f:
            raw = f.read()
    except FileNotFoundError:
        return {}, None
    try:
        cfg = json.loads(raw)
    except ValueError as e:
        raise PolicyError(f'{path} is not valid JSON: {e}') from None
    if not isinstance(cfg, dict):
        raise PolicyError(f'{path} must contain a JSON object')
    return cfg, hashlib.sha256(raw).hexdigest()


# --- inventory ------------------------------------------------------------------------------------------------------

KFD_TOPOLOGY = '/sys/class/kfd/kfd/topology/nodes'


def nvidia_gpus(env=None):
    """[{index, bus_id, name}] from nvidia-smi (MINA_HOST_NVIDIA_SMI replaces the program, for tests), and a note."""
    env = os.environ if env is None else env
    cmd = env.get('MINA_HOST_NVIDIA_SMI', 'nvidia-smi')
    try:
        r = subprocess.run([cmd, '--query-gpu=index,pci.bus_id,name', '--format=csv,noheader'],
                           capture_output=True, text=True, timeout=20)
    except FileNotFoundError:
        return [], 'nvidia-smi not found'
    except (OSError, subprocess.TimeoutExpired) as e:
        return [], f'nvidia-smi: {type(e).__name__}'
    if r.returncode != 0:
        return [], f'nvidia-smi exited {r.returncode}'
    gpus = []
    for line in r.stdout.splitlines():
        parts = [p.strip() for p in line.split(',', 2)]
        if len(parts) == 3 and parts[0].isdigit():
            gpus.append({'vendor': 'nvidia', 'index': int(parts[0]), 'bus_id': parts[1], 'name': parts[2]})
    return gpus, None


def amd_gpus(env=None):
    """[{index, bus_id, name}] from the KFD topology (MINA_HOST_KFD_TOPOLOGY replaces its folder, for tests)."""
    env = os.environ if env is None else env
    root = env.get('MINA_HOST_KFD_TOPOLOGY', KFD_TOPOLOGY)
    if not os.path.isdir(root):
        return [], f'{root} not found'
    gpus = []
    for node in sorted((n for n in os.listdir(root) if n.isdigit()), key=int):
        try:
            with open(os.path.join(root, node, 'properties')) as f:
                props = dict(line.split(None, 1) for line in f.read().splitlines() if len(line.split(None, 1)) == 2)
        except OSError:
            continue
        if props.get('simd_count', '0').strip() == '0':
            continue   # a CPU node
        name = ''
        try:
            with open(os.path.join(root, node, 'name')) as f:
                name = f.read().strip()
        except OSError:
            pass
        loc, domain = int(props.get('location_id', '0')), int(props.get('domain', '0'))
        bus = f'{domain:04x}:{(loc >> 8) & 0xff:02x}:{(loc >> 3) & 0x1f:02x}.{loc & 0x7:x}'
        gpus.append({'vendor': 'amd', 'index': len(gpus), 'kfd_node': int(node), 'bus_id': bus,
                     'name': name or f'gfx_target_version {props.get("gfx_target_version", "?").strip()}'})
    return gpus, None


def _bus(b):
    return str(b).lower()[-12:]


def inventory(cfg, project=None, env=None):
    """What the machine has, and what the policy covers (read-only). With project: only the machine resources and the
    project's effective resources (an agent's view: no other project's paths)."""
    gpus_n, note_n = nvidia_gpus(env)
    gpus_a, note_a = amd_gpus(env)
    sets = [('machine', machine_resources(cfg))]
    if project is None:
        for p, entry in sorted((cfg.get('projects') or {}).items()):
            if isinstance(entry, dict) and isinstance(entry.get('resources'), dict):
                sets.append((f'project {p}', entry['resources']))
        if isinstance(template(cfg), dict) and isinstance(template(cfg).get('resources'), dict):
            sets.append(('defaults', template(cfg)['resources']))
    else:
        entry, source = entry_for(cfg, project)
        if isinstance(entry, dict) and isinstance(entry.get('resources'), dict):
            sets.append((source, entry['resources']))
    devices = []
    for g in gpus_n + gpus_a:
        cover = []
        for label, rs in sets:
            for name, r in sorted(rs.items()):
                dev = (r or {}).get('device') if isinstance(r, dict) else None
                if not isinstance(dev, dict):
                    continue
                if g['vendor'] == 'nvidia' and _bus(g['bus_id']) in {_bus(b) for b in dev.get('nvidia') or []}:
                    cover.append(f'{label}:{name}')
                if g['vendor'] == 'amd' and dev.get('kfd') is True:
                    cover.append(f'{label}:{name}')
        devices.append({**g, 'covered_by': cover})
    locks, lockouts = {}, {}
    for label, rs in sets:
        for name, r in sorted(rs.items()):
            if not isinstance(r, dict):
                continue
            for e in r.get('locks') or []:
                if not isinstance(e, dict):
                    continue
                for key in ('path', 'turnstile'):
                    path = e.get(key)
                    if not isinstance(path, str):
                        continue
                    rec = locks.setdefault(path, {'path': path, 'exists': os.path.exists(path), 'used_by': [],
                                                  'holders': [{'pid': h['pid'], 'mode': h['mode'], 'waiting': h['waiting'],
                                                               'argv': h['argv'][:2]} for h in hostlib.lock_holders(path)]})
                    rec['used_by'].append(f'{label}:{name}' + (' turnstile' if key == 'turnstile' else f' {e.get("mode", "exclusive")}'))
            for lo in r.get('lockouts') or []:
                if isinstance(lo, str):
                    lockouts.setdefault(lo, {'path': lo, 'exists': os.path.exists(lo), 'used_by': []})['used_by'].append(f'{label}:{name}')
    notes = [n for n in (note_n, note_a) if n]
    return {'devices': devices, 'locks': list(locks.values()), 'lockouts': list(lockouts.values()), 'notes': notes,
            'kfd_resources': [f'{label}:{n}' for label, rs in sets for n, r in sorted(rs.items())
                              if isinstance(r, dict) and isinstance(r.get('device'), dict) and r['device'].get('kfd') is True]}


def suggestions(cfg, inv):
    """resource_set changes (scope machine) for the GPUs that no resource covers. The lock path is a placeholder in the
    folder of the existing lock files: replace it with the lock file that your host runners use."""
    names = set(machine_resources(cfg))
    dirs = {os.path.dirname(rec['path']) for rec in inv['locks']}
    folder = dirs.pop() if len(dirs) == 1 else '/tmp/gpu-locks'
    out = []

    def fresh(base):
        name, n = base, 1
        while name in names:
            n += 1
            name = f'{base}_{n}'
        names.add(name)
        return name

    for g in inv['devices']:
        if g['covered_by']:
            continue
        if g['vendor'] == 'nvidia':
            name = fresh(f'GPU_{g["index"]}')
            out.append({'kind': 'resource_set', 'scope': 'machine', 'name': name,
                        'resource': {'locks': [{'path': os.path.join(folder, f'{name}.lock')}], 'device': {'nvidia': [g['bus_id']]}}})
    if any(g['vendor'] == 'amd' and not g['covered_by'] for g in inv['devices']):
        name = fresh('GPU_AMD')   # the KFD process list covers all AMD GPUs together
        out.append({'kind': 'resource_set', 'scope': 'machine', 'name': name,
                    'resource': {'locks': [{'path': os.path.join(folder, f'{name}.lock')}], 'device': {'kfd': True}}})
    return out


# --- the owner's commands -------------------------------------------------------------------------------------------


def audit(rec, env=None):
    """Append a record to the broker's audit log, if its state folder exists (never create it from here)."""
    d = state_path(env)
    if not os.path.isdir(d):
        return
    rec = {'ts': datetime.datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z'), **rec}
    try:
        fd = os.open(os.path.join(d, 'audit.jsonl'), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as f:
            f.write(json.dumps(rec, default=str) + '\n')
    except OSError:
        pass


def _say(text=''):
    print(text, flush=True)


def _confirm(args):
    if args.yes:
        return True
    if not sys.stdin.isatty():
        _say('Refused: no terminal to confirm in. Repeat with --yes to apply without a question. Nothing was written.')
        return False
    try:
        return input('Apply? [y/N] ').strip().lower() in ('y', 'yes')
    except EOFError:
        return False


def _show_change(old, new, notes=()):
    errors, warnings = check(new)
    text = diff(old, new)
    for n in notes:
        _say(f'Note: {n}')
    _say(text.rstrip('\n') if text else '(no change)')
    fl = flags(old, new)
    _say('Risk flags:' if fl else 'Risk flags: none')
    for f in fl:
        _say(f'  ! {f}')
    old_errors = set(validate(old)) if old else set()
    for w in warnings:
        _say(f'warning: {w}')
    for e in errors:
        _say(f'error: {e}' + (' (already in the current file)' if e in old_errors else ''))
    return text, fl, errors


def _write_and_report(path, new, sha, via, fl, kinds):
    try:
        result = write(path, new, sha)
    except PolicyError as e:
        _say(f'Refused: {e}')
        return 1
    audit({'op': 'policy_change', 'via': via, 'kinds': kinds, 'sha_before': result['sha_before'],
           'sha_after': result['sha_after'], 'flags': fl, 'backup': result['backup']})
    _say(f'Written: {path}')
    _say(f'Backup: {result["backup"]}' if result['backup'] else 'Backup: none (the file is new)')
    _say('The broker reads the policy on each request: no restart is necessary.')
    return 0


def cmd_validate(args):
    path = config_path()
    try:
        cfg, sha = read(path)
    except PolicyError as e:
        _say(f'error: {e}')
        return 1
    if sha is None:
        _say(f'{path} does not exist: there is no host policy.')
        return 1
    errors, warnings = check(cfg)
    for w in warnings:
        _say(f'warning: {w}')
    for e in errors:
        _say(f'error: {e}')
    _say(f'{path}: {len(errors)} error(s), {len(warnings)} warning(s)')
    return 1 if errors else 0


def cmd_show(args):
    path = config_path()
    try:
        cfg, _sha = read(path)
    except PolicyError as e:
        _say(f'error: {e}')
        return 1
    project = canonical_project(os.path.abspath(args.project)) if args.project else project_root(os.getcwd())
    entry, source = entry_for(cfg, project)
    errors, warnings = check(cfg)
    if args.json:
        _say(json.dumps({'project': project, 'policy_source': source, 'entry': entry,
                         'resources': effective_resources(cfg, entry) if entry is not None else {},
                         'resource_sources': resource_sources(cfg, entry, source) if entry is not None else {},
                         'errors': errors, 'warnings': warnings}, indent=1, sort_keys=True))
        return 0
    _say(f'Project: {project}')
    root = defaults_root(project, (cfg.get('defaults') or {}).get('roots')) if source == 'defaults' else None
    _say(f'Policy source: {source or "none"}' + (f' (defaults root {root})' if root else ''))
    if entry is None:
        _say('This project has no host policy. Register it with `mina host apply` (kind project_register).')
    else:
        _say('Classes: ' + ', '.join(f'{c}={level_of(entry, c)}' for c in CLASSES))
        sources = resource_sources(cfg, entry, source)
        _say('Resources:' if effective_resources(cfg, entry) else 'Resources: none')
        for name, r in sorted(effective_resources(cfg, entry).items()):
            _say(f'  {name} ({sources[name]}): {q(r)}')
        ws = entry.get('workloads') or {}
        _say('Workloads:' if ws else 'Workloads: none')
        for name, w in sorted(ws.items()):
            _say(f'  {name}: {q(w)}')
        if entry.get('services'):
            _say('Services: ' + ', '.join(sorted(entry['services'])))
        if entry.get('monitor_paths'):
            _say(f'Monitor paths: {q(entry["monitor_paths"])}')
    _say(f'Validation of {path}: {len(errors)} error(s), {len(warnings)} warning(s)')
    for w in warnings:
        _say(f'  warning: {w}')
    for e in errors:
        _say(f'  error: {e}')
    return 0


def cmd_discover(args):
    path = config_path()
    try:
        cfg, _sha = read(path)
    except PolicyError as e:
        _say(f'error: {e}')
        return 1
    inv = inventory(cfg)
    sug = suggestions(cfg, inv)
    if args.json:
        _say(json.dumps({**inv, 'suggestions': sug}, indent=1, sort_keys=True))
        return 0
    _say('GPUs:' if inv['devices'] else 'GPUs: none found')
    for g in inv['devices']:
        _say(f'  {g["vendor"]} {g["index"]} {g["bus_id"]} {g["name"]}: '
             + (f'covered by {", ".join(g["covered_by"])}' if g['covered_by'] else 'NOT covered by a resource'))
    for n in inv['notes']:
        _say(f'  ({n})')
    _say('Lock files in the policy:' if inv['locks'] else 'Lock files in the policy: none')
    for rec in inv['locks']:
        held = ', '.join(f'pid {h["pid"]} {h["mode"]}{" waiting" if h["waiting"] else ""} {" ".join(h["argv"])}' for h in rec['holders'])
        _say(f'  {rec["path"]} ({"; ".join(rec["used_by"])}): ' + (f'held by {held}' if held else 'free' if rec['exists'] else 'not created yet'))
    _say('Lockouts:' if inv['lockouts'] else 'Lockouts: none')
    for rec in inv['lockouts']:
        _say(f'  {rec["path"]} ({"; ".join(rec["used_by"])}): {"EXISTS" if rec["exists"] else "absent"}')
    if sug:
        _say('Suggested resources for the GPUs that no resource covers (a change list for `mina host apply`).')
        _say('Replace each lock path with the lock file that your host runners use:')
        _say(json.dumps(sug, indent=1))
    return 0


def _load_changes(src):
    try:
        text = sys.stdin.read() if src == '-' else open(src).read()
    except OSError as e:
        raise PolicyError(f'cannot read {src}: {e.strerror}') from None
    try:
        return parse_changes(json.loads(text))
    except ValueError as e:
        raise PolicyError(f'{src} is not valid JSON: {e}') from None


def cmd_apply(args):
    path = config_path()
    try:
        cfg, sha = read(path)
        if sha is None:
            cfg = dict(NEW_POLICY)      # a new host.json starts from {"version": 1}
        changes = _load_changes(args.file)
        project = canonical_project(os.path.abspath(args.project)) if args.project else project_root(os.getcwd())
        new, notes = apply_changes(cfg, changes, project)
    except PolicyError as e:
        _say(f'Refused: {e}')
        return 1
    if sha is None:
        notes = [f'{path} does not exist yet: this change creates it.', *notes]
    _text, fl, errors = _show_change(cfg if sha is not None else {}, new, notes)
    if errors:
        _say('Refused: the new policy has errors. Nothing was written.')
        return 1
    if same(cfg, new):
        _say('Nothing to write: the policy does not change.')
        return 0
    if args.dry_run:
        _say('Dry run: nothing was written.')
        return 0
    if not _confirm(args):
        _say('Not applied.')
        return 1
    return _write_and_report(path, new, sha, 'mina host apply', fl, [c['kind'] for c in changes])


def cmd_edit(args):
    path = config_path()
    try:
        cfg, sha = read(path)
    except PolicyError as e:
        _say(f'Refused: {e} Correct the file, then run `mina host edit` again.')
        return 1
    if sha is None:
        cfg = dict(NEW_POLICY)
    start = cfg if sha is not None else {**NEW_POLICY, 'resources': {}, 'projects': {}}
    editor = os.environ.get('VISUAL') or os.environ.get('EDITOR') or 'vi'
    tmpdir = tempfile.mkdtemp(prefix='mina-host-edit-')
    copy_path = os.path.join(tmpdir, 'host.json')
    try:
        with open(copy_path, 'w') as f:
            f.write(json.dumps(start, indent=1) + '\n')
        while True:
            r = subprocess.run([*shlex.split(editor), copy_path])
            if r.returncode != 0:
                _say(f'The editor exited {r.returncode}. Nothing was written.')
                return 1
            problem, new = None, None
            try:
                with open(copy_path) as f:
                    new = json.load(f)
                if not isinstance(new, dict):
                    problem = 'the policy must be a JSON object'
            except ValueError as e:
                problem = f'not valid JSON: {e}'
            if problem is None:
                _text, fl, errors = _show_change(cfg, new)
                if not errors:
                    break
                problem = 'the new policy has errors'
            _say(f'Refused: {problem}.')
            if not sys.stdin.isatty() or input('Edit again? [Y/n] ').strip().lower() in ('n', 'no'):
                _say('Nothing was written.')
                return 1
        if same(cfg, new) and sha is not None:
            _say('Nothing to write: the policy does not change.')
            return 0
        if not _confirm(args):
            _say('Not applied.')
            return 1
        return _write_and_report(path, new, sha, 'mina host edit', fl, ['edit'])
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(prog='mina host', description='Show, examine and change the host policy '
                                 f'({config_path()}). The agent cannot run these commands: they need your terminal.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('discover', help='the GPUs and lock files of this machine, and what the policy covers (read-only)')
    p.add_argument('--json', action='store_true')
    p = sub.add_parser('show', help='the effective policy of a project (default: the project of this folder)')
    p.add_argument('project', nargs='?')
    p.add_argument('--json', action='store_true')
    sub.add_parser('validate', help='the errors (exit 1) and warnings of the policy')
    p = sub.add_parser('apply', help='apply a change list (a JSON file, or - for standard input)')
    p.add_argument('file')
    p.add_argument('--project', help='the project of changes without "project" (default: the project of this folder)')
    p.add_argument('--dry-run', action='store_true', help='show the diff and the risk flags only')
    p.add_argument('--yes', action='store_true', help='apply without a question (necessary without a terminal)')
    p = sub.add_parser('edit', help='edit the policy in $VISUAL or $EDITOR, then validate, show and confirm the change')
    p.add_argument('--yes', action='store_true', help='apply without a question (necessary without a terminal)')
    args = ap.parse_args(argv)
    return {'discover': cmd_discover, 'show': cmd_show, 'validate': cmd_validate, 'apply': cmd_apply,
            'edit': cmd_edit}[args.cmd](args)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
