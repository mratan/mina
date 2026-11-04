// Frames of the macOS call protocol (sandbox/macos/mina-instance.c): 1 byte type, 4 bytes big-endian length, payload.
export const FRAME_MAX = 1 << 20;

export function encodeFrame(type, data = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (body.length > FRAME_MAX) throw new Error('mina sandbox: frame too large');
  const head = Buffer.alloc(5);
  head.write(type, 0, 1, 'latin1');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

// The complete frames at the start of `buffer` (at most `limit`), and the bytes after them.
export function decodeFrames(buffer, limit = Infinity) {
  const frames = [];
  let at = 0;
  while (frames.length < limit && buffer.length - at >= 5) {
    const length = buffer.readUInt32BE(at + 1);
    if (length > FRAME_MAX) throw new Error('mina sandbox: frame too large');
    if (buffer.length - at < 5 + length) break;
    frames.push({ type: String.fromCharCode(buffer[at]), data: buffer.subarray(at + 5, at + 5 + length) });
    at += 5 + length;
  }
  return { frames, rest: buffer.subarray(at) };
}
