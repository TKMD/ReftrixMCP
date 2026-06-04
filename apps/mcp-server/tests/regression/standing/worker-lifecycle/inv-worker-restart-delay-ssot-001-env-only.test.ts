// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WORKER-RESTART-DELAY-SSOT-001
 *
 * **Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5**
 *
 * IO Plan Decision V1 anchor: `019e34c5-4480-76e5-8fcf-5e465a149fce`
 *
 * ## Contract / 不変条件
 *
 * **All per-type restart cooldown resolution MUST flow through the
 * `getRestartDelayMsForType(workerType)` module-level SSOT helper. The legacy
 * `WorkerSupervisorOptions.restartDelayMs?: number` field and the
 * `DEFAULT_RESTART_DELAY_MS = 1000` orphan constant MUST NOT exist anywhere
 * under `apps/mcp-server/src/`.**
 *
 * ## Why a standing regression / なぜ常設 regression か
 *
 * Plan v4.4 PR-N-A removes the legacy `restartDelayMs` constructor field +
 * `DEFAULT_RESTART_DELAY_MS = 1000` orphan constant in favour of the
 * ADR-0035 §Decision 3 canonical per-type helper. Without an AST sweep, a
 * future regression could silently reintroduce:
 *
 *   1. `restartDelayMs?: number` on `WorkerSupervisorOptions` (or any
 *      derived interface). This re-couples options-merge semantics to a
 *      single-value cooldown, breaking the per-type contract
 *      (`embedding-backfill 8000ms` vs `page 3000ms`).
 *   2. `const DEFAULT_RESTART_DELAY_MS = ...` constant. This is the orphan
 *      that PR-N-A removed; reintroduction would re-establish a stale
 *      fallback path that contradicts the SSOT.
 *
 * The Wave 5 LCC canonical CWE-209 PII protection pattern (anchor
 * `019df7ab-2f5a` EXPAND) established the equivalent rigor for
 * `audit_logs.target_id` SSOT length. The same forward-compat AST sweep is
 * applied here to the per-type restart delay contract.
 *
 * ## Why under worker-lifecycle domain / なぜ worker-lifecycle ドメインか
 *
 * Worker planned-restart cooldown is a worker-lifecycle integrity contract
 * (`INV-WORKER-LOCK-003` adjacent). Plan v4.1 CWE-770 41.67h/day DoS
 * boundary (PAGE_RESTART_DELAY_MS_MIN = 500) and Plan v4.3 PR-M-A per-type
 * cooldown (BACKFILL_RESTART_DELAY_MS_MIN = 500) both live in this domain.
 * INV-EMBEDDING-WORKER-INIT-001 already verifies per-type cooldown runtime
 * semantics; this INV adds the **structural AST gate** so future
 * regressions are caught at CI time.
 *
 * ## Scope (2 test cases) / スコープ (2 ケース)
 *
 * | # | Type             | Mode     | What it pins                                                       |
 * | - | ---------------- | -------- | ------------------------------------------------------------------ |
 * | 1 | AST sweep        | code     | No production file uses `DEFAULT_RESTART_DELAY_MS` identifier OR `restartDelayMs?: number` PropertySignature (forward-compat regression detector) |
 * | 2 | Runtime SSOT     | runtime  | `getRestartDelayMsForType("page")` returns 3000ms default + `getRestartDelayMsForType("embedding-backfill")` returns 8000ms default + env override path honoured |
 *
 * ## TDA-V44-PRN-RE-01 mandate / TDA mandate
 *
 * **Canonical pattern adoption**: this test MUST use the Wave 5 LCC canonical
 * `collectTypeScriptSources` inline helper (per
 * `apps/mcp-server/tests/regression/standing/gdpr-delete/inv-audit-emit-ssot-import-001.test.ts:188-242`).
 * Use of the `glob` library is **forbidden** (`glob` is NOT a dependency of
 * `apps/mcp-server/package.json`, fact-verified at PR-N-A landing).
 *
 * @see internal anchor `019e34c5-4480-76e5` (IO Plan Decision V1)
 * @see Plan v4.3 PR-M Phase 2 LCC Impl Audit canonical pattern anchor `019e30ad-9c3f`
 * @see Wave 5 LCC canonical pattern anchor `019df7ab-2f5a` (EXPAND)
 * @see ADR-0035 Amendment 1 §Decision 5
 * @see `apps/mcp-server/src/services/worker-supervisor.service.ts` (SSOT: `getRestartDelayMsForType`)
 * @see `apps/mcp-server/tests/regression/standing/worker-lifecycle/inv-embedding-worker-init-001-callback-exit-dispose.test.ts` (runtime semantic exemplar)
 * @module tests/regression/standing/worker-lifecycle/inv-worker-restart-delay-ssot-001-env-only
 */

import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Project, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";

// ============================================================================
// Constants / 定数
// ============================================================================

/**
 * Repository roots discovered relative to this test file.
 *
 * このテストファイルから相対計算したリポジトリ root の各 path。
 */
const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const SRC_ROOT = path.resolve(MCP_SERVER_ROOT, "src");

/**
 * Banned identifiers under `apps/mcp-server/src/`.
 *
 *   - `DEFAULT_RESTART_DELAY_MS` — orphan constant removed by PR-N-A
 *     (was the 1000ms test-coupling default that bypassed the per-type
 *     ADR-0035 §Decision 3 contract)
 *   - `restartDelayMs?: number` — legacy options field removed by PR-N-A
 *     (re-coupled options-merge to a single-value cooldown)
 *
 * apps/mcp-server/src/ 配下で禁止する識別子。
 */
const BANNED_CONST_IDENTIFIER = "DEFAULT_RESTART_DELAY_MS";
const BANNED_PROPERTY_NAME = "restartDelayMs";

// ============================================================================
// Helpers / ヘルパー
// ============================================================================

/**
 * Lazily-built ts-morph Project (AST parser only — no type checking).
 *
 * AST 解析専用 (型 check off)。Wave 5 LCC canonical
 * `createAstProject` パターンを採用。
 */
function createAstProject(): Project {
  return new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: {
      allowJs: false,
      strict: true,
    },
  });
}

/**
 * Recursively collect every `*.ts` file under `root`, excluding `dist/`,
 * `node_modules/`, and `.test.ts` / `.spec.ts` files. Returns absolute paths.
 *
 * Wave 5 LCC canonical pattern (TDA-V44-PRN-RE-01 mandate): this inline
 * helper is REQUIRED instead of the `glob` library (`glob` is NOT a
 * dependency of `apps/mcp-server/package.json`).
 *
 * 再帰的に `*.ts` を収集 (`dist/` / `node_modules/` / `.test.ts` / `.spec.ts` 除外)。
 * TDA-V44-PRN-RE-01 mandate により `glob` library 使用禁止、本 inline helper を使う。
 */
function collectTypeScriptSources(root: string, opts: { includeTests: boolean }): string[] {
  const out: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const isTest = entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts");
        if (!opts.includeTests && isTest) continue;
        if (opts.includeTests && !isTest) continue;
        out.push(full);
      }
    }
  }

  walk(root);
  return out;
}

// ============================================================================
// Test Suite
// ============================================================================

describe("INV-WORKER-RESTART-DELAY-SSOT-001: per-type restart cooldown SSOT — no `DEFAULT_RESTART_DELAY_MS` orphan constant + no `restartDelayMs?: number` legacy options field under `apps/mcp-server/src/` (Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5)", () => {
  let astProject: Project;
  let allSrcFiles: string[];
  let srcSourceFiles: SourceFile[];

  beforeAll(() => {
    astProject = createAstProject();
    allSrcFiles = collectTypeScriptSources(SRC_ROOT, { includeTests: false });
    srcSourceFiles = [];
    for (const abs of allSrcFiles) {
      srcSourceFiles.push(astProject.addSourceFileAtPath(abs));
    }
  });

  beforeEach(() => {
    // INV-WORKER-RESTART-DELAY-SSOT-001
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-RESTART-DELAY-SSOT-001");
  });

  // ==========================================================================
  // Test 1 — AST sweep: forward-compat regression detector
  //
  // (a) `DEFAULT_RESTART_DELAY_MS` identifier MUST have 0 occurrences in
  //     `VariableDeclaration` (the orphan constant removed by PR-N-A).
  // (b) `restartDelayMs?: number` MUST have 0 occurrences in
  //     `PropertySignature` (the legacy options field removed by PR-N-A).
  // (c) `restartDelayMs:` MUST have 0 occurrences in `PropertyAssignment`
  //     (the legacy options-merge target — defensive forward-compat).
  //
  // AST kind matching is per Wave 5 LCC canonical Test 8 parity
  // (PropertySignature + PropertyAssignment + VariableDeclaration).
  // ==========================================================================

  it("INV-WORKER-RESTART-DELAY-SSOT-001: AST sweep — no production file under `apps/mcp-server/src/` declares `DEFAULT_RESTART_DELAY_MS` constant OR `restartDelayMs?: number` PropertySignature OR `restartDelayMs:` PropertyAssignment (PR-N-A SSOT migration drift guard, Wave 5 LCC canonical AST pattern)", () => {
    // INV-WORKER-RESTART-DELAY-SSOT-001

    type Violation = {
      file: string;
      line: number;
      kind: "VariableDeclaration" | "PropertySignature" | "PropertyAssignment";
      snippet: string;
    };
    const violations: Violation[] = [];

    for (const sourceFile of srcSourceFiles) {
      const filePath = sourceFile.getFilePath();
      const relPath = path.relative(MCP_SERVER_ROOT, String(filePath));

      // (a) VariableDeclaration: `const DEFAULT_RESTART_DELAY_MS = ...`
      const varDecls = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
      for (const decl of varDecls) {
        const name = decl.getName();
        if (name === BANNED_CONST_IDENTIFIER) {
          violations.push({
            file: relPath,
            line: decl.getStartLineNumber(),
            kind: "VariableDeclaration",
            snippet: decl.getText().slice(0, 120),
          });
        }
      }

      // (b) PropertySignature: `restartDelayMs?: number` (interface/type field)
      const propSigs = sourceFile.getDescendantsOfKind(SyntaxKind.PropertySignature);
      for (const sig of propSigs) {
        const name = sig.getName();
        if (name === BANNED_PROPERTY_NAME) {
          violations.push({
            file: relPath,
            line: sig.getStartLineNumber(),
            kind: "PropertySignature",
            snippet: sig.getText().slice(0, 120),
          });
        }
      }

      // (c) PropertyAssignment: `restartDelayMs: ...` (object literal field)
      const propAssigns = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
      for (const assign of propAssigns) {
        const name = assign.getName();
        if (name === BANNED_PROPERTY_NAME) {
          violations.push({
            file: relPath,
            line: assign.getStartLineNumber(),
            kind: "PropertyAssignment",
            snippet: assign.getText().slice(0, 120),
          });
        }
      }
    }

    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  - ${v.file}:${v.line} (${v.kind})\n      ${v.snippet}`)
        .join("\n");
      expect.fail(
        `INV-WORKER-RESTART-DELAY-SSOT-001 violation: ${violations.length} occurrence(s) of the banned identifier(s) found under \`apps/mcp-server/src/\`.\n` +
          `Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5 removed these:\n` +
          `  - \`DEFAULT_RESTART_DELAY_MS\` orphan constant (was 1000ms test-coupling default)\n` +
          `  - \`restartDelayMs?: number\` legacy WorkerSupervisorOptions field\n` +
          `Use \`getRestartDelayMsForType(workerType)\` from \`worker-supervisor.service.ts\` instead.\n` +
          `Violations:\n${formatted}`
      );
    }
    expect(violations).toEqual([]);
  });

  // ==========================================================================
  // Test 2 — Runtime SSOT: `getRestartDelayMsForType` resolves canonical
  // per-type defaults + env-override path.
  //
  // This complements INV-EMBEDDING-WORKER-INIT-001 Test 3 by pinning the
  // post-PR-N-A semantic (no legacy `restartDelayMs` field fallback path
  // exists; the helper is the exclusive resolver).
  // ==========================================================================

  it("INV-WORKER-RESTART-DELAY-SSOT-001: runtime SSOT — `getRestartDelayMsForType('page')` returns 3000ms default + `getRestartDelayMsForType('embedding-backfill')` returns 8000ms default (ADR-0035 §Decision 3 canonical per-type contract)", async () => {
    // INV-WORKER-RESTART-DELAY-SSOT-001
    delete process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS;
    delete process.env.WORKER_RESTART_DELAY_MS;

    const supervisorModule = await import("../../../../src/services/worker-supervisor.service");
    const getRestartDelayMsForType = (
      supervisorModule as unknown as Record<string, ((workerType: string) => number) | undefined>
    ).getRestartDelayMsForType;

    if (typeof getRestartDelayMsForType !== "function") {
      expect.fail(
        "ADR-0035 §Decision 3 contract violation: " +
          "`getRestartDelayMsForType` is not exported from worker-supervisor.service.ts. " +
          "Plan v4.4 PR-N-A relies on this helper as the exclusive per-type SSOT."
      );
    }

    // Defaults: page 3000ms / embedding-backfill 8000ms (per ADR-0035 §Decision 3).
    expect(
      getRestartDelayMsForType("page"),
      "page default cooldown must be 3000ms (WORKER_RESTART_DELAY_MS default; Plan v4.1 CWE-770 boundary preserved)"
    ).toBe(3000);
    expect(
      getRestartDelayMsForType("embedding-backfill"),
      "embedding-backfill default cooldown must be 8000ms (EMBEDDING_BACKFILL_RESTART_DELAY_MS default; ADR-0035 §Decision 3)"
    ).toBe(8000);

    // Env override path: EMBEDDING_BACKFILL_RESTART_DELAY_MS=10000 + WORKER_RESTART_DELAY_MS=5000.
    process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS = "10000";
    process.env.WORKER_RESTART_DELAY_MS = "5000";

    expect(
      getRestartDelayMsForType("embedding-backfill"),
      "EMBEDDING_BACKFILL_RESTART_DELAY_MS env override (10000) must be honoured for embedding-backfill"
    ).toBe(10000);
    expect(
      getRestartDelayMsForType("page"),
      "WORKER_RESTART_DELAY_MS env override (5000) must be honoured for page (above 500ms CWE-770 boundary)"
    ).toBe(5000);

    // Cleanup
    delete process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS;
    delete process.env.WORKER_RESTART_DELAY_MS;
  });
});
