import { describe, expect, it } from 'vitest';
import { runBench } from './bench-lib.js';

/** Guards against retrieval regressions. Thresholds sit slightly below the measured values in results/. */
describe('retrieval benchmark (offline, deterministic)', () => {
  const rows = runBench();
  const avg = (k: 'recallAt10' | 'contextRecall' | 'impactRecall') => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  it('keeps average recall@10 and in-context recall high', () => {
    expect(avg('recallAt10')).toBeGreaterThanOrEqual(0.9);
    expect(avg('contextRecall')).toBeGreaterThanOrEqual(0.9);
    expect(avg('impactRecall')).toBeGreaterThanOrEqual(0.55);
  });
  it('every task stays within a 12k-token context budget', () => {
    for (const r of rows) expect(r.contextTokens).toBeLessThanOrEqual(12000);
  });
});
