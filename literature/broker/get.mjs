// paper_get: the best open-access text of a paper, validated, as passages, sections or the whole document.
//
// Depths: metadata (no download) · evidence (default; BM25 passages with section provenance) · sections (named sections the
// caller asks for) · full (the whole representation, paged).
//
// Acquisition order, over the work family's members, each tier validated by the broker (validate.mjs) — a tier's
// own completeness claim is recorded, never trusted alone; landing pages and record pages are rejected and the chain
// continues:
//   1  PMC / Europe PMC structured article (pubmed_fetch_fulltext; JATS sections)
//   2  native preprint text: arxiv.org/html → clean text (ar5iv when arxiv.org has no HTML; arxiv_read_paper as the
//      fallback, its markup stripped); bioRxiv/medRxiv rendered article (paced)
//   3  OpenAlex-hosted copy: PDF → text preferred; GROBID TEI only when no PDF, validated like any other tier
//   4  Unpaywall copy (as returned by the pubmed chain), accepted only after validation
//   5  other legitimate open-access PDF: URLs OpenAlex lists as open-access locations (repository / author copies), and
//      the arXiv PDF — no guessed URLs, no web archives, no authenticated routes
//   6  FULLTEXT_UNAVAILABLE with every tier tried and why
import { paperResolve } from './resolve.mjs';
import { validateRepresentation, ACCEPTABLE, USABLE } from './validate.mjs';
import { makeDocument, fromPmcSections, fromTeiSections, arxivHtmlToText, cleanReadPaper } from './text.mjs';
import { buildIndex, retrieve } from './passages.mjs';
import { PREPRINT_SERVER_DOI } from './ids.mjs';
import { TEMPORARY_OUTCOMES } from './runtime.mjs';

export const DEPTHS = ['metadata', 'evidence', 'sections', 'full'];
const FULL_PAGE = 40000;
/** Wait `ms`, ending early when `signal` aborts. */
const waitUnless = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted || ms <= 0) { resolve(); return; }
  const t = setTimeout(end, ms);
  function end() { clearTimeout(t); signal?.removeEventListener('abort', end); resolve(); }
  signal?.addEventListener('abort', end, { once: true });
});

/** Which member is the version the caller wants: published (default when it exists), preprint, or a specific version. */
function membersByVersion(family, version, requested) {
  const ms = family.members;
  const pre = ms.filter((m) => m.is_preprint);
  const vor = ms.filter((m) => !m.is_preprint);
  // A reference that names one manifestation (a preprint DOI, an arXiv id) is read from that manifestation first: the
  // caller asked about that text, and preprint and published wording differ. Otherwise the version of record first.
  if (!version && requested) {
    const own = ms.filter((m) => (requested.doi && m.doi === requested.doi) || (requested.arxiv && m.arxiv === requested.arxiv));
    if (own.length && own.every((m) => m.is_preprint)) return { order: [...own, ...vor, ...pre.filter((m) => !own.includes(m))], strict: false, requested_first: true };
  }
  if (!version || version === 'best') return { order: [...vor, ...pre], strict: false };
  if (version === 'published' || version === 'version_of_record') return { order: vor, strict: true };
  if (version === 'preprint') return { order: pre.sort((a, b) => (b.preprint_version ?? b.arxiv_version ?? 0) - (a.preprint_version ?? a.arxiv_version ?? 0)), strict: true };
  const v = Number(String(version).replace(/^v/i, ''));
  if (v) return { order: pre.map((m) => ({ ...m, preprint_version: m.preprint_version ? v : undefined, arxiv_version: m.arxiv ? v : undefined })), strict: true };
  return { order: [...vor, ...pre], strict: false };
}

/** Representations known from metadata alone (depth=metadata): nothing is downloaded. */
export function knownRepresentations(family) {
  const reps = [];
  for (const m of family.members) {
    if (m.pmcid) reps.push({ representation: 'pmc_jats', member: m.pmcid, tier: 1 });
    if (m.arxiv) reps.push({ representation: 'arxiv_html', member: `arxiv:${m.arxiv}`, tier: 2 });
    if (m.doi && PREPRINT_SERVER_DOI.test(m.doi)) reps.push({ representation: 'biorxiv_page', member: m.doi, tier: 2 });
    if (m.has_content?.pdf) reps.push({ representation: 'openalex_pdf_text', member: m.openalex, tier: 3, cost_usd: 0.01 });
    if (m.has_content?.grobid_xml) reps.push({ representation: 'openalex_tei', member: m.openalex, tier: 3, cost_usd: 0.01 });
    if (m.oa?.url) reps.push({ representation: 'oa_copy', member: m.oa.url, tier: m.oa.url.includes('ncbi.nlm.nih.gov/pmc') ? 1 : 4, oa_status: m.oa.status });
  }
  const seen = new Set();
  return reps.filter((r) => { const k = `${r.representation}|${r.member}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * acquire(env, family, { version, ctx }) → { doc, validation, provenance, tiers, status }
 * status: ok | partial | FULLTEXT_UNAVAILABLE
 */
export async function acquire(env, family, { version, requested = null, ctx = {} } = {}) {
  const { p, rt } = env;
  const { order, strict, requested_first: rf } = membersByVersion(family, version, requested);
  const cacheKey = ['fulltext', family.family_id, version ?? (rf ? `as-requested:${requested.doi ?? requested.arxiv}` : 'best')];
  const hit = rt.cache.get('fulltext', cacheKey);
  if (hit) { rt.log.event('fulltext.cache', { ctx, family: family.family_id, hit: true }); return { ...hit.value, doc: makeDocument(hit.value.doc.text, hit.value.doc.format), cached: true }; }
  const miss = rt.cache.get('fulltext_unavailable', cacheKey);
  if (miss) return { ...miss.value, cached: true };

  const tiers = [];
  // The invocation was cancelled or ran out of time (env.signal / env.deadline from createBroker): no new extraction work,
  // and a result built from cut-short tiers is temporary, never cached as unavailable.
  const stopped = () => Boolean(env.signal?.aborted) || (Number.isFinite(env.deadline) && (rt.now?.() ?? Date.now()) >= env.deadline);
  const toText = async (buf) => (stopped() ? '' : p.pdfToText(buf));
  let best = null; // best usable candidate so far
  const consider = (doc, meta) => {
    const validation = validateRepresentation(doc.text, { altChars: best?.validation?.metrics?.body_chars ?? 0, claim: meta.claim ?? null, representation: meta.representation });
    const row = { tier: meta.tier, source: meta.source, representation: meta.representation, member: meta.member, version: meta.version, url: meta.url ?? null,
      outcome: validation.state, reasons: validation.reasons, chars: validation.metrics.body_chars ?? 0, cost_usd: meta.cost_usd || undefined, claim: meta.claim ?? undefined };
    tiers.push(row);
    if (USABLE.has(validation.state)) {
      const better = !best || (ACCEPTABLE.has(validation.state) && !ACCEPTABLE.has(best.validation.state)) || (!ACCEPTABLE.has(best.validation.state) && (validation.metrics.body_chars ?? 0) > (best.validation.metrics.body_chars ?? 0) * 1.2);
      if (better) best = { doc, validation, provenance: { ...meta, retrieved_at: new Date().toISOString() } };
    }
    return ACCEPTABLE.has(validation.state);
  };
  const failed = (meta, outcome, reason) => tiers.push({ tier: meta.tier, source: meta.source, representation: meta.representation, member: meta.member, version: meta.version, outcome, reasons: [String(reason ?? '').slice(0, 240)] });
  const vlabel = (m) => (m.is_preprint ? `preprint${m.preprint_version ? ` v${m.preprint_version}` : m.arxiv_version ? ` v${m.arxiv_version}` : ''}` : 'version of record');

  const vorsAll = order.filter((m) => !m.is_preprint);
  const presAll = order.filter((m) => m.is_preprint);
  let unpaywallStash = null;
  let unpaywallNoted = false;
  // The tier chain over a set of members; true as soon as one tier gives acceptable text.
  async function chain(vors, pres) {
    // ---- tier 1: PMC / Europe PMC -----------------------------------------------------------------------------------------
    for (const m of vors.concat(pres.filter((x) => x.pmcid))) {
      if (!(m.pmcid || m.pmid || m.doi)) continue;
      const args = m.pmcid ? { pmcids: [m.pmcid] } : m.pmid ? { pmids: [String(m.pmid)] } : { dois: [m.doi] };
      const meta = { tier: 1, source: 'pubmed_fetch_fulltext', member: m.pmcid ?? m.pmid ?? m.doi, version: vlabel(m) };
      const r = await p.pubmed.fulltext({ ...args, ctx });
      const a = r.data?.articles?.[0];
      if (r.outcome !== 'ok' || !a) { failed({ ...meta, representation: 'pmc_jats' }, r.outcome === 'ok' ? 'unavailable' : r.outcome, r.error ?? JSON.stringify(r.data?.unavailable?.[0]?.triedTiers ?? r.data?.unavailable ?? '')); continue; }
      const via = a.viaSource ?? a.source;
      if (via === 'unpaywall') { unpaywallStash = { a, m, meta }; tiers.push({ ...meta, tier: 1, representation: 'pmc_jats', outcome: 'unavailable', reasons: ['no PMC or Europe PMC copy; an Unpaywall copy was returned and is held for tier 4'] }); continue; }
      const doc = a.sections?.length ? fromPmcSections(a) : makeDocument(a.content ?? '', via);
      if (consider(doc, { ...meta, representation: via === 'pmc' ? 'pmc_jats' : `${via}_${a.contentFormat ?? 'text'}`, url: a.pmcUrl ?? a.sourceUrl ?? null, pmcid: a.pmcId ?? null })) return true;
      break; // one PMC attempt per family is enough: the chain resolves DOI/PMID/PMCID to the same article
    }
    // ---- tier 2: native preprint text -----------------------------------------------------------------------------------
    for (const m of pres) {
      if (m.arxiv) {
        const id = m.arxiv_version ? `${m.arxiv}v${m.arxiv_version}` : m.arxiv;
        const meta = { tier: 2, member: `arxiv:${id}`, version: vlabel(m) };
        let got = false;
        for (const [source, url] of [['arxiv_html', `https://arxiv.org/html/${id}`], ['ar5iv', `https://ar5iv.labs.arxiv.org/html/${m.arxiv}`]]) {
          const r = await p.web.page({ url, raw: true, ctx, lane: 'arxiv' });
          if (r.outcome !== 'ok' || !r.data?.text) { failed({ ...meta, source, representation: 'arxiv_html_text' }, r.outcome, r.error ?? 'no page'); continue; }
          if (/<title>[^<]*(No HTML|not found|404)/i.test(r.data.text.slice(0, 3000))) { failed({ ...meta, source, representation: 'arxiv_html_text' }, 'unavailable', 'no HTML rendering for this paper'); continue; }
          if (consider(makeDocument(arxivHtmlToText(r.data.text), 'arxiv_html_text'), { ...meta, source, representation: 'arxiv_html_text', url: r.data.final_url ?? url })) return true;
          got = true; break;
        }
        if (!got) {
          const r = await p.arxiv.read({ id, ctx });
          if (r.outcome === 'ok' && r.text) { if (consider(makeDocument(cleanReadPaper(r.text), 'arxiv_read_paper'), { ...meta, source: 'arxiv_read_paper', representation: `arxiv_read_paper (${r.source ?? 'unknown'}, markup stripped)` })) return true; }
          else failed({ ...meta, source: 'arxiv_read_paper', representation: 'arxiv_read_paper' }, r.outcome, r.error);
        }
      } else if (m.doi && PREPRINT_SERVER_DOI.test(m.doi)) {
        const meta = { tier: 2, source: 'biorxiv_get_fulltext', representation: 'biorxiv_page', member: m.doi, version: vlabel(m) };
        let r = await p.biorxiv.fulltext({ doi: m.doi, version: m.preprint_version, ctx });
        if (r.outcome === 'rate_limited' || r.outcome === 'skipped_unhealthy') {
          // the article pages throttle bursts (HTTP 429 with a Retry-After); for a preprint whose only text is this page, wait once for the lane.
          // The wait ends early on cancellation; it is skipped when the invocation's deadline would pass first. Either way
          // nothing is retried and the lane's health is left as it is (only a completed wait clears the bench).
          const t = rt.now?.() ?? Date.now();
          const until = rt.health.get('biorxiv_page').until ?? 0;
          const wait = Math.min(65000, Math.max(20000, until - t));
          const left = Number.isFinite(env.deadline) ? env.deadline - t : Infinity;
          if (left <= wait) { failed(meta, r.outcome, `${r.error ?? ''} — not retried: the ${Math.round(wait / 1000)} s wait for the lane would outlast the invocation's deadline`); r = null; }
          else {
            failed(meta, r.outcome, `${r.error ?? ''} — waiting ${Math.round(wait / 1000)} s and retrying once`);
            await waitUnless(wait, env.signal);
            if (stopped()) { failed(meta, env.signal?.aborted ? 'cancelled' : 'timeout', 'the wait for the bioRxiv page lane was cut short (the invocation was cancelled or ran out of time); not retried'); r = null; }
            else {
              rt.health.mark('biorxiv_page', 'healthy', 0, 'retry after wait');
              r = await p.biorxiv.fulltext({ doi: m.doi, version: m.preprint_version, ctx });
            }
          }
        }
        if (!r) { /* recorded above */ } else if (r.outcome === 'ok' && r.text) { if (consider(makeDocument(r.text, 'biorxiv_page'), meta)) return true; }
        else failed(meta, r.outcome, r.error);
      }
    }
    // ---- tier 3: OpenAlex-hosted copy ------------------------------------------------------------------------------------
    for (const m of [...vors, ...pres]) {
      if (!m.openalex || !(m.has_content?.pdf || m.has_content?.grobid_xml)) continue;
      const meta = { tier: 3, source: 'openalex_content', member: m.openalex, version: vlabel(m) };
      if (m.has_content.pdf) {
        const r = await p.openalex.content({ id: m.openalex, format: 'pdf', ctx });
        if (r.outcome === 'ok' && r.data?.pdf) {
          const text = await toText(Buffer.from(r.data.pdf));
          if (text && consider(makeDocument(text, 'pdf_text'), { ...meta, representation: 'openalex_pdf_text', cost_usd: r.cost_usd })) return true;
          if (!text) failed({ ...meta, representation: 'openalex_pdf_text' }, 'error', 'PDF text extraction returned nothing');
        } else failed({ ...meta, representation: 'openalex_pdf_text' }, r.outcome, r.error ?? r.data?.reason);
      }
      if (m.has_content.grobid_xml && !(best && ACCEPTABLE.has(best.validation.state))) {
        const r = await p.openalex.content({ id: m.openalex, format: 'grobid_xml', ctx });
        if (r.outcome === 'ok' && r.data?.sections) { if (consider(fromTeiSections(r.data.sections, r.data.title), { ...meta, representation: 'openalex_tei', claim: r.data.claim, cost_usd: r.cost_usd })) return true; }
        else failed({ ...meta, representation: 'openalex_tei' }, r.outcome, r.error ?? r.data?.reason);
      }
    }
    // ---- tier 4: Unpaywall (held from tier 1) ----------------------------------------------------------------------------
    if (unpaywallStash) {
      const { a, m, meta } = unpaywallStash;
      const doc = makeDocument(a.content ?? '', `unpaywall_${a.contentFormat ?? 'text'}`);
      if (consider(doc, { ...meta, tier: 4, source: 'unpaywall', representation: `unpaywall_${a.contentFormat ?? 'text'}`, url: a.sourceUrl ?? null, host_type: a.hostType ?? null, claim: 'complete' })) return true;
    } else if (p.keys?.unpaywall === false && !unpaywallNoted && [...vors, ...pres].some((m) => m.doi)) {
      // Unpaywall's API requires a contact address; without one the pubmed server never queries it (no placeholder is sent).
      unpaywallNoted = true;
      tiers.push({ tier: 4, source: 'unpaywall', representation: 'unpaywall', outcome: 'skipped', reasons: ['Unpaywall skipped: no email set (Unpaywall requires a contact address; set RESEARCH_EMAIL to enable it)'] });
    }
    // ---- tier 5: other open-access PDFs OpenAlex lists (repository / author copies), arXiv PDF --------------------------
    const pdfUrls = [];
    for (const m of [...vors, ...pres]) {
      for (const l of m.locations ?? []) if (l.is_oa && l.pdf && !/arxiv\.org|biorxiv\.org|medrxiv\.org|ncbi\.nlm\.nih\.gov/.test(l.pdf)) pdfUrls.push({ url: l.pdf, source: l.source ?? 'open-access location', kind: l.source_type === 'repository' ? 'repository_copy' : 'oa_location_pdf', version: l.version, m });
      if (m.arxiv) pdfUrls.push({ url: `https://arxiv.org/pdf/${m.arxiv_version ? `${m.arxiv}v${m.arxiv_version}` : m.arxiv}`, source: 'arXiv', kind: 'arxiv_pdf', m });
    }
    for (const u of pdfUrls.slice(0, 3)) {
      if (best && ACCEPTABLE.has(best.validation.state)) break;
      const meta = { tier: 5, source: u.source, representation: `${u.kind}_pdf_text`, member: u.url, version: u.version ? `${vlabel(u.m)} (${u.version})` : vlabel(u.m), url: u.url };
      const r = await p.web.pdf({ url: u.url, ctx });
      if (r.outcome === 'ok' && r.data?.pdf) {
        const text = await toText(r.data.pdf);
        if (text && consider(makeDocument(text, 'pdf_text'), meta)) return true;
        if (!text) failed(meta, 'error', 'PDF text extraction returned nothing');
      } else failed(meta, r.outcome === 'empty' ? 'unavailable' : r.outcome, r.error ?? (r.data?.notPdf ? `not a PDF (${r.data.contentType})` : ''));
    }
    return false;
  }
  if (rf) {
    // the requested preprint's own text first (its PMC copy, its native page, its OpenAlex copy), then the rest of the family
    if (await chain([], presAll.slice(0, 1))) return done();
    if (await chain(vorsAll, presAll.slice(1))) return done();
  } else if (await chain(vorsAll, presAll)) return done();
  if (strict && !order.length) tiers.push({ tier: 0, outcome: 'unavailable', reasons: [`the family has no ${version} member`] });
  return done();

  function done() {
    let out;
    // a tier that failed for a temporary reason (rate limit, timeout, benched or held lane) is not evidence that no copy, or
    // no more complete copy, exists
    const temporary = tiers.filter((t) => TEMPORARY_OUTCOMES.includes(t.outcome));
    const why = `${temporary.length} tier(s) failed temporarily (${[...new Set(temporary.map((t) => `${t.source ?? t.representation}: ${t.outcome}`))].join(', ')})`;
    const halted = stopped();
    if (best) {
      out = { status: ACCEPTABLE.has(best.validation.state) ? 'ok' : 'partial', doc: best.doc, validation: best.validation, provenance: best.provenance, tiers };
      // Partial text is the final answer only when every other tier failed for good; otherwise a later call may do better.
      if (out.status === 'partial' && (temporary.length || halted)) {
        out.temporary = true;
        out.validation = { ...best.validation, reasons: [...(best.validation.reasons ?? []), halted ? 'the acquisition was cancelled or ran out of time before every tier was tried; a later call may find more complete text'
          : `${why}; a later call may find more complete text`] };
      }
    } else {
      out = { status: 'FULLTEXT_UNAVAILABLE', doc: null, temporary: temporary.length > 0 || halted, provenance: null, tiers,
        validation: { state: 'unavailable', reasons: temporary.length ? [`no usable text, but ${why}; try again later`] : ['no tier returned usable article text'] } };
    }
    // Never cache a stopped acquisition (its tiers were cut short) or a temporary result: the fulltext entry never expires
    // and the unavailable one lasts a week.
    if (halted || out.temporary) { /* not cached */ }
    else if (out.status === 'FULLTEXT_UNAVAILABLE') rt.cache.put('fulltext_unavailable', cacheKey, out);
    else rt.cache.put('fulltext', cacheKey, { ...out, doc: { text: out.doc.text, format: out.doc.format } }, { provenance: out.provenance });
    rt.log.event('fulltext', { ctx, family: family.family_id, status: out.status, chosen: out.provenance?.representation ?? null, tiers: tiers.map((t) => `${t.tier}:${t.representation}:${t.outcome}`) });
    return out;
  }
}

/**
 * paperGet(env, { ref, depth, query, sections, version, offset, max_chars, exclude, k })
 */
export async function paperGet(env, params) {
  const { ref, depth = 'evidence', query, sections: wantSections, version, offset = 0, max_chars: maxChars, exclude = [], k } = params ?? {};
  if (!DEPTHS.includes(depth)) return { status: 'invalid', error: `depth must be one of ${DEPTHS.join(', ')}` };
  const ctx = { tool: 'paper_get', depth, ref: String(typeof ref === 'object' ? JSON.stringify(ref) : ref).slice(0, 200) };
  const res = await paperResolve(env, ref, { ctx });
  if (res.status !== 'ok') return { status: res.status, depth, resolve: res };
  const fam = res.family;
  const meta = { family_id: fam.family_id, title: fam.canonical.title, year: fam.canonical.year ?? null, venue: fam.canonical.venue ?? null, authors: (fam.canonical.authors ?? []).slice(0, 8),
    identifiers: Object.fromEntries(['doi', 'pmid', 'pmcid', 'arxiv', 'openalex', 's2'].map((x) => [x, fam.members.find((m) => m[x] && (x !== 'doi' || !m.is_preprint))?.[x] ?? fam.members.find((m) => m[x])?.[x]]).filter(([, v]) => v)),
    versions: fam.versions, retracted: fam.retracted, corrections: fam.corrections, oa: fam.members.find((m) => m.oa)?.oa ?? null, abstract: fam.canonical.abstract ?? null,
    known_representations: knownRepresentations(fam), resolution: { authority: res.authority, confidence: res.confidence, conflicts: res.conflicts, notes: res.notes } };
  if (depth === 'metadata') return { status: 'ok', depth, paper: meta };
  if (depth === 'evidence' && !query) return { status: 'invalid', error: 'depth=evidence needs `query` (the question the passages should answer); use depth=sections or depth=full otherwise', paper: meta };

  const got = await acquire(env, { ...fam, members: fam.members }, { version, requested: res.input?.ids ?? null, ctx });
  const ft = { status: got.status, temporary: got.temporary || undefined, completeness: got.validation.state, completeness_reasons: got.validation.reasons, provenance: got.provenance, tiers_tried: got.tiers, cached: got.cached || false };
  if (got.status === 'FULLTEXT_UNAVAILABLE') {
    return { status: 'FULLTEXT_UNAVAILABLE', depth, paper: meta, fulltext: ft,
      note: got.temporary ? `No usable article text now: ${got.validation.reasons[0]}. Only the abstract is available for the moment; label claims from it abstract-only.`
        : 'No usable article text from any open-access tier. Only the abstract (above) is available: label claims from it abstract-only.' };
  }
  const doc = got.doc;
  const source = { representation: got.provenance.representation, source: got.provenance.source, tier: got.provenance.tier, version: got.provenance.version, url: got.provenance.url ?? null, completeness: got.validation.state };
  const outline = doc.sections.filter((s) => s.level <= 3).map((s) => ({ id: s.id, title: s.title, level: s.level, start: s.start, end: s.end }));

  if (depth === 'evidence') {
    const idxKey = ['index', fam.family_id, source.representation, source.version];
    const index = buildIndex(doc);
    env.rt.cache.put('index', idxKey, { paragraphs: index.items.length, sections: doc.sections.length }, {});
    const r = retrieve(index, query, { k: k ?? 8, maxChars: maxChars ?? 6000, exclude });
    const passages = r.passages.map((x) => ({ id: x.id, text: x.text, section: x.section, subsection: x.subsection, section_path: x.section_path, section_status: x.section ? 'from_representation' : 'unavailable',
      offset_start: x.start, offset_end: x.end, score: x.score, representation: source.representation, version: source.version, source_tier: source.tier, completeness: source.completeness }));
    env.rt.log.event('evidence', { ctx, family: fam.family_id, representation: source.representation, passages: passages.length, chars: passages.reduce((s, x) => s + x.text.length, 0), more: r.more });
    return { status: got.status === 'partial' ? 'ok_partial_text' : 'ok', depth, paper: meta, fulltext: ft, source, query, passages, more_available: r.more,
      next: r.more ? { exclude: [...exclude, ...passages.map((x) => x.id)], hint: 'call paper_get again with the same query and this exclude list for the next passages' } : null,
      section_outline: outline, document_chars: doc.text.length };
  }
  if (depth === 'sections') {
    if (!wantSections?.length) return { status: 'ok', depth, paper: meta, fulltext: ft, source, section_outline: outline, note: 'pass `sections` (titles or ids from this outline) to receive their text' };
    const want = wantSections.map((s) => String(s).toLowerCase());
    const picked = doc.sections.filter((s) => want.some((w) => s.id === w || s.title.toLowerCase().includes(w) || s.path.some((x) => x.toLowerCase() === w)));
    // drop sections contained in another picked section
    const top = picked.filter((s) => !picked.some((o) => o !== s && o.start <= s.start && s.end <= o.end && (o.start !== s.start || o.end !== s.end)));
    const limit = maxChars ?? 30000; let used = 0;
    const out = [];
    for (const s of top) { const text = doc.text.slice(s.start, s.end); const take = text.slice(0, Math.max(0, limit - used)); used += take.length; out.push({ id: s.id, title: s.title, path: s.path, offset_start: s.start, offset_end: s.start + take.length, truncated: take.length < text.length, text: take }); if (used >= limit) break; }
    return { status: out.length ? 'ok' : 'not_found', depth, paper: meta, fulltext: ft, source, sections: out, section_outline: outline,
      ...(out.length ? {} : { note: `no section matched ${JSON.stringify(wantSections)}; see section_outline` }) };
  }
  // full, paged
  const size = Math.min(maxChars ?? FULL_PAGE, 100000);
  const slice = doc.text.slice(offset, offset + size);
  return { status: 'ok', depth, paper: meta, fulltext: ft, source, section_outline: outline, offset, returned_chars: slice.length, document_chars: doc.text.length,
    next_offset: offset + slice.length < doc.text.length ? offset + slice.length : null, text: slice };
}
