#!/usr/bin/env bash
# Installs the OGraf -> Flame hook by linking this folder into Flame's shared Python hooks.
#
#   ./install.sh                         # .ograf.zip / package folders only
#   ./install.sh --studio ~/ograf-studio # also open .ogs template sets directly
#   ./install.sh --hooks-dir <dir>       # custom hooks folder (default /opt/Autodesk/shared/python)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="/opt/Autodesk/shared/python"
STUDIO=""
LINK_NAME="ograf_flame"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --studio) STUDIO="$2"; shift 2 ;;
    --hooks-dir) HOOKS_DIR="$2"; shift 2 ;;
    -h|--help) sed -n 2,7p "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

echo "OGraf -> Flame hook"

# Node.js 22+
NODE=""
for candidate in "$(command -v node || true)" "$HOME/.local/bin/node" /usr/local/bin/node /opt/homebrew/bin/node; do
  [[ -n "$candidate" && -x "$candidate" ]] && { NODE="$candidate"; break; }
done
[[ -n "$NODE" ]] || die "Node.js 22+ not found. Install it from https://nodejs.org and run this again."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node.js $("$NODE" -v) is too old; 22 or newer is needed."
ok "Node.js $("$NODE" -v) ($NODE)"

# Chrome / Chromium / Edge
CHROME=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
  [[ -x "$candidate" ]] && { CHROME="$candidate"; break; }
done
if [[ -n "$CHROME" ]]; then ok "Browser: $CHROME"; else warn "Chrome not found. Install Google Chrome or set OGRAF_CHROME."; fi
command -v unzip >/dev/null || warn "unzip not found; .ograf.zip input will not work."

# Optional OGraf Studio checkout for .ogs input
if [[ -n "$STUDIO" ]]; then
  STUDIO="$(cd "$STUDIO" && pwd)" || die "Studio folder not found: $STUDIO"
  [[ -f "$STUDIO/packages/codegen/src/buildExportArtifacts.ts" ]] || die "$STUDIO is not an OGraf Studio checkout."
  if [[ ! -f "$STUDIO/node_modules/tsx/dist/cli.mjs" || ! -f "$STUDIO/packages/ograf-runtime/dist/graphic-runtime.js" ]]; then
    echo "  Preparing OGraf Studio (npm ci + runtime build)..."
    (cd "$STUDIO" && PATH="$(dirname "$NODE"):$PATH" npm ci --silent && PATH="$(dirname "$NODE"):$PATH" npm run --silent build --workspace @ograf-editor/ograf-runtime >/dev/null)
  fi
  printf '{\n  "studioDir": "%s"\n}\n' "$STUDIO" > "$HERE/config.json"
  ok "OGraf Studio: $STUDIO (.ogs files enabled)"
else
  warn "No --studio given: use .ograf.zip exports (Non-real-time or Dual profile). .ogs needs --studio."
fi

# Link into Flame's hooks folder
[[ -d "$HOOKS_DIR" ]] || die "Flame hooks folder not found: $HOOKS_DIR (is Flame installed? use --hooks-dir)"
TARGET="$HOOKS_DIR/$LINK_NAME"
SUDO=""
[[ -w "$HOOKS_DIR" ]] || SUDO="sudo"
if [[ -L "$TARGET" || -e "$TARGET" ]]; then
  [[ -L "$TARGET" ]] || die "$TARGET exists and is not a link; remove it first."
  $SUDO rm "$TARGET"
fi
$SUDO ln -s "$HERE" "$TARGET"
ok "Linked $TARGET -> $HERE"

echo
echo "Done. In Flame: Flame menu > Python > Rescan Python Hooks (or restart Flame),"
echo "then right-click a reel > OGraf > Render OGraf Graphic..."
