# Privacy

**RepoMind collects nothing.** There is no telemetry, analytics, crash reporting, account or server.

## What stays on your machine

- Indexes, file snapshots, project memory, tasks, run history and settings: IndexedDB of the RepoMind extension in your browser profile.
- Engine configuration (`~/.config/repomind/`), logs (`~/.local/state/repomind/engine.log`, secrets redacted), checkpoints (git refs in your repositories), worktrees (`~/.local/share/repomind/worktrees/`).
- A GitHub token, if you add one: in your OS keyring, or — without a keyring — in browser session memory that is cleared when the browser quits.

## Network requests

| When | Where | What |
|---|---|---|
| You import or refresh a GitHub repository | `api.github.com`, `codeload.github.com` | Repository metadata, branches, commit, one zip snapshot. Token header only for private repositories. |
| You store a token | `api.github.com/user` | Validates the token and reads its login/scopes. |
| You press **Publish** in GitHub Builder and confirm | `api.github.com` | Creates one commit with the files you selected (Git Data / Contents API). |
| Build commands you approve | Whatever the project's build tool contacts | e.g. Gradle/Maven/npm dependency downloads. |

That is all. DeepSeek is opened as a normal browser tab; RepoMind never reads, injects into or automates it. What you paste into DeepSeek is governed by DeepSeek's own terms and privacy policy — RepoMind redacts detected secrets from generated prompts, but review prompts before sending code you are not allowed to share.

## Deleting data

- *Settings → Privacy & data → Delete all RepoMind data* (extension data).
- *Repositories → remove* deletes one project's data.
- `./scripts/uninstall.sh --purge` removes engine config and logs.
- Removing the extension deletes its storage.
