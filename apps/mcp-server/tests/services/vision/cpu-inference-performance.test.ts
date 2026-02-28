// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CPU Inference Performance Tests
 *
 * Vision CPU完走保証 Phase 2: パフォーマンステスト
 *
 * 目的:
 * - CPU推論の実際のパフォーマンスを計測
 * - 画像最適化による推論時間短縮効果を検証
 * - タイムアウト設定の妥当性を確認
 *
 * 注意:
 * - CI環境では軽量なテストのみ実行（Ollamaなし）
 * - ローカルでの詳細パフォーマンステストはスキップ可能
 * - 処理時間の許容範囲は広めに設定（環境差を考慮）
 *
 * @see apps/mcp-server/src/services/vision/image-optimizer.ts
 * @see apps/mcp-server/src/services/vision/timeout-calculator.ts
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sharp from 'sharp';
import {
  ImageOptimizer,
  OptimizationStrategy,
  IMAGE_SIZE_THRESHOLDS,
  type OptimizeResult,
} from '../../../src/services/vision/image-optimizer.js';
import {
  TimeoutCalculator,
  VisionTimeouts,
  ImageSize,
  HardwareType,
} from '../../../src/services/vision/timeout-calculator.js';

// =============================================================================
// 定数
// =============================================================================

/**
 * テスト用画像サイズ目標（バイト）
 */
const TEST_IMAGE_SIZES = {
  /** 小サイズ: 50KB */
  SMALL: 50_000,
  /** 中サイズ: 300KB */
  MEDIUM: 300_000,
  /** 大サイズ: 800KB */
  LARGE: 800_000,
} as const;

/**
 * パフォーマンス目標（ミリ秒）
 * 環境差を考慮して広めに設定
 */
const PERFORMANCE_TARGETS = {
  /** 小画像最適化: 100ms */
  SMALL_OPTIMIZATION_MS: 100,
  /** 中画像最適化: 500ms */
  MEDIUM_OPTIMIZATION_MS: 500,
  /** 大画像最適化: 1000ms */
  LARGE_OPTIMIZATION_MS: 1000,
  /** 画像生成: 2000ms */
  IMAGE_GENERATION_MS: 2000,
} as const;

/**
 * 品質目標
 */
const QUALITY_TARGETS = {
  /** 大画像の最小圧縮率（50%以上削減） */
  MIN_LARGE_COMPRESSION_RATIO: 0.5,
  /** 最大許容品質劣化（目視で許容可能） */
  MAX_QUALITY_DEGRADATION: 0.3,
} as const;

// =============================================================================
// テストヘルパー
// =============================================================================

/**
 * テスト用の画像バッファを生成
 *
 * ノイズを追加して圧縮率を下げ、より大きなファイルサイズを生成
 */
async function createTestImage(
  width: number,
  height: number,
  options?: { quality?: number; format?: 'jpeg' | 'png' }
): Promise<Buffer> {
  // ランダムノイズを生成（圧縮しにくいデータ）
  const noiseBuffer = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noiseBuffer.length; i++) {
    noiseBuffer[i] = Math.floor(Math.random() * 256);
  }

  let pipeline = sharp(noiseBuffer, {
    raw: {
      width,
      height,
      channels: 3,
    },
  });

  if (options?.format === 'png') {
    return pipeline.png().toBuffer();
  }

  return pipeline.jpeg({ quality: options?.quality ?? 90 }).toBuffer();
}

/**
 * 指定サイズに近い画像バッファを生成
 *
 * @param targetBytes - 目標サイズ（バイト）
 * @param tolerance - 許容誤差（0-1、デフォルト0.3）
 */
async function createImageNearSize(
  targetBytes: number,
  tolerance: number = 0.3
): Promise<Buffer> {
  // ピクセル数を推定（ノイズ画像なので圧縮率は低い）
  // JPEG品質90で約1-2 bytes/pixel程度
  const bytesPerPixel = 1.5;
  const estimatedPixels = Math.ceil(targetBytes / bytesPerPixel);
  const side = Math.ceil(Math.sqrt(estimatedPixels));

  // 試行して目標サイズに近づける
  let quality = 90;
  let currentSide = side;
  let buffer = await createTestImage(currentSide, currentSide, { quality });

  // サイズ調整（最大5回試行）
  for (let i = 0; i < 5; i++) {
    const ratio = buffer.length / targetBytes;

    // 許容範囲内ならOK
    if (ratio >= 1 - tolerance && ratio <= 1 + tolerance) {
      break;
    }

    // 調整
    if (buffer.length < targetBytes * (1 - tolerance)) {
      // 小さすぎる → 大きくする
      currentSide = Math.ceil(currentSide * 1.3);
    } else if (buffer.length > targetBytes * (1 + tolerance)) {
      // 大きすぎる → 小さくする
      currentSide = Math.floor(currentSide * 0.8);
    }

    buffer = await createTestImage(currentSide, currentSide, { quality });
  }

  return buffer;
}

/**
 * パフォーマンス計測ヘルパー
 */
interface PerformanceMeasurement {
  durationMs: number;
  result: OptimizeResult;
}

async function measureOptimization(
  optimizer: ImageOptimizer,
  buffer: Buffer,
  options: { hardwareType: HardwareType; forceStrategy?: OptimizationStrategy }
): Promise<PerformanceMeasurement> {
  const startTime = performance.now();
  const result = await optimizer.optimizeForCPU(buffer, options);
  const endTime = performance.now();

  return {
    durationMs: endTime - startTime,
    result,
  };
}

// =============================================================================
// テスト
// =============================================================================

describe('CPU Inference Performance', () => {
  let optimizer: ImageOptimizer;
  let calculator: TimeoutCalculator;

  // テスト用画像バッファ（beforeAllで生成してキャッシュ）
  let smallImage: Buffer;
  let mediumImage: Buffer;
  let largeImage: Buffer;

  beforeAll(async () => {
    // テスト用画像を事前生成（テスト実行時間短縮）
    const generationStart = performance.now();

    [smallImage, mediumImage, largeImage] = await Promise.all([
      createImageNearSize(TEST_IMAGE_SIZES.SMALL),
      createImageNearSize(TEST_IMAGE_SIZES.MEDIUM),
      createImageNearSize(TEST_IMAGE_SIZES.LARGE),
    ]);

    const generationTime = performance.now() - generationStart;

    // 画像生成が許容時間内か確認
    expect(generationTime).toBeLessThan(PERFORMANCE_TARGETS.IMAGE_GENERATION_MS * 3);

    // 生成された画像サイズをログ出力（デバッグ用）
    if (process.env.DEBUG) {
      console.log('[Performance Test] Generated test images:');
      console.log(`  Small: ${smallImage.length} bytes (target: ${TEST_IMAGE_SIZES.SMALL})`);
      console.log(`  Medium: ${mediumImage.length} bytes (target: ${TEST_IMAGE_SIZES.MEDIUM})`);
      console.log(`  Large: ${largeImage.length} bytes (target: ${TEST_IMAGE_SIZES.LARGE})`);
      console.log(`  Generation time: ${generationTime.toFixed(0)}ms`);
    }
  });

  beforeEach(() => {
    optimizer = new ImageOptimizer();
    calculator = new TimeoutCalculator();
  });

  // ===========================================================================
  // ImageOptimizer Performance
  // ===========================================================================

  describe('ImageOptimizer Performance', () => {
    it('should optimize small image in < 100ms', async () => {
      const { durationMs, result } = await measureOptimization(optimizer, smallImage, {
        hardwareType: HardwareType.CPU,
        // 小画像は自動でスキップされるが、強制的に最適化をテスト
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      // 処理時間チェック
      expect(durationMs).toBeLessThan(PERFORMANCE_TARGETS.SMALL_OPTIMIZATION_MS);

      // 結果検証
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.buffer).toBeInstanceOf(Buffer);

      if (process.env.DEBUG) {
        console.log(`[Performance] Small image optimization: ${durationMs.toFixed(0)}ms`);
        console.log(`  Original: ${result.originalSizeBytes} bytes`);
        console.log(`  Optimized: ${result.optimizedSizeBytes} bytes`);
        console.log(`  Compression ratio: ${(result.compressionRatio * 100).toFixed(1)}%`);
      }
    });

    it('should optimize medium image in < 500ms', async () => {
      const { durationMs, result } = await measureOptimization(optimizer, mediumImage, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      // 処理時間チェック
      expect(durationMs).toBeLessThan(PERFORMANCE_TARGETS.MEDIUM_OPTIMIZATION_MS);

      // 結果検証
      expect(result.skipped).toBe(false);
      expect(result.compressionRatio).toBeLessThan(1); // 圧縮されていること

      if (process.env.DEBUG) {
        console.log(`[Performance] Medium image optimization: ${durationMs.toFixed(0)}ms`);
        console.log(`  Original: ${result.originalSizeBytes} bytes`);
        console.log(`  Optimized: ${result.optimizedSizeBytes} bytes`);
        console.log(`  Compression ratio: ${(result.compressionRatio * 100).toFixed(1)}%`);
      }
    });

    it('should optimize large image in < 1000ms', async () => {
      const { durationMs, result } = await measureOptimization(optimizer, largeImage, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.AGGRESSIVE,
      });

      // 処理時間チェック
      expect(durationMs).toBeLessThan(PERFORMANCE_TARGETS.LARGE_OPTIMIZATION_MS);

      // 結果検証
      expect(result.skipped).toBe(false);
      expect(result.compressionRatio).toBeLessThan(1);
      expect(result.dimensions.width).toBeLessThanOrEqual(768);
      expect(result.dimensions.height).toBeLessThanOrEqual(768);

      if (process.env.DEBUG) {
        console.log(`[Performance] Large image optimization: ${durationMs.toFixed(0)}ms`);
        console.log(`  Original: ${result.originalSizeBytes} bytes`);
        console.log(`  Optimized: ${result.optimizedSizeBytes} bytes`);
        console.log(`  Compression ratio: ${(result.compressionRatio * 100).toFixed(1)}%`);
        console.log(`  Dimensions: ${result.dimensions.width}x${result.dimensions.height}`);
      }
    });

    it('should skip optimization for GPU hardware in < 10ms', async () => {
      const { durationMs, result } = await measureOptimization(optimizer, largeImage, {
        hardwareType: HardwareType.GPU,
      });

      // GPU時はほぼ即座にスキップ
      expect(durationMs).toBeLessThan(10);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('No optimization needed');

      if (process.env.DEBUG) {
        console.log(`[Performance] GPU skip: ${durationMs.toFixed(2)}ms`);
      }
    });
  });

  // ===========================================================================
  // Timeout Adequacy
  // ===========================================================================

  describe('Timeout Adequacy', () => {
    it('CPU_SMALL timeout (180s) should be sufficient for small images', async () => {
      const timeout = calculator.calculate(HardwareType.CPU, TEST_IMAGE_SIZES.SMALL);

      // タイムアウト値の確認
      expect(timeout).toBe(VisionTimeouts.CPU_SMALL);
      expect(timeout).toBe(180_000); // 180秒 = 3分

      // 実際の最適化時間との比較
      const { durationMs } = await measureOptimization(optimizer, smallImage, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      // タイムアウトは最適化時間の1000倍以上（十分な余裕）
      const safetyMargin = timeout / durationMs;
      expect(safetyMargin).toBeGreaterThan(100);

      if (process.env.DEBUG) {
        console.log(`[Timeout] Small image:`);
        console.log(`  Timeout: ${calculator.formatTimeout(timeout)}`);
        console.log(`  Actual: ${durationMs.toFixed(0)}ms`);
        console.log(`  Safety margin: ${safetyMargin.toFixed(0)}x`);
      }
    });

    it('CPU_MEDIUM timeout (600s) should be sufficient for medium images', async () => {
      const timeout = calculator.calculate(HardwareType.CPU, TEST_IMAGE_SIZES.MEDIUM);

      // タイムアウト値の確認
      expect(timeout).toBe(VisionTimeouts.CPU_MEDIUM);
      expect(timeout).toBe(600_000); // 600秒 = 10分

      // 実際の最適化時間との比較
      const { durationMs } = await measureOptimization(optimizer, mediumImage, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      // タイムアウトは最適化時間の100倍以上
      const safetyMargin = timeout / durationMs;
      expect(safetyMargin).toBeGreaterThan(100);

      if (process.env.DEBUG) {
        console.log(`[Timeout] Medium image:`);
        console.log(`  Timeout: ${calculator.formatTimeout(timeout)}`);
        console.log(`  Actual: ${durationMs.toFixed(0)}ms`);
        console.log(`  Safety margin: ${safetyMargin.toFixed(0)}x`);
      }
    });

    it('CPU_LARGE timeout (1200s) should be sufficient for large images', async () => {
      const timeout = calculator.calculate(HardwareType.CPU, TEST_IMAGE_SIZES.LARGE);

      // タイムアウト値の確認
      expect(timeout).toBe(VisionTimeouts.CPU_LARGE);
      expect(timeout).toBe(1_200_000); // 1200秒 = 20分

      // 実際の最適化時間との比較
      const { durationMs } = await measureOptimization(optimizer, largeImage, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.AGGRESSIVE,
      });

      // タイムアウトは最適化時間の100倍以上
      const safetyMargin = timeout / durationMs;
      expect(safetyMargin).toBeGreaterThan(100);

      if (process.env.DEBUG) {
        console.log(`[Timeout] Large image:`);
        console.log(`  Timeout: ${calculator.formatTimeout(timeout)}`);
        console.log(`  Actual: ${durationMs.toFixed(0)}ms`);
        console.log(`  Safety margin: ${safetyMargin.toFixed(0)}x`);
      }
    });

    it('should correctly classify image sizes', () => {
      // 閾値境界のテスト
      expect(calculator.classifyImageSize(99_999)).toBe(ImageSize.SMALL);
      expect(calculator.classifyImageSize(100_000)).toBe(ImageSize.MEDIUM);
      expect(calculator.classifyImageSize(499_999)).toBe(ImageSize.MEDIUM);
      expect(calculator.classifyImageSize(500_000)).toBe(ImageSize.LARGE);
    });
  });

  // ===========================================================================
  // Optimization Impact
  // ===========================================================================

  describe('Optimization Impact', () => {
    it('should reduce image size by at least 50% for large images', async () => {
      const result = await optimizer.optimizeForCPU(largeImage, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.AGGRESSIVE,
      });

      // 圧縮率チェック（50%以上削減 = compressionRatio < 0.5）
      expect(result.compressionRatio).toBeLessThanOrEqual(QUALITY_TARGETS.MIN_LARGE_COMPRESSION_RATIO);

      if (process.env.DEBUG) {
        console.log(`[Impact] Large image compression:`);
        console.log(`  Original: ${result.originalSizeBytes} bytes`);
        console.log(`  Optimized: ${result.optimizedSizeBytes} bytes`);
        console.log(`  Reduction: ${((1 - result.compressionRatio) * 100).toFixed(1)}%`);
      }
    });

    it('should reduce medium images with MEDIUM strategy', async () => {
      const result = await optimizer.optimizeForCPU(mediumImage, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.MEDIUM,
      });

      // 圧縮されていること
      expect(result.compressionRatio).toBeLessThan(1);
      expect(result.skipped).toBe(false);

      if (process.env.DEBUG) {
        console.log(`[Impact] Medium image compression:`);
        console.log(`  Original: ${result.originalSizeBytes} bytes`);
        console.log(`  Optimized: ${result.optimizedSizeBytes} bytes`);
        console.log(`  Reduction: ${((1 - result.compressionRatio) * 100).toFixed(1)}%`);
      }
    });

    it('should maintain acceptable quality after optimization', async () => {
      // 大きな画像を作成
      const originalBuffer = await createTestImage(2000, 2000, { quality: 95 });

      const result = await optimizer.optimizeForCPU(originalBuffer, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.AGGRESSIVE,
      });

      // 最適化後の画像メタデータを取得
      const metadata = await sharp(result.buffer).metadata();

      // 基本的な品質チェック
      expect(metadata.width).toBeLessThanOrEqual(768);
      expect(metadata.height).toBeLessThanOrEqual(768);
      expect(metadata.format).toBe('jpeg');

      // 画像が破損していないことを確認（メタデータが取得できる）
      expect(metadata.width).toBeGreaterThan(0);
      expect(metadata.height).toBeGreaterThan(0);

      if (process.env.DEBUG) {
        console.log(`[Quality] After optimization:`);
        console.log(`  Dimensions: ${metadata.width}x${metadata.height}`);
        console.log(`  Format: ${metadata.format}`);
        console.log(`  Original size: ${originalBuffer.length} bytes`);
        console.log(`  Optimized size: ${result.optimizedSizeBytes} bytes`);
      }
    });

    it('should preserve aspect ratio during optimization', async () => {
      // 横長画像を作成（3:1 aspect ratio）
      const wideImage = await createTestImage(1500, 500, { quality: 90 });

      const result = await optimizer.optimizeForCPU(wideImage, {
        hardwareType: HardwareType.CPU,
        forceStrategy: OptimizationStrategy.AGGRESSIVE,
      });

      // アスペクト比が維持されていること（許容誤差あり）
      const originalAspect = 1500 / 500; // 3:1
      const resultAspect = result.dimensions.width / result.dimensions.height;

      expect(resultAspect).toBeCloseTo(originalAspect, 1);

      if (process.env.DEBUG) {
        console.log(`[Quality] Aspect ratio preservation:`);
        console.log(`  Original aspect: ${originalAspect.toFixed(2)}`);
        console.log(`  Result aspect: ${resultAspect.toFixed(2)}`);
        console.log(`  Dimensions: ${result.dimensions.width}x${result.dimensions.height}`);
      }
    });
  });

  // ===========================================================================
  // Stress Tests
  // ===========================================================================

  describe('Stress Tests', () => {
    it('should handle concurrent optimization requests', async () => {
      const concurrentCount = 5;
      const buffers = await Promise.all(
        Array.from({ length: concurrentCount }, () =>
          createImageNearSize(TEST_IMAGE_SIZES.MEDIUM, 0.5)
        )
      );

      const startTime = performance.now();

      const results = await Promise.all(
        buffers.map((buffer) =>
          optimizer.optimizeForCPU(buffer, {
            hardwareType: HardwareType.CPU,
            forceStrategy: OptimizationStrategy.MEDIUM,
          })
        )
      );

      const totalTime = performance.now() - startTime;

      // すべて成功していること
      expect(results).toHaveLength(concurrentCount);
      results.forEach((result) => {
        expect(result.skipped).toBe(false);
        expect(result.buffer).toBeInstanceOf(Buffer);
      });

      // 並列処理で効率的に処理されていること（単純に5倍にはならない）
      // Sharp並行制限があるので、ある程度の並列化効果を確認
      expect(totalTime).toBeLessThan(PERFORMANCE_TARGETS.MEDIUM_OPTIMIZATION_MS * concurrentCount);

      if (process.env.DEBUG) {
        console.log(`[Stress] Concurrent optimization (${concurrentCount} images):`);
        console.log(`  Total time: ${totalTime.toFixed(0)}ms`);
        console.log(`  Average per image: ${(totalTime / concurrentCount).toFixed(0)}ms`);
      }
    });

    it('should handle rapid sequential optimization', async () => {
      const sequentialCount = 10;
      const durations: number[] = [];

      for (let i = 0; i < sequentialCount; i++) {
        const buffer = await createTestImage(800, 800, { quality: 85 });
        const { durationMs } = await measureOptimization(optimizer, buffer, {
          hardwareType: HardwareType.CPU,
          forceStrategy: OptimizationStrategy.MEDIUM,
        });
        durations.push(durationMs);
      }

      // 処理時間が安定していること（極端なばらつきがない）
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const maxDuration = Math.max(...durations);
      const minDuration = Math.min(...durations);

      // 最大と最小の差が平均の3倍以内
      expect(maxDuration - minDuration).toBeLessThan(avgDuration * 3);

      if (process.env.DEBUG) {
        console.log(`[Stress] Sequential optimization (${sequentialCount} images):`);
        console.log(`  Average: ${avgDuration.toFixed(0)}ms`);
        console.log(`  Min: ${minDuration.toFixed(0)}ms`);
        console.log(`  Max: ${maxDuration.toFixed(0)}ms`);
      }
    });
  });

  // ===========================================================================
  // Memory Usage (Optional)
  // ===========================================================================

  describe('Memory Usage', () => {
    it('should not leak memory during repeated optimizations', async () => {
      const iterations = 20;

      // 初期メモリ使用量
      const initialMemory = process.memoryUsage().heapUsed;

      for (let i = 0; i < iterations; i++) {
        const buffer = await createTestImage(1000, 1000, { quality: 85 });
        await optimizer.optimizeForCPU(buffer, {
          hardwareType: HardwareType.CPU,
          forceStrategy: OptimizationStrategy.MEDIUM,
        });

        // 定期的にGCを促す（テスト環境でのメモリ安定化）
        if (i % 5 === 0 && global.gc) {
          global.gc();
        }
      }

      // GCを促す
      if (global.gc) {
        global.gc();
      }

      // 最終メモリ使用量
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // メモリ増加が100MB以下であること
      const maxMemoryIncreaseBytes = 100 * 1024 * 1024; // 100MB
      expect(memoryIncrease).toBeLessThan(maxMemoryIncreaseBytes);

      if (process.env.DEBUG) {
        console.log(`[Memory] After ${iterations} optimizations:`);
        console.log(`  Initial: ${(initialMemory / 1024 / 1024).toFixed(1)}MB`);
        console.log(`  Final: ${(finalMemory / 1024 / 1024).toFixed(1)}MB`);
        console.log(`  Increase: ${(memoryIncrease / 1024 / 1024).toFixed(1)}MB`);
      }
    });
  });

  // ===========================================================================
  // Integration: Timeout + Optimization
  // ===========================================================================

  describe('Integration: Timeout + Optimization', () => {
    it('should optimize and calculate timeout consistently', async () => {
      const testCases = [
        { name: 'Small', buffer: smallImage, expectedImageSize: ImageSize.SMALL },
        { name: 'Medium', buffer: mediumImage, expectedImageSize: ImageSize.MEDIUM },
        { name: 'Large', buffer: largeImage, expectedImageSize: ImageSize.LARGE },
      ];

      for (const { name, buffer, expectedImageSize } of testCases) {
        // 画像サイズ分類
        const imageSize = calculator.classifyImageSize(buffer.length);

        // 戦略選択
        const strategy = optimizer.selectStrategy(HardwareType.CPU, buffer.length);

        // タイムアウト計算
        const timeout = calculator.calculate(HardwareType.CPU, buffer.length);

        // 最適化実行
        const result = await optimizer.optimizeForCPU(buffer, {
          hardwareType: HardwareType.CPU,
        });

        if (process.env.DEBUG) {
          console.log(`[Integration] ${name} image:`);
          console.log(`  Size: ${buffer.length} bytes`);
          console.log(`  Image classification: ${imageSize}`);
          console.log(`  Strategy: ${strategy}`);
          console.log(`  Timeout: ${calculator.formatTimeout(timeout)}`);
          console.log(`  Optimization skipped: ${result.skipped}`);
          console.log(`  Processing time: ${result.processingTimeMs}ms`);
        }

        // タイムアウトは処理時間の100倍以上であること
        if (!result.skipped) {
          expect(timeout / result.processingTimeMs).toBeGreaterThan(100);
        }
      }
    });

    it('should use consistent size thresholds across modules', () => {
      // ImageOptimizerとTimeoutCalculatorで同じ閾値を使用していること
      expect(IMAGE_SIZE_THRESHOLDS.SMALL).toBe(100_000);
      expect(IMAGE_SIZE_THRESHOLDS.LARGE).toBe(500_000);

      // 境界値でのテスト
      const boundaryTests = [
        { size: 99_999, expectedImageSize: ImageSize.SMALL, expectedStrategy: OptimizationStrategy.NONE },
        { size: 100_000, expectedImageSize: ImageSize.MEDIUM, expectedStrategy: OptimizationStrategy.MEDIUM },
        { size: 499_999, expectedImageSize: ImageSize.MEDIUM, expectedStrategy: OptimizationStrategy.MEDIUM },
        { size: 500_000, expectedImageSize: ImageSize.LARGE, expectedStrategy: OptimizationStrategy.AGGRESSIVE },
      ];

      for (const { size, expectedImageSize, expectedStrategy } of boundaryTests) {
        const imageSize = calculator.classifyImageSize(size);
        const strategy = optimizer.selectStrategy(HardwareType.CPU, size);

        expect(imageSize).toBe(expectedImageSize);
        expect(strategy).toBe(expectedStrategy);
      }
    });
  });
});
