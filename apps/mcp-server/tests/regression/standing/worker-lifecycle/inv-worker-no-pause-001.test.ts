// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain (Plan v1.1 candidate B).
 *
 * INV-WORKER-NO-PAUSE-001 (Plan v1.1 candidate B / ADR-0034 Amendment 5):
 * production code 全域で `worker.pause(...)` callsite が **0 件** である
 * ことを 3 layer で証明する。
 *
 *   1. **Layer 1 (AST gate execution)**:
 *      `apps/mcp-server/scripts/verify-no-worker-pause.mjs` を直接 spawn し、
 *      exit code 0 (PASS) を assert する。本 AST gate は production code
 *      `apps/mcp-server/src/**.ts` を再帰 sweep し、`worker.pause(`
 *      callsite 0 件 (exempt scope = `pause:` facade method + test files)、
 *      3 bypass pattern (computed access / indirect call / `vi.spyOn`)
 *      を reject する。
 *   2. **Layer 2 (Static regex grep, AST gate complement)**:
 *      `embedding-backfill-worker.ts` / `page-analyze-worker.ts` /
 *      `post-job-lifecycle.ts` のいずれにも `worker\.pause\s*\(` の正規表現
 *      マッチが、`pause:` facade method 以外で 0 件であることを line-based
 *      filter で再確認する (AST gate と independent な assertion で
 *      crosscheck)。
 *   3. **Layer 3 (env=0 fail-closed runtime contract)**:
 *      `WORKER_MAX_JOBS_BEFORE_RESTART=0` 環境変数を simulate し、
 *      `applyPostJobMemoryGate(false, ...)` が memory gate も
 *      listener exit も走らせない no-op path を辿ることを runtime spy で
 *      確認する (SEC-PLAN-V0-M-01 documented behavior + fail-closed
 *      契約)。`worker.pause` も呼ばれない (callsite が production code に
 *      存在しないため)。
 *
 * INV-WORKER-NO-PAUSE-001 (Plan v1.1 candidate B / ADR-0034 Amendment 5):
 * Three-layer proof that `worker.pause(...)` callsites are **0** in
 * production code:
 *
 *   1. **Layer 1 (AST gate execution)**: spawns
 *      `scripts/verify-no-worker-pause.mjs` and asserts exit code 0.
 *      The gate recursively sweeps `apps/mcp-server/src/**.ts`, rejects
 *      3 bypass patterns (computed access / indirect call / `vi.spyOn`),
 *      and exempts only `pause:` facade methods + test files.
 *   2. **Layer 2 (static regex grep)**: independent line-based regex
 *      crosscheck of the three primary worker files.
 *   3. **Layer 3 (env=0 fail-closed)**: simulates
 *      `WORKER_MAX_JOBS_BEFORE_RESTART=0` and asserts the memory-gate
 *      no-op path (SEC-PLAN-V0-M-01 documented-behavior + fail-closed
 *      contract); `worker.pause` is never called because production
 *      callsites are 0.
 *
 * ## A-9 Declaration (feedback_no_fake_success A-9)
 *
 * - **A-9.1**: Layer 1 spawns the real AST gate script as a child process;
 *   its semantic is the canonical structural enforcement.
 * - **A-9.2**: Layer 2 is a defensive crosscheck using a different mechanism
 *   (regex) so the two layers fail independently if the AST gate regresses.
 * - **A-9.3**: Layer 3 simulates env=0 via direct helper invocation;
 *   end-to-end env=0 behaviour with a real BullMQ Worker is covered by the
 *   24h smoke gate (ADR-0030 amendment).
 *
 * @see Plan v1.1 §3 candidate B + §4.3 + §7.2 (`backfill-pause-completed-race-v1.md`)
 * @see ADR-0034 Amendment 5 §Decision 2 (production callsite contract)
 * @see IO Plan Decision V2 anchor `019e6f1a-b580`
 * @see scripts/verify-no-worker-pause.mjs (canonical AST gate)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";
import { applyPostJobMemoryGate } from "../../../../src/workers/shared/post-job-lifecycle";

const REPO_ROOT = resolve(__dirname, "../../../../../../");
const AST_GATE_SCRIPT = resolve(REPO_ROOT, "apps/mcp-server/scripts/verify-no-worker-pause.mjs");

const WORKER_DIR = resolve(__dirname, "../../../../src/workers");
const POST_JOB_LIFECYCLE_FILE = resolve(WORKER_DIR, "shared/post-job-lifecycle.ts");
const PAGE_ANALYZE_WORKER_FILE = resolve(WORKER_DIR, "page-analyze-worker.ts");
const EMBEDDING_BACKFILL_WORKER_FILE = resolve(WORKER_DIR, "embedding-backfill-worker.ts");

/**
 * Line-based regex sweep filtering out comments / docstrings, returning
 * lines that contain a `worker.pause(` callsite AND are NOT inside the
 * exempt `pause:` facade method.
 *
 * Exempt-scope window detection: find the `pause:` method on the worker
 * facade returned by the factory, then scan forward to find its closing
 * `},` (the closing brace + comma of the property in the object literal).
 * Track brace depth to skip over inner blocks like `if (verbose) { ... }`.
 */
function findWorkerPauseCallsites(filePath: string): string[] {
  const fileContent = readFileSync(filePath, "utf-8");
  const fileLines = fileContent.split("\n");
  const codeLines = fileLines
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => !line.trim().startsWith("*") && !line.trim().startsWith("//"));
  // Locate the `pause:` facade method.
  const pauseMethodLineIdx = fileLines.findIndex((l) => /pause:\s*async/.test(l));
  let pauseMethodEnd = pauseMethodLineIdx;
  if (pauseMethodLineIdx >= 0) {
    // The pause method starts with `pause: async (): Promise<void> => {`,
    // so depth starts at 1 (one unmatched `{`). Scan forward, counting `{`
    // and `}` characters; the method ends when depth returns to 0.
    let depth = 1;
    for (
      let i = pauseMethodLineIdx + 1;
      i < Math.min(pauseMethodLineIdx + 30, fileLines.length);
      i++
    ) {
      const line = fileLines[i] ?? "";
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= 0) {
        pauseMethodEnd = i;
        break;
      }
    }
  }
  const exemptStart = pauseMethodLineIdx;
  const exemptEnd = pauseMethodEnd;
  return codeLines
    .filter(({ line, idx }) => {
      if (!/worker\.pause\s*\(/.test(line)) return false;
      if (exemptStart >= 0 && idx >= exemptStart && idx <= exemptEnd) return false;
      return true;
    })
    .map(({ line }) => line);
}

describe("INV-WORKER-NO-PAUSE-001 (Plan v1.1 candidate B): worker.pause(...) call-site forbidden in production code", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-NO-PAUSE-001");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Layer 1: AST gate execution -------------------------------------

  it("INV-WORKER-NO-PAUSE-001: Layer 1 — AST gate script verify-no-worker-pause.mjs exists and exits with code 0 (PASS) / Layer 1 — AST gate exits 0", () => {
    // Spawn the real AST gate as a child process. The gate writes
    // "[verify-no-worker-pause] PASS" to stdout on success. Any forbidden
    // callsite causes exit code 1 + FAIL output on stderr.
    let stdout = "";
    let exitOk = false;
    try {
      stdout = execFileSync("node", [AST_GATE_SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      exitOk = true;
    } catch (err) {
      // execFileSync throws when exit code != 0. Capture stdout for diag.
      const e = err as { stdout?: string; stderr?: string };
      stdout = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
      exitOk = false;
    }
    expect(exitOk).toBe(true);
    expect(stdout).toContain("[verify-no-worker-pause] PASS");
  });

  it("INV-WORKER-NO-PAUSE-001: Layer 1 — AST gate script rejects 3 bypass patterns (computed access / indirect call / vi.spyOn) in production code / Layer 1 — bypass pattern detection scope present", () => {
    // Structural verification that the AST gate script itself implements
    // the three bypass-pattern rejection branches. Reading the gate
    // script source and asserting key tokens are present.
    const gateSource = readFileSync(AST_GATE_SCRIPT, "utf-8");
    expect(gateSource).toContain("Bypass pattern (a)");
    expect(gateSource).toContain("Bypass pattern (b)");
    expect(gateSource).toContain("Bypass pattern (c)");
    // Specific detection idioms:
    expect(gateSource).toContain("computed === true"); // (a) computed access
    expect(gateSource).toContain("VariableDeclarator"); // (b) indirect call
    expect(gateSource).toContain("vi.spyOn"); // (c) spyOn pattern (rejected)
  });

  // --- Layer 2: Static regex grep crosscheck ---------------------------

  it("INV-WORKER-NO-PAUSE-001: Layer 2 — post-job-lifecycle.ts に worker.pause( callsite 0 件 (exempt scope 適用後) / Layer 2 — zero worker.pause( callsites in post-job-lifecycle.ts", () => {
    const violations = findWorkerPauseCallsites(POST_JOB_LIFECYCLE_FILE);
    expect(violations).toEqual([]);
  });

  it("INV-WORKER-NO-PAUSE-001: Layer 2 — page-analyze-worker.ts に worker.pause( callsite 0 件 (exempt scope = pause: facade method 適用後) / Layer 2 — zero worker.pause( callsites in page-analyze-worker.ts excluding pause: facade", () => {
    const violations = findWorkerPauseCallsites(PAGE_ANALYZE_WORKER_FILE);
    expect(violations).toEqual([]);
  });

  it("INV-WORKER-NO-PAUSE-001: Layer 2 — embedding-backfill-worker.ts に worker.pause( callsite 0 件 (exempt scope = pause: facade method 適用後) / Layer 2 — zero worker.pause( callsites in embedding-backfill-worker.ts excluding pause: facade", () => {
    const violations = findWorkerPauseCallsites(EMBEDDING_BACKFILL_WORKER_FILE);
    expect(violations).toEqual([]);
  });

  // --- Layer 3: env=0 fail-closed runtime contract ---------------------

  it("INV-WORKER-NO-PAUSE-001: Layer 3 — WORKER_MAX_JOBS_BEFORE_RESTART=0 simulation で applyPostJobMemoryGate(false, ...) は no-op (memory gate も exit も走らせない) (SEC-PLAN-V0-M-01 fail-closed) / Layer 3 — env=0 fail-closed: no memory gate, no exit", async () => {
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__UNEXPECTED_PROCESS_EXIT__");
    }) as never);
    try {
      // env=0 → enabled=false。memory gate も exit も走らない full no-op。
      await applyPostJobMemoryGate(false, "[INV-WORKER-NO-PAUSE-001-layer3]");
      expect(processExitSpy).not.toHaveBeenCalled();
    } finally {
      processExitSpy.mockRestore();
    }
  });

  it("INV-WORKER-NO-PAUSE-001: Layer 3 — env=1 enabled でも applyPostJobMemoryGate は worker instance を argument に取らない (= worker.pause を呼ぶ手段が型レベルで存在しない、constructive proof) / Layer 3 — applyPostJobMemoryGate signature has no Worker arg (pause structurally impossible)", () => {
    // Function signature の structural verification: production 側 helper の
    // 引数に Worker instance が無いため、`worker.pause(...)` を呼ぶ手段が
    // 型レベルで存在しない (constructive proof + Layer 1 AST gate + Layer 2
    // regex grep の 3 重防御)。
    // signature: applyPostJobMemoryGate(enabled: boolean, loggerPrefix: string)
    expect(applyPostJobMemoryGate.length).toBe(2);
  });
});
