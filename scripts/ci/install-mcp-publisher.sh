#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# =============================================================================
# install-mcp-publisher.sh [pin_file]
#
# Installs the pinned mcp-publisher CLI (registry-sync plan §8.2).
#
# 1. Reads scripts/ci/mcp-publisher.pin (or [pin_file]) with grep; never sources it.
# 2. Downloads the fixed release URL (explicit version in the path) into a fresh
#    directory under $RUNNER_TEMP.
# 3. `sha256sum -c` against the literal in the pin file. No checksums file is fetched.
# 4. Extracts only the `mcp-publisher` member, under $RUNNER_TEMP, never the work tree.
# 5. Prints the binary path; appends its directory to $GITHUB_PATH when that is set.
#
# The binary is not run here. Exit: 0 installed | 1 download / hash / extract failure |
# 2 bad input (pin file, RUNNER_TEMP, missing tool).
# =============================================================================
set -uo pipefail
set +x

die() { echo "ERROR: $*" >&2; exit 2; }
fail() { echo "ERROR: $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ $# -le 1 ] || die "usage: $0 [pin_file]"
PIN_FILE="${1:-$SCRIPT_DIR/mcp-publisher.pin}"
[ -f "$PIN_FILE" ] || die "pin file not found"
for tool in curl tar sha256sum grep mktemp; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done

pin_value() { grep -E "^$1=" "$PIN_FILE" | head -n 1 | cut -d= -f2-; }
VERSION="$(pin_value MCP_PUBLISHER_VERSION)"
URL="$(pin_value MCP_PUBLISHER_URL)"
SHA="$(pin_value MCP_PUBLISHER_SHA256)"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bad MCP_PUBLISHER_VERSION in pin file"
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || die "bad MCP_PUBLISHER_SHA256 in pin file"
EXPECTED_URL="https://github.com/modelcontextprotocol/registry/releases/download/${VERSION}/mcp-publisher_linux_amd64.tar.gz"
[ "$URL" = "$EXPECTED_URL" ] || die "MCP_PUBLISHER_URL does not match the fixed release URL for ${VERSION}"

[[ "${RUNNER_TEMP:-}" == /* ]] || die "RUNNER_TEMP must be an absolute path"
[ -d "$RUNNER_TEMP" ] || die "RUNNER_TEMP is not a directory"
RT_REAL="$(cd "$RUNNER_TEMP" && pwd -P)"
case "$RT_REAL/" in
  "$(pwd -P)"/*) die "RUNNER_TEMP must be outside the work tree" ;;
esac

WORK="$(mktemp -d "$RT_REAL/mcp-publisher.XXXXXX")" || die "cannot create temp dir"
TARBALL="$WORK/mcp-publisher_linux_amd64.tar.gz"
BIN_DIR="$WORK/bin"
mkdir -p "$BIN_DIR" || die "cannot create bin dir"

curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-time 120 -o "$TARBALL" "$URL" || fail "download failed"

printf '%s  %s\n' "$SHA" "$TARBALL" | sha256sum -c - >/dev/null 2>&1 \
  || fail "tarball sha256 does not match the pin file"

tar -xzf "$TARBALL" -C "$BIN_DIR" --no-same-owner mcp-publisher \
  || fail "extraction of the mcp-publisher member failed"
[ -f "$BIN_DIR/mcp-publisher" ] || fail "mcp-publisher member missing after extraction"
chmod 0755 "$BIN_DIR/mcp-publisher"

echo "$BIN_DIR/mcp-publisher"
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$BIN_DIR" >> "$GITHUB_PATH"
fi
