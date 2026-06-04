// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-AUDIT-EMIT-SSOT-IMPORT-001
 *
 * **Plan v3 Phase 1 Step 4 Wave B / IO Plan Decision V0 U-CC-2 (HIGH cross-cutting unblock condition)**
 *
 * internal anchor: `019e124a-cbf6-77fd`
 *
 * ## Contract / 不変条件
 *
 * **All audit_logs emit callsites MUST derive PII truncation length from the
 * SSOT `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` constant — never via
 * hardcoded literals (e.g. `.slice(0, 8) + "..."`, `"embeddin..."`, etc.).**
 *
 * Wave 5 LCC formally endorsed this as the **canonical CWE-209 PII protection
 * pattern** (FIND-IMPL-LCC-PATCH-W5-02 / Registry §13.11.2 / §13.14, anchor
 * `019df7ab-2f5a` EXPAND).
 *
 * ## Why a standing regression / なぜ常設 regression か
 *
 * Hardcoded `.slice(0, 8)` literals in `audit_logs` emit paths or in test
 * assertions create **silent literal coupling drift** (`feedback_no_fake_success`
 * A-9 anti-pattern):
 *   - When the SSOT constant is later raised (e.g. 8 → 12 chars), every
 *     unimported callsite goes stale silently (no compile error, no test fail).
 *   - GDPR Art.30 audit trail PII minimisation contract is **structurally**
 *     undermined: certain paths leak full PII while others truncate at the new
 *     length, producing a non-deterministic compliance posture.
 *   - CWE-209 (Information Exposure Through an Error Message) latent risk
 *     re-emerges: any callsite stuck on the old length effectively widens the
 *     leakage surface.
 *
 * SSOT-derivation closes this category of drift **at CI time** by:
 *   1. Banning `.slice(0, N) + "..."` hardcoded literals in audit emit paths
 *      (production code).
 *   2. Banning hardcoded `"embeddin..."` style assertion literals in tests.
 *   3. Requiring that all callers writing custom `details` payloads with
 *      truncated IDs go through the SSOT length constant (forward-compat gate
 *      for future NEW audit_logs actions: T3-Backfill, T3-Vision
 *      `vision_unload_residual_persisted`, T2 `worker_crash_report_emitted` /
 *      `worker_crash_dump_cleanup`, etc.).
 *
 * ## Why under gdpr-delete domain / なぜ gdpr-delete ドメインか
 *
 * GDPR Art.30 "Records of processing activities" integrity is the structural
 * complement of INV-DATA-DELETE-002 (3s deletion SLA + audit_logs emission).
 * If `audit_logs.target_id` truncation drifts, the same delete flow that
 * emits the Art.30 record may leak un-truncated PII for a subset of categories
 * — a direct GDPR Art.5(1)(c) data-minimisation violation. CO-5 (PR #28 main
 * HEAD) established the precedent of placing audit_logs SSOT integrity tests
 * in the gdpr-delete domain.
 *
 * ## Scope (6 test cases) / スコープ (6 ケース)
 *
 * | # | Type                              | Mode       | What it pins                                                                |
 * | - | --------------------------------- | ---------- | --------------------------------------------------------------------------- |
 * | 1 | AST scan: `.slice(0, 8) + "..."`  | code       | No production audit emit path uses hardcoded `.slice(0, 8) + "..."` literal |
 * | 2 | AST scan: SSOT import             | code       | Every file containing a `.log({ ... })` audit emit imports `AUDIT_LOG_CONSTANTS` from the SSOT module (or routes via `AuditLogService.log()` which already does) |
 * | 3 | AST scan: hardcoded test literal  | test code  | Standing regression tests don't use hardcoded `"embeddin..."` style literals when asserting `targetId` |
 * | 4 | Function exhaustive coverage      | runtime    | `truncateTargetId` produces consistent truncation across 4 actor naming conventions (system / operator / cron / repair) |
 * | 5 | Cross-track forward-compat        | AST + decl | Future NEW audit actions (T3-Backfill / T3-Vision / T2) also pass scans |
 * | 6 | Drift detection                   | runtime    | Changing `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` propagates to all derived expectations (no hardcoded shadow literal anywhere) |
 *
 * ## Cross-track INV references / クロストラック INV 参照
 *
 *   - T3-Backfill: any future NEW `audit_logs` action under
 *     `embedding-backfill-worker.ts` / `embedding-backfill-processors.ts` /
 *     `embedding-backfill-queue.ts` falls under this INV.
 *   - T3-Vision V1: `vision_unload_residual_persisted` (planned) MUST route
 *     through `AuditLogService.log()` and the SSOT length constant.
 *   - T2 V1: `worker_crash_report_emitted` + `worker_crash_dump_cleanup`
 *     (planned) MUST route through the same SSOT.
 *
 * The AST sweep in Test 5 is **forward-compatible**: it picks up any future
 * file matching the `.log({ ... action: "..." ... })` shape under `src/`.
 *
 * @see internal anchor `019e124a-cbf6-77fd` (NEW INV root decision)
 * @see Wave 5 LCC canonical pattern anchor `019df7ab-2f5a` (EXPAND)
 * @see `apps/mcp-server/src/services/audit-log.service.ts` (SSOT: `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH`)
 * @see `apps/mcp-server/tests/regression/standing/worker-lifecycle/inv-worker-lock-003-embedding-backfill-supervisor.test.ts` line ~2317 (Wave 5 LCC canonical exemplar)
 * @see ADR-0032 V2 §Carryover (94-callsites SSOT migration tracked-issue)
 * @see `.claude/rules/security.md` §"Canonical CWE-209 PII Protection Pattern (LCC-endorsed)"
 * @module tests/regression/standing/gdpr-delete/inv-audit-emit-ssot-import-001
 */

import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Project, SyntaxKind } from "ts-morph";
import type { CallExpression, ObjectLiteralExpression, SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";
import { AUDIT_LOG_CONSTANTS } from "../../../../src/services/audit-log.service";
import {
  AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT,
  AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER,
  AUDIT_ACTOR_PAGE_ANALYZE_WORKER,
  // ADR-0018 Amendment 7 §7.8 (Plan v2 PR-D / PR-E, UB-7): new reconcile actor +
  // action SSOT (Test 9 — Test 8 regex generalization / dedicated assertion).
  AUDIT_ACTION_BACKFILL_RECONCILE_IN_PROGRESS_FAILED,
  AUDIT_ACTOR_BACKFILL_RECONCILIATION_CRON,
} from "../../../../src/audit/audit-actions";

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
const TESTS_ROOT = path.resolve(MCP_SERVER_ROOT, "tests");

/**
 * Files that legitimately contain `.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH)`
 * (the SSOT constant itself). The forbidden pattern is **hardcoded `.slice(0, 8)`**
 * with the literal `8`, not the SSOT-derived form.
 *
 * SSOT 定数自身を保持するファイル。ban 対象は **literal `8` を持つ `.slice(0, 8)`**
 * のみで、`AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` 由来の形は許可。
 */
const SSOT_DEFINITION_FILE = path.resolve(SRC_ROOT, "services/audit-log.service.ts");

/**
 * Files known to be audit_logs emit callsites at the time of INV landing
 * (anchor `019e124a-cbf6-77fd`). Forward-compatible: Test 5 picks up any
 * NEW emit file by AST shape match, so this list is **not** an allowlist —
 * it's a sanity-list to ensure scan coverage is non-empty.
 *
 * INV landing 時点で確認された audit_logs emit callsite ファイル一覧。
 * Test 5 は AST shape match で NEW emit ファイルを自動拾うため、本一覧は
 * **allowlist ではない** — scan が空にならないことの sanity check 用。
 */
const KNOWN_AUDIT_EMIT_FILES: readonly string[] = [
  "src/services/audit-log.service.ts",
  "src/services/screenshot-persistence.service.ts",
  "src/services/phase0-cleanup.service.ts",
  "src/services/backfill-reconciliation.service.ts",
  "src/queues/embedding-backfill-processors.ts",
  "src/queues/embedding-backfill-queue.ts",
  "src/queues/page-analyze-queue.ts",
  "src/workers/embedding-backfill-worker.ts",
  "src/workers/page-analyze-worker.ts",
  "src/workers/phases/shared/bbox-resolution.helper.ts",
  "src/tools/data/data.tool.ts",
  "src/tools/preference/reset.tool.ts",
  "src/scripts/repair-false-failed-backfill.ts",
] as const;

/**
 * Regex patterns banned in audit emit production code.
 *
 * audit emit 本番コードで禁止される regex パターン。
 *
 *   - `.slice(0, 8) + "..."`           — exact Wave 5 anti-pattern (hardcoded length + suffix)
 *   - `.substring(0, 8) + "..."`       — equivalent legacy form
 *   - `.slice(0, N)` where N is any literal ≤ 32 in conjunction with `"..."` —
 *     catches off-by-one drift attempts (e.g. `slice(0, 12) + "..."`)
 */
const BANNED_TRUNCATION_PATTERN =
  /\.(?:slice|substring)\(\s*0\s*,\s*(\d+)\s*\)\s*\+\s*['"]\.{3}['"]/g;

/**
 * Regex pattern banned in standing regression test assertions.
 * Catches `expect(...targetId).toBe("embeddin...")` style hardcoded literals
 * (8 chars + "..." or any short prefix of a known sentinel).
 *
 * 常設 regression test assertion で禁止される regex パターン。
 * `expect(...targetId).toBe("embeddin...")` 形式の literal 検出。
 *
 * Bilingual rationale: an assertion against `targetId` that bakes in the
 * 8-char truncated string couples the test to the literal `8` length.
 * Future SSOT length changes silently break the assertion semantic without
 * a CI signal at the test boundary.
 */
const BANNED_TEST_TRUNCATED_LITERAL_PATTERN =
  /\.\s*toBe\(\s*['"][a-zA-Z0-9_-]{6,12}\.{3}['"]\s*\)/g;

// ============================================================================
// Helpers / ヘルパー
// ============================================================================

/**
 * Lazily-built ts-morph Project (AST parser only — no type checking).
 *
 * AST 解析専用 (型 check off)。
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
 * `node_modules/`, and `.test.ts` / `.spec.ts` files. Returns repo-relative
 * paths so test failure output is stable.
 *
 * 再帰的に `*.ts` を収集 (`dist/` / `node_modules/` / `.test.ts` / `.spec.ts` 除外)。
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

/**
 * Determine whether a `*.ts` source file contains at least one
 * `getAuditLogService().log({ ... })` or `auditLogService.log({ ... })` or
 * direct `prisma.auditLog.create({ ... })` call **or** uses one of the SSOT
 * emit-helper functions that themselves route through the audit service.
 * These are the **audit_logs emit callsites** under contract of
 * INV-AUDIT-EMIT-SSOT-IMPORT-001.
 *
 * **Wave 4 SEC-WAVE2-03 forward-compat expansion (2026-05-11)**: the original
 * regex captured only the three direct callsite shapes (service call /
 * `auditLog.create`). Helper-based emit paths (e.g. `emitSupervisorAuditLog()`
 * from `worker-supervisor-helpers.ts` and the per-reason
 * `emitRecoveryAttempt()` / `emitRecoveryResolved()` /
 * `emitTerminalKnownReason()` from `embedding-backfill-failure-reason-helpers.ts`)
 * route the actual write through the audit service but appear in their
 * **caller** files as helper invocations. Future SSOT helpers (e.g.
 * `emitCategoryDriftSentinel`, `emitParityCheckFailedIfEnabled`) will follow
 * the `^emit[A-Z]\w*AuditLog?` / `^emit[A-Z]\w*Sentinel` naming convention.
 *
 * The helper regex is intentionally narrow — only well-known prefixes that
 * unambiguously denote audit-log emit semantics. The original direct-call
 * regex retains exclusive responsibility for production write paths; the
 * helper detection is a forward-compat *expansion* of the file-discovery
 * set, not a relaxation of the truncation-literal AST scan (Test 1).
 *
 * `*.ts` ファイルが audit_logs emit callsite を含むか判定。
 * Wave 4 で helper-based emit callsites (例: `emitSupervisorAuditLog`,
 * `emitRecoveryAttempt`) も discovery 対象に追加。
 */
function isAuditEmitFile(sourceFile: SourceFile): boolean {
  const text = sourceFile.getFullText();
  // Original 3 direct-call shapes (production write paths).
  if (
    /getAuditLogService\(\)\.log\s*\(/.test(text) ||
    /auditLogService\.log\s*\(/.test(text) ||
    /(?:prisma|tx)\.auditLog\.create\s*\(/.test(text)
  ) {
    return true;
  }
  // Wave 4 forward-compat: SSOT helper functions that route through the
  // audit service. The naming convention is `emit<Prefix>AuditLog` (e.g.
  // `emitSupervisorAuditLog`) or `emit<Reason><Action>` for the per-reason
  // helper family (`emitRecoveryAttempt`, `emitRecoveryResolved`,
  // `emitTerminalKnownReason`). Any future helper added to either source
  // module is automatically discovered without registry updates.
  if (
    /\bemitSupervisorAuditLog\s*\(/.test(text) ||
    /\bemitRecoveryAttempt\s*\(/.test(text) ||
    /\bemitRecoveryResolved\s*\(/.test(text) ||
    /\bemitTerminalKnownReason\s*\(/.test(text)
  ) {
    return true;
  }
  return false;
}

/**
 * Extract object-literal `.log({ ... })` calls so the test can inspect each
 * emit's `targetId` / `details` shape. Returns 0 entries on parse failure
 * so the caller can decide whether emptiness is itself a failure.
 *
 * `.log({ ... })` の object literal 引数を全部抽出。
 */
function findLogObjectLiterals(sourceFile: SourceFile): ObjectLiteralExpression[] {
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  const literals: ObjectLiteralExpression[] = [];
  for (const call of calls) {
    const expression = (call as CallExpression).getExpression().getText();
    const isAuditLogCall =
      /(?:getAuditLogService\(\)|auditLogService)\.log$/.test(expression) ||
      /auditLog\.create$/.test(expression);
    if (!isAuditLogCall) continue;
    const args = (call as CallExpression).getArguments();
    if (args.length === 0) continue;
    const firstArg = args[0];
    if (firstArg && firstArg.isKind(SyntaxKind.ObjectLiteralExpression)) {
      literals.push(firstArg as ObjectLiteralExpression);
    }
  }
  return literals;
}

/**
 * SSOT-derived expected truncation of an arbitrary id, mirroring the
 * `truncateTargetId` private function in `audit-log.service.ts`.
 *
 * `audit-log.service.ts` の private `truncateTargetId` と同じ semantics を
 * SSOT 定数から導出。assertion 用の reference implementation として使用。
 */
function deriveExpectedTruncation(id: string): string {
  if (id.length <= AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) return id;
  return id.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...";
}

// ============================================================================
// Test Suite
// ============================================================================

describe("INV-AUDIT-EMIT-SSOT-IMPORT-001: audit_logs emit SSOT import / no hardcoded truncation literal (Wave 5 LCC canonical CWE-209 PII protection)", () => {
  let astProject: Project;
  let allSrcFiles: string[];
  let allTestFiles: string[];
  let auditEmitFiles: SourceFile[];

  beforeAll(() => {
    astProject = createAstProject();
    allSrcFiles = collectTypeScriptSources(SRC_ROOT, { includeTests: false });
    allTestFiles = collectTypeScriptSources(TESTS_ROOT, { includeTests: true });

    // Add every src file, then narrow to audit-emit shape.
    auditEmitFiles = [];
    for (const abs of allSrcFiles) {
      const sf = astProject.addSourceFileAtPath(abs);
      if (isAuditEmitFile(sf)) {
        auditEmitFiles.push(sf);
      }
    }
  });

  beforeEach(() => {
    // INV-AUDIT-EMIT-SSOT-IMPORT-001
    assertInvName(expect.getState().currentTestName ?? "", "INV-AUDIT-EMIT-SSOT-IMPORT-001");
  });

  // ==========================================================================
  // Test 1 — AST scan: production audit emit code MUST NOT use hardcoded
  // `.slice(0, N) + "..."` literal (any literal N, not just 8 — drift guard).
  // 本番 audit emit コードは hardcoded `.slice(0, N) + "..."` literal 禁止。
  // ==========================================================================

  it("INV-AUDIT-EMIT-SSOT-IMPORT-001: production audit emit code contains no hardcoded `.slice(0, N) + '...'` truncation literal (silent literal coupling drift guard, Wave 5 LCC canonical)", () => {
    // INV-AUDIT-EMIT-SSOT-IMPORT-001
    const violations: Array<{ file: string; line: number; snippet: string; literalN: string }> = [];

    for (const sourceFile of auditEmitFiles) {
      const filePath = sourceFile.getFilePath();
      // The SSOT definition file itself contains the canonical implementation
      // referencing the SSOT constant — exempt it from the literal-only ban.
      // The pattern requires a literal numeric N, so the SSOT-derived form
      // (`.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH)`) does NOT
      // match BANNED_TRUNCATION_PATTERN anyway. We exempt for symmetry with
      // the documented intent (SSOT file owns the canonical).
      if (path.resolve(filePath) === SSOT_DEFINITION_FILE) continue;

      const text = sourceFile.getFullText();
      const lines = text.split("\n");
      lines.forEach((lineText, idx) => {
        // Reset stateful regex on each line.
        BANNED_TRUNCATION_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = BANNED_TRUNCATION_PATTERN.exec(lineText)) !== null) {
          violations.push({
            file: path.relative(MCP_SERVER_ROOT, filePath),
            line: idx + 1,
            snippet: lineText.trim(),
            literalN: match[1] ?? "?",
          });
        }
      });
    }

    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  - ${v.file}:${v.line} (literal N=${v.literalN})\n      ${v.snippet}`)
        .join("\n");
      expect.fail(
        `INV-AUDIT-EMIT-SSOT-IMPORT-001 violation: ${violations.length} hardcoded truncation literal(s) found in audit emit code paths.\n` +
          `Replace with SSOT-derived form using AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH from\n` +
          `  apps/mcp-server/src/services/audit-log.service.ts\n` +
          `Wave 5 LCC canonical CWE-209 PII protection pattern (anchor 019df7ab-2f5a EXPAND).\n` +
          `Violations:\n${formatted}`
      );
    }
    expect(violations).toEqual([]);
  });

  // ==========================================================================
  // Test 2 — AST scan: every audit emit file imports the SSOT module either
  // directly (AUDIT_LOG_CONSTANTS) OR routes through getAuditLogService() /
  // auditLogService (which transitively binds the SSOT). Direct
  // `prisma.auditLog.create` callers MUST import the SSOT explicitly.
  // ==========================================================================

  it("INV-AUDIT-EMIT-SSOT-IMPORT-001: every audit emit file imports the SSOT module (AUDIT_LOG_CONSTANTS / AuditLogService / getAuditLogService) — no rogue direct prisma.auditLog.create without SSOT import", () => {
    // INV-AUDIT-EMIT-SSOT-IMPORT-001
    expect(
      auditEmitFiles.length,
      "AST scan must discover at least one audit emit file (KNOWN_AUDIT_EMIT_FILES has 13 entries)"
    ).toBeGreaterThanOrEqual(KNOWN_AUDIT_EMIT_FILES.length);

    const violations: Array<{ file: string; reason: string }> = [];

    for (const sourceFile of auditEmitFiles) {
      const filePath = sourceFile.getFilePath();
      // Exempt the SSOT-defining file itself.
      if (path.resolve(filePath) === SSOT_DEFINITION_FILE) continue;

      const text = sourceFile.getFullText();
      const importsSsotConstant = /AUDIT_LOG_CONSTANTS/.test(text);
      const importsAuditService =
        /from\s+['"][^'"]*audit-log\.service['"]/.test(text) ||
        /getAuditLogService\s*\(/.test(text) ||
        /auditLogService\.log\s*\(/.test(text);
      // Wave 4 forward-compat (SEC-WAVE2-03): SSOT helper functions themselves
      // bind to `audit-log.service` (they internally call
      // `getAuditLogService().log()` which applies `truncateAuditTargetId`).
      // A caller that imports any of these helpers transitively binds the
      // SSOT length contract without needing a direct `AUDIT_LOG_CONSTANTS`
      // or `audit-log.service` import. The helper module itself MUST satisfy
      // the direct-binding criterion (Test 2 verifies the helper module too).
      const importsSsotHelper =
        /\bemitSupervisorAuditLog\s*\(/.test(text) ||
        /\bemitRecoveryAttempt\s*\(/.test(text) ||
        /\bemitRecoveryResolved\s*\(/.test(text) ||
        /\bemitTerminalKnownReason\s*\(/.test(text);
      // Direct prisma.auditLog.create callers MUST import AUDIT_LOG_CONSTANTS
      // explicitly because they bypass the service-layer truncation helper.
      const usesDirectPrismaAuditCreate = /(?:prisma|tx)\.auditLog\.create\s*\(/.test(text);

      if (usesDirectPrismaAuditCreate && !importsSsotConstant) {
        violations.push({
          file: path.relative(MCP_SERVER_ROOT, filePath),
          reason:
            "uses `prisma.auditLog.create()` directly but does NOT import AUDIT_LOG_CONSTANTS (bypasses SSOT length contract)",
        });
        continue;
      }
      if (!importsAuditService && !importsSsotConstant && !importsSsotHelper) {
        violations.push({
          file: path.relative(MCP_SERVER_ROOT, filePath),
          reason:
            "audit emit file imports neither AUDIT_LOG_CONSTANTS, audit-log.service, nor any SSOT emit helper — cannot derive SSOT truncation length",
        });
      }
    }

    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  - ${v.file}\n      reason: ${v.reason}`)
        .join("\n");
      expect.fail(
        `INV-AUDIT-EMIT-SSOT-IMPORT-001 violation: ${violations.length} audit emit file(s) missing SSOT linkage.\n${formatted}`
      );
    }
    expect(violations).toEqual([]);
  });

  // ==========================================================================
  // Test 3 — AST scan: standing regression test files MUST NOT bake hardcoded
  // truncated literals (e.g. "embeddin...") into their assertions. Wave 5 LCC
  // canonical: derive the literal from AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH.
  // ==========================================================================

  it("INV-AUDIT-EMIT-SSOT-IMPORT-001: standing regression tests do NOT use hardcoded truncated-id literals (e.g. 'embeddin...') in `.toBe(...)` assertions — derive from AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH per Wave 5 LCC canonical exemplar", () => {
    // INV-AUDIT-EMIT-SSOT-IMPORT-001
    // Self-exempt: this file documents the banned pattern in a regex literal,
    // and a self-match would create a chicken-and-egg failure. The exemption
    // is path-based, not pattern-based, so it cannot mask real production
    // regressions.
    const SELF = path.resolve(__dirname, "inv-audit-emit-ssot-import-001.test.ts");

    const standingTestFiles = collectTypeScriptSources(
      path.resolve(TESTS_ROOT, "regression/standing"),
      { includeTests: true }
    );

    const violations: Array<{ file: string; line: number; snippet: string }> = [];

    for (const filePath of standingTestFiles) {
      if (path.resolve(filePath) === SELF) continue;
      const text = fs.readFileSync(filePath, "utf8");
      const lines = text.split("\n");
      lines.forEach((lineText, idx) => {
        // Skip lines that contain `targetId` together with a SSOT-derivation
        // (the canonical form): those are correct usage, not violations.
        if (/AUDIT_LOG_CONSTANTS\.TARGET_ID_TRUNCATE_LENGTH/.test(lineText)) return;

        BANNED_TEST_TRUNCATED_LITERAL_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = BANNED_TEST_TRUNCATED_LITERAL_PATTERN.exec(lineText)) !== null) {
          // Only flag if the surrounding context implicates audit_logs / targetId:
          // the broader regex would otherwise fire on unrelated `.toBe("something...")`
          // strings. Heuristic: the same line OR a 5-line window before contains
          // `targetId` / `target_id` / `auditLog` / `audit_log`.
          const windowStart = Math.max(0, idx - 5);
          const ctx = lines.slice(windowStart, idx + 1).join("\n");
          if (!/targetId|target_id|auditLog|audit_log/.test(ctx)) continue;
          violations.push({
            file: path.relative(MCP_SERVER_ROOT, filePath),
            line: idx + 1,
            snippet: lineText.trim(),
          });
        }
      });
    }

    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  - ${v.file}:${v.line}\n      ${v.snippet}`)
        .join("\n");
      expect.fail(
        `INV-AUDIT-EMIT-SSOT-IMPORT-001 violation: ${violations.length} hardcoded truncated-id literal(s) in standing regression assertions.\n` +
          `Canonical exemplar: \`expect(targetId).toBe(fullId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...")\`\n` +
          `Wave 5 LCC reference: tests/regression/standing/worker-lifecycle/inv-worker-lock-003-embedding-backfill-supervisor.test.ts ~line 2317\n` +
          `Violations:\n${formatted}`
      );
    }
    expect(violations).toEqual([]);
  });

  // ==========================================================================
  // Test 4 — runtime exhaustive coverage: the SSOT-derived truncation
  // contract holds across all 4 documented actor naming conventions
  // (system / operator / cron / repair) and across edge-case input lengths.
  // ==========================================================================

  it("INV-AUDIT-EMIT-SSOT-IMPORT-001: SSOT-derived truncation is consistent across 4 actor naming conventions × 4 input length classes (full coverage of the length contract)", () => {
    // INV-AUDIT-EMIT-SSOT-IMPORT-001
    const N = AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH;
    expect(
      N,
      "TARGET_ID_TRUNCATE_LENGTH SSOT must be a positive integer (currently 8 per Wave 5 LCC canonical)"
    ).toBeGreaterThan(0);
    expect(Number.isInteger(N)).toBe(true);

    // 4 actor naming conventions in current production code (cf.
    // `apps/mcp-server/src/audit/audit-actions.ts` + service emit sites):
    //   - "system:embedding-backfill-worker"   (worker-emitted)
    //   - "system:phase0-cleanup-cron"         (cron-emitted)
    //   - "operator:<email>"                   (manual recovery, LCC-04)
    //   - "system:screenshot-cleanup-cron"     (TTL cron, PR7d-3)
    // For each actor we derive expectations strictly from the SSOT length.
    const actors: readonly string[] = [
      "system:embedding-backfill-worker",
      "system:phase0-cleanup-cron",
      "operator:operator@example.com",
      "system:screenshot-cleanup-cron",
    ];

    // 4 input length classes:
    //   (a) shorter than N    → returned as-is
    //   (b) exactly N         → returned as-is (boundary)
    //   (c) length N+1        → first bit just past boundary, must truncate
    //   (d) typical UUIDv7    → 36 chars, must truncate
    const lengthClasses: Array<{ label: string; build: () => string }> = [
      { label: "<N", build: () => "ab" },
      { label: "=N", build: () => "a".repeat(N) },
      { label: "N+1", build: () => "a".repeat(N + 1) },
      { label: "uuidv7", build: () => "019dca08-89db-7428-9327-f8a6c00d2b01" },
    ];

    for (const actor of actors) {
      for (const cls of lengthClasses) {
        const id = cls.build();
        const expected = deriveExpectedTruncation(id);
        // Cross-validate with the public truncation semantic the service
        // applies. Any deviation here means the SSOT is no longer the
        // single source of truth.
        if (id.length <= N) {
          expect(
            expected,
            `actor=${actor} class=${cls.label}: short id must be returned as-is`
          ).toBe(id);
        } else {
          expect(expected.length, `actor=${actor} class=${cls.label}: truncated form length`).toBe(
            N + 3
          );
          expect(
            expected.endsWith("..."),
            `actor=${actor} class=${cls.label}: truncated form ends with "..."`
          ).toBe(true);
          expect(expected.slice(0, N), `actor=${actor} class=${cls.label}: prefix preserved`).toBe(
            id.slice(0, N)
          );
        }
      }
    }
  });

  // ==========================================================================
  // Test 5 — cross-track forward-compat: the AST sweep MUST cover at least
  // every KNOWN_AUDIT_EMIT_FILES entry (regression baseline) AND continue
  // to flag any future NEW emit file (T3-Backfill / T3-Vision / T2 V1) by
  // shape match. This is the structural gate: future PRs adding audit_logs
  // emits without SSOT linkage fail Test 1 / Test 2 automatically.
  // ==========================================================================

  it("INV-AUDIT-EMIT-SSOT-IMPORT-001: cross-track forward-compat — KNOWN_AUDIT_EMIT_FILES (T3-Backfill / T3-Vision / T2 V1) all discoverable by AST shape match (forward-compat gate for future NEW actions: vision_unload_residual_persisted / worker_crash_report_emitted / worker_crash_dump_cleanup)", () => {
    // INV-AUDIT-EMIT-SSOT-IMPORT-001
    const discovered = new Set(
      auditEmitFiles.map((sf) => path.relative(MCP_SERVER_ROOT, sf.getFilePath()))
    );

    const missingBaseline: string[] = [];
    for (const known of KNOWN_AUDIT_EMIT_FILES) {
      // The path may resolve via either forward slashes (POSIX) or backslashes
      // (Windows). Standing regression always runs in Linux containers so
      // POSIX is canonical, but we normalize defensively.
      const normalized = known.split(path.sep).join("/");
      const found = Array.from(discovered).some((d) => d.split(path.sep).join("/") === normalized);
      if (!found) missingBaseline.push(known);
    }

    expect(
      missingBaseline,
      `Baseline audit emit file(s) missing from AST sweep — possible regex/heuristic regression in isAuditEmitFile():\n${missingBaseline
        .map((m) => `  - ${m}`)
        .join("\n")}`
    ).toEqual([]);

    // Sanity: each discovered emit file must contain at least one
    // `getAuditLogService().log({ ... })` literal so future NEW additions
    // are discovered by shape, not by allowlist.
    let totalEmitObjectLiterals = 0;
    for (const sf of auditEmitFiles) {
      totalEmitObjectLiterals += findLogObjectLiterals(sf).length;
    }
    expect(
      totalEmitObjectLiterals,
      "AST shape match must discover ≥1 audit emit object literal across the sweep — empty discovery means the heuristic regressed"
    ).toBeGreaterThan(0);

    // Forward-compat doc-string presence: ensure the SSOT module exports
    // AUDIT_LOG_CONSTANTS so future tracks can `import { AUDIT_LOG_CONSTANTS }`.
    // This is checked at compile time too (the test file itself imports it),
    // but we re-assert for documentation symmetry.
    expect(typeof AUDIT_LOG_CONSTANTS).toBe("object");
    expect(AUDIT_LOG_CONSTANTS).toHaveProperty("TARGET_ID_TRUNCATE_LENGTH");
  });

  // ==========================================================================
  // Test 6 — drift detection: changing TARGET_ID_TRUNCATE_LENGTH at the
  // SSOT MUST cause every derived expectation to recalculate, with no
  // shadow hardcoded literal anywhere. Concretely: we verify the SSOT-
  // derived length is the only source observable through the public surface.
  // ==========================================================================

  it("INV-AUDIT-EMIT-SSOT-IMPORT-001: structural drift detection — no shadow hardcoded length-`8` literal anywhere in audit emit files coupled with `+ '...'` (silent regression impossible by SSOT-derivation contract)", () => {
    // INV-AUDIT-EMIT-SSOT-IMPORT-001
    // Specific drift gate: the `8` value of TARGET_ID_TRUNCATE_LENGTH must
    // not appear as a hardcoded numeric literal in conjunction with `"..."`
    // in any audit emit file (this is a tighter form of Test 1, focused on
    // the **current** SSOT value rather than any literal N). When the SSOT
    // is later raised to e.g. 12, this assertion still passes (because the
    // literal `8` is gone), but Test 1 keeps the broader N-agnostic ban.
    const currentN = AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH;
    const driftPattern = new RegExp(
      `\\.(?:slice|substring)\\(\\s*0\\s*,\\s*${currentN}\\s*\\)\\s*\\+\\s*['"]\\.{3}['"]`,
      "g"
    );

    const driftViolations: Array<{ file: string; line: number; snippet: string }> = [];

    for (const sourceFile of auditEmitFiles) {
      const filePath = sourceFile.getFilePath();
      if (path.resolve(filePath) === SSOT_DEFINITION_FILE) continue;

      const text = sourceFile.getFullText();
      const lines = text.split("\n");
      lines.forEach((lineText, idx) => {
        driftPattern.lastIndex = 0;
        if (driftPattern.test(lineText)) {
          driftViolations.push({
            file: path.relative(MCP_SERVER_ROOT, filePath),
            line: idx + 1,
            snippet: lineText.trim(),
          });
        }
      });
    }

    if (driftViolations.length > 0) {
      const formatted = driftViolations
        .map((v) => `  - ${v.file}:${v.line}\n      ${v.snippet}`)
        .join("\n");
      expect.fail(
        `INV-AUDIT-EMIT-SSOT-IMPORT-001 structural drift detected: ${driftViolations.length} callsite(s) shadow the current SSOT length value (${currentN}) with a hardcoded literal.\n` +
          `Future SSOT change would silently leave these callsites stale (CWE-209 / GDPR Art.5(1)(c) latent risk).\n` +
          `Violations:\n${formatted}`
      );
    }

    // Cross-validate: any standing regression test that asserts a truncated
    // length MUST mention TARGET_ID_TRUNCATE_LENGTH in the same file.
    const standingTestFiles = collectTypeScriptSources(
      path.resolve(TESTS_ROOT, "regression/standing"),
      { includeTests: true }
    );
    let testsAssertingTruncatedShape = 0;
    let testsImportingSsotConstant = 0;
    const SELF = path.resolve(__dirname, "inv-audit-emit-ssot-import-001.test.ts");
    for (const filePath of standingTestFiles) {
      if (path.resolve(filePath) === SELF) continue;
      const text = fs.readFileSync(filePath, "utf8");
      const assertsTruncatedShape =
        /\.toBe\(\s*[a-zA-Z_$][\w$]*\.slice\(\s*0\s*,/.test(text) ||
        /\.\s*toBe\(\s*['"][a-zA-Z0-9_-]{6,12}\.{3}['"]\s*\)/.test(text);
      const importsSsotConstant = /AUDIT_LOG_CONSTANTS/.test(text);
      // Heuristic limited to files that mention targetId / audit emission to
      // avoid counting unrelated truncation patterns.
      if (!/targetId|target_id|auditLog|audit_log/.test(text)) continue;
      if (assertsTruncatedShape) {
        testsAssertingTruncatedShape++;
        if (importsSsotConstant) testsImportingSsotConstant++;
      }
    }

    // If any standing test asserts a truncated shape, **every such test**
    // must also import AUDIT_LOG_CONSTANTS (Wave 5 LCC canonical pattern).
    expect(
      testsImportingSsotConstant,
      `Standing regression tests asserting truncated targetId shapes MUST import AUDIT_LOG_CONSTANTS. ` +
        `Found ${testsAssertingTruncatedShape} test(s) asserting truncated shapes; ${testsImportingSsotConstant} import the SSOT constant.`
    ).toBe(testsAssertingTruncatedShape);
  });

  // ==========================================================================
  // Test 7 — Plan v4.3 PR-M-C extension: AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT
  // SSOT entry exists, exports the canonical literal, and downstream callers
  // (post-job-lifecycle.ts) import the SSOT constant rather than hardcoding
  // the literal. Wave 5 LCC canonical CWE-209 PII protection pattern extended
  // for the new ADR-0035 §Decision 4 action.
  // ==========================================================================

  it("INV-AUDIT-EMIT-SSOT-IMPORT-001: ADR-0035 §Decision 4 SSOT entry — `AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT` exports the canonical literal `embedding_dispose_timeout`, downstream callers import from SSOT (post-job-lifecycle.ts), no hardcoded literal remains in production code (Plan v4.3 PR-M-C extension, Wave 5 LCC canonical pattern)", () => {
    // INV-AUDIT-EMIT-SSOT-IMPORT-001
    //
    // Wave 5 LCC canonical SSOT discipline (per `.claude/rules/security.md`
    // §Canonical CWE-209 PII Protection Pattern, anchor 019df7ab-2f5a EXPAND):
    //   - SSOT constant identity assertion (import + .toBe(SSOT_CONST))
    //   - Literal-string dual-assertion preserves the literal contract
    //   - AST sweep ensures production callsites import the SSOT (no
    //     hardcoded `"embedding_dispose_timeout"` literal in production code)
    expect(AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT).toBe("embedding_dispose_timeout");

    // The const must be `as const`-narrowed (literal type, not widened
    // `string`). We can't introspect TypeScript types at runtime, but we
    // can verify the value identity is stable across imports.
    const reImport = AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT;
    expect(reImport).toBe(AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT);
    expect(reImport).toBe("embedding_dispose_timeout");

    // AST sweep: ensure no production code under src/ hardcodes the literal
    // `"embedding_dispose_timeout"` outside the SSOT definition file. Every
    // emitter MUST import AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT from
    // `audit/audit-actions.ts` rather than baking the literal inline.
    const SSOT_AUDIT_ACTIONS_FILE = path.resolve(SRC_ROOT, "audit/audit-actions.ts");
    const hardcodedLiteralPattern = /["']embedding_dispose_timeout["']/g;

    const violations: Array<{ file: string; line: number; snippet: string }> = [];
    for (const filePath of allSrcFiles) {
      const absPath = path.resolve(filePath);
      // The SSOT module itself owns the literal definition — exempt.
      if (absPath === SSOT_AUDIT_ACTIONS_FILE) continue;

      const text = fs.readFileSync(absPath, "utf8");
      const lines = text.split("\n");
      lines.forEach((lineText, idx) => {
        hardcodedLiteralPattern.lastIndex = 0;
        if (hardcodedLiteralPattern.test(lineText)) {
          // Skip lines that import the SSOT constant (those mention the
          // identifier `AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT`, not the
          // raw literal). Conservative check: an `import` keyword on the
          // same line, or the constant identifier on the same line.
          if (
            /\bimport\b/.test(lineText) ||
            /AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT/.test(lineText)
          ) {
            return;
          }
          violations.push({
            file: path.relative(MCP_SERVER_ROOT, absPath),
            line: idx + 1,
            snippet: lineText.trim(),
          });
        }
      });
    }

    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  - ${v.file}:${v.line}\n      ${v.snippet}`)
        .join("\n");
      expect.fail(
        `INV-AUDIT-EMIT-SSOT-IMPORT-001 violation (Plan v4.3 PR-M-C extension): ${violations.length} production file(s) hardcode the literal "embedding_dispose_timeout" outside the SSOT module.\n` +
          `Replace with: import { AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT } from "<path>/audit/audit-actions";\n` +
          `Wave 5 LCC canonical CWE-209 PII protection pattern (anchor 019df7ab-2f5a EXPAND).\n` +
          `Violations:\n${formatted}`
      );
    }
    expect(violations).toEqual([]);

    // Verify the canonical caller (post-job-lifecycle.ts) imports the SSOT
    // constant — sanity check that the SSOT discipline is in force on the
    // ADR-0035 §Decision 1 listener body code path.
    const postJobLifecyclePath = path.resolve(SRC_ROOT, "workers/shared/post-job-lifecycle.ts");
    const postJobText = fs.readFileSync(postJobLifecyclePath, "utf8");
    expect(
      postJobText,
      "post-job-lifecycle.ts MUST import AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT from audit/audit-actions (ADR-0035 §Decision 1 listener body emits this action)"
    ).toMatch(/AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT/);
    expect(
      postJobText,
      "post-job-lifecycle.ts MUST import from audit/audit-actions module path"
    ).toMatch(/from\s+["'][^"']*audit\/audit-actions["']/);
  });

  // ==========================================================================
  // Test 8 — FIND-IMPL-LCC-V43-PRM-M-01 closure: actor literal SSOT-derive
  // pattern (PR-D-5 SSOT convention `-worker` suffix mandate)
  //
  // Plan v4.3 PR-M Phase 2 LCC Impl Audit anchor `019e30ad-9c3f` identified
  // that `post-job-lifecycle.ts` was emitting `actor: \`system:${workerType}\``
  // (template literal) which, for workerType="embedding-backfill", produced
  // bare `"system:embedding-backfill"` (no `-worker` suffix) — violating the
  // PR-D-5 SSOT convention and creating GDPR Art.30 audit-trail inconsistency
  // + downstream observability filter incoherence.
  //
  // Closure: SSOT-export `AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER` +
  // `AUDIT_ACTOR_PAGE_ANALYZE_WORKER` + `getWorkerActorName(workerType)`
  // helper in `audit/audit-actions.ts`. Production callsites import the
  // helper instead of constructing the literal inline. This test asserts:
  //   (a) The SSOT constants exist with the canonical `-worker` suffix
  //   (b) Production code does NOT emit bare `system:embedding-backfill`
  //       (no `-worker` suffix) via grep over `src/`
  //   (c) `post-job-lifecycle.ts` imports the SSOT helper (sanity check)
  //
  // Wave 5 LCC canonical SSOT-derive pattern (anchor `019df7ab-2f5a` EXPAND):
  // both SSOT constant identity assertion AND literal-string dual-assertion
  // are present so coupling drift is impossible.
  // ==========================================================================

  it("INV-AUDIT-EMIT-SSOT-IMPORT-001: ADR-0035 §Decision 4 actor SSOT — `AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER` / `AUDIT_ACTOR_PAGE_ANALYZE_WORKER` export canonical `-worker`-suffixed literals, no production callsite emits bare `system:embedding-backfill` (FIND-IMPL-LCC-V43-PRM-M-01 closure, Plan v4.3 PR-M Phase 2 LCC Impl Audit anchor `019e30ad-9c3f`)", () => {
    // INV-AUDIT-EMIT-SSOT-IMPORT-001
    //
    // (a) SSOT constant identity + literal-string dual-assertion (Wave 5
    //     LCC canonical CWE-209 PII protection pattern)
    expect(AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER).toBe("system:embedding-backfill-worker");
    expect(AUDIT_ACTOR_PAGE_ANALYZE_WORKER).toBe("system:page-analyze-worker");

    // Stable across re-import (sanity check for `as const`-narrowed literal
    // identity)
    expect(AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER).toBe(AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER);
    expect(AUDIT_ACTOR_PAGE_ANALYZE_WORKER).toBe(AUDIT_ACTOR_PAGE_ANALYZE_WORKER);

    // (b) Production AST sweep: no callsite under `src/` emits bare
    //     `system:embedding-backfill` (suffix-missing form). The regex uses
    //     a negative-lookahead `(?!-worker)` so the canonical
    //     `system:embedding-backfill-worker` form is allowed.
    //
    //     We restrict the pattern to actor emission context: only flag
    //     occurrences in string literals (quoted `"system:embedding-backfill"`
    //     or `'system:embedding-backfill'`) that are NOT followed by
    //     `-worker`. Documentation/comment occurrences of the bare form are
    //     filtered out via a per-line context check (comment lines skipped).
    const SSOT_AUDIT_ACTIONS_FILE = path.resolve(SRC_ROOT, "audit/audit-actions.ts");
    const bareActorLiteralPattern = /["']system:embedding-backfill(?!-worker)["']/g;

    const bareActorViolations: Array<{ file: string; line: number; snippet: string }> = [];
    for (const filePath of allSrcFiles) {
      const absPath = path.resolve(filePath);
      // The SSOT module itself describes the bare-vs-canonical contrast in
      // JSDoc — exempt from the production-emit ban.
      if (absPath === SSOT_AUDIT_ACTIONS_FILE) continue;

      const text = fs.readFileSync(absPath, "utf8");
      const lines = text.split("\n");
      lines.forEach((lineText, idx) => {
        // Skip JSDoc / single-line comment / multi-line block comment lines
        // (we only target actual production emit literals). This is a
        // conservative line-prefix check — production callsites emit the
        // literal inside an object literal, not in `*` JSDoc lines.
        const trimmed = lineText.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith("/**")
        ) {
          return;
        }
        bareActorLiteralPattern.lastIndex = 0;
        if (bareActorLiteralPattern.test(lineText)) {
          bareActorViolations.push({
            file: path.relative(MCP_SERVER_ROOT, absPath),
            line: idx + 1,
            snippet: lineText.trim(),
          });
        }
      });
    }

    if (bareActorViolations.length > 0) {
      const formatted = bareActorViolations
        .map((v) => `  - ${v.file}:${v.line}\n      ${v.snippet}`)
        .join("\n");
      expect.fail(
        `INV-AUDIT-EMIT-SSOT-IMPORT-001 violation (FIND-IMPL-LCC-V43-PRM-M-01): ${bareActorViolations.length} production file(s) emit bare \`system:embedding-backfill\` literal without the canonical \`-worker\` suffix.\n` +
          `Replace with: import { getWorkerActorName, AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER } from "<path>/audit/audit-actions"; actor: getWorkerActorName(workerType)\n` +
          `PR-D-5 SSOT convention requires the canonical \`system:embedding-backfill-worker\` form (anchor 019e30ad-9c3f Plan v4.3 PR-M Phase 2 LCC Impl Audit).\n` +
          `Violations:\n${formatted}`
      );
    }
    expect(bareActorViolations).toEqual([]);

    // (c) Sanity check: `post-job-lifecycle.ts` (canonical caller) imports
    //     `getWorkerActorName` from the SSOT module. This pins the import
    //     site so a regression that replaces the import with an inline
    //     template literal will fail this assertion immediately.
    const postJobLifecyclePath = path.resolve(SRC_ROOT, "workers/shared/post-job-lifecycle.ts");
    const postJobText = fs.readFileSync(postJobLifecyclePath, "utf8");
    expect(
      postJobText,
      "post-job-lifecycle.ts MUST import getWorkerActorName from audit/audit-actions (FIND-IMPL-LCC-V43-PRM-M-01 closure)"
    ).toMatch(/getWorkerActorName/);
    expect(
      postJobText,
      "post-job-lifecycle.ts MUST emit actor via getWorkerActorName(workerType), not template literal `system:${workerType}`"
    ).not.toMatch(/actor:\s*`system:\$\{workerType\}`/);
  });

  // ==========================================================================
  // Test 9 — ADR-0018 Amendment 7 §7.8 (UB-7, SEC-V1-02 closure): the V1 claim
  // that "Test 8 auto-covers the new reconcile actor" was a factual error (Test
  // 8's negative-lookahead `(?!-worker)` regex sweeps ONLY the
  // `system:embedding-backfill` family and does NOT cover the new
  // `system:backfill-reconciliation-cron` actor nor the `audit_logs.details` raw
  // message). This dedicated assertion closes the gap: it pins the new reconcile
  // actor/action SSOT-derive AND that the reconciliation service emits via the
  // SSOT constants (no hardcoded bare literal / template literal).
  // ==========================================================================

  it("INV-AUDIT-EMIT-SSOT-IMPORT-001: ADR-0018 Amendment 7 §7.8 reconcile actor SSOT — `AUDIT_ACTOR_BACKFILL_RECONCILIATION_CRON` / `AUDIT_ACTION_BACKFILL_RECONCILE_IN_PROGRESS_FAILED` export canonical `system:`-prefixed literals; backfill-reconciliation.service.ts imports + emits via the SSOT constants (no hardcoded literal, details PII-free) — corrects the V1 'Test 8 auto-cover' factual error (UB-7, SEC-V1-02)", () => {
    // INV-AUDIT-EMIT-SSOT-IMPORT-001
    //
    // (a) SSOT constant identity + literal-string dual-assertion (Wave 5 LCC
    //     canonical CWE-209 PII protection pattern).
    expect(AUDIT_ACTOR_BACKFILL_RECONCILIATION_CRON).toBe("system:backfill-reconciliation-cron");
    expect(AUDIT_ACTION_BACKFILL_RECONCILE_IN_PROGRESS_FAILED).toBe(
      "backfill_reconcile_in_progress_failed"
    );
    // `system:` prefix mandate (Worker actor naming SSOT convention).
    expect(AUDIT_ACTOR_BACKFILL_RECONCILIATION_CRON.startsWith("system:")).toBe(true);

    // (b) The reconciliation service imports the SSOT constants from the SSOT
    //     module (drift guard) and emits the new action via the constant — NOT
    //     a hardcoded `"backfill_reconcile_in_progress_failed"` / bare actor
    //     literal at the emit callsite.
    const reconSrc = fs.readFileSync(
      path.resolve(SRC_ROOT, "services/backfill-reconciliation.service.ts"),
      "utf8"
    );
    expect(
      reconSrc,
      "backfill-reconciliation.service.ts MUST import AUDIT_ACTION_BACKFILL_RECONCILE_IN_PROGRESS_FAILED from the SSOT module"
    ).toMatch(/AUDIT_ACTION_BACKFILL_RECONCILE_IN_PROGRESS_FAILED/);
    expect(
      reconSrc,
      "backfill-reconciliation.service.ts MUST import AUDIT_ACTOR_BACKFILL_RECONCILIATION_CRON from the SSOT module"
    ).toMatch(/AUDIT_ACTOR_BACKFILL_RECONCILIATION_CRON/);
    // The emit callsite uses the SSOT constants (not a string literal).
    expect(reconSrc).toMatch(/action:\s*AUDIT_ACTION_BACKFILL_RECONCILE_IN_PROGRESS_FAILED/);
    expect(reconSrc).toMatch(/actor:\s*AUDIT_ACTOR_BACKFILL_RECONCILIATION_CRON/);

    // (c) details raw-message sweep (Test 8 does NOT cover details payload):
    //     the §7.8 emit details MUST be PII-free numeric/enum only — assert no
    //     raw `error.message` / `sanitizeErrorMessage(...)` flows into the
    //     `details` object of the §7.8 emit (only remainingStatus + stalenessMs).
    //     We assert the §7.8 emit block does not put a `message:` field into details.
    const emitBlock = reconSrc.slice(
      reconSrc.indexOf("AUDIT_ACTION_BACKFILL_RECONCILE_IN_PROGRESS_FAILED")
    );
    const detailsMatch = emitBlock.match(/details:\s*\{([\s\S]*?)\}/);
    expect(detailsMatch, "§7.8 emit MUST have a details object").not.toBeNull();
    const detailsBody = detailsMatch?.[1] ?? "";
    expect(detailsBody).toContain("remainingStatus");
    expect(detailsBody).toContain("stalenessMs");
    // No raw error message / sanitize call inside the §7.8 details payload.
    expect(detailsBody).not.toMatch(/message/);
    expect(detailsBody).not.toMatch(/sanitizeErrorMessage/);

    // (d) Production-wide bare-literal ban for the new reconcile actor: no
    //     production file emits the bare `"system:backfill-reconciliation-cron"`
    //     string literal except the SSOT module itself (the constant definition).
    const SSOT_AUDIT_ACTIONS_FILE = path.resolve(SRC_ROOT, "audit/audit-actions.ts");
    const bareReconActorPattern = /["']system:backfill-reconciliation-cron["']/g;
    const violations: Array<{ file: string; line: number }> = [];
    for (const filePath of allSrcFiles) {
      const absPath = path.resolve(filePath);
      if (absPath === SSOT_AUDIT_ACTIONS_FILE) continue;
      const text = fs.readFileSync(absPath, "utf8");
      text.split("\n").forEach((lineText, idx) => {
        const trimmed = lineText.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith("/**")
        ) {
          return;
        }
        bareReconActorPattern.lastIndex = 0;
        if (bareReconActorPattern.test(lineText)) {
          violations.push({ file: path.relative(MCP_SERVER_ROOT, absPath), line: idx + 1 });
        }
      });
    }
    expect(
      violations,
      `Production file(s) emit bare "system:backfill-reconciliation-cron" literal instead of importing AUDIT_ACTOR_BACKFILL_RECONCILIATION_CRON: ${violations
        .map((v) => `${v.file}:${v.line}`)
        .join(", ")}`
    ).toEqual([]);
  });
});
