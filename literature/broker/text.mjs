// Representations → one document shape with section offsets.
//
// Document: { text, format, sections: [{ id, title, level, path, start, end }] } where `text` is the representation the
// passages and offsets refer to. Headings come from the representation itself (Markdown #, numbered or canonical section
// lines, PMC section titles, TEI <head>); nothing is inferred from a query. When a representation has no headings, the
// document has no sections and every passage reports section_status "unavailable".

const CANON = /^(abstract|introduction|background|related work|methods?|materials and methods|materials & methods|online methods|star methods|experimental( section| procedures)?|results?|results and discussion|discussion|conclusions?|references|bibliography|acknowledg(e)?ments?|experiments?|evaluation|appendix|supplementary (information|materials?)|data availability|code availability|limitations)\.?$/i;

/** Markdown-ish text → sections with offsets. */
export function sectionize(text) {
  const t = String(text ?? '');
  const sections = [];
  const re = /^.*$/gm;
  let m;
  while ((m = re.exec(t))) {
    const raw = m[0];
    if (!raw.trim()) { if (re.lastIndex === m.index) re.lastIndex++; continue; }
    const line = raw.trim();
    let title = null; let level = null;
    let h;
    if ((h = line.match(/^(#{1,6})\s+(.+?)\s*#*$/))) { level = h[1].length; title = h[2]; }
    else if ((h = line.match(/^\*\*([A-Z0-9][^*]{2,90})\*\*$/))) { level = 3; title = h[1]; }
    else if ((h = line.match(/^((\d+)((?:\.\d+)*))\.?\s+([A-Z][^.!?]{2,90})$/)) && line.length < 100) { level = 2 + (h[3] ? h[3].split('.').length - 1 : 0); title = `${h[1]} ${h[4]}`; }
    else if (line.length < 60 && CANON.test(line.replace(/[*_]/g, ''))) { level = 2; title = line.replace(/[*_]/g, ''); }
    if (title) sections.push({ title: title.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim(), level, start: m.index });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  // paths and ends
  const stack = [];
  sections.forEach((s, i) => {
    while (stack.length && stack.at(-1).level >= s.level) stack.pop();
    s.path = [...stack.map((x) => x.title), s.title];
    s.levels = [...stack.map((x) => x.level), s.level];
    s.id = `s${i + 1}`;
    stack.push(s);
  });
  sections.forEach((s, i) => {
    const next = sections.slice(i + 1).find((x) => x.level <= s.level);
    s.end = next ? next.start : t.length;
  });
  return sections;
}

export function makeDocument(text, format) {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  return { text: t, format, sections: sectionize(t) };
}

/** PMC JATS sections from pubmed_fetch_fulltext ([{title, text}]) → document. */
export function fromPmcSections(article) {
  const parts = [];
  if (article.title) parts.push(`# ${article.title}`);
  if (article.abstract) parts.push(`## Abstract\n\n${article.abstract}`);
  for (const s of article.sections ?? []) {
    parts.push(`## ${s.title || '(untitled section)'}\n\n${s.text ?? ''}`);
    for (const sub of s.subsections ?? s.sections ?? []) parts.push(`### ${sub.title || '(untitled)'}\n\n${sub.text ?? ''}`);
  }
  for (const tb of article.tables ?? []) if (tb.caption || tb.label) parts.push(`### ${tb.label ?? 'Table'}\n\n${tb.caption ?? ''}`);
  return makeDocument(parts.join('\n\n'), 'pmc_jats');
}

/** GROBID TEI sections ([{n, head, text}]) → document. */
export function fromTeiSections(sections, title) {
  const parts = title ? [`# ${title}`] : [];
  for (const s of sections ?? []) parts.push(`## ${[s.n, s.head].filter(Boolean).join(' ') || '(untitled section)'}\n\n${s.text ?? ''}`);
  return makeDocument(parts.join('\n\n'), 'openalex_tei');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', minus: '−', times: '×', le: '≤', ge: '≥', plusmn: '±', deg: '°', micro: 'µ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', mu: 'μ', sigma: 'σ', lambda: 'λ', pi: 'π' };
export const decodeEntities = (s) => String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m));

/**
 * arXiv HTML (LaTeXML: arxiv.org/html, ar5iv) → clean Markdown text: headings kept as #, math kept as $alttext$ (equations
 * preserved as LaTeX source where the page provides it), citations and navigation dropped. The raw HTML that
 * arxiv_read_paper returns is ≈ 47 % markup and costs about four times the tokens.
 */
export function arxivHtmlToText(html) {
  let h = String(html ?? '');
  const body = h.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? h.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? h;
  h = body
    .replace(/<(script|style|nav|header|footer|button|svg|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<math\b[^>]*alttext="([^"]*)"[^>]*>[\s\S]*?<\/math>/gi, (_, a) => ` $${decodeEntities(a)}$ `)
    .replace(/<math\b[\s\S]*?<\/math>/gi, ' [math] ')
    .replace(/<cite\b[\s\S]*?<\/cite>/gi, (c) => ` ${c.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()} `)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, x) => `\n\n${'#'.repeat(Math.min(6, Number(l)))} ${x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/gi, (_, x) => `\n\n${x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<\/(p|div|li|tr|table|section|figure|blockquote|dd|dt|ul|ol)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(h).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Generic HTML → text with headings (for bioRxiv/medRxiv or repository HTML when given as HTML). */
export const htmlToMarkdown = arxivHtmlToText;

/** Strip markup from an arxiv_read_paper result that came back as raw HTML (its arxiv_html source). */
export function cleanReadPaper(text) {
  const t = String(text ?? '');
  const markup = (t.match(/<\/?[a-zA-Z][^<>]{0,400}>/g) ?? []).join('').length / (t.length || 1);
  return markup > 0.15 ? arxivHtmlToText(t) : t;
}

/**
 * LaTeXML bibliography (arxiv.org/html, ar5iv) → reference entries { title, year, arxiv, doi, raw }. Used as the reference
 * list of arXiv anchors: OpenAlex's arXiv records carry no referenced_works (five speculative-decoding papers checked: all
 * 0) and undercount citations, so OpenAlex cannot supply the ML/CS citation graph.
 */
export function parseLatexmlBibliography(html) {
  const out = [];
  for (const m of String(html ?? '').matchAll(/<li[^>]*class="ltx_bibitem[^"]*"[^>]*>([\s\S]*?)<\/li>/g)) {
    const item = m[1];
    const blocks = [...item.matchAll(/<span class="ltx_bibblock">([\s\S]*?)<\/span>\s*(?=<span class="ltx_bibblock">|$)/g)].map((b) => b[1]);
    const text = (s) => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const all = text(item);
    const hrefs = [...item.matchAll(/href="([^"]+)"/g)].map((h) => decodeEntities(h[1]));
    let arxiv = null; let doi = null;
    for (const h of hrefs) {
      const d = h.match(/doi\.org\/(10\.\d{4,9}\/[^\s"#?]+)/i)?.[1];
      if (d) { if (/^10\.48550\/arxiv\./i.test(d)) arxiv ??= d.slice(15); else doi ??= d.toLowerCase(); }
      const a = h.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i)?.[1]; if (a) arxiv ??= a;
    }
    arxiv ??= all.match(/(?:arXiv:|abs\/)(\d{4}\.\d{4,5})/i)?.[1] ?? null;
    const year = Number(text(blocks[0]).match(/\b(19[5-9]\d|20[0-4]\d)\b/)?.[1] ?? all.match(/\b(19[5-9]\d|20[0-4]\d)\b/)?.[1]) || null;
    let title = blocks.length >= 2 ? text(blocks[1]).replace(/[.,]\s*$/, '') : null;
    if (!title || title.length < 8) title = null;
    if (title || arxiv || doi) out.push({ title, year, arxiv: arxiv ? arxiv.replace(/v\d+$/, '') : null, doi, raw: all.slice(0, 300) });
  }
  return out;
}
