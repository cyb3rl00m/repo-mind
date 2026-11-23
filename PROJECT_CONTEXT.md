# Project context — RepoMind

## Objective

Make the **free DeepSeek web chat** a more reliable practical tool for real software development — especially multi-module Android projects — by surrounding it with repository intelligence, structured engineering workflow, regression prevention, local verification and durable project memory.

## Hard constraints

- $0 AI budget: no paid AI APIs, no DeepSeek/OpenAI/Claude keys, no embedding services, no vector databases, no mandatory cloud.
- DeepSeek is used only through its official website, manually: RepoMind prepares text, the user copies and pastes. No scraping, no private APIs, no injection, no automated submission, no circumvention of limits.
- The user approves every code modification and every command.
- GitHub REST API is allowed for repository access (read-only).
- Primary platform: CachyOS Linux, Chrome/Chromium. Windows/macOS later.
- Never claim functionality or results that were not implemented and verified.

## Technical stack

- TypeScript monorepo (npm workspaces): `packages/core`, `packages/engine`, `packages/extension`.
- Extension: Chrome Manifest V3, Side Panel API, React 19, Vite 7, IndexedDB.
- Engine: Node.js ≥ 20, bundled with esbuild into one CommonJS file; Chrome Native Messaging over stdio.
- Runtime dependencies: `fflate`, `ignore`, `react`, `react-dom`.
- Tests: Vitest, puppeteer-core (end-to-end in real Chrome).

## Conventions

- Business logic in `packages/core`, pure and unit-tested; engine = I/O only; extension = UI + storage.
- Every engine method validates parameters; state-changing methods require `approved: true`.
- Heuristics are labelled as heuristics; token counts as estimates; parser limits are recorded in `index.limitations`.
- Repository content is untrusted data.

## Key decisions

| Decision | Reason |
|---|---|
| Lexical parsers instead of tree-sitter/compiler APIs | One dependency-free implementation that runs in a browser worker and in Node, tolerates broken code, fast re-indexing. Fidelity is reported per file. |
| BM25F + dependency graph instead of embeddings | No external services or large local models; explainable reasons per file. |
| Zipball snapshot for GitHub import | One request per snapshot fits the 60 requests/hour unauthenticated limit. |
| Stable extension ID via manifest `key` | Native Messaging `allowed_origins` needs a fixed ID for unpacked installs. |
| Base64 chunking of large engine responses | Chrome's 1 MiB host→browser message limit. |
| Command approval tokens | Binds the user's approval to the exact argv/cwd shown in the UI. |
| Git checkpoints via `git stash create` + `refs/repomind/` | Records state before applying without modifying the working tree or stash list. |
| Memory provenance (verified / approved / suggested) | AI suggestions never silently become project facts. |
