# DeepSeek A/B evaluation protocol

RepoMind cannot call DeepSeek (by design: no API, no automation), so the end-to-end comparison
“DeepSeek without RepoMind” vs “DeepSeek with RepoMind” is performed by a human following this
protocol. **No scores are published in this repository until real runs have been recorded.**

## What is automated

`npm run bench` measures RepoMind's own contribution deterministically and offline:

- retrieval recall@5 / @10 of the files a correct change must touch (`tasks.json`)
- whether those files fit into the generated context package (12k-token budget)
- whether the Change Impact Report names them
- context and prompt size (heuristic token estimates)
- a naive keyword baseline for comparison

Latest numbers: [`results/retrieval-latest.md`](results/retrieval-latest.md). The fixtures are small,
so the keyword baseline is already strong on most tasks; larger real repositories are needed to
show the difference properly (contributions welcome).

## Manual A/B procedure

For each task in `tasks.json` (and ideally on a larger real Android project of your own):

1. Create two clean git worktrees of the same commit: `baseline/` and `repomind/`.
2. **Baseline:** open a new DeepSeek conversation. Paste the task text and whatever files you would
   normally paste by hand. Apply the answer manually.
3. **RepoMind:** open a new DeepSeek conversation. Use Context Builder → Workflow (Understand → Plan →
   approve → Implement), review the patch in Patch Review, apply it in the `repomind/` worktree.
4. In both worktrees run the same verification commands (e.g. `./gradlew assembleDebug test`).
5. If verification fails, continue the conversation with the failure output. Baseline: paste the
   output yourself. RepoMind: use the Correction stage. Stop after 3 correction cycles.
6. A reviewer who did not see which arm produced the change scores the final diff.

Record one row per task and arm in `results/ab-runs.csv`:

```csv
date,task_id,arm,deepseek_model,build_success,tests_passed,tests_total,requirements_met,requirements_total,regressions_found,correction_cycles,context_tokens_est,minutes_spent,reviewer_findings,notes
```

Rules:

- Use the same DeepSeek model/mode for both arms on the same day.
- Count only results you actually observed; leave a field empty when unknown.
- Do not claim superiority over any other model or product without a properly controlled comparison.
