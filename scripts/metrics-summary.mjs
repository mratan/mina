#!/usr/bin/env node
// Summarize mina's measurements per model (extensions/handoff/metrics.mjs): node scripts/metrics-summary.mjs [file]
import { readMetrics, summarize, metricsPath } from '../extensions/handoff/metrics.mjs';

const file = process.argv[2] ?? metricsPath();
const rows = summarize(readMetrics(file));
if (!rows.length) { console.log(`No measurements in ${file}.`); process.exit(0); }
for (const r of rows) {
  console.log(`\n${r.model}`);
  for (const [k, v] of Object.entries(r)) if (k !== 'model') console.log(`  ${k.padEnd(30)} ${v === null ? '-' : Number.isFinite(v) ? Math.round(v * 10) / 10 : v}`);
}
