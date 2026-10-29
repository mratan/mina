// Content classification for supplement_get: magic bytes first, then the declared Content-Type, then (for text only) the
// name. HTML is always an access/type outcome (a landing page, login wall or bot challenge), never a table.
//
// HTML sniff scope (bounded, not a full HTML classifier): a UTF-8 BOM is skipped and a UTF-16 LE/BE BOM decoded; leading
// whitespace/NULs are skipped for up to 1 MiB; then at most 16 KiB (16384 characters) of the meaningful prefix is read,
// skipping XML declarations/processing instructions and comments, and the first markup decides: an HTML doctype, an
// unambiguous HTML start tag, or a short tag (<p>, <a>, <b>, ...) followed by structural HTML markup (<br>, <div>, <p>,
// <table>, ...). Inline-only markup such as "<i>E. coli</i>,12" is data. When that window (or the whitespace bound) is
// used up inside the leading whitespace/comments/declarations and the file continues, the result is
// "unclassified_markup_prefix" (a typed outcome), never clean text. HTML that starts later in a file is not detected.
import { isZip } from './zip.mjs';

const head = (buf, n) => buf.subarray(0, Math.min(n, buf.length));

export const HTML_SNIFF_CHARS = 16384;
const HTML_WS_SKIP_BYTES = 1024 * 1024;

// Unambiguous HTML start tags (a CSV/text file does not begin with these followed by whitespace, ">" or "/").
const HTML_START = /^<(html|head|body|script|meta|title|iframe|div|table|noscript|form|link|style|section|main|header|footer|nav|article|aside|center|frameset|frame|base|h[1-6]|ul|ol|dl|pre|span|input|img|button|label|select|textarea|object|embed|template|blockquote)[\s>/]/;
// Short tags that also occur in data ("<p 0.05", "<b>gene</b>"): HTML only as a complete tag followed by structural
// HTML markup. Inline tags (<b>, <i>, <em>, <sup>, <a>, ...) alone never make a file HTML.
const HTML_SHORT = /^<(p|a|b|i|u|br|hr|em|strong|font|small|big|tt|code)(\s[^<>]*)?\/?>/;
const HTML_MORE = /<\/?(p|br|hr|div|html|body|head|title|meta|link|style|table|thead|tbody|tr|td|th|ul|ol|li|dl|h[1-6]|script|noscript|form|input|iframe|section|main|header|footer|nav|article|pre|center)[\s>/]/;

/** The decoded meaningful prefix: after any BOM and leading whitespace, at most HTML_SNIFF_CHARS characters. */
function meaningfulPrefix(buf) {
  let enc = 'latin1'; let start = 0; let unit = 1;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  else if (buf[0] === 0xff && buf[1] === 0xfe) { enc = 'utf-16le'; start = 2; unit = 2; }
  else if (buf[0] === 0xfe && buf[1] === 0xff) { enc = 'utf-16be'; start = 2; unit = 2; }
  const wsEnd = Math.min(buf.length, start + HTML_WS_SKIP_BYTES);
  let i = start;
  while (i + unit <= wsEnd) {
    const c = unit === 1 ? buf[i] : enc === 'utf-16le' ? buf[i] | (buf[i + 1] << 8) : (buf[i] << 8) | buf[i + 1];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c && c !== 0) break;
    i += unit;
  }
  if (i + unit > wsEnd && wsEnd < buf.length) return { s: '', more: true };
  const end = Math.min(buf.length, i + HTML_SNIFF_CHARS * unit);
  const bytes = buf.subarray(i, end);
  const s = enc === 'latin1' ? bytes.toString('latin1') : new TextDecoder(enc).decode(bytes);
  return { s: s.toLowerCase(), more: end < buf.length };
}

/**
 * 'html' for an HTML page (see the sniff scope above), 'undetermined' when the bounded scan ends inside leading
 * whitespace, comments or declarations of a longer file, else 'not_html'.
 */
export function htmlPrefix(buf) {
  const { s, more } = meaningfulPrefix(buf);
  const out = more ? 'undetermined' : 'not_html';
  const ws = /[\s\u0000]*/y;
  let p = 0;
  for (;;) {
    ws.lastIndex = p; ws.exec(s); p = ws.lastIndex;
    if (s.startsWith('<?', p)) { const e = s.indexOf('?>', p + 2); if (e < 0) return out; p = e + 2; continue; }
    if (s.startsWith('<!--', p)) {
      const e = s.indexOf('-->', p + 4);
      if (e < 0) return /<!doctype\s+html|<html[\s>]/.test(s.slice(p)) ? 'html' : out;
      p = e + 3; continue;
    }
    break;
  }
  if (p >= s.length) return out;
  const rest = s.slice(p);
  if (/^<!doctype\s+html/.test(rest) || HTML_START.test(rest)) return 'html';
  if (more && rest.startsWith('<!doctype') && !rest.includes('>')) return 'undetermined';
  const short = HTML_SHORT.exec(rest);
  return short && HTML_MORE.test(rest.slice(short[0].length)) ? 'html' : 'not_html';
}

/** True for an HTML page within the bounded sniff scope. */
export function sniffHtml(buf) {
  return htmlPrefix(buf) === 'html';
}

const CHALLENGE = /cf-chl|challenge-platform|__cf_chl|just a moment\.\.\.|attention required|captcha|please enable (javascript|cookies)|verify you are (a )?human|are you a robot|incapsula|perimeterx|px-captcha|ddos-guard|access denied|request unsuccessful|bot detection|unusual traffic/i;

/** True when a response looks like a bot/challenge/denial page rather than a file. Never inspects more than 16 KiB. */
export function looksLikeChallenge(buf, headers = {}) {
  if (/challenge/i.test(headers['cf-mitigated'] ?? '')) return true;
  if (headers['x-amzn-waf-action'] || headers['x-datadome']) return true;
  return CHALLENGE.test(head(buf, 16384).toString('latin1'));
}

/** Best-effort magic-byte classification. */
export function sniffMagic(buf) {
  const h = head(buf, 16);
  const ascii = h.toString('latin1');
  if (ascii.startsWith('%PDF-')) return 'pdf';
  if (isZip(buf)) return 'zip';
  if (h.length >= 8 && h.readUInt32BE(0) === 0xd0cf11e0 && h.readUInt32BE(4) === 0xa1b11ae1) return 'ole2';
  if (h[0] === 0x1f && h[1] === 0x8b) return 'gzip';
  if (ascii.startsWith('\x89PNG') || (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) || ascii.startsWith('GIF8')
    || ascii.startsWith('II*\x00') || ascii.startsWith('MM\x00*') || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')) return 'image';
  if (ascii.startsWith('Rar!') || ascii.startsWith('7z\xbc\xaf') || ascii.startsWith('BZh') || (h[0] === 0xfd && ascii.slice(1, 6) === '7zXZ\x00')) return 'other_archive';
  const html = htmlPrefix(buf);
  if (html === 'html') return 'html';
  if (html === 'undetermined') return 'unclassified_markup_prefix';
  if (looksBinary(buf)) return 'binary';
  return 'text';
}

/** NUL bytes in the first 8 KiB (outside a UTF-16 BOM) mean binary. */
export function looksBinary(buf) {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return false;
  return head(buf, 8192).includes(0);
}

export function mimeOf(contentType) {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase();
}

// Which magic classes a declared MIME type is compatible with. Generic/download types accept anything (magic decides);
// vnd.ms-excel is commonly sent for both CSV and XLSX; unknown declared types are accepted with a note.
const DECLARED = [
  [/^application\/(x-)?pdf$/, ['pdf']],
  [/^application\/(x-)?(zip|zip-compressed)$|^application\/x-zip-compressed$|^application\/vnd\.openxmlformats-officedocument\./, ['zip']],
  [/^application\/vnd\.ms-excel(\.sheet\.macroenabled\.12)?$/, ['zip', 'text', 'ole2']],
  [/^text\/html$|^application\/xhtml\+xml$/, ['html']],
  [/^text\/|^application\/(csv|json|xml|x-csv)$/, ['text']],
  [/^image\//, ['image']],
  [/^application\/(octet-stream|x-download|force-download|download|binary|unknown)$|^binary\/octet-stream$/, null],
];

/** null when compatible (or undeclared/generic), else a short mismatch description. */
export function mimeMismatch(contentType, magic) {
  const mime = mimeOf(contentType);
  if (!mime) return null;
  for (const [re, kinds] of DECLARED) {
    if (!re.test(mime)) continue;
    if (kinds === null || kinds.includes(magic)) return null;
    return `declared ${mime} but the bytes are ${magic}`;
  }
  return null;
}

/** Decode text: BOM-aware UTF-8/UTF-16, else strict UTF-8, else Windows-1252 (reported). */
export function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8 (BOM)' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le (BOM)' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be (BOM)' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }; } catch {
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252 (fallback: not valid UTF-8)' };
  }
}

/** Format of a member/URL from its name extension (a hint only; magic bytes decide). */
export function extensionOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? '').split(/[?#]/)[0]);
  return m ? m[1].toLowerCase() : '';
}
