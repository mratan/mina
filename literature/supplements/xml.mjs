// A deliberately small XML tokenizer for the OOXML parts supplement_get reads (workbook, relationships, shared strings,
// worksheets). It is not a general XML parser: it never fetches, never expands entities beyond the five predefined ones
// and numeric character references, and it rejects any DOCTYPE or ENTITY declaration outright (no external entities,
// no billion-laughs). Namespace prefixes are stripped from element and attribute names (local names only).

export class XmlError extends Error {
  constructor(message, code = 'xml_invalid') { super(message); this.code = code; }
}

const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:([^;&\s<]{1,12});)?/g, (m, name) => {
    if (name === undefined) throw new XmlError('bare ampersand');
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      const cp = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new XmlError(`invalid character reference ${m}`);
      return String.fromCodePoint(cp);
    }
    if (Object.hasOwn(PREDEFINED, name)) return PREDEFINED[name];
    throw new XmlError(`undeclared entity ${m.slice(0, 20)}`, 'xml_entity_rejected');
  });
}

const local = (name) => { const i = name.indexOf(':'); return i < 0 ? name : name.slice(i + 1); };

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) {
    const full = m[1];
    attrs[local(full)] = decodeEntities(m[3] ?? m[4] ?? '');
    if (full.includes(':')) attrs[full] = attrs[local(full)]; // keep r:id style lookups available too
  }
  return attrs;
}

/**
 * Walk `xml` and call handlers: open(name, attrs, selfClosing), close(name), text(decodedText).
 * A handler may return false to stop early. Throws XmlError on DOCTYPE/ENTITY or malformed markup.
 */
export function walkXml(xml, { open, close, text } = {}, { maxDepth = 64 } = {}) {
  let i = 0;
  let depth = 0;
  const n = xml.length;
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new XmlError('DOCTYPE/ENTITY declarations are not allowed', 'xml_doctype_rejected');
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const end = lt < 0 ? n : lt;
    if (end > i && text) {
      const raw = xml.slice(i, end);
      if (text(decodeEntities(raw)) === false) return;
    }
    if (lt < 0) break;
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt + 2); if (e < 0) throw new XmlError('unterminated processing instruction'); i = e + 2; continue; }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); if (e < 0) throw new XmlError('unterminated comment'); i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) throw new XmlError('unterminated CDATA');
      if (text && text(xml.slice(lt + 9, e)) === false) return;
      i = e + 3; continue;
    }
    if (xml.startsWith('<!', lt)) throw new XmlError('markup declarations are not allowed', 'xml_doctype_rejected');
    const gt = findTagEnd(xml, lt + 1);
    if (gt < 0) throw new XmlError('unterminated tag');
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      depth--;
      if (close && close(local(body.slice(1).trim())) === false) return;
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const sp = inner.search(/\s/);
    const name = local(sp < 0 ? inner : inner.slice(0, sp));
    const attrs = sp < 0 ? {} : parseAttrs(inner.slice(sp));
    if (!selfClosing && ++depth > maxDepth) throw new XmlError(`nesting deeper than ${maxDepth}`);
    if (open && open(name, attrs, selfClosing) === false) return;
    if (selfClosing && close && close(name) === false) return;
  }
}

function findTagEnd(xml, from) {
  let q = null;
  for (let j = from; j < xml.length; j++) {
    const c = xml[j];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') return j;
  }
  return -1;
}
