#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# registry-attestation-check.sh <attestation.json> <server.json> <publishing_entity> [<deprecation_message>]
#
# Passes only when the attestation file exists, is schema-valid (same shape as
# registry-sync-attestation.schema.json), cc0_rights_held is true, publishing_entity equals
# the given entity (the runtime caller passes github.repository_owner), and the content hash of
# server.json (registry-content-hash.sh) is a member of attested_content_sha256.
# It checks existence, consistency and hash membership; it cannot check that the statements are
# true, who added an entry, or whether the User approved it. Append-only is checked against git
# history in the private-only test leg, not here.
# On success prints the matched entry. Offending keys are named by path.
# Exit: 0 ok | 1 violation | 2 bad input or tool.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "ERROR: $*" >&2; exit 2; }
fail() { echo "::error::registry-attestation-check: $*" >&2; exit 1; }

[ $# -ge 3 ] && [ $# -le 4 ] || die "usage: $0 <attestation.json> <server.json> <publishing_entity> [<deprecation_message>]"
ATT="$1"
SERVER="$2"
ENTITY="$3"
[[ "$ENTITY" =~ ^[A-Za-z0-9-]+$ ]] || die "bad publishing_entity"
[ -f "$SERVER" ] || die "server.json not found"
command -v jq >/dev/null 2>&1 || die "required tool not found: jq"

[ -f "$ATT" ] || fail "attestation file not found"
jq -s -e 'length == 1 and (.[0] | type) == "object"' "$ATT" >/dev/null 2>&1 || fail "attestation is not one JSON object"

# shellcheck disable=SC2016 # jq program text, not shell expansion
PROBLEMS=$(jq -r '
  def date: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}\\z");
  def keys_ok($want; $p): (keys - $want | map($p + "." + . + ": key not allowed")) + ($want - keys | map($p + "." + . + ": missing"));
  keys_ok(["cc0_rights_held","publishing_entity","tos_effective","attested_on","decision_ref","conditions","attested_content_sha256"]; "$")[],
  (if has("cc0_rights_held") and .cc0_rights_held != true then "$.cc0_rights_held: must be true" else empty end),
  (if has("publishing_entity") and ((.publishing_entity | type) != "string" or (.publishing_entity | test("^[A-Za-z0-9-]+\\z") | not)) then "$.publishing_entity: bad value" else empty end),
  (if has("tos_effective") and (.tos_effective | date | not) then "$.tos_effective: bad date" else empty end),
  (if has("attested_on") and (.attested_on | date | not) then "$.attested_on: bad date" else empty end),
  (if has("decision_ref") and ((.decision_ref | type) != "string" or (.decision_ref | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\z") | not)) then "$.decision_ref: not a UUID" else empty end),
  (if has("conditions") and ((.conditions | type) != "array" or (.conditions | length) == 0
       or ([.conditions[] | type] | any(. != "string")) or ((.conditions | unique | length) != (.conditions | length)))
   then "$.conditions: must be a non-empty array of unique strings" else empty end),
  (if has("attested_content_sha256") then
     if (.attested_content_sha256 | type) != "array" or (.attested_content_sha256 | length) == 0 then "$.attested_content_sha256: must be a non-empty array"
     else
       ( .attested_content_sha256 | to_entries[] | . as $e | "$.attested_content_sha256[\($e.key)]" as $p
         | if ($e.value | type) != "object" then "\($p): expected an object"
           else ($e.value | keys_ok(["sha256","attested_on"]; $p)[]),
                (if ($e.value.sha256 | type) != "string" or ($e.value.sha256 | test("^[0-9a-f]{64}\\z") | not) then "\($p).sha256: bad value" else empty end),
                (if ($e.value.attested_on | date | not) then "\($p).attested_on: bad date" else empty end)
           end ),
       (if ([.attested_content_sha256[] | select(type == "object") | .sha256] | (unique | length) != length) then "$.attested_content_sha256: duplicate sha256" else empty end)
     end
   else empty end)
' "$ATT") || fail "attestation could not be evaluated"
if [ -n "$PROBLEMS" ]; then
  while IFS= read -r line; do echo "::error::registry-attestation-check: $line" >&2; done <<<"$PROBLEMS"
  exit 1
fi

jq -e --arg e "$ENTITY" '.publishing_entity == $e' "$ATT" >/dev/null || fail "publishing_entity differs from the expected entity"

if [ $# -eq 4 ]; then
  HASH=$(bash "$SCRIPT_DIR/registry-content-hash.sh" "$SERVER" "$4") || die "could not compute the content hash"
else
  HASH=$(bash "$SCRIPT_DIR/registry-content-hash.sh" "$SERVER") || die "could not compute the content hash"
fi

MATCH=$(jq -r --arg h "$HASH" '.attested_content_sha256[] | select(.sha256 == $h) | .attested_on' "$ATT")
[ -n "$MATCH" ] || fail "content hash ${HASH} is not a member of attested_content_sha256"
echo "registry-attestation-check: ok (matched entry ${HASH} attested_on ${MATCH})"
