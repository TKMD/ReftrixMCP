#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# publish-targets.sh — single source of truth (SSOT) for the 5 OSS-publishable
# packages and their Tier (dependency) order.
# =============================================================================
#
# Sourced (NOT executed) by 4 call-sites across 3 files:
#   - scripts/sync-oss.sh             (1 source call)
#   - scripts/prepare-oss.sh          (1 source call, reused by Step 3.6.1's
#                                       publish-prep jq clause AND Phase 4's
#                                       V6.1 / V6.2 / V34 / V35 checks — a
#                                       single bash process needs only 1 source)
#   - .github/workflows/publish.yml   (2 source calls — the `verify` job and
#                                       the `publish` job are separate GitHub
#                                       Actions runners/processes, so each must
#                                       independently source this file once, at
#                                       the top of its own combined `run:` step)
#
# Directory-only entries; callers append "/package.json" where that format is
# needed (prepare-oss.sh's publish-prep loop / V6.1 / V6.2 targets).
#
# packages/config is dev-only and intentionally excluded — it is never
# published to npm (see .claude/specs/plans/npm-publish-automation-plan-v0.md
# §3 Decision 5 for the full design rationale).
#
# =============================================================================

# Guard: this file declares bash arrays only and has no side effects of its
# own; it exists to be `source`d into a caller's shell, never executed
# directly. Executing it directly is a no-op that prints this guard message.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "publish-targets.sh must be sourced, not executed: source ${BASH_SOURCE[0]}" >&2
  exit 1
fi

# 公開順序（依存グラフのトポロジカル順）/ Publish order (topological dependency order)
PUBLISH_TIER1=("packages/core" "packages/database" "packages/ml")
PUBLISH_TIER2=("packages/webdesign-core")
PUBLISH_TIER3=("apps/mcp-server")
PUBLISH_PACKAGES=("${PUBLISH_TIER1[@]}" "${PUBLISH_TIER2[@]}" "${PUBLISH_TIER3[@]}")

# Shared helpers for the callers above (preflight, sync-oss.sh).
# A publish package dir is packages/<x> or apps/<x>; anything else stops the caller.
publish_package_path_ok() { [[ "$1" =~ ^(packages|apps)/[a-z0-9-]+$ ]]; }
# The database client output the build recreates (prisma generate); the preflight ignores it.
# shellcheck disable=SC2034 # read by the scripts that source this file
PUBLISH_DATABASE_GENERATED="packages/database/src/generated"
# Exit 42 means the same in both callers: the clone is not publishable as it stands (the
# preflight's clone_dirty, and sync-oss.sh step 6 when a package, its parent or its dist is a
# symlink, which the preflight also rejects as clone_dirty).
