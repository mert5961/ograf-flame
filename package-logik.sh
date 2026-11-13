#!/usr/bin/env bash
# Builds a clean folder to submit to the Logik Portal (Python Scripts tab > Submit).
# In the submit window choose dist/logik/ograf_flame/ograf_flame.py and tick "Upload All Files".
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/dist/logik/ograf_flame"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$HERE"/{ograf_flame.py,renderFrames.mjs,exportPackage.mts,README.md,LICENSE} "$OUT/"
echo "Logik Portal package ready: $OUT"
ls -1 "$OUT"
