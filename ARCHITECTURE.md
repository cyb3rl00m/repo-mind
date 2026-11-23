# Architecture

RepoMind has three packages and one rule: **all intelligence is local and deterministic; DeepSeek is used only through text the user copies by hand.**

```
┌────────────────────────── Chrome ──────────────────────────┐        ┌──────── your computer ────────┐
│  RepoMind extension (MV3)                                   │        │  RepoMind engine (Node.js)     │
│  ┌──────────────┐  ┌──────────────────────────────────────┐ │ Native │  ┌──────────────────────────┐  │
│  │ background   │  │ side panel (React)                   │ │ Msg.   │  │ main.ts  framing/dispatch │  │
│  │ service      │  │  screens ─ store ─ IndexedDB         │◄├────────┼─►│ handlers.ts validation    │  │
│  │ worker       │  │  engine client (chunk reassembly)    │ │ stdio  │  │ scan · git · patch ·      │  │
│  └──────────────┘  │  indexer Web Worker                  │ │        │  │ commands · keyring ·      │  │
│                    │  @repomind/core (bundled)            │ │        │  │ github · worktrees        │  │
│                    └──────────────────────────────────────┘ │        │  │ @repomind/core (bundled)  │  │
└──────────────┬──────────────────────────────────────────────┘        │  └──────────────────────────┘  │
               │ HTTPS (only on import/refresh)                         └───────────────┬───────────────┘
               ▼                                                                        │ HTTPS (private repos)
          api.github.com / codeload.github.com  ◄───────────────────────────────────────┘

   DeepSeek web chat ◄── user copies prompt / pastes answer ──► RepoMind (no automation, no scraping)
```

## packages/core

Pure TypeScript, no Node or DOM dependencies (except `TextEncoder`/`atob`), used by both other packages. Dependencies: `fflate` (zip), `ignore` (gitignore matching).

| Module | Responsibility |
|---|---|
| `lang.ts` | Language/role detection, default exclusions, binary detection, safe path normalization |
| `filter.ts` | `PathFilter`: defaults + user exclusions + nested `.gitignore`, secret files, size limits |
| `secrets.ts` | Secret-file patterns and value detectors (GitHub, AWS, Google, Slack, Stripe, OpenAI/Anthropic keys, JWT, private keys, URL credentials, assigned passwords) with redaction |
| `injection.ts` | Instruction-like text detection, delimiter neutralization |
| `parsers/` | Offset-preserving comment/string scanner + extractors for Kotlin, Java, TS/JS, Python, Rust, Go, C/C++, Gradle (Groovy/KTS), version catalogs, AndroidManifest, Android XML resources, package.json, Cargo.toml, go.mod, pyproject, requirements, Markdown |
| `indexer.ts` | `buildIndex()` → `RepoIndex`: file records, import resolution per language, graph edges, modules, entry points, config map, symbol index, stack, stats, limitations |
| `graph.ts` | Adjacency, reverse closure, tests-for |
| `search.ts` | Identifier tokenizer, light stemmer, synonym expansion, BM25F |
| `retrieval.ts` | `Retriever`: task → ranked files with reasons |
| `context.ts` | Budget selection, outlines, package splitting, prompt sanitization |
| `impact.ts` | Change Impact Report + risk scoring |
| `diff.ts` | Unified diff parser/formatter, response extraction, Myers diff, in-memory apply, path validation |
| `regression.ts` | Regression findings + checklist |
| `buildlog.ts` | Diagnostic extraction + noise filtering |
| `prompts/` | Modes, stage templates, prompt builder |
| `memory.ts` | Provenance-tagged, versioned project memory + Markdown export/import |
| `workflow.ts` | Task model, plan extraction, completion report |
| `commands.ts` | Build/test command detection, custom command safety |
| `github.ts` | URL parsing, REST client, zip ingestion |
| `protocol.ts` | Native Messaging protocol types and chunking |

## Indexing strategy

1. **Ingest** — engine walks the folder (never following directory symlinks; file symlinks only if they resolve inside the project) or the zipball is unpacked in memory. `.gitignore` files are applied relative to their directory; defaults exclude build outputs, caches, lockfiles, binaries; secret files are skipped; files over 768 KiB and binary content are skipped. Skips are recorded with reasons.
2. **Parse** — each file is scanned into two views of identical length: comments removed (for imports) and comments+string bodies removed (for declarations). Brace depth (or indentation for Python) tracks containers so locals inside functions are never reported as symbols. Parsers are **lexical**, not full ASTs; this is recorded per file (`fidelity`) and in `index.limitations`. Rationale: one dependency-free implementation that runs identically in a browser worker and in Node, handles partially broken code, and is fast enough to re-index on every refresh.
3. **Resolve** —
   - Kotlin/Java: FQN map (`package` + top-level declarations, nested classes, file facades), wildcard imports, **implicit same-package references** (Kotlin/Java/Go need no import inside a package).
   - TS/JS: relative paths with extension/index probing, `.js`→`.ts` mapping, workspace packages, `@/` and `~/`.
   - Python: relative dots, dotted modules (with `src/` layout), `from x import module`.
   - Rust: `mod x;` → `x.rs` / `x/mod.rs`, `crate::`/`super::`/`self::` paths.
   - Go: `go.mod` module path → package directory.
   - C/C++: quoted includes relative to the file, then by unique suffix.
   - Gradle: `project(":x")` and type-safe `projects.x` → module build file.
   - Android: `R.layout.x`, `R.string.x`, ViewBinding class names (`ActivityMainBinding` → `layout/activity_main`), `@layout/` references, manifest components → classes, custom view/fragment class names in XML.
   - Unresolvable internal-looking imports are flagged `unresolved` and counted in limitations.
4. **Derive** — test → subject edges by naming convention, modules (Gradle settings + build files, npm, Cargo, Go, Python; else top-level directories with derived dependencies), entry points (launcher activity, components, `main`, package bin/main, `__main__`), configuration map, detected stack.

## Retrieval algorithm

`Retriever.retrieve(task)`:

1. **Explicit mentions** — identifiers in the task that exist in the symbol index (each segment of dotted names) score 1.6; file names score 1.8; repository paths score 2.0.
2. **BM25F** — fields: path (weight 3.0, b=0.3), symbol names (2.2, b=0.5), body (1.0, b=0.75), k1=1.2. Tokens: identifiers split on camelCase/snake_case + the joined form, light stemming, stop words removed, query expanded with developer synonym groups (weight 0.35). Scores normalized to the best hit; hits below 12 % dropped.
3. **Graph expansion** from up to 10 seeds: dependencies (0.45 × seed), importers (0.32 ×, max 12 per seed with a warning when more), tests (0.42 ×), module build file (0.2 ×).
4. **Task vocabulary** — build/dependency words pull in build files and catalogs (0.4); screen/permission/component words pull in manifests (0.38); architecture docs get 0.18.
5. **Combine** — max signal + 0.15 × the smaller one, normalized to 0–1, every contribution kept as a human-readable reason.

`selectContext()` then fills the budget: manual includes, strong seeds (≥ 0.35) and the direct dependencies of the top four seeds are **required** — included in full, else as an outline (signatures + line numbers), else listed as required overflow with a warning and a split option. Optional files are added greedily by score.

## Change impact & risk

`analyzeImpact()` picks files that stand out (score ≥ max(0.4, 0.6 × top seed)), walks importers two hops, finds exported symbols used by name elsewhere, shared components (≥ 5 dependents or used across modules), API/serialization contracts and database code (pattern detectors) near the change, module build files/manifests, tests and untested targets. Risk points: number of targets (+1..3), fan-in (+1..3), shared component target (+2), database target (+3, nearby +1), API contract target (+2), build/manifest target (+2), cross-module (+1), no tests (+2, partial +1), unresolved imports (+1). LOW 0–2, MODERATE 3–5, HIGH 6–8, CRITICAL ≥ 9. Every factor is shown.

## Regression engine

For each file in a patch: apply in memory (exact, then offset ±200 lines, then whitespace-insensitive, reported as fuzz) → re-parse → compare declarations by `(container, name, kind)`:
removed symbols (+ name references elsewhere), parameter list changes, return type changes, class/interface header changes, new abstract interface members, new imports that resolve to nothing (TS relative, Kotlin/Java internal packages, Python relative), deleted/renamed files still imported, deleted Android resources still referenced, config/build/manifest changes, dependency line changes, schema changes with/without migration, unrelated files vs. the approved plan, destructive operations (DROP/TRUNCATE/unbounded DELETE, `fallbackToDestructiveMigration`, recursive deletes, force push), elided-code placeholders (`// ... rest of code`), stubs/TODOs, security patterns, added secrets, mass deletions. Findings carry severity and an explanation; they are heuristics.

## Native Messaging protocol (v1)

Host name `com.repomind.engine`; allowed origin `chrome-extension://ddblnfbnekcpcpnnbeioffideiikfgmp/` (stable because the manifest contains a public `key`).

Framing: 4-byte little-endian length + UTF-8 JSON (Chrome's format). Messages:

```jsonc
// extension → engine
{ "v": 1, "id": "r12_x", "method": "patch.check", "params": { ... } }
// engine → extension (one of)
{ "v": 1, "id": "r12_x", "ok": true,  "result": { ... } }
{ "v": 1, "id": "r12_x", "ok": false, "error": { "code": "FORBIDDEN", "message": "...", "details": ... } }
{ "v": 1, "id": "r12_x", "event": "progress" | "output", "data": { ... } }
{ "v": 1, "id": "r12_x", "chunk": { "seq": 0, "total": 7, "data": "<base64>" } }
```

Chrome limits host → browser messages to **1 MiB**. Any response whose JSON exceeds 960 KiB is base64-encoded and split into 512 KiB chunks; the extension reassembles them (order-independent) and parses the original response. Requests are capped at 32 MiB (Chrome allows 64 MiB). Error codes: `BAD_REQUEST`, `UNKNOWN_METHOD`, `NOT_FOUND`, `FORBIDDEN`, `NOT_APPROVED`, `UNAVAILABLE`, `CONFLICT`, `TIMEOUT`, `INTERNAL`, `PROTOCOL`.

Methods (`packages/core/src/protocol.ts` holds the typed definitions):

| Method | Purpose |
|---|---|
| `engine.hello` | Version/protocol handshake, capabilities |
| `project.pickFolder` / `register` / `list` / `forget` | Explicit folder access (kdialog/zenity picker) |
| `project.scan` / `readFiles` | Ingest; read current file versions (confined to the project) |
| `git.info` / `git.diff` | Branch, HEAD, upstream, ahead/behind, dirty files, remotes (credentials stripped) |
| `patch.check` / `apply` / `revert` | Validation, approved application with checkpoint, reverse apply |
| `checkpoint.list` | `refs/repomind/checkpoints/*` |
| `worktree.create` / `list` / `remove` | Isolated `repomind/<name>` branches under `~/.local/share/repomind/worktrees` |
| `commands.detect` / `prepare` / `run` / `cancel` | Approval-bound command execution with streamed output |
| `secrets.status` / `setGithubToken` / `deleteGithubToken` | Keyring via `secret-tool` |
| `github.fetch` | Private repo snapshot using the keyring token |

Versioning: `v` must equal the engine's `PROTOCOL_VERSION`; `engine.hello` rejects a different protocol with an explicit upgrade message. New methods are additive within a version; breaking changes bump the version.

## Extension architecture

- `background.ts` — sets `openPanelOnActionClick`. No network, no state.
- `sidepanel.html` — the whole UI. Also usable in a full tab (`?tab=1`).
- `lib/store.tsx` — React context: projects, active project data (files, index, contents map, memory, tasks), engine state, settings, drafts, toasts, activity.
- `lib/db.ts` — IndexedDB stores: `projects`, `snapshots` (file contents), `indexes`, `memory`, `tasks`, `runs`, `activity`, `kv` (settings, folder handles).
- `lib/engine.ts` — single long-lived `connectNative` port, request multiplexing, chunk reassembly, disconnect diagnosis.
- `lib/indexer.worker.ts` — indexing off the UI thread.
- Screens: Dashboard, Repositories, Explorer, Project Brain, Context Builder, Workflow, Patch Review, Build & Test, Memory, Settings.

Permissions: `sidePanel`, `storage`, `nativeMessaging`, `clipboardWrite`; host permissions only for `api.github.com` and `codeload.github.com`; `notifications` is optional and requested at runtime. CSP: `script-src 'self'`, `connect-src` limited to GitHub.

## Engine architecture

`main.ts` validates the caller origin argument, frames messages, dispatches to `handlers.ts` which validates every parameter, resolves projects by id and confines every path with `ProjectRegistry.resolveInside()` (normalization + real-path check against symlink escapes). Long work emits progress events. Logs go to `~/.local/state/repomind/engine.log` with secret redaction and rotation. Commands run through `spawn(argv, { shell: false, detached: true })` with an allow-listed environment (optionally merged with the login-shell environment so `ANDROID_HOME`/`JAVA_HOME` match your terminal), process-group kill on timeout/cancel, head+tail output capping.

Portability: OS-specific code is isolated in `dialog.ts` (picker), `keyring.ts` (secret store), `env.ts` (shell environment), `doctor.ts`/`install.sh` (host registration paths). Windows (registry-based host registration, Credential Manager) and macOS (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts`, Keychain) can be added there without touching core logic.

## Data flow of one task

```
task text ─► Retriever ─► ranked files ─► selectContext ─► ContextSelection ─┐
                                    └───► analyzeImpact ─► ImpactReport ─────┤
project memory (verified + approved) ────────────────────────────────────────┼─► buildPrompt ─► clipboard ─► DeepSeek
                                                                              │
DeepSeek answer ─► paste ─► extractChanges ─► unified diff ─► analyzeRegression + validatePatchPaths
                                                  └─► engine patch.check (git apply --check) ─► approve ─► patch.apply (checkpoint)
                                                                                   ─► commands.run (approved) ─► analyzeLog
                                                                                   ─► correction prompt (real diagnostics + current files)
```
