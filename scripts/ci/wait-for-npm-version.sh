#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# wait-for-npm-version.sh <@scope/name> <version> [deadline_epoch]
#
# Waits until the npm version document answers HTTP 200 with the target version.
#
# Primary probe : GET https://registry.npmjs.org/<@scope%2Fname>/<version>
#                 success = HTTP 200 and .version == <version>;
#                 5xx / timeout / body mismatch = "not yet".
# Log only      : `npm view <pkg>@<ver> --prefer-online version` and the packument
#                 time[<version>]; never a success criterion.
# Backoff       : 5 s, doubling, capped at 30 s.
# Deadline      : [deadline_epoch], default now + NPM_PROPAGATION_MAX_SECONDS.
#
# Publish stderr (fail-closed): when NPM_PUBLISH_STDERR_FILE is non-empty, exit 2 before any
# probe unless the refusal is a classified republish. Callers pass the variable only when
# `npm publish` failed. A republish is classified only when the stderr holds BOTH `E403`
# and `previously published versions` AND the fixture file (NPM_403_FIXTURE, default
# scripts/ci/fixtures/npm-403-republish.txt) holds both strings too. A fixture may only be
# taken from a source that writes nothing (npm CLI / registry source text, with URL and
# retrieval date in its header). No such fixture ships, so the classifier is disabled and
# every publish failure exits 2. A classified package gets deadline =
# classification time + NPM_PROPAGATION_MAX_SECONDS.
#
# Exit: 0 visible | 1 deadline reached | 2 bad input, missing tool, deadline ceiling, or a
# publish failure that is not a classified republish.
# =============================================================================
set -uo pipefail

# Observed maximum 1039 s (n = 5) plus the 300 s packument CDN max-age gives a floor of
# 1339 s; 600 s and 900 s are below it, 1800 s is the only listed option above it.
# Revise only on new time[version] evidence.
NPM_PROPAGATION_MAX_SECONDS=1800
REGISTRY_BASE="https://registry.npmjs.org"
BACKOFF_START=5
BACKOFF_CAP=30

die() { echo "ERROR: $*" >&2; exit 2; }

[ $# -ge 2 ] && [ $# -le 3 ] || die "usage: $0 <@scope/name> <version> [deadline_epoch]"
PKG="$1"
VERSION="$2"
[[ "$PKG" =~ ^@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$ ]] || die "bad package name"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "bad version"
if [ $# -eq 3 ]; then
  [[ "$3" =~ ^[0-9]{1,12}$ ]] || die "bad deadline_epoch"
fi
for tool in curl jq npm; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENC_NAME="${PKG/\//%2F}"
DOC_URL="${REGISTRY_BASE}/${ENC_NAME}/${VERSION}"
PACKUMENT_URL="${REGISTRY_BASE}/${ENC_NAME}"

now() { date +%s; }
START=$(now)
DEADLINE="${3:-$((START + NPM_PROPAGATION_MAX_SECONDS))}"
# a caller-supplied deadline may shorten the wait, never extend it past the constant
[ "$DEADLINE" -le $((START + NPM_PROPAGATION_MAX_SECONDS)) ] ||
  die "deadline_epoch is more than ${NPM_PROPAGATION_MAX_SECONDS} s ahead"

# --- stderr contract (fail-closed) ----------------------------------------------------
# Once NPM_PUBLISH_STDERR_FILE is non-empty, every case except a classified republish
# exits 2 before any probe: missing / unreadable file, a refusal without E403, a 403 that
# is not a republish, or a disabled classifier. Callers pass the variable only when
# `npm publish` failed.
STDERR_FILE="${NPM_PUBLISH_STDERR_FILE:-}"
if [ -n "$STDERR_FILE" ]; then
  if [ ! -f "$STDERR_FILE" ] || [ ! -r "$STDERR_FILE" ]; then
    echo "::error::$PKG@$VERSION: publish stderr file is not a readable regular file" >&2
    exit 2
  fi
  if grep -qF 'E403' "$STDERR_FILE" && grep -qF 'previously published versions' "$STDERR_FILE"; then
    FIXTURE="${NPM_403_FIXTURE:-$SCRIPT_DIR/fixtures/npm-403-republish.txt}"
    if [ ! -f "$FIXTURE" ] || ! grep -qF 'E403' "$FIXTURE" ||
      ! grep -qF 'previously published versions' "$FIXTURE"; then
      echo "::error::$PKG@$VERSION: publish failed and the 403 classifier disabled (no fixture with both strings)" >&2
      exit 2
    fi
    CLASSIFIED_AT=$(now)
    DEADLINE=$((CLASSIFIED_AT + NPM_PROPAGATION_MAX_SECONDS))
    echo "[wait] $PKG@$VERSION: 403 classified as republish at=$CLASSIFIED_AT deadline=$DEADLINE"
  else
    echo "::error::$PKG@$VERSION: publish failed and it is not a republish (unclassified 403 or other refusal)" >&2
    exit 2
  fi
fi

# --- wait loop -----------------------------------------------------------------------
BODY_FILE=$(mktemp) || die "mktemp failed"
trap 'rm -f "$BODY_FILE"' EXIT

probe_doc() {
  # sets PROBE_STATUS; PROBE_OK=1 on 200 with the target version (no subshell: globals)
  local code rc
  PROBE_OK=0
  : >"$BODY_FILE"
  code=$(curl -sS --max-time 20 --proto =https -o "$BODY_FILE" -w '%{http_code}' "$DOC_URL" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    PROBE_STATUS="curl-error-$rc"
    return
  fi
  PROBE_STATUS="$code"
  if [ "$code" = "200" ]; then
    if [ "$(jq -r '.version // empty' "$BODY_FILE" 2>/dev/null)" = "$VERSION" ]; then
      PROBE_OK=1
    else
      PROBE_STATUS="200-version-mismatch"
    fi
  fi
}

secondary_log() {
  # log only; values are checked before printing so a hostile response cannot inject
  # workflow commands
  local npm_out t
  npm_out=$(npm view "${PKG}@${VERSION}" --prefer-online version --fetch-timeout=20000 --fetch-retries=0 2>/dev/null | head -1)
  t=$(curl -sS --max-time 20 --proto =https "$PACKUMENT_URL" 2>/dev/null |
    jq -r --arg v "$VERSION" '.time[$v] // empty' 2>/dev/null | head -1)
  if [ -n "$npm_out" ] && ! [[ "$npm_out" =~ ^[0-9A-Za-z.+-]{1,64}$ ]]; then npm_out="unparsable"; fi
  if [ -n "$t" ] && ! [[ "$t" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,16}Z$ ]]; then t="unparsable"; fi
  echo "[wait]   npm-view=${npm_out:-none} time[${VERSION}]=${t:-unknown}"
}

attempt=0
delay=$BACKOFF_START
last_status="none"
PROBE_OK=0
PROBE_STATUS="none"
echo "[wait] $PKG@$VERSION: deadline=$DEADLINE"
while :; do
  attempt=$((attempt + 1))
  elapsed=$(($(now) - START))
  probe_doc
  last_status="$PROBE_STATUS"
  echo "[wait] attempt=$attempt elapsed=${elapsed}s probe=version-doc status=$PROBE_STATUS"
  secondary_log
  if [ "$PROBE_OK" -eq 1 ]; then
    echo "[wait] $PKG@$VERSION visible after ${elapsed}s"
    exit 0
  fi
  if [ "$(now)" -ge "$DEADLINE" ]; then
    break
  fi
  sleep "$delay"
  delay=$((delay * 2))
  [ "$delay" -gt "$BACKOFF_CAP" ] && delay=$BACKOFF_CAP
done

echo "::error::$PKG@$VERSION: not visible at the deadline (last status=$last_status)" >&2
echo "[wait] deadline reached, last status=$last_status"
exit 1
