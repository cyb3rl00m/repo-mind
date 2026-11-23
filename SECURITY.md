# Security

## Threat model

RepoMind connects a browser extension to a local process that can read your projects, change files and run build commands. The main risks it is designed against:

| Threat | Mitigation |
|---|---|
| A web page or other extension talks to the engine | Native Messaging host manifest `allowed_origins` contains only RepoMind's ID; the engine also rejects other origins passed by Chrome; no `externally_connectable`; the engine is **not** a network service (stdio only, no ports). |
| Malicious/compromised request reaches the engine | Every parameter is validated; projects are addressed by id; paths are normalized and confined (`..`, absolute paths, NUL, symlink escape via real-path check); system directories and the home directory itself cannot be opened; request size capped. |
| AI-generated patch damages the repository | Syntax/path validation, secret-file and `.git/` blocking, deletion opt-in, `git apply --check`, dirty-file overlap requires confirmation, checkpoint ref before every apply, revert; regression findings shown before approval; patches are never committed or pushed. |
| AI-generated command is harmful | Commands are never taken from DeepSeek automatically. Detected commands come from your build files; custom commands are typed by you, parsed without a shell (pipes, `&&`, `$()`, redirects rejected) and blocked for `sudo`/`su`/`doas`/`pkexec`, shells, `rm`, destructive git subcommands and system tools. Each run needs a single-use token issued for the exact argv + directory that the UI displayed, plus `approved: true`. Timeout, process-group kill and output caps apply. |
| Secrets leak into prompts, logs or exports | Secret files are excluded from indexing; secret-looking values are redacted from context, outlines, signatures, regression explanations, command output and logs. GitHub tokens live in the OS keyring (via `secret-tool`, token passed on stdin), never in prompts, exports, IndexedDB or logs; remote URLs have credentials stripped. |
| Prompt injection in repository files | Files are wrapped in delimited blocks; the prompt states that file content is data; RepoMind's delimiters inside files are neutralized; instruction-like text is flagged in the UI. RepoMind itself never executes anything found in a repository file. |
| Build commands reading credentials from the browser environment | Commands get an allow-listed environment (paths, SDK homes, locale, proxies). |
| Over-broad GitHub access | Only read-only fine-grained tokens are recommended; classic tokens trigger a warning; the extension never writes to GitHub. |

## Limits you should know

- Build scripts are code. Running `./gradlew`, `npm test` or `make` executes whatever the project defines — RepoMind shows the command and asks, but cannot sandbox it. Run builds of untrusted projects in a VM/container.
- The approval in the UI is enforced by the extension; the engine enforces the `approved` flag and command tokens but cannot see your screen. Anything that can control your browser profile could act as you.
- Secret detection is pattern-based and can miss custom formats.
- Heuristic analysis is not a security review.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (Security → Report a vulnerability) on <https://github.com/cyb3rl00m/repo-mind>. Include steps to reproduce and the affected version. You will get an answer as soon as possible; please allow time for a fix before public disclosure.
