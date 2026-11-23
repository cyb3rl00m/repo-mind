import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@repomind/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'benchmarks/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000
  }
});
