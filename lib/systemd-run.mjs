// systemd-run's --expand-environment arrived in systemd 254, together with the expansion it turns off: from 254 on,
// systemd-run rewrites ${NAME} and $$ in a scope's command line; before it, the command line goes through verbatim and
// the option is rejected (Debian 11, systemd 247: "unrecognized option").
// A version that cannot be read gets the option: a refused launch is safe, an expanded command line is not.
import { execFileSync } from 'node:child_process';

const versions = new Map();

export function systemdRunVersion(bin = 'systemd-run') {
  if (!versions.has(bin)) {
    let version = null;
    try {
      const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /^systemd (\d+)\b/.exec(out);
      if (m) version = Number(m[1]);
    } catch { /* unknown */ }
    versions.set(bin, version);
  }
  return versions.get(bin);
}

export function noExpandArgs(bin = 'systemd-run') {
  const version = systemdRunVersion(bin);
  return version !== null && version < 254 ? [] : ['--expand-environment=no'];
}
