#!/usr/bin/env node
// OpenAlex full text from the command line. Usage:
//   node scripts/openalex-content.mjs <OpenAlex ID | DOI | pmid:N | PMCID> [--sections methods,results] [--json] [--pdf FILE]
// Reads OPENALEX_API_KEY from the environment or the research key directory (as the literature MCP launcher does).
import { writeFileSync } from 'node:fs';
import { openalexContent } from '../literature/openalex-content.mjs';
import { readKeyDirs, keyDirs } from './mcp-sandbox.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const id = argv.find((a, i) => !a.startsWith('--') && !['--sections', '--pdf'].includes(argv[i - 1]));
if (!id) { process.stderr.write('usage: openalex-content.mjs <OpenAlex ID | DOI | pmid:N | PMCID> [--sections a,b] [--json] [--pdf FILE]\n'); process.exit(2); }
const apiKey = process.env.OPENALEX_API_KEY ?? readKeyDirs(keyDirs()).OPENALEX_API_KEY;
const pdf = opt('pdf');
const r = await openalexContent(id, { apiKey, format: pdf ? 'pdf' : 'grobid_xml', select: opt('sections')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null });
if (pdf && r.pdf) { writeFileSync(pdf, r.pdf); delete r.pdf; r.saved = pdf; }
if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
else {
  process.stdout.write(`${r.status}${r.reason ? `: ${r.reason}` : ''}\n${JSON.stringify(r.provenance ?? r.identifier)}\n`);
  for (const s of r.sections ?? []) process.stdout.write(`\n## ${s.n ? `${s.n} ` : ''}${s.head ?? '(untitled)'}\n${s.text}\n`);
}
process.exit(r.status === 'OK' ? 0 : r.status === 'FULLTEXT_UNAVAILABLE' || r.status === 'NOT_FOUND' ? 3 : 1);
