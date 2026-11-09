#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Build Sheddit for Firefox and Chrome from the shared source in src/.
#
#   dist/sheddit-firefox.xpi   Firefox package
#   dist/chrome/               unpacked Chrome extension ("Load unpacked")
#   dist/sheddit-chrome.zip    Chrome package, for the Chrome Web Store
#
# src/manifest.json is the Firefox manifest. The Chrome manifest is the same
# file without the Firefox-only browser_specific_settings and developer keys,
# and with the background script declared as a service worker.
set -eu
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist/chrome

(cd src && zip -qr ../dist/sheddit-firefox.xpi .)

cp -r src/*.js src/*.html src/icons src/images dist/chrome/
python3 - <<'PY'
import json
with open("src/manifest.json") as f:
    manifest = json.load(f)
manifest.pop("browser_specific_settings", None)
manifest.pop("developer", None)
# Chrome runs MV3 background scripts as a service worker.
manifest["background"] = {"service_worker": "background.js"}
with open("dist/chrome/manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY
(cd dist/chrome && zip -qr ../sheddit-chrome.zip .)

echo "Built:"
ls -1 dist
