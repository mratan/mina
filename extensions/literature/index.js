// mina's literature layer: five literature tools (literature_search, paper_resolve, paper_get, citation_expand,
// literature_db), on one broker, as a normal Pi extension. The tool code is lib/literature-tools.mjs, run directly
// (a pass-through runner): mina has no supervisor or effect ledger.
// literature_db is one allowlisted read-only operation of PubMed/PMC/Europe PMC, bioRxiv/medRxiv, arXiv, Semantic Scholar
// (the sandboxed local MCP servers) or the OpenAlex REST API.
// It also registers supplement_get (extensions/literature/supplement-tool.mjs): bounded, provenance-preserving access to
// one explicitly linked supplement file (CSV/TSV, XLSX, ZIP member, PDF text), outside the broker.
import { createBroker } from '../../literature/broker/index.mjs';
import { withRetainedOutput } from '../../lib/retained-tool-results.mjs';
import { createLiteratureTools } from '../../adapters/pi-literature-broker/index.js';
import { createSupervisedLiteratureTools, LITERATURE_TOOL_NAMES } from '../../lib/literature-tools.mjs';
import { createSupplementTool } from './supplement-tool.mjs';

export const passthroughRunner = {
  run: async ({ execute }) => ({ result: await execute({ effect_id: null }) }),
  reconcileReadOnly() {},
};

export function createMinaLiteratureTools(broker = createBroker(), { env = process.env, retention = {} } = {}) {
  // Retain the produced database body before preview truncation. Other hosts keep the existing inline cap.
  const tools = createSupervisedLiteratureTools({ literature: { broker, createLiteratureTools }, runner: passthroughRunner, maxDbChars: Infinity });
  return LITERATURE_TOOL_NAMES.map((name) => withRetainedOutput(tools[name], { ...retention, env }));
}

// Pi calls this with `pi` only; tests pass a broker and supplement options to exercise the same registration path.
export default function minaLiterature(pi, { broker, supplement, env = process.env, retention = {} } = {}) {
  for (const t of createMinaLiteratureTools(broker, { env, retention })) pi.registerTool(t);
  pi.registerTool(withRetainedOutput(createSupplementTool(supplement), { ...retention, env }));
}
