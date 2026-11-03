#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# INV-PUBLISHED-PACKAGE-LAUNCH-002 / INV-INFRA-PACKED-INSTALL-HARDENING-001
# Install the packed tarballs of the 5 published packages outside the repository in the hoisted layout (npm
# default) and start the packed mcp-server from node_modules/.bin. Usage: check-packed-launch.sh <tarball-dir> <version>
#
# Third-party install scripts must not run with a token in reach:
#   - install runs `--ignore-scripts --before=<now - PACKED_LAUNCH_BEFORE_DAYS days>` (default 14): a version
#     published inside that window is not installed, so a freshly published malicious release of a transitive
#     dependency cannot reach the check before the community has had time to spot it; ignore-scripts is never
#     written to .npmrc
#   - the only script that runs is `npm rebuild @prisma/client --foreground-scripts`, once per layout, after
#     asserting that no prisma CLI is installed or on PATH, and the result must be the stub-free client without
#     prisma generate, engine download or new npm cache entries
#   - install, rebuild and launch share one cleared environment (no tokens, NODE_PATH or Prisma variables); the
#     environment is cleared and rebuilt inside a subshell, so no value (DATABASE_URL included) is put on an argv
#   - PACKED_LAUNCH_PASSTHROUGH names must match ^[A-Za-z_][A-Za-z0-9_]*$ and must not match
#     TOKEN|SECRET|PASSWORD|AUTH or ^NPM_CONFIG_
# Run it in a disposable container locally; the server is started from node_modules/.bin, never through a package runner.
set -euo pipefail

TARBALLS="${1:?usage: check-packed-launch.sh <tarball-dir> <version>}"
VERSION="${2:?usage: check-packed-launch.sh <tarball-dir> <version>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MJS="$SCRIPT_DIR/check-packed-launch.mjs"
NPM="${PACKED_LAUNCH_NPM:-$(command -v npm)}"   # resolved before the environment is cleared
NODE_BIN="$(command -v node)"
NODE_DIR="${NODE_BIN%/*}"
TARBALLS="$(cd "$TARBALLS" && pwd)"
fail() { echo "FAIL $*"; echo "RESULT FAIL"; exit 1; }

BEFORE_DAYS="${PACKED_LAUNCH_BEFORE_DAYS:-14}"
[[ "$BEFORE_DAYS" =~ ^[0-9]+$ ]] && [ "$BEFORE_DAYS" -ge 1 ] || fail "PACKED_LAUNCH_BEFORE_DAYS must be a positive integer, got '$BEFORE_DAYS'"
for n in ${PACKED_LAUNCH_PASSTHROUGH:-}; do
  [[ "$n" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "PACKED_LAUNCH_PASSTHROUGH name '$n' is not a variable name"
  u="${n^^}"
  if [[ "$u" =~ TOKEN|SECRET|PASSWORD|AUTH ]] || [[ "$u" =~ ^NPM_CONFIG_ ]]; then
    fail "PACKED_LAUNCH_PASSTHROUGH name '$n' is refused (secret-like or npm config)"
  fi
done

ROOT="${PACKED_LAUNCH_TMP_ROOT:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
T="$(mktemp -d "$ROOT/packed-launch.XXXXXX")"
trap 'rm -rf "$T"' EXIT
if [ -n "$(git -C "$T" rev-parse --show-toplevel 2>/dev/null || true)" ]; then
  fail "the temp dir $T is inside a git work tree"
fi
mkdir -p "$T/home" "$T/npm-cache" "$T/empty-browsers"
: > "$T/empty-npmrc"

# One env for every child: install, rebuild and launch (the launch adds NODE_ENV and PLAYWRIGHT_BROWSERS_PATH).
cenv() {
  local extra=() n kv v
  for n in ${PACKED_LAUNCH_PASSTHROUGH:-} ${CENV_EXTRA:-}; do [ -n "${!n+x}" ] && extra+=("$n=${!n}"); done
  (
    for v in $(compgen -e); do unset "$v" 2>/dev/null || true; done
    export PATH="$NODE_DIR:/usr/bin:/bin" HOME="$T/home"
    export npm_config_userconfig="$T/empty-npmrc" npm_config_globalconfig=/dev/null
    export npm_config_registry=https://registry.npmjs.org/ npm_config_cache="$T/npm-cache"
    for kv in ${extra[@]+"${extra[@]}"}; do declare -x "$kv"; done
    exec "$@"
  )
}

# The launch runs against a reachable database: a server without one is not the contract.
[ -n "${PACKED_LAUNCH_DATABASE_URL:-}" ] || fail "PACKED_LAUNCH_DATABASE_URL (a reachable database) is required"

NOW="${PACKED_LAUNCH_NOW:-$(date +%s)}"
BEFORE="$(date -u -d "@$((NOW - BEFORE_DAYS * 86400))" +%Y-%m-%dT%H:%M:%SZ)"

# The linked layout (install-strategy=linked) is out of scope: @bull-board/api requires bullmq without declaring it,
# so the packed server cannot start there (tracked: .claude/specs/tracked-issues/release.md).
layout=hoisted
{
  P="$T/$layout"
  mkdir -p "$P"
  cd "$P"
  echo '{"name":"packed-launch-probe","version":"0.0.0","private":true}' > package.json
  # layout only; ignore-scripts must stay on the install argv so a later rebuild is not a no-op
  : > .npmrc

  cenv "$NPM" install --ignore-scripts "--before=$BEFORE" "$TARBALLS"/*.tgz > "$T/install-$layout.log" 2>&1 \
    || fail "layout=$layout npm install failed (--before window: $BEFORE_DAYS days)"
  cenv node "$MJS" lock "$P" "$TARBALLS" || fail "layout=$layout lockfile check"

  # the single Prisma path: preconditions
  if [ -n "$(find node_modules -type d \( -path 'node_modules/prisma' -o -path '*/node_modules/prisma' -o -path 'node_modules/@prisma/cli' -o -path '*/node_modules/@prisma/cli' \) -print -quit)" ]; then
    fail "layout=$layout a prisma CLI is installed; refusing to rebuild"
  fi
  if cenv bash -c 'command -v prisma' > /dev/null 2>&1; then
    fail "layout=$layout a prisma CLI is on the child PATH; refusing to rebuild"
  fi
  cache_entries() { find "$T/npm-cache/_cacache" -type f 2>/dev/null | wc -l; }   # npm's own _logs are not cache entries
  CACHE_BEFORE="$(cache_entries)"
  cenv "$NPM" rebuild @prisma/client --foreground-scripts > "$T/rebuild-$layout.log" 2>&1 \
    || fail "layout=$layout npm rebuild @prisma/client failed"
  # postconditions
  NM="$(cenv node "$MJS" prisma-dir "$P")" || fail "layout=$layout @prisma/client does not resolve"
  [ -f "$NM/.prisma/client/default.js" ] || fail "layout=$layout no .prisma/client/default.js beside @prisma/client"
  if grep -Eiq 'prisma generate|downloading|fetching engine' "$T/rebuild-$layout.log"; then
    fail "layout=$layout rebuild ran prisma generate or fetched an engine"
  fi
  [ "$(cache_entries)" = "$CACHE_BEFORE" ] || fail "layout=$layout rebuild added npm cache entries"
  cenv node "$MJS" prisma-init "$P" || fail "layout=$layout prisma-init"

  cenv node "$MJS" ondisk "$P" "$TARBALLS" || fail "layout=$layout on-disk check"
  DATABASE_URL="$PACKED_LAUNCH_DATABASE_URL" CENV_EXTRA=DATABASE_URL cenv env NODE_ENV=development PLAYWRIGHT_BROWSERS_PATH="$T/empty-browsers" \
    node "$MJS" rpc "$P/node_modules/.bin/reftrix-mcp" "$VERSION" "${PACKED_LAUNCH_RPC_TIMEOUT_MS:-60000}" \
    || fail "layout=$layout launch"
  echo "layout=$layout ok"
}
echo "RESULT PASS"
