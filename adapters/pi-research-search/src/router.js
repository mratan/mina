// Mode routing. The model should normally choose the mode; `auto` is a small, explainable fallback.

export const MODES = ['auto', 'discover', 'literature', 'docs', 'exact', 'verify'];
export const BACKENDS = ['exa', 'searxng', 'brave'];

/** Backends used by each explicit mode. */
export const MODE_BACKENDS = {
  discover: ['exa'],
  literature: ['searxng'],
  docs: ['brave'],
  exact: ['brave'],
  verify: ['exa', 'searxng', 'brave'],
};

const QUOTED = /"[^"]{3,}"/;
const SITE_OP = /(^|\s)site:\S+/i;
// Identifier-like tokens: flags, call syntax, namespaces, snake/camel case, dotted modules, versions, error names.
const IDENTIFIER = /(^|\s)(--?[a-z][\w-]*|\w+\(\)|\w+::\w+|[a-z]+_[a-z0-9_]+|[a-z]+[A-Z]\w*|\w+\.\w+\.\w+|v?\d+\.\d+\.\d+|\w*(Error|Exception)\b)/;
const LITERATURE = /\b(papers?|preprints?|literature|peer[- ]reviewed|publications?|pubmed|doi|meta-analys[ie]s|systematic review|cohort|clinical trial|journal)\b/i;
const DOCS = /\b(docs?|documentation|manual|install(ation|ing)?|configur(e|ation)|usage|api reference|cli|flag|option|parameter|release notes|changelog|readme|vignette|man page|github repo)\b/i;

/**
 * Pick a mode for `auto`. Returns { mode, reason }. Order: quoted → site: → identifier+docs → literature → identifier → docs → discover.
 * Deliberately small: anything conceptual or ambiguous goes to discover (Exa), which tolerates vocabulary mismatch.
 */
export function classifyQuery(query) {
  const q = String(query);
  if (QUOTED.test(q)) return { mode: 'exact', reason: 'query contains a quoted phrase' };
  if (SITE_OP.test(q)) return { mode: 'docs', reason: 'query uses a site: operator' };
  const ident = q.match(IDENTIFIER);
  if (ident && DOCS.test(q)) return { mode: 'docs', reason: `documentation request naming identifier "${ident[2]}"` };
  if (LITERATURE.test(q)) return { mode: 'literature', reason: 'query asks for scholarly literature' };
  if (ident) return { mode: 'exact', reason: `query contains identifier-like token "${ident[2]}"` };
  if (DOCS.test(q)) return { mode: 'docs', reason: 'query asks for software documentation' };
  return { mode: 'discover', reason: 'conceptual query (default)' };
}

/** Resolve the backends to call. An explicit `backends` list overrides the mode's default set. */
export function resolveRoute({ query, mode = 'auto', backends }) {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}"; expected one of ${MODES.join(', ')}`);
  const chosen = mode === 'auto' ? classifyQuery(query) : { mode, reason: 'mode chosen by caller' };
  let list = MODE_BACKENDS[chosen.mode];
  if (backends?.length) {
    const bad = backends.filter((b) => !BACKENDS.includes(b));
    if (bad.length) throw new Error(`Unknown backend(s) ${bad.join(', ')}; expected ${BACKENDS.join(', ')}`);
    list = [...new Set(backends)];
  }
  return { mode: chosen.mode, reason: chosen.reason, backends: list };
}
