// Representation analysis: what a returned full text actually contains, independent of what the tool claims about it.
// Pure functions over text.

const H_METHODS = /\b(method|methods|materials?|experimental|procedures?|online methods|approach|implementation|setup|model|architecture)\b/i;
const H_RESULTS = /\b(results?|findings|evaluation|experiments?|benchmark|performance)\b/i;
const H_DISCUSS = /\b(discussion|conclusions?|summary|limitations)\b/i;
const H_REFS = /^(references|bibliography|literature cited|works cited)\b/i;

// Section headings in any of the representations the stack returns: Markdown (#, bold-only lines), HTML (<h1>–<h6>,
// raw markup from arxiv_read_paper's arxiv_html source), and plain text (numbered section lines such as
// "2.1 Structured State Space Models", or a bare canonical section name on its own line).
const CANON = /^(abstract|introduction|background|related work|methods?|materials and methods|online methods|results?|results and discussion|discussion|conclusions?|references|acknowledg(e)?ments?|experiments?|evaluation|appendix|supplementary (information|materials?))\.?$/i;
export function headings(text) {
  const t = String(text ?? '');
  const out = [];
  for (const m of t.matchAll(/<h([1-6])[^>]*>([\s\S]{1,300}?)<\/h\1>/gi)) out.push(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  for (const raw of t.split('\n')) {
    const line = raw.replace(/<[^>]+>/g, '').trim();
    const m = raw.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/) ?? raw.match(/^\*\*([A-Z0-9][^*]{2,80})\*\*\s*$/)
      ?? line.match(/^((?:\d+|[IVX]+)(?:\.\d+)*\.?\s+[A-Z][^.!?]{2,80})$/) ?? (line.length < 60 && CANON.test(line) ? [line, line] : null);
    if (m) out.push(m[1].replace(/[*_`]/g, '').trim());
  }
  return out.filter(Boolean);
}

export function analyze(text) {
  const t = String(text ?? '');
  const lines = t.split('\n');
  const heads = headings(t);
  const nonEmpty = lines.filter((l) => l.trim());
  const shortLines = nonEmpty.filter((l) => l.trim().length < 4).length;
  const boiler = (t.match(/\b(cookie|sign in|log in|subscribe|javascript is disabled|access through your institution|purchase|we use cookies|skip to main content|download pdf|share this article)\b/gi) ?? []).length;
  const tableSep = (t.match(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm) ?? []).length;
  const tableCaps = new Set((t.match(/\bTable\s+\d+[.:]/g) ?? []).map((s) => s.replace(/\D/g, ''))).size;
  const figCaps = new Set((t.match(/(?:^|\n)\s*(?:\*\*|#+\s*)?(?:Fig\.?|Figure)\s*\d+[.:|]/gi) ?? []).map((s) => s.replace(/\D/g, ''))).size;
  const figMentions = new Set((t.match(/\b(?:Fig\.?|Figure)\s*(\d+)/gi) ?? []).map((s) => s.replace(/\D/g, ''))).size;
  const equations = (t.match(/\$\$[^$]+\$\$|\$[^$\n]{2,}\$|\\\(|\\\[|<math|\\frac|\\sum|\\mathbf/g) ?? []).length;
  const refHead = heads.findIndex((h) => H_REFS.test(h));
  const refLines = (t.match(/^\s*(?:\[\d+\]|\d+\.)\s+[A-Z][^\n]{20,}\(?(19|20)\d\d/gm) ?? []).length;
  const supp = (t.match(/\b(supplementary|supplemental|additional file|extended data|supporting information)\b/gi) ?? []).length;
  const suppLinks = (t.match(/https?:\/\/\S*(supp|suppl|media-\d|moesm|esm|figshare|zenodo)\S*/gi) ?? []).length;
  return {
    chars: t.length, approx_tokens: Math.ceil(t.length / 4), lines: nonEmpty.length, headings: heads.length,
    has_methods: heads.some((h) => H_METHODS.test(h)), has_results: heads.some((h) => H_RESULTS.test(h)), has_discussion: heads.some((h) => H_DISCUSS.test(h)),
    has_references: refHead >= 0 || refLines >= 10, reference_lines: refLines,
    tables: Math.max(tableCaps, tableSep ? 1 : 0), table_grid_rows: tableSep, figure_captions: figCaps, figure_mentions: figMentions,
    equations, supplementary_mentions: supp, supplementary_links: suppLinks,
    noise: { short_line_share: nonEmpty.length ? +(shortLines / nonEmpty.length).toFixed(3) : 0, boilerplate_hits: boiler,
      markup_share: t.length ? +((t.match(/<\/?[a-zA-Z][^<>]{0,400}>/g) ?? []).join('').length / t.length).toFixed(3) : 0 },
    text_chars: t.replace(/<\/?[a-zA-Z][^<>]{0,400}>/g, '').replace(/[ \t]+/g, ' ').length,
    first_headings: heads.slice(0, 12),
  };
}

/**
 * Our completeness judgment of one representation, from content, not from the tool's claim:
 *   complete    body with methods-like and results-like sections, a discussion or conclusion, and > 15k characters
 *   likely      methods-like and results-like sections and > 8k characters, but no discussion/conclusion seen
 *   partial     some body text beyond an abstract, but missing methods or results, or short
 *   landing     a landing/repository/abstract page: short, boilerplate-heavy, or no body sections
 *   unavailable nothing returned
 * The relative check (`ref`): when another representation of the same paper is much longer, a representation with
 * less than 50% of its characters is at most partial.
 */
export function judgeCompleteness(a0, { refChars = 0 } = {}) {
  if (!a0 || !a0.chars) return 'unavailable';
  const a = { ...a0, chars: a0.text_chars ?? a0.chars }; // judge the text, not the markup around it
  if (a.chars < 4000 || (a.noise.boilerplate_hits >= 3 && !(a.has_methods && a.has_results)) || (a.headings <= 1 && a.chars < 12000)) return 'landing';
  let j = a.has_methods && a.has_results ? (a.has_discussion && a.chars > 15000 ? 'complete' : a.chars > 8000 ? 'likely' : 'partial') : 'partial';
  if (refChars && a.chars < 0.5 * refChars && j !== 'partial') j = 'partial';
  return j;
}

/** Does the tool claim this is the full text? Map each route's own signal to complete / partial / unavailable / none. */
export function toolClaim(route, r) {
  if (r.status !== 'ok') return 'unavailable';
  if (route === 'openalex_tei') return r.claim === 'likely' ? 'complete' : r.claim === 'partial' ? 'partial' : 'unavailable';
  if (route === 'pubmed_chain') return r.truncated ? 'partial' : 'complete';
  // Tools that present their output as the paper's full text: the bioRxiv/arXiv full-text tools and S2's PDF tool.
  if (route === 'biorxiv_html' || route === 'arxiv_tool' || route === 's2_pdf') return 'complete';
  // web_fetch (publisher page, forced arXiv HTML/ar5iv) and raw PDF downloads make no completeness claim: a landing page
  // there is an unavailable representation, not a false-complete one. OpenAlex PDF reports complete: 'unknown'.
  return 'none';
}

/** A false-complete response: the tool presents it as the full text, the content says otherwise. */
export function falseComplete(claim, judged) {
  return claim === 'complete' && (judged === 'landing' || judged === 'partial');
}

/** Section selection for targeted evidence: keep sections whose heading matches any hint. */
export function selectSections(text, hints) {
  const re = new RegExp(hints.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const lines = String(text ?? '').split('\n');
  const out = []; let keep = false; let level = 9;
  for (const line of lines) {
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (m) {
      const l = m[1].length;
      if (re.test(m[2])) { keep = true; level = l; } else if (l <= level) keep = false;
    }
    if (keep) out.push(line);
  }
  return out.join('\n');
}

/** Passage retrieval for targeted evidence: BM25 over paragraphs, top-k by the question's terms. */
const STOP = new Set('the a an of and or to in for on with by from at as is are was were be been which what how many much did does do that this these those used use using their its into than then there per each whether'.split(' '));
const toks = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9.%-]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w));
export function passages(text, query, { k = 8, maxChars = 6000 } = {}) {
  const paras = String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 80);
  if (!paras.length) return '';
  const docs = paras.map(toks);
  const N = docs.length, avg = docs.reduce((s, d) => s + d.length, 0) / N;
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const q = [...new Set(toks(query))];
  const score = docs.map((d, i) => {
    const tf = new Map(); for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0;
    for (const w of q) { const f = tf.get(w) ?? 0; if (!f) continue; const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg)); }
    return { i, s };
  }).sort((a, b) => b.s - a.s);
  const chosen = []; let used = 0;
  for (const { i, s } of score) { if (chosen.length >= k || s <= 0) break; if (used + paras[i].length > maxChars && chosen.length) continue; chosen.push(i); used += paras[i].length; }
  return chosen.sort((a, b) => a - b).map((i) => paras[i]).join('\n\n');
}

// The section hint a caller would pass for the question: what was done (Methods) or what was found (Results).
export function sectionHints(question) {
  const methodsy = /\b(how (was|were|many|much|long)|what (concentration|duration|temperature|software|version|parameter|threshold|depth|composition|reagent|protocol|control|dataset|simulat|settings?|hyperparameter|batch|learning rate)|which (software|tool|version|parameter|control|dataset|model|reference)|replicates?|sequenc(ing|ed) depth|used|incubat|fixed|fixation|trained|hyperparameter)\b/i;
  const resultsy = /\b(how many .* (detected|found|identified|switch|errors?)|what (was|were) the (accuracy|speed ?up|precision|recall|error|rate|percentage|performance|score|result)|reported|achiev|outperform|compared|improv)\b/i;
  const hints = [];
  if (methodsy.test(question)) hints.push('method', 'material', 'experimental', 'procedure', 'implementation', 'setup', 'approach');
  if (resultsy.test(question) || !hints.length) hints.push('result', 'experiment', 'evaluation', 'benchmark');
  return hints;
}
