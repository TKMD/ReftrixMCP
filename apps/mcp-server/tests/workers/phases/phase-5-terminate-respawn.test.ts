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
 * 1. terminateAndRespawn()メソッドがEmbeddingServiceソースに存在すること
 * 2. サブフェーズ末尾でterminateAndRespawnEmbeddingPipelineが呼ばれること
 * 3. チャンク間ではdisposeEmbeddingPipelineが維持されること
 * 4. workerRestartCountがリセットされないこと
 * 5. lastCrashTime=0リセットがあること
 * 6. process.exit(0)がworker-thread.tsのterminate handlerから削除されていること
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
  const layoutEmbeddingPath = path.resolve(
    __dirname,
    "../../../src/services/layout-embedding.service.ts"
  );

  let mlServiceSource: string;
  let workerThreadSource: string;
  let phase5Source: string;
  let layoutEmbeddingSource: string;

  beforeAll(() => {
    mlServiceSource = fs.readFileSync(mlServicePath, "utf8");
    workerThreadSource = fs.readFileSync(workerThreadPath, "utf8");
    phase5Source = fs.readFileSync(phase5Path, "utf8");
    layoutEmbeddingSource = fs.readFileSync(layoutEmbeddingPath, "utf8");
  });

  // ==========================================================================
  // T-1: terminateAndRespawn()メソッドの存在
  // ==========================================================================

  describe("T-1: terminateAndRespawn() method existence", () => {
    it("EmbeddingServiceにterminateAndRespawn()メソッドが存在すること / terminateAndRespawn() should exist in EmbeddingService", () => {
      expect(mlServiceSource).toContain("async terminateAndRespawn()");
    });

    it("LayoutEmbeddingServiceにterminateAndRespawnEmbeddingPipeline()メソッドが存在すること / terminateAndRespawnEmbeddingPipeline() should exist in LayoutEmbeddingService", () => {
      expect(layoutEmbeddingSource).toContain("async terminateAndRespawnEmbeddingPipeline()");
    });

    it("既存のdispose()メソッドが維持されていること / existing dispose() method should be preserved", () => {
      expect(mlServiceSource).toContain("async dispose()");
    });

    it("既存のdisposeEmbeddingPipeline()メソッドが維持されていること / existing disposeEmbeddingPipeline() should be preserved", () => {
      expect(layoutEmbeddingSource).toContain("async disposeEmbeddingPipeline()");
    });

    it("terminateAndRespawnEmbeddingPipeline()が内部でterminateAndRespawn()を呼ぶこと / terminateAndRespawnEmbeddingPipeline() should call terminateAndRespawn() internally", () => {
      expect(layoutEmbeddingSource).toContain("terminateAndRespawn()");
    });
  });

  // ==========================================================================
  // T-2: サブフェーズ末尾でterminateAndRespawn、チャンク間でdispose維持
  // ==========================================================================

  describe("T-2: sub-phase end vs chunk boundary calls", () => {
    it("サブフェーズ末尾でterminateAndRespawnEmbeddingPipelineが呼ばれること / sub-phase endings should call terminateAndRespawnEmbeddingPipeline", () => {
      // 各サブフェーズ関数の末尾で terminateAndRespawnEmbeddingPipeline が呼ばれる
      // processSectionTextEmbeddingChunks, processMotionTextEmbeddingChunks,
      // processVisionMotionEmbeddingChunks, processBackgroundTextEmbeddingChunks,
      // processJsAnimationEmbeddingChunks, processResponsiveEmbeddingChunks,
      // processPartTextEmbeddingChunks

      // 各サブフェーズ関数の末尾パターン:
      // "await ctx.sharedLayoutEmbeddingService.terminateAndRespawnEmbeddingPipeline();\n  tryGarbageCollect();\n}"
      const subPhaseEndPattern =
        /terminateAndRespawnEmbeddingPipeline\(\);\s*\n\s*tryGarbageCollect\(\);\s*\n\}/g;
      const matches = phase5Source.match(subPhaseEndPattern);
      // 7つのサブフェーズ末尾で呼ばれる
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(7);
    });

    it("チャンク間ではdisposeEmbeddingPipelineが維持されること / chunk boundaries should still use disposeEmbeddingPipeline", () => {
      // チャンク間パターン: if (...) { disposeEmbeddingPipeline(); tryGarbageCollect(); }
      const chunkBoundaryPattern =
        /if\s*\([^)]+\)\s*\{\s*\n\s*await\s+ctx\.sharedLayoutEmbeddingService\.disposeEmbeddingPipeline\(\)/g;
      const matches = phase5Source.match(chunkBoundaryPattern);
      // 5つのチャンク間呼び出し: Section, Motion, VisionMotion, Background, Part
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(5);
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

    it("terminateAndRespawnEmbeddingPipeline()のログにURL/webPageIdが含まれないこと / terminateAndRespawnEmbeddingPipeline() logs should not contain PII", () => {
      const methodMatch = layoutEmbeddingSource.match(
        /async terminateAndRespawnEmbeddingPipeline\(\)[^{]*\{([\s\S]*?)(?:\n  \}|\n  async )/
      );
      expect(methodMatch).not.toBeNull();
      const methodBody = methodMatch![1];
      expect(methodBody).not.toContain("url");
      expect(methodBody).not.toContain("webPageId");
    });
  });
});
