#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Publish a GitHub release for the version in src/manifest.json.
#
#   ./release.sh notes.md
#
# Builds both packages, tags the current commit as v<version>, pushes the
# tag and creates the release with the notes file as its description. The
# working tree must be clean so the release matches a commit.
set -eu
cd "$(dirname "$0")"

notes=${1:?usage: ./release.sh notes.md}
version=$(python3 -c 'import json; print(json.load(open("src/manifest.json"))["version"])')
tag="v$version"

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit your changes first." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists. Bump the version in src/manifest.json." >&2
  exit 1
fi

./build.sh
cp dist/sheddit-firefox.xpi "dist/sheddit-$version-firefox.xpi"
cp dist/sheddit-chrome.zip "dist/sheddit-$version-chrome.zip"

git tag -a "$tag" -m "Sheddit $version"
git push origin "$tag"
gh release create "$tag" --title "Sheddit $version" --notes-file "$notes" \
  "dist/sheddit-$version-firefox.xpi" "dist/sheddit-$version-chrome.zip"
