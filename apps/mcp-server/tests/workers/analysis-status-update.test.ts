// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - analysisStatus DB Update Tests
 *
 * Verifies that the worker correctly updates web_pages.analysisStatus:
 * - Success path: analysisStatus = "completed" + analysisCompletedAt
 * - Failure path: analysisStatus = "failed" + analysisError + analysisCompletedAt
 *
 * Uses source code verification pattern (consistent with existing tests).
 *
 * @module tests/workers/analysis-status-update
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const workerSourcePath = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");
const workerSource = fs.readFileSync(workerSourcePath, "utf-8");

describe("PageAnalyzeWorker - analysisStatus DB Update", () => {
  const orchestratorPath = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");
  const phase0Path = path.resolve(__dirname, "../../src/workers/phases/phase-0-ingest.ts");

  let orchestratorSource: string;
  let phase0Source: string;

  beforeAll(() => {
    orchestratorSource = fs.readFileSync(orchestratorPath, "utf8");
    phase0Source = fs.readFileSync(phase0Path, "utf8");
  });

  describe("Phase 0: Initial Status", () => {
    it("should set analysisStatus to 'pending' during Phase 0 upsert (legacy path)", () => {
      // PR-B (v0.4.0 PR7e P4): Phase 0 still writes analysisStatus='pending'
      // for both create/update branches of the W1 upsert when the Phase 0
      // Early INSERT flag is OFF (legacy, default behavior). With the flag
      // ON, the orchestrator's W0 upsert writes 'pending' instead.
      //
      // Source shape evolved from object-literal keys (`analysisStatus: "pending"`)
      // to property assignments (`createData.analysisStatus = "pending"` /
      // `updateData.analysisStatus = "pending"`) to support the conditional
      // branch. Static check matches either form.
      //
      // PR-B (v0.4.0 PR7e P4): Phase 0 continues to write
      // analysisStatus='pending' for both create/update branches of W1
      // upsert on the legacy path (flag OFF, default). When the flag is ON,
      // the orchestrator writes 'pending' instead via W0 upsert.
      //
      // Source shape evolved from `analysisStatus: "pending"` object-literal
      // to `createData.analysisStatus = "pending"` /
      // `updateData.analysisStatus = "pending"` assignments to support the
      // conditional branch. Static check now matches either form.
      const objectLiteralMatches = phase0Source.match(/analysisStatus:\s*"pending"/g) ?? [];
      const assignmentMatches = phase0Source.match(/\.analysisStatus\s*=\s*"pending"/g) ?? [];
      const totalMatches = objectLiteralMatches.length + assignmentMatches.length;
      // Should appear at least twice (once for create payload, once for update)
      expect(totalMatches).toBeGreaterThanOrEqual(2);
    });

    it("should branch the W1 upsert on the phase0EarlyInsertEnabled flag (PR-B v0.4.0 PR7e P4)", () => {
      // The Phase 0 Early INSERT feature flag must be honored in Phase 0.5
      // Phase 0.5 は phase0EarlyInsertEnabled フラグを尊重して W1 の
      // analysisStatus 書込をスキップする必要がある。
      expect(phase0Source).toContain("phase0EarlyInsertEnabled");
      expect(phase0Source).toMatch(/if\s*\(\s*!phase0EarlyInsertEnabled\s*\)/);
    });
  });

  describe("Phase 0 Early INSERT (PR-B v0.4.0 PR7e P4)", () => {
    it("orchestrator declares PHASE0_EARLY_INSERT feature flag (default OFF)", () => {
      // オーケストレーター側に opt-in フラグ関数がある
      // Orchestrator must expose the opt-in flag helper
      expect(orchestratorSource).toContain("isPhase0EarlyInsertEnabled");
      // env var は PHASE0_EARLY_INSERT でデフォルトは false (opt-in)
      expect(orchestratorSource).toMatch(/process\.env\.PHASE0_EARLY_INSERT\s*===\s*"true"/);
    });

    it("orchestrator performs W0 upsert before processIngestPhase when flag=true", () => {
      // W0 upsert は processIngestPhase 呼び出しより前に位置する
      // W0 upsert must appear before the processIngestPhase call
      const flagBlock = orchestratorSource.indexOf("phase0EarlyInsertEnabled");
      const w0Upsert = orchestratorSource.indexOf("prisma.webPage.upsert", flagBlock);
      const ingestCall = orchestratorSource.indexOf("processIngestPhase(state, ctx");
      expect(flagBlock).toBeGreaterThan(-1);
      expect(w0Upsert).toBeGreaterThan(-1);
      expect(ingestCall).toBeGreaterThan(-1);
      expect(w0Upsert).toBeLessThan(ingestCall);
    });

    it("orchestrator propagates phase0EarlyInsertEnabled flag into ingest deps", () => {
      // processIngestPhase に phase0EarlyInsertEnabled が渡される
      // processIngestPhase must receive phase0EarlyInsertEnabled in its deps
      expect(orchestratorSource).toMatch(
        /processIngestPhase\(state,\s*ctx,\s*\{[^}]*phase0EarlyInsertEnabled/s
      );
    });
  });

  describe("Success Path: analysisStatus = 'completed'", () => {
    it("should update analysisStatus to 'completed' in the Finalize section", () => {
      // The Finalize section should contain a prisma.webPage.update with analysisStatus: "completed"
      const finalizeStart = orchestratorSource.indexOf("// Finalize");
      expect(finalizeStart).toBeGreaterThan(-1);

      const finalizeSection = orchestratorSource.slice(finalizeStart, finalizeStart + 4000);
      expect(finalizeSection).toContain('analysisStatus: "completed"');
    });

    it("should set analysisCompletedAt in the success path", () => {
      const finalizeStart = orchestratorSource.indexOf("// Finalize");
      const finalizeSection = orchestratorSource.slice(finalizeStart, finalizeStart + 4000);
      expect(finalizeSection).toContain("analysisCompletedAt:");
    });

    it("should wrap analysisStatus update in try-catch for graceful degradation", () => {
      const finalizeStart = orchestratorSource.indexOf("// Finalize");
      // v0.4.0 PR7e-α (バグ④): PhasedDbHandler 統合により finalize セクションが
      // ~2x に拡大したため slice 窓を 4000 に拡張 / PhasedDbHandler doubled the
      // finalize section size; widened the slice window to 4000.
      const finalizeSection = orchestratorSource.slice(finalizeStart, finalizeStart + 4000);
      // Should have try-catch around the DB update
      expect(finalizeSection).toContain("statusError");
      expect(finalizeSection).toContain("Failed to update analysisStatus to completed");
    });

    it("should update analysisStatus before building the job result", () => {
      const finalizeStart = orchestratorSource.indexOf("// Finalize");
      const finalizeSection = orchestratorSource.slice(finalizeStart, finalizeStart + 5000);
      const statusUpdatePos = finalizeSection.indexOf('analysisStatus: "completed"');
      const resultBuildPos = finalizeSection.indexOf("const result: PageAnalyzeJobResult");
      expect(statusUpdatePos).toBeGreaterThan(-1);
      expect(resultBuildPos).toBeGreaterThan(-1);
      expect(statusUpdatePos).toBeLessThan(resultBuildPos);
    });
  });

  describe("Failure Path: analysisStatus = 'failed'", () => {
    it("should update analysisStatus to 'failed' in the catch block", () => {
      // Find the catch block
      const catchStart = orchestratorSource.indexOf("Job failed with exception");
      expect(catchStart).toBeGreaterThan(-1);

      const catchSection = orchestratorSource.slice(catchStart, catchStart + 4000);
      expect(catchSection).toContain('analysisStatus: "failed"');
    });

    it("should set analysisError in the failure path", () => {
      const catchStart = orchestratorSource.indexOf("Job failed with exception");
      const catchSection = orchestratorSource.slice(catchStart, catchStart + 4000);
      expect(catchSection).toContain("analysisError:");
    });

    it("should set analysisCompletedAt in the failure path", () => {
      const catchStart = orchestratorSource.indexOf("Job failed with exception");
      const catchSection = orchestratorSource.slice(catchStart, catchStart + 4000);
      expect(catchSection).toContain("analysisCompletedAt:");
    });

    it("should guard failure update with actualWebPageId check", () => {
      const catchStart = orchestratorSource.indexOf("Job failed with exception");
      const catchSection = orchestratorSource.slice(catchStart, catchStart + 4000);
      // Should check state.actualWebPageId before updating
      expect(catchSection).toContain("state.actualWebPageId");
    });

    it("should truncate error message to prevent oversized DB writes", () => {
      const catchStart = orchestratorSource.indexOf("Job failed with exception");
      const catchSection = orchestratorSource.slice(catchStart, catchStart + 4000);
      // Error message should be sliced to prevent oversized writes
      expect(catchSection).toMatch(/\.slice\(0,\s*\d+\)/);
    });

    it("should still re-throw the error after updating status", () => {
      const catchStart = orchestratorSource.indexOf("Job failed with exception");
      // v0.4.0 PR7e-α (バグ④): PhasedDbHandler 経路拡張により catch block が
      // ~2x に拡大。slice 窓を 4000 に広げる / catch block expanded ~2x;
      // widened slice window to 4000.
      const catchSection = orchestratorSource.slice(catchStart, catchStart + 4000);
      // The catch block must re-throw to let BullMQ record the failure
      expect(catchSection).toContain("throw error");
    });

    it("should not call pause(true) in the failure path", () => {
      const catchStart = orchestratorSource.indexOf("Job failed with exception");
      const rethrowPos = orchestratorSource.indexOf("throw error", catchStart);
      expect(rethrowPos).toBeGreaterThan(-1);

      const catchSection = orchestratorSource.slice(catchStart, rethrowPos);
      // Pre-Return Pause pattern: failure path must NOT call pause
      // Filter out comment lines to avoid false positives from inline documentation
      const codeLines = catchSection
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(codeLines).not.toContain("pause(true)");
    });
  });

  describe("Consistency: all exit paths update analysisStatus", () => {
    it("should have analysisStatus updates in both success and failure paths", () => {
      // Count occurrences of analysisStatus updates in the worker
      const completedMatches = orchestratorSource.match(/analysisStatus:\s*"completed"/g);
      const failedMatches = orchestratorSource.match(/analysisStatus:\s*"failed"/g);

      // At least 1 "completed" update (Finalize)
      // and 1 "failed" update (catch block)
      expect(completedMatches).not.toBeNull();
      expect(completedMatches!.length).toBeGreaterThanOrEqual(1);
      expect(failedMatches).not.toBeNull();
      expect(failedMatches!.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("analysisError PII sanitization (CWE-209 / GDPR Art.5(1)(c))", () => {
    it("should apply sanitizeErrorMessage() with 500-char truncation in failure path", () => {
      // v0.4.0 PR7e-α: 失敗パスで sanitizeErrorMessage(error).slice(0, 500) が
      // 呼び出されていることを静的検査。PhasedDbHandler 移行により、結果は
      // ローカル const errorMessage に一度代入され markAnalysisFailed(errorMessage)
      // へ渡される。
      // v0.4.0 PR7e-α: verify `sanitizeErrorMessage(error).slice(0, 500)` is
      // still present in the failure path. After the PhasedDbHandler migration,
      // the result is stored in a local `errorMessage` const and passed to
      // markAnalysisFailed(errorMessage).
      expect(workerSource).toMatch(/sanitizeErrorMessage\(error\)\.slice\(0,\s*500\)/);
      // The sanitized value is bound to `errorMessage` before PhasedDbHandler /
      // fallback consumes it.
      expect(workerSource).toMatch(
        /const\s+errorMessage\s*=\s*sanitizeErrorMessage\(error\)\.slice\(0,\s*500\)/
      );
    });

    it("should use sanitized errorMessage in the fallback inline update", () => {
      // fallback 経路は analysisError: errorMessage を使い、生 error.message を露出しない。
      // Fallback inline update uses `analysisError: errorMessage` (never raw).
      expect(workerSource).toMatch(/analysisError:\s*errorMessage/);
    });

    it("should not expose raw error.message to analysisError anywhere", () => {
      // analysisError: error.message（生値）直書きは禁止。
      // Direct `analysisError: error.message` is forbidden.
      expect(workerSource).not.toMatch(/analysisError:\s*error\.message/);
    });
  });

  // v0.4.0 PR7e-α (バグ④): PhasedDbHandler で analysis_phase_status /
  // analysis_started_at / last_analyzed_phase を遷移させる。
  // v0.4.0 PR7e-α (bug ④): PhasedDbHandler drives analysis_phase_status /
  // analysis_started_at / last_analyzed_phase transitions.
  describe("PR7e-α bug④: PhasedDbHandler integration", () => {
    it("should import PhasedDbHandler", () => {
      expect(workerSource).toMatch(
        /import\s+\{\s*PhasedDbHandler\s*\}\s+from\s+"\.\.\/tools\/page\/handlers\/phased-db-handler"/
      );
    });

    it("should call markAnalysisStarted() after Phase 0 completes", () => {
      // markAnalysisStarted() を処理本体で呼んでいることを確認。
      // Verify markAnalysisStarted() is invoked in the job body.
      expect(workerSource).toContain("phasedDb.markAnalysisStarted()");
      // Phase 0 完了後に呼ばれる (processIngestPhase より下の位置)
      const ingestPos = workerSource.indexOf("processIngestPhase(state, ctx");
      const startedPos = workerSource.indexOf("phasedDb.markAnalysisStarted()");
      expect(ingestPos).toBeGreaterThan(-1);
      expect(startedPos).toBeGreaterThan(ingestPos);
    });

    it("should call markAnalysisCompleted() in the success finalize path", () => {
      expect(workerSource).toContain("phasedDb.markAnalysisCompleted(success)");
      const finalizeStart = workerSource.indexOf("// Finalize");
      const completedPos = workerSource.indexOf(
        "phasedDb.markAnalysisCompleted(success)",
        finalizeStart
      );
      expect(completedPos).toBeGreaterThan(finalizeStart);
    });

    it("should call markAnalysisFailed() in the catch block", () => {
      expect(workerSource).toContain("phasedDb.markAnalysisFailed(errorMessage)");
      const catchStart = workerSource.indexOf("Job failed with exception");
      const failedPos = workerSource.indexOf("phasedDb.markAnalysisFailed", catchStart);
      expect(failedPos).toBeGreaterThan(catchStart);
    });

    it("should treat PhasedDbHandler failures as non-fatal (fail-open)", () => {
      // PhasedDbHandler 呼び出しは try-catch で囲み、失敗しても re-throw しない。
      // PhasedDbHandler calls must be wrapped in try-catch and never re-throw.
      const failStartedLog = "PhasedDbHandler.markAnalysisStarted failed";
      const failCompletedLog = "PhasedDbHandler.markAnalysisCompleted failed";
      const failFailedLog = "PhasedDbHandler.markAnalysisFailed failed";
      expect(workerSource).toContain(failStartedLog);
      expect(workerSource).toContain(failCompletedLog);
      expect(workerSource).toContain(failFailedLog);
    });

    it("should preserve legacy inline fallback when PhasedDbHandler is null", () => {
      // PhasedDbHandler が初期化できなかった場合のフォールバック経路が存在する。
      // A fallback path must remain in case PhasedDbHandler initialisation fails.
      expect(workerSource).toMatch(/if\s*\(phasedDb\)/);
      // 既存の analysisStatus: "completed" / "failed" が fallback として残る
      expect(workerSource).toContain('analysisStatus: "completed"');
      expect(workerSource).toContain('analysisStatus: "failed"');
    });
  });
});
