// Test-only parse worker for supplement_get: never answers. mode "spin" burns CPU forever (a parser stuck in a loop);
// mode "alloc" grows the heap until the worker's resource limit kills it. Used to prove the controller's timer, abort
// and memory limit terminate the thread while the parent event loop keeps running.
import { workerData } from 'node:worker_threads';

const mode = workerData?.q?.range === 'A1' ? 'alloc' : 'spin';
if (mode === 'alloc') {
  const hold = [];
  for (;;) hold.push(new Array(1e5).fill({ x: Math.random() }));
} else {
  let x = 0;
  for (;;) x = (x + 1) % 1e9;
}
