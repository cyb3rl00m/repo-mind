#!/usr/bin/env bash
# Removes the RepoMind engine and Native Messaging registrations. Never touches your projects.
# Usage: ./scripts/uninstall.sh [--purge]   (--purge also deletes config, logs and RepoMind worktrees)
set -euo pipefail
HOST_NAME="com.repomind.engine"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

for dir in google-chrome google-chrome-beta google-chrome-unstable chromium BraveSoftware/Brave-Browser vivaldi microsoft-edge; do
  f="$CONFIG_HOME/$dir/NativeMessagingHosts/$HOST_NAME.json"
  if [[ -f "$f" ]]; then rm -f "$f"; echo "removed $f"; fi
done
if [[ -L "$HOME/.local/bin/repomind-engine" ]]; then rm -f "$HOME/.local/bin/repomind-engine"; echo "removed ~/.local/bin/repomind-engine"; fi
rm -rf "$DATA_HOME/repomind/engine" && echo "removed $DATA_HOME/repomind/engine"

if [[ $PURGE -eq 1 ]]; then
  if [[ -d "$DATA_HOME/repomind/worktrees" ]] && [[ -n "$(ls -A "$DATA_HOME/repomind/worktrees" 2>/dev/null)" ]]; then
    echo "WARNING: $DATA_HOME/repomind/worktrees contains git worktrees. Remove them from RepoMind or with 'git worktree remove' first;"
    echo "         they are left in place. Run 'git worktree prune' in the original repositories afterwards."
  else
    rm -rf "$DATA_HOME/repomind"
  fi
  rm -rf "$CONFIG_HOME/repomind" "$STATE_HOME/repomind"
  echo "removed RepoMind config and logs"
fi

cat <<'DONE'

Also:
  - Remove the extension in chrome://extensions (this deletes its local IndexedDB data).
  - If you stored a GitHub token in the keyring:   secret-tool clear service repomind account github-token
  - Revoke the token on GitHub:                     https://github.com/settings/personal-access-tokens
DONE
