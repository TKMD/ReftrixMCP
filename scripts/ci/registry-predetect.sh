#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# registry-predetect.sh [--recheck] <server.json>
#
# Pre-detect for the MCP Registry sync: is this exact version already registered, and is the
# existing record the same package? The Registry record of a version is immutable, so a
# record that differs in identity can never be repaired by publishing again.
#
#   GET https://registry.modelcontextprotocol.io/v0.1/servers/<name with %2F>/versions/<version>
#
#   200 -> identity compare on 5 fields: name, packages[0].registryType, .identifier,
#          .version, repository.url. All equal -> decision=skip-registered; any difference
#          -> fail (exit 1) naming the fields (never their values).
#   404 -> decision=publish.
#   anything else (5xx, timeout, other status, unreadable body) -> MAX_RETRIES bounded
#          retries with backoff, then fail closed (exit 1). Never read as "not registered".
#
# --recheck is the re-GET after a failed publish: 200 + identity match -> decision=registered
# (the publish error did not lose the record); 404 or a mismatch -> fail (exit 1).
#
# A description-only difference is reported (description_drift=true, ::notice::), not failed.
# stdout: decision=<publish|skip-registered|registered> and description_drift=<true|false>.
# Exit: 0 decided | 1 identity mismatch or registry not readable | 2 bad input or tool.
# =============================================================================
set -euo pipefail

REGISTRY_BASE="https://registry.modelcontextprotocol.io/v0.1/servers"
MAX_RETRIES=3
BACKOFF_START=5

die() { echo "ERROR: $*" >&2; exit 2; }
fail() { echo "::error::registry-predetect: $*" >&2; exit 1; }

RECHECK=0
if [ "${1:-}" = "--recheck" ]; then RECHECK=1; shift; fi
[ $# -eq 1 ] || die "usage: $0 [--recheck] <server.json>"
FILE="$1"
[ -f "$FILE" ] || die "server.json not found"
for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done

# local identity: one JSON object, the 5 compared fields plus the top-level version
LOCAL=$(jq -s -c -e 'if length == 1 and (.[0] | type) == "object" then
    .[0] as $s | {
      name: $s.name,
      registryType: $s.packages[0].registryType,
      identifier: $s.packages[0].identifier,
      version: $s.packages[0].version,
      url: $s.repository.url,
      top: $s.version,
      description: $s.description
    } else error("shape") end' "$FILE" 2>/dev/null) || die "server.json is not a readable object"

field() { jq -r --arg k "$1" '.[$k] // empty' <<<"$LOCAL"; }
NAME=$(field name)
VERSION=$(field version)
[[ "$NAME" =~ ^io\.github\.[A-Za-z0-9-]+/[a-z0-9-]+$ ]] || die "bad server name"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "bad version"
[ "$(field top)" = "$VERSION" ] || die "version and packages[0].version differ"
for k in registryType identifier url; do
  [ -n "$(field "$k")" ] || die "server.json lacks $k"
done

URL="${REGISTRY_BASE}/${NAME/\//%2F}/versions/${VERSION}"
BODY=$(mktemp) || die "mktemp failed"
trap 'rm -f "$BODY"' EXIT

fetch() { # prints the HTTP status, or curl-error-<rc>
  local code rc=0
  : >"$BODY"
  code=$(curl -sS --max-time 20 --proto =https -o "$BODY" -w '%{http_code}' "$URL" 2>/dev/null) || rc=$?
  if [ "$rc" -ne 0 ]; then echo "curl-error-$rc"; else echo "$code"; fi
}

attempt=0
delay=$BACKOFF_START
while true; do
  status=$(fetch)
  case "$status" in
    200 | 404) break ;;
  esac
  [ "$attempt" -lt "$MAX_RETRIES" ] ||
    fail "registry not readable after $MAX_RETRIES retries (category network); not read as 'not registered'"
  sleep "$delay"
  delay=$((delay * 2))
  attempt=$((attempt + 1))
done

if [ "$status" = "404" ]; then
  [ "$RECHECK" -eq 0 ] || fail "recheck: the version is not registered after the publish error"
  echo "decision=publish"
  echo "description_drift=false"
  exit 0
fi

# 200: the body is one JSON object; the v0.1 API wraps the record in {"server": {...}}
REMOTE=$(jq -s -c -e 'if length == 1 and (.[0] | type) == "object" then
    (.[0] | if (.server | type) == "object" then .server else . end) as $r | {
      name: $r.name,
      registryType: $r.packages[0].registryType,
      identifier: $r.packages[0].identifier,
      version: $r.packages[0].version,
      url: $r.repository.url,
      description: $r.description
    } else error("shape") end' "$BODY" 2>/dev/null) || fail "registry answered 200 with an unreadable record"

DIFF=$(jq -r -n --argjson l "$LOCAL" --argjson r "$REMOTE" \
  '["name","registryType","identifier","version","url"] | map(select($l[.] != $r[.])) | join(",")')
if [ -n "$DIFF" ]; then
  fail "registered record differs in: $DIFF; the record is immutable, so this stays red until the next version"
fi

DRIFT=false
if [ "$(jq -n --argjson l "$LOCAL" --argjson r "$REMOTE" '$l.description == $r.description')" != "true" ]; then
  DRIFT=true
  echo "::notice::registry-predetect: description differs from the registered record (report only)" >&2
fi
if [ "$RECHECK" -eq 1 ]; then echo "decision=registered"; else echo "decision=skip-registered"; fi
echo "description_drift=$DRIFT"
