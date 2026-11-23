/**
 * RepoMind retrieval / impact benchmark. Deterministic, offline, no AI involved.
 * Usage: npm run bench
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runBench } from './bench-lib.js';

const rows = runBench();
const pct = (x: number) => `${Math.round(x * 100)}%`;
const avg = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + (r[k] as number), 0) / rows.length;
const lines = [
  '| Task | Recall@5 | Recall@10 | Keyword baseline @10 | In context (12k budget) | Covered by impact report | Context files | ≈Context tokens | ≈Prompt tokens | Risk |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.category} | ${pct(r.recallAt5)} | ${pct(r.recallAt10)} | ${pct(r.baselineRecallAt10)} | ${pct(r.contextRecall)} | ${pct(r.impactRecall)} | ${r.contextFiles} | ${r.contextTokens} | ${r.promptTokens} | ${r.risk} |`),
  `| **Average** | **${pct(avg('recallAt5'))}** | **${pct(avg('recallAt10'))}** | **${pct(avg('baselineRecallAt10'))}** | **${pct(avg('contextRecall'))}** | **${pct(avg('impactRecall'))}** | | | | |`
];
console.log(lines.join('\n'));
for (const r of rows) if (r.missing.length) console.log(`\n${r.id}: not in context: ${r.missing.join(', ')}`);
const dir = fileURLToPath(new URL('./results/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}retrieval-latest.json`, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
writeFileSync(`${dir}retrieval-latest.md`, `# Retrieval benchmark (generated ${new Date().toISOString()})\n\nToken counts are heuristic estimates.\n\n${lines.join('\n')}\n`);
