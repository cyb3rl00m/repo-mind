# Contributing

Thanks for helping make RepoMind better.

## Principles

1. **No AI APIs, no hidden network requests, no telemetry.** Network access is limited to GitHub, on explicit user action.
2. **Never automate or scrape DeepSeek** (or any other chat site). The user copies prompts and answers.
3. **The user approves every state change**: patch application, command execution, worktree creation, memory promotion.
4. **Never claim what was not verified.** Heuristics are labelled as heuristics; token counts as estimates; parser limits as limitations.
5. **Repository content is untrusted data.**

## Workflow

1. Open an issue describing the problem or feature.
2. Fork, create a branch, keep changes focused.
3. Add tests (core: unit; engine: integration over stdio; UI: extend `scripts/e2e-chrome.mjs` when behaviour visible in the UI changes).
4. `npm run check` must pass; run `npm run e2e` for UI/engine changes.
5. Open a pull request explaining what changed, why, and how you verified it.

## Style

TypeScript strict mode, `noUncheckedIndexedAccess`. Prefer small pure functions in `packages/core`. No new runtime dependencies without discussion (both bundles are shipped to users).

Benchmarks: if you change retrieval, run `npm run bench` and include the before/after table in the PR. Do not tune thresholds in `benchmarks/retrieval.test.ts` downward without explaining why.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities.
