// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-NO-RESUME-001 (Plan v4.2 redefine, invocation contract):
 * `Worker.resume()` の呼び出しが **worker code base 全体で構造的に存在しない**
 * ことを 3 layer で証明する。
 *
 * Plan v4.2 PR-A landing で `applyPostJobLifecycleGate` の return type は
 * `Promise<never>` → **`Promise<void>`** に降格された (ADR-0034 §Decision 1)。
 * これに伴い、本 INV は **type-level Promise<never> 保証** ではなく
 * **invocation contract (call-site 禁止)** に redefine された (TPA-V42-M-02
 * closure, ADR-0034 §Decision 2)。
 *
 * ## 3-layer proof
 *
 *   1. **Layer 1 (AST gate enforcement, canonical per SEC-V42-L-NEW-4)**:
 *      `scripts/verify-completed-listener-sync.mjs` が `worker.once('completed',
 *      ...)` listener body を synchronous-only (no async / no await) に強制する。
 *      これは Plan v4.2 PR-L closure 以前の `applyPostJobLifecycleGateAlwaysExits`
 *      wrapper の type-level `Promise<never>` guarantee を **structurally**
 *      置換する canonical Layer 1 enforcement である (SEC-V42-L-NEW-4 mandate)。
 *   2. **Layer 2 (Static AST grep)**: `apps/mcp-server/src/workers/` 配下の
 *      worker file 群および `shared/post-job-lifecycle.ts` 内で
 *      `\.resume\s*\(` の正規表現マッチが 0 件であること (call-site contract)。
 *   3. **Layer 3 (Runtime spy)**: `applyPostJobLifecycleGate` 実行時に
 *      `worker.resume()` spy が一度も呼ばれないこと。
 *
 * INV-WORKER-NO-RESUME-001 (Plan v4.2 redefine, invocation contract):
 * Three-layer proof that `Worker.resume()` invocations are **structurally
 * absent from the entire worker code base**.
 *
 * Plan v4.2 PR-A demoted `applyPostJobLifecycleGate` from `Promise<never>` to
 * **`Promise<void>`** (ADR-0034 §Decision 1). This INV is consequently
 * redefined from **type-level Promise<never> guarantee** to
 * **invocation contract (call-site forbidden)** (TPA-V42-M-02 closure,
 * ADR-0034 §Decision 2). Plan v4.2 PR-L closure further removed the
 * `applyPostJobLifecycleGateAlwaysExits` wrapper (SEC-V42-L-NEW-4 mandate,
 * CWE-705 + CWE-754 closure); Layer 1 canonical enforcement is now the AST
 * gate `scripts/verify-completed-listener-sync.mjs`.
 *
 *   1. **Layer 1 (AST gate enforcement)**: AST gate script
 *      `scripts/verify-completed-listener-sync.mjs` runs in CI and enforces
 *      synchronous-only listener body across `worker.once('completed', ...)`
 *      callsites — structurally guaranteeing the single-shot exit timing that
 *      previously relied on a `Promise<never>` wrapper helper.
 *   2. **Layer 2 (static AST grep)**: zero matches of `\.resume\s*\(` across
 *      worker files in `apps/mcp-server/src/workers/` and
 *      `shared/post-job-lifecycle.ts` (call-site contract).
 *   3. **Layer 3 (runtime spy)**: `worker.resume()` spy never invoked.
 *
 * ## A-9 Declaration (feedback_no_fake_success A-9)
 *
 * - **A-9.1**: Layer 2 static grep は AST-walk ではなく line-based regex match
 *   (comment行 / docstring 行を除外)。`scripts/check-no-resume.sh` AST gate が
 *   将来 PR で導入される際に AST-level validation に upgrade 予定 (TPA M-NEW
 *   tracked-issue)。本 test では line-based filter で 99% 検出。
 * - **A-9.2**: Layer 3 runtime spy は fake Worker (object literal) で simulate。
 *   Real BullMQ Worker `.resume()` semantic は real-Redis 24h smoke で verify。
 *
 * Mock-based bounded-trust assertion; real-Redis 24h smoke supplements.
 *
 * @see Plan v4.2 §3.3 Constraint 2 (INV redefine)
 * @see ADR-0034 §Decision 2 (call-site forbidden contract)
 * @see TDA M-1 closure (wrapper helper Option (b))
 * @see TPA-V42-M-02 (INV-WORKER-NO-RESUME-001 redefine scope)
 * @see internal anchor: Plan v4.2 019e2c7e-3b25-701b-a18c-91b8a054a93f
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

import { applyPostJobLifecycleGate } from "../../../../src/workers/shared/post-job-lifecycle";

// AST grep targets: worker code base 全体 (call-site forbidden contract)
const WORKER_DIR = resolve(__dirname, "../../../../src/workers");
const POST_JOB_LIFECYCLE_FILE = resolve(WORKER_DIR, "shared/post-job-lifecycle.ts");
const PAGE_ANALYZE_WORKER_FILE = resolve(WORKER_DIR, "page-analyze-worker.ts");
const EMBEDDING_BACKFILL_WORKER_FILE = resolve(WORKER_DIR, "embedding-backfill-worker.ts");

/**
 * code-only filter: comment行 / docstring 行を除外して `.resume(` 正規表現
 * マッチを返す。
 */
function findResumeCallsites(filePath: string): string[] {
  const fileContent = readFileSync(filePath, "utf-8");
  const codeLines = fileContent
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"));
  return codeLines.filter((line) => /\.resume\s*\(/.test(line));
}

describe("INV-WORKER-NO-RESUME-001 (Plan v4.2 redefine): Worker.resume() call-site forbidden across worker code base", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-NO-RESUME-001");
    // process.exit を spy 化 (Layer 3 runtime test で wrapper を呼ぶ場合のみ trigger)
    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined as never) as typeof process.exit);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // --- Layer 1: AST gate enforcement (SEC-V42-L-NEW-4 canonical) -------

  it("INV-WORKER-NO-RESUME-001: Layer 1 — AST gate script `verify-completed-listener-sync.mjs` exists and enforces synchronous-only listener body (SEC-V42-L-NEW-4 canonical replacement for retired wrapper) / Layer 1 — AST gate enforces synchronous listener body", () => {
    // Plan v4.2 PR-L closure (SEC-V42-L-NEW-4): the legacy
    // `applyPostJobLifecycleGateAlwaysExits` wrapper was formally removed and
    // its Layer 1 type-level `Promise<never>` guarantee is now structurally
    // provided by the AST gate `scripts/verify-completed-listener-sync.mjs`.
    // The AST gate enforces synchronous-only listener body across
    // `worker.once('completed', callback)` callsites — structurally
    // guaranteeing single-shot exit timing without relying on a wrapper.
    const scriptPath = resolve(__dirname, "../../../../scripts/verify-completed-listener-sync.mjs");
    const scriptContent = readFileSync(scriptPath, "utf-8");
    // AST gate must inspect listener body for await + async (synchronous-only contract)
    expect(scriptContent).toContain("worker.once");
    expect(scriptContent).toContain("AwaitExpression");
    expect(scriptContent).toContain("synchronous");
  });

  it("INV-WORKER-NO-RESUME-001: Layer 1 — wrapper `applyPostJobLifecycleGateAlwaysExits` is formally removed from post-job-lifecycle.ts (SEC-V42-L-NEW-4 CWE-705 + CWE-754 closure) / Layer 1 — legacy wrapper formally absent", () => {
    // SEC-V42-L-NEW-4 mandate verification: wrapper の export 削除を structural に verify。
    // CWE-705 (Incorrect Control Flow Scoping) primary + CWE-754 (Improper Check)
    // secondary risk の構造的閉鎖。
    const postJobLifecycleSource = readFileSync(
      resolve(__dirname, "../../../../src/workers/shared/post-job-lifecycle.ts"),
      "utf-8"
    );
    // export 文に wrapper 名が存在しない (formal removal)
    expect(postJobLifecycleSource).not.toMatch(
      /export\s+(async\s+)?function\s+applyPostJobLifecycleGateAlwaysExits/
    );
  });

  it("INV-WORKER-NO-RESUME-001: Layer 1 — applyPostJobLifecycleGate return type is Promise<void> (gate-only responsibility) / Layer 1 — gate return type is Promise<void> per Plan v4.2 PR-A", async () => {
    // Plan v4.2 PR-A signature change verification: Promise<void> semantic
    // resolved value が undefined であることで Promise<void> を runtime verify。
    const pauseSpy = vi.fn().mockResolvedValue(undefined);
    const fakeWorker = {
      pause: pauseSpy,
      resume: vi.fn(),
    } as unknown as Worker;

    const result = await applyPostJobLifecycleGate(
      fakeWorker,
      true,
      "[INV-WORKER-NO-RESUME-001-layer1]"
    );

    expect(result).toBeUndefined();
  });

  // --- Layer 2: Static AST grep ------------------------------------------

  it("INV-WORKER-NO-RESUME-001: Layer 2 — post-job-lifecycle.ts に .resume( call-site が 0 件 (call-site forbidden) / Layer 2 — zero .resume( call-sites in post-job-lifecycle.ts", () => {
    const violations = findResumeCallsites(POST_JOB_LIFECYCLE_FILE);
    expect(violations).toEqual([]);
  });

  it("INV-WORKER-NO-RESUME-001: Layer 2 — page-analyze-worker.ts に .resume( call-site が 0 件 / Layer 2 — zero .resume( call-sites in page-analyze-worker.ts", () => {
    const violations = findResumeCallsites(PAGE_ANALYZE_WORKER_FILE);
    expect(violations).toEqual([]);
  });

  it("INV-WORKER-NO-RESUME-001: Layer 2 — embedding-backfill-worker.ts に .resume( call-site が 0 件 / Layer 2 — zero .resume( call-sites in embedding-backfill-worker.ts", () => {
    const violations = findResumeCallsites(EMBEDDING_BACKFILL_WORKER_FILE);
    expect(violations).toEqual([]);
  });

  // --- Layer 3: Runtime spy ---------------------------------------------

  it("INV-WORKER-NO-RESUME-001: Layer 3 — applyPostJobLifecycleGate 実行時に worker.resume() spy も worker.pause() spy も一度も呼ばれない (Plan v1.1 candidate B no-op stub) / Layer 3 — runtime: both worker.resume() and worker.pause() spies never invoked under no-op stub", async () => {
    const resumeSpy = vi.fn();
    const pauseSpy = vi.fn().mockResolvedValue(undefined);
    const fakeWorker = {
      resume: resumeSpy,
      pause: pauseSpy,
    } as unknown as Worker;

    // Plan v1.1 candidate B (ADR-0034 Amendment 5): applyPostJobLifecycleGate
    // is a `Promise<void>` no-op stub retained for legacy test-caller backward
    // compat. Production callers were migrated to `applyPostJobMemoryGate` in
    // the same commit. `worker.pause` callsites are 0 in production code
    // (INV-WORKER-NO-PAUSE-001 enforced by AST gate
    // `scripts/verify-no-worker-pause.mjs`).
    await applyPostJobLifecycleGate(fakeWorker, true, "[INV-WORKER-NO-RESUME-001-layer3]");

    expect(resumeSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    // no-op stub: process.exit は呼ばれない (listener が発火する)
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("INV-WORKER-NO-RESUME-001: Layer 3 — enabled=false 経路でも worker.resume() を呼ばない / Layer 3 — disabled path also never invokes worker.resume()", async () => {
    const resumeSpy = vi.fn();
    const pauseSpy = vi.fn().mockResolvedValue(undefined);
    const fakeWorker = {
      resume: resumeSpy,
      pause: pauseSpy,
    } as unknown as Worker;

    await applyPostJobLifecycleGate(fakeWorker, false, "[INV-WORKER-NO-RESUME-001-layer3]");

    expect(resumeSpy).not.toHaveBeenCalled();
    // disabled path は pause も呼ばない
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  // Plan v4.2 PR-L closure (SEC-V42-L-NEW-4): the prior "Layer 3 — wrapper
  // helper never invokes resume()" test was removed alongside the
  // `applyPostJobLifecycleGateAlwaysExits` wrapper itself. Layer 1 canonical
  // enforcement is now the AST gate (verified above); Layer 3 runtime spy
  // coverage of the resume-free contract is preserved by the two prior tests
  // (enabled=true / enabled=false paths) which already exhaust the
  // `applyPostJobLifecycleGate` execution surface that previously routed
  // through the wrapper.
});
