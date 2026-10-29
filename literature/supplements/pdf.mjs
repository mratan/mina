// PDF text layer extraction for supplement_get with the pinned PyMuPDF in the literature venv (requirements.lock:
// pymupdf==1.28.2). PyMuPDF is native code on untrusted bytes, so it only ever runs inside the bubblewrap sandbox of
// ./pdf-sandbox.mjs (positive read-only mounts, private /tmp, no network, no host home or controller state); a missing
// sandbox is a typed pdf_extractor_unavailable outcome, never an unsandboxed run. The PDF goes in on stdin (no temp
// file), arguments are integers in argv (no shell), Python runs with -I -B (isolated: no PYTHONPATH, user site or cwd on
// sys.path; no bytecode writes) under a hard timeout, a stdout byte cap, the caller's abort signal and rlimits set by the
// prelude before PyMuPDF loads (address space, CPU seconds, file size 0, no core, 64 descriptors). If any rlimit cannot be
// applied the prelude refuses to run the parser. It reads the embedded text layer only (page.get_text): no OCR, no
// layout model, no image or figure interpretation, no JavaScript. Image counts per page are reported so empty scanned
// pages are visible.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSandboxedPython } from './pdf-sandbox.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_PYTHON = join(REPO, 'services/literature-mcp/.venv/bin/python');

// argv[1] = address-space bytes, argv[2] = CPU seconds; removed before the body runs. Fail closed: a limit that cannot
// be set (or reads back differently) stops here with reason rlimit_failed. Lowering below an existing hard limit is
// the only adjustment (never raising, never RLIM_INFINITY).
export const RLIMIT_PRELUDE = String.raw`
import sys, json as _rl_json
def _rl_refuse(reason):
    sys.stdout.write(_rl_json.dumps({"status": "pdf_extractor_unavailable", "reason": reason})); sys.stdout.flush()
    import os; os._exit(0)
try:
    import resource
    _rl_mem, _rl_cpu = int(sys.argv[1]), int(sys.argv[2])
    if _rl_mem <= 0 or _rl_cpu <= 0:
        raise ValueError("limits must be positive")
    for _rl_res, _rl_soft, _rl_hard in ((resource.RLIMIT_AS, _rl_mem, _rl_mem), (resource.RLIMIT_CPU, _rl_cpu, _rl_cpu + 1),
            (resource.RLIMIT_FSIZE, 0, 0), (resource.RLIMIT_CORE, 0, 0), (resource.RLIMIT_NOFILE, 64, 64)):
        _rl_cur = resource.getrlimit(_rl_res)[1]
        if _rl_cur != resource.RLIM_INFINITY:
            _rl_soft, _rl_hard = min(_rl_soft, _rl_cur), min(_rl_hard, _rl_cur)
        resource.setrlimit(_rl_res, (_rl_soft, _rl_hard))
        if tuple(resource.getrlimit(_rl_res)) != (_rl_soft, _rl_hard):
            raise OSError("rlimit not applied")
except BaseException:
    _rl_refuse("rlimit_failed")
del sys.argv[1:3]
`;

const PDF_BODY = String.raw`
import json
def out(o):
    sys.stdout.buffer.write(json.dumps(o, ensure_ascii=False).encode("utf-8", "replace")); sys.stdout.flush(); sys.exit(0)
try:
    import pymupdf
except Exception as e:
    out({"status": "pdf_extractor_unavailable", "reason": "pymupdf_missing", "error": type(e).__name__})
off, lim, cap = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
try:
    pymupdf.TOOLS.mupdf_display_errors(False)
    pymupdf.TOOLS.mupdf_display_warnings(False)
except Exception:
    pass
data = sys.stdin.buffer.read()
try:
    doc = pymupdf.open(stream=data, filetype="pdf")
except Exception as e:
    out({"status": "parse_error", "error": type(e).__name__})
if doc.needs_pass:
    out({"status": "pdf_encrypted", "page_count": doc.page_count})
n = doc.page_count
pages = []
for i in range(max(0, off), min(n, off + lim)):
    page = doc[i]
    t = page.get_text("text")
    try:
        imgs = len(page.get_images(full=False))
    except Exception:
        imgs = None
    pages.append({"page": i + 1, "chars": len(t), "text": t[:cap], "truncated": len(t) > cap, "images": imgs})
out({"status": "ok", "page_count": n, "pages": pages, "pymupdf": getattr(pymupdf, "VersionBind", None)})
`;

export const PDF_SCRIPT = RLIMIT_PRELUDE + PDF_BODY;

/**
 * Run the sandboxed extractor. Resolves { status, page_count?, pages?, reason?, error? }; status is one of ok,
 * pdf_encrypted, pdf_extractor_unavailable (reason: isolation_unavailable, unsafe_runtime, runtime_unavailable,
 * rlimit_failed, invalid_limits, pymupdf_missing), parse_error, extractor_timeout, extractor_output_limit,
 * extractor_failed. Rejects only on abort. `python` is owner configuration, never a model argument.
 */
export function extractPdfText(buf, { python = DEFAULT_PYTHON, offset = 0, limit = 5, maxCharsPerPage = 20000, timeoutMs = 30000,
  maxStdoutBytes = 4 * 1024 * 1024, maxMemoryBytes = 1536 * 1024 * 1024, signal, spawnImpl, bwrap } = {}) {
  return runSandboxedPython(buf, { python, script: PDF_SCRIPT, args: [String(offset | 0), String(limit | 0), String(maxCharsPerPage | 0)],
    timeoutMs, maxStdoutBytes, maxMemoryBytes, signal, ...(spawnImpl ? { spawnImpl } : {}), ...(bwrap ? { bwrap } : {}) });
}
