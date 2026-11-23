# Project handoff — RepoMind 0.1.0

This document lets another engineer or AI assistant continue RepoMind without re-discovering it. Read [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) first for goals and constraints.

## Product purpose

RepoMind is an open-source development companion that makes the free DeepSeek web chat more useful on real repositories. It indexes a repository locally, selects and explains the relevant context, predicts change impact, structures the work into plan/implement/verify stages, inspects AI patches for regressions, runs real builds/tests with user approval and feeds actual errors back — without any AI API and without automating DeepSeek.

## Technical architecture

Monorepo, TypeScript everywhere (~13k lines including tests):

| Package | Role | Entry points |
|---|---|---|
| `packages/core` | Shared deterministic logic | `src/index.ts` |
| `packages/engine` | Native Messaging host, local I/O | `src/main.ts` → `dist/repomind-engine.cjs` |
| `packages/extension` | MV3 side panel UI | `sidepanel.html`, `src/background.ts` → `dist/` |

Detailed design, diagrams, algorithms and the protocol: [ARCHITECTURE.md](ARCHITECTURE.md).

## Module descriptions

**Core** — `lang` (detection, exclusions, safe paths) · `filter` (gitignore/exclusions) · `secrets` · `injection` · `parsers/*` (scan, jvm, tsjs, langs, build) · `indexer` · `graph` · `search` (BM25F) · `retrieval` · `context` · `impact` · `diff` · `regression` · `buildlog` · `memory` · `workflow` · `commands` · `github` · `protocol` · `prompts/modes`, `prompts/builder`.

**Engine** — `main` (origin check, framing, dispatch, logging) · `nm` (framing) · `handlers` (all methods + validation) · `projects` (registry, path confinement) · `scan` · `git` (status, checkpoints) · `patch` (check/apply/revert, non-git transactional apply with backups) · `commands` (detect, prepare, approval tokens, run, cancel, toolchains) · `env` (allow-listed env, login-shell import) · `keyring` (secret-tool) · `dialog` (kdialog/zenity) · `doctor` · `config` · `errors` · `proc`.

**Extension** — `lib/store` (state + pipelines) · `lib/db` (IndexedDB) · `lib/engine` (Native Messaging client) · `lib/indexing` + `indexer.worker` · `lib/github` (browser import, session token) · `lib/localFolder` (File System Access) · `lib/prompting` (selection/impact/prompt glue) · `lib/patches` (response → diff) · `screens/*` · `components/ui`, `PathLabel`.

## Data flow

1. Import: GitHub zipball (browser or engine) / engine folder scan / browser folder → `SourceFile[]` + skipped list.
2. Index in a Web Worker → `RepoIndex`; verified memory facts refreshed; snapshot, index and memory stored in IndexedDB.
3. Context Builder: `Retriever.retrieve()` → `selectContext()` + `analyzeImpact()` → `buildPrompt()` → clipboard / `.md`.
4. Workflow stores prompts, responses, plan (files, units, criteria), patches, runs and corrections per task.
5. Patch Review: response → `extractChanges` → unified diff → `validatePatchPaths` + `analyzeRegression` → engine `patch.check` → approved `patch.apply` (checkpoint) → re-index.
6. Build & Test: `commands.detect` → user approval → `commands.run` (streamed) → `analyzeLog` → run record → correction prompt with current files from `project.readFiles`.

## Native Messaging protocol

Version 1, host `com.repomind.engine`, allowed origin `chrome-extension://ddblnfbnekcpcpnnbeioffideiikfgmp/`. Envelopes, chunking (> 960 KiB → base64, 512 KiB chunks), error codes and all methods: [ARCHITECTURE.md → Native Messaging protocol](ARCHITECTURE.md#native-messaging-protocol-v1). Types: `packages/core/src/protocol.ts`.

## GitHub integration

`GitHubClient` (core) uses `GET /repos/{o}/{r}`, `/branches`, `/commits/{ref}`, `/zipball/{sha}`; `/user` validates tokens and detects classic tokens via `x-oauth-scopes`. Public repos: browser fetch from the extension. Private repos: through the engine with the keyring token (`secret-tool`, attributes `service=repomind account=github-token`); fallback without keyring: `chrome.storage.session`. Rate-limit and 404/401 errors are translated into actionable messages.

## Repository indexing

See ARCHITECTURE.md → Indexing strategy. Limits: 768 KiB per file, 25 000 files (configurable). Index version: `INDEX_VERSION = 3` in `indexer.ts`.

## Retrieval algorithms

BM25F (path 3.0 / symbols 2.2 / body 1.0) + explicit mention boosts + synonym expansion + graph expansion (deps 0.45, importers 0.32, tests 0.42, build file 0.2) + task-vocabulary config boosts. Budget selection keeps seeds and their direct dependencies as required (full → outline → reported overflow). Details in ARCHITECTURE.md.

## Memory structure

`ProjectMemory { schema: 1, revision, updatedAt, entries[] }`; `MemoryEntry { id, category, text, provenance: verified|approved|suggested, source, version, history[], archived }`. Verified entries (`source: 'index'`) are regenerated on every re-index; approved/suggested are never overwritten automatically; edits create versions; suggestions are excluded from prompts. Export: `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `DEVELOPMENT_STATUS.md`, `DECISIONS.md`, `KNOWN_ISSUES.md` (tags + ids, re-importable) and JSON.

## Engineering workflows

Modes: architecture, implementation, debugging, refactoring, review, testing, emergency, handoff — each with its own role, priorities, stage list and stage-specific instructions (`prompts/modes.ts`). Stages: understand → plan (user approval) → implement → review → verify (local) → correct (counted attempts) → complete (evidence-only report). Universal prompt rules forbid invented APIs/paths, unnecessary rewrites, ignoring errors, claiming unexecuted tests passed, omitted functionality, unrelated changes and placeholders, and mark repository content as data.

## Security decisions

See [SECURITY.md](SECURITY.md): origin restriction, parameter validation, path confinement with real-path checks, system directory refusal, approval flags, single-use command tokens, no shell, no sudo, allow-listed environment, checkpoints, secret exclusion/redaction everywhere, keyring tokens, prompt-injection handling, no network service, no telemetry.

## Installation

`./scripts/install.sh` (user-level, no sudo) → load `packages/extension/dist` unpacked → `node scripts/selftest.mjs`. See [INSTALLATION.md](INSTALLATION.md).

## Build and test instructions

```bash
npm ci
npm run check      # lint + typecheck + 132 tests + builds
npm run e2e        # real Chrome + real engine, 12 UI steps
npm run bench      # retrieval benchmark
```

## Verification status

What was actually executed in the development environment (Linux x86_64, Node 22, Google Chrome for Testing 153, git 2.43, no Android SDK, network restricted to package registries and parts of GitHub):

| Check | Result |
|---|---|
| ESLint, TypeScript (3 projects) | pass |
| Vitest: 132 tests (core units, engine over real stdio, benchmark guard) | pass |
| Production builds (engine 136 KB, extension) | pass |
| Chrome end-to-end (`scripts/e2e-chrome.mjs`): extension loads with stable ID, side panel options set, UI renders, **extension ↔ engine Native Messaging connection**, local folder import + indexing, explorer, module graph, context retrieval + prompt with real code + impact report, workflow task creation, patch analysis + `git apply --check` + approved application (file changed on disk, checkpoint ref created), Gradle command detection + approved custom command run, memory persistence across reload, settings | 12/12 pass |
| `scripts/install.sh` in a throw-away `$HOME` (Chrome + Chromium registration, launcher, doctor) | pass |
| `scripts/selftest.mjs` against the installed engine (protocol, git apply/revert/checkpoint, Android Gradle detection, approval, sudo refusal) | pass |
| `scripts/uninstall.sh --purge` | pass |
| Retrieval benchmark (8 tasks, 2 fixtures) | avg recall@10 98 %, in-context recall 98 %, impact-report coverage 65 % (keyword baseline recall@10: 91 %) |

**Not verified here** (environment limits — please verify on CachyOS):

- Live GitHub zipball download: the sandbox proxy blocked `/zipball` (HTTP 403), metadata requests worked. Covered by mocked client tests and zip ingestion tests.
- Private repository import with a real token and keyring: `secret-tool` was not installed; keyring code paths are untested against a real Secret Service.
- A real `./gradlew assembleDebug`/`test` on an Android project: no Android SDK/Gradle distribution available. Detection, approval and execution plumbing are verified with other commands.
- The installer on actual CachyOS (tested on a Debian-based environment with bash; uses only POSIX tools + bash).
- Opening the side panel by clicking the toolbar icon (headless Chrome cannot click toolbar actions; the panel page and `openPanelOnActionClick` were verified).
- kdialog/zenity folder picker (not installed); manual path entry was verified.
- DeepSeek A/B outcomes: protocol and CSV template provided in `benchmarks/PROTOCOL.md`; no results recorded.

## Known limitations

- Parsers are lexical. Macros, code generation, annotation processors (Room/Hilt/KSP output), reflection, dependency injection wiring, Kotlin extension resolution by type and overloaded methods are not fully understood. Generated sources are not indexed.
- TypeScript path aliases other than `@/` and `~/` are not resolved; Python namespace packages and Go `replace` directives are not handled; C/C++ include paths from build systems are not read.
- Gradle: custom `projectDir` mappings in settings, convention plugins and `buildSrc` logic are not evaluated.
- Impact analysis matches symbol usages by name (possible false positives) and follows at most two importer hops.
- Token counts are heuristic estimates (~3.4 chars/token for ASCII code); DeepSeek's real tokenizer is not used.
- Patch review works best with unified diffs; whole-file answers are diffed against the *indexed* version (re-index if the working tree changed).
- Non-git folders: apply works (with backups) but revert/checkpoints/worktrees need git.
- Browser-folder projects are read-only (no git, patches or builds).
- The extension stores full file snapshots in IndexedDB; very large repositories use significant browser storage.
- Linux only for the engine; Windows/macOS not implemented.
- Chrome Web Store packaging not done; the private key for the fixed ID was discarded (see DEVELOPMENT.md → Releasing).

## Future roadmap

1. Optional tree-sitter (WASM) parsers for higher fidelity, keeping lexical parsers as fallback.
2. GitHub trees/blobs fallback when zipball downloads are blocked by proxies.
3. Incremental re-indexing (git diff-based) and file watching in the engine.
4. Android: parse `buildSrc`/convention plugins, navigation graphs as edges, Compose navigation routes.
5. Per-hunk accept/reject in Patch Review; three-way merge for stale whole-file answers.
6. Correction-loop automation of verification commands (still approval-gated).
7. Windows and macOS engine support (registry/plist host registration, Credential Manager/Keychain).
8. Larger public benchmark repositories and recorded DeepSeek A/B results.
9. Chrome Web Store release with documented ID.

## Final report

Implemented: everything described in the README feature table and in this document, with the verification listed above. Unfinished or unverified items are exactly those under *Not verified here*, *Known limitations* and *Future roadmap*.
