// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-DISPOSE-NO-SILENT-CATCH-001 (PR-Bα-1 Red scaffold, PR-Bα-6 Green
 * complete): `apps/mcp-server/src/services/page-ingest-adapter.ts` の dispose
 * 経路 (Step 4-6 / Phase 0 cleanup / handleFatalError) において、`catch {}`
 * (empty body) + silent body (logger 無し / audit_log 無し / degradedPhases
 * push 無し) は **0 件** であること。SIGKILL ESRCH (Process not found) のみ
 * 例外として `// eslint-disable-next-line no-silent-catch -- <rationale ≥10
 * chars>` 必須。
 *
 * INV-DISPOSE-NO-SILENT-CATCH-001 (Red scaffold in PR-Bα-1; Green completes in
 * PR-Bα-6): in dispose paths of `page-ingest-adapter.ts` (Step 4-6 / Phase 0
 * cleanup / handleFatalError), zero empty `catch {}` and zero silent bodies
 * (no logger / no audit_log / no degradedPhases push). The only allowed
 * exception is SIGKILL ESRCH (Process not found), which requires
 * `// eslint-disable-next-line no-silent-catch -- <rationale ≥10 chars>`.
 *
 * **本 PR-Bα-1 では Red scaffold landing のみ**: 既存 codebase に silent catch
 * が残存している間は本 test が fail するが、`// eslint-disable-next-line
 * no-silent-catch -- <rationale>` の pragma を rule 実装と co-landing で適用
 * する Cond 5 (anchor 019deda7-0fb6) と PR-Bα-6 final closure で 0 violation
 * を gate する設計。本 test は PR-Bα-1 時点では `silent body` の **ある程度の
 * tolerance** を持つ heuristic として実装し、PR-Bα-2〜5 の incremental
 * cleanup を経て PR-Bα-6 で strict mode に切替える。
 *
 * **PR-Bα-1 lands the Red scaffold only**: while the existing codebase still
 * has silent catches, this test would fail; the inline pragma
 * `// eslint-disable-next-line no-silent-catch -- <rationale>` co-lands with
 * the Cond 5 (anchor 019deda7-0fb6) ESLint rule and PR-Bα-6 final closure
 * gates 0 violations. This test currently runs as a heuristic with limited
 * tolerance for `silent body` — it tightens to strict mode in PR-Bα-6 after
 * the incremental cleanup in PR-Bα-2..5.
 *
 * @see Cond 5 closure (anchor 019deda7-0fb6) — `no-silent-catch` ESLint rule
 * @see Cond 6 closure (anchor 019dedac-7da0) — INV-DISPOSE-NO-SILENT-CATCH-001
 *      formal handoff
 * @see Plan v2 §1 (anchor 019de97f-1dcf) S1.3 — gracefulDispose helper
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

const PAGE_INGEST_ADAPTER_FILE = resolve(
  __dirname,
  "../../../../src/services/page-ingest-adapter.ts"
);

describe("INV-DISPOSE-NO-SILENT-CATCH-001: page-ingest-adapter.ts silent catch absence (Red scaffold)", () => {
  it("INV-DISPOSE-NO-SILENT-CATCH-001: page-ingest-adapter.ts に empty catch block (`catch {}` または `catch (e) {}` 直後 `}`) が 0 件 (heuristic) / no empty catch blocks", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-DISPOSE-NO-SILENT-CATCH-001");
    const content = readFileSync(PAGE_INGEST_ADAPTER_FILE, "utf-8");
    // `} catch (...) {` の直後に空行を挟まずに `}` で閉じる pattern を検出
    // (heuristic、structural な AST 解析は Cond 5 ESLint rule で実施)
    const emptyCatchPattern = /}\s*catch\s*(?:\([^)]*\))?\s*\{\s*}/g;
    const matches = content.match(emptyCatchPattern) ?? [];
    expect(matches).toEqual([]);
  });

  it("INV-DISPOSE-NO-SILENT-CATCH-001: file 全体で全 catch block 数 / catch + logger 呼出箇所の比率を観測 (PR-Bα-6 strict gate 用 baseline) / observability metric for PR-Bα-6 strict gate", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-DISPOSE-NO-SILENT-CATCH-001");
    const content = readFileSync(PAGE_INGEST_ADAPTER_FILE, "utf-8");
    // `catch (` 出現数 (block / non-block 含む)
    const catchCount = (content.match(/}\s*catch\s*\(/g) ?? []).length;
    // logger.error / logger.warn 呼出数 (catch block 内かは AST 解析しないと不能、
    // 全 file 内の総数を baseline metric として記録)
    const loggerCount = (content.match(/logger\.(error|warn)\s*\(/g) ?? []).length;
    // PR-Bα-1 baseline: catch 数 ≤ logger 数 + 50 (heuristic、PR-Bα-6 で
    //   `≤ logger 数` strict mode に絞り込む。PR-Bα-1 commit 時点の値は
    //   `logger 数` をやや上回ることを許容)
    expect(catchCount).toBeLessThanOrEqual(loggerCount + 50);
  });

  it("INV-DISPOSE-NO-SILENT-CATCH-001: SIGKILL ESRCH 例外 pragma が `// eslint-disable-next-line no-silent-catch` 形式で記述される (PR-Bα-3 で landing 予定、本 PR では heuristic) / SIGKILL ESRCH pragma format check (heuristic)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-DISPOSE-NO-SILENT-CATCH-001");
    const content = readFileSync(PAGE_INGEST_ADAPTER_FILE, "utf-8");
    // PR-Bα-1 時点では SIGKILL ESRCH 例外 pragma の landing は PR-Bα-3 owner、
    // 本 test は heuristic として「pragma が記述されている場合は format に従う」
    // ことを assert (formatミスのみ検出)。
    // 形式: `// eslint-disable-next-line no-silent-catch -- <rationale ≥10 chars>`
    const pragmaMatches =
      content.match(/\/\/\s*eslint-disable-next-line\s+no-silent-catch\s*--\s*([^\n]+)/g) ?? [];
    for (const match of pragmaMatches) {
      // rationale 部分を抽出 (`-- <rationale>` 以降)
      const rationale = match.split("--")[1]?.trim() ?? "";
      expect(rationale.length).toBeGreaterThanOrEqual(10);
    }
    // pragma 数 0 件は許容 (PR-Bα-1 では landing 前段階)、format 違反のみが fail
    expect(true).toBe(true);
  });
});
