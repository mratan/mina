// One OS scope per launcher. Receipts describe local processes, never host-job authority.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir, totalmem, availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { noExpandArgs } from './systemd-run.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const instanceDirectory = (env = process.env) => join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'mina', 'instances');
const bootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const systemctl = (args) => execFileSync('/usr/bin/systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 10_000,
  env: { PATH: '/usr/bin:/bin', HOME: homedir(), XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) } });

// maxWallS is opt-in: by default an instance has no wall-clock deadline, so long-running goals are not cut off.
const OPTIONAL_LIMITS = ['maxWallS'];

export function instanceLimits(overrides = {}) {
  const defaults = { memoryBytes: Math.min(32 * 1024 ** 3, Math.floor(totalmem() / 2)),
    cpuPercent: Math.min(8, availableParallelism()) * 100, maxProcesses: 1024 };
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Instance limits must be an object.');
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in defaults || OPTIONAL_LIMITS.includes(key)) || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid instance limit ${key}: positive integers required.`);
  }
  return { ...defaults, ...overrides };
}

export function writeInstance(instance, extra = {}) {
  const data = { ...instance, ...extra };
  const temporary = `${instance.file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, instance.file);
  return data;
}

export const artifactDirectory = (env = process.env) => join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'mina', 'artifacts');

export function createInstance({ cwd, stateDir = instanceDirectory(), artifactBase = join(stateDir, 'artifacts'), limits = {} }) {
  const id = randomUUID();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const workerHome = join(stateDir, `${id}.home`);
  mkdirSync(workerHome, { mode: 0o700 });
  const workerOutputs = join(artifactBase, id);
  mkdirSync(workerOutputs, { recursive: true, mode: 0o700 });
  const instance = { id, unit: `mina-${id}.scope`, file: join(stateDir, `${id}.json`), workerHome, workerOutputs, cwd: resolve(cwd),
    bootId: bootId(), limits: instanceLimits(limits), openedAt: new Date().toISOString(), status: 'launching' };
  return writeInstance(instance);
}

export function loadInstance(id, stateDir = instanceDirectory()) {
  if (!UUID.test(id ?? '')) throw new Error('Invalid mina instance ID.');
  const file = join(stateDir, `${id}.json`);
  const instance = JSON.parse(readFileSync(file, 'utf8'));
  if (instance.id !== id || instance.unit !== `mina-${id}.scope` || instance.file !== file) throw new Error('Instance identity does not match its receipt.');
  return instance;
}

function validateIdentity(instance) {
  if (!UUID.test(instance?.id ?? '') || instance.unit !== `mina-${instance.id}.scope`) throw new Error('Invalid mina scope identity.');
}

export function scopeCommand(instance, command) {
  validateIdentity(instance);
  const limits = instanceLimits(instance.limits);
  return ['/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--collect', ...noExpandArgs('/usr/bin/systemd-run'),
    '--slice=app-mina.slice', `--unit=${instance.unit}`, `--property=MemoryMax=${limits.memoryBytes}`,
    `--property=CPUQuota=${limits.cpuPercent}%`, `--property=TasksMax=${limits.maxProcesses}`,
    ...(limits.maxWallS ? [`--property=RuntimeMaxSec=${limits.maxWallS}`] : []), '--property=TimeoutStopSec=2', '--', ...command];
}

export function inspectInstance(instance) {
  validateIdentity(instance);
  if (instance.bootId !== bootId()) return { alive: false, state: 'absent', reason: 'boot changed' };
  const raw = systemctl(['show', instance.unit, '--property=LoadState,ActiveState,ControlGroup']);
  const state = Object.fromEntries(raw.trim().split('\n').map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (state.LoadState === 'not-found' || ['inactive', 'failed'].includes(state.ActiveState)) {
    return { alive: false, state: state.ActiveState || 'absent' };
  }
  if (!state.ControlGroup || !state.ControlGroup.endsWith(`/${instance.unit}`)) throw new Error('Cannot verify the owned instance cgroup.');
  let events;
  try { events = readFileSync(join('/sys/fs/cgroup', state.ControlGroup, 'cgroup.events'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') {
      const fresh = systemctl(['show', instance.unit, '--property=LoadState,ActiveState']);
      if (/LoadState=not-found|ActiveState=(inactive|failed)/.test(fresh)) return { alive: false, state: 'absent' };
    }
    throw error;
  }
  return { alive: /populated 1/.test(events), state: state.ActiveState, cgroup: state.ControlGroup };
}

export async function stopInstance(instance) {
  validateIdentity(instance);
  let status = inspectInstance(instance);
  if (status.alive) {
    // Explicit stop-work is different from accidental exit. Only this UUID-named local scope is selected.
    // --kill-who: systemd 252 renamed it --kill-whom and still accepts the old name; systemd 247 (Debian 11) knows only this one.
    try { systemctl(['kill', '--kill-who=all', '--signal=SIGKILL', instance.unit]); }
    catch (error) { if (inspectInstance(instance).alive) throw error; }
    for (let i = 0; i < 40; i++) {
      status = inspectInstance(instance);
      if (!status.alive) break;
      await delay(50);
    }
  }
  if (status.alive) throw new Error('Local stop is unverified; owned processes remain.');
  writeInstance(instance, { status: 'stopped', observedAt: new Date().toISOString(), observation: status });
  return status;
}
