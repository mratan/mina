// Fixtures for supplement_get tests: an in-memory ZIP writer (with knobs for malicious archives), an XLSX builder, a
// minimal text PDF, and a fake HTTP client that honors the research adapter's client contract (policy.check before every
// hop, manual redirects, maxBytes truncation, abort).
import zlib from 'node:zlib';
import { crc32 } from '../supplements/zip.mjs';

/**
 * entries: [{ name, data, method=8, unixMode?, declaredSize?, declaredCrc?, utf8=true }]
 * opts.duplicateCentral: index of an entry whose central record is emitted twice (overlapping entries).
 */
export function buildZip(entries, { duplicateCentral = null } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const method = e.method ?? 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, 'utf8');
    const size = e.declaredSize ?? data.length;
    const crc = e.declaredCrc ?? crc32(data);
    const flags = 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.unixMode ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.unixMode ? (e.unixMode << 16) >>> 0 : 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(Buffer.concat([central, name]));
    offset += local.length + name.length + comp.length;
  }
  if (duplicateCentral !== null) centrals.push(centrals[duplicateCentral]);
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(centrals.length, 8); eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** sheets: [{ name, rows: xml string inside <sheetData>, state?, extra? (xml after sheetData), raw? (full sheet xml) }] */
export function buildXlsx({ sheets, sharedStrings = null, sharedStringsXml = null, externalRels = [], extraParts = [], macros = false }) {
  const parts = [];
  parts.push({ name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>' });
  parts.push({ name: '_rels/.rels', data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  const sheetEls = sheets.map((s, i) => `<sheet name="${s.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('');
  parts.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0"?><workbook ${NS}><workbookPr/><sheets>${sheetEls}</sheets></workbook>` });
  let rels = sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  if (sharedStrings || sharedStringsXml) rels += `<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`;
  externalRels.forEach((t, i) => { rels += `<Relationship Id="rIdX${i}" Type="${REL}/externalLink" Target="${t}" TargetMode="External"/>`; });
  parts.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` });
  sheets.forEach((s, i) => parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.raw ?? `<?xml version="1.0"?><worksheet ${NS}>${s.dimension ? `<dimension ref="${s.dimension}"/>` : ''}<sheetData>${s.rows}</sheetData>${s.extra ?? ''}</worksheet>` }));
  if (sharedStringsXml) parts.push({ name: 'xl/sharedStrings.xml', data: sharedStringsXml });
  else if (sharedStrings) parts.push({ name: 'xl/sharedStrings.xml', data: `<?xml version="1.0"?><sst ${NS} count="${sharedStrings.length}">${sharedStrings.map((s) => (s.startsWith('<') ? `<si>${s}</si>` : `<si><t xml:space="preserve">${s}</t></si>`)).join('')}</sst>` });
  if (macros) parts.push({ name: 'xl/vbaProject.bin', data: Buffer.from('not really vba') });
  parts.push(...extraParts);
  return buildZip(parts);
}

/** A minimal one-font text PDF with one page per string (ASCII text). */
export function buildPdf(pages) {
  const objs = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const PUBLIC = { address: '93.184.215.14', family: 4 };
/** DNS stub: *.private.test resolves to RFC 1918, everything else to a public documentation-free address. */
export async function fakeResolve(host) {
  if (host.endsWith('private.test')) return [{ address: '10.0.0.7', family: 4 }];
  if (host.endsWith('metadata.test')) return [{ address: '169.254.169.254', family: 4 }];
  return [PUBLIC];
}

export const reply = (status, body = '', headers = {}) => ({ status, headers: { ...headers }, body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8') });

/** routes: { 'https://host/path': reply | (req) => reply }. Follows redirects like createNodeHttpClient. */
export function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async request(opts) {
      let url = opts.url;
      const redirects = [];
      for (let hop = 0; ; hop++) {
        if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('aborted');
        if (opts.policy) await opts.policy.check(url);
        calls.push({ url, headers: opts.headers });
        const route = routes[url];
        if (!route) throw new Error(`no route for ${url}`);
        let r = typeof route === 'function' ? await route(opts) : route;
        if ([301, 302, 303, 307, 308].includes(r.status) && (opts.maxRedirects ?? 0) > 0) {
          if (hop >= opts.maxRedirects) throw new Error(`Too many redirects (max ${opts.maxRedirects})`);
          url = new URL(r.headers.location, url).toString();
          redirects.push(url);
          continue;
        }
        let truncated = false;
        if (opts.maxBytes !== undefined && r.body.length > opts.maxBytes) { r = { ...r, body: r.body.subarray(0, opts.maxBytes) }; truncated = true; }
        return { ...r, url, redirects, truncated };
      }
    },
  };
}
