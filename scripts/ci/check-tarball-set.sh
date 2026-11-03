#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# INV-INFRA-PUBLISH-LAUNCH-JOB-ISOLATION-001 (R2-b). The tarballs in <dir> must be exactly the set the
# `verify` job produced: CHECKSUMS is its `sha256sum ./*.tgz` output, handed over as a job output (not the
# checksums.txt inside the artifact, which a compromised job could rewrite). An extra tarball, a missing one
# or a changed one fails. Usage: CHECKSUMS=... check-tarball-set.sh <dir>
set -euo pipefail

DIR="${1:?usage: check-tarball-set.sh <dir>}"
: "${CHECKSUMS:?CHECKSUMS (needs.verify.outputs.checksums) is empty or unset}"

expected="$(printf '%s\n' "$CHECKSUMS" | sed '/^[[:space:]]*$/d' | sort)"
[ -n "$expected" ] || { echo "::error::the verified checksums are empty"; exit 1; }
actual="$(cd "$DIR" && sha256sum ./*.tgz | sort)" || { echo "::error::no tarball in $DIR"; exit 1; }

if [ "$actual" != "$expected" ]; then
  echo "::error::the tarballs in $DIR are not the set the verify job produced"
  diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") || true
  exit 1
fi
echo "tarball set matches the verify job output ($(printf '%s\n' "$expected" | wc -l) tarballs)"
