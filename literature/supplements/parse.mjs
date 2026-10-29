// Pure, synchronous format handling for supplement_get: classification, CSV/TSV, plain text, XLSX and ZIP listing and
// member reading. It takes bytes and normalized parameters and returns bounded rendered lines plus bounded details; it
// never touches the network, credentials, the download cache or the filesystem. The service runs it in a worker thread
// (parse-worker.mjs) under a memory limit and a hard deadline. PDF is not parsed here: a PDF (or a PDF ZIP member, whose
// bytes are returned) is handed back to the controller, which runs the separately isolated extractor.
import { createHash } from 'node:crypto';
import { ArchiveError, createBudget, readZipDirectory, readZipEntry } from './zip.mjs';
import { XmlError } from './xml.mjs';
import { decodeText, extensionOf, looksLikeChallenge, mimeMismatch, sniffMagic } from './sniff.mjs';
import { chooseDelimiter, parseDelimited, physicalLines } from './delimited.mjs';
import { isXlsx, numberToCol, openWorkbook, readCells, sheetFacts, sheetXml } from './xlsx.mjs';

export class SupplementOutcome extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

/** Structured-clone-safe form of an error thrown while parsing (for the worker boundary). */
export function serializeError(e) {
  if (e instanceof SupplementOutcome) return { type: 'outcome', status: e.status, message: e.message, extra: e.extra };
  if (e instanceof ArchiveError) return { type: 'archive', message: e.message, code: e.code };
  if (e instanceof XmlError) return { type: 'xml', message: e.message, code: e.code };
  if (e instanceof RangeError) return { type: 'outcome', status: 'parse_resource_limit', message: 'the parser hit a size limit (string or array length)', extra: {} };
  return { type: 'outcome', status: 'parse_failed', message: `internal parser error (${String(e?.name ?? 'Error')})`, extra: {} };
}

export function deserializeError(s) {
  if (s.type === 'archive') return new ArchiveError(s.message, s.code);
  if (s.type === 'xml') return new XmlError(s.message, s.code);
  return new SupplementOutcome(s.status, s.message, s.extra ?? {});
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const esc = (s) => String(s).replace(/\t/g, '\\t').replace(/\r\n|\r|\n/g, '\\n');
export const quote = (s) => JSON.stringify(String(s));
/** File-controlled names are clipped in output (Excel's own limit is 31 characters). */
const NAME_MAX = 256;
export const clipName = (s) => (String(s).length > NAME_MAX ? `${String(s).slice(0, NAME_MAX)}…` : String(s));
export const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

function refuseCharsRange(q, what) {
  if (q.charStart) throw new SupplementOutcome('invalid_range', `range "chars:${q.charStart}" applies only to plain-text files; this is ${what}. Use an A1 range (e.g. A1:F50) or rows (5:10).`);
}

function cellText(c) {
  if (c.type === 'invalid_shared_string') return `[invalid shared string index ${esc(c.shared_string_index ?? '?')}]`;
  let s = c.value === null || c.value === undefined ? '' : esc(c.value);
  if (c.clipped) s += `…[+${c.length - String(c.value).length} chars]`;
  if (c.formula !== undefined) {
    const ftext = c.formula ? `=${esc(c.formula)}` : '';
    s += c.cached ? ` [cached value of formula ${ftext}]` : ` [formula ${ftext}, no cached value]`;
  }
  return s;
}

/**
 * Render rows [{row, cells:[{col,value,formula?,cached?,clipped?,length?}], partial?}] as a tab-separated grid with
 * column letters and row numbers, within `budget` characters. A first row wider than the budget is cut at a cell
 * boundary and `rowCut` says from which column (as an A1 range) the rest of that row can be read.
 */
export function renderGrid(rows, { c1, c2, budget }) {
  let maxCol = c1;
  for (const r of rows) for (const c of r.cells) if (c.col > maxCol) maxCol = c.col;
  maxCol = Math.min(maxCol, c2);
  const letters = [];
  for (let c = c1; c <= maxCol; c++) letters.push(numberToCol(c));
  const header = `row\t${letters.join('\t')}`;
  const lines = [header];
  let used = header.length + 1;
  let shown = 0; let lastRow = null; let cut = false; let formulas = 0; let clipped = 0; let rowCut = null; let rowCutNextCol = null; let capRow = null;
  for (const r of rows) {
    if (r.partial) { cut = true; capRow = r.row; break; }
    const vals = new Array(maxCol - c1 + 1).fill('');
    let f = 0; let cl = 0;
    for (const c of r.cells) {
      if (c.col < c1 || c.col > maxCol) continue;
      vals[c.col - c1] = cellText(c);
      if (c.clipped) cl++;
      if (c.formula !== undefined) f++;
    }
    const line = `${r.row}\t${vals.join('\t')}`;
    if (used + line.length + 1 > budget && shown > 0) { cut = true; break; }
    if (used + line.length + 1 > budget) {
      // The first row alone is wider than the budget: cut at a cell boundary (or inside the first cell that does not fit).
      const room = budget - used - 60;
      let acc = `${r.row}`; let nextCol = null; let partialCell = false;
      for (let k = 0; k < vals.length; k++) {
        const piece = `\t${vals[k]}`;
        if (acc.length + piece.length <= room) { acc += piece; continue; }
        const left = room - acc.length - 1;
        if (vals[k] && left >= 20) { acc += `\t${vals[k].slice(0, left)}`; partialCell = true; }
        nextCol = c1 + k;
        break;
      }
      lines.push(`${acc}\t…[row cut at max_chars]`);
      used += acc.length + 24; shown++; lastRow = r.row; cut = true;
      const shownThrough = nextCol === null ? maxCol : nextCol - 1;
      for (const c of r.cells) if (c.col >= c1 && c.col <= shownThrough) { if (c.clipped) clipped++; if (c.formula !== undefined) formulas++; }
      rowCut = { row: r.row, shown_through_column: shownThrough >= c1 ? numberToCol(shownThrough) : null, partial_cell: partialCell,
        next_column: nextCol ? numberToCol(nextCol) : null,
        next_range: nextCol && nextCol > c1 ? `${numberToCol(nextCol)}${r.row}:${numberToCol(c2)}${r.row}` : null };
      rowCutNextCol = nextCol;
      break;
    }
    lines.push(line);
    used += line.length + 1; shown++; lastRow = r.row; formulas += f; clipped += cl;
  }
  return { lines, shown, lastRow, cut, formulas, clipped, rowCut, rowCutNextCol, capRow, columns: letters.length ? `${letters[0]}-${letters.at(-1)}` : null };
}

function listLines(items, fmt, budget) {
  const lines = [];
  let used = 0; let shown = 0;
  for (const it of items) {
    const l = fmt(it);
    if (used + l.length + 1 > budget && shown > 0) break;
    lines.push(l.length > budget ? `${l.slice(0, Math.max(0, budget - 30))}…[cut at max_chars]` : l); used += Math.min(l.length, budget) + 1; shown++;
  }
  return { lines, shown };
}

/** A1 bounding box of the non-empty cells returned (null when none). */
function boundingBox(rows, c2) {
  const cols = rows.flatMap((r) => r.cells.map((c) => c.col)).filter((c) => c <= c2);
  if (!cols.length) return null;
  return `${numberToCol(Math.min(...cols))}${rows[0].row}:${numberToCol(Math.max(...cols))}${rows.at(-1).row}`;
}

function noProgress(row, L) {
  return new SupplementOutcome('no_progress', `row ${row} has more non-empty cells in the column window than the per-call cell cap (${L.maxCells}); narrow the column window with range (e.g. A${row}:J${row}) or max_columns`);
}

function classify(buf, { mime, name }, L) {
  const magic = sniffMagic(buf);
  const ext = extensionOf(name);
  if (magic === 'zip') {
    const dir = readZipDirectory(buf, L.zip);
    return { kind: isXlsx(dir.entries) ? 'xlsx' : (dir.entries.some((e) => /^word\/document\.xml$|^ppt\/presentation\.xml$/i.test(e.name)) ? 'office_document' : 'zip'), dir, magic };
  }
  if (magic !== 'text') return { kind: magic, magic };
  const head = buf.subarray(0, 4096).toString('utf8');
  if (/progid="Excel\.Sheet"|urn:schemas-microsoft-com:office:spreadsheet/.test(head)) return { kind: 'spreadsheetml_2003', magic };
  if (['csv', 'tsv', 'tab'].includes(ext) || ['text/csv', 'text/tab-separated-values', 'application/csv', 'application/x-csv'].includes(mime)) return { kind: 'delimited', magic };
  if (['txt', 'md', 'json', 'xml', 'fa', 'fasta', 'fastq', 'gff', 'gtf', 'bed', 'vcf', 'log', 'tex', 'bib', 'r', 'py'].includes(ext) || /json|xml/.test(mime)) return { kind: 'text', magic };
  // Unknown text: delimited only if a delimiter is used consistently in the first records.
  const { text } = decodeText(buf.subarray(0, 16384));
  const d = chooseDelimiter(text);
  return { kind: d.consistent && (d.records ?? 0) >= 2 ? 'delimited' : 'text', magic };
}

function handleDelimited(buf, q, ctx, L) {
  refuseCharsRange(q, 'a CSV/TSV table');
  const { text, encoding } = decodeText(buf);
  const choice = chooseDelimiter(text, { ext: extensionOf(ctx.name), mime: ctx.mime });
  const { delimiter } = choice;
  const { r1, c1, r2, c2: c2req } = q.rangeParsed;
  const c2 = Math.min(c2req, c1 + q.maxColumns - 1);
  const limit = Math.min(q.limit ?? (q.operation === 'list' ? 1 : L.defaultRows), L.maxRows);
  const from = r1 + q.offset;
  const to = Math.min(r2, from + limit - 1);
  const rows = []; let maxFields = 0; let columnsBeyond = false; let cells = 0; let header = null;
  const stats = {};
  const total = parseDelimited(text, delimiter, (n, fields) => {
    if (fields.length > maxFields) maxFields = fields.length;
    if (n === 1) header = fields;
    if (n < from || n > to) return true;
    if (fields.length > c2) columnsBeyond = true;
    const row = { row: n, cells: [] };
    for (let c = c1; c <= Math.min(c2, fields.length); c++) {
      const v = fields[c - 1];
      if (v === '') continue;
      if (cells >= L.maxCells) { row.partial = true; break; }
      const cell = { col: c, value: v.length > q.maxCellChars ? v.slice(0, q.maxCellChars) : v };
      if (v.length > q.maxCellChars) { cell.clipped = true; cell.length = v.length; }
      row.cells.push(cell); cells++;
    }
    rows.push(row);
    return true;
  }, stats);
  if (stats.unterminatedQuote) {
    const { lines, lineOf } = physicalLines(text, stats.unterminatedQuote.index);
    throw new SupplementOutcome('malformed_csv', `unterminated quoted field: the quote opened on physical line ${lineOf} (record ${stats.unterminatedQuote.record}) is never closed, so the remaining ${lines - lineOf} line(s) would merge into one record; the file was not parsed as a table`,
      { physical_lines: lines, unterminated_quote_line: lineOf, unterminated_quote_record: stats.unterminatedQuote.record, records_before: stats.unterminatedQuote.record - 1,
        result: { encoding, delimiter: delimiter === '\t' ? '\\t' : delimiter } });
  }
  if (stats.textAfterQuote) {
    const { lines } = physicalLines(text);
    const { line, record } = stats.textAfterQuote;
    throw new SupplementOutcome('malformed_csv', `text after a closing quote on physical line ${line} (record ${record}): a quoted field must end at the delimiter or the line end, so the quoting is broken (often stray quotes such as inch marks pairing up across lines); the file was not parsed as a table`,
      { physical_lines: lines, text_after_closing_quote_line: line, text_after_closing_quote_record: record,
        result: { encoding, delimiter: delimiter === '\t' ? '\\t' : delimiter } });
  }
  const physical = physicalLines(text).lines;
  const fmt = delimiter === '\t' ? 'tsv' : 'csv';
  const notes = ['Row numbers are 1-based CSV records (row 1 included), not physical lines; columns are lettered like a spreadsheet. Cells are text as written; nothing is evaluated.'];
  if (choice.note) notes.unshift(choice.note);
  const span = stats.longestSpan;
  if (stats.multilineRecords) {
    notes.unshift(`${stats.multilineRecords} record(s) have quoted fields that span multiple physical lines (${total} records from ${physical} physical lines); the longest quoted field covers ${span.physical_lines} physical lines (record ${span.record}, from line ${span.start_line}). This is valid CSV for multi-line cells, but unbalanced stray quotes (e.g. inch marks) pair up the same way and merge many lines into one cell; check those records against the physical lines.`);
  }
  const base = { format: fmt, result: { encoding, delimiter: delimiter === '\t' ? '\\t' : delimiter, records: total, max_columns: maxFields,
    physical_lines: physical, quoted_multiline_records: stats.multilineRecords, longest_quoted_span: span } };
  if (q.operation === 'list') {
    const hdr = (header ?? []).slice(0, q.maxColumns).map((h) => esc(h.length > 80 ? `${h.slice(0, 80)}…` : h));
    return { ...base, status: 'ok', location: {}, notes, lines: [
      `${fmt.toUpperCase()} · ${total} records (row 1 included) from ${physical} physical lines${stats.multilineRecords ? ` (${stats.multilineRecords} multi-line record(s))` : ''} · up to ${maxFields} columns (${numberToCol(1)}-${numberToCol(Math.max(1, Math.min(maxFields, 16384)))}) · delimiter ${base.result.delimiter} · ${encoding}`,
      `Row 1 (header if the file has one): ${hdr.join(' | ')}${(header?.length ?? 0) > q.maxColumns ? ' | …' : ''}`,
      'Extract with operation=extract and range (A1 style, e.g. A1:F50) and/or offset/limit (rows).'],
    pagination: null };
  }
  const grid = renderGrid(rows, { c1, c2, budget: q.maxChars });
  const lastShown = grid.lastRow ?? (from - 1);
  const moreInRange = Math.min(r2, total) > lastShown;
  const nextOffset = moreInRange ? lastShown + 1 - r1 : null;
  if (nextOffset !== null && nextOffset <= q.offset) throw noProgress(grid.capRow ?? from, L);
  const lines = [];
  if (from > 1 && header && c1 <= header.length) lines.push(`(row 1 for reference: ${header.slice(c1 - 1, c2).map((h) => esc(h.slice(0, 80))).join(' | ')})`);
  lines.push(...grid.lines);
  return { ...base, status: 'ok', lines, notes,
    location: { rows: grid.shown ? `${rows[0].row}-${lastShown}` : null, columns: grid.columns, range: q.range ?? null },
    pagination: { unit: 'rows', offset: q.offset, limit, returned: grid.shown, next_offset: nextOffset, columns_truncated: columnsBeyond,
      truncated_by_max_chars: grid.cut, clipped_cells: grid.clipped, ...(grid.rowCut ? { row_cut: grid.rowCut } : {}) } };
}

const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;

function handleText(buf, q, L) {
  const { text, encoding } = decodeText(buf);
  const all = text.split(/\r\n|\r|\n/);
  if (all.length && all.at(-1) === '') all.pop();
  if (q.operation === 'list') {
    let longest = 0; for (const l of all) if (l.length > longest) longest = l.length;
    return { status: 'ok', format: 'text', result: { encoding, lines: all.length, chars: text.length, longest_line_chars: longest }, location: {},
      lines: [`Plain text · ${all.length} lines · ${text.length} characters · longest line ${longest} characters · ${encoding}. Extract with operation=extract and offset/limit (lines); a line longer than max_chars continues with range="chars:N".`], pagination: null };
  }
  const limit = Math.min(q.limit ?? L.defaultLines, L.maxLines);
  const budget = q.maxChars;
  const startChar = q.charStart ? q.charStart - 1 : 0; // 0-based, first selected line only
  if (q.charStart && q.offset < all.length && startChar >= Math.max(1, all[q.offset].length)) {
    throw new SupplementOutcome('invalid_range', `line ${q.offset + 1} has ${all[q.offset].length} characters; range "chars:${q.charStart}" starts beyond it`);
  }
  const lines = []; let used = 0; let shown = 0; let cut = false; let partial = null;
  const stop = Math.min(all.length, q.offset + limit);
  for (let i = q.offset; i < stop; i++) {
    const full = all[i];
    const start = i === q.offset ? startChar : 0;
    const whole = start === 0 ? `${i + 1}\t${full}` : `${i + 1}[chars ${start + 1}-${full.length} of ${full.length}]\t${full.slice(start)}`;
    if (used + whole.length + 1 <= budget) { lines.push(whole); used += whole.length + 1; shown++; continue; }
    // Does not fit: continue inside the line (never clip silently). Start a line mid-page only if a useful part fits.
    const room = budget - used - 170;
    if (shown > 0 && room < 200) { cut = true; break; }
    let end = Math.min(full.length, start + Math.max(1, room));
    if (end < full.length && isHigh(full.charCodeAt(end - 1))) end = end - 1 > start ? end - 1 : end + 1; // keep surrogate pairs whole
    lines.push(`${i + 1}[chars ${start + 1}-${end} of ${full.length}]\t${full.slice(start, end)}`);
    lines.push(`[line ${i + 1} continues at character ${end + 1}: continue with offset=${i} range="chars:${end + 1}"]`);
    partial = { line: i + 1, char_start: start + 1, char_end: end, line_chars: full.length };
    shown++; cut = true;
    break;
  }
  const nextOffset = partial ? partial.line - 1 : (q.offset + shown < all.length ? q.offset + shown : null);
  return { status: 'ok', format: 'text', result: { encoding, lines: all.length }, lines,
    location: { lines: shown ? `${q.offset + 1}-${q.offset + shown}` : null, ...(q.charStart || partial ? { first_line_from_char: startChar + 1 } : {}) },
    pagination: { unit: 'lines', offset: q.offset, limit, returned: shown, next_offset: nextOffset, truncated_by_max_chars: cut,
      ...(partial ? { partial_line: partial, next_range: `chars:${partial.char_end + 1}` } : {}) } };
}

function handleXlsx(buf, dir, q, budget, L) {
  refuseCharsRange(q, 'an XLSX workbook');
  const wb = openWorkbook(buf, dir.entries, { budget });
  const byPart = Object.entries(wb.externalByPart);
  const result = {
    sheets: wb.sheets.length, external_relationships_not_resolved: wb.externalRelationships,
    external_relationships_by_part: Object.fromEntries(byPart.slice(0, 20)), external_link_parts: wb.externalLinkParts,
    macros_present_not_run: wb.hasMacros, date1904: wb.date1904, defined_names: wb.definedNames,
  };
  if (byPart.length > 20) result.external_relationship_parts = byPart.length;
  if (wb.relsPartsUnread) result.relationship_parts_not_read = wb.relsPartsUnread;
  const notes = ['Workbook read as stored: formulas are never recalculated (cells with formulas show the value cached by the authoring application, labelled), macros never run, external links never resolved. Numbers are shown as stored (number formats, dates and hidden rows/columns not applied).'];
  if (wb.externalRelationships || wb.externalLinkParts) notes.push(`${wb.externalRelationships}${wb.relsPartsUnread ? '+' : ''} external relationship(s) across ${byPart.length} relationship part(s) (external workbooks, hyperlinks, data connections, OLE/images) and ${wb.externalLinkParts} external-link part(s) were counted and not resolved; cached values that depend on them may be stale.`);
  if (wb.relsPartsUnread) notes.push(`${wb.relsPartsUnread} oversized or unreadable relationship part(s) were not read; the external-relationship count is a lower bound.`);
  const pickSheet = () => {
    const sheets = wb.sheets;
    if (!q.sheet) {
      const ws = sheets.filter((s) => !s.problem);
      if (ws.length === 1) return { sheet: ws[0], note: 'only worksheet' };
      throw new SupplementOutcome('selection_required', `the workbook has ${sheets.length} sheets; name one with sheet`, { listing: 'sheets' });
    }
    const exact = sheets.find((s) => s.name === q.sheet);
    if (exact) return { sheet: exact };
    const ci = sheets.filter((s) => s.name.toLowerCase() === q.sheet.toLowerCase());
    if (ci.length === 1) return { sheet: ci[0], note: `matched ${quote(clipName(ci[0].name))} case-insensitively` };
    throw new SupplementOutcome('sheet_not_found', `no sheet named ${quote(q.sheet)}`, { listing: 'sheets' });
  };
  // Only the requested page of sheets is described (facts for at most maxSheetsWithFacts of them), in text and details.
  const listing = () => {
    const lim = Math.min(q.limit ?? L.defaultListItems, L.maxListItems);
    let factsBudget = L.maxSheetsWithFacts;
    const page = wb.sheets.slice(q.offset, q.offset + lim).map((s, k) => {
      let facts = null;
      if (!s.problem && factsBudget > 0 && budget.remaining > s.partBytes) { factsBudget--; try { facts = sheetFacts(sheetXml(wb, s)); } catch { facts = null; } }
      const row = { index: q.offset + k + 1, name: clipName(s.name), state: clipName(s.state), problem: s.problem ?? null, dimension: facts?.dimension ?? null, merged_cells: facts?.merged.length ?? null };
      if (s.name.length > NAME_MAX) row.name_length = s.name.length;
      return row;
    });
    const out = listLines(page, (r) => `${r.index}. ${quote(r.name)}${r.state !== 'visible' ? ` (${r.state})` : ''}${r.dimension ? ` · ${r.dimension}` : ''}${r.merged_cells ? ` · ${r.merged_cells} merged ranges` : ''}${r.problem ? ` · not readable: ${r.problem}` : ''}`, q.maxChars);
    const next = q.offset + out.shown < wb.sheets.length ? q.offset + out.shown : null;
    return { lines: [`XLSX workbook · ${wb.sheets.length} sheet(s)${wb.hasMacros ? ' · contains macros (not run)' : ''}`, ...out.lines],
      result: { ...result, sheet_list: page.slice(0, out.shown) },
      pagination: { unit: 'sheets', offset: q.offset, limit: lim, returned: out.shown, next_offset: next, total: wb.sheets.length } };
  };
  if (q.operation === 'list' && !q.sheet) return { status: 'ok', format: 'xlsx', location: {}, notes, ...listing() };
  let picked;
  try { picked = pickSheet(); } catch (e) {
    if (e instanceof SupplementOutcome) { const l = listing(); return { status: e.status, message: e.message, format: 'xlsx', location: {}, notes, ...l }; }
    throw e;
  }
  const sheet = picked.sheet;
  const sheetName = clipName(sheet.name);
  const xml = sheetXml(wb, sheet);
  const facts = sheetFacts(xml);
  const sheetInfo = { name: sheetName, state: clipName(sheet.state), dimension: facts.dimension, merged_cells: facts.merged, part: sheet.part };
  if (q.operation === 'list') {
    return { status: 'ok', format: 'xlsx', location: { sheet: sheetName }, notes, result: { ...result, sheet: sheetInfo }, pagination: null,
      lines: [`Sheet ${quote(sheetName)}${sheet.state !== 'visible' ? ` (${clipName(sheet.state)})` : ''}${picked.note ? ` (${picked.note})` : ''} · dimension ${facts.dimension ?? 'not recorded'}`,
        facts.merged.length ? `Merged ranges: ${facts.merged.slice(0, 50).join(', ')}${facts.merged.length > 50 ? ', …' : ''}` : 'No merged ranges recorded.',
        'Extract with operation=extract, sheet, and range (e.g. A1:H50) and/or offset/limit (rows).'] };
  }
  const { r1, c1, r2, c2: c2req } = q.rangeParsed;
  const c2 = Math.min(c2req, c1 + q.maxColumns - 1);
  const limit = Math.min(q.limit ?? L.defaultRows, L.maxRows);
  const from = r1 + q.offset;
  const to = Math.min(r2, from + limit - 1);
  const cells = readCells(wb, xml, { rowFrom: from, rowTo: to, c1, c2, maxCellChars: q.maxCellChars, maxCells: L.maxCells });
  const grid = renderGrid(cells.rows, { c1, c2, budget: q.maxChars });
  const incomplete = grid.cut || cells.cellCapHit;
  const lastShown = incomplete ? grid.lastRow : to;
  const more = incomplete || (cells.moreRows && to < r2);
  if (more && (lastShown === null || lastShown + 1 - r1 <= q.offset)) throw noProgress(grid.capRow ?? from, L);
  const nextOffset = more ? lastShown + 1 - r1 : null;
  const shownCells = cells.rows.slice(0, grid.shown);
  if (grid.rowCut) { // details carry only the cells fully shown in the cut row
    const last = shownCells.at(-1);
    shownCells[shownCells.length - 1] = { ...last, cells: last.cells.filter((c) => c.col < (grid.rowCutNextCol ?? Infinity)), cut_at_max_chars: true };
  }
  const invalidShown = shownCells.reduce((n, r) => n + r.cells.filter((c) => c.type === 'invalid_shared_string').length, 0);
  const outNotes = [...notes];
  if (invalidShown) outNotes.push(`${invalidShown} cell(s) reference a shared string that does not exist (shown as [invalid shared string index N]); the workbook is damaged there.`);
  return {
    status: 'ok', format: 'xlsx', notes: outNotes, lines: [
      `Sheet ${quote(sheetName)}${picked.note ? ` (${picked.note})` : ''} · dimension ${facts.dimension ?? 'not recorded'} · requested rows ${from}-${to === 1048576 ? 'end' : to}, columns ${numberToCol(c1)}-${numberToCol(c2)}`,
      ...(grid.shown ? grid.lines : ['(no non-empty cells in this window)'])],
    location: { sheet: sheetName, range: q.range ?? null, requested_rows: `${from}-${to}`, requested_columns: `${numberToCol(c1)}-${numberToCol(c2)}`,
      rows: grid.shown ? `${shownCells[0].row}-${shownCells.at(-1).row}` : null, columns: grid.columns, cells: boundingBox(shownCells, c2) },
    result: { ...result, sheet: sheetInfo, rows: shownCells, formula_cells: grid.formulas },
    pagination: { unit: 'rows', offset: q.offset, limit, returned: grid.shown, next_offset: nextOffset, columns_truncated: cells.columnsBeyond,
      truncated_by_max_chars: grid.cut, cell_cap_hit: cells.cellCapHit, clipped_cells: grid.clipped, ...(grid.rowCut ? { row_cut: grid.rowCut } : {}) },
  };
}

function handleZip(dir, q, L) {
  const lim = Math.min(q.limit ?? L.defaultListItems, L.maxListItems);
  const page = dir.entries.slice(q.offset, q.offset + lim);
  const out = listLines(page, (e) => {
    const flag = e.rejected ? ` · REFUSED (${e.rejected})` : e.unreadable ? ` · not readable (${e.unreadable})` : '';
    return e.isDir ? `${quote(e.name)} · directory${flag}` : `${quote(e.name)} · ${fmtBytes(e.size)} (${fmtBytes(e.compressedSize)} compressed)${flag}`;
  }, q.maxChars);
  const next = q.offset + out.shown < dir.entries.length ? q.offset + out.shown : null;
  return {
    format: 'zip', location: {},
    lines: [`ZIP archive · ${dir.entries.length} entries · ${fmtBytes(dir.declaredTotal)} uncompressed (declared)`, ...out.lines],
    result: { entries: dir.entries.length, declared_uncompressed_bytes: dir.declaredTotal,
      entry_list: page.slice(0, out.shown).map((e) => ({ name: e.name, size: e.size, compressed: e.compressedSize, directory: e.isDir, refused: e.rejected, unreadable: e.unreadable })) },
    pagination: { unit: 'entries', offset: q.offset, limit: lim, returned: out.shown, next_offset: next, total: dir.entries.length },
    notes: ['Name one member with entry (exact name as listed) to list or extract it. Members are read in memory only; nested archives other than XLSX are not opened.'],
  };
}

function handleDocument(buf, q, ctx, depth, L) {
  const cls = classify(buf, ctx, L);
  const mismatch = depth === 0 ? mimeMismatch(ctx.mime, cls.magic) : null;
  if (cls.kind === 'html') throw new SupplementOutcome(looksLikeChallenge(buf, ctx.headers ?? {}) ? 'challenge' : 'html_not_file',
    depth === 0 ? 'the URL returned an HTML page (landing page, login/paywall or challenge), not a supplement file' : 'the member is an HTML document; HTML is not extracted by supplement_get');
  if (cls.kind === 'unclassified_markup_prefix') {
    throw new SupplementOutcome('unsupported_format', `the ${depth === 0 ? 'file' : 'member'} starts with whitespace, comments or declarations that run past the bounded 16 KiB HTML sniff window (1 MiB for leading whitespace), so it could be an HTML page; it was not interpreted as text or a table`,
      { detected: 'unclassified_markup_prefix' });
  }
  if (mismatch) throw new SupplementOutcome('type_mismatch', mismatch, { detected: cls.magic });
  const unsupported = {
    ole2: 'legacy binary Office file (.xls/.doc) or an encrypted Office document: not supported',
    office_document: 'Word/PowerPoint documents are not extracted',
    spreadsheetml_2003: 'XML Spreadsheet 2003 is not supported',
    image: 'image file: no OCR or figure interpretation is performed',
    gzip: 'gzip/tar archives are not supported', other_archive: 'RAR/7z/bzip2/xz archives are not supported', binary: 'unrecognized binary format',
  };
  if (unsupported[cls.kind]) throw new SupplementOutcome('unsupported_format', unsupported[cls.kind], { detected: cls.kind });
  if (cls.kind === 'pdf') return { pdf: true };
  if (cls.kind === 'delimited') return handleDelimited(buf, q, ctx, L);
  if (cls.kind === 'text') return handleText(buf, q, L);
  const budget = ctx.budget;
  if (cls.kind === 'xlsx') return handleXlsx(buf, cls.dir, q, budget, L);
  // Generic ZIP
  if (depth > 0) throw new SupplementOutcome('nested_archive_unsupported', 'a ZIP inside a ZIP is not opened (only XLSX workbooks inside a ZIP are read)');
  if (!q.entry) {
    const listing = handleZip(cls.dir, q, L);
    if (q.operation === 'extract') return { ...listing, status: 'selection_required', message: 'name one member with entry to extract it' };
    return { ...listing, status: 'ok' };
  }
  const entry = cls.dir.entries.find((e) => e.name === q.entry);
  if (!entry) {
    const near = cls.dir.entries.filter((e) => e.name.toLowerCase() === q.entry.toLowerCase() || e.name.split('/').pop() === q.entry).map((e) => e.name).slice(0, 5);
    throw new SupplementOutcome('entry_not_found', `no member named ${quote(q.entry)}${near.length ? `; did you mean ${near.map(quote).join(', ')}?` : ''}`, { candidates: near });
  }
  if (entry.rejected) throw new SupplementOutcome('entry_rejected', `member ${quote(entry.name)} is refused: ${entry.rejected}`);
  if (entry.isDir) throw new SupplementOutcome('entry_not_found', `${quote(entry.name)} is a directory`);
  const bytes = readZipEntry(buf, entry, { budget });
  const member = { name: entry.name, bytes: bytes.length, compressed_bytes: entry.compressedSize, crc32: entry.crc32.toString(16).padStart(8, '0'), sha256: sha256(bytes) };
  const inner = handleDocument(bytes, q, { mime: '', name: entry.name, budget }, depth + 1, L);
  if (inner.pdf) return { pdf: true, bytes, member };
  return { ...inner, location: { entry: entry.name, ...inner.location }, member };
}

/**
 * Parse `buf` (already downloaded and hashed by the controller). Returns the handler output with decompressed_bytes,
 * or { pdf: true, bytes?, member? } when the selected document is a PDF. Throws SupplementOutcome/ArchiveError/XmlError.
 */
export function parseDocument(buf, q, ctx, L) {
  const budget = createBudget(L.decompressionBudgetBytes);
  const out = handleDocument(buf, q, { ...ctx, budget }, 0, L);
  return { ...out, decompressed_bytes: budget.total - budget.remaining };
}
