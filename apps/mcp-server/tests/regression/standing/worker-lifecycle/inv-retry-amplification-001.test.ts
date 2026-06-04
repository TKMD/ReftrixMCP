// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-RETRY-AMPLIFICATION-001: BullMQ queue defaults の `attempts` field が
 * `1` であることを CI で gate する。Plan v2 Cond 7 (anchor 019dedb1-ef6f) で
 * SEC FIND-PLAN-SEC-V1-03 (commitment A7 retry amplification アンチパターン、
 * CWE-693+754) を formal closure し、Plan v1 採択値 `attempts: 3` を破棄、
 * `attempts: 1` (BullMQ job-level retry ZERO) に統一した contract を構造的に
 * 保証する。
 *
 * INV-RETRY-AMPLIFICATION-001: gates that all BullMQ queue defaults set
 * `attempts: 1` in CI. Plan v2 Cond 7 (anchor 019dedb1-ef6f) formally closed
 * SEC FIND-PLAN-SEC-V1-03 (commitment A7 retry amplification anti-pattern,
 * CWE-693+754), retracting the Plan v1 value `attempts: 3` and unifying to
 * `attempts: 1` (BullMQ job-level retry ZERO). This test structurally
 * guarantees that contract.
 *
 * 例外 (allowed retry layers): Phase 0 HTTP client / Playwright navigation /
 * Ollama Vision / Prisma deadlock の internal retry のみ allowed (BullMQ
 * job-level retry は ZERO)。
 *
 * Allowed retry layers (out of scope): Phase 0 HTTP client / Playwright nav /
 * Ollama Vision / Prisma deadlock internal retries. BullMQ job-level retry is
 * the only thing this INV gates.
 *
 * @see Plan v2 Cond 7 closure (anchor 019dedb1-ef6f)
 * @see SEC FIND-PLAN-SEC-V1-03
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

const QUEUES_DIR = resolve(__dirname, "../../../../src/queues");

describe("INV-RETRY-AMPLIFICATION-001: BullMQ queue defaultJobOptions.attempts === 1", () => {
  // Helper: file 内 code-only 行 (コメント / docstring を除外) を返す
  function readCodeLines(filePath: string): string[] {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter((line) => {
      const trimmed = line.trim();
      // 行頭の `//` / `*` / backtick で始まる markdown コードブロックは skip
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
      return true;
    });
  }

  it("INV-RETRY-AMPLIFICATION-001: page-analyze-queue.ts は attempts: 1 を defaultJobOptions に設定する / page-analyze-queue.ts sets attempts: 1", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-RETRY-AMPLIFICATION-001");
    const filePath = resolve(QUEUES_DIR, "page-analyze-queue.ts");
    const content = readFileSync(filePath, "utf-8");
    // defaultJobOptions: { ... attempts: 1, ... }
    expect(content).toMatch(/defaultJobOptions[\s\S]{0,500}attempts:\s*1\s*,/);
    // 実コード行で attempts: 3 や attempts: 2 が残存していないこと (コメントは
    // historical reference として `attempts: 3` の言及を許容)
    const codeLines = readCodeLines(filePath);
    const violations = codeLines.filter((line) => /\battempts:\s*([2-9]|[1-9]\d+)\b/.test(line));
    expect(violations).toEqual([]);
  });

  it("INV-RETRY-AMPLIFICATION-001: embedding-backfill-queue.ts は attempts: 1 を defaultJobOptions に設定する (Cond 7 mandate) / embedding-backfill-queue.ts sets attempts: 1 (Cond 7 mandate)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-RETRY-AMPLIFICATION-001");
    const filePath = resolve(QUEUES_DIR, "embedding-backfill-queue.ts");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toMatch(/defaultJobOptions[\s\S]{0,2000}attempts:\s*1\s*,/);
    // 実コード行のみ matching (コメント内の historical `attempts: 3` 言及は許容)
    const codeLines = readCodeLines(filePath);
    const violations = codeLines.filter((line) => /\battempts:\s*([2-9]|[1-9]\d+)\b/.test(line));
    expect(violations).toEqual([]);
  });

  it("INV-RETRY-AMPLIFICATION-001: queues/ 配下の全 *.ts file で attempts: > 1 が出現しない / no attempts: > 1 anywhere in queues/", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-RETRY-AMPLIFICATION-001");
    const queueFiles = readdirSync(QUEUES_DIR).filter((f) => f.endsWith(".ts"));
    const violations: Array<{ file: string; line: string }> = [];
    for (const file of queueFiles) {
      const filePath = resolve(QUEUES_DIR, file);
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        // コメント行 (`//`, `*`) は skip
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        // `attempts: N` (N >= 2) を検出
        const match = /\battempts:\s*([2-9]|[1-9]\d+)\b/.exec(line);
        if (match) {
          violations.push({ file, line: line.trim() });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
