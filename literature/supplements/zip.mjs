// In-memory ZIP reader for supplement_get. Reads the central directory of a buffer and inflates ONE explicitly selected
// member at a time, never to disk (no extractall, no filesystem writes from entry names). Bounds: entry count, central
// directory size, per-entry and declared-total uncompressed size, compression ratio, a per-call decompression budget,
// exact decompressed length and CRC-32. Refuses ZIP64, multi-disk and overlapping entries (the non-recursive "zip bomb"),
// and marks members with absolute, traversing, backslash, control-character, duplicate, symlink or special-file names
// as rejected (listed, never readable). Only stored (0) and deflate (8) members are readable; encrypted ones are not.
import zlib from 'node:zlib';

export class ArchiveError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxCentralDirectoryBytes: 4 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalDeclaredBytes: 1024 * 1024 * 1024,
  maxRatio: 200,
  ratioFloorBytes: 2 * 1024 * 1024,
  maxNameBytes: 1024,
});

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && ((buf[2] === 3 && buf[3] === 4) || (buf[2] === 5 && buf[3] === 6));
}

let CRC_TABLE;
export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Why a member name is unsafe or ambiguous, or null. Names are compared verbatim; nothing is ever written from them. */
export function entryNameProblem(name) {
  if (!name) return 'empty_name';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control_characters';
  if (name.includes('\\')) return 'backslash_separator';
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return 'absolute_path';
  const parts = name.split('/');
  if (parts.includes('..')) return 'path_traversal';
  if (parts.slice(0, -1).some((p) => p === '' || p === '.') || parts.at(-1) === '.') return 'non_normalized_path';
  return null;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  return -1;
}

/**
 * Parse the central directory. Throws ArchiveError for archive-level refusals; per-member problems are recorded on the
 * entry as `rejected` (unsafe name/type) or `unreadable` (method/encryption/size/ratio) and the member is never inflated.
 */
export function readZipDirectory(buf, limits = ZIP_LIMITS) {
  const L = { ...ZIP_LIMITS, ...limits };
  if (!isZip(buf)) throw new ArchiveError('not a ZIP archive', 'not_zip');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ArchiveError('ZIP end-of-central-directory record not found (truncated or not a ZIP)', 'zip_corrupt');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError('ZIP64 archives are not supported', 'zip64_unsupported');
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) throw new ArchiveError('multi-disk ZIP archives are not supported', 'zip_multidisk');
  if (count > L.maxEntries) throw new ArchiveError(`ZIP has ${count} entries (limit ${L.maxEntries})`, 'zip_too_many_entries');
  if (cdSize > L.maxCentralDirectoryBytes) throw new ArchiveError(`ZIP central directory is ${cdSize} bytes (limit ${L.maxCentralDirectoryBytes})`, 'zip_directory_too_large');
  if (cdOffset + cdSize > eocd) throw new ArchiveError('ZIP central directory lies outside the archive', 'zip_corrupt');

  const entries = [];
  let p = cdOffset;
  let declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ArchiveError('ZIP central directory entry is malformed', 'zip_corrupt');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new ArchiveError('ZIP64 entries are not supported', 'zip64_unsupported');
    const nameEnd = p + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > cdOffset + cdSize) throw new ArchiveError('ZIP central directory entry overruns the directory', 'zip_corrupt');
    const nameBytes = buf.subarray(p + 46, nameEnd);
    let name;
    if (flags & 0x800) {
      try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { name = nameBytes.toString('latin1'); }
    } else name = nameBytes.toString('latin1'); // CP437 approximated as Latin-1; names are compared verbatim
    p = nameEnd + extraLen + commentLen;

    const isDir = name.endsWith('/');
    const unixMode = (madeBy >> 8) === 3 ? external >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    let rejected = nameLen > L.maxNameBytes ? 'name_too_long' : entryNameProblem(isDir ? name.slice(0, -1) || '/' : name);
    if (!rejected && fileType === 0o120000) rejected = 'symlink';
    else if (!rejected && fileType && fileType !== 0o100000 && fileType !== 0o040000) rejected = 'special_file';
    let unreadable = null;
    if (flags & 0x1) unreadable = 'encrypted';
    else if (method !== 0 && method !== 8) unreadable = `unsupported_method_${method}`;
    else if (usize > L.maxEntryBytes) unreadable = 'entry_too_large';
    else if (usize > L.ratioFloorBytes && usize / Math.max(csize, 1) > L.maxRatio) unreadable = 'compression_ratio';
    else if (method === 0 && csize !== usize) unreadable = 'stored_size_mismatch';
    declaredTotal += usize;
    entries.push({ index: i, name, isDir, method, flags, crc32: crc, compressedSize: csize, size: usize, localOffset, rejected, unreadable });
  }
  if (declaredTotal > L.maxTotalDeclaredBytes) throw new ArchiveError(`ZIP declares ${declaredTotal} uncompressed bytes (limit ${L.maxTotalDeclaredBytes})`, 'zip_total_too_large');

  // Duplicate names are ambiguous: reject every copy.
  const seen = new Map();
  for (const e of entries) seen.set(e.name, (seen.get(e.name) ?? 0) + 1);
  for (const e of entries) if (seen.get(e.name) > 1 && !e.rejected) e.rejected = 'duplicate_name';

  // Local headers must match the directory, lie before it, and member data must not overlap (overlap = zip bomb).
  const spans = [];
  for (const e of entries) {
    const o = e.localOffset;
    if (o + 30 > cdOffset || buf.readUInt32LE(o) !== SIG_LOCAL) throw new ArchiveError(`ZIP local header for entry ${e.index} is missing`, 'zip_corrupt');
    const ln = buf.readUInt16LE(o + 26);
    const lx = buf.readUInt16LE(o + 28);
    const dataStart = o + 30 + ln + lx;
    const dataEnd = dataStart + e.compressedSize;
    if (dataEnd > cdOffset) throw new ArchiveError(`ZIP entry ${e.index} data overruns the central directory`, 'zip_corrupt');
    const localName = buf.subarray(o + 30, o + 30 + ln);
    const cdName = Buffer.from(e.name, (e.flags & 0x800) ? 'utf8' : 'latin1');
    if (!e.rejected && !localName.equals(cdName)) e.rejected = 'local_header_mismatch';
    e.dataStart = dataStart;
    spans.push([o, dataEnd]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] < spans[i - 1][1]) throw new ArchiveError('ZIP entries overlap (a known zip-bomb construction)', 'zip_overlapping_entries');
  }
  return { entries, declaredTotal };
}

/** A per-call decompression budget shared across every member a call inflates. */
export function createBudget(bytes) {
  return { remaining: bytes, total: bytes, spend(n) { if (n > this.remaining) throw new ArchiveError(`decompression budget of ${this.total} bytes exceeded`, 'decompression_budget'); this.remaining -= n; } };
}

/** Inflate one member into memory, verifying exact length and CRC-32. */
export function readZipEntry(buf, entry, { budget } = {}) {
  if (entry.isDir) throw new ArchiveError(`${entry.name} is a directory`, 'entry_is_directory');
  if (entry.rejected) throw new ArchiveError(`entry refused: ${entry.rejected}`, 'entry_rejected');
  if (entry.unreadable) throw new ArchiveError(`entry not readable: ${entry.unreadable}`, entry.unreadable === 'encrypted' ? 'entry_encrypted' : 'entry_unreadable');
  budget?.spend(entry.size);
  const data = buf.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let out;
  if (entry.method === 0) out = data;
  else {
    try {
      out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
    } catch (e) {
      if (e?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw new ArchiveError(`${entry.name} inflates beyond its declared ${entry.size} bytes`, 'decompressed_size_mismatch');
      throw new ArchiveError(`${entry.name} could not be inflated`, 'zip_corrupt');
    }
  }
  if (out.length !== entry.size) throw new ArchiveError(`${entry.name} inflated to ${out.length} bytes, declared ${entry.size}`, 'decompressed_size_mismatch');
  if (crc32(out) !== entry.crc32) throw new ArchiveError(`${entry.name} failed its CRC-32 check`, 'crc_mismatch');
  return out;
}
