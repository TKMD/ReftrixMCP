#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# check-npm-provenance.sh <@scope/name> <version> <tag_commit_sha> [deadline_epoch]
#
# Integrity source for a published version: the npm provenance attestation, never a
# rebuilt tarball (the mcp-server tarball is not reproducible). Run it AFTER the version
# document answered 200.
#
#   GET https://registry.npmjs.org/-/npm/v1/attestations/<scope%2fname>@<version>
#   GET https://registry.npmjs.org/<scope%2Fname>/<version>      (dist.integrity)
#
# Checks, on the SLSA v1 entry (in-toto statement in the DSSE payload):
#   1. a subject sha512 digest equals the version document's dist.integrity
#   2. predicate.buildDefinition.externalParameters.workflow.repository == EXPECTED_REPOSITORY
#   3. ...workflow.path == EXPECTED_WORKFLOW_PATH
#   4. every predicate.buildDefinition.resolvedDependencies[].digest.gitCommit == <tag_commit_sha>
# The JSON paths were compared with the live registry response for @reftrixmcp/*@0.6.1
# (tag commit bcb281b3, 2026-10-21): rc 0 for the real values, rc 1 for a wrong tag commit sha.
#
# A mismatch fails at once. A response that is not yet 200 (attestation or version
# document) is retried with the wait script's backoff until [deadline_epoch] (default: now,
# so one probe), then fails. Registry-supplied values are never echoed.
# Exit: 0 verified | 1 mismatch or not available at the deadline | 2 bad input or tool.
# =============================================================================
set -uo pipefail

NPM_PROPAGATION_MAX_SECONDS=1800
REGISTRY_BASE="https://registry.npmjs.org"
EXPECTED_REPOSITORY="https://github.com/TKMD/ReftrixMCP"
EXPECTED_WORKFLOW_PATH=".github/workflows/publish.yml"
SLSA_PREDICATE="https://slsa.dev/provenance/v1"
BACKOFF_START=5
BACKOFF_CAP=30

die() { echo "ERROR: $*" >&2; exit 2; }

[ $# -ge 3 ] && [ $# -le 4 ] || die "usage: $0 <@scope/name> <version> <tag_commit_sha> [deadline_epoch]"
PKG="$1"
VERSION="$2"
TAG_SHA="$3"
[[ "$PKG" =~ ^@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$ ]] || die "bad package name"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "bad version"
[[ "$TAG_SHA" =~ ^[0-9a-f]{40}$ ]] || die "bad tag commit sha"
if [ $# -eq 4 ]; then
  [[ "$4" =~ ^[0-9]{1,12}$ ]] || die "bad deadline_epoch"
fi
for tool in curl jq base64 od; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done

DOC_URL="${REGISTRY_BASE}/${PKG/\//%2F}/${VERSION}"
ATT_URL="${REGISTRY_BASE}/-/npm/v1/attestations/${PKG/\//%2f}@${VERSION}"

now() { date +%s; }
START=$(now)
DEADLINE="${4:-$START}"
[ "$DEADLINE" -le $((START + NPM_PROPAGATION_MAX_SECONDS)) ] ||
  die "deadline_epoch is more than ${NPM_PROPAGATION_MAX_SECONDS} s ahead"

DOC_FILE=$(mktemp) || die "mktemp failed"
ATT_FILE=$(mktemp) || die "mktemp failed"
trap 'rm -f "$DOC_FILE" "$ATT_FILE"' EXIT

fetch() { # <url> <file>: prints the HTTP status, or curl-error-<rc>
  local code rc
  : >"$2"
  code=$(curl -sS --max-time 20 --proto =https -o "$2" -w '%{http_code}' "$1" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then echo "curl-error-$rc"; else echo "$code"; fi
}

mismatch() { echo "::error::$PKG@$VERSION: provenance check failed: $1" >&2; exit 1; }

verify() {
  local integrity expected_hex payload statement slsa_entries
  # one JSON object whose version is the target; a stream of values is refused, so the
  # integrity read below belongs to the same value
  jq -s -e --arg v "$VERSION" 'length == 1 and (.[0] | type == "object") and .[0].version == $v' "$DOC_FILE" >/dev/null 2>&1 ||
    mismatch "version document version differs"
  integrity=$(jq -r '.dist.integrity // empty' "$DOC_FILE" 2>/dev/null)
  [[ "$integrity" =~ ^sha512-[A-Za-z0-9+/]+=*$ ]] || mismatch "dist.integrity is not a sha512 value"
  expected_hex=$(printf '%s' "${integrity#sha512-}" | base64 -d 2>/dev/null | od -An -v -tx1 | tr -d ' \n') ||
    mismatch "dist.integrity is not valid base64"
  [ "${#expected_hex}" -eq 128 ] || mismatch "dist.integrity is not a 64-byte digest"
  slsa_entries=$(jq -r --arg p "$SLSA_PREDICATE" '[.attestations[]? | select(.predicateType == $p)] | length' "$ATT_FILE" 2>/dev/null)
  [ "${slsa_entries:-0}" -ge 1 ] 2>/dev/null || mismatch "no SLSA v1 provenance entry"
  [ "$slsa_entries" -eq 1 ] || mismatch "more than one SLSA v1 provenance entry"
  payload=$(jq -r --arg p "$SLSA_PREDICATE" \
    '.attestations[] | select(.predicateType == $p) | .bundle.dsseEnvelope.payload // empty' "$ATT_FILE" 2>/dev/null)
  [ -n "$payload" ] || mismatch "no SLSA v1 provenance entry"
  statement=$(printf '%s' "$payload" | base64 -d 2>/dev/null) || mismatch "attestation payload is not valid base64"
  # exactly one JSON value, and it is an object (jq -s: empty input gives length 0, a stream gives > 1)
  jq -s -e 'length == 1 and (.[0] | type == "object")' <<<"$statement" >/dev/null 2>&1 ||
    mismatch "attestation payload is not a single statement"
  jq -e --arg d "$expected_hex" '[.subject[]?.digest.sha512] | index($d) != null' <<<"$statement" >/dev/null 2>&1 ||
    mismatch "attestation subject digest differs from dist.integrity"
  jq -e --arg r "$EXPECTED_REPOSITORY" '.predicate.buildDefinition.externalParameters.workflow.repository == $r' <<<"$statement" >/dev/null 2>&1 ||
    mismatch "repository differs"
  jq -e --arg w "$EXPECTED_WORKFLOW_PATH" '.predicate.buildDefinition.externalParameters.workflow.path == $w' <<<"$statement" >/dev/null 2>&1 ||
    mismatch "workflow path differs"
  jq -e --arg c "$TAG_SHA" '[.predicate.buildDefinition.resolvedDependencies[]?.digest.gitCommit] | length > 0 and all(. == $c)' <<<"$statement" >/dev/null 2>&1 ||
    mismatch "commit differs from the tag commit"
}

attempt=0
delay=$BACKOFF_START
echo "[provenance] $PKG@$VERSION: deadline=$DEADLINE"
while :; do
  attempt=$((attempt + 1))
  doc_status=$(fetch "$DOC_URL" "$DOC_FILE")
  att_status=$(fetch "$ATT_URL" "$ATT_FILE")
  echo "[provenance] attempt=$attempt elapsed=$(($(now) - START))s version-doc=$doc_status attestation=$att_status"
  if [ "$doc_status" = "200" ] && [ "$att_status" = "200" ]; then
    verify
    echo "[provenance] $PKG@$VERSION verified"
    exit 0
  fi
  [ "$(now)" -ge "$DEADLINE" ] && break
  sleep "$delay"
  delay=$((delay * 2))
  [ "$delay" -gt "$BACKOFF_CAP" ] && delay=$BACKOFF_CAP
done

echo "::error::$PKG@$VERSION: attestation not available at the deadline (last status=$att_status, version-doc=$doc_status)" >&2
exit 1
