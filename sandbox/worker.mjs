// Dependency-free file worker. Invoked ONLY through worker-client's inner namespace.
// stdin/stdout are a bounded JSON protocol; file paths are never shell-interpolated.
import { open, writeFile, mkdir, access, stat, lstat, readdir, rename, rm, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const MAX = 64 * 1024 * 1024;
const metadata = (s) => ({ size: s.size, mode: s.mode, mtimeMs: s.mtimeMs,
  isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() });
async function execute({ action, args = {} }) {
  if (typeof args.path !== 'string' || args.path.includes('\0')) throw new Error('a file path is required');
  switch (action) {
    case 'bundle': {
      const files = {}, hashes = {}; let bytes = 0;
      const visit = async (path, relative = '') => {
        const s = await lstat(path);
        if (s.isSymbolicLink()) throw new Error('Check assets cannot contain symlinks.');
        if (s.isDirectory()) {
          for (const name of (await readdir(path)).sort()) if (name !== '__pycache__' && !name.endsWith('.pyc')) await visit(join(path, name), relative ? `${relative}/${name}` : name);
        } else if (s.isFile()) {
          const data = Buffer.from((await execute({ action: 'read', args: { path, limit: MAX - bytes } })).data, 'base64'); bytes += data.length;
          if (bytes > MAX) throw new Error('Check assets exceed byte limit.');
          const name = `.mina/checks/${relative}`;
          files[name] = data.toString('base64'); hashes[name] = createHash('sha256').update(data).digest('hex');
        } else throw new Error('Check assets must be regular files.');
      };
      try { await visit(args.path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return { files, hashes };
    }
    case 'read': {
      const limit = args.limit ?? MAX;
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX) throw new Error('invalid read limit');
      const f = await open(args.path, constants.O_RDONLY | constants.O_NONBLOCK); // Never block on a planted FIFO.
      try {
        const s = await f.stat();
        if (!s.isFile()) throw new Error('read requires a regular file');
        if (s.size > limit) throw new Error('read exceeds byte limit');
        const chunks = []; let size = 0;
        for await (const chunk of f.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > limit) throw new Error('read exceeds byte limit');
          chunks.push(chunk);
        }
        return { data: Buffer.concat(chunks).toString('base64'), ...metadata(s) };
      } finally { await f.close(); }
    }
    case 'write': {
      if (typeof args.data !== 'string' || args.data.length > Math.ceil(MAX / 3) * 4) throw new Error('invalid/oversized base64 write');
      const bytes = Buffer.from(args.data, 'base64');
      if (bytes.toString('base64') !== args.data) throw new Error('invalid base64 write');
      if (bytes.length > MAX) throw new Error('write exceeds byte limit');
      await writeFile(args.path, bytes);
      return { bytesWritten: bytes.length };
    }
    case 'mkdir': await mkdir(args.path, { recursive: args.recursive ?? true }); return { created: true };
    case 'access': await access(args.path, args.mode ?? 0); return { exists: true };
    case 'stat': return metadata(await stat(args.path));
    case 'readdir': return await readdir(args.path);
    case 'rename':
      if (typeof args.target !== 'string' || args.target.includes('\u0000')) throw new Error('invalid rename target');
      await rename(args.path, args.target); return {};
    case 'remove': await rm(args.path, args.options ?? {}); return {};
    default: throw new Error(`unsupported file action: ${action}`);
  }
}

try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 90 * 1024 * 1024) throw new Error('request exceeds byte limit');
    chunks.push(chunk);
  }
  const result = await execute(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: error.message, code: error.code } }));
  process.exitCode = 1;
}
