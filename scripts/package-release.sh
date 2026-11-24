#!/usr/bin/env bash
# Builds the prebuilt release archive: release/repomind-prebuilt.tar.gz (contains a "repomind/" folder).
# Users install it with ./scripts/install.sh --no-build — no npm needed on their machine.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
OUT="$ROOT/release"
STAGE="$OUT/stage/repomind"

cd "$ROOT"
npm ci --no-audit --no-fund
npm run build

rm -rf "$OUT/stage" && mkdir -p "$STAGE/packages/extension" "$STAGE/packages/engine"
cp -r packages/extension/dist "$STAGE/packages/extension/"
cp -r packages/engine/dist "$STAGE/packages/engine/"
mkdir -p "$STAGE/scripts"
cp scripts/install.sh scripts/uninstall.sh scripts/selftest.mjs "$STAGE/scripts/"
cp README.md INSTALLATION.md CHANGELOG.md LICENSE SECURITY.md PRIVACY.md package.json "$STAGE/"
cat > "$STAGE/INSTALL-PREBUILT.txt" <<TXT
RepoMind $VERSION — prebuilt (no npm build needed)

  sudo pacman -S --needed nodejs git          # optional: libsecret kdialog
  ./scripts/install.sh --no-build
  node scripts/selftest.mjs

Then: chrome://extensions -> Developer mode -> Load unpacked -> ~/repomind/packages/extension/dist
(the folder you extracted). Extension ID: ddblnfbnekcpcpnnbeioffideiikfgmp
Keep this folder in place: Chrome loads the extension from it.
TXT
chmod +x "$STAGE/scripts/"*.sh
tar -C "$OUT/stage" -czf "$OUT/repomind-prebuilt.tar.gz" repomind
(cd "$OUT" && sha256sum repomind-prebuilt.tar.gz > repomind-prebuilt.tar.gz.sha256)
rm -rf "$OUT/stage"
echo "Built $OUT/repomind-prebuilt.tar.gz (RepoMind $VERSION)"
