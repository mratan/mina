// paper_resolve: any paper reference → its work family (versions, identifiers, links), from the authoritative source.
//
// Authority first, enrichment second:
//   arXiv id        → arXiv metadata; OpenAlex (doi 10.48550/arxiv.*) only enriches, and only when its title matches
//                     arXiv's (5 of 37 OpenAlex arXiv records carried another paper's title, 6 did not resolve)
//   PMID / PMCID    → NCBI (ID converter, PubMed record: retraction, corrections, preprint links)
//   bioRxiv/medRxiv → bioRxiv API (versions, published DOI)
//   DOI             → OpenAlex record (free get), else doi.org metadata; PubMed for retraction/correction status
//   OpenAlex id     → OpenAlex;  S2 id → Semantic Scholar (when enabled);  URL → identifiers in the URL, else the page's
//                     citation_* meta tags;  title → OpenAlex title search including retracted works (ambiguous titles
//                     return candidates, not a single answer)
// The result is a work family with lineage links, each link with a confidence and the evidence behind it.
import { parseRef, PREPRINT_SERVER_DOI } from './ids.mjs';
import { FamilyBuilder, familyStatus, versionsOf } from './family.mjs';
import { candidate, normDoi, normTitle, idsFromUrl } from '../lib/normalize.mjs';

export const jaccard = (a, b) => {
  const A = new Set(normTitle(a).split(' ').filter(Boolean)), B = new Set(normTitle(b).split(' ').filter(Boolean));
  const i = [...A].filter((x) => B.has(x)).length; return i / (A.size + B.size - i || 1);
};

function pubmedRecord(a) {
  const types = (a.publicationTypes ?? []).map((t) => (typeof t === 'string' ? t : t.name ?? t.type ?? ''));
  const cc = a.commentsCorrections ?? [];
  const ccOf = (re) => cc.filter((x) => re.test(JSON.stringify(x))).map((x) => ({ pmid: x.pmid ?? x.PMID ?? JSON.stringify(x).match(/"pmid"\s*:\s*"?(\d+)/i)?.[1] ?? null,
    doi: normDoi(JSON.stringify(x).match(/10\.\d{4,9}\/[^"\s,}]+/)?.[0]) ?? null, note: (x.refSource ?? x.note ?? x.text ?? '').toString().slice(0, 160) }));
  const pd = a.journalInfo?.publicationDate;
  const year = Number(pd?.year ?? String(pd ?? a.journalInfo?.pubDate ?? a.pubDate ?? '').match(/\d{4}/)?.[0] ?? a.articleDates?.[0]?.year) || undefined;
  return {
    rec: candidate({ title: a.title, pmid: a.pmid, doi: a.doi, pmcid: a.pmcId ?? a.pmcid, abstract: a.abstractText ?? a.abstract, year,
      venue: a.journalInfo?.title ?? a.journalInfo?.isoAbbreviation ?? a.source, authors: (a.authors ?? []).slice(0, 12).map((x) => (typeof x === 'string' ? x : [x.foreName ?? x.firstName ?? x.givenNames, x.lastName].filter(Boolean).join(' ') || x.collectiveName)).filter(Boolean),
      type: types.join('; ') || undefined, is_retracted: types.some((t) => /retracted publication/i.test(t)) || ccOf(/RetractionIn/i).length > 0 || undefined }),
    retractionIn: ccOf(/RetractionIn/i), erratumIn: ccOf(/ErratumIn|CorrectedandRepublishedIn/i), updateOf: ccOf(/UpdateOf/i), updateIn: ccOf(/UpdateIn/i), types,
  };
}

export async function paperResolve(env, ref, { lineage = true, ctx = {} } = {}) {
  const { p } = env;
  let parsed;
  try { parsed = parseRef(ref); } catch (e) { return { status: 'invalid', error: e.message }; }
  const fb = new FamilyBuilder();
  const sources = []; const notes = []; const conflicts = [];
  const note = (r, what) => { sources.push({ backend: r.backend, op: r.op, outcome: r.outcome, cached: r.cached || undefined, what }); return r; };
  let authority = null; let agreed = 0; let primary = null;
  const add = (rec, source) => { const i = fb.add({ ...rec, _source: source }); return fb.records[i]; };

  // ---- enrichment helpers -------------------------------------------------------------------------------------------
  async function enrichOpenalex(id, expectTitle, source) {
    const r = note(await p.openalex.get({ id, full: true, ctx }), `OpenAlex record for ${id}`);
    if (!r.item) return null;
    if (expectTitle && jaccard(r.item.title, expectTitle) < 0.6) {
      conflicts.push({ source: 'openalex', id: r.item.openalex, their_title: r.item.title, authoritative_title: expectTitle, resolution: 'OpenAlex record not used (title does not match the authoritative source)' });
      return { ...r.item, conflict: true };
    }
    if (expectTitle) agreed++;
    return r.item;
  }
  async function pubmedEnrich(pmid) {
    const f = note(await p.pubmed.fetch({ pmids: [pmid], ctx }), `PubMed record ${pmid}`);
    const a = f.data?.articles?.[0];
    return a ? pubmedRecord(a) : null;
  }
  async function biorxivLineage(doi, preRec) {
    const g = note(await p.biorxiv.published({ doi, ctx }), `bioRxiv published version of ${doi}`);
    const pub = normDoi(g.data?.publishedDoi);
    if (!pub && preRec?.title && normTitle(preRec.title).length >= 30) {
      // The bioRxiv API does not list every publication (it missed the journal version of a known preprint): a journal record with the exact
      // title in PubMed (free) is linked as probable, never as authoritative.
      // title words as [ti] terms (a quoted title phrase with a colon returns nothing); the exact-title check follows
      const tq = [...new Set(normTitle(preRec.title).split(' ').filter((w) => w.length >= 4))].slice(0, 8).map((w) => `${w}[ti]`).join(' AND ');
      const s = note(await p.pubmed.search({ q: tq, n: 10, ctx }), 'PubMed journal records with the preprint title');
      const hit = (s.items ?? []).find((c) => c.doi && !PREPRINT_SERVER_DOI.test(c.doi) && normTitle(c.title) === normTitle(preRec.title) && !/preprint/i.test(c.type ?? '') && !/biorxiv|medrxiv|research square/i.test(c.venue ?? ''));
      if (hit) {
        const vor = await enrichOpenalex(`doi:${hit.doi}`, preRec.title, 'openalex');
        add(vor && !vor.conflict ? vor : hit, vor && !vor.conflict ? 'openalex' : 'pubmed');
        fb.link(`doi:${doi}`, `doi:${hit.doi}`, 'preprint_of', 'probable', 'exact title in a PubMed journal record; the bioRxiv API lists no published version');
        return hit.doi;
      }
    }
    if (pub) {
      const vor = await enrichOpenalex(`doi:${pub}`, null, 'openalex');
      add(vor ?? candidate({ doi: pub, title: g.data?.publishedJournal ? `${preRec?.title ?? ''}` : undefined, venue: g.data?.publishedJournal }), vor ? 'openalex' : 'biorxiv');
      fb.link(`doi:${doi}`, `doi:${pub}`, 'preprint_of', 'authoritative', 'bioRxiv API published DOI');
    }
    return pub;
  }
  async function preprintsOfVor(rec) {
    // Preprint versions of a version of record: OpenAlex locations on a preprint server (strong), then Europe PMC preprint
    // records with the exact title (probable), each confirmed against the bioRxiv API when possible (→ authoritative).
    const found = new Map();
    for (const l of rec.locations ?? []) {
      const ids = idsFromUrl(l.landing ?? l.pdf ?? '');
      if (ids.doi && PREPRINT_SERVER_DOI.test(ids.doi) && ids.doi !== rec.doi) found.set(ids.doi, { conf: 'strong', ev: 'OpenAlex lists the preprint as a location of this work' });
      if (ids.arxiv && !rec.arxiv) found.set(`arxiv:${ids.arxiv}`, { conf: 'strong', ev: 'OpenAlex lists the arXiv version as a location of this work' });
    }
    if (rec.title && normTitle(rec.title).length >= 30) {
      // title words, not the quoted title (a colon inside a quoted phrase finds nothing); exact-title check below
      const q = `${[...new Set(normTitle(rec.title).split(' ').filter((w) => w.length >= 4))].slice(0, 8).map((w) => `TITLE:${w}`).join(' AND ')} AND SRC:PPR`;
      const s = note(await p.europepmc.search({ q, n: 5, ctx }), 'Europe PMC preprint records with this title');
      for (const it of s.items ?? []) if (it.doi && PREPRINT_SERVER_DOI.test(it.doi) && normTitle(it.title) === normTitle(rec.title) && !found.has(it.doi)) found.set(it.doi, { conf: 'probable', ev: 'Europe PMC preprint record with the exact title' });
    }
    for (const [k, v] of found) {
      if (k.startsWith('arxiv:')) { add(candidate({ arxiv: k.slice(6), is_preprint: true, title: rec.title }), 'openalex-location'); fb.link(k, `doi:${rec.doi}`, 'preprint_of', v.conf, v.ev); continue; }
      let conf = v.conf; let ev = v.ev;
      const g = note(await p.biorxiv.published({ doi: k, ctx }), `bioRxiv published version of ${k}`);
      const pub = normDoi(g.data?.publishedDoi);
      if (pub && pub === rec.doi) { conf = 'authoritative'; ev = `${ev}; confirmed by the bioRxiv API published DOI`; }
      else if (pub && pub !== rec.doi) { conf = 'same_title_unverified'; ev = `${ev}; but the bioRxiv API links it to ${pub}`; }
      add(candidate({ doi: k, is_preprint: true, title: g.data?.preprintTitle ?? rec.title, year: Number(String(g.data?.preprintDate ?? '').slice(0, 4)) || undefined }), 'biorxiv');
      fb.link(`doi:${k}`, `doi:${rec.doi}`, 'preprint_of', conf, ev);
    }
  }
  function applyPubmed(pm) {
    if (!pm) return;
    const r = add(pm.rec, 'pubmed');
    for (const x of pm.erratumIn) { r.corrections = [...(r.corrections ?? []), x.doi ? `doi:${x.doi}` : x.pmid ? `pmid:${x.pmid}` : x.note]; }
    for (const x of pm.retractionIn) { r.retraction_notices = [...(r.retraction_notices ?? []), x.doi ? `doi:${x.doi}` : x.pmid ? `pmid:${x.pmid}` : x.note]; }
    for (const x of pm.updateOf) if (x.doi || x.pmid) { const k = x.doi ? `doi:${x.doi}` : `pmid:${x.pmid}`; add(candidate({ doi: x.doi, pmid: x.pmid, is_preprint: true }), 'pubmed'); fb.link(k, refKey(pm.rec), 'preprint_of', 'authoritative', 'PubMed UpdateOf link'); }
    for (const x of pm.erratumIn) if (x.doi || x.pmid) fb.links.push({ from: refKey(pm.rec), to: [x.doi ? `doi:${x.doi}` : `pmid:${x.pmid}`], relation: 'corrected_by', confidence: 'authoritative', evidence: 'PubMed ErratumIn' });
    for (const x of pm.retractionIn) if (x.doi || x.pmid) fb.links.push({ from: refKey(pm.rec), to: [x.doi ? `doi:${x.doi}` : `pmid:${x.pmid}`], relation: 'retracted_by', confidence: 'authoritative', evidence: 'PubMed RetractionIn' });
  }
  const refKey = (r) => (r.doi ? `doi:${r.doi}` : r.pmid ? `pmid:${r.pmid}` : r.arxiv ? `arxiv:${r.arxiv}` : `oa:${r.openalex}`);

  // ---- per kind ----------------------------------------------------------------------------------------------------------
  const k = parsed.kind;
  if (k === 'arxiv') {
    authority = 'arxiv';
    const id = parsed.version ? `${parsed.value}v${parsed.version}` : parsed.value;
    const m = note(await p.arxiv.metadata({ ids: [id], ctx }), `arXiv metadata for ${id}`);
    const x = m.data?.papers?.[0];
    if (!x) return finish(m.outcome === 'ok' || m.outcome === 'empty' || m.outcome === 'not_found' ? 'not_found' : 'error');
    const v = Number(String(x.id).match(/v(\d+)$/)?.[1]) || null;
    primary = add(candidate({ arxiv: parsed.value, arxiv_version: v, title: x.title, abstract: x.abstract, date: x.published, authors: (x.authors ?? []).slice(0, 12).map((a) => (typeof a === 'string' ? a : a.name)),
      venue: x.journal_ref, is_preprint: true, arxiv_updated: x.updated, arxiv_comment: x.comment }), 'arxiv');
    const oa = await enrichOpenalex(`doi:10.48550/arxiv.${parsed.value}`, x.title, 'openalex');
    if (oa && !oa.conflict) { primary.openalex = oa.openalex; primary.cited_by = oa.cited_by; primary.oa = oa.oa; primary.has_content = oa.has_content; primary.locations = oa.locations; fb.find(`oa:${oa.openalex}`); fb.union(primary._node, `oa:${oa.openalex}`); }
    else if (oa?.conflict) primary.openalex_conflict = oa.openalex;
    else notes.push('OpenAlex has no record for this arXiv id');
    if (lineage && x.doi && !/^10\.48550\//.test(x.doi)) {
      const jd = normDoi(x.doi);
      const vor = await enrichOpenalex(`doi:${jd}`, null, 'openalex');
      add(vor ?? candidate({ doi: jd, venue: x.journal_ref }), vor ? 'openalex' : 'arxiv');
      fb.link(`arxiv:${parsed.value}`, `doi:${jd}`, 'preprint_of', 'strong', 'arXiv metadata journal DOI');
    }
  } else if (k === 'pmid' || k === 'pmcid') {
    authority = 'pubmed';
    let pmid = parsed.kind === 'pmid' ? parsed.value : null;
    if (!pmid) {
      const c = note(await p.pubmed.convert({ ids: [parsed.value], idType: 'pmcid', ctx }), `NCBI ID converter for ${parsed.value}`);
      pmid = c.data?.records?.[0]?.pmid ?? null;
      if (!pmid) return finish(c.outcome === 'ok' || c.outcome === 'empty' ? 'not_found' : 'error');
    }
    const pm = await pubmedEnrich(pmid);
    if (!pm) return finish('not_found');
    applyPubmed(pm);
    primary = fb.records.at(-1);
    if (parsed.kind === 'pmcid') primary.pmcid = parsed.value;
    const oa = await enrichOpenalex(`pmid:${pmid}`, pm.rec.title, 'openalex');
    if (oa && !oa.conflict) { const r = add(oa, 'openalex'); Object.assign(primary, { openalex: oa.openalex, cited_by: oa.cited_by, oa: oa.oa, has_content: oa.has_content, locations: oa.locations }); if (lineage && !pm.rec.is_preprint && pm.rec.doi) await preprintsOfVor({ ...r, doi: pm.rec.doi, title: pm.rec.title }); }
    if (pm.rec.doi && PREPRINT_SERVER_DOI.test(pm.rec.doi) && lineage) await biorxivLineage(pm.rec.doi, pm.rec);
  } else if (k === 'biorxiv') {
    authority = 'biorxiv';
    const g = note(await p.biorxiv.preprint({ doi: parsed.value, ctx }), `bioRxiv record for ${parsed.value}`);
    const rec0 = g.data?.preprints?.[0] ?? g.data?.collection?.[0];
    if (!rec0) return finish(g.outcome === 'ok' || g.outcome === 'empty' || g.outcome === 'not_found' ? 'not_found' : 'error');
    // the bioRxiv API returns one entry per version under `revisions`; the latest carries the current title and metadata
    const revs = (rec0.revisions ?? [rec0]).slice().sort((a, b) => (Number(a.version) || 0) - (Number(b.version) || 0));
    const pre = { ...rec0, ...(revs.at(-1) ?? {}) };
    const firstDate = revs[0]?.date ?? pre.date;
    const latest = Number(pre.version) || null;
    primary = add(candidate({ doi: parsed.value, preprint_version: parsed.version ?? latest, title: pre.title, abstract: pre.abstract, date: firstDate, venue: pre.server, is_preprint: true,
      authors: String(pre.authors ?? '').split(/;\s*/).filter(Boolean).slice(0, 12) }), 'biorxiv');
    primary.preprint_versions = revs.map((r) => ({ version: Number(r.version) || null, date: r.date ?? null })).filter((r) => r.version);
    if (parsed.version && latest && parsed.version > latest) notes.push(`requested version v${parsed.version} is newer than the latest known v${latest}`);
    const oa = await enrichOpenalex(`doi:${parsed.value}`, pre.title, 'openalex');
    if (oa && !oa.conflict) Object.assign(primary, { openalex: oa.openalex, cited_by: oa.cited_by, oa: oa.oa, has_content: oa.has_content });
    if (lineage) await biorxivLineage(parsed.value, primary);
  } else if (k === 'doi' || k === 'openalex') {
    authority = 'openalex';
    const id = k === 'doi' ? `doi:${parsed.value}` : parsed.value;
    const r = note(await p.openalex.get({ id, full: true, ctx }), `OpenAlex record for ${id}`);
    if (r.item) {
      primary = add(r.item, 'openalex');
      if (r.item.pmid) { const pm = await pubmedEnrich(r.item.pmid); if (pm) { applyPubmed(pm); if (jaccard(pm.rec.title, r.item.title) >= 0.6) agreed++; } }
      if (lineage && r.item.doi && !PREPRINT_SERVER_DOI.test(r.item.doi) && !r.item.is_preprint) await preprintsOfVor(r.item);
      if (lineage && r.item.doi && PREPRINT_SERVER_DOI.test(r.item.doi)) await biorxivLineage(r.item.doi, r.item);
    } else if (k === 'doi') {
      if (r.outcome === 'budget_exhausted') notes.push('OpenAlex budget exhausted; DOI metadata from doi.org only');
      authority = 'doi_org';
      const d = note(await p.doi_org.get({ doi: parsed.value, ctx }), `doi.org metadata for ${parsed.value}`);
      if (!d.data?.title) return finish(d.outcome === 'not_found' || r.outcome === 'not_found' ? 'not_found' : 'error');
      const cs = d.data;
      primary = add(candidate({ doi: parsed.value, title: Array.isArray(cs.title) ? cs.title[0] : cs.title, venue: Array.isArray(cs['container-title']) ? cs['container-title'][0] : cs['container-title'],
        year: cs.issued?.['date-parts']?.[0]?.[0], type: cs.type, authors: (cs.author ?? []).slice(0, 12).map((a) => [a.given, a.family].filter(Boolean).join(' ')) }), 'doi_org');
    } else return finish(r.outcome === 'not_found' ? 'not_found' : 'error');
  } else if (k === 's2') {
    authority = 'semantic_scholar';
    const state = p.semantic_scholar.state(env.config);
    if (state === 'disabled' || state === 'temporarily_unhealthy') { notes.push(`Semantic Scholar is ${state}`); return finish('unavailable'); }
    const g = note(await p.semantic_scholar.get({ id: parsed.value, ctx }), `Semantic Scholar record ${parsed.value}`);
    if (['rate_limited', 'timeout', 'skipped_unhealthy'].includes(g.outcome)) { notes.push(`Semantic Scholar ${g.outcome} (${state}); this identifier can only be resolved through Semantic Scholar`); return finish('unavailable'); }
    const d = g.data?.data?.[0] ?? g.data?.data ?? g.data;
    const e = d?.external_ids ?? d?.externalIds ?? {};
    const next = e.ArXiv ? `arxiv:${e.ArXiv}` : e.DOI ?? (e.PubMed ? `pmid:${e.PubMed}` : null);
    if (next) { const res = await paperResolve(env, next, { lineage, ctx }); if (res.family) res.family.canonical.s2 = d.paper_id ?? d.paperId; return { ...res, input: parsed, sources: [...sources, ...res.sources] }; }
    if (!d?.title) return finish(g.outcome === 'ok' ? 'not_found' : 'error');
    primary = add(candidate({ s2: d.paper_id ?? d.paperId, title: d.title, year: d.year, venue: d.venue }), 'semantic_scholar');
  } else if (k === 'url') {
    authority = 'url_meta';
    const w = note(await p.web.page({ url: parsed.value, raw: true, ctx }), `page meta tags of ${parsed.value}`);
    const html = w.data?.text ?? '';
    const meta = (n) => html.match(new RegExp(`<meta[^>]+name=["']${n}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${n}["']`, 'i'))?.[1];
    const doi = normDoi(meta('citation_doi') ?? meta('dc\\.identifier') ?? meta('DC\\.Identifier') ?? meta('prism\\.doi'));
    const next = doi ?? (meta('citation_arxiv_id') ? `arxiv:${meta('citation_arxiv_id')}` : meta('citation_pmid') ? `pmid:${meta('citation_pmid')}` : meta('citation_title') ? `title:${meta('citation_title')}` : null);
    if (!next) { notes.push(w.outcome === 'ok' ? 'the page carries no citation meta tags' : `the page could not be read (${w.outcome}: ${w.error ?? ''})`); return finish(w.outcome === 'ok' ? 'not_found' : 'unavailable'); }
    const res = await paperResolve(env, next, { lineage, ctx });
    return { ...res, input: parsed, sources: [...sources, ...res.sources], notes: [...notes, `resolved through the page's citation meta tags (${next})`, ...(res.notes ?? [])] };
  } else if (k === 'title') {
    authority = 'title_search';
    const s = note(await p.openalex.titleSearch({ title: parsed.value, n: 8, ctx }), 'OpenAlex title search (retracted works included)');
    let cands = (s.items ?? []).map((c) => ({ ...c, sim: jaccard(c.title, parsed.value) })).filter((c) => c.sim >= 0.5).sort((a, b) => b.sim - a.sim || (b.cited_by ?? 0) - (a.cited_by ?? 0));
    if (!cands.length && s.outcome !== 'ok') {
      // OpenAlex unavailable or out of budget: PubMed and arXiv title searches instead.
      notes.push(`OpenAlex title search ${s.outcome}; PubMed and arXiv title searches used instead`);
      const [pm, ax] = await Promise.all([p.pubmed.search({ q: `"${parsed.value.replace(/"/g, '')}"[ti]`, n: 5, ctx }), p.arxiv.search({ q: `ti:"${parsed.value.replace(/"/g, '')}"`, n: 5, ctx })]);
      note(pm, 'PubMed title search'); note(ax, 'arXiv title search');
      cands = [...(pm.items ?? []), ...(ax.items ?? [])].map((c) => ({ ...c, sim: jaccard(c.title, parsed.value) })).filter((c) => c.sim >= 0.5).sort((a, b) => b.sim - a.sim);
    }
    if (!cands.length) return finish(s.outcome === 'ok' || s.outcome === 'empty' ? 'not_found' : 'error');
    const exact = cands.filter((c) => c.sim >= 0.9);
    const distinct = new Set(exact.map((c) => normTitle(c.title)));
    if (!exact.length || (exact.length > 1 && distinct.size > 1)) {
      return { status: 'ambiguous', input: parsed, confidence: 'ambiguous', candidates: cands.slice(0, 5).map((c) => ({ title: c.title, year: c.year, venue: c.venue, doi: c.doi, arxiv: c.arxiv, pmid: c.pmid, openalex: c.openalex, type: c.type, is_retracted: c.is_retracted ?? false, cited_by: c.cited_by, similarity: +c.sim.toFixed(2) })),
        sources, notes: [...notes, 'more than one plausible work (or none exact); pass an identifier'] };
    }
    const best = exact.sort((a, b) => (b.cited_by ?? 0) - (a.cited_by ?? 0))[0];
    const next = best.arxiv && !best.doi?.startsWith('10.') ? `arxiv:${best.arxiv}` : best.arxiv ? `arxiv:${best.arxiv}` : best.doi ?? (best.pmid ? `pmid:${best.pmid}` : best.openalex);
    const res = await paperResolve(env, next, { lineage, ctx });
    const others = exact.filter((c) => c !== best).map((c) => ({ doi: c.doi, title: c.title, type: c.type }));
    return { ...res, input: parsed, confidence: res.status === 'ok' ? 'title_match' : res.confidence, sources: [...sources, ...(res.sources ?? [])],
      notes: [...notes, ...(others.length ? [`same-title records not merged: ${others.map((o) => o.doi ?? o.title).join(', ')}`] : []), ...(res.notes ?? [])] };
  }

  return finish('ok');

  function finish(status) {
    if (status !== 'ok' || !fb.records.length) return { status, input: parsed, authority, sources, notes, conflicts, family: null, confidence: null };
    const fams = fb.build();
    const fam = fams.find((f) => f.members.some((m) => m._node === primary?._node || (primary && m.doi && m.doi === primary.doi))) ?? fams[0];
    const status2 = familyStatus(fam.members);
    const confidence = conflicts.length ? 'conflict' : agreed > 0 ? 'exact' : 'single_source';
    const unmerged = fams.filter((f) => f !== fam).map((f) => ({ family_id: f.family_id, title: f.canonical.title, relation: 'same_title_unverified_or_unlinked' }));
    return {
      status: 'ok', input: parsed, authority, confidence, conflicts, notes,
      family: { family_id: fam.family_id, canonical: clean(pickDisplay(fam)), members: fam.members.map(clean), versions: versionsOf(fam.members, fam.canonical), links: fam.links.map(({ from, to, relation, confidence: c, evidence }) => ({ from, to, relation, confidence: c, evidence })),
        retracted: status2.retracted, corrections: status2.corrections, retraction_notices: status2.retraction_notices, unmerged_related: unmerged },
      sources,
    };
  }
  function pickDisplay(fam) {
    // arXiv's own title wins for arXiv families (OpenAlex arXiv titles are not trusted).
    const ax = fam.members.find((m) => m._source === 'arxiv' || (m._sources ?? []).includes('arxiv'));
    return ax && fam.canonical.arxiv ? { ...fam.canonical, title: ax.title ?? fam.canonical.title } : fam.canonical;
  }
}

function clean(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) if (!k.startsWith('_') && v !== undefined && v !== null && !(Array.isArray(v) && !v.length) && k !== 'referenced_works') o[k] = v;
  // Only open-access locations are kept (paper_get's tier 5 uses the PDF URLs OpenAlex lists; nothing is guessed).
  if (o.locations) { o.locations = o.locations.filter((l) => l.is_oa).slice(0, 6); if (!o.locations.length) delete o.locations; }
  if (r._sources?.length) o.sources = r._sources; else if (r._source) o.sources = [r._source];
  return o;
}
