#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# check-published-license-closure.sh [--only <package-dir>]...
#
# License gate over the production closure of each published package (the 5 of
# scripts/publish-targets.sh). The union of the 5 closures covers the published closure: every
# `workspace:` runtime dependency of a published package is itself one of the 5.
# INV-INFRA-LICENSE-GATE-CLOSURE-001.
#
# The root package declares no dependencies, so a root-only `license-checker` run inspected
# nothing and still exited 0. This gate lists the production closure of every published
# package with `pnpm --filter <name> licenses list --prod --json` (reads the installed tree;
# no registry access, no package code runs) and fails when:
#   - a package's closure is empty (inspected=0)
#   - a dependency the package declares in `dependencies` is missing from its closure (positive
#     control; it follows the manifest, so a dependency added later is covered without editing
#     this file). `optionalDependencies` are listed in the closure but are not required by this
#     control, because an optional package may be legitimately absent from an install tree.
#   - a license is outside LICENSE_ALLOWLIST (SPDX OR/AND expressions are evaluated)
#   - the listing cannot be read or parsed
# A package that is individually reviewed (see license-closure-eval.mjs REVIEWED) is counted
# as reviewed=N, never silently dropped. Names come from each package.json, so the same script
# runs in the OSS tree where the scope differs.
#
# Exit: 0 every package passes | 1 a package fails | 2 bad input or missing tool.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# The allowlist of CI and security.md, unchanged. LGPL is not and must not be added here.
LICENSE_ALLOWLIST="MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;CC0-1.0;CC-BY-4.0;Unlicense;0BSD;AGPL-3.0-only;PostgreSQL;MPL-2.0;Python-2.0;BlueOak-1.0.0"

die() { echo "ERROR: $*" >&2; exit 2; }

for tool in pnpm node; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done
# shellcheck disable=SC1091 source=../publish-targets.sh
source "$SCRIPT_DIR/../publish-targets.sh" || die "cannot load scripts/publish-targets.sh"
declare -p PUBLISH_PACKAGES >/dev/null 2>&1 || die "PUBLISH_PACKAGES is not defined"
[ "${#PUBLISH_PACKAGES[@]}" -gt 0 ] || die "PUBLISH_PACKAGES is empty"

targets=("${PUBLISH_PACKAGES[@]}")
if [ $# -gt 0 ]; then
  targets=()
  while [ $# -gt 0 ]; do
    [ "$1" = "--only" ] && [ $# -ge 2 ] || die "usage: $0 [--only <package-dir>]..."
    found=0
    for p in "${PUBLISH_PACKAGES[@]}"; do [ "$p" = "$2" ] && found=1; done
    [ "$found" -eq 1 ] || die "not a published package dir: $2"
    targets+=("$2")
    shift 2
  done
fi

status=0
for dir in "${targets[@]}"; do
  manifest="$REPO_ROOT/$dir/package.json"
  [ -f "$manifest" ] || { echo "FAIL $dir: package.json not found" >&2; status=1; continue; }
  name="$(node -p "require(process.argv[1]).name" "$manifest")" || die "cannot read name of $dir"
  listing="$(cd "$REPO_ROOT" && pnpm --filter "$name" licenses list --prod --json)" || {
    echo "FAIL $name: cannot list the production closure" >&2
    status=1
    continue
  }
  printf '%s' "$listing" | node "$SCRIPT_DIR/license-closure-eval.mjs" \
    --name "$name" --manifest "$manifest" --allow "$LICENSE_ALLOWLIST" || status=1
done

if [ "$status" -eq 0 ]; then
  echo "license gate: OK (${#targets[@]} package(s))"
else
  echo "license gate: FAILED" >&2
fi
exit "$status"
