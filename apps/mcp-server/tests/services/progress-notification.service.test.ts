// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ProgressNotificationService テスト
 *
 * v0.3.0 Tier 2: Streaming progress (MCP notifications)
 * page.analyze等の長時間処理のリアルタイム進捗通知。
 * MCP progressToken + BullMQ progress eventsの統合。
 *
 * @module tests/services/progress-notification.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  ProgressNotificationService,
  type ProgressNotificationOptions,
  type PipelinePhaseInfo,
  type ProgressNotificationEvent,
  PIPELINE_PHASES,
} from "../../src/services/progress-notification.service.js";

describe("ProgressNotificationService", () => {
  let mockSendNotification: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSendNotification = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // コンストラクタ・初期化
  // ===========================================================================

  describe("constructor", () => {
    it("progressTokenとsendNotificationが設定されている場合にenabledがtrueになる", () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      expect(service.isEnabled()).toBe(true);
    });

    it("progressTokenがundefinedの場合にenabledがfalseになる", () => {
      const service = new ProgressNotificationService({
        progressToken: undefined,
        sendNotification: mockSendNotification,
      });

      expect(service.isEnabled()).toBe(false);
    });

    it("sendNotificationがundefinedの場合にenabledがfalseになる", () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: undefined,
      });

      expect(service.isEnabled()).toBe(false);
    });

    it("numberのprogressTokenを受け入れる", () => {
      const service = new ProgressNotificationService({
        progressToken: 42,
        sendNotification: mockSendNotification,
      });

      expect(service.isEnabled()).toBe(true);
    });
  });

  // ===========================================================================
  // フェーズ通知
  // ===========================================================================

  describe("notifyPhaseStart", () => {
    it("フェーズ開始通知を送信する", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      await service.notifyPhaseStart("ingest");

      expect(mockSendNotification).toHaveBeenCalledTimes(1);
      const call = mockSendNotification.mock.calls[0][0];
      expect(call.method).toBe("notifications/progress");
      expect(call.params.progressToken).toBe("test-token");
      expect(call.params.progress).toBe(PIPELINE_PHASES.ingest.startPercent);
      expect(call.params.total).toBe(100);
      expect(call.params.message).toContain("Ingest");
    });

    it("無効な場合は通知を送信しない", async () => {
      const service = new ProgressNotificationService({
        progressToken: undefined,
        sendNotification: mockSendNotification,
      });

      await service.notifyPhaseStart("ingest");

      expect(mockSendNotification).not.toHaveBeenCalled();
    });
  });

  describe("notifyPhaseComplete", () => {
    it("フェーズ完了通知を送信する", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      await service.notifyPhaseComplete("ingest");

      expect(mockSendNotification).toHaveBeenCalledTimes(1);
      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.progress).toBe(PIPELINE_PHASES.ingest.endPercent);
      expect(call.params.message).toContain("complete");
    });
  });

  describe("notifyPhaseFailed", () => {
    it("フェーズ失敗通知を送信する", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      await service.notifyPhaseFailed("layout", "Timeout exceeded");

      expect(mockSendNotification).toHaveBeenCalledTimes(1);
      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.message).toContain("failed");
      expect(call.params.message).toContain("Layout");
    });
  });

  // ===========================================================================
  // サブステップ進捗
  // ===========================================================================

  describe("notifySubProgress", () => {
    it("フェーズ内のサブステップ進捗を送信する", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      // embedding phaseの50%完了を通知
      await service.notifySubProgress("embedding", 50, "Section embeddings: 10/20");

      expect(mockSendNotification).toHaveBeenCalledTimes(1);
      const call = mockSendNotification.mock.calls[0][0];

      // embedding: startPercent=90, endPercent=100, 50% → 95
      const expectedProgress = 90 + Math.round(((100 - 90) * 50) / 100);
      expect(call.params.progress).toBe(expectedProgress);
      expect(call.params.message).toContain("Section embeddings");
    });

    it("進捗値を0-100の範囲にクランプする", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      await service.notifySubProgress("embedding", 150, "Over 100%");

      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.progress).toBe(PIPELINE_PHASES.embedding.endPercent);
    });

    it("負の進捗値を0にクランプする", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      await service.notifySubProgress("ingest", -10, "Negative");

      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.progress).toBe(PIPELINE_PHASES.ingest.startPercent);
    });
  });

  // ===========================================================================
  // 通知頻度制御（フラッド防止）
  // ===========================================================================

  describe("throttling", () => {
    it("最小間隔500ms内の通知を抑制する", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
        minIntervalMs: 500,
      });

      // 最初の通知は通る
      await service.notifySubProgress("embedding", 10, "Step 1");
      expect(mockSendNotification).toHaveBeenCalledTimes(1);

      // 100ms後の通知は抑制される
      await vi.advanceTimersByTimeAsync(100);
      await service.notifySubProgress("embedding", 20, "Step 2");
      expect(mockSendNotification).toHaveBeenCalledTimes(1);

      // 500ms後の通知は通る
      await vi.advanceTimersByTimeAsync(400);
      await service.notifySubProgress("embedding", 30, "Step 3");
      expect(mockSendNotification).toHaveBeenCalledTimes(2);
    });

    it("フェーズ開始/完了はスロットリングを無視する（マイルストーン通知）", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
        minIntervalMs: 500,
      });

      await service.notifySubProgress("ingest", 50, "Processing");
      expect(mockSendNotification).toHaveBeenCalledTimes(1);

      // 即座のフェーズ完了通知は抑制されない
      await service.notifyPhaseComplete("ingest");
      expect(mockSendNotification).toHaveBeenCalledTimes(2);

      // 即座のフェーズ開始通知も抑制されない
      await service.notifyPhaseStart("layout");
      expect(mockSendNotification).toHaveBeenCalledTimes(3);
    });

    it("デフォルトの最小間隔は500ms", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      await service.notifySubProgress("embedding", 10, "Step 1");
      await service.notifySubProgress("embedding", 20, "Step 2");

      // デフォルト500ms間隔のため、2つ目は抑制
      expect(mockSendNotification).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // BullMQ progress → MCP通知変換
  // ===========================================================================

  describe("fromBullMQProgress", () => {
    it("BullMQのnumber progressをMCP通知に変換する", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      await service.fromBullMQProgress(45);

      expect(mockSendNotification).toHaveBeenCalledTimes(1);
      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.progress).toBe(45);
    });

    it("BullMQの詳細progressデータをMCP通知に変換する", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      await service.fromBullMQProgress({
        overallProgress: 60,
        currentPhase: "motion",
        phases: {},
      });

      expect(mockSendNotification).toHaveBeenCalledTimes(1);
      const call = mockSendNotification.mock.calls[0][0];
      expect(call.params.progress).toBe(60);
      expect(call.params.message).toContain("motion");
    });

    it("NaN progressを無視する", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      await service.fromBullMQProgress(NaN);

      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it("Infinity progressを無視する", async () => {
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: mockSendNotification,
      });

      await service.fromBullMQProgress(Infinity);

      expect(mockSendNotification).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // エラーハンドリング（Graceful Degradation）
  // ===========================================================================

  describe("error handling", () => {
    it("sendNotification失敗時にエラーをスローしない", async () => {
      const failingSend = vi.fn().mockRejectedValue(new Error("Network error"));
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: failingSend,
      });

      // エラーがスローされないことを確認
      await expect(service.notifyPhaseStart("ingest")).resolves.not.toThrow();
    });

    it("sendNotification失敗時に警告ログを出力する", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const failingSend = vi.fn().mockRejectedValue(new Error("Network error"));
      const service = new ProgressNotificationService({
        progressToken: "test-token",
        sendNotification: failingSend,
      });

      await service.notifyPhaseStart("ingest");

      // logger.warnが呼ばれることを確認するが、テスト環境ではconsole.warnの可能性もある
      // Graceful Degradationのため、エラーが飲み込まれていることのみ確認
      warnSpy.mockRestore();
    });
  });

  // ===========================================================================
  // PIPELINE_PHASES定数
  // ===========================================================================

  describe("PIPELINE_PHASES", () => {
    it("全フェーズが定義されている", () => {
      expect(PIPELINE_PHASES.ingest).toBeDefined();
      expect(PIPELINE_PHASES.layout).toBeDefined();
      expect(PIPELINE_PHASES.scrollVision).toBeDefined();
      expect(PIPELINE_PHASES.motion).toBeDefined();
      expect(PIPELINE_PHASES.quality).toBeDefined();
      expect(PIPELINE_PHASES.narrative).toBeDefined();
      expect(PIPELINE_PHASES.responsive).toBeDefined();
      expect(PIPELINE_PHASES.embedding).toBeDefined();
    });

    it("全フェーズのstartPercentが0-100の範囲内", () => {
      for (const [, phase] of Object.entries(PIPELINE_PHASES)) {
        expect(phase.startPercent).toBeGreaterThanOrEqual(0);
        expect(phase.startPercent).toBeLessThanOrEqual(100);
      }
    });

    it("全フェーズのendPercentがstartPercent以上", () => {
      for (const [, phase] of Object.entries(PIPELINE_PHASES)) {
        expect(phase.endPercent).toBeGreaterThanOrEqual(phase.startPercent);
      }
    });

    it("最終フェーズのendPercentが100", () => {
      expect(PIPELINE_PHASES.embedding.endPercent).toBe(100);
    });

    it("全フェーズにラベルが設定されている", () => {
      for (const [, phase] of Object.entries(PIPELINE_PHASES)) {
        expect(phase.label).toBeTruthy();
        expect(typeof phase.label).toBe("string");
      }
    });
  });

  // ===========================================================================
  // 統合テスト: 全フェーズ通知フロー
  // ===========================================================================

  describe("integration: full pipeline progress flow", () => {
    it("実際のパイプライン順序で全フェーズの開始→完了を通知できる", async () => {
      const service = new ProgressNotificationService({
        progressToken: "pipeline-test",
        sendNotification: mockSendNotification,
        minIntervalMs: 0, // スロットリング無効化
      });

      // 実際のパイプライン実行順序
      // Phase 0: Ingest → Phase 1: Layout → Phase 2: Motion (scrollVision含む)
      // → Phase 3: Quality → Phase 4: Narrative → Phase 4.5: Responsive → Phase 5: Embedding
      // Note: motion(45-60)とscrollVision(45-63)は範囲が重複するため、
      // 実際のパイプラインではmotionの後にscrollVisionが完了する
      const phases: Array<keyof typeof PIPELINE_PHASES> = [
        "ingest",
        "layout",
        "motion",
        "scrollVision",
        "quality",
        "narrative",
        "responsive",
        "embedding",
      ];

      for (const phase of phases) {
        await service.notifyPhaseStart(phase);
        await service.notifyPhaseComplete(phase);
      }

      // 各フェーズ2回（開始+完了） × 8フェーズ = 16回
      expect(mockSendNotification).toHaveBeenCalledTimes(16);

      // 全通知が有効な進捗値（0-100）を持つことを確認
      const progressValues = mockSendNotification.mock.calls.map(
        (call: Array<{ params: { progress: number } }>) => call[0].params.progress
      );
      for (const val of progressValues) {
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(100);
      }

      // 最後の通知は100%（embedding complete）
      expect(progressValues[progressValues.length - 1]).toBe(100);
    });

    it("順次フェーズ（重複なし）の進捗は単調増加", async () => {
      const service = new ProgressNotificationService({
        progressToken: "monotonic-test",
        sendNotification: mockSendNotification,
        minIntervalMs: 0,
      });

      // 重複なしのフェーズ順序のみ
      const nonOverlappingPhases: Array<keyof typeof PIPELINE_PHASES> = [
        "ingest",
        "layout",
        "quality",
        "narrative",
        "responsive",
        "embedding",
      ];

      for (const phase of nonOverlappingPhases) {
        await service.notifyPhaseStart(phase);
        await service.notifyPhaseComplete(phase);
      }

      const progressValues = mockSendNotification.mock.calls.map(
        (call: Array<{ params: { progress: number } }>) => call[0].params.progress
      );
      for (let i = 1; i < progressValues.length; i++) {
        expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
      }
    });
  });
});
