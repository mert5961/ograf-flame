#!/usr/bin/env bash
# Removes the OGraf -> Flame hook link. Rendered clips and this folder are left in place.
set -euo pipefail
HOOKS_DIR="${1:-/opt/Autodesk/shared/python}"
TARGET="$HOOKS_DIR/ograf_flame"
if [[ -L "$TARGET" ]]; then
  if [[ -w "$HOOKS_DIR" ]]; then rm "$TARGET"; else sudo rm "$TARGET"; fi
  echo "Removed $TARGET. Rescan Python hooks or restart Flame."
else
  echo "Nothing to remove at $TARGET."
fi
