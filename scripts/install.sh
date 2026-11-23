#!/usr/bin/env bash
# RepoMind installer for CachyOS / Arch Linux (works on other Linux distributions too).
#
# - Installs the local engine into ~/.local/share/repomind/engine (user-level, no root).
# - Registers the Chrome Native Messaging host for the browsers found in your home directory.
# - Never runs sudo. If something is missing it tells you the command to run yourself.
#
# Usage: ./scripts/install.sh [--no-build] [--browser chrome|chromium|brave|vivaldi|edge|all]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_ID="ddblnfbnekcpcpnnbeioffideiikfgmp"
HOST_NAME="com.repomind.engine"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
INSTALL_DIR="$DATA_HOME/repomind/engine"
BUILD=1
BROWSER="auto"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --browser) BROWSER="${2:-auto}"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

if [[ $EUID -eq 0 && -z "${REPOMIND_ALLOW_ROOT:-}" ]]; then
  die "Do not run the installer as root. It installs into your user account only."
fi

say "Checking dependencies"
command -v node >/dev/null || die "Node.js not found. Install it with: sudo pacman -S nodejs npm"
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node.js $("$NODE_BIN" --version) is too old; RepoMind needs Node 20 or newer."
ok "Node.js $("$NODE_BIN" --version) at $NODE_BIN"
command -v git >/dev/null || die "git not found. Install it with: sudo pacman -S git"
ok "$(git --version)"
if command -v secret-tool >/dev/null; then ok "secret-tool (system keyring for GitHub tokens)"; else warn "secret-tool missing — optional, for private repos: sudo pacman -S libsecret"; fi
if command -v kdialog >/dev/null || command -v zenity >/dev/null; then ok "folder picker available"; else warn "no kdialog/zenity — optional folder picker: sudo pacman -S kdialog"; fi
if command -v java >/dev/null; then ok "java found (Gradle builds)"; else warn "java not found — needed for Android/Gradle builds: sudo pacman -S jdk17-openjdk"; fi

if [[ $BUILD -eq 1 ]]; then
  say "Building RepoMind (npm ci && npm run build)"
  command -v npm >/dev/null || die "npm not found. Install it with: sudo pacman -S npm"
  (cd "$ROOT" && npm ci --no-audit --no-fund && npm run build)
fi
[[ -f "$ROOT/packages/engine/dist/repomind-engine.cjs" ]] || die "Engine build missing. Run: npm ci && npm run build"
[[ -f "$ROOT/packages/extension/dist/manifest.json" ]] || die "Extension build missing. Run: npm ci && npm run build"

say "Installing the local engine to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
install -m 0644 "$ROOT/packages/engine/dist/repomind-engine.cjs" "$INSTALL_DIR/repomind-engine.cjs"
# Chrome starts native hosts without your shell's PATH, so the launcher pins the absolute Node path.
cat > "$INSTALL_DIR/repomind-engine" <<LAUNCHER
#!/bin/sh
exec "$NODE_BIN" "$INSTALL_DIR/repomind-engine.cjs" "\$@"
LAUNCHER
chmod 0755 "$INSTALL_DIR/repomind-engine"
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/repomind-engine" "$HOME/.local/bin/repomind-engine"
ok "engine installed (also linked as ~/.local/bin/repomind-engine)"

say "Registering the Native Messaging host"
declare -A DIRS=(
  [chrome]="$CONFIG_HOME/google-chrome"
  [chrome-beta]="$CONFIG_HOME/google-chrome-beta"
  [chrome-dev]="$CONFIG_HOME/google-chrome-unstable"
  [chromium]="$CONFIG_HOME/chromium"
  [brave]="$CONFIG_HOME/BraveSoftware/Brave-Browser"
  [vivaldi]="$CONFIG_HOME/vivaldi"
  [edge]="$CONFIG_HOME/microsoft-edge"
)
registered=0
for name in "${!DIRS[@]}"; do
  dir="${DIRS[$name]}"
  if [[ "$BROWSER" == "auto" && ! -d "$dir" ]]; then continue; fi
  if [[ "$BROWSER" != "auto" && "$BROWSER" != "all" && "$BROWSER" != "$name" ]]; then continue; fi
  mkdir -p "$dir/NativeMessagingHosts"
  cat > "$dir/NativeMessagingHosts/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "RepoMind Local Engine",
  "path": "$INSTALL_DIR/repomind-engine",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  chmod 0644 "$dir/NativeMessagingHosts/$HOST_NAME.json"
  ok "$name: $dir/NativeMessagingHosts/$HOST_NAME.json"
  registered=$((registered + 1))
done
if [[ $registered -eq 0 ]]; then
  warn "No browser profile directory found. Start Chrome once, or run: $0 --no-build --browser chrome"
fi

say "Running the engine self-check"
"$INSTALL_DIR/repomind-engine" --doctor || true

cat <<DONE

$(printf '\033[1mNext steps\033[0m')
  1. Open chrome://extensions and enable "Developer mode".
  2. Click "Load unpacked" and select: $ROOT/packages/extension/dist
  3. Check that the extension ID is: $EXT_ID
  4. Click the RepoMind toolbar icon; the side panel opens and the "Engine" pill turns green.
  5. Optional end-to-end self test (does not touch your projects):
       node $ROOT/scripts/selftest.mjs

Uninstall any time with: $ROOT/scripts/uninstall.sh
DONE
