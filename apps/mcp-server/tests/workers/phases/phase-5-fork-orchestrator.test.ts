// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Fork Orchestrator Tests
 *
 * child_process.fork() による Phase 5 embedding 生成のオーケストレーションをテスト。
 * 以下をカバー:
 *   A. buildChildEnv() — 環境変数ビルド
 *   B. buildChildExecArgv() — Node.js execArgv
 *   C. dispatchEmbeddingPhase() — fork パスが唯一の実行パス
 *   D. layoutResultForNarrative 参照切断
 *   E. screenshotBase64 が fork orchestrator に渡されないこと
 *   F. mergeChildResult — 3-branch pattern
 *   G. V8 heap headroom check
 *   H. System MemAvailable check
 *   I. appendConnectionLimit / serializeIdMapping IPC ヘルパー
 *
 * @module tests/workers/phases/phase-5-fork-orchestrator
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ============================================================================
// Source Path Constants
// ============================================================================

const ORCHESTRATOR_SRC = path.resolve(
  __dirname,
  "../../../src/workers/phases/phase-5-fork-orchestrator.ts"
);

const EMBEDDING_SRC = path.resolve(__dirname, "../../../src/workers/phases/phase-5-embedding.ts");

const CHILD_IPC_SRC = path.resolve(__dirname, "../../../src/workers/phases/phase-5-child-ipc.ts");

// ============================================================================
// Mock Setup for IPC module tests
// ============================================================================

vi.mock("../../../src/utils/sanitize-error", () => ({
  sanitizeErrorMessage: (err: unknown): string =>
    err instanceof Error ? err.message : String(err),
}));

// ============================================================================
// Tests
// ============================================================================

describe("Phase 5: Fork Orchestrator", () => {
  // ==========================================================================
  // A. buildChildEnv() — ソースコード構造検証
  // ==========================================================================
  describe("A. buildChildEnv() — 子プロセス環境変数 / Child process environment", () => {
    let orchestratorSource: string;

    beforeEach(() => {
      orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
    });

    it("EMBEDDING_WORKER_THREAD=false が設定されること / should set EMBEDDING_WORKER_THREAD=false", () => {
      // buildChildEnv sets both worker thread flags to "false" (P0-1)
      expect(orchestratorSource).toMatch(/baseEnv\.EMBEDDING_WORKER_THREAD\s*=\s*["']false["']/);
    });

    it("DINOV2_WORKER_THREAD=false が設定されること / should set DINOV2_WORKER_THREAD=false", () => {
      expect(orchestratorSource).toMatch(/baseEnv\.DINOV2_WORKER_THREAD\s*=\s*["']false["']/);
    });

    it("ONNX_EXECUTION_PROVIDER が GPU-COORD probe で駆動されること（PR-1, ADR-0038） / should be driven by the GPU-COORD probe (PR-1, ADR-0038 FIND-PLAN-H-01)", () => {
      // PR-1 GPU-COORD (T1-wins): the pre-PR-1 hardcoded `cpu` (β2-P1) is replaced
      // by the probe-resolved provider. buildChildEnv now takes `resolvedProvider`
      // and assigns it. The probe's "cpu" branch (below-threshold / contention /
      // PHASE5_FORK_GPU_PROBE_ENABLED=false rollback) preserves the legacy CPU
      // safety, so the CUDA-unavailable host still resolves to CPU.
      expect(orchestratorSource).toMatch(/baseEnv\.ONNX_EXECUTION_PROVIDER\s*=\s*resolvedProvider/);
      // The hardcoded `= "cpu"` assignment MUST be gone (inert-change / fake-success guard).
      expect(orchestratorSource).not.toMatch(/baseEnv\.ONNX_EXECUTION_PROVIDER\s*=\s*["']cpu["']/);
      // buildChildEnv signature accepts the probe-resolved provider.
      expect(orchestratorSource).toMatch(
        /function buildChildEnv\(resolvedProvider:\s*ChildExecutionProvider\)/
      );
    });

    it("MALLOC_ARENA_MAX=2 が設定されること（OOM-1） / should set MALLOC_ARENA_MAX=2 (OOM-1)", () => {
      // buildChildEnv sets MALLOC_ARENA_MAX to "2" when not already set
      expect(orchestratorSource).toMatch(/MALLOC_ARENA_MAX/);
      expect(orchestratorSource).toMatch(/baseEnv\.MALLOC_ARENA_MAX\s*=\s*["']2["']/);
    });

    it("DATABASE_URL に appendConnectionLimit が適用されること（P0-3） / should apply appendConnectionLimit to DATABASE_URL", () => {
      expect(orchestratorSource).toContain("appendConnectionLimit");
      expect(orchestratorSource).toContain("DATABASE_URL");
      expect(orchestratorSource).toContain("CHILD_CONNECTION_LIMIT");
    });

    it("WORKER_MAX_OLD_SPACE_MB がメモリプロファイルから設定されること / should set WORKER_MAX_OLD_SPACE_MB from profile", () => {
      expect(orchestratorSource).toMatch(
        /baseEnv\.WORKER_MAX_OLD_SPACE_MB\s*=\s*String\(profile\.maxOldSpaceSizeMb\)/
      );
    });
  });

  // ==========================================================================
  // B. buildChildExecArgv() — Node.js execArgv
  // ==========================================================================
  describe("B. buildChildExecArgv() — Node.js 起動引数 / Node.js exec arguments", () => {
    let orchestratorSource: string;

    beforeEach(() => {
      orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
    });

    it("--max-old-space-size が CHILD_MAX_OLD_SPACE_MB(4096) で制限されること / should cap at CHILD_MAX_OLD_SPACE_MB", () => {
      // CHILD_MAX_OLD_SPACE_MB constant is 4096
      expect(orchestratorSource).toMatch(/CHILD_MAX_OLD_SPACE_MB\s*=\s*4096/);
      // Math.min is used to cap
      expect(orchestratorSource).toMatch(
        /Math\.min\(profile\.maxOldSpaceSizeMb,\s*CHILD_MAX_OLD_SPACE_MB\)/
      );
    });

    it("--expose-gc が execArgv に含まれること / should include --expose-gc", () => {
      expect(orchestratorSource).toContain('"--expose-gc"');
    });

    it("buildChildExecArgv が --max-old-space-size と --expose-gc を含む配列を返すこと / should return array with both args", () => {
      // The function returns a 2-element array
      expect(orchestratorSource).toMatch(
        /return\s*\[\s*`--max-old-space-size=\$\{childHeapMb\}`\s*,\s*"--expose-gc"\s*\]/
      );
    });
  });

  // ==========================================================================
  // C. dispatchEmbeddingPhase() — fork パスが唯一の実行パス
  // ==========================================================================
  describe("C. dispatchEmbeddingPhase() — fork が唯一の実行パス / fork is the sole path", () => {
    it("レガシー in-process パスが削除されていること / legacy in-process path removed", () => {
      const embeddingSource = fs.readFileSync(EMBEDDING_SRC, "utf-8");

      expect(embeddingSource).toContain("Legacy processEmbeddingPhase removed");
      // No conditional fork flag — fork is always used
      expect(embeddingSource).not.toContain("PHASE5_FORK_ENABLED");
    });

    it("dispatchEmbeddingPhase が runPhase5ViaFork をインポートすること / should import runPhase5ViaFork", () => {
      const embeddingSource = fs.readFileSync(EMBEDDING_SRC, "utf-8");

      expect(embeddingSource).toContain('import("./phase-5-fork-orchestrator');
      expect(embeddingSource).toContain("runPhase5ViaFork");
    });

    it("fork orchestrator が child_process.fork を使用すること / should use child_process.fork", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      expect(orchestratorSource).toMatch(
        /import\s*\{\s*fork.*\}\s*from\s*["']node:child_process["']/
      );
      // fork is called in runChildProcess
      expect(orchestratorSource).toMatch(/const\s+child.*=\s*fork\(/);
    });
  });

  // ==========================================================================
  // D. layoutResultForNarrative 参照切断
  // ==========================================================================
  describe("D. layoutResultForNarrative 参照切断 / null-out after visual child", () => {
    it("visual child 用 JSON.stringify 後に params.layoutResultForNarrative が null に設定されること / should null-out layoutResultForNarrative", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // OOM-FIX: Release original object reference after JSON serialization.
      // PR-BT-5 (ADR-0039): retained in the per-sub-phase visual block (the
      // visual layout JSON is stringified once, then the object reference is
      // released before the visual sub-phase fork loop).
      expect(orchestratorSource).toMatch(/params.*layoutResultForNarrative\s*=\s*null/);
      // Comment documents the intentional null-out (wording updated in PR-BT-5).
      expect(orchestratorSource).toContain("release the original object reference");
    });
  });

  // ==========================================================================
  // E. screenshotBase64 が fork orchestrator に渡されないこと
  // ==========================================================================
  describe("E. screenshotBase64 が fork に渡されないこと / screenshotBase64 not in IPC", () => {
    it("runPhase5ViaFork の destructure に screenshotBase64 が含まれないこと / should not destructure screenshotBase64", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // The destructuring block extracts screenshotPngPath but NOT screenshotBase64
      expect(orchestratorSource).toContain("screenshotPngPath");
      // screenshotBase64 should NOT appear in the destructuring of params
      // (It may appear in type definitions, so check specifically for destructuring)
      const destructureMatch = orchestratorSource.match(/const\s*\{[\s\S]*?\}\s*=\s*params/);
      expect(destructureMatch).toBeTruthy();
      expect(destructureMatch![0]).not.toContain("screenshotBase64");
    });

    it("IPC init-text メッセージに screenshotBase64 フィールドがないこと / no screenshotBase64 in init-text", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // Find the init-text message object literal
      const textInitMatch = orchestratorSource.match(
        /type:\s*["']init-text["'][\s\S]*?partsSavedCount/
      );
      expect(textInitMatch).toBeTruthy();
      expect(textInitMatch![0]).not.toContain("screenshotBase64");
    });

    it("IPC init-visual メッセージが screenshotPngPath を使用すること / init-visual uses screenshotPngPath", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // Find the init-visual message object literal
      const visualInitMatch = orchestratorSource.match(
        /type:\s*["']init-visual["'][\s\S]*?dinov2ModelPath/
      );
      expect(visualInitMatch).toBeTruthy();
      expect(visualInitMatch![0]).toContain("screenshotPngPath");
      expect(visualInitMatch![0]).not.toContain("screenshotBase64");
    });
  });

  // ==========================================================================
  // F. mergeChildResult — 3-branch pattern (success / error / abnormal-exit / IPC race)
  // ==========================================================================
  describe("F. mergeChildResult — IPC 結果マージ / child result merging", () => {
    let orchestratorSource: string;

    beforeEach(() => {
      orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
    });

    it("mergeChildResult が 4 パターンを処理すること（success / error / abnormal-exit / IPC race） / should handle 4 branches", () => {
      // success path: type matches expectedType
      expect(orchestratorSource).toContain("childResult.message?.type === expectedType");
      // error path
      expect(orchestratorSource).toContain('childResult.message?.type === "error"');
      // abnormal exit path
      expect(orchestratorSource).toContain("!childResult.exitedCleanly");
      // IPC race path (clean exit, no result)
      expect(orchestratorSource).toContain("IPC race");
    });

    it("text-result から6種のembedding countをマージすること / should merge 6 embedding counts from text-result", () => {
      expect(orchestratorSource).toContain("sectionEmbeddingsGenerated");
      expect(orchestratorSource).toContain("motionEmbeddingsGenerated");
      expect(orchestratorSource).toContain("bgEmbeddingsGenerated");
      expect(orchestratorSource).toContain("jsAnimationEmbeddingsGenerated");
      expect(orchestratorSource).toContain("responsiveEmbeddingsGenerated");
      expect(orchestratorSource).toContain("partEmbeddingsGenerated");
    });

    it("visual-result から2種のvisual countをマージすること / should merge 2 visual counts", () => {
      expect(orchestratorSource).toContain("sectionVisualEmbeddingsGenerated");
      expect(orchestratorSource).toContain("partVisualEmbeddingsGenerated");
    });

    it("error/abnormal-exit/IPC race で embeddingFailedChunks がインクリメントされること / should increment failed chunks on all failure paths", () => {
      // Count occurrences of embeddingFailedChunks++ in error paths
      const failedChunksIncrement = (
        orchestratorSource.match(/result\.embeddingFailedChunks\+\+/g) || []
      ).length;
      // mergeChildResult has 3 failure paths + pre-fork checks can also increment
      expect(failedChunksIncrement).toBeGreaterThanOrEqual(3);
    });
  });

  // ==========================================================================
  // G. V8 heap headroom check
  // ==========================================================================
  describe("G. V8 ヒープヘッドルーム不足時のスキップ / V8 heap headroom check", () => {
    it("fork 前に V8 ヒープ残量チェックが存在すること / should check V8 heap before fork", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      expect(orchestratorSource).toContain("getHeapStatistics");
      expect(orchestratorSource).toContain("MIN_HEAP_HEADROOM_BYTES");
      expect(orchestratorSource).toContain("Insufficient V8 heap headroom");
    });

    it("MIN_HEAP_HEADROOM_BYTES が 512MB であること / MIN_HEAP_HEADROOM_BYTES should be 512MB", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      expect(orchestratorSource).toMatch(
        /MIN_HEAP_HEADROOM_BYTES\s*=\s*512\s*\*\s*1024\s*\*\s*1024/
      );
    });

    it("ヒープ不足時に early return すること / should early return when insufficient", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // Pattern: if (heapRemaining < MIN_HEAP_HEADROOM_BYTES) { ... return result; }
      expect(orchestratorSource).toMatch(/heapRemaining\s*<\s*MIN_HEAP_HEADROOM_BYTES/);
    });
  });

  // ==========================================================================
  // H. System MemAvailable check (OOM-FIX-4)
  // ==========================================================================
  describe("H. システムメモリ不足 / System MemAvailable check (OOM-FIX-4)", () => {
    it("fork 前に /proc/meminfo チェックが存在すること / should check /proc/meminfo before fork", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      expect(orchestratorSource).toContain("/proc/meminfo");
      expect(orchestratorSource).toContain("MemAvailable");
      expect(orchestratorSource).toContain("MIN_SYSTEM_MEM_AVAILABLE_BYTES");
    });

    it("非 Linux 環境で graceful に null を返すこと / should return null on non-Linux", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // getSystemMemAvailable catches errors and returns null
      expect(orchestratorSource).toMatch(/catch\s*\{[\s\S]*?\}[\s\S]*?return\s+null/);
    });

    it("memAvailable が null の場合 fork を続行すること / should continue when memAvailable is null", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // Check: memAvailable !== null && memAvailable < threshold
      expect(orchestratorSource).toMatch(
        /memAvailable\s*!==\s*null\s*&&\s*memAvailable\s*<\s*MIN_SYSTEM_MEM_AVAILABLE_BYTES/
      );
    });
  });

  // ==========================================================================
  // I. IPC ヘルパー関数の実行テスト (appendConnectionLimit / serializeIdMapping)
  // ==========================================================================
  describe("I. IPC ヘルパー関数 / IPC helper functions", () => {
    it("appendConnectionLimit がクエリパラメータなし URL に ? で追加すること", async () => {
      const { appendConnectionLimit } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const result = appendConnectionLimit("postgresql://user:pass@localhost:26432/reftrix", 3);
      expect(result).toBe("postgresql://user:pass@localhost:26432/reftrix?connection_limit=3");
    });

    it("appendConnectionLimit が既存クエリパラメータ URL に & で追加すること", async () => {
      const { appendConnectionLimit } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const result = appendConnectionLimit(
        "postgresql://user:pass@localhost:26432/reftrix?sslmode=require",
        5
      );
      expect(result).toBe(
        "postgresql://user:pass@localhost:26432/reftrix?sslmode=require&connection_limit=5"
      );
    });

    it("serializeIdMapping が Map を [key, value][] に変換すること", async () => {
      const { serializeIdMapping } = await import("../../../src/workers/phases/phase-5-child-ipc");

      const map = new Map([
        ["section-1", "db-section-1"],
        ["section-2", "db-section-2"],
      ]);
      const result = serializeIdMapping(map);
      expect(result).toEqual([
        ["section-1", "db-section-1"],
        ["section-2", "db-section-2"],
      ]);
    });

    it("serializeIdMapping が null/undefined/空 Map で null を返すこと", async () => {
      const { serializeIdMapping } = await import("../../../src/workers/phases/phase-5-child-ipc");

      expect(serializeIdMapping(null)).toBeNull();
      expect(serializeIdMapping(undefined)).toBeNull();
      expect(serializeIdMapping(new Map())).toBeNull();
    });

    it("deserializeIdMapping が [key, value][] を Map に変換すること", async () => {
      const { deserializeIdMapping } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const entries: [string, string][] = [
        ["s1", "db-s1"],
        ["s2", "db-s2"],
      ];
      const result = deserializeIdMapping(entries);
      expect(result).toBeInstanceOf(Map);
      expect(result.get("s1")).toBe("db-s1");
      expect(result.get("s2")).toBe("db-s2");
    });

    it("deserializeIdMapping が null で空 Map を返すこと", async () => {
      const { deserializeIdMapping } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const result = deserializeIdMapping(null);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("truncateErrorForIPC が長いメッセージを 1000 文字に切り詰めること", async () => {
      const { truncateErrorForIPC, IPC_ERROR_MESSAGE_MAX_LENGTH } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const longMessage = "x".repeat(2000);
      const truncated = truncateErrorForIPC(longMessage);
      expect(truncated.length).toBe(IPC_ERROR_MESSAGE_MAX_LENGTH);
      expect(truncated.length).toBe(1000);
    });

    it("truncateErrorForIPC が短いメッセージをそのまま返すこと", async () => {
      const { truncateErrorForIPC } = await import("../../../src/workers/phases/phase-5-child-ipc");

      const shortMessage = "ONNX inference failed";
      expect(truncateErrorForIPC(shortMessage)).toBe(shortMessage);
    });
  });

  // ==========================================================================
  // J. IPC Zod スキーマバリデーション
  // ==========================================================================
  describe("J. IPC Zod スキーマバリデーション / IPC Zod schema validation", () => {
    it("validateChildMessage が正しい heartbeat メッセージを通すこと", async () => {
      const { validateChildMessage } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const msg = {
        type: "heartbeat",
        rssMb: 1200,
        rssDeltaMb: 200,
        phase: "text-embedding",
      };
      const result = validateChildMessage(msg);
      expect(result).toEqual(msg);
    });

    it("validateChildMessage が正しい text-result メッセージを通すこと", async () => {
      const { validateChildMessage } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const msg = {
        type: "text-result",
        sectionEmbeddingsGenerated: 10,
        motionEmbeddingsGenerated: 3,
        bgEmbeddingsGenerated: 2,
        jsAnimationEmbeddingsGenerated: 1,
        responsiveEmbeddingsGenerated: 1,
        partEmbeddingsGenerated: 5,
        embeddingFailedChunks: 0,
      };
      const result = validateChildMessage(msg);
      expect(result).toEqual(msg);
    });

    it("validateChildMessage が正しい visual-result メッセージを通すこと", async () => {
      const { validateChildMessage } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const msg = {
        type: "visual-result",
        sectionVisualEmbeddingsGenerated: 4,
        partVisualEmbeddingsGenerated: 3,
        // PR-D-2: additively added; Zod schema defaults to 0 when absent
        partVisualSkippedBboxInvalid: 0,
        // ADR-0018 Amendment 7 §7.6 exit #2 (Plan v2 PR-B): additively added;
        // Zod schema defaults to 0 when absent (symmetric with bbox_invalid)
        partVisualSkippedBboxUnresolvable: 0,
        embeddingFailedChunks: 0,
      };
      const result = validateChildMessage(msg);
      expect(result).toEqual(msg);
    });

    it("validateChildMessage が visual-result から partVisualSkippedBboxInvalid が欠落しても 0 に default する (PR-D-2 additive)", async () => {
      const { validateChildMessage } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      // Legacy child (PR-D-1 or earlier) did not send partVisualSkippedBboxInvalid.
      // Zod optional().default(0) must fill it in for back-compat.
      const legacyMsg = {
        type: "visual-result",
        sectionVisualEmbeddingsGenerated: 1,
        partVisualEmbeddingsGenerated: 2,
        embeddingFailedChunks: 0,
      };
      const result = validateChildMessage(legacyMsg);
      expect(result).toMatchObject({
        type: "visual-result",
        sectionVisualEmbeddingsGenerated: 1,
        partVisualEmbeddingsGenerated: 2,
        partVisualSkippedBboxInvalid: 0,
        embeddingFailedChunks: 0,
      });
    });

    it("validateChildMessage が正しい error メッセージを通すこと", async () => {
      const { validateChildMessage } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const msg = {
        type: "error",
        message: "ONNX inference failed",
        phase: "text-embedding-uncaught",
      };
      const result = validateChildMessage(msg);
      expect(result).toEqual(msg);
    });

    it("validateChildMessage が不正なメッセージで null を返すこと", async () => {
      const { validateChildMessage } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      expect(validateChildMessage({ type: "unknown-type" })).toBeNull();
      expect(validateChildMessage(null)).toBeNull();
      expect(validateChildMessage("string")).toBeNull();
      expect(validateChildMessage(42)).toBeNull();
    });

    it("validateChildMessage が負のカウント値を拒否すること", async () => {
      const { validateChildMessage } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const msg = {
        type: "text-result",
        sectionEmbeddingsGenerated: -1,
        motionEmbeddingsGenerated: 0,
        bgEmbeddingsGenerated: 0,
        jsAnimationEmbeddingsGenerated: 0,
        responsiveEmbeddingsGenerated: 0,
        partEmbeddingsGenerated: 0,
        embeddingFailedChunks: 0,
      };
      expect(validateChildMessage(msg)).toBeNull();
    });

    it("validateParentMessage が init-text メッセージを通すこと", async () => {
      const { validateParentMessage } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const msg = {
        type: "init-text",
        webPageId: "01234567-89ab-cdef-0123-456789abcdef",
        url: "https://example.com",
        sectionIdMapping: [["s1", "db-s1"]],
        motionIdMapping: null,
        jsIdMapping: null,
        bgIds: null,
        scrollVisionIdMapping: null,
        layoutResultJson: null,
        motionResultJson: null,
        jsAnimationsJson: null,
        scrollVisionResultJson: null,
      };
      const result = validateParentMessage(msg);
      expect(result).toEqual(msg);
    });

    it("validateParentMessage が lock-ack メッセージを通すこと", async () => {
      const { validateParentMessage } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      const msg = { type: "lock-ack", success: true };
      const result = validateParentMessage(msg);
      expect(result).toEqual(msg);
    });

    it("validateParentMessage が不正なメッセージで null を返すこと", async () => {
      const { validateParentMessage } =
        await import("../../../src/workers/phases/phase-5-child-ipc");

      expect(validateParentMessage({ type: "garbage" })).toBeNull();
      expect(validateParentMessage(undefined)).toBeNull();
    });
  });

  // ==========================================================================
  // K. Visual child スキップ条件
  // ==========================================================================
  describe("K. Visual child スキップ条件 / visual child skip conditions", () => {
    it("visual sub-phase forks が screenshot 存在でゲートされ、section/part 存在は descriptor shouldRun が担う (PR-BT-5 ADR-0039)", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // PR-BT-5 (ADR-0039): the orchestrator gates the visual sub-phase fork
      // loop on screenshot presence (`if (hasScreenshot)`); the per-sub-phase
      // section/part data-presence decision is now owned by the visual
      // descriptors' `shouldRun` (buildVisualSubPhaseDescriptors), NOT by an
      // inline `hasSections || hasParts` gate. So `hasScreenshot` + the descriptor
      // builder must be present; the old combined `if (hasScreenshot && (...))`
      // gate is replaced.
      expect(orchestratorSource).toContain("hasScreenshot");
      expect(orchestratorSource).toMatch(/if\s*\(hasScreenshot\)/);
      expect(orchestratorSource).toContain("buildVisualSubPhaseDescriptors");
      // `hasParts` is still computed (gates resolvePartBboxFn before part_visual).
      expect(orchestratorSource).toContain("hasParts");
    });
  });

  // ==========================================================================
  // L. Part bbox 解決
  // ==========================================================================
  describe("L. Part bbox 解決 / part bounding box resolution", () => {
    it("partsSavedCount > 0 の場合のみ resolvePartBboxFn が呼ばれる構造であること / should only call bbox fn when parts exist", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // hasParts check before resolvePartBboxFn call
      expect(orchestratorSource).toMatch(
        /const\s+hasParts\s*=\s*\(partsSavedCount\s*\?\?\s*0\)\s*>\s*0/
      );
      expect(orchestratorSource).toMatch(/if\s*\(hasParts\)/);
      expect(orchestratorSource).toContain("resolvePartBboxFn");
    });

    it("resolvePartBboxFn 失敗が non-fatal として処理されること / bbox failure is non-fatal", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      expect(orchestratorSource).toContain("Part bbox resolution failed (non-fatal)");
    });
  });

  // ==========================================================================
  // M. completed フラグ計算
  // ==========================================================================
  describe("M. completed フラグ / completed flag logic", () => {
    it("completed が embeddingFailedChunks===0 OR embeddings>0 で true になること / should be true when no failures or some embeddings generated", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // result.completed = failedChunks === 0 || sectionEmbeddings > 0 || motionEmbeddings > 0
      expect(orchestratorSource).toMatch(
        /result\.completed\s*=[\s\S]*embeddingFailedChunks\s*===\s*0/
      );
      expect(orchestratorSource).toMatch(/sectionEmbeddingsGenerated\s*>\s*0/);
      expect(orchestratorSource).toMatch(/motionEmbeddingsGenerated\s*>\s*0/);
    });
  });

  // ==========================================================================
  // N. OOM-FIX-2: JSON string 参照解放
  // ==========================================================================
  describe("N. OOM-FIX-2: JSON string 参照解放 / JSON string release pattern", () => {
    // PR-BT-5 (ADR-0039): the text IPC payloads are serialized ONCE and reused
    // across the (up to 7) text sub-phase forks, then released together after
    // the loop via `textPayloads = null` (the old per-string `let ... = null`
    // pattern is replaced by a single payload-bundle release — same OOM-FIX-2
    // intent, relocated to after the dispatch loop).
    it("text sub-phase payloads が dispatch loop 完了後に null に解放されること (PR-BT-5 OOM-FIX-2)", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // The serialized payloads are built into a `textPayloads` bundle and
      // released after the loop.
      expect(orchestratorSource).toContain("textPayloads = null");
      // OOM-FIX-2 intent documented.
      expect(orchestratorSource).toContain("Release the text payloads after all text forks");
      // The 4 large JSON payloads are still serialized (held in the bundle).
      expect(orchestratorSource).toContain("layoutResultJson");
      expect(orchestratorSource).toContain("motionResultJson");
      expect(orchestratorSource).toContain("jsAnimationsJson");
      expect(orchestratorSource).toContain("scrollVisionResultJson");
    });

    it("text payloads bundle が GC を伴って解放されること / payloads released with GC after fork loop", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // `textPayloads = null` followed by an optional GC (OOM-FIX-2 semantics).
      expect(orchestratorSource).toMatch(/textPayloads\s*=\s*null;[\s\S]{0,200}globalThis\.gc/);
    });
  });

  // ==========================================================================
  // O. Pre-fork メモリ計測ログ
  // ==========================================================================
  describe("O. Pre-fork メモリ計測ログ / Pre-fork memory measurement", () => {
    it("fork 前に RSS/heapUsed/external/arrayBuffers のログが出力されること / should log memory snapshot before fork", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      expect(orchestratorSource).toContain("Pre-fork memory snapshot");
      expect(orchestratorSource).toContain("rssMb");
      expect(orchestratorSource).toContain("heapUsedMb");
      expect(orchestratorSource).toContain("externalMb");
      expect(orchestratorSource).toContain("arrayBuffersMb");
    });
  });

  // ==========================================================================
  // P. セカンダリ tmp ファイルクリーンアップ (P1-17)
  // ==========================================================================
  describe("P. セカンダリ tmp クリーンアップ (P1-17) / Secondary tmp cleanup", () => {
    it("fork 完了後に cleanupPhase5TempDir が呼ばれること (v0.4.0 PR7d-1) / should call cleanupPhase5TempDir after fork", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // v0.4.0 PR7d-1 (ADR-0010): cleanupPhase5TmpDirOnly was removed and
      //   delegated to cleanupPhase5TempDir (which now carries a 3-stage
      //   whitelist defense via realpath + os.tmpdir() containment + prefix).
      // v0.4.0 PR7d-1 (ADR-0010): cleanupPhase5TmpDirOnly removed and
      //   delegates to cleanupPhase5TempDir (3-stage whitelist defense).
      expect(orchestratorSource).toContain("cleanupPhase5TempDir");

      // The old helper name must be removed from executable code but may
      // appear in comments as a migration note.
      const codeOnly = orchestratorSource
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      expect(codeOnly).not.toContain("cleanupScreenshotAndTmp");
      expect(codeOnly).not.toContain("cleanupPhase5TmpDirOnly(");
    });

    it("Phase 5 orchestrator が ScreenshotPersistenceService.deleteScreenshot() を呼ばないこと / should NOT call ScreenshotPersistenceService.deleteScreenshot() from Phase 5 orchestrator (v0.4.0 PR7c/PR7d-1)", () => {
      // v0.4.0 PR7c / PR7d-1 regression guard:
      //   The Phase 5 orchestrator must NOT call deleteScreenshot(); otherwise
      //   the Queue-based Backfill sees a zero-byte file and produces zero
      //   visual embeddings. Deletion is consolidated into PR6 TTL cron +
      //   GDPR `data.delete`. See ADR-0009 + ADR-0010.
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      const codeOnly = orchestratorSource
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");

      // Negative assertion — no deleteScreenshot call anywhere in executable code.
      expect(codeOnly).not.toMatch(/\.deleteScreenshot\s*\(/);
      // Negative assertion — no IPhase5ScreenshotPersistence reference in executable code.
      expect(codeOnly).not.toContain("IPhase5ScreenshotPersistence");
      // Positive sanity: the successor helper is still present.
      expect(codeOnly).toContain("cleanupPhase5TempDir");
    });
  });

  // ==========================================================================
  // Q. IPC setImmediate race condition fix
  // ==========================================================================
  describe("Q. IPC setImmediate race condition fix / exit イベント遅延処理", () => {
    it("child exit イベントで setImmediate を使用して IPC message の drain を待つこと / should use setImmediate in exit handler", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");

      // Fix: Use setImmediate to let pending IPC "message" events drain first
      expect(orchestratorSource).toContain("setImmediate");
      expect(orchestratorSource).toContain('let pending IPC "message" events drain');
    });
  });

  // ==========================================================================
  // R. RSS Delta Self-Monitoring (v0.4.0 PR3) / 子プロセスRSS delta 自己監視機構
  //
  // v0.4.0 PR3 で絶対値ベースの RSS 監視 (PHASE5_CHILD_RSS_*_MB) から
  // delta ベース (PHASE5_CHILD_RSS_*_DELTA_MB) に移行した。fork() COW で
  // 子プロセスが親の RSS を継承する問題 (Stripe バグ) を根本解決するため。
  //
  // Migrated absolute-value RSS monitoring (PHASE5_CHILD_RSS_*_MB) to
  // delta-based monitoring (PHASE5_CHILD_RSS_*_DELTA_MB) in v0.4.0 PR3 to
  // fix the Stripe bug where fork() COW made the child inherit the parent's
  // RSS, producing false-positive self-kills.
  // ==========================================================================
  describe("R. RSS Delta Self-Monitoring (v0.4.0 PR3) / 子プロセスRSS delta 自己監視機構", () => {
    it("phase-5-child-ipc が CHILD_RSS_WARN_DELTA_MB 定数を export すること / should export CHILD_RSS_WARN_DELTA_MB", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      expect(ipcSource).toMatch(/export const CHILD_RSS_WARN_DELTA_MB\b/);
    });

    it("phase-5-child-ipc が CHILD_RSS_KILL_DELTA_MB 定数を export すること / should export CHILD_RSS_KILL_DELTA_MB", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      expect(ipcSource).toMatch(/export const CHILD_RSS_KILL_DELTA_MB\b/);
    });

    it("CHILD_RSS_WARN_DELTA_MB が safeParseInt で環境変数オーバーライド可能であること / should use safeParseInt for env override", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      expect(ipcSource).toContain("PHASE5_CHILD_RSS_WARN_DELTA_MB");
      expect(ipcSource).toMatch(/safeParseInt\s*\(\s*process\.env\.PHASE5_CHILD_RSS_WARN_DELTA_MB/);
    });

    it("CHILD_RSS_KILL_DELTA_MB が safeParseInt で環境変数オーバーライド可能であること / should use safeParseInt for env override", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      expect(ipcSource).toContain("PHASE5_CHILD_RSS_KILL_DELTA_MB");
      expect(ipcSource).toMatch(/safeParseInt\s*\(\s*process\.env\.PHASE5_CHILD_RSS_KILL_DELTA_MB/);
    });

    it("旧絶対値環境変数 (PHASE5_CHILD_RSS_WARN_MB/KILL_MB) がソースから完全削除されていること / legacy absolute-value env vars fully removed (no parallel paths)", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      // Only comments (prefixed with //) may reference the legacy names.
      // The live code (safeParseInt / exports) must NOT use them.
      expect(ipcSource).not.toMatch(/safeParseInt\s*\(\s*process\.env\.PHASE5_CHILD_RSS_WARN_MB\b/);
      expect(ipcSource).not.toMatch(/safeParseInt\s*\(\s*process\.env\.PHASE5_CHILD_RSS_KILL_MB\b/);
      expect(ipcSource).not.toMatch(/export const CHILD_RSS_WARN_MB\b/);
      expect(ipcSource).not.toMatch(/export const CHILD_RSS_KILL_MB\b/);
    });

    it("子プロセス側: startHeartbeat が RSS delta kill 閾値チェックと自己終了を含むこと / child self-terminates on RSS delta > kill threshold", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      // Self-kill path: delta check, log, send error, exit(1)
      expect(ipcSource).toMatch(/rssDeltaMb\s*>\s*CHILD_RSS_KILL_DELTA_MB/);
      expect(ipcSource).toContain("rss-kill");
      expect(ipcSource).toContain("process.exit(1)");
    });

    it("子プロセス側: startHeartbeat が RSS delta warn 閾値ログを含むこと / child logs warning on RSS delta > warn threshold", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      expect(ipcSource).toMatch(/rssDeltaMb\s*>\s*CHILD_RSS_WARN_DELTA_MB/);
      expect(ipcSource).toContain("console.warn");
    });

    it("子プロセス側: startHeartbeat が initialRssMb をベースラインとして記録すること / child captures initialRssMb baseline", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      // Delta calculation: currentRss - initialRss
      expect(ipcSource).toContain("initialRssMb");
      expect(ipcSource).toMatch(/rssMb\s*-\s*initialRssMb/);
    });

    it("子プロセス側: rssKillInProgress フラグで二重終了を防ぐこと / should prevent double-exit via flag", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      expect(ipcSource).toContain("rssKillInProgress");
    });

    it("親プロセス側: fork orchestrator が CHILD_RSS_KILL_DELTA_MB をインポートすること / parent imports CHILD_RSS_KILL_DELTA_MB", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
      expect(orchestratorSource).toContain("CHILD_RSS_KILL_DELTA_MB");
      expect(orchestratorSource).toMatch(
        /from\s+["']\.\/phase-5-child-ipc["']|from\s+["']\.\/phase-5-child-ipc\.js["']/
      );
    });

    it("親プロセス側: fork orchestrator が旧 CHILD_RSS_KILL_MB 絶対値シンボルを参照しないこと / parent no longer references legacy absolute-value CHILD_RSS_KILL_MB", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
      // The old symbol would appear in `import { CHILD_RSS_KILL_MB }` or a
      // non-delta comparison. Neither is allowed (technical debt zero).
      expect(orchestratorSource).not.toMatch(/\bCHILD_RSS_KILL_MB\b(?!_DELTA)/);
      expect(orchestratorSource).not.toMatch(/msg\.rssMb\s*>\s*CHILD_RSS_KILL_MB\b(?!_DELTA)/);
    });

    it("親プロセス側: heartbeat ハンドラが msg.rssDeltaMb > CHILD_RSS_KILL_DELTA_MB で SIGKILL を送ること / parent kills child on heartbeat RSS delta exceed", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
      // Parent-side delta-based kill switch (backup layer)
      expect(orchestratorSource).toMatch(/msg\.rssDeltaMb\s*>\s*CHILD_RSS_KILL_DELTA_MB/);
      expect(orchestratorSource).toContain('child.kill("SIGKILL")');
    });

    it("親プロセス側: killedByRssSwitch フラグで二重SIGKILLを防ぐこと / parent prevents double SIGKILL via flag (TPA improvement #1)", () => {
      const orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
      // TPA #1: double-kill prevention — heartbeats arrive every 10s
      expect(orchestratorSource).toContain("killedByRssSwitch");
      expect(orchestratorSource).toMatch(/if\s*\(\s*!killedByRssSwitch\s*\)/);
    });

    it("子プロセス側: validateRssDeltaThresholds で kill <= warn を検出しデフォルトにフォールバック / child validates kill > warn (SEC L2)", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      // SEC L2: cross-consistency validation on delta thresholds
      expect(ipcSource).toContain("validateRssDeltaThresholds");
      expect(ipcSource).toMatch(/kill\s*<=\s*warn/);
      expect(ipcSource).toContain("Falling back to defaults");
    });

    it("子プロセス側: stopHeartbeat が rssKillInProgress と initialRssMb をリセットすること / stopHeartbeat resets flag and baseline (TDA M-2)", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      // TDA M-2: test isolation and re-entrancy safety
      expect(ipcSource).toMatch(/stopHeartbeat[\s\S]{0,400}rssKillInProgress\s*=\s*false/);
      expect(ipcSource).toMatch(/stopHeartbeat[\s\S]{0,400}initialRssMb\s*=\s*0/);
    });

    it("デフォルト閾値が設計値（warnDelta=2560MB, killDelta=4096MB）であること / default delta thresholds match design", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      // Default: WARN_DELTA=2560 (2.5GB), KILL_DELTA=4096 (4GB)
      // β2-P1: 2048→2560 / 3072→4096 (e5-base CPU mode RSS delta ~3.1GB)
      expect(ipcSource).toMatch(/PHASE5_CHILD_RSS_WARN_DELTA_MB[\s\S]{0,120}2560/);
      expect(ipcSource).toMatch(/PHASE5_CHILD_RSS_KILL_DELTA_MB[\s\S]{0,120}4096/);
    });

    it("IPC heartbeat スキーマが rssDeltaMb を必須フィールドとして定義すること / heartbeat schema requires rssDeltaMb", () => {
      const ipcSource = fs.readFileSync(CHILD_IPC_SRC, "utf-8");
      // rssDeltaMb must be declared in childHeartbeatSchema (not optional)
      expect(ipcSource).toMatch(
        /childHeartbeatSchema[\s\S]{0,500}rssDeltaMb:\s*z\.number\(\)(?!\.optional)/
      );
    });
  });

  // ==========================================================================
  // L. PR2 (v0.4.0): EmbeddingSkipReason 設定の網羅性
  // L. PR2 (v0.4.0): EmbeddingSkipReason coverage on all failure paths
  // ==========================================================================
  describe("L. EmbeddingSkipReason 設定 / EmbeddingSkipReason propagation (PR2)", () => {
    let orchestratorSource: string;

    beforeEach(() => {
      orchestratorSource = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
    });

    it("V8 ヒープ不足時に skipReason='v8_heap_headroom_low' を設定すること / sets v8_heap_headroom_low on heap pressure", () => {
      // Expect setSkipReasonIfUnset call in the V8 heap early-return path
      expect(orchestratorSource).toMatch(
        /Insufficient V8 heap headroom[\s\S]{0,600}setSkipReasonIfUnset\(\s*result,\s*["']v8_heap_headroom_low["']/
      );
    });

    it("システムメモリ不足時に skipReason='system_memavailable_low' を設定すること / sets system_memavailable_low on MemAvailable pressure", () => {
      expect(orchestratorSource).toMatch(
        /Insufficient system memory[\s\S]{0,600}setSkipReasonIfUnset\(\s*result,\s*["']system_memavailable_low["']/
      );
    });

    // PR-BT-5 (ADR-0039): the per-sub-phase fork helpers
    // (runTextSubPhaseFork / runVisualSubPhaseFork) use a unified `forkError`
    // catch variable. The skipReason contract (text_fork_failed /
    // visual_fork_failed on fork exception) is PRESERVED — only the catch var
    // name changed (textError/visualError → forkError).
    it("Text sub-phase fork 例外時に skipReason='text_fork_failed' を設定すること / sets text_fork_failed on fork exception", () => {
      expect(orchestratorSource).toMatch(
        /catch\s*\(forkError\)[\s\S]{0,500}setSkipReasonIfUnset\(\s*result,\s*["']text_fork_failed["']/
      );
    });

    it("Visual sub-phase fork 例外時に skipReason='visual_fork_failed' を設定すること / sets visual_fork_failed on fork exception", () => {
      expect(orchestratorSource).toMatch(
        /catch\s*\(forkError\)[\s\S]{0,500}setSkipReasonIfUnset\(\s*result,\s*["']visual_fork_failed["']/
      );
    });

    it("Text channel の skipReason triple が定義されていること / TEXT_CHANNEL_REASONS triple defined", () => {
      expect(orchestratorSource).toContain("TEXT_CHANNEL_REASONS");
      expect(orchestratorSource).toContain('"text_child_error"');
      expect(orchestratorSource).toContain('"text_child_abnormal_exit"');
      expect(orchestratorSource).toContain('"text_ipc_race"');
    });

    it("Visual channel の skipReason triple が定義されていること / VISUAL_CHANNEL_REASONS triple defined", () => {
      expect(orchestratorSource).toContain("VISUAL_CHANNEL_REASONS");
      expect(orchestratorSource).toContain('"visual_child_error"');
      expect(orchestratorSource).toContain('"visual_child_abnormal_exit"');
      expect(orchestratorSource).toContain('"visual_ipc_race"');
    });

    it("mergeChildResult が全3失敗分岐で setSkipReasonIfUnset を呼ぶこと / mergeChildResult calls setSkipReasonIfUnset on all 3 failure branches", () => {
      // Count occurrences of setSkipReasonIfUnset in the mergeChildResult body.
      // Expected: error / abnormalExit / ipcRace → 3 calls at minimum
      const match = orchestratorSource.match(/function mergeChildResult[\s\S]*?\n\}\n/);
      expect(match).not.toBeNull();
      const body = match![0];
      const callCount = (body.match(/setSkipReasonIfUnset\(/g) || []).length;
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it("setSkipReasonIfUnset が先着の理由を保持すること / setSkipReasonIfUnset preserves first-arrival reason", () => {
      // Guard: result.skipReason === undefined before assignment
      expect(orchestratorSource).toMatch(
        /function setSkipReasonIfUnset[\s\S]*?if\s*\(\s*result\.skipReason\s*===\s*undefined\s*\)/
      );
    });

    it("skipReason 値が EMBEDDING_SKIP_REASONS enum 値のみを参照すること / only references EMBEDDING_SKIP_REASONS values", async () => {
      // Load the EMBEDDING_SKIP_REASONS enum and check each skipReason string
      // literal in the orchestrator source is a member of the enum.
      const typesPath = path.resolve(__dirname, "../../../src/workers/phases/types.ts");
      const typesSource = fs.readFileSync(typesPath, "utf-8");
      const match = typesSource.match(/EMBEDDING_SKIP_REASONS\s*=\s*\[([\s\S]*?)\]\s*as const/);
      expect(match).not.toBeNull();
      const enumLiterals = (match![1].match(/"[a-z0-9_]+"/g) || []).map((s) => s.slice(1, -1));
      const requiredReasons = [
        "v8_heap_headroom_low",
        "system_memavailable_low",
        "text_fork_failed",
        "text_child_error",
        "text_child_abnormal_exit",
        "text_ipc_race",
        "visual_fork_failed",
        "visual_child_error",
        "visual_child_abnormal_exit",
        "visual_ipc_race",
        "no_embeddable_items",
      ];
      for (const r of requiredReasons) {
        expect(enumLiterals).toContain(r);
      }
    });
  });
});
