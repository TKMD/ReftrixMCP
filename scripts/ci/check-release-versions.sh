#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# check-release-versions.sh <data-dir> <tag>
#
# Every version a release carries must equal the version of the tag. <data-dir> is a tree
# laid out like the repository (a checkout of the tag, or files extracted from the tag):
#
#   <data-dir>/package.json                       root version
#   <data-dir>/<pkg>/package.json                 the 5 packages of scripts/publish-targets.sh
#   <data-dir>/server.json                        .version and .packages[0].version
#
# The package list comes from scripts/publish-targets.sh next to this script, never from
# <data-dir>. Called by publish.yml `verify`; versions read from <data-dir> are never echoed
# unless they match the semver shape.
# Exit: 0 all equal | 1 a version differs or is missing | 2 bad input or tool.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

die() { echo "ERROR: $*" >&2; exit 2; }

[ $# -eq 2 ] || die "usage: $0 <data-dir> <tag>"
DATA_DIR="$1"
TAG="$2"
[ -d "$DATA_DIR" ] || die "data dir not found"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$ ]] || die "bad tag"
command -v jq >/dev/null 2>&1 || die "required tool not found: jq"
# The pinned ShellCheck step in ci.yml runs without -x, so it cannot follow this source; the
# list it would read is checked at run time below instead.
# shellcheck disable=SC1091 source=../publish-targets.sh
source "$SCRIPT_DIR/../publish-targets.sh" || die "cannot load scripts/publish-targets.sh"
# Fail closed: no package list must never read as "no packages to compare".
declare -p PUBLISH_PACKAGES >/dev/null 2>&1 || die "PUBLISH_PACKAGES is not defined"
[ "${#PUBLISH_PACKAGES[@]}" -gt 0 ] || die "PUBLISH_PACKAGES is empty"

TAG_VERSION="${TAG#v}"
FAILED=0

# check <label> <file> <jq filter>
check() {
  local label="$1" file="$2" filter="$3" got
  if [ ! -f "$file" ]; then
    echo "::error::$label: file missing"
    FAILED=1
    return
  fi
  got=$(jq -r "$filter // empty" "$file" 2>/dev/null) || got=""
  if [[ ! "$got" =~ $SEMVER_RE ]]; then
    echo "::error::$label: version missing or not semver"
    FAILED=1
  elif [ "$got" != "$TAG_VERSION" ]; then
    echo "::error::$label: $got != tag $TAG_VERSION"
    FAILED=1
  fi
}

check "package.json" "$DATA_DIR/package.json" ".version"
for pkg in "${PUBLISH_PACKAGES[@]}"; do
  check "$pkg" "$DATA_DIR/$pkg/package.json" ".version"
done
check "server.json .version" "$DATA_DIR/server.json" ".version"
check "server.json .packages[0].version" "$DATA_DIR/server.json" ".packages[0].version"

[ "$FAILED" -eq 0 ] || exit 1
echo "OK: all release versions equal $TAG_VERSION"
