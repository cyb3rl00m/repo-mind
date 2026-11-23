# RepoMind

**Local-first engineering intelligence for the free DeepSeek web chat.**

RepoMind is a Chrome extension plus a small local companion (the *engine*). It does the engineering work around DeepSeek that small and mid-size coding models are bad at doing for themselves:

- understanding the whole repository, not just the files you remembered to paste
- telling the model what else a change will affect before it writes code
- forcing a plan → approve → implement → review → verify → correct loop
- catching broken imports, removed functions, schema changes and elided code before a patch touches your files
- running your real build and tests (with your approval) and sending the actual errors back
- remembering architecture decisions across conversations

RepoMind never calls an AI API, never automates or reads the DeepSeek page and never pushes to GitHub. You copy a prompt into DeepSeek yourself and paste the answer back. Everything else happens on your machine.

> RepoMind does not change DeepSeek's model. It improves what the model sees and checks what it produces. It does not promise results equal to any other model.

## Features

| Area | What it does |
|---|---|
| **GitHub import** | Public repos without a token. Private repos with a fine-grained **read-only** token stored in the system keyring (libsecret / KWallet / GNOME Keyring). Branch selection, commit SHA, re-index. One zip download per snapshot. |
| **Local folders** | Through the engine: live files, `.gitignore`-aware scan, git status, checkpoints, isolated worktrees, patching, builds. Browser-only read-only import also available. |
| **Repository brain** | File tree, symbol index, import/dependency graph (with Kotlin same-package and Android resource/ViewBinding edges), Gradle module graph, version catalog, manifest entry points, configuration map, stack detection, language stats — and an explicit list of what it could not understand. |
| **Context retrieval** | BM25F over paths, symbols and code + identifier splitting + developer synonyms + dependency-graph expansion (imports, importers, tests, build files). Every file shows *why* it was selected, its relevance and token estimate. Manual include/exclude. |
| **Context budget** | Estimated tokens/characters per file and in total; required dependencies are never silently dropped (downgraded to outlines, otherwise reported); split into multiple packages. |
| **Change impact** | Likely files, importers (2 hops), symbols used elsewhere, shared components, API contracts, database code, configuration, tests, regression risks, and a LOW / MODERATE / HIGH / CRITICAL rating from transparent, listed factors. |
| **Engineering workflow** | Understand → Plan (approve) → Implement → Review → Verify → Correct → Complete, with stage-specific prompts and eight modes: Architecture, Implementation, Debugging, Refactoring, Code Review, Testing, Emergency Fix, Project Handoff. |
| **Patch review** | Unified-diff and whole-file extraction from DeepSeek answers, hunk-count repair, path safety (absolute, `..`, symlink escape, `.git/`, secret files, deletions), in-memory application, regression findings with explanations, regression checklist, `git apply --check`, approved application with checkpoints, revert, `.patch` export. |
| **Build & test** | Detects Gradle/Android, Maven, npm/pnpm/yarn, pytest/ruff/mypy, cargo, go, make. Shows the exact command, directory and side-effects; runs only after approval; no shell, no sudo; timeout and output cap; parses Kotlin, javac, AAPT, lint, tsc, ESLint, rustc, go, pytest, JUnit, Vitest/Jest output. |
| **Error → repair loop** | Real diagnostics + current source of the failing files + original requirement + applied diff → targeted correction prompt. Attempts are counted; nothing is “fixed” until verification passes. |
| **Project memory** | Objectives, architecture, stack, conventions, dependencies, decisions, known bugs, tasks, limitations, constraints — each tagged *verified* (from the index), *approved* (by you) or *suggested* (by AI, excluded from prompts until approved). Versioned, editable, exportable as `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `DEVELOPMENT_STATUS.md`, `DECISIONS.md`, `KNOWN_ISSUES.md`. |

## Quick start (CachyOS / Arch)

```bash
sudo pacman -S --needed nodejs npm git libsecret kdialog   # libsecret + kdialog are optional
git clone https://github.com/cyb3rl00m/repo-mind.git
cd repo-mind
./scripts/install.sh            # builds, installs the engine for your user, registers Chrome/Chromium/Brave/Vivaldi
node scripts/selftest.mjs       # optional: verifies engine, git integration and Gradle detection
```

Then in Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** → `packages/extension/dist`. The extension ID must be `ddblnfbnekcpcpnnbeioffideiikfgmp`. Click the toolbar icon to open the side panel.

Full guide: [INSTALLATION.md](INSTALLATION.md).

## A typical session

1. **Repositories** → open `~/AndroidStudioProjects/MyApp` (or import a GitHub URL).
2. **Context Builder** → describe the task, pick a mode, press *Find relevant code*. Review files, reasons, budget and the impact report. *Start workflow task*.
3. **Workflow** → *Generate & copy* the Understand prompt → paste into DeepSeek → paste the answer back. Same for **Plan**; approve it.
4. **Implement** → paste DeepSeek's diff. RepoMind extracts it and opens **Patch Review**: findings, checklist, `git apply --check`, apply (creates a checkpoint).
5. **Build & Test** → run `./gradlew assembleDebug` / `test` after confirming. Failures turn into a **Correct** prompt with the real compiler output.
6. **Complete** → evidence-based report; add decisions to memory.

## Repository layout

```
packages/core        Shared TypeScript: parsers, indexer, retrieval, context, impact, diff,
                     regression, build-log analysis, prompts, memory, workflow, protocol
packages/engine      Native Messaging host (Node.js): scan, git, patches, worktrees,
                     commands, keyring, private GitHub
packages/extension   Chrome MV3 side panel (React + TypeScript + Vite)
scripts/             install.sh, uninstall.sh, selftest.mjs, e2e-chrome.mjs
benchmarks/          Fixture repositories, tasks, retrieval benchmark, A/B protocol
```

## Status and verification

See [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md#verification-status) for exactly what was tested and how. In short: lint, type-check, 132 unit/integration tests, production builds, a 12-step end-to-end test in real Chrome (extension ↔ engine over Native Messaging), and the installer + self-test all pass in the development environment. Live GitHub zip download and a real Android Gradle build could not be executed there and are covered by mocked tests and command detection only.

## Documentation

[ARCHITECTURE](ARCHITECTURE.md) · [INSTALLATION](INSTALLATION.md) · [DEVELOPMENT](DEVELOPMENT.md) · [SECURITY](SECURITY.md) · [PRIVACY](PRIVACY.md) · [CONTRIBUTING](CONTRIBUTING.md) · [CHANGELOG](CHANGELOG.md) · [PROJECT_CONTEXT](PROJECT_CONTEXT.md) · [PROJECT_HANDOFF](PROJECT_HANDOFF.md) · [Benchmark protocol](benchmarks/PROTOCOL.md)

## License

MIT — see [LICENSE](LICENSE).
