// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Worker Thread terminate-and-respawn テスト
 *
 * ONNX Runtime C++ arenaのglibc malloc断片化により、dispose()では
 * OSにメモリが返却されない。Worker Thread自体をterminate→re-spawnする
 * ことでOSがメモリを全回収する。
 *
 * T-7テスト項目:
 * 1. terminateAndRespawn()メソッドがEmbeddingServiceソースに存在すること (base、維持)
 * 2. PR-BT-5 (ADR-0039 Decision 2): サブフェーズ末尾で terminateAndRespawn は
 *    呼ばれない (fork-child path から除去済)。チャンク間 dispose は維持。
 * 3. チャンク間ではdisposeEmbeddingPipelineが維持されること
 * 4. workerRestartCountがリセットされないこと
 * 5. lastCrashTime=0リセットがあること
 * 6. process.exit(0)がworker-thread.tsのterminate handlerから削除されていること
 *
 * PR-BT-5 (M-1-RSS, ADR-0039 Decision 2 / CO-PRBT5-04): the Phase-5-only
 * `terminateAndRespawnEmbeddingPipeline()` wrapper was REMOVED (orphaned after
 * the 7 sub-phase call sites were deleted). The base
 * `EmbeddingService.terminateAndRespawn()` (worker-thread restart path) is
 * RETAINED — so the base-method tests (T-1 base, T-3..T-6, T-8 base) stay valid.
 * The wrapper-specific assertions were updated to the new contract.
 *
 * Worker Thread terminate-and-respawn tests for Phase 5 (Embedding).
 * ONNX Runtime C++ arena glibc malloc fragmentation prevents dispose()
 * from returning memory to OS. Terminating and re-spawning the Worker Thread
 * allows the OS to reclaim all memory.
 *
 * @module tests/workers/phases/phase-5-terminate-respawn
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Phase 5: Worker Thread terminate-and-respawn", () => {
  const mlServicePath = path.resolve(
    __dirname,
    "../../../../../packages/ml/src/embeddings/service.ts"
  );
  const workerThreadPath = path.resolve(
    __dirname,
    "../../../../../packages/ml/src/embeddings/worker-thread.ts"
  );
  const phase5Path = path.resolve(__dirname, "../../../src/workers/phases/phase-5-embedding.ts");
  // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): the canonical
  // chunk loop (incl. the chunk-boundary dispose) was extracted into this shared
  // driver, so the chunk-boundary dispose now lives here, not in phase-5-embedding.ts.
  const chunkLoopPath = path.resolve(
    __dirname,
    "../../../src/workers/phases/phase-5-chunked-text-loop.ts"
  );
  const layoutEmbeddingPath = path.resolve(
    __dirname,
    "../../../src/services/layout-embedding.service.ts"
  );

  let mlServiceSource: string;
  let workerThreadSource: string;
  let phase5Source: string;
  let chunkLoopSource: string;
  let layoutEmbeddingSource: string;

  beforeAll(() => {
    mlServiceSource = fs.readFileSync(mlServicePath, "utf8");
    workerThreadSource = fs.readFileSync(workerThreadPath, "utf8");
    phase5Source = fs.readFileSync(phase5Path, "utf8");
    chunkLoopSource = fs.readFileSync(chunkLoopPath, "utf8");
    layoutEmbeddingSource = fs.readFileSync(layoutEmbeddingPath, "utf8");
  });

  // ==========================================================================
  // T-1: terminateAndRespawn()メソッドの存在
  // ==========================================================================

  describe("T-1: terminateAndRespawn() method existence", () => {
    it("EmbeddingServiceにterminateAndRespawn()メソッドが存在すること / terminateAndRespawn() should exist in EmbeddingService", () => {
      expect(mlServiceSource).toContain("async terminateAndRespawn()");
    });

    // PR-BT-5 (M-1-RSS, ADR-0039 Decision 2 / CO-PRBT5-04): the Phase-5-only
    // wrapper `terminateAndRespawnEmbeddingPipeline()` was REMOVED after the 7
    // sub-phase call sites were deleted (it became orphaned). Assert ABSENCE of
    // the method declaration (the OLD "should exist" assertion is now invalid).
    it("LayoutEmbeddingServiceからterminateAndRespawnEmbeddingPipeline()メソッドが除去されていること / terminateAndRespawnEmbeddingPipeline() should be REMOVED from LayoutEmbeddingService (ADR-0039 Decision 2 / CO-PRBT5-04)", () => {
      expect(layoutEmbeddingSource).not.toContain("async terminateAndRespawnEmbeddingPipeline()");
    });

    it("既存のdispose()メソッドが維持されていること / existing dispose() method should be preserved", () => {
      expect(mlServiceSource).toContain("async dispose()");
    });

    it("既存のdisposeEmbeddingPipeline()メソッドが維持されていること / existing disposeEmbeddingPipeline() should be preserved", () => {
      expect(layoutEmbeddingSource).toContain("async disposeEmbeddingPipeline()");
    });

    // The base `EmbeddingService.terminateAndRespawn()` (worker-thread restart
    // path) is RETAINED — still referenced by the ml service. (The Phase-5
    // wrapper that delegated to it is gone, but the base method stays.)
    it("base EmbeddingService.terminateAndRespawn() が維持されていること / base terminateAndRespawn() should still exist in ml EmbeddingService", () => {
      expect(mlServiceSource).toContain("async terminateAndRespawn()");
    });
  });

  // ==========================================================================
  // T-2: サブフェーズ末尾でterminateAndRespawn、チャンク間でdispose維持
  // ==========================================================================

  describe("T-2: sub-phase end vs chunk boundary calls", () => {
    // PR-BT-5 (M-1-RSS, ADR-0039 Decision 2): the sub-phase-tail
    // `terminateAndRespawnEmbeddingPipeline()` invocation was REMOVED from the
    // fork-child path (per-sub-phase fork → fork-boundary OS reclamation). The
    // OLD assertion (7 sub-phase-end calls) is now INVALID; assert the
    // invocation is ABSENT. (Source-pinned more rigorously by the standing
    // INV-PHASE5-SUBPHASE-NO-RELOAD-001 AST sweep.)
    it("サブフェーズ末尾でterminateAndRespawnEmbeddingPipelineが呼ばれないこと / sub-phase endings should NOT call terminateAndRespawnEmbeddingPipeline (ADR-0039 Decision 2)", () => {
      // The actual invocation form `await ...terminateAndRespawnEmbeddingPipeline();`
      // must NOT appear in either the orchestrator or the chunk-loop driver
      // (comment references to "...is REMOVED..." are not invocations).
      const invocationPattern =
        /await\s+ctx\.sharedLayoutEmbeddingService\.terminateAndRespawnEmbeddingPipeline\(\)/g;
      expect(phase5Source.match(invocationPattern)).toBeNull();
      expect(chunkLoopSource.match(invocationPattern)).toBeNull();
    });

    it("チャンク間ではdisposeEmbeddingPipelineが維持されること / chunk boundaries should still use disposeEmbeddingPipeline (centralized in shared driver)", () => {
      // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): the
      // chunk-boundary dispose was centralized into the shared driver's
      // `disposeBetweenChunks` helper (one call site, consumed by all delegating
      // text sub-phases). Assert the chunk-boundary dispose is RETAINED in the
      // driver (the M-1-RSS root cause is rooted out by the fork boundary, NOT by
      // removing this transient intra-fork recovery — INV-PHASE5-SUBPHASE-NO-RELOAD-001 (b)).
      const chunkBoundaryPattern =
        /await\s+ctx\.sharedLayoutEmbeddingService\.disposeEmbeddingPipeline\(\)/g;
      const driverMatches = chunkLoopSource.match(chunkBoundaryPattern);
      expect(driverMatches).not.toBeNull();
      expect(driverMatches!.length).toBeGreaterThanOrEqual(1);
      // The orchestrator no longer holds inline chunk-boundary disposes (they
      // moved to the driver). Each chunked sub-phase delegates instead.
      expect(phase5Source).toContain("runChunkedTextEmbeddingLoop(ctx, {");
    });
  });

  // ==========================================================================
  // T-3: lastCrashTime + workerRestartCount
  // ==========================================================================

  describe("T-3: lastCrashTime reset + workerRestartCount preservation", () => {
    it("terminateAndRespawn()内でlastCrashTime=0にリセットされること / lastCrashTime should be reset to 0 in terminateAndRespawn()", () => {
      // terminateAndRespawnメソッド内で lastCrashTime = 0 が含まれること
      const methodMatch = mlServiceSource.match(
        /async terminateAndRespawn\(\)[^{]*\{([\s\S]*?)(?:\n  \}|\n  async )/
      );
      expect(methodMatch).not.toBeNull();
      const methodBody = methodMatch![1];
      expect(methodBody).toContain("this.lastCrashTime = 0");
    });

    it("workerRestartCountが増加しないこと（保存・復元されること） / workerRestartCount should be preserved (saved and restored)", () => {
      // terminateAndRespawnメソッド内で workerRestartCount を保存・復元する
      const methodMatch = mlServiceSource.match(
        /async terminateAndRespawn\(\)[^{]*\{([\s\S]*?)(?:\n  \}|\n  async )/
      );
      expect(methodMatch).not.toBeNull();
      const methodBody = methodMatch![1];
      // 保存してから復元するパターン
      expect(methodBody).toContain("workerRestartCount");
      // workerRestartCount++ がないこと（増加させない）
      expect(methodBody).not.toContain("this.workerRestartCount++");
      expect(methodBody).not.toContain("workerRestartCount++");
    });
  });

  // ==========================================================================
  // T-4: 排他制御
  // ==========================================================================

  describe("T-4: mutual exclusion", () => {
    it("terminateAndRespawn()内でworkerInitPromiseが設定されること / workerInitPromise should be set during terminateAndRespawn()", () => {
      const methodMatch = mlServiceSource.match(
        /async terminateAndRespawn\(\)[^{]*\{([\s\S]*?)(?:\n  \}|\n  async )/
      );
      expect(methodMatch).not.toBeNull();
      const methodBody = methodMatch![1];
      expect(methodBody).toContain("workerInitPromise");
    });
  });

  // ==========================================================================
  // T-5: re-spawn時device設定
  // ==========================================================================

  describe("T-5: re-spawn device configuration", () => {
    it("spawnAndInitWorkerがthis.config.deviceをinitメッセージで送信すること / spawnAndInitWorker should send this.config.device in init message", () => {
      // spawnAndInitWorkerメソッド内でdevice: this.config.device が含まれること
      expect(mlServiceSource).toContain("device: this.config.device");
    });

    it("currentProviderがterminateAndRespawn()で保持されること / currentProvider should be preserved across terminateAndRespawn()", () => {
      // terminateAndRespawnメソッド内で currentProvider を破壊しないこと
      const methodMatch = mlServiceSource.match(
        /async terminateAndRespawn\(\)[^{]*\{([\s\S]*?)(?:\n  \}|\n  async )/
      );
      expect(methodMatch).not.toBeNull();
      const methodBody = methodMatch![1];
      // currentProviderをリセットしていないこと（cpu固定にしていない）
      expect(methodBody).not.toContain('this.currentProvider = "cpu"');
    });
  });

  // ==========================================================================
  // T-6: process.exit(0) 削除
  // ==========================================================================

  describe("T-6: process.exit(0) removal from worker-thread.ts", () => {
    it("worker-thread.tsのterminate handlerにprocess.exit(0)の実行コードがないこと / terminate handler should not contain process.exit(0) call", () => {
      // terminateケース内でprocess.exit()が実際のコードとして呼ばれていないこと
      // コメント内の言及は許容する
      const terminateCase = workerThreadSource.match(/case "terminate":\s*\{([\s\S]*?)\n\s*break;/);
      expect(terminateCase).not.toBeNull();
      const terminateCaseBody = terminateCase![1];
      // コメントを除去してからprocess.exitの有無を確認
      const codeOnly = terminateCaseBody.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(codeOnly).not.toContain("process.exit");
    });

    it("worker-thread.tsのterminate handlerがdisposePipelineを実行しレスポンスを返すこと / terminate handler should disposePipeline and send response", () => {
      const terminateCase = workerThreadSource.match(/case "terminate":\s*\{([\s\S]*?)\n\s*break;/);
      expect(terminateCase).not.toBeNull();
      const terminateCaseBody = terminateCase![1];
      expect(terminateCaseBody).toContain("disposePipeline");
      expect(terminateCaseBody).toContain("sendResponse");
    });
  });

  // ==========================================================================
  // T-8: PII/ログ
  // ==========================================================================

  describe("T-8: PII-free logging", () => {
    it("terminateAndRespawn()のログにURL/webPageIdが含まれないこと / terminateAndRespawn() logs should not contain PII", () => {
      const methodMatch = mlServiceSource.match(
        /async terminateAndRespawn\(\)[^{]*\{([\s\S]*?)(?:\n  \}|\n  async )/
      );
      expect(methodMatch).not.toBeNull();
      const methodBody = methodMatch![1];
      // URL や webPageId のようなPIIがログに含まれないこと
      expect(methodBody).not.toContain("url");
      expect(methodBody).not.toContain("webPageId");
    });

    // PR-BT-5 (M-1-RSS, ADR-0039 Decision 2 / CO-PRBT5-04): the wrapper
    // `terminateAndRespawnEmbeddingPipeline()` was REMOVED, so its PII-free-log
    // assertion is no longer applicable (no method body to inspect). The base
    // `terminateAndRespawn()` PII test above remains.
  });
});
