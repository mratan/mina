// OpenAlex full text through the OpenAlex Content API (docs/research-literature.md, "OpenAlex content").
//
//   identifier (OpenAlex W-id or URL, DOI, pmid:N, pmcid:PMCN)
//     → resolve the work (api.openalex.org)                       NOT_FOUND when OpenAlex has no such work
//     → check has_content / content_urls                          FULLTEXT_UNAVAILABLE when OpenAlex holds no copy
//     → fetch GROBID TEI XML (structured; preferred) or the PDF   ERROR on a failed fetch
//     → sections and provenance
//
// The official OpenAlex MCP stays the discovery and citation interface; this helper only fetches content. It needs
// OPENALEX_API_KEY (each content file costs about USD 0.01 of the key's daily budget). The key is sent as a query
// parameter, as the API requires, and never appears in a returned URL, a provenance record, or an error message.
// Only legal open-access copies that OpenAlex itself holds are retrieved; nothing here handles paywalled content.
import { MINA_USER_AGENT } from '../adapters/pi-research-search/src/user-agent.js';

const API = 'https://api.openalex.org';
const SELECT = 'id,doi,ids,title,display_name,publication_date,primary_location,authorships,open_access,has_content,content_urls,has_fulltext,abstract_inverted_index,type';

// One canonical identifier form per kind, so records from different sources can be related later (DOIs lowercased, PMC ids uppercased).
export function normalizeIdentifier(raw) {
  const s = String(raw ?? '').trim();
  let m;
  if ((m = s.match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i))) return { kind: 'openalex', value: m[1].toUpperCase(), key: m[1].toUpperCase() };
  if ((m = s.match(/^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i))) return { kind: 'doi', value: m[1].toLowerCase(), key: `doi:${m[1].toLowerCase()}` };
  if ((m = s.match(/^(?:pmid:|https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)(\d+)\/?$/i))) return { kind: 'pmid', value: m[1], key: `pmid:${m[1]}` };
  if ((m = s.match(/^(?:pmcid:)?(PMC\d+)$/i))) return { kind: 'pmcid', value: m[1].toUpperCase(), key: `pmcid:${m[1].toUpperCase()}` };
  throw new Error(`INVALID_IDENTIFIER: ${s.slice(0, 80)} is not an OpenAlex ID, DOI, pmid:N, or PMCID`);
}

const strip = (url) => String(url ?? '').replace(/^https?:\/\/(?:openalex\.org|doi\.org|pubmed\.ncbi\.nlm\.nih\.gov|www\.ncbi\.nlm\.nih\.gov\/pmc\/articles)\//, '').replace(/\/$/, '');

export function abstractFrom(inverted) {
  if (!inverted) return null;
  const words = [];
  for (const [w, positions] of Object.entries(inverted)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(' ') || null;
}

// The candidate-record shape new literature code uses; provider-specific fields stay out of it.
export function toRecord(work) {
  const ids = work.ids ?? {};
  return {
    title: work.display_name ?? work.title ?? null,
    authors: (work.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
    date: work.publication_date ?? null,
    venue: work.primary_location?.source?.display_name ?? null,
    abstract: abstractFrom(work.abstract_inverted_index),
    identifiers: { openalex: strip(work.id) || null, doi: ids.doi ? strip(ids.doi).toLowerCase() : null,
      pmid: ids.pmid ? strip(ids.pmid) : null, pmcid: ids.pmcid ? strip(ids.pmcid).replace(/^.*\//, '').toUpperCase() : null },
    source: 'openalex',
    url: work.id ?? null,
    oa_status: work.open_access?.oa_status ?? null,
    fulltext: { openalex_content: { grobid_xml: Boolean(work.has_content?.grobid_xml), pdf: Boolean(work.has_content?.pdf) } },
  };
}

// GROBID wraps each sentence in <s>; a sentence boundary becomes a space, so sentences do not run together.
const decode = (t) => t.replace(/<\/s>\s*/g, ' ').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ').trim();

// GROBID TEI → sections of the body ({ n, head, text }), in document order. Dependency-free on purpose: GROBID's body is
// a flat list of <div> elements, each with an optional <head> and <p> paragraphs; formulas and figure references are
// flattened to their text. Front matter and the bibliography are not body text.
export function teiSections(xml) {
  const body = String(xml).match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? '';
  const sections = [];
  for (const m of body.matchAll(/<div\b[^>]*>([\s\S]*?)<\/div>/g)) {
    const div = m[1];
    const headM = div.match(/<head(?:\s+n="([^"]*)")?[^>]*>([\s\S]*?)<\/head>/);
    const paras = [...div.matchAll(/<(p|formula)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((p) => decode(p[2])).filter(Boolean);
    if (!headM && !paras.length) continue;
    sections.push({ n: headM?.[1] ?? null, head: headM ? decode(headM[2]) : null, text: paras.join('\n\n') });
  }
  return sections;
}

const sectionRe = (names) => new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');

// GROBID can miss or merge sections. "complete" here is a description of what came back, not a guarantee: a body whose
// headings include methods-like and results-like sections and holds substantial text is "likely"; anything less is
// "partial", and an empty body is "none".
export function completeness(sections) {
  const chars = sections.reduce((n, s) => n + s.text.length, 0);
  const heads = sections.map((s) => s.head ?? '').join(' | ');
  const methods = sectionRe(['method', 'materials', 'experimental', 'implementation', 'approach'])
    .test(heads), results = sectionRe(['result', 'evaluation', 'experiment', 'discussion']).test(heads);
  return { complete: !chars ? 'none' : methods && results && chars > 5000 ? 'likely' : 'partial', body_chars: chars, sections: sections.length,
    has_methods_like: methods, has_results_like: results };
}

async function getJson(fetchImpl, url, apiKey, userAgent) {
  const u = new URL(url); if (apiKey) u.searchParams.set('api_key', apiKey);
  const res = await fetchImpl(u, { headers: { accept: 'application/json', 'user-agent': userAgent } });
  if (res.status === 404) return { status: 404 };
  if (!res.ok) return { status: res.status, error: `HTTP ${res.status}` };
  return { status: 200, json: await res.json() };
}

// `select`: section headings to keep (case-insensitive substrings), for Level 1 targeted evidence; omitted = the whole
// body (Level 2). `format`: 'grobid_xml' (default) or 'pdf' (bytes, not parsed here). `userAgent`: Mina's identity; the
// broker passes the variant with the user's contact address when one is configured.
export async function openalexContent(identifier, { apiKey = process.env.OPENALEX_API_KEY, fetchImpl = globalThis.fetch, format = 'grobid_xml', select = null,
  now = () => new Date(), userAgent = MINA_USER_AGENT } = {}) {
  const id = normalizeIdentifier(identifier);
  const base = { identifier: { input: String(identifier), kind: id.kind, value: id.value }, retrieved_at: now().toISOString(), source: 'openalex-content' };
  if (!apiKey) return { ...base, status: 'FULLTEXT_UNAVAILABLE', reason: 'OPENALEX_API_KEY is not set: the Content API needs a key' };
  let work;
  try {
    const r = await getJson(fetchImpl, `${API}/works/${encodeURIComponent(id.key).replace(/%3A/g, ':')}?select=${SELECT}`, apiKey, userAgent);
    if (r.status === 404) return { ...base, status: 'NOT_FOUND', reason: `OpenAlex has no work for ${id.key}` };
    if (r.error) return { ...base, status: 'ERROR', reason: `work lookup failed: ${r.error}` };
    work = r.json;
  } catch (error) { return { ...base, status: 'ERROR', reason: `work lookup failed: ${String(error.message).replace(/api_key=[^&\s]+/g, 'api_key=…')}` }; }
  const record = toRecord(work);
  const provenance = { ...record.identifiers, title: record.title, oa_status: record.oa_status, representation: format === 'pdf' ? 'pdf' : 'tei-xml (GROBID)' };
  const url = work.content_urls?.[format];
  if (!work.has_content?.[format] || !url) {
    return { ...base, status: 'FULLTEXT_UNAVAILABLE', record, provenance,
      reason: `OpenAlex holds no ${format} copy of this work (has_content: ${JSON.stringify(work.has_content ?? {})}); try PMC/Europe PMC, the preprint server, or Unpaywall` };
  }
  let res;
  try {
    const u = new URL(url); u.searchParams.set('api_key', apiKey);
    res = await fetchImpl(u, { redirect: 'follow', headers: { 'user-agent': userAgent } });
  } catch (error) { return { ...base, status: 'ERROR', record, provenance, reason: `content fetch failed: ${String(error.message).replace(/api_key=[^&\s]+/g, 'api_key=…')}` }; }
  const cost = res.headers.get('x-ratelimit-cost-usd');
  if (!res.ok) return { ...base, status: res.status === 404 ? 'FULLTEXT_UNAVAILABLE' : 'ERROR', record, provenance, reason: `content fetch returned HTTP ${res.status}` };
  provenance.content_url = url; provenance.cost_usd = cost ? Number(cost) : null;
  if (format === 'pdf') return { ...base, status: 'OK', record, provenance: { ...provenance, complete: 'unknown' }, pdf: Buffer.from(await res.arrayBuffer()) };
  const xml = await res.text();
  const all = teiSections(xml);
  const quality = completeness(all);
  const sections = select ? all.filter((s) => select.some((want) => (s.head ?? '').toLowerCase().includes(String(want).toLowerCase()))) : all;
  return { ...base, status: quality.complete === 'none' ? 'FULLTEXT_UNAVAILABLE' : 'OK', record, provenance: { ...provenance, ...quality },
    ...(quality.complete === 'none' ? { reason: 'the TEI file has no body text' } : {}),
    selected: select ? { requested: select, matched: sections.map((s) => s.head) } : null, sections };
}
