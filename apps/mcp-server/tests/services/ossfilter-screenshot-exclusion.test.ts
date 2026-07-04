// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `.ossfilter` screenshot exclusion rules assert (PR-SS-A / H-2 / D-6)
 *
 * 第三者サイトの screenshot (PII / 著作物) が OSS sync (rsync) に混入しないことを
 * 保証する `.ossfilter` ルールの存在を assert する。D-1 により default root は
 * repo 外 (XDG data dir) のため構造的に sync 対象外だが、operator が
 * `REFTRIX_SCREENSHOT_ROOT` を repo 内に向けた場合の事故経路を塞ぐ
 * defense-in-depth (H-2 第二防御)。
 *
 * Asserts the `.ossfilter` rules that keep third-party-site screenshots
 * (PII / copyrighted works) out of the OSS sync. With D-1 the default root
 * lives outside the repo (XDG data dir = structural primary defense); these
 * rules are defense-in-depth against an operator pointing
 * `REFTRIX_SCREENSHOT_ROOT` inside the repo (H-2 secondary defense).
 *
 * 追加 assert / Additional asserts:
 * - UB-9 (e): ADR-0041 §配布形態別信号への能動参照警告コメント
 * - L-09: atomic-rename 残骸 (`*.tmp`) が既存ルールで二重に救われる旨のコメント
 *
 * Cross-ref: Plan v1 §3 D-6 / §5.2, Finding Registry FIND-SSPLAN-M-11 (UB-9 (e)) /
 * FIND-SSPLAN-L-09.
 *
 * @module tests/services/ossfilter-screenshot-exclusion.test
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/** repo root の `.ossfilter`（tests/services/ から 4 階層上 / four levels up） */
const OSSFILTER_PATH = path.resolve(__dirname, "../../../../.ossfilter");

describe(".ossfilter screenshot exclusion (PR-SS-A / H-2)", () => {
  const content = fs.readFileSync(OSSFILTER_PATH, "utf-8");
  const lines = content.split("\n").map((l) => l.trim());

  it("screenshot ディレクトリの除外ルールが存在する / contains the screenshot-dir exclusion rule", () => {
    expect(lines).toContain("- **/reftrix-screenshots/***");
  });

  it("phase5 PNG の除外ルールが存在する / contains the phase5 PNG exclusion rule", () => {
    expect(lines).toContain("- **/phase5/*.png");
  });

  it("除外ルールが allowlist include (`+ `) より前に位置する (first-match wins) / exclusion rules precede allowlist includes", () => {
    const ruleIndex = lines.indexOf("- **/reftrix-screenshots/***");
    const firstInclude = lines.findIndex((l) => l.startsWith("+ "));
    expect(ruleIndex).toBeGreaterThanOrEqual(0);
    expect(firstInclude).toBeGreaterThanOrEqual(0);
    expect(ruleIndex).toBeLessThan(firstInclude);
  });

  it("UB-9 (e): ADR-0041 配布形態別信号への能動参照コメントが存在する / contains the active ADR-0041 per-distribution-signal reference", () => {
    expect(content).toContain("ADR-0041");
  });

  it("L-09: tmp-suffix 残骸の二重防御コメントが存在する / contains the L-09 tmp-residue double-coverage note", () => {
    // 既存 `- **/*.tmp` ルールが atomic-rename 残骸を二重に救う旨の明記
    // The note that the existing `- **/*.tmp` rule doubly covers atomic-rename residue.
    expect(content).toMatch(/\*\.tmp.*(double|二重)/i);
  });
});
