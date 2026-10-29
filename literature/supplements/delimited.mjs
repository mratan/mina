// RFC 4180-style CSV/TSV parsing over an in-memory string, with a visitor so callers keep only the requested window.
// Nothing is evaluated: a cell beginning with "=" is text. An unterminated quoted field is reported (it would otherwise
// swallow the rest of the file into one record), and the delimiter is sniffed from the content with quotes respected.
// A quoted field that spans line breaks is valid CSV, but two stray quotes can pair up across many lines and look the
// same, so spans are measured (multiline records, longest span) for the caller to report; text after a closing quote
// (other than blanks, the delimiter or a line end) cannot be valid and is reported as such.

/**
 * Visit each record: visit(recordNumber (1-based), fields[]) -> false to stop. Returns the number of records visited.
 * Quoted fields may contain the delimiter, doubled quotes and newlines. A trailing newline does not add a record.
 * When `stats` is given:
 *  - stats.unterminatedQuote = { record, index } when the text ends inside a quoted field (index of the opening quote);
 *  - stats.textAfterQuote = { record, line, index } for the first closing quote followed by anything other than blanks
 *    and then the delimiter, a line end or the end of the text (a closing quote can only end a field);
 *  - stats.multilineRecords = number of records with a quoted field containing a line break, and
 *    stats.longestSpan = { physical_lines, record, start_line } for the quoted field spanning the most physical lines
 *    (null when none spans a line break).
 */
export function parseDelimited(text, delimiter, visit, stats) {
  let row = [];
  let field = '';
  let quoted = false;
  let quoteAt = -1;
  let n = 0;
  let i = 0;
  let line = 1; // physical line of text[i]
  let quoteLine = 1; let breaks = 0; let rowMultiline = false;
  if (stats) { stats.multilineRecords = 0; stats.longestSpan = null; }
  const len = text.length;
  const endRow = () => {
    row.push(field); field = ''; n++;
    if (rowMultiline && stats) stats.multilineRecords++;
    rowMultiline = false;
    const r = visit(n, row); row = []; return r !== false;
  };
  const closeSpan = () => {
    if (breaks > 0) {
      rowMultiline = true;
      if (stats && (!stats.longestSpan || breaks + 1 > stats.longestSpan.physical_lines)) stats.longestSpan = { physical_lines: breaks + 1, record: n + 1, start_line: quoteLine };
    }
    line += breaks; breaks = 0;
  };
  while (i < len) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; closeSpan();
        if (stats && !stats.textAfterQuote) {
          let j = i;
          while (j < len && (text[j] === ' ' || text[j] === '\t') && text[j] !== delimiter) j++;
          if (j < len && text[j] !== delimiter && text[j] !== '\n' && text[j] !== '\r') stats.textAfterQuote = { record: n + 1, line, index: j };
        }
        continue;
      }
      // Copy a run of ordinary characters at once (counting the line breaks inside the quoted field).
      const next = text.indexOf('"', i);
      const stop = next < 0 ? len : next;
      for (let k = i; k < stop; k++) {
        const ch = text.charCodeAt(k);
        if (ch === 10 || (ch === 13 && text.charCodeAt(k + 1) !== 10)) breaks++;
      }
      field += text.slice(i, stop); i = stop; continue;
    }
    if (c === '"' && field === '') { quoted = true; quoteAt = i; quoteLine = line; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++; line++;
      if (!endRow()) return n;
      continue;
    }
    field += c; i++;
  }
  if (quoted) closeSpan();
  if (quoted && stats) stats.unterminatedQuote = { record: n + 1, index: quoteAt };
  if (field !== '' || row.length > 0 || quoted) endRow();
  return n;
}

/** Physical line count (a trailing line break does not start a new line) and the 1-based line of character `index`. */
export function physicalLines(text, index = -1) {
  let lines = 0; let at = null;
  for (let i = 0; i < text.length; i++) {
    if (i === index) at = lines + 1;
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) lines++;
  }
  if (text.length && !/[\r\n]$/.test(text)) lines++;
  return { lines, lineOf: at };
}

const CANDIDATES = [',', '\t', ';', '|'];
const label = (d) => (d === '\t' ? '\\t' : d);

/** Field counts of the first records of `sample` with `d` (quote-aware). The last record is dropped if cut off. */
function fieldCounts(sample, d, truncated) {
  const counts = [];
  parseDelimited(sample, d, (_n, fields) => { counts.push(fields.length); return counts.length < 21; });
  if (truncated && counts.length > 1) counts.pop();
  return counts.slice(0, 20);
}

/**
 * Pick the delimiter. The declared one (tab for .tsv/.tab or text/tab-separated-values, comma for .csv or text/csv) is
 * used when the content agrees with it; when the declared delimiter is not consistent and exactly one other candidate
 * is (e.g. semicolons with decimal commas in a ".csv"), the content wins and a note says so. Without a declaration the
 * most consistent of , \t ; | is used. Returns { delimiter, consistent, note? }.
 */
export function chooseDelimiter(text, { ext = '', mime = '' } = {}) {
  let declared = null; let declaredBy = null;
  if (ext === 'tsv' || ext === 'tab' || mime === 'text/tab-separated-values') { declared = '\t'; declaredBy = ext === 'tsv' || ext === 'tab' ? `.${ext}` : mime; }
  else if (ext === 'csv' || ['text/csv', 'application/csv', 'application/x-csv'].includes(mime)) { declared = ','; declaredBy = ext === 'csv' ? '.csv' : mime; }
  const sample = text.slice(0, 65536);
  const truncated = text.length > sample.length;
  const stat = {};
  for (const d of CANDIDATES) {
    const counts = fieldCounts(sample, d, truncated);
    stat[d] = { fields: counts[0] ?? 0, consistent: counts.length > 0 && counts.every((c) => c === counts[0]), records: counts.length };
  }
  const good = (d) => stat[d].consistent && stat[d].fields >= 2;
  if (declared) {
    if (good(declared)) return { delimiter: declared, consistent: true };
    const others = CANDIDATES.filter((d) => d !== declared && good(d)).sort((a, b) => stat[b].fields - stat[a].fields);
    if (others.length) {
      const d = others[0];
      const also = others.length > 1 ? ` (also consistent: ${others.slice(1).map((x) => `"${label(x)}"`).join(', ')})` : '';
      return { delimiter: d, consistent: true,
        note: `parsed with delimiter "${label(d)}": the content uses it consistently while the declared ${declaredBy} delimiter "${label(declared)}" does not${also}. Check the columns.` };
    }
    return { delimiter: declared, consistent: stat[declared].consistent };
  }
  let best = ','; let bestScore = -1;
  for (const d of CANDIDATES) {
    const s = stat[d];
    if (s.fields < 2) continue;
    const score = (s.consistent ? 1e6 : 0) + s.fields;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return { delimiter: best, consistent: good(best), records: stat[best].records };
}
