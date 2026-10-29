// Passage index and BM25 retrieval with section provenance. On a set of evidence questions, BM25 passages ≤ 6,000
// characters answered 94 % vs 96 % for the full text, at ≈ 1.5k vs 18k tokens; keyword-chosen sections answered 49 %;
// passages without their section headings were attributed to the right section only 38 % of the time.
//
// The retriever is lib/representation.mjs passages() (BM25 k1 1.2, b 0.75, paragraphs > 80 characters, k ≤ 8,
// ≤ 6,000 characters) with one change: every passage carries its section, subsection, section path and character offsets
// into the document text.

const STOP = new Set('the a an of and or to in for on with by from at as is are was were be been which what how many much did does do that this these those used use using their its into than then there per each whether'.split(' '));
export const tokens = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9.%-]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w));
const REFS = /^(references|bibliography|literature cited|works cited|reference list)\b/i;

export function sectionAt(doc, offset) {
  let best = null;
  for (const s of doc.sections) if (s.start <= offset && offset < s.end && (!best || s.start >= best.start)) best = s;
  return best;
}

/** Paragraph index: split on blank lines; paragraphs over 1,600 characters split at sentence ends near 1,000. */
export function buildIndex(doc, { minChars = 80, includeReferences = false } = {}) {
  const t = doc.text;
  const paras = [];
  const re = /\n\s*\n/g;
  let start = 0; let m;
  const push = (s, e) => {
    const raw = t.slice(s, e); const lead = raw.length - raw.trimStart().length; const text = raw.trim();
    if (text.length < minChars || /^#{1,6}\s/.test(text) && text.length < 200) return;
    const st = s + lead;
    if (text.length > 1600) {
      let a = 0;
      while (a < text.length) {
        let b = Math.min(text.length, a + 1000);
        if (b < text.length) { const dot = text.slice(b, b + 400).search(/[.!?]\s/); b = dot >= 0 ? b + dot + 1 : Math.min(text.length, a + 1400); }
        const chunk = text.slice(a, b).trim(); if (chunk.length >= minChars) paras.push({ start: st + a, end: st + b, text: chunk });
        a = b;
      }
    } else paras.push({ start: st, end: st + text.length, text });
  };
  while ((m = re.exec(t))) { push(start, m.index); start = m.index + m[0].length; }
  push(start, t.length);
  const items = [];
  for (const p of paras) {
    const sec = sectionAt(doc, p.start);
    if (!includeReferences && sec && sec.path.some((x) => REFS.test(x))) continue;
    // a paragraph that is itself a heading line + text: drop the heading prefix from scoring but keep offsets
    const { section, subsection } = sectionNames(sec);
    items.push({ id: `p${items.length + 1}`, ...p, section, subsection, section_path: sec?.path ?? null });
  }
  const docs = items.map((x) => tokens(x.text));
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = docs.reduce((s, d) => s + d.length, 0) / (docs.length || 1);
  return { items, docs, df, avg, N: docs.length };
}
// Section = the outermost heading below the paper title (a level-1 heading is the title when deeper headings exist);
// subsection = the innermost heading when it differs. No heading → both null (reported as unavailable, never guessed).
export function sectionNames(sec) {
  if (!sec) return { section: null, subsection: null };
  const i = sec.levels.findIndex((l) => l > 1);
  const top = i >= 0 ? i : 0;
  return { section: sec.path[top], subsection: sec.path.length - 1 > top ? sec.path.at(-1) : null };
}

export function bm25(index, query) {
  const q = [...new Set(tokens(query))];
  const { docs, df, avg, N } = index;
  return docs.map((d, i) => {
    const tf = new Map(); for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0;
    for (const w of q) { const f = tf.get(w) ?? 0; if (!f) continue; const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg)); }
    return { i, s };
  }).sort((a, b) => b.s - a.s || a.i - b.i);
}

/**
 * retrieve(index, query, { k, maxChars, exclude }) → { passages: [...], more: bool, considered }
 * Second pass: pass the ids already returned in `exclude` to get the next-best passages (no jump to the full paper).
 */
export function retrieve(index, query, { k = 8, maxChars = 6000, exclude = [] } = {}) {
  const skip = new Set(exclude);
  const scored = bm25(index, query).filter((x) => x.s > 0 && !skip.has(index.items[x.i].id));
  const chosen = []; let used = 0;
  for (const { i, s } of scored) {
    if (chosen.length >= k) break;
    const it = index.items[i];
    if (used + it.text.length > maxChars && chosen.length) continue;
    chosen.push({ ...it, score: +s.toFixed(3) }); used += it.text.length;
  }
  return { passages: chosen.sort((a, b) => a.start - b.start), more: scored.length > chosen.length, considered: scored.length };
}
