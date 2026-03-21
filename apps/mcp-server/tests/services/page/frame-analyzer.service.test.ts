// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FrameAnalyzerService テスト
 * TDD Red Phase: 動画フレームからモーション検出するサービスのテスト
 *
 * 目的:
 * - 動画ファイルからフレームを抽出
 * - フレーム間の差分検出（ピクセル変化率）
 * - モーションタイムライン生成
 * - CSS animation/transitionの推定パラメータ算出
 *
 * Phase1: 動画キャプチャ - Playwright録画 + フレーム解析
 *
 * @module tests/services/page/frame-analyzer.service
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";

// =====================================================
// 型定義（TDD Red Phase: 期待する型を先に定義）
// =====================================================

/**
 * フレーム抽出オプション
 */
interface ExtractOptions {
  /** フレームレート（fps） デフォルト: 10 */
  fps?: number | undefined;
  /** 開始時間（秒） デフォルト: 0 */
  startTime?: number | undefined;
  /** 終了時間（秒） デフォルト: 動画全長 */
  endTime?: number | undefined;
  /** 出力フォーマット デフォルト: png */
  format?: "png" | "jpeg" | undefined;
  /** 出力サイズ デフォルト: 動画と同じ */
  outputSize?: { width: number; height: number } | undefined;
}

/**
 * 抽出されたフレーム情報
 */
interface ExtractedFrame {
  /** フレームインデックス（0開始） */
  index: number;
  /** タイムスタンプ（ミリ秒） */
  timestampMs: number;
  /** フレーム画像パス */
  imagePath: string;
  /** 画像サイズ（バイト） */
  sizeBytes: number;
}

/**
 * フレーム抽出結果
 */
interface ExtractResult {
  /** 抽出されたフレーム配列 */
  frames: ExtractedFrame[];
  /** 総フレーム数 */
  totalFrames: number;
  /** フレームレート */
  fps: number;
  /** 動画長さ（ミリ秒） */
  durationMs: number;
  /** フレーム出力ディレクトリ */
  outputDir: string;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * フレーム間差分情報
 */
interface FrameDiff {
  /** 比較元フレームインデックス */
  fromIndex: number;
  /** 比較先フレームインデックス */
  toIndex: number;
  /** タイムスタンプ差分（ミリ秒） */
  timestampDiffMs: number;
  /** 変化率（0-1） */
  changeRatio: number;
  /** 変化ピクセル数 */
  changedPixels: number;
  /** 総ピクセル数 */
  totalPixels: number;
  /** 変化が検出されたか（閾値以上） */
  hasMotion: boolean;
}

/**
 * モーションセグメント（アニメーション期間）
 */
interface MotionSegment {
  /** 開始タイムスタンプ（ミリ秒） */
  startMs: number;
  /** 終了タイムスタンプ（ミリ秒） */
  endMs: number;
  /** 継続時間（ミリ秒） */
  durationMs: number;
  /** 平均変化率 */
  avgChangeRatio: number;
  /** 最大変化率 */
  maxChangeRatio: number;
  /** モーションタイプ推定 */
  estimatedType: "fade" | "slide" | "scale" | "rotate" | "complex" | "unknown";
  /** 推定イージング */
  estimatedEasing: "linear" | "ease-in" | "ease-out" | "ease-in-out" | "unknown";
}

/**
 * モーション解析結果
 */
interface AnalyzeResult {
  /** フレーム間差分配列 */
  diffs: FrameDiff[];
  /** 検出されたモーションセグメント */
  motionSegments: MotionSegment[];
  /** 総フレーム数 */
  totalFrames: number;
  /** 動画長さ（ミリ秒） */
  durationMs: number;
  /** モーション検出された割合（0-1） */
  motionCoverage: number;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * フレーム解析オプション
 */
interface AnalyzeOptions {
  /** 変化検出閾値（0-1） デフォルト: 0.01 (1%) */
  changeThreshold?: number | undefined;
  /** 最小モーション継続時間（ミリ秒） デフォルト: 100 */
  minMotionDurationMs?: number | undefined;
  /** モーションセグメント間のギャップ許容（ミリ秒） デフォルト: 50 */
  gapToleranceMs?: number | undefined;
}

/**
 * デフォルトの抽出オプション
 */
const DEFAULT_EXTRACT_OPTIONS: Required<ExtractOptions> = {
  fps: 10,
  startTime: 0,
  endTime: Infinity, // 動画全長
  format: "png",
  outputSize: { width: 0, height: 0 }, // 0 = 動画と同じ
};

/**
 * デフォルトの解析オプション
 */
const DEFAULT_ANALYZE_OPTIONS: Required<AnalyzeOptions> = {
  changeThreshold: 0.01, // 1%
  minMotionDurationMs: 100,
  gapToleranceMs: 50,
};

// =====================================================
// Unit Tests - ネットワークアクセス不要
// =====================================================

describe("FrameAnalyzerService - Unit Tests", () => {
  describe("Module Exports", () => {
    it("FrameAnalyzerService クラスがエクスポートされていること", async () => {
      const { FrameAnalyzerService } =
        await import("../../../src/services/page/frame-analyzer.service");
      expect(FrameAnalyzerService).toBeDefined();
      expect(typeof FrameAnalyzerService).toBe("function");
    });

    it("extractFrames 関数がエクスポートされていること", async () => {
      const { extractFrames } = await import("../../../src/services/page/frame-analyzer.service");
      expect(extractFrames).toBeDefined();
      expect(typeof extractFrames).toBe("function");
    });

    it("analyzeMotion 関数がエクスポートされていること", async () => {
      const { analyzeMotion } = await import("../../../src/services/page/frame-analyzer.service");
      expect(analyzeMotion).toBeDefined();
      expect(typeof analyzeMotion).toBe("function");
    });

    it("DEFAULT_EXTRACT_OPTIONS がエクスポートされていること", async () => {
      const { DEFAULT_EXTRACT_OPTIONS } =
        await import("../../../src/services/page/frame-analyzer.service");
      expect(DEFAULT_EXTRACT_OPTIONS).toBeDefined();
    });

    it("DEFAULT_ANALYZE_OPTIONS がエクスポートされていること", async () => {
      const { DEFAULT_ANALYZE_OPTIONS } =
        await import("../../../src/services/page/frame-analyzer.service");
      expect(DEFAULT_ANALYZE_OPTIONS).toBeDefined();
    });

    it("FrameAnalyzerError エラークラスがエクスポートされていること", async () => {
      const { FrameAnalyzerError } =
        await import("../../../src/services/page/frame-analyzer.service");
      expect(FrameAnalyzerError).toBeDefined();
    });
  });

  describe("DEFAULT_EXTRACT_OPTIONS", () => {
    it("デフォルトfpsが10であること", () => {
      expect(DEFAULT_EXTRACT_OPTIONS.fps).toBe(10);
    });

    it("デフォルトstartTimeが0であること", () => {
      expect(DEFAULT_EXTRACT_OPTIONS.startTime).toBe(0);
    });

    it("デフォルトendTimeがInfinityであること", () => {
      expect(DEFAULT_EXTRACT_OPTIONS.endTime).toBe(Infinity);
    });

    it("デフォルトformatがpngであること", () => {
      expect(DEFAULT_EXTRACT_OPTIONS.format).toBe("png");
    });
  });

  describe("DEFAULT_ANALYZE_OPTIONS", () => {
    it("デフォルトchangeThresholdが0.01であること", () => {
      expect(DEFAULT_ANALYZE_OPTIONS.changeThreshold).toBe(0.01);
    });

    it("デフォルトminMotionDurationMsが100であること", () => {
      expect(DEFAULT_ANALYZE_OPTIONS.minMotionDurationMs).toBe(100);
    });

    it("デフォルトgapToleranceMsが50であること", () => {
      expect(DEFAULT_ANALYZE_OPTIONS.gapToleranceMs).toBe(50);
    });
  });

  describe("FrameAnalyzerService Class", () => {
    it("インスタンスを作成できること", async () => {
      const { FrameAnalyzerService } =
        await import("../../../src/services/page/frame-analyzer.service");
      const service = new FrameAnalyzerService();
      expect(service).toBeInstanceOf(FrameAnalyzerService);
    });

    it("extractFramesメソッドが存在すること", async () => {
      const { FrameAnalyzerService } =
        await import("../../../src/services/page/frame-analyzer.service");
      const service = new FrameAnalyzerService();
      expect(typeof service.extractFrames).toBe("function");
    });

    it("analyzeMotionメソッドが存在すること", async () => {
      const { FrameAnalyzerService } =
        await import("../../../src/services/page/frame-analyzer.service");
      const service = new FrameAnalyzerService();
      expect(typeof service.analyzeMotion).toBe("function");
    });

    it("cleanupメソッドが存在すること", async () => {
      const { FrameAnalyzerService } =
        await import("../../../src/services/page/frame-analyzer.service");
      const service = new FrameAnalyzerService();
      expect(typeof service.cleanup).toBe("function");
    });
  });

  describe("FrameAnalyzerError Class", () => {
    it("FrameAnalyzerError が正しい名前を持つこと", async () => {
      const { FrameAnalyzerError } =
        await import("../../../src/services/page/frame-analyzer.service");
      const error = new FrameAnalyzerError("test error message");
      expect(error.name).toBe("FrameAnalyzerError");
      expect(error.message).toBe("test error message");
    });

    it("FrameAnalyzerError が Error を継承すること", async () => {
      const { FrameAnalyzerError } =
        await import("../../../src/services/page/frame-analyzer.service");
      const error = new FrameAnalyzerError("test");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("Input Validation", () => {
    it("存在しない動画ファイルでエラーをスローすること", async () => {
      const { extractFrames, FrameAnalyzerError } =
        await import("../../../src/services/page/frame-analyzer.service");
      await expect(extractFrames("/nonexistent/video.webm")).rejects.toThrow(FrameAnalyzerError);
    });

    it("負のfpsでエラーをスローすること", async () => {
      const { extractFrames, FrameAnalyzerError } =
        await import("../../../src/services/page/frame-analyzer.service");
      await expect(extractFrames("/some/video.webm", { fps: -1 })).rejects.toThrow(
        FrameAnalyzerError
      );
    });

    it("0のfpsでエラーをスローすること", async () => {
      const { extractFrames, FrameAnalyzerError } =
        await import("../../../src/services/page/frame-analyzer.service");
      await expect(extractFrames("/some/video.webm", { fps: 0 })).rejects.toThrow(
        FrameAnalyzerError
      );
    });

    it("負のstartTimeでエラーをスローすること", async () => {
      const { extractFrames, FrameAnalyzerError } =
        await import("../../../src/services/page/frame-analyzer.service");
      await expect(extractFrames("/some/video.webm", { startTime: -1 })).rejects.toThrow(
        FrameAnalyzerError
      );
    });
  });
});
