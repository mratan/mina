// The two code paths that load onnxruntime (pymupdf4llm's layout model), run for real without a model, for the privacy
// e2e tests. Prints one JSON line: { ok, chars, title }. Usage: node pdf-paths.mjs semantic-scholar|broker
import { connect, resultText } from '../../scripts/mcp-client.mjs';
import { createProviders } from '../../literature/broker/providers.mjs';
import { createRuntime } from '../../literature/broker/runtime.mjs';

const ARXIV = '1706.03762';
const mode = process.argv[2];
let text = '';
if (mode === 'semantic-scholar') {
  // The Semantic Scholar server downloads the open-access PDF (an eLife paper: Semantic Scholar lists no PDF for the
  // arXiv one) and converts it in its own sandbox.
  const s = await connect('semantic_scholar', { timeoutMs: 300_000 });
  try {
    const r = await s.call('get_paper_fulltext', { paper_id: 'DOI:10.7554/eLife.05005', output_mode: 'markdown', max_pages: 2, force_refresh: true });
    text = resultText(r);
  } finally { await s.close(); }
} else if (mode === 'broker') {
  // The broker's tier-5 path: an open-access PDF download, then pdfToText in the PDF sandbox.
  const p = createProviders(createRuntime(), {});
  const r = await p.web.pdf({ url: `https://arxiv.org/pdf/${ARXIV}`, ctx: {} });
  if (r.outcome !== 'ok' || !r.data?.pdf) throw new Error(`download failed: ${r.outcome}`);
  text = await p.pdfToText(r.data.pdf);
  await p.close?.();
} else throw new Error('usage: pdf-paths.mjs semantic-scholar|broker');
process.stdout.write(`${JSON.stringify({ ok: text.length > 1000 && !/^\s*\{\s*"error"/.test(text), chars: text.length, title: /attention is all you need/i.test(text) })}\n`);
