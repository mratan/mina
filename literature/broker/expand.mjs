// Citation expansion: OpenAlex references and citing works, PubMed references, cited-by and similar lists for PMID-bearing
// anchors. OpenAlex related_works is not offered (0 relevant papers across 9 test anchors). Semantic Scholar graph
// operations are not offered until re-evaluated with an API key.
//
// expandAnchor() returns raw candidates tagged with the relation and the backend that produced each edge;
// citationExpand() (the public tool) resolves the anchor first, then returns normalized work families.

/**
 * expandAnchor(env, anchor, { direction, limit, sources })
 *   anchor: a record with openalex and/or pmid (and arxiv/title for the arXiv identity check)
 *   direction: references | citing | similar | both
 * → { edges: [{ candidate, relation, backend, anchor, rank }], calls: [...], notes: [...] }
 */
export async function expandAnchor(env, anchor, { direction = 'both', limit = 50, refLimit = limit, sources = ['openalex', 'pubmed', 'arxiv_bibliography'], ctx } = {}) {
  const { p } = env;
  const edges = []; const calls = []; const notes = [];
  const anchorId = anchor.family_id ?? anchor.openalex ?? anchor.pmid ?? anchor.doi;
  const want = (d) => direction === d || (direction === 'both' && d !== 'similar');
  const jobs = [];
  if (sources.includes('openalex') && anchor.openalex) {
    if (anchor.openalex_conflict) notes.push(`OpenAlex record ${anchor.openalex} does not match the arXiv title; OpenAlex expansion skipped for this anchor`);
    else {
      if (want('references')) jobs.push(p.openalex.references({ openalex: anchor.openalex, n: Math.max(limit, 150), ctx }).then((r) => ({ r, relation: 'references', backend: 'openalex' })));
      if (want('citing')) jobs.push(p.openalex.citing({ openalex: anchor.openalex, n: limit, ctx }).then((r) => ({ r, relation: 'cited_by', backend: 'openalex' })));
    }
  } else if (sources.includes('openalex') && !anchor.arxiv) notes.push(`no OpenAlex id for anchor ${anchorId}`);
  // arXiv anchors: the paper's own bibliography (OpenAlex arXiv records have no reference lists).
  if (sources.includes('arxiv_bibliography') && anchor.arxiv && want('references')) jobs.push(p.arxiv.bibliography({ id: anchor.arxiv, ctx }).then((r) => ({ r, relation: 'references', backend: 'arxiv_html' })));
  if (sources.includes('pubmed') && anchor.pmid) {
    if (want('references')) jobs.push(p.pubmed.related({ pmid: anchor.pmid, relationship: 'references', n: refLimit, ctx }).then((r) => ({ r, relation: 'references', backend: 'pubmed' })));
    if (want('citing')) jobs.push(p.pubmed.related({ pmid: anchor.pmid, relationship: 'cited_by', n: limit, ctx }).then((r) => ({ r, relation: 'cited_by', backend: 'pubmed' })));
    if (direction === 'similar') jobs.push(p.pubmed.related({ pmid: anchor.pmid, relationship: 'similar', n: limit, ctx }).then((r) => ({ r, relation: 'similar', backend: 'pubmed' })));
  }
  const settled = await Promise.allSettled(jobs);
  for (const s of settled) {
    if (s.status !== 'fulfilled') { calls.push({ backend: 'unknown', outcome: 'error', error: String(s.reason?.message ?? s.reason) }); continue; }
    const { r, relation, backend } = s.value;
    calls.push({ backend, op: r.op, relation, outcome: r.outcome, count: r.items?.length ?? 0, total: r.total ?? null, ms: r.ms, cached: r.cached, error: r.error ?? undefined });
    for (const c of r.items ?? []) edges.push({ candidate: { ...c, _source: `${backend}:${relation}` }, relation, backend, anchor: anchorId, rank: c.rank });
  }
  return { edges, calls, notes };
}
