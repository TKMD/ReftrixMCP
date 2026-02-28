// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FrameImageAnalysisService
 *
 * PNG/JPEGフレーム連番を入力として分析機能を提供するサービス
 *
 * @module @reftrix/mcp-server/services/motion/frame-image-analysis
 *
 * 主要機能:
 * 1. フレーム差分検出 (Pixelmatch)
 * 2. レイアウトシフト検出 (CLS計算)
 * 3. 色変化検出
 * 4. タイムライン生成
 */

import * as fs from 'fs';
import * as path from 'path';

import { FrameLoader } from './infrastructure/frame-loader';
import { FrameWorkerPool } from './frame-worker-pool.service';
import type { WorkerTask } from './frame-worker-pool.service';
import type {
  FrameAnalysisInput,
  FrameAnalysisResult,
  FrameData,
  FrameDiffResult,
  DiffOptions,
  DiffAnalysisSummary,
  LayoutShiftResult,
  LayoutShiftSummary,
  ColorChangeResult,
  TimelineEvent,
  BoundingBox,
  ViewportSize,
  IFrameImageAnalysisService,
  FrameAnalysisErrorCode,
} from './types';
import {
  FrameAnalysisError,
  FrameAnalysisErrorCodes,
  DEFAULTS,
  LIMITS,
} from './types';

// ============================================================================
// 設定インターフェース
// ============================================================================

/**
 * サービス設定
 */
export interface FrameImageAnalysisServiceConfig {
  /** 最大ワーカー数 */
  maxWorkers?: number;
  /** キャッシュサイズ */
  cacheSize?: number;
}

// ============================================================================
// サービス実装
// ============================================================================

/**
 * FrameImageAnalysisService
 *
 * フレーム画像シーケンスを分析し、モーションパターンを検出するサービス
 */
export class FrameImageAnalysisService implements IFrameImageAnalysisService {
  private readonly config: Required<FrameImageAnalysisServiceConfig>;
  private disposed = false;

  constructor(config: FrameImageAnalysisServiceConfig = {}) {
    this.config = {
      maxWorkers: config.maxWorkers ?? DEFAULTS.MAX_WORKERS,
      cacheSize: config.cacheSize ?? DEFAULTS.CACHE_SIZE,
    };

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameImageAnalysisService] Initialized:', this.config);
    }
  }

  /**
   * フレームシーケンスを分析
   */
  async analyze(input: FrameAnalysisInput): Promise<FrameAnalysisResult> {
    const startTime = performance.now();

    try {
      // 入力バリデーション
      this.validateInput(input);

      // フレーム読み込み
      const frames = await this.loadFrames(input);

      if (frames.length === 0) {
        return this.createErrorResult(
          FrameAnalysisErrorCodes.MISSING_FRAMES,
          'No valid frames found in the specified location'
        );
      }

      // FPS決定
      const fps = input.extractResult?.fps ?? input.fps ?? DEFAULTS.FPS;

      // ビューポートサイズ決定
      const viewport = input.viewport ?? {
        width: frames[0]?.width ?? 1920,
        height: frames[0]?.height ?? 1080,
      };

      // 分析オプション
      const analysisOptions = input.analysisOptions ?? {};

      // 結果初期化
      const result: FrameAnalysisResult = {
        success: true,
        data: {
          totalFrames: frames.length,
          analyzedPairs: Math.max(0, frames.length - 1),
          durationMs: Math.round((frames.length / fps) * 1000),
          fps,
          processingTimeMs: 0,
          _summaryMode: input.summary ?? false,
        },
      };

      // 差分分析
      if (analysisOptions.diffAnalysis !== false) {
        const diffResults = await this.runDiffAnalysis(
          frames,
          analysisOptions.diffThreshold ?? DEFAULTS.DIFF_THRESHOLD,
          analysisOptions.parallel ?? true
        );
        result.data!.diffAnalysis = {
          results: diffResults,
          summary: this.calculateDiffSummary(diffResults),
        };
      }

      // レイアウトシフト検出
      if (analysisOptions.layoutShift !== false) {
        const shiftResults = await this.runLayoutShiftDetection(
          frames,
          viewport,
          analysisOptions.layoutShiftThreshold ?? DEFAULTS.LAYOUT_SHIFT_THRESHOLD
        );
        result.data!.layoutShifts = {
          results: shiftResults,
          summary: this.calculateLayoutShiftSummary(shiftResults),
        };
      }

      // 色変化検出
      if (analysisOptions.colorChange === true) {
        result.data!.colorChanges = await this.runColorChangeDetection(frames, fps);
      }

      // タイムライン生成
      result.data!.timeline = this.generateTimeline(result.data!, fps);

      // 処理時間記録（最低1msを保証）
      const elapsedMs = performance.now() - startTime;
      result.data!.processingTimeMs = Math.max(1, Math.round(elapsedMs));

      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log('[FrameImageAnalysisService] Analysis complete:', {
          totalFrames: result.data!.totalFrames,
          processingTimeMs: result.data!.processingTimeMs,
        });
      }

      return result;
    } catch (error) {
      if (error instanceof FrameAnalysisError) {
        return this.createErrorResult(error.code, error.message, error.details);
      }
      return this.createErrorResult(
        FrameAnalysisErrorCodes.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Unknown error occurred'
      );
    }
  }

  /**
   * 単一フレームペアの差分を計算
   */
  async comparePair(
    frame1: string | Buffer,
    frame2: string | Buffer,
    options: DiffOptions = {}
  ): Promise<FrameDiffResult> {
    const buf1 = Buffer.isBuffer(frame1) ? frame1 : await this.loadFrameBuffer(frame1);
    const buf2 = Buffer.isBuffer(frame2) ? frame2 : await this.loadFrameBuffer(frame2);

    // バッファからサイズを推測（RGBAフォーマット前提）
    const totalPixels = buf1.length / 4;
    const width = Math.sqrt(totalPixels);
    const height = totalPixels / width;

    return this.compareBuffers(buf1, buf2, width, height, options, 0);
  }

  /**
   * リソースをクリーンアップ
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameImageAnalysisService] Disposed');
    }
  }

  // ============================================================================
  // プライベートメソッド: バリデーション
  // ============================================================================

  /**
   * 入力バリデーション
   */
  private validateInput(input: FrameAnalysisInput): void {
    // 入力ソースチェック
    if (!input.frameDir && !input.framePaths && !input.extractResult) {
      throw new FrameAnalysisError(
        FrameAnalysisErrorCodes.INVALID_INPUT,
        'Either frameDir, framePaths, or extractResult is required as input source'
      );
    }

    // パストラバーサルチェック
    const pathsToCheck: string[] = [];
    if (input.frameDir) pathsToCheck.push(input.frameDir);
    if (input.framePaths) pathsToCheck.push(...input.framePaths);
    if (input.extractResult?.frameDir) pathsToCheck.push(input.extractResult.frameDir);

    for (const p of pathsToCheck) {
      if (p.includes('..')) {
        throw new FrameAnalysisError(
          FrameAnalysisErrorCodes.PATH_TRAVERSAL,
          'Path traversal detected in input path'
        );
      }
    }

    // フレーム数チェック
    if (input.framePaths && input.framePaths.length > LIMITS.MAX_TOTAL_FRAMES) {
      throw new FrameAnalysisError(
        FrameAnalysisErrorCodes.MAX_FRAMES_EXCEEDED,
        `Frame count exceeds maximum of ${LIMITS.MAX_TOTAL_FRAMES}`,
        { frameCount: input.framePaths.length, maxFrames: LIMITS.MAX_TOTAL_FRAMES }
      );
    }
  }

  // ============================================================================
  // プライベートメソッド: フレーム読み込み
  // ============================================================================

  /**
   * フレーム読み込み（FrameLoaderを使用して実際の画像を読み込み）
   */
  private async loadFrames(input: FrameAnalysisInput): Promise<FrameData[]> {
    let framePaths: string[] = [];

    if (input.framePaths) {
      framePaths = input.framePaths;
    } else if (input.frameDir) {
      framePaths = await this.getFramePathsFromDir(input.frameDir);
    } else if (input.extractResult) {
      framePaths = await this.getFramePathsFromDir(input.extractResult.frameDir);
    }

    // 有効な拡張子のみフィルタ
    framePaths = framePaths.filter((p) => {
      const ext = path.extname(p).toLowerCase();
      return LIMITS.ALLOWED_EXTENSIONS.includes(ext);
    });

    if (framePaths.length === 0) {
      return [];
    }

    // フレームディレクトリを許可ディレクトリに追加したFrameLoaderを作成
    const frameDir = path.dirname(framePaths[0] ?? '');
    const loader = new FrameLoader({
      allowedDirectories: [frameDir],
      maxFileSize: LIMITS.MAX_FILE_SIZE,
      optimizeMemory: true,
      maxWidth: 1920,
      maxHeight: 1080,
    });

    // 実際の画像を読み込み
    const frames: FrameData[] = [];
    for (let index = 0; index < framePaths.length; index++) {
      const framePath = framePaths[index];
      if (!framePath) continue;

      try {
        const frameData = await loader.loadFrame(framePath);
        frames.push({
          buffer: frameData.buffer,
          width: frameData.metadata.width,
          height: frameData.metadata.height,
          index,
          path: framePath,
        });

        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console -- Intentional debug log in development
          console.log(`[FrameImageAnalysisService] Loaded frame ${index + 1}/${framePaths.length}:`, {
            path: framePath,
            width: frameData.metadata.width,
            height: frameData.metadata.height,
            bufferSize: frameData.buffer.length,
          });
        }
      } catch (error) {
        // ファイル読み込みエラーはスキップして続行（エラーログ出力）
        if (process.env.NODE_ENV === 'development') {
          console.warn(`[FrameImageAnalysisService] Failed to load frame: ${framePath}`, error);
        }
      }
    }

    return frames;
  }

  /**
   * ディレクトリからフレームパスを取得
   */
  private async getFramePathsFromDir(dir: string): Promise<string[]> {
    if (!fs.existsSync(dir)) {
      throw new FrameAnalysisError(
        FrameAnalysisErrorCodes.MISSING_FRAMES,
        `Directory does not exist: ${dir}`
      );
    }

    const files = await fs.promises.readdir(dir);
    return files
      .filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return LIMITS.ALLOWED_EXTENSIONS.includes(ext);
      })
      .sort()
      .map((f) => path.join(dir, f));
  }

  /**
   * 単一フレームバッファを読み込み（FrameLoaderを使用）
   */
  private async loadFrameBuffer(framePath: string): Promise<Buffer> {
    if (!fs.existsSync(framePath)) {
      throw new FrameAnalysisError(
        FrameAnalysisErrorCodes.FILE_READ_ERROR,
        `Frame file not found: ${framePath}`
      );
    }

    // 動的に許可ディレクトリを設定
    const frameDir = path.dirname(framePath);
    const loader = new FrameLoader({
      allowedDirectories: [frameDir],
      maxFileSize: LIMITS.MAX_FILE_SIZE,
    });

    const frameData = await loader.loadFrame(framePath);
    return frameData.buffer;
  }

  // ============================================================================
  // プライベートメソッド: 差分分析
  // ============================================================================

  /**
   * 差分分析を実行
   *
   * parallel=true かつフレームペア数が PARALLEL_THRESHOLD 以上の場合、
   * FrameWorkerPool を使用してWorker Threads並列処理を行う。
   * それ以外はメインスレッドで逐次処理。
   */
  private async runDiffAnalysis(
    frames: FrameData[],
    threshold: number,
    parallel: boolean
  ): Promise<FrameDiffResult[]> {
    const totalPairs = frames.length - 1;

    if (totalPairs <= 0) {
      return [];
    }

    // 並列処理の閾値: 10ペア以上かつ parallel=true の場合にWorker Poolを使用
    const PARALLEL_THRESHOLD = 10;

    if (parallel && totalPairs >= PARALLEL_THRESHOLD) {
      return this.runDiffAnalysisParallel(frames, threshold);
    }

    return this.runDiffAnalysisSequential(frames, threshold);
  }

  /**
   * 逐次差分分析
   */
  private async runDiffAnalysisSequential(
    frames: FrameData[],
    threshold: number
  ): Promise<FrameDiffResult[]> {
    const results: FrameDiffResult[] = [];

    for (let i = 0; i < frames.length - 1; i++) {
      const frame1 = frames[i];
      const frame2 = frames[i + 1];

      // TypeScript strictモードでは配列アクセスがundefinedになり得る
      if (!frame1 || !frame2) {
        continue;
      }

      const result = await this.compareBuffers(
        frame1.buffer,
        frame2.buffer,
        frame1.width,
        frame1.height,
        { threshold },
        i + 1
      );

      results.push(result);
    }

    return results;
  }

  /**
   * Worker Pool を使用した並列差分分析
   *
   * FrameWorkerPoolでフレームペアを並列に比較し、
   * 失敗時は逐次処理にフォールバックする
   */
  private async runDiffAnalysisParallel(
    frames: FrameData[],
    threshold: number
  ): Promise<FrameDiffResult[]> {
    const workerPool = new FrameWorkerPool({
      workerCount: this.config.maxWorkers,
    });

    try {
      await workerPool.initialize();

      // タスクを構築
      const tasks: WorkerTask[] = [];
      for (let i = 0; i < frames.length - 1; i++) {
        const frame1 = frames[i];
        const frame2 = frames[i + 1];

        if (!frame1 || !frame2) {
          continue;
        }

        tasks.push({
          taskId: `diff-${i + 1}`,
          frame1: frame1.buffer,
          frame2: frame2.buffer,
          width: frame1.width,
          height: frame1.height,
          options: { threshold },
        });
      }

      if (tasks.length === 0) {
        return [];
      }

      // バッチ処理で並列実行
      const taskResults = await workerPool.processBatch(tasks);

      // 結果を FrameDiffResult に変換
      const results: FrameDiffResult[] = [];
      for (let idx = 0; idx < taskResults.length; idx++) {
        const taskResult = taskResults[idx];
        if (!taskResult) continue;

        if (taskResult.success && taskResult.result) {
          const r = taskResult.result;
          results.push({
            frameIndex: idx + 1,
            changedPixels: r.changedPixels,
            totalPixels: r.totalPixels,
            changeRatio: r.changeRatio,
            hasChange: r.hasChange,
            regions: r.regions,
          });
        } else {
          // ワーカー失敗時はフレームインデックス付きの空結果を追加
          if (process.env.NODE_ENV === 'development') {
            console.warn(
              `[FrameImageAnalysisService] Worker failed for pair ${idx + 1}:`,
              taskResult.error
            );
          }
          results.push({
            frameIndex: idx + 1,
            changedPixels: 0,
            totalPixels: 0,
            changeRatio: 0,
            hasChange: false,
            regions: [],
          });
        }
      }

      if (process.env.NODE_ENV === 'development') {
        const stats = workerPool.getStats();
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log('[FrameImageAnalysisService] Parallel diff analysis complete:', {
          totalPairs: tasks.length,
          completedTasks: stats.completedTasks,
          failedTasks: stats.failedTasks,
        });
      }

      return results;
    } catch (error) {
      // Worker Pool初期化/処理失敗時は逐次処理にフォールバック
      if (process.env.NODE_ENV === 'development') {
        console.warn(
          '[FrameImageAnalysisService] Parallel processing failed, falling back to sequential:',
          error instanceof Error ? error.message : String(error)
        );
      }
      return this.runDiffAnalysisSequential(frames, threshold);
    } finally {
      await workerPool.shutdown();
    }
  }

  /**
   * バッファ比較
   * 注: パフォーマンス最適化 - 境界ボックス計算をインラインで行い、
   * 大量のピクセル位置配列を保持しない
   */
  private async compareBuffers(
    buf1: Buffer,
    buf2: Buffer,
    width: number,
    height: number,
    options: DiffOptions,
    frameIndex: number
  ): Promise<FrameDiffResult> {
    const threshold = options.threshold ?? DEFAULTS.DIFF_THRESHOLD;
    const totalPixels = width * height;
    const thresholdValue = threshold * 255 * 3;
    const bufLen = Math.min(buf1.length, buf2.length);

    // インラインで境界ボックスを計算（メモリ効率とパフォーマンス向上）
    let changedPixels = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    for (let i = 0; i < bufLen; i += 4) {
      const r1 = buf1[i] ?? 0;
      const g1 = buf1[i + 1] ?? 0;
      const b1 = buf1[i + 2] ?? 0;
      const r2 = buf2[i] ?? 0;
      const g2 = buf2[i + 1] ?? 0;
      const b2 = buf2[i + 2] ?? 0;

      const diff = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
      if (diff > thresholdValue) {
        changedPixels++;
        const pixelIndex = i / 4;
        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);

        // 境界ボックスをその場で更新
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    const changeRatio = changedPixels / totalPixels;

    // 変化があった場合のみ領域を生成
    const regions: BoundingBox[] =
      changedPixels > 0
        ? [
            {
              x: minX,
              y: minY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            },
          ]
        : [];

    return {
      frameIndex,
      changedPixels,
      totalPixels,
      changeRatio,
      hasChange: changeRatio > 0.001,
      regions,
    };
  }

  /**
   * 差分サマリーを計算
   */
  private calculateDiffSummary(results: FrameDiffResult[]): DiffAnalysisSummary {
    if (results.length === 0) {
      return {
        avgChangeRatio: 0,
        maxChangeRatio: 0,
        motionFrameCount: 0,
        motionFrameRatio: 0,
      };
    }

    let sum = 0;
    let maxChangeRatio = 0;
    let motionFrameCount = 0;

    for (const r of results) {
      sum += r.changeRatio;
      if (r.changeRatio > maxChangeRatio) {
        maxChangeRatio = r.changeRatio;
      }
      if (r.hasChange) {
        motionFrameCount++;
      }
    }

    return {
      avgChangeRatio: sum / results.length,
      maxChangeRatio,
      motionFrameCount,
      motionFrameRatio: motionFrameCount / results.length,
    };
  }

  // ============================================================================
  // プライベートメソッド: レイアウトシフト検出
  // ============================================================================

  /**
   * レイアウトシフト検出を実行
   *
   * Core Web Vitals準拠のCLS計算:
   * - impact fraction = 変化領域面積 / ビューポート面積
   * - distance fraction = シフト距離 / max(viewport.width, viewport.height)
   * - layout shift score = impact fraction * distance fraction
   */
  private async runLayoutShiftDetection(
    frames: FrameData[],
    viewport: ViewportSize,
    threshold: number
  ): Promise<LayoutShiftResult[]> {
    const results: LayoutShiftResult[] = [];

    if (frames.length < 2) {
      return results;
    }

    const viewportArea = viewport.width * viewport.height;
    const maxViewportDimension = Math.max(viewport.width, viewport.height);

    if (viewportArea === 0 || maxViewportDimension === 0) {
      return results;
    }

    // 前フレームの変化領域を保持（シフト距離計算用）
    let previousRegions: BoundingBox[] = [];

    for (let i = 0; i < frames.length - 1; i++) {
      const frame1 = frames[i];
      const frame2 = frames[i + 1];

      if (!frame1 || !frame2) {
        continue;
      }

      // フレーム差分を計算
      const diffResult = await this.compareBuffers(
        frame1.buffer,
        frame2.buffer,
        frame1.width,
        frame1.height,
        { threshold: DEFAULTS.DIFF_THRESHOLD },
        i + 1
      );

      // 変化がない場合はスキップ
      if (!diffResult.hasChange || diffResult.regions.length === 0) {
        previousRegions = [];
        continue;
      }

      for (const region of diffResult.regions) {
        // impact fraction: ビューポートに対する変化領域の割合
        const visibleLeft = Math.max(0, region.x);
        const visibleTop = Math.max(0, region.y);
        const visibleRight = Math.min(viewport.width, region.x + region.width);
        const visibleBottom = Math.min(viewport.height, region.y + region.height);
        const visibleWidth = Math.max(0, visibleRight - visibleLeft);
        const visibleHeight = Math.max(0, visibleBottom - visibleTop);
        const visibleArea = visibleWidth * visibleHeight;

        const impactFraction = Math.max(0, Math.min(1, visibleArea / viewportArea));

        // distance fraction: シフト距離の計算
        let shiftDistance = 0;
        let shiftDirection = 0;

        // 前フレームに対応する領域があればそこからの移動距離を計算
        const matchedPrev = previousRegions.length > 0 ? previousRegions[0] : undefined;
        if (matchedPrev) {
          const dx = region.x - matchedPrev.x;
          const dy = region.y - matchedPrev.y;
          shiftDistance = Math.sqrt(dx * dx + dy * dy);
          shiftDirection = Math.atan2(dy, dx) * (180 / Math.PI);
        } else {
          // previousRegionがない場合は変化強度に基づいて推定
          shiftDistance = diffResult.changeRatio * maxViewportDimension * 0.1;
          shiftDirection = 0;
        }

        const distanceFraction = Math.max(
          0,
          Math.min(1, shiftDistance / maxViewportDimension)
        );

        // CLS impact score = impact fraction * distance fraction
        const impactScore = impactFraction * distanceFraction;

        // 閾値以下はスキップ
        if (impactScore <= threshold) {
          continue;
        }

        // シフト原因の推定
        const estimatedCause = this.estimateShiftCause(
          region,
          diffResult.changeRatio,
          viewport
        );

        results.push({
          frameIndex: i + 1,
          shiftStartMs: ((i + 1) / DEFAULTS.FPS) * 1000,
          impactScore,
          affectedRegions: [region],
          estimatedCause,
          shiftDirection,
          shiftDistance,
        });
      }

      // 次のフレーム比較のために現在の変化領域を保存
      previousRegions = diffResult.regions;
    }

    return results;
  }

  /**
   * レイアウトシフトの推定原因を判定
   */
  private estimateShiftCause(
    region: BoundingBox,
    changeRatio: number,
    viewport: ViewportSize
  ): LayoutShiftResult['estimatedCause'] {
    const regionArea = region.width * region.height;
    const viewportArea = viewport.width * viewport.height;
    const areaRatio = viewportArea > 0 ? regionArea / viewportArea : 0;

    // 大きな矩形領域の変化 -> 画像読み込み
    const aspectRatio = region.width > 0 ? region.height / region.width : 0;
    if (areaRatio > 0.05 && aspectRatio > 0.3 && aspectRatio < 3.0) {
      return 'image_load';
    }

    // 幅広で高さが小さい変化 -> フォントスワップ
    if (region.width > viewport.width * 0.3 && region.height < viewport.height * 0.1) {
      return 'font_swap';
    }

    // 変化率が低い場合 -> 動的コンテンツ
    if (changeRatio < 0.05) {
      return 'dynamic_content';
    }

    return 'unknown';
  }

  /**
   * レイアウトシフトサマリーを計算
   */
  private calculateLayoutShiftSummary(results: LayoutShiftResult[]): LayoutShiftSummary {
    if (results.length === 0) {
      return {
        totalShifts: 0,
        maxImpactScore: 0,
        cumulativeShiftScore: 0,
      };
    }

    let maxImpactScore = 0;
    let cumulativeShiftScore = 0;

    for (const r of results) {
      if (r.impactScore > maxImpactScore) {
        maxImpactScore = r.impactScore;
      }
      cumulativeShiftScore += r.impactScore;
    }

    return {
      totalShifts: results.length,
      maxImpactScore,
      cumulativeShiftScore,
    };
  }

  // ============================================================================
  // プライベートメソッド: 色変化検出
  // ============================================================================

  /**
   * 色変化検出を実行
   *
   * 4x4グリッドの各領域でフレーム間のRGB平均色を追跡し、
   * フェードイン/アウト・色遷移・輝度変化を検出する
   */
  private async runColorChangeDetection(
    frames: FrameData[],
    fps: number
  ): Promise<ColorChangeResult> {
    if (frames.length < 2) {
      return { events: [], fadeInCount: 0, fadeOutCount: 0, transitionCount: 0 };
    }

    const GRID_COLS = 4;
    const GRID_ROWS = 4;
    const TOTAL_REGIONS = GRID_COLS * GRID_ROWS;

    // 輝度閾値（0-1スケール）
    const DARK_THRESHOLD = 0.1;
    const LIGHT_THRESHOLD = 0.3;
    const LUMINANCE_CHANGE_THRESHOLD = 0.3;
    const HUE_CHANGE_THRESHOLD = 30;
    const MIN_EVENT_FRAMES = 2;

    const firstFrame = frames[0];
    if (!firstFrame) {
      return { events: [], fadeInCount: 0, fadeOutCount: 0, transitionCount: 0 };
    }

    const width = firstFrame.width;
    const height = firstFrame.height;
    const cellW = Math.floor(width / GRID_COLS);
    const cellH = Math.floor(height / GRID_ROWS);

    // 各フレーム・各グリッド領域の平均色情報を計算
    interface RegionColor {
      r: number;
      g: number;
      b: number;
      luminance: number;
      hue: number;
    }

    const frameColors: RegionColor[][] = [];
    for (const frame of frames) {
      const regionColors: RegionColor[] = [];
      for (let row = 0; row < GRID_ROWS; row++) {
        for (let col = 0; col < GRID_COLS; col++) {
          const startX = col * cellW;
          const startY = row * cellH;
          const avgColor = this.calculateRegionAvgColor(
            frame.buffer,
            width,
            startX,
            startY,
            cellW,
            cellH
          );
          regionColors.push(avgColor);
        }
      }
      frameColors.push(regionColors);
    }

    // 各領域ごとにフレーム間の色変化を追跡してイベントを検出
    const events: ColorChangeResult['events'] = [];

    for (let regionIdx = 0; regionIdx < TOTAL_REGIONS; regionIdx++) {
      const col = regionIdx % GRID_COLS;
      const row = Math.floor(regionIdx / GRID_COLS);
      const regionBox: BoundingBox = {
        x: col * cellW,
        y: row * cellH,
        width: cellW,
        height: cellH,
      };

      // 色変化の連続を追跡
      let eventStartFrame: number | null = null;
      let startColor: RegionColor | null = null;
      let lastSignificantFrame = 0;
      let accumulatedLuminanceDelta = 0;
      let accumulatedHueDelta = 0;

      for (let fi = 1; fi < frames.length; fi++) {
        const prevColors = frameColors[fi - 1];
        const currColors = frameColors[fi];
        if (!prevColors || !currColors) continue;

        const prev = prevColors[regionIdx];
        const curr = currColors[regionIdx];
        if (!prev || !curr) continue;

        const luminanceDelta = curr.luminance - prev.luminance;
        const absLuminanceDelta = Math.abs(luminanceDelta);
        let hueDelta = Math.abs(curr.hue - prev.hue);
        if (hueDelta > 180) hueDelta = 360 - hueDelta;

        const hasSignificantChange =
          absLuminanceDelta > 0.02 || hueDelta > 5;

        if (hasSignificantChange) {
          if (eventStartFrame === null) {
            eventStartFrame = fi - 1;
            startColor = prev;
            accumulatedLuminanceDelta = luminanceDelta;
            accumulatedHueDelta = hueDelta;
          } else {
            accumulatedLuminanceDelta += luminanceDelta;
            accumulatedHueDelta += hueDelta;
          }
          lastSignificantFrame = fi;
        } else if (eventStartFrame !== null) {
          // 変化が止まった -> イベント確定を試みる
          this.finalizeColorEvent(
            events,
            eventStartFrame,
            lastSignificantFrame,
            startColor,
            frameColors,
            regionIdx,
            regionBox,
            accumulatedLuminanceDelta,
            accumulatedHueDelta,
            fps,
            DARK_THRESHOLD,
            LIGHT_THRESHOLD,
            LUMINANCE_CHANGE_THRESHOLD,
            HUE_CHANGE_THRESHOLD,
            MIN_EVENT_FRAMES
          );
          eventStartFrame = null;
          startColor = null;
          accumulatedLuminanceDelta = 0;
          accumulatedHueDelta = 0;
        }
      }

      // 最後まで続いた変化を処理
      if (eventStartFrame !== null && startColor !== null) {
        this.finalizeColorEvent(
          events,
          eventStartFrame,
          lastSignificantFrame,
          startColor,
          frameColors,
          regionIdx,
          regionBox,
          accumulatedLuminanceDelta,
          accumulatedHueDelta,
          fps,
          DARK_THRESHOLD,
          LIGHT_THRESHOLD,
          LUMINANCE_CHANGE_THRESHOLD,
          HUE_CHANGE_THRESHOLD,
          MIN_EVENT_FRAMES
        );
      }
    }

    // イベントをstartFrameでソート
    events.sort((a, b) => a.startFrame - b.startFrame);

    // カウント集計
    let fadeInCount = 0;
    let fadeOutCount = 0;
    let transitionCount = 0;

    for (const event of events) {
      switch (event.changeType) {
        case 'fade_in':
          fadeInCount++;
          break;
        case 'fade_out':
          fadeOutCount++;
          break;
        case 'color_transition':
          transitionCount++;
          break;
        // brightness_change はどのカウントにも含めない
      }
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameImageAnalysisService] Color change detection:', {
        totalEvents: events.length,
        fadeInCount,
        fadeOutCount,
        transitionCount,
      });
    }

    return { events, fadeInCount, fadeOutCount, transitionCount };
  }

  /**
   * 色変化イベントを確定してリストに追加
   */
  private finalizeColorEvent(
    events: ColorChangeResult['events'],
    eventStartFrame: number,
    lastSignificantFrame: number,
    startColor: { r: number; g: number; b: number; luminance: number; hue: number } | null,
    frameColors: { r: number; g: number; b: number; luminance: number; hue: number }[][],
    regionIdx: number,
    regionBox: BoundingBox,
    accumulatedLuminanceDelta: number,
    accumulatedHueDelta: number,
    fps: number,
    darkThreshold: number,
    lightThreshold: number,
    luminanceChangeThreshold: number,
    hueChangeThreshold: number,
    minEventFrames: number
  ): void {
    const eventFrameCount = lastSignificantFrame - eventStartFrame;
    if (eventFrameCount < minEventFrames || !startColor) {
      return;
    }

    const endColors = frameColors[lastSignificantFrame];
    const endColor = endColors?.[regionIdx];
    if (!endColor) {
      return;
    }

    const absLuminanceDelta = Math.abs(accumulatedLuminanceDelta);

    // 変化タイプの判定
    let changeType: ColorChangeResult['events'][number]['changeType'];

    if (
      startColor.luminance < darkThreshold &&
      endColor.luminance > lightThreshold
    ) {
      changeType = 'fade_in';
    } else if (
      startColor.luminance > lightThreshold &&
      endColor.luminance < darkThreshold
    ) {
      changeType = 'fade_out';
    } else if (accumulatedHueDelta > hueChangeThreshold) {
      changeType = 'color_transition';
    } else if (absLuminanceDelta > luminanceChangeThreshold) {
      changeType = 'brightness_change';
    } else {
      // 閾値未満の変化は無視
      return;
    }

    const fromColor = this.rgbToHex(startColor.r, startColor.g, startColor.b);
    const toColor = this.rgbToHex(endColor.r, endColor.g, endColor.b);
    const estimatedDurationMs = (eventFrameCount / fps) * 1000;

    events.push({
      startFrame: eventStartFrame,
      endFrame: lastSignificantFrame,
      changeType,
      affectedRegion: regionBox,
      fromColor,
      toColor,
      estimatedDurationMs: Math.round(estimatedDurationMs),
    });
  }

  /**
   * バッファ領域の平均RGB色と輝度・色相を計算
   */
  private calculateRegionAvgColor(
    buffer: Buffer,
    imageWidth: number,
    startX: number,
    startY: number,
    cellWidth: number,
    cellHeight: number
  ): { r: number; g: number; b: number; luminance: number; hue: number } {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;

    for (let y = startY; y < startY + cellHeight; y++) {
      for (let x = startX; x < startX + cellWidth; x++) {
        const idx = (y * imageWidth + x) * 4;
        const r = buffer[idx] ?? 0;
        const g = buffer[idx + 1] ?? 0;
        const b = buffer[idx + 2] ?? 0;
        sumR += r;
        sumG += g;
        sumB += b;
        count++;
      }
    }

    if (count === 0) {
      return { r: 0, g: 0, b: 0, luminance: 0, hue: 0 };
    }

    const avgR = sumR / count;
    const avgG = sumG / count;
    const avgB = sumB / count;

    // sRGB relative luminance (ITU-R BT.709)
    const luminance = (0.2126 * avgR + 0.7152 * avgG + 0.0722 * avgB) / 255;

    // Simple hue calculation
    const rNorm = avgR / 255;
    const gNorm = avgG / 255;
    const bNorm = avgB / 255;
    const max = Math.max(rNorm, gNorm, bNorm);
    const min = Math.min(rNorm, gNorm, bNorm);
    const delta = max - min;

    let hue = 0;
    if (delta > 0.001) {
      if (max === rNorm) {
        hue = ((gNorm - bNorm) / delta) % 6;
      } else if (max === gNorm) {
        hue = (bNorm - rNorm) / delta + 2;
      } else {
        hue = (rNorm - gNorm) / delta + 4;
      }
      hue = Math.round(hue * 60);
      if (hue < 0) hue += 360;
    }

    return {
      r: Math.round(avgR),
      g: Math.round(avgG),
      b: Math.round(avgB),
      luminance,
      hue,
    };
  }

  /**
   * RGB値をHEX文字列に変換
   */
  private rgbToHex(r: number, g: number, b: number): string {
    const toHex = (value: number): string =>
      Math.round(Math.max(0, Math.min(255, value)))
        .toString(16)
        .padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  // ============================================================================
  // プライベートメソッド: タイムライン生成
  // ============================================================================

  /**
   * タイムラインを生成
   */
  private generateTimeline(
    data: NonNullable<FrameAnalysisResult['data']>,
    fps: number
  ): TimelineEvent[] {
    const events: TimelineEvent[] = [];

    // 差分分析からイベント生成
    if (data.diffAnalysis) {
      let motionStarted = false;
      for (const result of data.diffAnalysis.results) {
        if (result.hasChange && !motionStarted) {
          events.push({
            timestampMs: (result.frameIndex / fps) * 1000,
            frameIndex: result.frameIndex,
            type: 'motion_start',
            details: { changeRatio: result.changeRatio },
          });
          motionStarted = true;
        } else if (!result.hasChange && motionStarted) {
          events.push({
            timestampMs: (result.frameIndex / fps) * 1000,
            frameIndex: result.frameIndex,
            type: 'motion_end',
            details: {},
          });
          motionStarted = false;
        }
      }
    }

    // レイアウトシフトからイベント生成
    if (data.layoutShifts) {
      for (const shift of data.layoutShifts.results) {
        events.push({
          timestampMs: shift.shiftStartMs,
          frameIndex: shift.frameIndex,
          type: 'layout_shift',
          details: { impactScore: shift.impactScore },
        });
      }
    }

    // タイムスタンプでソート
    events.sort((a, b) => a.timestampMs - b.timestampMs);

    return events;
  }

  // ============================================================================
  // プライベートメソッド: エラーハンドリング
  // ============================================================================

  /**
   * エラー結果を作成
   */
  private createErrorResult(
    code: FrameAnalysisErrorCode,
    message: string,
    details?: Record<string, unknown>
  ): FrameAnalysisResult {
    const error: FrameAnalysisResult['error'] = {
      code,
      message,
    };
    if (details !== undefined) {
      error!.details = details;
    }
    return {
      success: false,
      error,
    };
  }
}

// ============================================================================
// ファクトリ関数
// ============================================================================

/**
 * サービスインスタンスを作成
 */
export function createFrameImageAnalysisService(
  config?: FrameImageAnalysisServiceConfig
): FrameImageAnalysisService {
  return new FrameImageAnalysisService(config);
}
