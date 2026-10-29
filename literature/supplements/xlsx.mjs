// Read-only XLSX (OOXML SpreadsheetML) access for supplement_get, from an in-memory ZIP. Nothing is evaluated: formula
// cells report the value Excel cached at save time (labelled as such) and the formula text; macros (vbaProject.bin) are
// detected and never run; relationships with TargetMode="External" and externalLink parts are counted and never resolved;
// internal relationship targets must stay inside the package. XML goes through the DOCTYPE/ENTITY-rejecting tokenizer.
import { readZipEntry, ArchiveError } from './zip.mjs';
import { XmlError, walkXml } from './xml.mjs';

export const MAX_COLUMN = 16384;
export const MAX_ROW = 1048576;

export function colToNumber(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numberToCol(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Parse "B2", "B2:D20", "A:C", "5:10" into {r1,c1,r2,c2} (1-based, inclusive). Throws on bad syntax. */
export function parseRange(spec) {
  if (spec === undefined || spec === null || spec === '') return { r1: 1, c1: 1, r2: MAX_ROW, c2: MAX_COLUMN, label: null };
  const s = String(spec).trim().toUpperCase().replace(/\$/g, '');
  const m = /^([A-Z]{1,3})?(\d{1,7})?(?::([A-Z]{1,3})?(\d{1,7})?)?$/.exec(s);
  if (!m || (!m[1] && !m[2])) throw new Error(`range must look like A1, A1:D20, A:C or 5:10 (got ${JSON.stringify(spec).slice(0, 40)})`);
  const [, sc, sr, ec, er] = m;
  const hasEnd = s.includes(':');
  if (hasEnd && !ec && !er) throw new Error('range end is empty');
  if (hasEnd && Boolean(sc) !== Boolean(ec)) throw new Error('range mixes row-only and column forms (use A1:D20, A:C or 5:10)');
  const c1 = sc ? colToNumber(sc) : 1;
  const r1 = sr ? Number(sr) : 1;
  const c2 = hasEnd ? (ec ? colToNumber(ec) : MAX_COLUMN) : (sc ? c1 : MAX_COLUMN);
  const r2 = hasEnd ? (er ? Number(er) : MAX_ROW) : (sr ? r1 : MAX_ROW);
  if (r1 < 1 || c1 < 1 || r2 < r1 || c2 < c1 || c2 > MAX_COLUMN || r2 > MAX_ROW || c1 > MAX_COLUMN || r1 > MAX_ROW) throw new Error(`range ${s} is out of order or out of bounds`);
  return { r1, c1, r2, c2, label: s };
}

export function splitRef(ref) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref ?? '');
  return m ? { col: colToNumber(m[1]), row: Number(m[2]) } : null;
}

/** Part names are case-insensitive in OPC: two parts differing only by case make the package ambiguous (refused). */
function partMap(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.isDir) continue;
    const k = e.name.toLowerCase();
    if (map.has(k)) throw new ArchiveError(`workbook package has parts whose names differ only by case (${JSON.stringify(map.get(k).name.slice(0, 80))} and ${JSON.stringify(e.name.slice(0, 80))}); which one applies is ambiguous`, 'xlsx_ambiguous_part');
    map.set(k, e);
  }
  return map;
}

const MAX_RELS_PART_BYTES = 4 * 1024 * 1024;

/** Resolve a relationship target against the source part's folder; null if it leaves the package. */
export function resolveTarget(baseDir, target) {
  const raw = target.startsWith('/') ? target.slice(1) : `${baseDir}${target}`;
  const out = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

function readRels(zip, map, path, budget, decode) {
  const e = map.get(path.toLowerCase());
  if (!e) return [];
  const xml = decode(readZipEntry(zip, e, { budget }));
  const rels = [];
  walkXml(xml, { open(name, a) { if (name === 'Relationship') rels.push({ id: a.Id, type: a.Type ?? '', target: a.Target ?? '', external: /^external$/i.test(a.TargetMode ?? '') }); } });
  return rels;
}

const utf8 = (b) => new TextDecoder('utf-8').decode(b);

export function isXlsx(entries) {
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  return names.has('[content_types].xml') && [...names].some((n) => /(^|\/)workbook\.xml$/.test(n) || n === 'xl/workbook.bin');
}

/** Open the workbook: sheets, relationship safety summary. */
export function openWorkbook(zip, entries, { budget } = {}) {
  const map = partMap(entries);
  const unsafe = entries.filter((e) => e.rejected);
  if (unsafe.length) throw new ArchiveError(`workbook package has ${unsafe.length} unsafe part name(s) (${unsafe[0].rejected})`, 'xlsx_unsafe_part');
  if (map.has('xl/workbook.bin')) throw new ArchiveError('binary workbooks (.xlsb) are not supported', 'xlsb_unsupported');
  const rootRels = readRels(zip, map, '_rels/.rels', budget, utf8);
  const office = rootRels.find((r) => !r.external && /\/officeDocument$/.test(r.type));
  const wbPath = office ? resolveTarget('', office.target) : 'xl/workbook.xml';
  if (!wbPath || !map.has(wbPath.toLowerCase())) throw new ArchiveError('workbook part not found', 'xlsx_corrupt');
  const wbDir = wbPath.includes('/') ? wbPath.slice(0, wbPath.lastIndexOf('/') + 1) : '';
  const wbXml = utf8(readZipEntry(zip, map.get(wbPath.toLowerCase()), { budget }));
  const sheets = [];
  let date1904 = false;
  let definedNames = 0;
  walkXml(wbXml, {
    open(name, a) {
      if (name === 'sheet') sheets.push({ name: a.name ?? '', sheetId: a.sheetId, state: a.state ?? 'visible', rid: a['r:id'] ?? a.id });
      else if (name === 'workbookPr') date1904 = a.date1904 === '1' || a.date1904 === 'true';
      else if (name === 'definedName') definedNames++;
    },
  });
  const wbRelsPath = `${wbDir}_rels/${wbPath.slice(wbDir.length)}.rels`;
  const rels = readRels(zip, map, wbRelsPath, budget, utf8);
  // External relationships are counted across EVERY relationship part (package, workbook, sheets, drawings, ...), never
  // resolved. Oversized relationship parts are not read; the count is then a lower bound (reported).
  const externalByPart = {};
  let externalRelationships = 0; let relsPartsUnread = 0;
  for (const e of entries) {
    if (e.isDir || !/(^|\/)_rels\/[^/]*\.rels$/i.test(e.name)) continue;
    let list;
    const lower = e.name.toLowerCase();
    if (lower === '_rels/.rels') list = rootRels;
    else if (lower === wbRelsPath.toLowerCase()) list = rels;
    else if (e.size > MAX_RELS_PART_BYTES || e.unreadable) { relsPartsUnread++; continue; }
    else list = readRels(zip, map, e.name, budget, utf8);
    const n = list.filter((r) => r.external).length;
    if (n) { externalRelationships += n; externalByPart[e.name] = n; }
  }
  const byId = new Map(rels.map((r) => [r.id, r]));
  for (const s of sheets) {
    const rel = byId.get(s.rid);
    if (!rel) { s.problem = 'missing_relationship'; continue; }
    if (rel.external) { s.problem = 'external_target_not_resolved'; continue; }
    const kind = rel.type.split('/').pop();
    s.kind = kind;
    if (kind !== 'worksheet') { s.problem = `not_a_worksheet (${kind})`; continue; }
    const part = resolveTarget(wbDir, rel.target);
    if (!part) { s.problem = 'target_outside_package'; continue; }
    const entry = map.get(part.toLowerCase());
    if (!entry) { s.problem = 'part_missing'; continue; }
    s.part = entry.name;
    s.partBytes = entry.size;
  }
  const sst = rels.find((r) => !r.external && /\/sharedStrings$/.test(r.type));
  const sstPath = sst ? resolveTarget(wbDir, sst.target) : null;
  return {
    zip, entries, map, budget, sheets, date1904, definedNames,
    sharedStringsPart: sstPath && map.get(sstPath.toLowerCase()) ? map.get(sstPath.toLowerCase()).name : null,
    externalRelationships, externalByPart, relsPartsUnread,
    externalLinkParts: entries.filter((e) => /(^|\/)externallinks\//i.test(e.name) && !/\.rels$/i.test(e.name)).length,
    hasMacros: entries.some((e) => /vbaproject\.bin$/i.test(e.name)),
    _sst: undefined,
  };
}

/** Shared string table (rich-text runs concatenated, phonetic runs dropped). Lazily read once per workbook. */
export function sharedStrings(wb) {
  if (wb._sst) return wb._sst;
  const out = [];
  if (wb.sharedStringsPart) {
    const xml = utf8(readZipEntry(wb.zip, wb.map.get(wb.sharedStringsPart.toLowerCase()), { budget: wb.budget }));
    let inSi = false; let inT = false; let rph = 0; let cur = '';
    walkXml(xml, {
      open(n, _a, self) { if (n === 'si') { inSi = true; cur = ''; } else if (n === 'rPh') rph++; else if (n === 't' && !self) inT = true; },
      close(n) { if (n === 'si') { out.push(cur); inSi = false; } else if (n === 'rPh') rph--; else if (n === 't') inT = false; },
      text(t) { if (inSi && inT && rph === 0) cur += t; },
    });
  }
  wb._sst = out;
  return out;
}

/** Cheap header facts of a sheet part without walking the cells. */
export function sheetFacts(xml) {
  const dim = /<(?:\w+:)?dimension\s+ref="([^"]{1,40})"/.exec(xml.slice(0, 65536));
  const merged = [];
  const re = /<(?:\w+:)?mergeCell\s+ref="([^"]{1,40})"/g;
  let m;
  while ((m = re.exec(xml)) && merged.length < 200) merged.push(m[1]);
  return { dimension: dim?.[1] ?? null, merged };
}

export function sheetXml(wb, sheet) {
  if (sheet.problem) throw new ArchiveError(`sheet ${JSON.stringify(sheet.name)} is not readable: ${sheet.problem}`, 'sheet_unreadable');
  return utf8(readZipEntry(wb.zip, wb.map.get(sheet.part.toLowerCase()), { budget: wb.budget }));
}

/**
 * Read cells inside rows [rowFrom,rowTo] and columns [c1,c2] (column window already capped by the caller).
 * Returns { rows: [{row, cells:[{ref,col,value,type,formula?,cached?}]}], moreRows, columnsBeyond, maxRowSeen, cellCount, cellCapHit }.
 */
export function readCells(wb, xml, { rowFrom, rowTo, c1, c2, maxCellChars = 500, maxCells = 20000, maxFormulaChars = 120 }) {
  const sst = sharedStrings(wb);
  const rows = [];
  let curRow = null; let rowNum = 0; let colNum = 0;
  let cell = null; let field = null; let rph = 0; let inIs = false;
  let moreRows = false; let columnsBeyond = false; let maxRowSeen = 0; let cellCount = 0; let cellCapHit = false; let invalidShared = 0;
  // Rows must ascend and cells ascend within a row: duplicates or reordering would make the window ambiguous (and a
  // row of duplicate refs could defeat paging), so they are refused as a malformed sheet.
  let lastRow = 0; let rowStartPrev = 0; let rowHasR = false; let firstCell = true; let lastCol = 0;
  const disorder = (what) => { throw new XmlError(`${what}: the sheet is malformed (duplicate or out-of-order cell references)`, 'xlsx_cell_order'); };
  const clip = (s) => (s.length > maxCellChars ? { text: s.slice(0, maxCellChars), clipped: true, length: s.length } : { text: s, clipped: false });
  const finishCell = () => {
    const c = cell; cell = null;
    if (!c || c.row < rowFrom || c.row > rowTo) return;
    if (c.col < c1) return;
    if (c.col > c2) { columnsBeyond = true; return; }
    const hasF = c.f !== null;
    if (c.v === null && c.is === null && !hasF) return; // styled empty cell
    let value = null; let type;
    switch (c.t) {
      case 's': { const idx = Number(c.v); type = 'string'; value = Number.isInteger(idx) && idx >= 0 && idx < sst.length ? sst[idx] : null; if (value === null) { type = 'invalid_shared_string'; invalidShared++; } break; }
      case 'inlineStr': type = 'string'; value = c.is ?? ''; break;
      case 'str': type = 'string'; value = c.v; break;
      case 'b': type = 'boolean'; value = c.v === null ? null : (c.v === '1' ? 'TRUE' : 'FALSE'); break;
      case 'e': type = 'error'; value = c.v; break;
      case 'd': type = 'date'; value = c.v; break;
      default: type = 'number'; value = c.v; break;
    }
    const out = { ref: `${numberToCol(c.col)}${c.row}`, col: c.col, type };
    if (value !== null) { const v = clip(value); out.value = v.text; if (v.clipped) { out.clipped = true; out.length = v.length; } } else out.value = null;
    if (type === 'invalid_shared_string') out.shared_string_index = String(c.v ?? '').slice(0, 24);
    if (hasF) {
      out.formula = c.f ? (c.f.length > maxFormulaChars ? `${c.f.slice(0, maxFormulaChars)}…` : c.f) : (c.fShared ? '(shared formula)' : '');
      out.cached = c.v !== null || c.is !== null;
    }
    if (cellCount >= maxCells) { cellCapHit = true; if (curRow && curRow.row === c.row) curRow.partial = true; return; }
    cellCount++;
    if (!curRow || curRow.row !== c.row) { curRow = { row: c.row, cells: [] }; rows.push(curRow); }
    curRow.cells.push(out);
  };
  walkXml(xml, {
    open(n, a, self) {
      if (n === 'row') {
        rowStartPrev = lastRow;
        rowNum = a.r ? Number(a.r) : lastRow + 1; colNum = 0;
        if (!(Number.isInteger(rowNum) && rowNum > lastRow)) disorder(`row ${String(a.r).slice(0, 12)} follows row ${lastRow}`);
        lastRow = rowNum; rowHasR = Boolean(a.r); firstCell = true; lastCol = 0;
        maxRowSeen = Math.max(maxRowSeen, rowNum);
        if (rowNum > rowTo) { moreRows = true; return false; } // stop early: everything requested is behind us
        if (cellCapHit) return false;
      } else if (n === 'c') {
        const pos = splitRef(a.r);
        if (pos) {
          if (pos.row !== rowNum) {
            if (rowHasR || !firstCell || pos.row <= rowStartPrev) disorder(`cell ${a.r} is not in row ${rowNum}`);
            rowNum = lastRow = pos.row;
          }
          if (pos.col <= lastCol) disorder(`cell ${a.r} repeats or precedes an earlier cell of row ${rowNum}`);
          colNum = pos.col;
        } else colNum = lastCol + 1;
        lastCol = colNum; firstCell = false;
        cell = { row: rowNum, col: colNum, t: a.t ?? 'n', v: null, f: null, fShared: false, is: null };
        if (self) finishCell();
      } else if (cell && n === 'v') field = self ? null : 'v';
      else if (cell && n === 'f') { cell.f = cell.f ?? ''; if (a.t === 'shared') cell.fShared = true; field = self ? null : 'f'; }
      else if (cell && n === 'is') { inIs = true; cell.is = cell.is ?? ''; }
      else if (cell && inIs && n === 'rPh') rph++;
      else if (cell && inIs && n === 't' && !self) field = 'is';
      return undefined;
    },
    close(n) {
      if (n === 'c') finishCell();
      else if (n === 'v' || n === 'f' || n === 't') field = null;
      else if (n === 'is') inIs = false;
      else if (n === 'rPh') rph--;
      else if (n === 'sheetData') return false;
      return undefined;
    },
    text(t) {
      if (!cell || !field) return;
      if (field === 'v') cell.v = (cell.v ?? '') + t;
      else if (field === 'f') cell.f += t;
      else if (field === 'is' && rph === 0) cell.is += t;
    },
  });
  return { rows, moreRows, columnsBeyond, maxRowSeen, cellCount, cellCapHit, invalidShared };
}
