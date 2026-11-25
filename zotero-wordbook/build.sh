#!/usr/bin/env bash
# Builds the .xpi (a zip with manifest.json and bootstrap.js at the archive root)
set -euo pipefail
cd "$(dirname "$0")"
python3 tools/make_update.py
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/zotero-wordbook-${VERSION}.xpi"
mkdir -p dist
rm -f "$OUT"
zip -X -r "$OUT" manifest.json bootstrap.js prefs.js content
echo "$OUT"
