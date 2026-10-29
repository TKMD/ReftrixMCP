#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# check-environments.sh
#
# Environment assertion for registry-sync (plan §4.8). Fails closed.
#
#   npm-publish  : deployment policies exactly [{v*, tag}],   one required reviewer = owner
#   mcp-registry : deployment policies exactly [{main, branch}], one required reviewer = owner
#
# Any answer other than HTTP 200, including 404, fails. A missing mcp-registry therefore
# stops the run before a job that would make GitHub auto-create it unprotected.
#
# Env  : GITHUB_REPOSITORY (owner/name), GITHUB_REPOSITORY_OWNER, GITHUB_API_URL (default
#        https://api.github.com), GITHUB_TOKEN (optional; set it only in the env: of the
#        step that runs this script), GITHUB_STEP_SUMMARY (optional).
# Token: sent through a curl config on stdin, never in argv, never printed. If the token
#        read answers 403 the call is repeated once without it (R5' fallback, removed
#        after the first public run measures token read = 200). 403 without a token, or
#        403 on the fallback, is a rate limit: category `network`, fail.
# Exit : 0 all assertions hold | 1 assertion failed (category on stderr) | 2 bad input.
# Categories: network (403 / 5xx / no answer) | environment-missing (404) | policy |
#             reviewer.
# =============================================================================
set -uo pipefail
set +x

die() { echo "ERROR: $*" >&2; exit 2; }

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done
REPO="${GITHUB_REPOSITORY:-}"
OWNER="${GITHUB_REPOSITORY_OWNER:-}"
API="${GITHUB_API_URL:-https://api.github.com}"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "bad GITHUB_REPOSITORY"
[[ "$OWNER" =~ ^[A-Za-z0-9-]+$ ]] || die "bad GITHUB_REPOSITORY_OWNER"
[[ "$API" =~ ^https://[A-Za-z0-9./:-]+$ ]] || die "bad GITHUB_API_URL"
TOKEN="${GITHUB_TOKEN:-}"
if [ -n "$TOKEN" ]; then
  [[ "$TOKEN" =~ ^[A-Za-z0-9_.-]+$ ]] || die "GITHUB_TOKEN has an unexpected format"
fi

WORK="$(mktemp -d)" || die "cannot create temp dir"
trap 'rm -rf "$WORK"' EXIT
FAILURES=0
SUMMARY=""

fail() { echo "FAIL [$1]: $2" >&2; FAILURES=$((FAILURES + 1)); }

# fetch <path> <outfile> -> prints "<category>" on failure, "ok" on 200
fetch() {
  local url="$API/$1" out="$2" code
  local -a base=(curl --silent --max-time 20 --proto '=https' -o "$out" -w '%{http_code}'
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28')
  code="000"
  if [ -n "$TOKEN" ]; then
    code="$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | "${base[@]}" -K - "$url")" || code="000"
    if [ "$code" = "403" ]; then
      code="$("${base[@]}" "$url")" || code="000"
    fi
  else
    code="$("${base[@]}" "$url")" || code="000"
  fi
  case "$code" in
    200) echo ok ;;
    404) echo environment-missing ;;
    *) echo network ;;
  esac
}

check_env() {
  local name="$1" want_name="$2" want_type="$3" cat
  cat="$(fetch "repos/$REPO/environments/$name" "$WORK/env.json")"
  if [ "$cat" != ok ]; then fail "$cat" "environment $name: no 200 answer"; return; fi
  cat="$(fetch "repos/$REPO/environments/$name/deployment-branch-policies" "$WORK/pol.json")"
  if [ "$cat" != ok ]; then fail "$cat" "environment $name policies: no 200 answer"; return; fi

  if ! jq -e --arg n "$want_name" --arg t "$want_type" \
    '[.branch_policies[]? | {name, type}] == [{name: $n, type: $t}]' "$WORK/pol.json" >/dev/null 2>&1; then
    fail policy "environment $name: deployment policies are not exactly [{$want_name, $want_type}]"
  fi
  if ! jq -e '.deployment_branch_policy == {protected_branches: false, custom_branch_policies: true}' \
    "$WORK/env.json" >/dev/null 2>&1; then
    fail policy "environment $name: deployment_branch_policy is not custom branch policies only"
  fi
  if ! jq -e '[.protection_rules[]?.type] | index("branch_policy") != null' \
    "$WORK/env.json" >/dev/null 2>&1; then
    fail policy "environment $name: no branch_policy protection rule"
  fi
  if ! jq -e --arg o "$OWNER" \
    '[.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]? | .reviewer.login] == [$o]' \
    "$WORK/env.json" >/dev/null 2>&1; then
    fail reviewer "environment $name: required reviewer is not exactly the repository owner"
  fi
  local bypass
  bypass="$(jq -r '.can_admins_bypass | if type == "boolean" then tostring else "unknown" end' "$WORK/env.json" 2>/dev/null || echo unknown)"
  SUMMARY="${SUMMARY}| $name | can_admins_bypass=$bypass |
"
}

check_env npm-publish 'v*' tag
check_env mcp-registry main branch

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Environment assertion"
    echo "| environment | note |"
    echo "| --- | --- |"
    printf '%s' "$SUMMARY"
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "Environment assertion failed ($FAILURES)" >&2
  exit 1
fi
echo "Environment assertion passed"
