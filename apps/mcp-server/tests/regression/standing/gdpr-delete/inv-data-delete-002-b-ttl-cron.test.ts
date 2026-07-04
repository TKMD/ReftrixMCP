// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-DATA-DELETE-002-B
 * (Screenshot TTL cron removal — `screenshot_ttl_cleanup` non-emit guard)
 *
 * INV-DATA-DELETE-002-B (revised, ADR-0041 §Invariants (1)): the Screenshot
 *   TTL cron has been structurally removed (PR-SS-B). The
 *   `screenshot_ttl_cleanup` audit_logs action is therefore **no longer
 *   emitted from any production source file** — a forward-compat guard that
 *   prevents the TTL deletion path from being silently re-introduced.
 *
 * INV-DATA-DELETE-002-B (改訂、ADR-0041 §Invariants (1)): Screenshot TTL cron
 *   は PR-SS-B で構造的に撤去された。よって `screenshot_ttl_cleanup` action は
 *   **production src のいずれからも emit されない** ことを assert する
 *   forward-compat guard。TTL 削除経路の暗黙的再導入を防ぐ。
 *
 * 背景 / Background: 旧 002-B は `cleanupExpired()` の「削除件数 > 0 のみ audit
 *   書込」契約 (CWE-778 audit-flood 防御) を検証していた。PR-SS-B で
 *   `cleanupExpired` orchestrator + cron module + その audit emit を撤去した
 *   ため、契約は「`screenshot_ttl_cleanup` literal は production src に
 *   1 occurrence も存在しない」negative assert へ縮退する (ADR-0041 §Invariants
 *   (1) の正式決定、`.skip` 不使用)。歴史的 audit_logs 行の有効性は不変
 *   (DATA_RETENTION §9.6 で文書化)。
 *
 * Background: the old 002-B verified the `cleanupExpired()` "audit only when
 *   deletedCount > 0" contract (CWE-778 audit-flood defense). PR-SS-B removed
 *   the `cleanupExpired` orchestrator + cron module + its audit emit, so the
 *   contract shrinks to a negative assert that the `screenshot_ttl_cleanup`
 *   literal has 0 occurrences in production src (formally decided in ADR-0041
 *   §Invariants (1); never `.skip`). Historical audit_logs rows remain valid
 *   (documented in DATA_RETENTION §9.6).
 *
 * Ownership note (Registry FIND-SSB-PLAN-L-06): the `screenshot_ttl_cleanup`
 *   non-emit negative sweep (assertion #5 of INV-SCREENSHOT-RETENTION-001) is
 *   **single-owned by this file**. The new INV
 *   (inv-screenshot-retention-001.test.ts) carries a cross-ref comment only and
 *   does NOT duplicate the sweep here.
 *
 * @see  §Invariants (1)
 * @see apps/mcp-server/tests/regression/standing/gdpr-delete/inv-screenshot-retention-001.test.ts (assertion #5 cross-ref)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

const SCREENSHOT_TTL_CLEANUP_LITERAL = "screenshot_ttl_cleanup";

describe("INV-DATA-DELETE-002-B: Screenshot TTL cron removed (screenshot_ttl_cleanup non-emit guard)", () => {
  // ==========================================================================
  // Assertion #5 (single-owned here per L-06): screenshot_ttl_cleanup must have
  // 0 occurrences across the entire production src tree.
  // ==========================================================================
  it("INV-DATA-DELETE-002-B: screenshot_ttl_cleanup is no longer emitted from production src", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-DATA-DELETE-002-B");

    const srcRoot = path.resolve(__dirname, "../../../../src");
    const hits = grepSrc(srcRoot, SCREENSHOT_TTL_CLEANUP_LITERAL);

    expect(
      hits,
      `[INV-DATA-DELETE-002-B] '${SCREENSHOT_TTL_CLEANUP_LITERAL}' must have 0 occurrences in ` +
        `production src (TTL cron is structurally removed by PR-SS-B). Found in: ${hits.join(", ")}`
    ).toHaveLength(0);
  });

  // ==========================================================================
  // Anti-vacuity sanity: the sweep machinery can actually detect a literal —
  // proves the negative assert above is not trivially passing on a broken sweep.
  // ==========================================================================
  it("INV-DATA-DELETE-002-B: source-sweep machinery detects a known literal (anti-vacuity)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-DATA-DELETE-002-B");

    const srcRoot = path.resolve(__dirname, "../../../../src");
    // `data.delete` is a literal that MUST exist in production src
    // (gdpr-deletion.service.ts / data.tool.ts). If the sweep cannot find it,
    // the negative assert above would be vacuously green.
    const sentinelHits = grepSrc(srcRoot, "data.delete");
    expect(
      sentinelHits.length,
      "source-sweep must be able to find the 'data.delete' literal — a 0 result here means " +
        "the sweep is broken and the negative assert is vacuous"
    ).toBeGreaterThan(0);
  });

  // ==========================================================================
  // Structural: the cron module and the cleanupExpired orchestrator are gone.
  // ==========================================================================
  it("INV-DATA-DELETE-002-B: screenshot-cleanup-cron module and cleanupExpired orchestrator are removed", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-DATA-DELETE-002-B");

    const srcRoot = path.resolve(__dirname, "../../../../src");

    expect(
      fs.existsSync(path.join(srcRoot, "cron", "screenshot-cleanup-cron.ts")),
      "src/cron/screenshot-cleanup-cron.ts must be deleted"
    ).toBe(false);

    const serviceContent = fs.readFileSync(
      path.join(srcRoot, "services", "screenshot-persistence.service.ts"),
      "utf8"
    );
    expect(
      serviceContent.includes("cleanupExpired"),
      "screenshot-persistence.service.ts must not contain cleanupExpired (TTL orchestrator removed)"
    ).toBe(false);
  });
});

// ============================================================================
// Source-sweep helper (scope-limited, no node_modules / dist)
// ============================================================================

/** Recursively list `*.ts` files under `dir`, skipping `*.d.ts`. */
function listSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSrcFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Return the list of src files (relative to `srcRoot`) containing `needle`. */
function grepSrc(srcRoot: string, needle: string): string[] {
  const hits: string[] = [];
  for (const file of listSrcFiles(srcRoot)) {
    if (fs.readFileSync(file, "utf8").includes(needle)) {
      hits.push(path.relative(srcRoot, file));
    }
  }
  return hits;
}
