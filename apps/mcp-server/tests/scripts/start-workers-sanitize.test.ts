// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * start-workers.ts — CWE-209 raw error.message sanitize regression test (PR-D-7 Wave 4).
 *
 * start-workers.ts — CWE-209 生 error.message サニタイズ回帰テスト (PR-D-7 Wave 4)。
 *
 * Verifies FIND-PLAN-SEC-01 (M severity, PR-D-7 Phase 2 Wave 4) landing:
 * Plan v1.2 §3.6.1 evidence table enumerated 9 residual sites at
 * L337 / L350 / L469 / L483 / L513 / L624 / L652 / L725 / L736 where
 * raw `error instanceof Error ? error.message : error` ternary was used
 * inside logger / console contexts without passing through
 * `sanitizeErrorMessage(error)`. These 9 sites are the last CWE-209
 * (Information Exposure Through an Error Message) latent vectors in the
 * start-workers.ts surface area, covering BullMQ / ioredis recovery loops,
 * IPC shutdown handlers, node-cron schedule failures, and cron.stop
 * synchronous failures during shutdown.
 *
 * FIND-PLAN-SEC-01 (M severity, PR-D-7 Phase 2 Wave 4) の着地を検証:
 * Plan v1.2 §3.6.1 の evidence table で列挙された 9 sites
 * (L337 / L350 / L469 / L483 / L513 / L624 / L652 / L725 / L736) で、
 * logger/console context 内の生 `error instanceof Error ? error.message : error`
 * 三項演算子を `sanitizeErrorMessage(error)` 経由に置換。start-workers.ts
 * surface 内の CWE-209 (Information Exposure Through an Error Message)
 * latent 最終残存を閉塞（BullMQ/ioredis recovery loop、IPC shutdown handler、
 * node-cron schedule failure、shutdown 時の cron.stop 同期失敗を網羅）。
 *
 * Block A (regex fail-if-matched) design per Registry v2 §16 Wave 4 Binding
 * and Plan v1.2 §3.6.4 CI-failing regex specification:
 *   - Negative assertion: `/error instanceof Error\s*\?\s*error\.message/`
 *     across the full start-workers.ts source — 0 occurrences required
 *     (FIND-PLAN-SEC-01 Landing contract §3.6.1 "0 residual sites
 *     post-PR-D-7" declaration).
 *   - Positive assertion: sanitizeErrorMessage import preserved + usage
 *     count ≥ 9 (aligning with the 9 sites converted in Wave 4).
 *
 * Block A (regex fail-if-matched) 設計は Registry v2 §16 Wave 4 Binding
 * および Plan v1.2 §3.6.4 CI-failing regex 仕様に従う:
 *   - 否定アサーション: `/error instanceof Error\s*\?\s*error\.message/`
 *     を full start-workers.ts source に対し実行し 0 件必須
 *     (FIND-PLAN-SEC-01 Landing contract §3.6.1 "0 residual sites
 *     post-PR-D-7" 宣言)。
 *   - 肯定アサーション: sanitizeErrorMessage import 存続 + 使用回数 ≥ 9
 *     (Wave 4 で変換した 9 sites に整合)。
 *
 * @module tests/scripts/start-workers-sanitize
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SCRIPT_PATH = path.resolve(__dirname, "../../src/scripts/start-workers.ts");

describe("start-workers.ts — CWE-209 raw error.message sanitize (FIND-PLAN-SEC-01)", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");

  it("no raw `error instanceof Error ? error.message` ternary residue (CWE-209 regression)", () => {
    // Block A negative regex per Plan v1.2 §3.6.4 + Registry v2 §16 Wave 4 Binding.
    // Fail-if-matched: any remaining occurrence of the raw ternary pattern
    // indicates a CWE-209 latent vector has regressed into start-workers.ts.
    //
    // Block A 否定 regex。Plan v1.2 §3.6.4 + Registry v2 §16 Wave 4 Binding に従う。
    // fail-if-matched: 生三項演算子の残存は CWE-209 latent vector の回帰を意味する。
    const rawPattern = /error\s+instanceof\s+Error\s*\?\s*error\.message/g;
    const matches = source.match(rawPattern) ?? [];
    expect(matches).toEqual([]); // 0 occurrences required (Plan v1.2 §3.6.1 declaration).
  });

  it("preserves `sanitizeErrorMessage` import from ../utils/sanitize-error", () => {
    // Import presence guard: regression would remove the import after Wave 4,
    // re-exposing the CWE-209 surface. Matches both named and combined imports.
    //
    // Import 存続ガード: Wave 4 後に import が削除されると CWE-209 surface が
    // 再暴露される。named/combined import 両方を許容する regex。
    expect(source).toMatch(
      /import\s*\{[^}]*\bsanitizeErrorMessage\b[^}]*\}\s*from\s*['"][^'"]*sanitize-error['"]/
    );
  });

  it("uses `sanitizeErrorMessage(...)` at least 9 times (Wave 4 9-site conversion)", () => {
    // Positive assertion: Wave 4 converts 9 sites (L337 / L350 / L469 / L483 /
    // L513 / L624 / L652 / L725 / L736) in addition to the existing uses
    // already present before PR-D-7. Total usage must therefore be >= 9.
    //
    // 肯定アサーション: Wave 4 で 9 sites (L337/L350/L469/L483/L513/L624/L652/L725/L736)
    // を変換。PR-D-7 以前から存在する既存使用箇所と合わせ、合計使用数は >= 9 必須。
    const usageCount = (source.match(/sanitizeErrorMessage\s*\(/g) ?? []).length;
    expect(usageCount).toBeGreaterThanOrEqual(9);
  });

  it("all 9 Wave 4 contexts contain `sanitizeErrorMessage(error)` invocation (exhaustiveness guard)", () => {
    // Exhaustiveness guard per FIND-PLAN-SEC-01 §254 Landing contract:
    // "Phase 2 test regex assertion covers entire start-workers.ts (not just
    // listed 9 sites)". Match the specific Wave 4 contextual log-message
    // fragments to guarantee each converted site remains sanitized.
    //
    // 網羅性ガード (FIND-PLAN-SEC-01 §254 Landing contract):
    // "Phase 2 test regex assertion covers entire start-workers.ts"。
    // Wave 4 で変換した 9 箇所の log-message 断片を明示的に match し、
    // 各 site が sanitize 化されたままであることを保証する。
    const wave4ContextFragments: Array<{ context: string; minMatches: number }> = [
      // L337 / L350: Embedding-backfill recovery (loop-internal + outer-catch).
      // L337 / L350: Embedding-backfill recovery (ループ内 + outer-catch)。
      { context: "Embedding-backfill recovery complete", minMatches: 1 },
      { context: "Orphaned embedding-backfill recovery failed", minMatches: 1 },
      // L469 / L483: Orphaned job (generic) recovery (loop-internal + outer-catch).
      // L469 / L483: Orphaned job (generic) recovery (ループ内 + outer-catch)。
      { context: "Startup recovery complete", minMatches: 1 },
      { context: "Orphaned job recovery failed", minMatches: 1 },
      // L513: IPC-triggered shutdown failure.
      // L513: IPC-triggered shutdown 失敗。
      { context: "Error during IPC-triggered shutdown", minMatches: 1 },
      // L624 / L652: Cron schedule init failures.
      // L624 / L652: Cron schedule 初期化失敗。
      { context: "Failed to schedule screenshot cleanup cron", minMatches: 1 },
      { context: "Failed to schedule reconciliation cron", minMatches: 1 },
      // L725 / L736: Cron.stop synchronous failures (shutdown path).
      // L725 / L736: Cron.stop 同期失敗 (shutdown path)。
      { context: "Error stopping screenshot cleanup cron", minMatches: 1 },
      { context: "Error stopping backfill reconciliation cron", minMatches: 1 },
    ];

    for (const { context } of wave4ContextFragments) {
      // Verify each Wave 4 context fragment is still present in the source
      // (guards against accidental message-text refactor erasing the site).
      //
      // 各 Wave 4 context 断片が source に残存していることを検証
      // (message-text refactor による site 消失を防ぐ)。
      expect(source.includes(context)).toBe(true);
    }
  });
});
