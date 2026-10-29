// Project-file access by trusted goal/handoff code still crosses the worker boundary.
// Session storage and credentials use their separate, trusted SDK storage APIs.
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { runFileOperationSync } from './worker-client.mjs';
const contained = () => process.env.MINA_SANDBOX === '1';
const operation = (action, path, args = {}) => runFileOperationSync(action, { path: resolve(path), ...args });
export function readFileSync(path, encoding) {
  if (!contained()) return fs.readFileSync(path, encoding);
  const bytes = operation('read', path);
  return encoding ? bytes.toString(typeof encoding === 'string' ? encoding : encoding.encoding) : bytes;
}
export function writeFileSync(path, content) {
  if (!contained()) return fs.writeFileSync(path, content);
  return operation('write', path, { data: Buffer.from(content).toString('base64') });
}
export function mkdirSync(path, options) {
  return contained() ? operation('mkdir', path, { recursive: options?.recursive ?? false }) : fs.mkdirSync(path, options);
}
export function renameSync(path, target) {
  return contained() ? operation('rename', path, { target: resolve(target) }) : fs.renameSync(path, target);
}
export function rmSync(path, options) {
  return contained() ? operation('remove', path, { options }) : fs.rmSync(path, options);
}
export function readdirSync(path) { return contained() ? operation('readdir', path) : fs.readdirSync(path); }
export function statSync(path) {
  if (!contained()) return fs.statSync(path);
  const s = operation('stat', path);
  return { ...s, isFile: () => s.isFile, isDirectory: () => s.isDirectory, isSymbolicLink: () => s.isSymbolicLink };
}
export function existsSync(path) {
  if (!contained()) return fs.existsSync(path);
  try { operation('access', path); return true; } catch { return false; }
}
