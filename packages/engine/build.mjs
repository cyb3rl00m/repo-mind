import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: [new URL('./src/main.ts', import.meta.url).pathname],
  outfile: new URL('./dist/repomind-engine.cjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'inline',
  banner: { js: '#!/usr/bin/env node' },
  define: { __ENGINE_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info'
});
