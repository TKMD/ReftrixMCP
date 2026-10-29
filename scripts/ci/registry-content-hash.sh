#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# registry-content-hash.sh <server.json> [<deprecation_message>]
#
# Prints the content hash that the Registry sync attestation covers (64 lowercase hex).
# One JSON object is built from
#   name, description, repository.url,
#   each environment variable's name and description (all packages, sorted by name),
#   the deprecation message (empty string when none is given),
# canonicalised with `jq -S -c` (no trailing newline), then hashed with sha256.
# Version fields and every other field are excluded.
# Exit: 0 hash printed | 2 bad input or tool.
# =============================================================================
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 2; }

[ $# -ge 1 ] && [ $# -le 2 ] || die "usage: $0 <server.json> [<deprecation_message>]"
FILE="$1"
MSG="${2-}"
[ -f "$FILE" ] || die "server.json not found"
command -v jq >/dev/null 2>&1 || die "required tool not found: jq"
command -v sha256sum >/dev/null 2>&1 || die "required tool not found: sha256sum"

# every hashed field must be present with its type; a missing field must not hash as null
jq -s -e '
  length == 1 and (.[0] | type) == "object"
  and (.[0].name | type) == "string"
  and (.[0].description | type) == "string"
  and (.[0].repository | type) == "object" and (.[0].repository.url | type) == "string"
  and ((.[0].packages // []) | type) == "array"
  and ([ (.[0].packages // [])[] | (.environmentVariables // []) | if type == "array" then .[] else null end
         | select((type) != "object" or (.name | type) != "string" or (.description | type) != "string") ] | length) == 0
' "$FILE" >/dev/null 2>&1 || die "server.json lacks a hashed field or has one of the wrong type"

CANONICAL=$(jq -S -c --arg m "$MSG" '{
  name,
  description,
  repository_url: .repository.url,
  environment_variables: ([ (.packages // [])[] | (.environmentVariables // [])[] | {name, description} ] | sort_by(.name)),
  deprecation_message: $m
}' "$FILE") || die "could not build the hash input"

printf '%s' "$CANONICAL" | sha256sum | cut -d' ' -f1
