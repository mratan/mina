// Worker-thread entry for supplement_get parsing (see parse-runner.mjs). Receives the downloaded bytes (transferred,
// one copy), normalized parameters and limits; posts exactly one message: { ok: true, result } or { ok: false, error }.
// No network, credentials, cache or filesystem access happens here.
import { parentPort, workerData } from 'node:worker_threads';
import { parseDocument, serializeError } from './parse.mjs';

const { buf, q, ctx, limits } = workerData;
try {
  const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const result = parseDocument(bytes, q, ctx, limits);
  if (result.pdf && result.bytes) {
    // A PDF ZIP member goes back to the controller for the isolated extractor: one exact-size copy, transferred.
    const copy = new Uint8Array(result.bytes.length);
    copy.set(result.bytes);
    parentPort.postMessage({ ok: true, result: { ...result, bytes: copy } }, [copy.buffer]);
  } else {
    const size = JSON.stringify(result).length;
    if (size > limits.maxResultChars) {
      parentPort.postMessage({ ok: false, error: { type: 'outcome', status: 'result_too_large', message: `the parsed result (${size} characters) exceeds the ${limits.maxResultChars}-character result limit; narrow the selection`, extra: {} } });
    } else parentPort.postMessage({ ok: true, result });
  }
} catch (e) {
  parentPort.postMessage({ ok: false, error: serializeError(e) });
}
