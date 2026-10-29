// Completeness validation owned by the broker. Providers do return false-complete responses: from the Unpaywall tier a
// journal landing page and a HAL record page, and OpenAlex TEI bodies missing sections, each labelled as full text.
// A provider saying "full text" is evidence, not proof. States:
//   complete         body with methods-like and results-like sections and a discussion/conclusion, > 15k text characters
//   likely_complete  methods-like and results-like sections, > 8k characters
//   partial          body text beyond an abstract, but missing major sections, short, or < 50 % of an alternate copy
//   landing_page     a landing/record/interstitial page, or only abstract + bibliography (rejected; the chain continues)
//   unavailable      nothing returned
//   unknown          text present but too unstructured to judge (e.g. a short paper without headings)
import { analyze, headings } from '../lib/representation.mjs';

const RECORD_PAGE = /\b(HAL Id|hal-\d{6,}|Submitted on \d|Add to your list|Export citation|Cite this article|Author links open overlay panel|View article metrics|Request permissions|Purchase (this )?article|Access through your institution|Sign in to (view|access)|Rent this article|Buy article|Get access|Subscribe to journal|Download citation|Article metrics|Altmetric)\b/gi;
const INTERSTITIAL = /\b(enable javascript|javascript is (disabled|required)|we use cookies|cookie (settings|preferences|policy)|accept (all )?cookies|are you a robot|verify you are human|checking your browser|captcha|access denied|unusual traffic)\b/gi;
const REF_HEAD = /^(references|bibliography|literature cited|works cited|reference list)\b/i;

/** Text characters outside the reference list (references are not article body). */
function bodyChars(text) {
  const lines = String(text ?? '').split('\n');
  let out = 0; let inRefs = false;
  for (const l of lines) {
    const h = l.replace(/^#+\s*|\*\*/g, '').trim();
    if (/^#{1,6}\s|^\*\*.+\*\*$/.test(l.trim()) || (h.length < 40 && REF_HEAD.test(h))) inRefs = REF_HEAD.test(h);
    if (!inRefs) out += l.replace(/<\/?[a-zA-Z][^<>]{0,400}>/g, '').length + 1;
  }
  return out;
}

/**
 * validateRepresentation(text, { altChars, claim, representation }) → { state, reasons[], metrics }
 * `altChars`: body characters of another representation of the same paper (relative check).
 * `claim`: what the provider said (complete / likely / partial / none) — recorded, never trusted alone.
 */
export function validateRepresentation(text, { altChars = 0, claim = null, representation = null } = {}) {
  const t = String(text ?? '');
  if (!t.trim()) return { state: 'unavailable', reasons: ['no text returned'], metrics: { chars: 0 }, claim };
  const a = analyze(t);
  const body = bodyChars(t);
  const recordHits = (t.slice(0, 20000).match(RECORD_PAGE) ?? []).length;
  const interstitialHits = (t.slice(0, 8000).match(INTERSTITIAL) ?? []).length;
  const heads = headings(t);
  const headsLower = heads.map((h) => h.toLowerCase());
  const onlyAbstractAndRefs = heads.length > 0 && headsLower.every((h) => /abstract|summary|references|bibliography|keywords|introduction|author|affiliation|cite|metrics|download/.test(h)) && body < 6000;
  const metrics = { chars: a.chars, text_chars: a.text_chars, body_chars: body, headings: a.headings, has_methods: a.has_methods, has_results: a.has_results, has_discussion: a.has_discussion,
    markup_share: a.noise.markup_share, short_line_share: a.noise.short_line_share, record_page_hits: recordHits, interstitial_hits: interstitialHits, alt_chars: altChars || undefined };
  const reasons = [];
  if (a.text_chars < 2500 && interstitialHits) { reasons.push('cookie/JavaScript/robot interstitial'); return { state: 'landing_page', reasons, metrics, claim }; }
  if (recordHits >= 3 && !(a.has_methods && a.has_results)) reasons.push(`repository/publisher record page markers (${recordHits})`);
  if (onlyAbstractAndRefs) reasons.push('only abstract, front matter and references');
  if (a.noise.short_line_share > 0.55 && body < 15000) reasons.push(`navigation-heavy (short lines ${Math.round(a.noise.short_line_share * 100)} %)`);
  if (body < 4000) reasons.push(`body text ${body} characters`);
  // Text extracted from a PDF is the document itself, never a landing page: a short PDF (a one-page JOSS paper) is at most
  // partial. Landing-page markers apply to HTML representations.
  const fromPdf = /pdf/i.test(representation ?? '');
  if (reasons.length && fromPdf && !interstitialHits) { const r = [...reasons]; reasons.length = 0; reasons.push(`short PDF text (${r.join('; ')})`); return { state: a.has_methods && a.has_results ? 'likely_complete' : 'partial', reasons, metrics, claim, representation }; }
  if (reasons.length && !(a.has_methods && a.has_results && body > 8000)) return { state: 'landing_page', reasons, metrics, claim };
  reasons.length = 0;
  let state;
  if (a.has_methods && a.has_results) state = a.has_discussion && body > 15000 ? 'complete' : body > 8000 ? 'likely_complete' : 'partial';
  else if (a.headings <= 1 && body > 8000) { state = 'unknown'; reasons.push('no section structure to judge (headings ≤ 1)'); }
  else { state = 'partial'; reasons.push(`missing ${[!a.has_methods && 'methods-like', !a.has_results && 'results-like'].filter(Boolean).join(' and ')} sections`); }
  if (altChars && body < 0.5 * altChars && state !== 'partial') { state = 'partial'; reasons.push(`${Math.round((100 * body) / altChars)} % of an alternate copy's length`); }
  if (state === 'complete' || state === 'likely_complete') reasons.push(`${a.headings} headings, methods/results${a.has_discussion ? '/discussion' : ''} present, ${body} body characters`);
  return { state, reasons, metrics, claim, representation };
}

export const ACCEPTABLE = new Set(['complete', 'likely_complete']);
export const USABLE = new Set(['complete', 'likely_complete', 'partial', 'unknown']);
