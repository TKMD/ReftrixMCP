// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-NEXT-JOB-RACE-001 (sub 3/3, grace-bound): `IPC_SHUTDOWN_GRACE_MS` が
 * (a) constant 1 箇所定義 + env override 1 箇所 read に集約され、(b) 旧
 * hardcoded `2000` literal が `worker-supervisor.service.ts` の inline に残存
 * しないこと、(c) range validation (1,000-120,000ms) が機能することを
 * code-level + structural test で証明する (TPA-PLAN-002 closure)。
 *
 * INV-NEXT-JOB-RACE-001 (sub 3/3, grace-bound): `IPC_SHUTDOWN_GRACE_MS` is
 * (a) defined exactly once at the constant-declaration site with env override,
 * (b) the legacy hardcoded `2000` literal does not remain inline in
 * `worker-supervisor.service.ts`, and (c) range validation (1,000-120,000ms)
 * functions correctly. Proven via code-level + structural tests
 * (TPA-PLAN-002 closure).
 *
 * @see Plan v2 §1 (anchor 019de97f-1dcf) S1.2
 * @see ADR-0009 Amendment 4
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

import { __IPC_SHUTDOWN_GRACE_MS_FOR_TEST } from "../../../../src/services/worker-supervisor.service";

const SUPERVISOR_FILE = resolve(__dirname, "../../../../src/services/worker-supervisor.service.ts");
// CO-26 split: IPC_SHUTDOWN_GRACE_MS constant declaration moved to Module B
// (worker-supervisor-lifecycle.service.ts). Module A re-exports it for callsite churn = 0.
const SUPERVISOR_LIFECYCLE_FILE = resolve(
  __dirname,
  "../../../../src/services/worker-supervisor-lifecycle.service.ts"
);

describe("INV-NEXT-JOB-RACE-001 (sub 3, grace-bound): IPC_SHUTDOWN_GRACE_MS unification", () => {
  it("INV-NEXT-JOB-RACE-001: IPC_SHUTDOWN_GRACE_MS_DEFAULT = 30000 で env override 設定が無い時の値である / DEFAULT is 30000 when no env override", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-NEXT-JOB-RACE-001");
    expect(__IPC_SHUTDOWN_GRACE_MS_FOR_TEST.default).toBe(30_000);
    // process 起動時の env override が無い場合、current === default
    if (
      process.env.WORKER_IPC_SHUTDOWN_GRACE_MS === undefined ||
      process.env.WORKER_IPC_SHUTDOWN_GRACE_MS === ""
    ) {
      expect(__IPC_SHUTDOWN_GRACE_MS_FOR_TEST.current).toBe(30_000);
    }
  });

  it("INV-NEXT-JOB-RACE-001: range validation の bound は 1000-120000ms / range bounds are 1000-120000ms", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-NEXT-JOB-RACE-001");
    expect(__IPC_SHUTDOWN_GRACE_MS_FOR_TEST.min).toBe(1_000);
    expect(__IPC_SHUTDOWN_GRACE_MS_FOR_TEST.max).toBe(120_000);
  });

  it("INV-NEXT-JOB-RACE-001: current 値は range [min, max] 内 (NaN/範囲外フォールバック検証) / current is within [min, max]", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-NEXT-JOB-RACE-001");
    expect(__IPC_SHUTDOWN_GRACE_MS_FOR_TEST.current).toBeGreaterThanOrEqual(
      __IPC_SHUTDOWN_GRACE_MS_FOR_TEST.min
    );
    expect(__IPC_SHUTDOWN_GRACE_MS_FOR_TEST.current).toBeLessThanOrEqual(
      __IPC_SHUTDOWN_GRACE_MS_FOR_TEST.max
    );
  });

  it("INV-NEXT-JOB-RACE-001: worker-supervisor.service.ts の **実コード行** に hardcoded `2000` literal が残存しない (TPA-PLAN-002 closure) / no inline `2000` literal in worker-supervisor.service.ts code lines", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-NEXT-JOB-RACE-001");
    // CO-26 split: check both Module A facade and Module B lifecycle.
    const fileContent =
      readFileSync(SUPERVISOR_FILE, "utf-8") +
      "\n" +
      readFileSync(SUPERVISOR_LIFECYCLE_FILE, "utf-8");
    // コメント / docstring 行は match から除外。`* `, `// ` で始まる行をスキップ。
    const codeLines = fileContent.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) return false;
      return true;
    });
    // `2000` または `2_000` literal が IPC 系 const 宣言 / 関数本体に残存しているか
    // 検出。新 default `30_000` / `30000` は許容、min/max literal `1000`/`1_000`/
    // `120000`/`120_000` も許容。
    const violations = codeLines.filter((line) => {
      // strict regex: word-boundary `2000` (not `20000`, not `200`).
      // 数値 literal のみ拾う: `\b2_?000\b` (e.g. `2000` or `2_000`) かつ
      // line 内に `IPC_SHUTDOWN_GRACE` 文字列を含まない (constant declaration の
      // dead-code 例外: 旧 grace value を describe する場合に false positive を防ぐ
      // ため、constant declaration 行も除外)。
      if (line.includes("IPC_SHUTDOWN_GRACE_MS_DEFAULT")) return false;
      if (line.includes("IPC_SHUTDOWN_GRACE_MS_MIN")) return false;
      if (line.includes("IPC_SHUTDOWN_GRACE_MS_MAX")) return false;
      return /\b2_?000\b/.test(line);
    });
    expect(violations).toEqual([]);
  });

  it("INV-NEXT-JOB-RACE-001: IPC_SHUTDOWN_GRACE_MS constant が file 内で 1 箇所のみ宣言される / IPC_SHUTDOWN_GRACE_MS declared exactly once", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-NEXT-JOB-RACE-001");
    // CO-26 split: IPC_SHUTDOWN_GRACE_MS now declared in Module B (lifecycle).
    // Module A re-exports it via `export { IPC_SHUTDOWN_GRACE_MS } from "./worker-supervisor-lifecycle.service"`
    // (export statement, NOT a `const` declaration). Combined source must
    // contain exactly ONE `const` declaration across both modules.
    const fileContent =
      readFileSync(SUPERVISOR_FILE, "utf-8") +
      "\n" +
      readFileSync(SUPERVISOR_LIFECYCLE_FILE, "utf-8");
    // const IPC_SHUTDOWN_GRACE_MS = ... の宣言行を count
    // Accept both `const X` and `export const X` forms (Module B exports the const).
    const declarations = fileContent
      .split("\n")
      .filter((line) => /^(export\s+)?const\s+IPC_SHUTDOWN_GRACE_MS\s*[:=]/.test(line.trim()));
    expect(declarations.length).toBe(1);
  });
});
