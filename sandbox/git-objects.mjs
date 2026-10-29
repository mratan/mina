// mina sandbox unlink-git-objects DIR: gives each hard-linked file in DIR/.git/objects its own copy, so that the startup
// preflight (validateWritableRoots in sandbox.mjs) accepts a clone made by a `git clone` from a local path. It runs outside
// the sandbox, and only when the user calls it. It changes nothing outside DIR/.git/objects, never follows a symbolic link,
// and never changes the other links: the source repository keeps its files, and their link counts drop by one.
// Other hard-linked files in DIR are reported, not changed.
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, realpathSync,
  renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { addHardlink, hardlinkDetails, hardlinkFindings } from './sandbox.mjs';

// DIR must be the top folder of a working tree whose .git is a real directory: a gitfile (git worktree, submodule) or a
// symbolic link points to another repository, which this command must not change.
export function gitWorkTree(dir) {
  const root = realpathSync(resolve(dir));
  const git = join(root, '.git');
  let st;
  try { st = lstatSync(git); } catch { throw new Error(`${root} has no .git. Give the top folder of the git clone (the folder that contains .git).`); }
  if (st.isSymbolicLink()) throw new Error(`${git} is a symbolic link. Mina repairs only a .git that is a real directory.`);
  if (st.isFile()) throw new Error(`${git} is a file (the .git of a git worktree or a submodule). Its objects are in another repository, which Mina does not change.`);
  if (!st.isDirectory()) throw new Error(`${git} is not a directory.`);
  const objects = join(git, 'objects');
  let ost;
  try { ost = lstatSync(objects); } catch { throw new Error(`${objects} does not exist.`); }
  if (!ost.isDirectory()) throw new Error(`${objects} is not a real directory${ost.isSymbolicLink() ? ' (it is a symbolic link)' : ''}.`);
  return { root, objects };
}

// Copy into a new file in the same folder (same mode, fsync), then rename it over the original. The original is read
// through a descriptor opened without following links and checked to be the inode that the walk saw.
function replaceWithCopy(path, seen) {
  const same = (st) => st.isFile() && st.ino === seen.ino && st.dev === seen.dev;
  const tmp = join(dirname(path), `.${basename(path)}.mina-copy-${process.pid}-${randomBytes(4).toString('hex')}`);
  const src = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let out = null, made = false;
  try {
    const st = fstatSync(src);
    if (!same(st)) return 'changed';
    out = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    made = true;
    const buf = Buffer.allocUnsafe(1 << 20);
    let copied = 0;
    for (let n; (n = readSync(src, buf, 0, buf.length, null)) > 0; copied += n) {
      for (let o = 0; o < n;) o += writeSync(out, buf, o, n - o);
    }
    if (copied !== st.size) throw new Error(`read ${copied} of ${st.size} bytes`);
    fchmodSync(out, st.mode & 0o7777);
    fsyncSync(out);
    closeSync(out); out = null;
    const now = lstatSync(path);   // again, just before the rename
    if (!same(now)) return 'changed';
    if (now.nlink <= 1) return 'skipped';
    renameSync(tmp, path); made = false;
    return 'replaced';
  } finally {
    if (out !== null) closeSync(out);
    closeSync(src);
    if (made) try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

export function unlinkGitObjects(dir, { dryRun = false } = {}) {
  const { root, objects } = gitWorkTree(dir);
  const r = { root, objects, dryRun, replaced: 0, skipped: 0, refused: [], failed: [], other: hardlinkFindings() };
  const changedDirs = new Set();
  const visit = (p) => {
    let st;
    try { st = lstatSync(p); } catch (e) { r.failed.push(`${p}: ${e.code ?? e.message}`); return; }
    if (st.isSymbolicLink()) { r.refused.push(`${p}: a symbolic link (not followed)`); return; }
    if (st.isDirectory()) {
      let entries;
      try { entries = readdirSync(p); } catch (e) { r.failed.push(`${p}: ${e.code ?? e.message}`); return; }
      for (const entry of entries) visit(join(p, entry));
      return;
    }
    if (!st.isFile()) { r.refused.push(`${p}: not a regular file`); return; }
    if (st.nlink <= 1) return;
    if (dryRun) { r.replaced++; return; }
    try {
      const result = replaceWithCopy(p, st);
      if (result === 'replaced') { r.replaced++; changedDirs.add(dirname(p)); }
      else if (result === 'skipped') r.skipped++;
      else r.refused.push(`${p}: it changed during the repair`);
    } catch (e) { r.failed.push(`${p}: ${e.code ?? e.message}`); }
  };
  visit(objects);
  for (const d of changedDirs) {
    try { const fd = openSync(d, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); } }
    catch (e) { r.failed.push(`${d}: fsync: ${e.code ?? e.message}`); }
  }
  // The rest of the tree: report hard-linked files, change nothing.
  const scan = (p) => {
    if (p === objects) return;
    let st;
    try { st = lstatSync(p); } catch (e) { r.failed.push(`${p}: ${e.code ?? e.message}`); return; }
    if (st.isFile() && st.nlink > 1) addHardlink(r.other, p, st.nlink);
    if (!st.isDirectory()) return;
    let entries;
    try { entries = readdirSync(p); } catch (e) { r.failed.push(`${p}: ${e.code ?? e.message}`); return; }
    for (const entry of entries) scan(join(p, entry));
  };
  scan(root);
  r.ok = !r.refused.length && !r.failed.length && !r.other.total;
  return r;
}

export function formatUnlinkReport(r) {
  const list = (items) => [...items.slice(0, 5).map((s) => `  ${s}`), ...(items.length > 5 ? [`  ... and ${items.length - 5} more`] : [])];
  const lines = [`mina: ${r.objects}${r.dryRun ? ' (dry run: nothing changed)' : ''}`,
    `  ${r.dryRun ? 'would replace with own copies' : 'replaced with own copies'}: ${r.replaced}`,
    `  skipped (only one link at the time of the copy): ${r.skipped}`,
    `  refused (not changed): ${r.refused.length}`,
    `  failed: ${r.failed.length}`];
  if (r.refused.length) lines.push('Refused:', ...list(r.refused));
  if (r.failed.length) lines.push('Failed:', ...list(r.failed));
  if (r.replaced && !r.dryRun) lines.push('The other links (the source repository) did not change. Their link counts dropped by one.');
  if (r.other.total) {
    lines.push(`${r.other.total} other hard-linked file${r.other.total === 1 ? '' : 's'} in ${r.root} did not change. This command repairs only ${r.objects}.`,
      ...hardlinkDetails(r.other));
  }
  return lines.join('\n');
}
