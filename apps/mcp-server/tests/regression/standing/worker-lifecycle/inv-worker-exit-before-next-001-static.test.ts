// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 (sub 1/3, static analysis):
 * Plan v4.2 PR-A landing で導入された **callback-based exit pattern** が
 * source code レベルで遵守されていることを static analysis で証明する。
 *
 * ## 検証契約 / Verification contracts
 *
 *   1. **process.exit(0) call-site location**: worker source code 内の
 *      `process.exit(0)` 呼出は **listener callback path** からのみ可能で、
 *      processor inline からの呼出は禁止 (call-site location contract)。
 *   2. **Signature contract**: `applyPostJobLifecycleGate` は `Promise<void>`
 *      を返す。Layer 1 type-level guarantee は Plan v4.2 PR-L closure
 *      (SEC-V42-L-NEW-4 mandate) で AST gate
 *      `scripts/verify-completed-listener-sync.mjs` に移管された
 *      (旧 `applyPostJobLifecycleGateAlwaysExits` wrapper は formal removal 済、
 *      CWE-705 + CWE-754 closure)。
 *   3. **worker.once('completed', ...) registration**: page-analyze-worker.ts
 *      および embedding-backfill-worker.ts に `worker.once("completed", ...)`
 *      listener が登録されている (pre-register contract per ADR-0034 §Decision 1
 *      Step C)。
 *
 * INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 (sub 1/3, static analysis):
 * Verifies via static analysis that the **callback-based exit pattern**
 * introduced in Plan v4.2 PR-A is upheld at the source code level.
 *
 *   1. **process.exit(0) call-site location**: `process.exit(0)` in worker
 *      source must be invoked only from the listener callback path, not from
 *      processor inline (call-site location contract).
 *   2. **Signature contract**: `applyPostJobLifecycleGate` returns
 *      `Promise<void>`. Layer 1 type-level guarantee migrated to the AST gate
 *      `scripts/verify-completed-listener-sync.mjs` under Plan v4.2 PR-L
 *      closure (SEC-V42-L-NEW-4 mandate); the legacy
 *      `applyPostJobLifecycleGateAlwaysExits` wrapper was formally removed
 *      (CWE-705 + CWE-754 closure).
 *   3. **worker.once('completed', ...) registration**: page-analyze-worker.ts
 *      and embedding-backfill-worker.ts must register `worker.once("completed",
 *      ...)` listener (pre-register contract per ADR-0034 §Decision 1 Step C).
 *
 * ## A-9 Declaration (feedback_no_fake_success A-9)
 *
 * - **A-9.1**: Static analysis は line-based regex match (comment行 / docstring
 *   行を除外)。AST-level walk は `scripts/verify-completed-listener-sync.mjs`
 *   が CI で別途実行 (SEC M-NEW-1 AST gate)。本 test は **補完的** な
 *   structural evidence で、AST gate と complementary。
 * - **A-9.2**: process.exit(0) call-site の listener-path 限定は **call-site
 *   location** verification (call-site の文脈 = "worker.once コールバック内"
 *   であることの structural inference)。Real BullMQ event flow ordering は
 *   sub 2 (mocked) + sub 3 (smoke) で verify。
 *
 * Static + AST-gate complementary; real-Redis smoke supplements (sub 3).
 *
 * @see Plan v4.2 §3.3 Constraint 5 (NEW INV)
 * @see ADR-0034 §Decision 1 (callback-based exit pattern)
 * @see ADR-0030 amendment (24h smoke pre-merge gate)
 * @see internal anchor: Plan v4.2 019e2c7e-3b25-701b-a18c-91b8a054a93f
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

import { applyPostJobLifecycleGate } from "../../../../src/workers/shared/post-job-lifecycle";

const WORKER_DIR = resolve(__dirname, "../../../../src/workers");
const POST_JOB_LIFECYCLE_FILE = resolve(WORKER_DIR, "shared/post-job-lifecycle.ts");
const PAGE_ANALYZE_WORKER_FILE = resolve(WORKER_DIR, "page-analyze-worker.ts");
const EMBEDDING_BACKFILL_WORKER_FILE = resolve(WORKER_DIR, "embedding-backfill-worker.ts");

function readCodeLines(filePath: string): string[] {
  const fileContent = readFileSync(filePath, "utf-8");
  return fileContent
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"));
}

describe("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 (sub 1, static analysis): callback-based exit structural contract", () => {
  // --- Contract 1: process.exit(0) call-site location ---

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: page-analyze-worker.ts が registerCompletedListenerAndExit helper 経由で listener を登録する (Plan v4.2 PR-L TDA-V42-L-02 helper extraction) / page-analyze-worker.ts registers listener via helper", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    // Plan v4.2 PR-L closure (TDA-V42-L-02): boilerplate を helper に集約し、
    // worker file は `registerCompletedListenerAndExit(worker, "page-analyze")`
    // を呼ぶことで listener を登録する。Helper 経由でも SEC M-NEW-1 AST gate が
    // synchronous-only enforcement を担保する (helper file が gate TARGETS に追加済)。
    //
    // Plan v4.3 PR-M-A refinement Item 1 (closure): call-site が
    // `registerCompletedListenerAndExit(worker, "page-analyze", { ... })` の
    // optional 3rd argument 形 (multi-line) も許容する multi-line regex に
    // 拡張済。改行を `[\s\S]*?` で許容しつつ optional 3rd argument を greedy
    // にせず first-match で確実に検出する。
    const fileContent = readFileSync(PAGE_ANALYZE_WORKER_FILE, "utf-8");
    // Strip comment/docstring lines before matching to avoid false positives
    // from JSDoc snippets referencing the helper invocation form. After
    // stripping, the call-site is identified by its argument-prefix:
    // `registerCompletedListenerAndExit(worker, "<workerType>"` — either
    // followed by `)` (legacy 2-arg form, page-analyze) or `,` (3-arg form
    // with optional `disposeFn` config object, Plan v4.3 PR-M-A
    // refinement). Both forms count as one structurally-correct call-site;
    // the AST gate `scripts/verify-completed-listener-sync.mjs` separately
    // verifies the closing `)` and synchronous-only listener body contract.
    const sourceOnly = fileContent
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    const helperPattern =
      /registerCompletedListenerAndExit\s*\(\s*worker\s*,\s*["']page-analyze["']\s*[,)]/g;
    const helperMatches = sourceOnly.match(helperPattern) ?? [];
    expect(helperMatches.length).toBeGreaterThanOrEqual(1);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: embedding-backfill-worker.ts が registerCompletedListenerAndExit helper 経由で listener を登録する (Plan v4.2 PR-L TDA-V42-L-02 helper extraction) / embedding-backfill-worker.ts registers listener via helper", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    // Plan v4.3 PR-M-A refinement Item 1 (closure): embedding-backfill-worker
    // では PR-M-B で `disposeFn` bind が追加され call-site が multi-line
    // 形 (3-arg form) になった (line ~1023)。Argument-prefix match で
    // `(worker, "embedding-backfill"` の直後が `,` (3-arg) or `)` (2-arg)
    // である call-site を 1 件以上検出する。AST gate との役割分担:
    // 本 test は call-site の **存在** を structural に証明し、AST gate
    // (`scripts/verify-completed-listener-sync.mjs`) が listener body の
    // synchronous-only contract と argument balanced parens を担保する。
    const fileContent = readFileSync(EMBEDDING_BACKFILL_WORKER_FILE, "utf-8");
    const sourceOnly = fileContent
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    const helperPattern =
      /registerCompletedListenerAndExit\s*\(\s*worker\s*,\s*["']embedding-backfill["']\s*[,)]/g;
    const helperMatches = sourceOnly.match(helperPattern) ?? [];
    expect(helperMatches.length).toBeGreaterThanOrEqual(1);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: post-job-lifecycle.ts helper 内に worker.once('completed', ...) listener が登録されている (Plan v4.2 PR-L TDA-V42-L-02 canonical SSOT location) / helper file is the canonical listener registration site", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    // Plan v4.2 PR-L closure: listener registration の SSOT location は
    // shared helper file に移管された。両 worker file の boilerplate 重複は解消。
    const codeLines = readCodeLines(POST_JOB_LIFECYCLE_FILE);
    const onceRegistrations = codeLines.filter((line) =>
      /worker\.once\s*\(\s*["']completed["']\s*,/.test(line)
    );
    expect(onceRegistrations.length).toBeGreaterThanOrEqual(1);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: post-job-lifecycle.ts 内 applyPostJobLifecycleGate 関数本体 (gate-only) は process.exit(0) を呼ばない / applyPostJobLifecycleGate body (gate-only) does NOT call process.exit", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    // Gate-only contract: `applyPostJobLifecycleGate` 関数本体に process.exit が
    // 存在しない (caller が `return result` で listener path に exit を委譲する)。
    // Plan v4.2 PR-L closure (SEC-V42-L-NEW-4) で `applyPostJobLifecycleGateAlwaysExits`
    // wrapper は formal removal 済。Source 全体には `applyPostJobMemoryGate`
    // (failure path memory-only gate) のみが exit を持つことを許容するが、
    // 本 test は `applyPostJobLifecycleGate` 関数体のみを scope に限定して
    // structural verification する。
    const fileContent = readFileSync(POST_JOB_LIFECYCLE_FILE, "utf-8");
    // `applyPostJobLifecycleGate` 関数の宣言 → 次の top-level `export` までを抽出
    const gateMatch = fileContent.match(
      /export\s+async\s+function\s+applyPostJobLifecycleGate\s*\([^]*?\n\}\s*\n/
    );
    expect(gateMatch).not.toBeNull();
    const gateBody = gateMatch![0];
    // 関数体内に process.exit( パターンが 0 件 (gate-only 契約)
    const codeLines = gateBody
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"));
    const exitMatches = codeLines.filter((line) => /process\.exit\s*\(/.test(line));
    expect(exitMatches).toEqual([]);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: applyPostJobLifecycleGateAlwaysExits wrapper は formal removal 済 (Plan v4.2 PR-L / SEC-V42-L-NEW-4 CWE-705 + CWE-754 closure) / wrapper formally removed", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    // SEC-V42-L-NEW-4 mandate verification: wrapper export 削除を structural に verify。
    // Layer 1 canonical role は AST gate (verify-completed-listener-sync.mjs) に移管。
    const fileContent = readFileSync(POST_JOB_LIFECYCLE_FILE, "utf-8");
    expect(fileContent).not.toMatch(
      /export\s+(async\s+)?function\s+applyPostJobLifecycleGateAlwaysExits/
    );
  });

  // --- Contract 2: Signature contract ---

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: applyPostJobLifecycleGate は (worker, enabled, loggerPrefix) の 3 引数を取る / applyPostJobLifecycleGate has 3 params (worker, enabled, loggerPrefix)", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    // Function arity is part of the API contract; Plan v4.2 changes return
    // type but keeps signature shape.
    expect(applyPostJobLifecycleGate.length).toBe(3);
  });

  // --- Contract 3: AST gate script existence + SEC-V42-L-NEW-4 Layer 1 ----

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: verify-completed-listener-sync.mjs AST gate script が存在し AwaitExpression inspection を含む (SEC M-NEW-1 + SEC-V42-L-NEW-4 Layer 1 canonical) / AST gate exists and inspects AwaitExpression (Layer 1 canonical)", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    const scriptPath = resolve(__dirname, "../../../../scripts/verify-completed-listener-sync.mjs");
    // file system access で existence + content 確認
    const scriptContent = readFileSync(scriptPath, "utf-8");
    expect(scriptContent).toContain("worker.once");
    expect(scriptContent).toContain("synchronous");
    // SEC-V42-L-NEW-4 Layer 1 canonical role: AST gate が AwaitExpression を inspect する
    // (旧 wrapper の Promise<never> type-level guarantee の structural 代替)
    expect(scriptContent).toContain("AwaitExpression");
  });
});
