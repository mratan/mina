import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noExpandArgs, systemdRunVersion } from '../lib/systemd-run.mjs';

const fakeRun = (versionLine) => {
  const bin = join(mkdtempSync(join(tmpdir(), 'mina-systemd-run-')), 'systemd-run');
  writeFileSync(bin, `#!/bin/sh\n${versionLine === null ? 'exit 1' : `printf '%s\\n' '${versionLine}' '+PAM +AUDIT'`}\n`, { mode: 0o755 });
  return bin;
};

test('systemd-run before 254 (Debian 11, 247) gets no --expand-environment: it rejects it and expands nothing', () => {
  const bin = fakeRun('systemd 247 (247.3-7+deb11u8)');
  assert.equal(systemdRunVersion(bin), 247);
  assert.deepEqual(noExpandArgs(bin), []);
});

test('systemd-run 254 and later gets --expand-environment=no', () => {
  assert.deepEqual(noExpandArgs(fakeRun('systemd 254 (254.1-1)')), ['--expand-environment=no']);
  assert.deepEqual(noExpandArgs(fakeRun('systemd 262 (262.1-1-arch)')), ['--expand-environment=no']);
});

test('an unreadable systemd-run version keeps the option: a refused launch is safe, an expanded command is not', () => {
  assert.deepEqual(noExpandArgs(fakeRun(null)), ['--expand-environment=no']);
  assert.deepEqual(noExpandArgs(fakeRun('something else')), ['--expand-environment=no']);
  assert.deepEqual(noExpandArgs('/nonexistent/systemd-run'), ['--expand-environment=no']);
});
