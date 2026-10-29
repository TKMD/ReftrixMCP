#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# registry-fields-check.sh <server.json> <publishing_entity> [<deprecation_message>]
#
# Condition 1 of the Registry sync: everything in server.json is publishable information.
# The key allowlist is the deterministic part; the value patterns are known-pattern detection.
#
#   top level      $schema name description repository version packages
#   repository     url source
#   packages[]     registryType identifier version transport environmentVariables
#   transport      type
#   environmentVariables[]  name description isRequired format isSecret   (no value / default / _meta)
#
# Value rules over every string (case-insensitive except tokens): no e-mail, no absolute
# local path (/home/, /Users/, C:\), no file:/ URL, no URL credentials, no PEM header, no
# token prefix (ghp_, AKIA, xox). description <= 100 chars; repository.url equals the constant;
# name equals io.github.<publishing_entity>/<slug> (same shape as V30); known keys have leaf types.
# The optional deprecation message must be 1..500 characters and passes the same value rules.
# Offending keys are named by path; their values are never echoed.
# Exit: 0 publishable | 1 violation | 2 bad input or tool.
# =============================================================================
set -euo pipefail

EXPECTED_REPOSITORY_URL="https://github.com/TKMD/ReftrixMCP"
DESCRIPTION_MAX=100
DEPRECATION_MESSAGE_MAX=500

die() { echo "ERROR: $*" >&2; exit 2; }

[ $# -ge 2 ] && [ $# -le 3 ] || die "usage: $0 <server.json> <publishing_entity> [<deprecation_message>]"
FILE="$1"
ENTITY="$2"
[ -f "$FILE" ] || die "server.json not found"
[[ "$ENTITY" =~ ^[A-Za-z0-9-]+$ ]] || die "bad publishing_entity"
command -v jq >/dev/null 2>&1 || die "required tool not found: jq"
jq -s -e 'length == 1 and (.[0] | type) == "object"' "$FILE" >/dev/null 2>&1 || die "server.json is not one JSON object"

VIOLATIONS=$(mktemp) || die "mktemp failed"
trap 'rm -f "$VIOLATIONS"' EXIT

# shared value rules: input is an array of {p: <path>, v: <string>}; prints "<path>: <rule>"
# shellcheck disable=SC2016 # jq program text, not shell expansion
VALUE_RULES='
  def rules: [
    ["e-mail address", "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+", "i"],
    ["absolute local path", "/home/|/Users/|[A-Za-z]:\\\\", "i"],
    ["file:// URL", "file:/", "i"],
    ["credentials in a URL", "://[^/\\s@]+@", "i"],
    ["PEM header", "-----BEGIN", "i"],
    ["token prefix", "ghp_|AKIA|xox", ""]
  ];
  .[] | . as $s | rules[] | . as $r | select($s.v | test($r[1]; $r[2])) | "\($s.p): \($r[0])"
'

# a jq evaluation error is a failure of the check (exit 1), never a pass
{
jq -r '
  def chk($o; $allowed; $p):
    if ($o | type) == "object" then (($o | keys) - $allowed | map($p + "." + . + ": key not in allowlist"))
    else [$p + ": expected an object"] end;
  def arr($a; $p): if ($a | type) == "array" then [] else [$p + ": expected an array"] end;
  def ty($o; $spec; $p):
    if ($o | type) != "object" then []
    else [ $spec | to_entries[] | . as $s | select($o | has($s.key))
           | select(($o[$s.key] | type) != $s.value) | "\($p).\($s.key): type" ] end;
  def S: "string";
  ty(.; {"$schema":S,name:S,description:S,version:S,repository:"object",packages:"array"}; "$")
  + ty(.repository; {url:S,source:S}; "$.repository")
  + chk(.; ["$schema","name","description","repository","version","packages"]; "$")
  + chk(.repository; ["url","source"]; "$.repository")
  + arr(.packages; "$.packages")
  + (if (.packages | type) == "array" then
      [ .packages | to_entries[] | . as $e | "$.packages[\($e.key)]" as $p
        | chk($e.value; ["registryType","identifier","version","transport","environmentVariables"]; $p)
        + ty($e.value; {registryType:S,identifier:S,version:S,transport:"object",environmentVariables:"array"}; $p)
        + ty($e.value.transport; {type:S}; $p + ".transport")
        + (if ($e.value | type) != "object" then []
           else
             (if $e.value.transport == null then [] else chk($e.value.transport; ["type"]; $p + ".transport") end)
             + arr($e.value.environmentVariables // []; $p + ".environmentVariables")
             + (if (($e.value.environmentVariables // []) | type) == "array" then
                 [ ($e.value.environmentVariables // []) | to_entries[]
                   | chk(.value; ["name","description","isRequired","format","isSecret"];
                         "\($p).environmentVariables[\(.key)]")
                     + ty(.value; {name:S,description:S,format:S,isRequired:"boolean",isSecret:"boolean"};
                          "\($p).environmentVariables[\(.key)]") ] | add // []
               else [] end)
           end)
      ] | add // []
    else [] end)
  | .[]' "$FILE" &&
jq -r "[ paths(type == \"string\") as \$p | {p: (\$p | map(tostring) | join(\".\")), v: getpath(\$p)} ] | $VALUE_RULES" \
  "$FILE" &&
jq -r --arg url "$EXPECTED_REPOSITORY_URL" --arg entity "$ENTITY" --argjson max "$DESCRIPTION_MAX" '
  (if (.description | type) == "string" and (.description | length) >= 1 and (.description | length) <= $max
   then empty else "$.description: must be 1.." + ($max | tostring) + " characters" end),
  (if (.repository | type) == "object" and .repository.url == $url then empty
   else "$.repository.url: differs from the expected repository" end),
  (if (.name | type) == "string" and (.name | test("^io\\.github\\." + $entity + "/[a-z0-9-]+\\z"))
   then empty else "$.name: must be io.github." + $entity + "/<slug>" end),
  (if (.packages | type) == "array" and (.packages | length) >= 1 then empty else "$.packages: must not be empty" end),
  (if (.packages | type) == "array" then
     .packages | to_entries[] | .key as $i
     | (if (.value | type) == "object" then (.value.environmentVariables // []) else [] end)
     | if type == "array" then to_entries[]
         | select((.value | type) == "object" and .value.isSecret == true and (.value | has("value") or has("default")))
         | "$.packages[\($i)].environmentVariables[\(.key)]: secret entry carries a value"
       else empty end
   else empty end)' "$FILE"
} >>"$VIOLATIONS" || {
  echo "::error::registry-fields-check: server.json could not be evaluated" >&2
  exit 1
}

if [ $# -eq 3 ]; then
  MSG="$3"
  if [ -z "$MSG" ] || [ "${#MSG}" -gt "$DEPRECATION_MESSAGE_MAX" ]; then
    echo "deprecation message: must be 1..${DEPRECATION_MESSAGE_MAX} characters" >>"$VIOLATIONS"
  fi
  jq -n -r --arg m "$MSG" "[{p: \"deprecation message\", v: \$m}] | $VALUE_RULES" >>"$VIOLATIONS"
fi

if [ -s "$VIOLATIONS" ]; then
  while IFS= read -r line; do
    echo "::error::registry-fields-check: $line" >&2
  done <"$VIOLATIONS"
  exit 1
fi
echo "registry-fields-check: ok"
