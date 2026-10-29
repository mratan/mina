import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { reportArgs } from '../report-out.mjs';

test('live suite reports go to .mina/literature (git-ignored) unless --out is given; check ids are upper-cased', () => {
  assert.deepEqual(reportArgs(['a', 'b2'], '/r'), { out: resolve('/r/.mina/literature'), only: ['A', 'B2'] });
  assert.deepEqual(reportArgs(['--out', '/tmp/x', 's1'], '/r'), { out: '/tmp/x', only: ['S1'] });
  assert.deepEqual(reportArgs(['--out=/tmp/y'], '/r'), { out: '/tmp/y', only: [] });
  assert.throws(() => reportArgs(['--out'], '/r'), /--out needs a directory/);
});
