// The local limits of an instance on macOS (docs/macos.md). On Linux the systemd scope enforces them in the kernel:
// MemoryMax, CPUQuota, TasksMax and RuntimeMaxSec. macOS has no cgroups, so the supervisor checks the members of the
// instance's coalitions (the instance job and its call jobs) and acts as the kernel would:
// - memory above the limit: the largest process is killed, as the OOM killer of a cgroup kills one;
// - CPU above the quota: all members pause for the excess time, as CFS throttling does;
// - more processes than the limit: the newest ones are killed (on Linux, fork fails for them);
// - the deadline: the instance stops (SIGTERM, then SIGKILL after 2 s, as systemd's TimeoutStopSec=2).
// These limits are emulated, not enforced by the kernel: they act within one sampling interval.

export const SAMPLE_MS = 250;

// Mina's own processes: the supervisor and the mina-instance helpers. Linux counts them neither (systemd-run, the launcher).
export const infrastructure = (m, self = process.pid) => m.pid === self || m.comm === 'mina-instance';

// The actions for one sample: { kill: [pids], reason } or { pauseMs, reason } or null. `members` from launchd.members();
// `cpuNs` is the CPU time the members used since the last sample, over `intervalMs`.
export function decide(members, limits, { cpuNs = 0, intervalMs = SAMPLE_MS, self = process.pid } = {}) {
  const live = members.filter((m) => !m.zombie && !infrastructure(m, self));
  const memory = live.reduce((sum, m) => sum + m.footprint, 0);
  if (limits.memoryBytes && memory > limits.memoryBytes) {
    const largest = live.reduce((a, b) => (b.footprint > a.footprint ? b : a));
    return { kill: [largest.pid], reason: `memory ${memory} bytes > ${limits.memoryBytes}: killed the largest process ${largest.pid} (${largest.comm})` };
  }
  if (limits.maxProcesses && live.length > limits.maxProcesses) {
    const newest = [...live].sort((a, b) => b.start - a.start || b.pid - a.pid).slice(0, live.length - limits.maxProcesses);
    return { kill: newest.map((m) => m.pid), reason: `${live.length} processes > ${limits.maxProcesses}: killed the ${newest.length} newest` };
  }
  if (limits.cpuPercent && cpuNs > 0) {
    const allowed = (limits.cpuPercent / 100) * intervalMs * 1e6;
    if (cpuNs > allowed) {
      const pauseMs = Math.min(5000, Math.ceil((cpuNs - allowed) / ((limits.cpuPercent / 100) * 1e6)));
      return { pauseMs, reason: `CPU ${(cpuNs / (intervalMs * 1e4)).toFixed(0)}% > ${limits.cpuPercent}%: paused ${pauseMs} ms` };
    }
  }
  return null;
}

// The CPU time of the members since the previous sample (a process that ended is not counted again).
export function cpuDelta(previous, members) {
  let used = 0;
  const next = new Map();
  for (const m of members) {
    const key = `${m.pid}:${m.start}`;
    next.set(key, m.cpuNs);
    used += Math.max(0, m.cpuNs - (previous.get(key) ?? m.cpuNs));
  }
  return { used, next };
}
