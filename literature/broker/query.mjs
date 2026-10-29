// Query classification and backend-aware transformation.
//
// On a set of test queries, a natural-language sentence sent to a lexical engine collapsed its precision (OpenAlex
// keyword P@20 0.51 → 0.14, PubMed 0.48 → 0.17), Exa and OpenAlex semantic search were insensitive to formulation, and
// synonym formulations raised the recovery of known relevant papers on terminology-mismatch queries. So every backend gets its own form:
//   semantic engines (Exa, OpenAlex semantic)  the sentence
//   lexical engines (OpenAlex keyword, PubMed, Europe PMC, SearXNG, bioRxiv)  compact keywords, no wildcards
//   arXiv  all:t1 AND all:t2 (a bare sentence is OR-ed by the arXiv API)
// Everything here is deterministic. A caller (the agent) may pass its own keywords and synonyms; they are used verbatim.

const STOP = new Set(`a an the of and or to in on for with by from at as is are was were be been being which what who whom whose how why when where
does do did done can could should would will shall may might must there here this that these those it its their them they we our you your i me my
than then so such into onto about over under between among within without across per via versus vs etc also only just more most less least very
any all each every some many much few several other another same new recent recently current currently latest state art sota exist exists existing
used use using uses based approach approaches method methods technique techniques tool tools way ways paper papers study studies work works literature
review reviews overview survey find found show shows shown report reported reports evidence demonstrate demonstrated known major main key leading
best strongest important compare compared comparison whether if not no yes have has had what's whats give list identify describe explain`.split(/\s+/));

// Vocabulary cues for field routing. Counted, not matched once: a question about "deep learning for protein structure"
// has both, and the larger count wins; ties go to computational biology.
const BIO = /\b(gene|genes|genom\w*|protein\w*|cell|cells|cellular|tissue\w*|patient\w*|clinical|disease\w*|cancer\w*|tumou?r\w*|mouse|mice|rat|bacteri\w*|microb\w*|virus\w*|viral|rna|dna|mrna|transcript\w*|antibiot\w*|drug\w*|therap\w*|immun\w*|neuro\w*|brain|enzyme\w*|metabol\w*|sequencing|microscopy|imaging|assay\w*|pathogen\w*|infection\w*|trial\w*|receptor\w*|agonist\w*|disorder\w*|syndrome|biomarker\w*|epidemiolog\w*|in vivo|in vitro|fish|crispr|persister\w*|strain\w*|metagenom\w*|hydrogel\w*)\b/gi;
const COMPBIO = /\b(bioinformatic\w*|metagenom\w*|assembl\w*|alignment|aligner\w*|read mapping|variant call\w*|phylogen\w*|k-?mer\w*|sketch\w*|minhash|ani\b|nucleotide identity|haplotyp\w*|long[- ]reads?|short[- ]reads?|single[- ]cell|scrna|pipeline\w*|genome assembly|annotation)\b/gi;
const MLCS = /\b(neural|network\w*|deep learning|machine learning|transformer\w*|language model\w*|llm\w*|gpt|bert|attention|reinforcement|diffusion model\w*|gan\w*|embedding\w*|fine[- ]tun\w*|distillation|inference|decoding|token\w*|benchmark\w*|dataset\w*|training|pretrain\w*|gradient|optimi[sz]\w*|retrieval|agent\w*|reasoning|quantization|pruning|speculative|lora|adapter\w*|prompt\w*|computer vision|nlp|algorithm\w*|compiler\w*|gpu\w*|teacher models?|student models?|small(er)? models?|large models?|model compression|knowledge distillation)\b/gi;

export const FIELDS = ['biomedical', 'computational_biology', 'ml_cs', 'general'];
export function classifyField(text) {
  const t = String(text ?? '');
  const bio = (t.match(BIO) ?? []).length, cb = (t.match(COMPBIO) ?? []).length, ml = (t.match(MLCS) ?? []).length;
  if (!bio && !cb && !ml) return { field: 'general', scores: { bio, cb, ml } };
  if (cb && cb >= ml) return { field: 'computational_biology', scores: { bio, cb, ml } };
  if (ml > bio + cb) return { field: 'ml_cs', scores: { bio, cb, ml } };
  if (bio >= ml) return { field: 'biomedical', scores: { bio, cb, ml } };
  return { field: 'ml_cs', scores: { bio, cb, ml } };
}

/** Compact keywords from a sentence: quoted phrases and hyphenated/technical tokens kept, stopwords and punctuation dropped. */
export function keywords(sentence, { max = 7 } = {}) {
  const s = String(sentence ?? '').replace(/[?!]/g, ' ');
  const phrases = [...s.matchAll(/"([^"]{2,80})"/g)].map((m) => `"${m[1]}"`);
  const rest = s.replace(/"[^"]*"/g, ' ');
  const toks = rest.split(/[\s,;:()[\]{}]+/).map((w) => w.replace(/^[^\w]+|[^\w+%-]+$/g, '')).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const w of toks) {
    const lw = w.toLowerCase();
    if (STOP.has(lw) || lw.length < 2 || /^\d+$/.test(lw) || seen.has(lw)) continue;
    seen.add(lw); out.push(/^[A-Z0-9-]{2,}$/.test(w) || /[A-Z].*[A-Z]/.test(w) ? w : lw);
  }
  return [...phrases, ...out].slice(0, max).join(' ');
}

/** OpenAlex keyword search: stemmed; rejects wildcards on the stemmed field and inside quoted phrases. */
export const forOpenalexKeyword = (kw) => kw.replace(/,/g, ' ').replace(/(\w)\*/g, '$1').replace(/\s+/g, ' ').trim();
/** arXiv: all:t1 AND all:t2; quoted phrases stay phrases; explicit field syntax is passed through. */
export function forArxiv(kw) {
  if (/\b(all|ti|abs|au|cat):/.test(kw)) return kw;
  const parts = kw.match(/"[^"]+"|\S+/g) ?? [];
  return parts.filter((t) => !/^(AND|OR|NOT)$/.test(t)).map((t) => `all:${t.startsWith('"') ? t : t.replace(/[^\w*-]/g, '')}`).filter((t) => t !== 'all:').join(' AND ');
}
/** PubMed: keywords as given; its automatic term mapping adds MeSH. A synonym group is an OR-clause. */
export const forPubmed = (kw) => kw.replace(/\s+/g, ' ').trim();

/** Synonym formulation: each synonym group (["persister", "dormant cells"]) becomes (a OR b) in the keyword form. */
export function withSynonyms(kw, synonyms = []) {
  if (!synonyms?.length) return null;
  const groups = synonyms.map((g) => (Array.isArray(g) ? g : String(g).split(/\s*[|;]\s*/))).filter((g) => g.length);
  const ors = groups.map((g) => `(${g.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' OR ')})`);
  return `${kw} ${ors.join(' ')}`.trim();
}

/**
 * Terminology expansion by pseudo-relevance feedback: the semantic engines bridge vocabulary (Exa does best on
 * terminology-mismatch queries), so the frequent title terms of their top results that the query does not use are
 * the field's own words. Returns up to `max` terms, deterministic for a given result list.
 */
export function feedbackTerms(query, items, { top = 12, max = 4 } = {}) {
  const q = new Set(keywords(query, { max: 30 }).toLowerCase().split(/\s+/));
  const df = new Map();
  for (const it of items.slice(0, top)) {
    const ws = new Set(String(it.title ?? '').toLowerCase().replace(/[^a-z0-9 -]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w) && !q.has(w)));
    for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
  }
  return [...df.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w]) => w);
}

/**
 * Formulations for one request. `standard`: sentence + keywords. `conceptual/landscape`: + synonyms when given.
 * `comprehensive`/`novelty`: sentence, keywords, synonyms (caller's, else feedback terms filled in later), and a short core
 * form (the three most specific keywords) — at least three formulations.
 */
export function formulations({ query, keywords: kwIn, synonyms, mode }) {
  const kw = (kwIn && String(kwIn).trim()) || keywords(query);
  const f = [{ id: 'sentence', text: query, for: 'semantic' }, { id: 'keywords', text: kw, for: 'lexical' }];
  const syn = withSynonyms(kw, synonyms);
  if (syn) f.push({ id: 'synonyms', text: syn, for: 'lexical' });
  if (mode === 'comprehensive' || mode === 'novelty') {
    const core = kw.split(/\s+/).filter((w) => !/^(AND|OR)$/.test(w)).slice(0, 3).join(' ');
    if (core && core !== kw) f.push({ id: 'core', text: core, for: 'lexical' });
  }
  return f;
}
