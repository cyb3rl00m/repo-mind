# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-11-23

### Added
- **GitHub Builder** screen: GITHUB MODE prompts for DeepSeek (start / continue / fix-and-resend), parser for `=== FILE:` answers with plan, batch, REMAINING and MANUAL STEPS, per-file validation (placeholders, truncation, unsafe paths, secret files, binaries, embedded secrets), diff preview, approved publishing to the connected repository (one commit, optional new branch, fast-forward only, stale-branch detection), publish history, local snapshot update without re-downloading.
- Engine method `github.publish` (keyring token); browser publishing with a session token.
- End-to-end steps for empty-repo import and two publish batches against a mocked GitHub API.

### Fixed
- Importing an **empty GitHub repository** failed (GitHub answers 409 for commits/zipball). It now imports as a project with zero files.

## [0.1.0] — 2026-11-23

First release.

### Added
- Chrome MV3 extension with side panel: Dashboard, Repositories, Explorer, Project Brain, Context Builder, Workflow, Patch Review, Build & Test, Memory Center, Settings; dark and light themes; full-tab mode.
- Local engine (Native Messaging host, protocol v1) with chunked responses, folder registry, `.gitignore`-aware scanning, git status, checkpoints, patch check/apply/revert, worktrees, approval-bound command execution, keyring token storage, private GitHub snapshots, `--doctor`.
- Core library: lexical parsers for Kotlin, Java, TypeScript/JavaScript, Python, Rust, Go, C/C++, Gradle, version catalogs, AndroidManifest, Android XML, package.json, Cargo, go.mod, pyproject; dependency graph with Android resource/ViewBinding and same-package edges; BM25F retrieval with graph expansion; context budgeting with outlines and package splitting; change impact analysis with transparent risk scoring; unified diff parsing/repair/application; regression engine; build-log analysis for Gradle/Kotlin/javac/AAPT/lint/tsc/ESLint/rustc/go/pytest/JUnit/Vitest; eight engineering modes and stage prompts; provenance-tagged versioned memory with Markdown export/import; secret detection/redaction; prompt-injection detection.
- CachyOS installer, uninstaller and installation self-test.
- Unit, integration and Chrome end-to-end tests; offline retrieval benchmark and DeepSeek A/B protocol.

### Known limitations
- See PROJECT_HANDOFF.md → Known limitations.
