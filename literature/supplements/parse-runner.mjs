// Runs one supplement parse job in a fresh worker thread so that inflating, XML walking and CSV/text scanning never
// block the controller's event loop. Bounds: one transferred copy of the input (the download is already capped), a V8
// heap limit (resourceLimits; ZIP inflation is separately capped by the decompression budget), a hard deadline, and the
// caller's abort signal. Deadline, abort, heap exhaustion and an unexpected exit all terminate the thread. Every job's
// worker is terminated when the job settles, so nothing keeps the process alive afterwards. The worker gets an empty
// environment and no inherited execArgv; its stdout/stderr are drained and discarded (never logged).
import { Worker } from 'node:worker_threads';

const DEFAULT_WORKER = new URL('./parse-worker.mjs', import.meta.url);
const stats = { started: 0, active: 0, timeouts: 0, aborted: 0, memory: 0 };

/** Counters for tests and diagnostics: workers started and currently alive. */
export function parseWorkerStats() { return { ...stats }; }

function abortError(signal) {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  const e = new Error(r ? String(r) : 'supplement_get aborted');
  e.name = 'AbortError';
  return e;
}

const failure = (status, message) => ({ ok: false, error: { type: 'outcome', status, message, extra: {} } });

/**
 * @param {{buf: Uint8Array, q: object, ctx: object, limits: object}} job
 * @param {{signal?: AbortSignal, timeoutMs: number, memoryMb: number, workerUrl?: URL}} o
 * Resolves the worker's message ({ok, result} | {ok:false, error}); rejects only on abort.
 */
export function runParseJob(job, { signal, timeoutMs, memoryMb, workerUrl = DEFAULT_WORKER }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const bytes = new Uint8Array(job.buf.byteLength);
    bytes.set(job.buf);
    let worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: { ...job, buf: bytes }, transferList: [bytes.buffer],
        resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: Math.max(4, Math.min(64, Math.floor(memoryMb / 8))), stackSizeMb: 4 },
        env: {}, execArgv: [], stdout: true, stderr: true,
      });
    } catch {
      resolve(failure('parse_failed', 'the parser thread could not be started'));
      return;
    }
    stats.started++; stats.active++;
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate().catch(() => {});
      fn(v);
    };
    const onAbort = () => { stats.aborted++; finish(reject, abortError(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { stats.timeouts++; finish(resolve, failure('parse_timeout', `parsing exceeded the ${timeoutMs} ms deadline and was stopped; select a smaller part (sheet, range or ZIP member) or a smaller file`)); }, timeoutMs);
    worker.once('exit', () => { stats.active--; finish(resolve, failure('parse_failed', 'the parser thread exited without a result')); });
    worker.once('message', (m) => finish(resolve, m && typeof m === 'object' ? m : failure('parse_failed', 'the parser thread returned an invalid result')));
    worker.on('error', (e) => {
      if (e?.code === 'ERR_WORKER_OUT_OF_MEMORY') { stats.memory++; finish(resolve, failure('parse_resource_limit', `parsing exceeded the parser's ${memoryMb} MiB memory limit and was stopped; select a smaller part or a smaller file`)); return; }
      finish(resolve, failure('parse_failed', `the parser thread failed (${String(e?.code ?? e?.name ?? 'error')})`));
    });
  });
}
