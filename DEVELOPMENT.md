# Development

## Setup

```bash
npm ci
npm run build          # engine (esbuild) + extension (Vite)
npm run check          # lint + typecheck + tests + build
```

Requirements: Node.js ≥ 20, git. The end-to-end test also needs Chrome or Chromium (Chrome for Testing works).

## Scripts

| Command | What it does |
|---|---|
| `npm run lint` | ESLint (typescript-eslint, react-hooks) over all packages |
| `npm run typecheck` | `tsc --noEmit` for core, engine and extension |
| `npm test` | Vitest: core unit tests, engine integration tests (spawns the real host over stdio), benchmark regression test |
| `npm run build` | `packages/engine/dist/repomind-engine.cjs` and `packages/extension/dist/` |
| `npm run e2e` | Loads the built extension in Chrome with a temporary profile, registers the built engine as a native host in that profile and drives the UI (12 steps, screenshots in `.e2e-profile/screenshots`) |
| `npm run bench` | Offline retrieval/impact benchmark → `benchmarks/results/retrieval-latest.{md,json}` |
| `npm run dev -w @repomind/extension` | Rebuild the extension on change (reload it in `chrome://extensions`) |

Branded Google Chrome 137+ ignores `--load-extension`; use a natively packaged Chromium (`CHROME_PATH=/usr/bin/chromium`) or Chrome for Testing (`npx @puppeteer/browsers install chrome@stable`). `HEADFUL=1 npm run e2e` shows the browser; `KEEP=1` keeps the temp profile; `CHROME_PATH=…` selects the browser.

## Working on the engine without the installer

Point a host manifest at your build:

```bash
mkdir -p ~/.config/google-chrome/NativeMessagingHosts
cat > /tmp/repomind-dev <<EOF2
#!/bin/sh
exec $(command -v node) $PWD/packages/engine/dist/repomind-engine.cjs "\$@"
EOF2
chmod +x /tmp/repomind-dev
# then use scripts/install.sh --no-build, or edit the manifest's "path" to /tmp/repomind-dev
```

Engine logs: `~/.local/state/repomind/engine.log`. Override directories with `REPOMIND_CONFIG_DIR`, `REPOMIND_STATE_DIR`, `REPOMIND_DATA_DIR` (used by tests).

## Code layout

- Business logic belongs in `packages/core` (pure, unit-testable, shared).
- `packages/engine` only does I/O: filesystem, git, processes, keyring, network for private repos. Every handler validates its parameters and resolves paths through `ProjectRegistry.resolveInside`.
- `packages/extension` is UI + storage. It talks to the engine only through `lib/engine.ts`.

## Adding a language

1. Map extensions in `core/src/lang.ts`.
2. Write `parseX(src): ParseResult` using `scanSource` (comment/string blanking) and `lineDepths`/`ContainerStack` for containers.
3. Dispatch it in `parsers/index.ts`.
4. Add import resolution in `indexer.ts` (mark internal-looking failures as `unresolved`).
5. Add parser and resolution tests; add diagnostics patterns to `buildlog.ts`; add commands to `commands.ts`.

## Adding an engine method

1. Add the typed signature to `EngineMethods` in `core/src/protocol.ts`.
2. Implement it in `engine/src/handlers.ts` with parameter validation; state-changing methods must require `approved: true`.
3. Add an integration test in `engine/test/engine.test.ts`.
4. Call it from the extension through `engine.call()`.

## Releasing

1. Update versions in the four `package.json` files and `packages/extension/public/manifest.json`.
2. Update `CHANGELOG.md`.
3. `npm run check && npm run e2e`.
4. `./scripts/package-release.sh` → `release/repomind-prebuilt.tar.gz` (+ `.sha256`).
5. Tag `vX.Y.Z`, create a GitHub release and attach both files (the README's download link points at `releases/latest/download/repomind-prebuilt.tar.gz`). Bump `PROTOCOL_VERSION` only for breaking protocol changes.

The extension ID is fixed by the public key in `manifest.json`. The matching private key was not kept; a Chrome Web Store release would get a store-assigned ID that must be added to the host manifest's `allowed_origins` (and `engine.json` `allowedOrigins`).
