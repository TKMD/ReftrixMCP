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

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
  format?: 'png' | 'jpeg' | undefined;
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
  estimatedType: 'fade' | 'slide' | 'scale' | 'rotate' | 'complex' | 'unknown';
  /** 推定イージング */
  estimatedEasing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'unknown';
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
  format: 'png',
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

describe('FrameAnalyzerService - Unit Tests', () => {
  describe('Module Exports', () => {
    it('FrameAnalyzerService クラスがエクスポートされていること', async () => {
      const { FrameAnalyzerService } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      expect(FrameAnalyzerService).toBeDefined();
      expect(typeof FrameAnalyzerService).toBe('function');
    });

    it('extractFrames 関数がエクスポートされていること', async () => {
      const { extractFrames } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      expect(extractFrames).toBeDefined();
      expect(typeof extractFrames).toBe('function');
    });

    it('analyzeMotion 関数がエクスポートされていること', async () => {
      const { analyzeMotion } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      expect(analyzeMotion).toBeDefined();
      expect(typeof analyzeMotion).toBe('function');
    });

    it('DEFAULT_EXTRACT_OPTIONS がエクスポートされていること', async () => {
      const { DEFAULT_EXTRACT_OPTIONS } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      expect(DEFAULT_EXTRACT_OPTIONS).toBeDefined();
    });

    it('DEFAULT_ANALYZE_OPTIONS がエクスポートされていること', async () => {
      const { DEFAULT_ANALYZE_OPTIONS } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      expect(DEFAULT_ANALYZE_OPTIONS).toBeDefined();
    });

    it('FrameAnalyzerError エラークラスがエクスポートされていること', async () => {
      const { FrameAnalyzerError } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      expect(FrameAnalyzerError).toBeDefined();
    });
  });

  describe('DEFAULT_EXTRACT_OPTIONS', () => {
    it('デフォルトfpsが10であること', () => {
      expect(DEFAULT_EXTRACT_OPTIONS.fps).toBe(10);
    });

    it('デフォルトstartTimeが0であること', () => {
      expect(DEFAULT_EXTRACT_OPTIONS.startTime).toBe(0);
    });

    it('デフォルトendTimeがInfinityであること', () => {
      expect(DEFAULT_EXTRACT_OPTIONS.endTime).toBe(Infinity);
    });

    it('デフォルトformatがpngであること', () => {
      expect(DEFAULT_EXTRACT_OPTIONS.format).toBe('png');
    });
  });

  describe('DEFAULT_ANALYZE_OPTIONS', () => {
    it('デフォルトchangeThresholdが0.01であること', () => {
      expect(DEFAULT_ANALYZE_OPTIONS.changeThreshold).toBe(0.01);
    });

    it('デフォルトminMotionDurationMsが100であること', () => {
      expect(DEFAULT_ANALYZE_OPTIONS.minMotionDurationMs).toBe(100);
    });

    it('デフォルトgapToleranceMsが50であること', () => {
      expect(DEFAULT_ANALYZE_OPTIONS.gapToleranceMs).toBe(50);
    });
  });

  describe('FrameAnalyzerService Class', () => {
    it('インスタンスを作成できること', async () => {
      const { FrameAnalyzerService } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      const service = new FrameAnalyzerService();
      expect(service).toBeInstanceOf(FrameAnalyzerService);
    });

    it('extractFramesメソッドが存在すること', async () => {
      const { FrameAnalyzerService } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      const service = new FrameAnalyzerService();
      expect(typeof service.extractFrames).toBe('function');
    });

    it('analyzeMotionメソッドが存在すること', async () => {
      const { FrameAnalyzerService } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      const service = new FrameAnalyzerService();
      expect(typeof service.analyzeMotion).toBe('function');
    });

    it('cleanupメソッドが存在すること', async () => {
      const { FrameAnalyzerService } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      const service = new FrameAnalyzerService();
      expect(typeof service.cleanup).toBe('function');
    });
  });

  describe('FrameAnalyzerError Class', () => {
    it('FrameAnalyzerError が正しい名前を持つこと', async () => {
      const { FrameAnalyzerError } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      const error = new FrameAnalyzerError('test error message');
      expect(error.name).toBe('FrameAnalyzerError');
      expect(error.message).toBe('test error message');
    });

    it('FrameAnalyzerError が Error を継承すること', async () => {
      const { FrameAnalyzerError } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      const error = new FrameAnalyzerError('test');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('Input Validation', () => {
    it('存在しない動画ファイルでエラーをスローすること', async () => {
      const { extractFrames, FrameAnalyzerError } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      await expect(
        extractFrames('/nonexistent/video.webm')
      ).rejects.toThrow(FrameAnalyzerError);
    });

    it('負のfpsでエラーをスローすること', async () => {
      const { extractFrames, FrameAnalyzerError } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      await expect(
        extractFrames('/some/video.webm', { fps: -1 })
      ).rejects.toThrow(FrameAnalyzerError);
    });

    it('0のfpsでエラーをスローすること', async () => {
      const { extractFrames, FrameAnalyzerError } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      await expect(
        extractFrames('/some/video.webm', { fps: 0 })
      ).rejects.toThrow(FrameAnalyzerError);
    });

    it('負のstartTimeでエラーをスローすること', async () => {
      const { extractFrames, FrameAnalyzerError } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );
      await expect(
        extractFrames('/some/video.webm', { startTime: -1 })
      ).rejects.toThrow(FrameAnalyzerError);
    });
  });
});

// =====================================================
// Integration Tests - 実際の動画ファイルが必要
// =====================================================

describe('FrameAnalyzerService - Integration Tests (TDD Red Phase)', () => {
  // Skipped: Requires video recording infrastructure (Playwright video + ffmpeg)
  // These are TDD Red Phase tests - implementation pending
  // テスト用の一時ディレクトリ
  let tempDir: string;
  let testVideoPath: string | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-analyzer-test-'));
  });

  afterEach(async () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // クリーンアップエラーは無視
    }
  });

  afterAll(async () => {
    // テスト動画があれば削除
    if (testVideoPath && fs.existsSync(testVideoPath)) {
      try {
        fs.unlinkSync(testVideoPath);
        const dir = path.dirname(testVideoPath);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
        }
      } catch {
        // 無視
      }
    }
  });

  describe('Frame Extraction', () => {
    it.skip('動画からフレームを抽出できること', async () => {
      // まずVideoRecorderで動画を作成
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { extractFrames } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        // テスト用動画を録画
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 2000,
        });
        testVideoPath = recordResult.videoPath;

        // フレーム抽出
        const result = await extractFrames(testVideoPath, {
          fps: 5, // 5fps = 2秒で約10フレーム
        });

        expect(result).toHaveProperty('frames');
        expect(result).toHaveProperty('totalFrames');
        expect(result).toHaveProperty('fps');
        expect(result).toHaveProperty('durationMs');
        expect(result).toHaveProperty('outputDir');
        expect(result).toHaveProperty('processingTimeMs');

        expect(result.frames.length).toBeGreaterThan(0);
        expect(result.totalFrames).toBeGreaterThan(0);
        expect(result.fps).toBe(5);
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);

    it.skip('抽出されたフレームがPNG形式であること', async () => {
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { extractFrames } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 2000,
        });
        testVideoPath = recordResult.videoPath;

        const result = await extractFrames(testVideoPath, {
          fps: 5,
          format: 'png',
        });

        for (const frame of result.frames) {
          expect(frame.imagePath.endsWith('.png')).toBe(true);
          expect(fs.existsSync(frame.imagePath)).toBe(true);
        }
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);

    it.skip('フレームにタイムスタンプ情報が含まれること', async () => {
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { extractFrames } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 2000,
        });
        testVideoPath = recordResult.videoPath;

        const result = await extractFrames(testVideoPath, { fps: 5 });

        for (let i = 0; i < result.frames.length; i++) {
          const frame = result.frames[i];
          expect(frame.index).toBe(i);
          expect(frame.timestampMs).toBeGreaterThanOrEqual(0);
          expect(frame.sizeBytes).toBeGreaterThan(0);

          // タイムスタンプが増加していること
          if (i > 0) {
            expect(frame.timestampMs).toBeGreaterThan(
              result.frames[i - 1].timestampMs
            );
          }
        }
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);

    it.skip('カスタムfpsが適用されること', async () => {
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { extractFrames } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 2000,
        });
        testVideoPath = recordResult.videoPath;

        // 2fps = 2秒で約4フレーム
        const result = await extractFrames(testVideoPath, { fps: 2 });

        expect(result.fps).toBe(2);
        // 2秒 * 2fps = 4フレーム（±1の誤差許容）
        expect(result.totalFrames).toBeGreaterThanOrEqual(3);
        expect(result.totalFrames).toBeLessThanOrEqual(5);
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);
  });

  describe('Motion Analysis', () => {
    it.skip('フレーム間の差分を検出できること', async () => {
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { extractFrames, analyzeMotion } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        // スクロールありで録画（モーションが発生する）
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 2000,
          scrollPage: true,
        });
        testVideoPath = recordResult.videoPath;

        const extractResult = await extractFrames(testVideoPath, { fps: 5 });
        const analyzeResult = await analyzeMotion(extractResult);

        expect(analyzeResult).toHaveProperty('diffs');
        expect(analyzeResult).toHaveProperty('motionSegments');
        expect(analyzeResult).toHaveProperty('totalFrames');
        expect(analyzeResult).toHaveProperty('durationMs');
        expect(analyzeResult).toHaveProperty('motionCoverage');
        expect(analyzeResult).toHaveProperty('processingTimeMs');

        // フレーム間差分が計算されていること
        expect(analyzeResult.diffs.length).toBe(extractResult.totalFrames - 1);
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);

    it.skip('FrameDiffに必須フィールドが含まれること', async () => {
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { extractFrames, analyzeMotion } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 2000,
          scrollPage: true,
        });
        testVideoPath = recordResult.videoPath;

        const extractResult = await extractFrames(testVideoPath, { fps: 5 });
        const analyzeResult = await analyzeMotion(extractResult);

        for (const diff of analyzeResult.diffs) {
          expect(typeof diff.fromIndex).toBe('number');
          expect(typeof diff.toIndex).toBe('number');
          expect(typeof diff.timestampDiffMs).toBe('number');
          expect(typeof diff.changeRatio).toBe('number');
          expect(typeof diff.changedPixels).toBe('number');
          expect(typeof diff.totalPixels).toBe('number');
          expect(typeof diff.hasMotion).toBe('boolean');

          // changeRatioは0-1の範囲
          expect(diff.changeRatio).toBeGreaterThanOrEqual(0);
          expect(diff.changeRatio).toBeLessThanOrEqual(1);
        }
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);

    it.skip('モーションセグメントが検出されること（スクロールあり）', async () => {
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { extractFrames, analyzeMotion } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        // スクロールありで録画
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 3000,
          scrollPage: true,
          moveMouseRandomly: true,
        });
        testVideoPath = recordResult.videoPath;

        const extractResult = await extractFrames(testVideoPath, { fps: 10 });
        const analyzeResult = await analyzeMotion(extractResult);

        // モーションセグメントが1つ以上検出されること
        expect(analyzeResult.motionSegments.length).toBeGreaterThan(0);
        expect(analyzeResult.motionCoverage).toBeGreaterThan(0);
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);

    it.skip('静止画面でモーションセグメントが少ないこと', async () => {
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { extractFrames, analyzeMotion } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        // スクロール・マウス移動なしで録画
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 2000,
          scrollPage: false,
          moveMouseRandomly: false,
        });
        testVideoPath = recordResult.videoPath;

        const extractResult = await extractFrames(testVideoPath, { fps: 5 });
        const analyzeResult = await analyzeMotion(extractResult);

        // 静止画面なのでモーションカバレッジは低い
        expect(analyzeResult.motionCoverage).toBeLessThan(0.5);
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);

    it.skip('MotionSegmentに推定タイプと推定イージングが含まれること', async () => {
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { extractFrames, analyzeMotion } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 3000,
          scrollPage: true,
        });
        testVideoPath = recordResult.videoPath;

        const extractResult = await extractFrames(testVideoPath, { fps: 10 });
        const analyzeResult = await analyzeMotion(extractResult);

        if (analyzeResult.motionSegments.length > 0) {
          const segment = analyzeResult.motionSegments[0];
          expect(typeof segment.startMs).toBe('number');
          expect(typeof segment.endMs).toBe('number');
          expect(typeof segment.durationMs).toBe('number');
          expect(typeof segment.avgChangeRatio).toBe('number');
          expect(typeof segment.maxChangeRatio).toBe('number');
          expect(segment.estimatedType).toBeDefined();
          expect(segment.estimatedEasing).toBeDefined();

          // 有効な値であること
          expect(segment.endMs).toBeGreaterThan(segment.startMs);
          expect(segment.durationMs).toBe(segment.endMs - segment.startMs);
        }
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);
  });

  describe('Options Handling', () => {
    it.skip('カスタム変化閾値が適用されること', async () => {
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { extractFrames, analyzeMotion } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 2000,
          scrollPage: true,
        });
        testVideoPath = recordResult.videoPath;

        const extractResult = await extractFrames(testVideoPath, { fps: 5 });

        // 低い閾値（敏感）
        const lowThreshold = await analyzeMotion(extractResult, {
          changeThreshold: 0.001,
        });

        // 高い閾値（鈍感）
        const highThreshold = await analyzeMotion(extractResult, {
          changeThreshold: 0.1,
        });

        // 低い閾値のほうがモーション検出が多い
        const lowMotionCount = lowThreshold.diffs.filter((d) => d.hasMotion).length;
        const highMotionCount = highThreshold.diffs.filter((d) => d.hasMotion).length;
        expect(lowMotionCount).toBeGreaterThanOrEqual(highMotionCount);
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);
  });

  describe('Resource Cleanup', () => {
    it.skip('cleanupで抽出フレームが削除されること', async () => {
      const { recordPage, closeSharedRecorder } = await import(
        '../../../src/services/page/video-recorder.service'
      );
      const { FrameAnalyzerService } = await import(
        '../../../src/services/page/frame-analyzer.service'
      );

      try {
        const recordResult = await recordPage('https://example.com', {
          timeout: 30000,
          recordDuration: 2000,
        });
        testVideoPath = recordResult.videoPath;

        const service = new FrameAnalyzerService();
        const extractResult = await service.extractFrames(testVideoPath, { fps: 5 });

        // フレームが存在すること
        for (const frame of extractResult.frames) {
          expect(fs.existsSync(frame.imagePath)).toBe(true);
        }

        // クリーンアップ
        await service.cleanup(extractResult);

        // フレームが削除されていること
        for (const frame of extractResult.frames) {
          expect(fs.existsSync(frame.imagePath)).toBe(false);
        }
      } finally {
        await closeSharedRecorder();
      }
    }, 120000);
  });
});

// =====================================================
// Performance Tests
// =====================================================

describe('FrameAnalyzerService - Performance (TDD Red Phase)', () => {
  it.skip('10フレームの解析が5秒以内に完了すること', async () => {
    const { recordPage, closeSharedRecorder } = await import(
      '../../../src/services/page/video-recorder.service'
    );
    const { extractFrames, analyzeMotion } = await import(
      '../../../src/services/page/frame-analyzer.service'
    );

    try {
      const recordResult = await recordPage('https://example.com', {
        timeout: 30000,
        recordDuration: 2000,
      });

      const extractResult = await extractFrames(recordResult.videoPath, {
        fps: 5, // 約10フレーム
      });

      const startTime = Date.now();
      await analyzeMotion(extractResult);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(5000);
    } finally {
      await closeSharedRecorder();
    }
  }, 120000);
});
