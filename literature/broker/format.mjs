// Model-facing text for the four tools: compact, grouped, with identifiers and provenance a model can act
// on. The full machine-readable result travels in the tool's `details`.

const idLine = (ids = {}) => ['doi', 'pmid', 'pmcid', 'arxiv', 'preprint_doi', 'openalex'].filter((k) => ids[k]).map((k) => `${k === 'preprint_doi' ? 'preprint' : k}:${ids[k]}`).join(' · ');
const yr = (y) => (y ? ` (${y})` : '');

function famLine(f, i) {
  const sig = f.role_signals ?? {};
  const why = [
    sig.anchor_refs ? `referenced by ${sig.anchor_refs} anchor paper${sig.anchor_refs > 1 ? 's' : ''}` : null,
    f.cited_by ? `cited ${f.cited_by}×` : null,
    `found by ${f.found_by.map((b) => (b.startsWith('expansion') ? `citation expansion (${b.split(':').slice(1).join(' ')})` : b)).join(', ')}`,
  ].filter(Boolean).join('; ');
  const flags = [f.retracted ? 'RETRACTED' : null, f.openalex_conflict ? 'OpenAlex record conflicts with arXiv (not used)' : null, f.versions?.length > 1 ? `${f.versions.length} versions (one study)` : null].filter(Boolean);
  return `${i}. ${f.title ?? '(untitled)'}${yr(f.year)}${f.venue ? ` — ${f.venue}` : ''}\n   ${idLine(f.ids)}${f.roles?.length ? ` · roles: ${f.roles.filter((r) => r !== 'foundational').join(', ')}` : ''}${flags.length ? ` · ${flags.join(' · ')}` : ''}\n   ${why}  [family ${f.family_id}]`;
}

export function formatSearch(r) {
  if (r.status !== 'ok') return `literature_search: ${r.status}${r.error ? ` — ${r.error}` : ''}`;
  if (r.mode === 'identifier_lookup') return `literature_search: the query is an identifier; resolved instead of searched.\n${formatResolve(r.resolve)}`;
  if (!r.coverage) return `literature_search (continuation): ${r.results.length} more families\n${r.results.map((f, i) => famLine(f, (r.page?.offset ?? 0) + i + 1)).join('\n')}${r.continuation ? `\nMore: continuation="${r.continuation}"` : ''}`;
  const c = r.coverage;
  const head = [`literature_search (${r.mode}, field ${r.field}${c.field_inferred ? ' inferred' : ''}): ${r.results.length} of ${c.candidates.after_filters} work families (${c.candidates.raw} records).`,
    `Backends succeeded: ${c.backends_succeeded.join(', ') || 'none'}.${c.backends_failed.length ? ` FAILED: ${[...new Set(c.backends_failed.map((f) => `${f.backend} (${f.reason})`))].join(', ')}.` : ''} Not routed: ${c.backends_not_routed.map((b) => b.backend).join(', ') || 'none'}.`,
    c.citation_expansion ? `Citation expansion: ${c.expansion.counts.anchors} anchors → ${c.expansion.counts.edges} edges, ${c.expansion.counts.kept} kept${c.expansion.named_methods?.length ? `; named-method searches: ${c.expansion.named_methods.map((n) => `${n.name}${n.found ? '' : ' (nothing)'}`).join(', ')}` : ''}.` : null,
  ].filter(Boolean);
  let body;
  let n = 0;
  if (r.groups) body = r.groups.map((g) => `\n## ${g.label}\n${g.families.map((id) => famLine(r.results.find((f) => f.family_id === id), ++n)).join('\n')}`).join('\n');
  else body = `\n${r.results.map((f) => famLine(f, ++n)).join('\n')}`;
  const tail = [
    c.searches_with_zero_results.length ? `Searches with zero results: ${c.searches_with_zero_results.slice(0, 6).join(' | ')}` : null,
    c.coverage_notes.length ? `Notes: ${[...new Set(c.coverage_notes)].join(' · ')}` : null,
    c.absence_statement ? `Absence reporting: ${c.absence_statement}` : null,
    r.continuation ? `More: ${c.candidates.overflow} further families — call literature_search with continuation="${r.continuation}".` : null,
    'Search relevance is not scientific importance: the foundational group comes from citation structure, not from query wording. Read papers with paper_get(ref, depth="evidence", query=…) before relying on them.',
  ].filter(Boolean);
  return [...head, body, '', ...tail].join('\n');
}

export function formatResolve(r) {
  if (!r) return '';
  if (r.status === 'ambiguous') return `paper_resolve: ambiguous — candidates:\n${r.candidates.map((c, i) => `${i + 1}. ${c.title}${yr(c.year)} ${idLine(c)}${c.is_retracted ? ' RETRACTED' : ''} (similarity ${c.similarity})`).join('\n')}\n${r.notes.join(' ')}`;
  if (r.status !== 'ok') return `paper_resolve: ${r.status}${r.error ? ` — ${r.error}` : ''}${r.notes?.length ? `\n${r.notes.join(' ')}` : ''}`;
  const f = r.family;
  const lines = [`paper_resolve: ${f.canonical.title ?? '(untitled)'}${yr(f.canonical.year)}${f.canonical.venue ? ` — ${f.canonical.venue}` : ''}`,
    `family ${f.family_id} · authority ${r.authority} · confidence ${r.confidence}${f.retracted ? ' · RETRACTED' : ''}${f.corrections?.length ? ` · corrected by ${f.corrections.join(', ')}` : ''}`,
    'Versions (one study):', ...f.versions.map((v) => `  - ${v.kind}${v.version ? ` v${v.version}` : ''}${v.year ? ` ${v.year}` : ''}${v.venue ? ` ${v.venue}` : ''}: ${idLine(v.ids)}${v.canonical ? '  ← canonical' : ''}`)];
  const lin = f.links.filter((l) => l.relation !== 'same_record');
  if (lin.length) lines.push('Lineage:', ...lin.map((l) => `  - ${l.from} ${l.relation} ${l.to.join(', ')} [${l.confidence}: ${l.evidence}]`));
  if (r.conflicts?.length) lines.push('Conflicts:', ...r.conflicts.map((c) => `  - ${c.source} ${c.id}: "${c.their_title}" ≠ "${c.authoritative_title}" — ${c.resolution}`));
  if (f.unmerged_related?.length) lines.push(`Related but not merged (title only): ${f.unmerged_related.map((u) => u.family_id).join(', ')}`);
  if (r.notes?.length) lines.push(`Notes: ${r.notes.join(' · ')}`);
  return lines.join('\n');
}

export function formatGet(r) {
  if (r.status === 'invalid') return `paper_get: ${r.error}`;
  if (!r.paper) return `paper_get: ${r.status}\n${formatResolve(r.resolve)}`;
  const p = r.paper;
  const head = `paper_get (${r.depth}): ${p.title}${yr(p.year)}${p.venue ? ` — ${p.venue}` : ''}\nfamily ${p.family_id} · ${idLine(p.identifiers)}${p.retracted ? ' · RETRACTED' : ''}${p.corrections?.length ? ` · corrected by ${p.corrections.join(', ')}` : ''}`;
  if (r.depth === 'metadata') {
    return `${head}\nversions: ${p.versions.map((v) => `${v.kind}${v.version ? ` v${v.version}` : ''}`).join(', ')}\nknown full-text representations: ${p.known_representations.map((k) => k.representation).join(', ') || 'none known'}\n${p.abstract ? `Abstract: ${p.abstract}` : 'No abstract.'}`;
  }
  const tiers = (r.fulltext?.tiers_tried ?? []).map((t) => `${t.tier}:${t.representation ?? t.source}=${t.outcome}${t.reasons?.length && t.outcome !== 'complete' && t.outcome !== 'likely_complete' ? ` (${t.reasons[0]})` : ''}`).join('; ');
  if (r.status === 'FULLTEXT_UNAVAILABLE') return `${head}\nFULLTEXT_UNAVAILABLE${r.fulltext?.temporary ? ' (temporary: a source was rate limited or timed out; try again later)' : ''} — tiers tried: ${tiers}\n${p.abstract ? `Abstract (abstract-only; label claims from it as such): ${p.abstract}` : 'No abstract either.'}`;
  const s = r.source;
  const src = `source: ${s.representation} (tier ${s.tier}, ${s.version}, completeness ${s.completeness})${s.url ? ` ${s.url}` : ''}${r.fulltext.cached ? ' [cached]' : ''}`;
  if (r.depth === 'evidence') {
    const ps = r.passages.map((x) => `[${x.id}] ${x.section ?? 'section unavailable'}${x.subsection ? ` › ${x.subsection}` : ''} · chars ${x.offset_start}–${x.offset_end}\n${x.text}`).join('\n\n');
    return `${head}\n${src}\nquery: ${r.query}\n\n${ps || '(no passage matched the query terms)'}\n\n${r.more_available ? `More passages: call paper_get again with the same query and exclude=${JSON.stringify(r.next.exclude)}. ` : ''}Full text only if passages are insufficient: depth="sections" (sections=[…]) or depth="full".\ntiers: ${tiers}`;
  }
  if (r.depth === 'sections') {
    if (!r.sections) return `${head}\n${src}\nSections: ${r.section_outline.map((o) => `${o.id} ${'  '.repeat(Math.max(0, o.level - 1))}${o.title}`).join('\n')}\n${r.note ?? ''}`;
    return `${head}\n${src}\n${r.sections.map((x) => `### ${x.path.join(' › ')} (chars ${x.offset_start}–${x.offset_end}${x.truncated ? ', truncated' : ''})\n${x.text}`).join('\n\n')}${r.note ? `\n${r.note}` : ''}`;
  }
  return `${head}\n${src}\nchars ${r.offset}–${r.offset + r.returned_chars} of ${r.document_chars}${r.next_offset ? ` · continue with offset=${r.next_offset}` : ' · end of document'}\n\n${r.text}`;
}

export function formatExpand(r) {
  if (r.status !== 'ok') return `citation_expand: ${r.status}${r.error ? ` — ${r.error}` : ''}`;
  const lines = [`citation_expand (${r.direction}) of ${r.anchor.title} [family ${r.anchor.family_id}]: ${r.results.length} work families`,
    `calls: ${r.calls.map((c) => `${c.backend}.${c.relation}=${c.outcome}(${c.count})`).join(', ')}`];
  r.results.slice(0, 60).forEach((f, i) => lines.push(`${i + 1}. ${f.title ?? '(untitled)'}${yr(f.year)} — ${idLine(f.ids)}${f.retracted ? ' RETRACTED' : ''} · ${f.relations.map((x) => `${x.relation} via ${x.backend}${x.rank ? ` #${x.rank}` : ''}`).join(', ')}`));
  if (r.results.length > 60) lines.push(`… ${r.results.length - 60} more in details`);
  if (r.notes?.length) lines.push(`Notes: ${r.notes.join(' · ')}`);
  return lines.join('\n');
}
