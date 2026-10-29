// Dependency-free HTML to readable text. Ported from @bytetrue/pi-web-search 0.5.1 src/html.ts (itself from the
// MIT-licensed rpiv-web-tools), MIT. Changes: plain JS; also drops <head>, <svg>, <template>, <iframe>, comments;
// marks list items and headings; decodes a few more named entities.

const DROP_BLOCKS = /<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const BLOCK_CLOSERS = /<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|details|summary|table|ul|ol|dl|dt|dd|figure|figcaption|main|aside)\s*>/gi;
const BR = /<br\s*\/?>/gi;
const LI_OPEN = /<li\b[^>]*>/gi;
const HEADING_OPEN = /<h([1-6])\b[^>]*>/gi;
const TAG = /<[^>]+>/g;
const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/i;

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', times: '×', deg: '°', plusmn: '±', micro: 'µ', alpha: 'α', beta: 'β', mu: 'μ',
};

function codePoint(code, radix) {
  const v = Number.parseInt(code, radix);
  if (!Number.isInteger(v) || v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return '�';
  return String.fromCodePoint(v);
}

export function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => codePoint(c, 16))
    .replace(/&#(\d+);/g, (_, c) => codePoint(c, 10))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

/** Strip tags and decode entities from a short fragment (search snippets). */
export function stripTags(fragment) {
  return decodeEntities(String(fragment ?? '').replace(TAG, ' ')).replace(/\s+/g, ' ').trim();
}

export function htmlToText(html) {
  let text = String(html).replace(COMMENTS, '').replace(DROP_BLOCKS, '');
  // Keep only <body> when present.
  const body = text.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  if (body) text = body[1];
  text = text.replace(HEADING_OPEN, (_, n) => `\n${'#'.repeat(Number(n))} `).replace(LI_OPEN, '\n- ');
  text = text.replace(BLOCK_CLOSERS, '\n').replace(BR, '\n').replace(TAG, ' ');
  text = decodeEntities(text);
  return text.replace(/[ \t\f\v\r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractTitle(html) {
  const m = String(html).match(TITLE);
  if (!m) return undefined;
  return stripTags(m[1]) || undefined;
}
