// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FrameImageAnalyzer Adapter
 *
 * motion.detect (Phase5) から呼び出されるFrame Image Analysisサービス
 *
 * 設計:
 * - detect.tool.ts の IFrameImageAnalysisService インターフェースを実装
 * - 内部でPixelmatch + Sharpを使用してフレーム差分を計算
 * - スタンドアロン版 frame-image-analysis.mjs のロジックをTypeScriptにポート
 *
 * @module @reftrix/mcp-server/services/motion/frame-image-analyzer.adapter
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import pixelmatch from 'pixelmatch';

// ============================================================================
// 型定義（detect.tool.ts の FrameImageAnalysisOutput と互換）
// ============================================================================

/**
 * アニメーションタイプ
 * スクロール距離（duration）に基づいて分類
 */
export type AnimationType =
  | 'micro-interaction'         // < 500px
  | 'fade/slide transition'     // 500-1500px
  | 'scroll-linked animation'   // 1500-3000px
  | 'long-form reveal';         // > 3000px

/**
 * モーション方向
 */
export type MotionDirection = 'up' | 'down' | 'left' | 'right' | 'stationary';

/**
 * 境界ボックス
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * アニメーションゾーン
 * 連続した有意な変化が検出されたフレーム範囲
 */
export interface AnimationZone {
  frameStart: string;
  frameEnd: string;
  scrollStart: number;
  scrollEnd: number;
  duration: number;
  avgDiff: string;
  peakDiff: string;
  animationType: AnimationType;
}

/**
 * レイアウトシフト検出結果
 */
export interface LayoutShiftInfo {
  frameRange: string;
  scrollRange: string;
  impactFraction: string;
  boundingBox: BoundingBox;
}

/**
 * モーションベクトル情報
 */
export interface MotionVectorInfo {
  frameRange: string;
  dx: number;
  dy: number;
  magnitude: string;
  direction: MotionDirection;
  angle: string;
}

/**
 * Frame Image Analysis 出力
 * detect.tool.ts の FrameImageAnalysisOutput と互換
 */
export interface FrameImageAnalysisOutput {
  metadata: {
    framesDir: string;
    totalFrames: number;
    analyzedPairs: number;
    sampleInterval: number;
    scrollPxPerFrame: number;
    analysisTime: string;
    analyzedAt: string;
  };
  statistics: {
    averageDiffPercentage: string;
    significantChangeCount: number;
    significantChangePercentage: string;
    layoutShiftCount: number;
    motionVectorCount: number;
  };
  animationZones: AnimationZone[];
  layoutShifts: LayoutShiftInfo[];
  motionVectors: MotionVectorInfo[];
}

/**
 * 分析オプション
 */
export interface AnalyzeOptions {
  sampleInterval?: number;
  diffThreshold?: number;
  clsThreshold?: number;
  motionThreshold?: number;
  outputDiffImages?: boolean;
  parallel?: boolean;
  scrollPxPerFrame?: number;
  /** 最大レイアウトシフト数（デフォルト: 1000） */
  maxLayoutShifts?: number;
  /** 最大モーションベクター数（デフォルト: 1000） */
  maxMotionVectors?: number;
  /** 最大アニメーションゾーン数（デフォルト: 1000） */
  maxAnimationZones?: number;
  /**
   * 分析対象のフレーム数上限
   * FrameCaptureServiceからキャプチャされたフレーム数を渡すことで、
   * 古いフレームと混在することを防ぐ
   * 未指定の場合はディレクトリ内の全フレームを分析
   */
  maxFrames?: number;
}

/**
 * フレームペア分析結果（内部用）
 */
interface FramePairAnalysis {
  frame1: string;
  frame2: string;
  width: number;
  height: number;
  diffPixels: number;
  totalPixels: number;
  diffPercentage: string;
  significantChange: boolean;
  motion: MotionAnalysis;
}

/**
 * モーション分析結果（内部用）
 */
interface MotionAnalysis {
  detected: boolean;
  boundingBox: BoundingBox | null;
  centroid: { x: number; y: number } | null;
  area: number;
  areaPercentage: string;
  impactFraction: string;
  isLayoutShift: boolean;
}

// ============================================================================
// 定数
// ============================================================================

/** デフォルト: 差分しきい値 (10%) */
const DEFAULT_DIFF_THRESHOLD = 0.1;

/** デフォルト: CLSしきい値 (Core Web Vitals基準) */
const DEFAULT_CLS_THRESHOLD = 0.05;

/** デフォルト: モーション検出しきい値 (pixels) */
const DEFAULT_MOTION_THRESHOLD = 50;

/** デフォルト: サンプリング間隔 */
const DEFAULT_SAMPLE_INTERVAL = 10;

/** デフォルト: スクロール距離/フレーム */
const DEFAULT_SCROLL_PX_PER_FRAME = 15;

/** デフォルト: 最大レイアウトシフト数 */
const DEFAULT_MAX_LAYOUT_SHIFTS = 1000;

/** デフォルト: 最大モーションベクター数 */
const DEFAULT_MAX_MOTION_VECTORS = 1000;

/** デフォルト: 最大アニメーションゾーン数 */
const DEFAULT_MAX_ANIMATION_ZONES = 1000;

// ============================================================================
// FrameImageAnalyzerAdapter クラス
// ============================================================================

/**
 * FrameImageAnalyzerAdapter
 *
 * motion.detect (Phase5) 向けのFrame Image Analysisサービス
 * IFrameImageAnalysisService インターフェースを実装
 */
export class FrameImageAnalyzerAdapter {
  private disposed = false;

  constructor() {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameImageAnalyzerAdapter] Initialized');
    }
  }

  /**
   * フレームディレクトリを分析
   *
   * @param framesDir - フレーム画像が格納されているディレクトリ
   * @param options - 分析オプション
   * @returns Frame Image Analysis結果
   */
  async analyze(
    framesDir: string,
    options: AnalyzeOptions = {}
  ): Promise<FrameImageAnalysisOutput> {
    const startTime = Date.now();

    // オプションのデフォルト値
    const sampleInterval = options.sampleInterval ?? DEFAULT_SAMPLE_INTERVAL;
    const diffThreshold = options.diffThreshold ?? DEFAULT_DIFF_THRESHOLD;
    const clsThreshold = options.clsThreshold ?? DEFAULT_CLS_THRESHOLD;
    const motionThreshold = options.motionThreshold ?? DEFAULT_MOTION_THRESHOLD;
    const scrollPxPerFrame = options.scrollPxPerFrame ?? DEFAULT_SCROLL_PX_PER_FRAME;
    const maxLayoutShifts = options.maxLayoutShifts ?? DEFAULT_MAX_LAYOUT_SHIFTS;
    const maxMotionVectors = options.maxMotionVectors ?? DEFAULT_MAX_MOTION_VECTORS;
    const maxAnimationZones = options.maxAnimationZones ?? DEFAULT_MAX_ANIMATION_ZONES;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameImageAnalyzerAdapter] Starting analysis:', {
        framesDir,
        sampleInterval,
        diffThreshold,
        clsThreshold,
        motionThreshold,
        scrollPxPerFrame,
      });
    }

    // ディレクトリ存在確認
    if (!fs.existsSync(framesDir)) {
      throw new Error(`Frames directory not found: ${framesDir}`);
    }

    // フレームファイル一覧を取得
    const files = await fs.promises.readdir(framesDir);
    let frameFiles = files
      .filter((f) => f.startsWith('frame-') && (f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg')))
      .sort();

    if (frameFiles.length === 0) {
      throw new Error(`No frame files found in ${framesDir}`);
    }

    // maxFramesが指定されている場合、その数に制限
    // これにより、古いフレームと混在することを防ぐ
    const maxFrames = options.maxFrames;
    if (maxFrames !== undefined && maxFrames > 0 && frameFiles.length > maxFrames) {
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console -- Intentional debug log in development
        console.log('[FrameImageAnalyzerAdapter] Limiting frames:', {
          foundFrames: frameFiles.length,
          maxFrames,
          trimmedCount: frameFiles.length - maxFrames,
        });
      }
      frameFiles = frameFiles.slice(0, maxFrames);
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameImageAnalyzerAdapter] Found frames:', {
        totalFrames: frameFiles.length,
        expectedPairs: Math.floor(frameFiles.length / sampleInterval),
        maxFramesLimit: maxFrames ?? 'unlimited',
      });
    }

    // フレームペア分析
    const results: FramePairAnalysis[] = [];
    const layoutShifts: LayoutShiftInfo[] = [];
    const motionVectors: MotionVectorInfo[] = [];
    let prevAnalysis: FramePairAnalysis | null = null;

    for (let i = 0; i < frameFiles.length - sampleInterval; i += sampleInterval) {
      const frame1Name = frameFiles[i];
      const frame2Name = frameFiles[i + sampleInterval];

      if (!frame1Name || !frame2Name) continue;

      const frame1Path = path.join(framesDir, frame1Name);
      const frame2Path = path.join(framesDir, frame2Name);

      try {
        const analysis = await this.analyzeFramePair(
          frame1Path,
          frame2Path,
          diffThreshold,
          clsThreshold
        );

        if (analysis) {
          results.push(analysis);

          // レイアウトシフト追跡
          if (analysis.motion.isLayoutShift) {
            const frameNum = this.extractFrameNumber(frame1Name);
            layoutShifts.push({
              frameRange: `${frame1Name} - ${frame2Name}`,
              scrollRange: `${frameNum * scrollPxPerFrame}px - ${(frameNum + sampleInterval) * scrollPxPerFrame}px`,
              impactFraction: analysis.motion.impactFraction,
              boundingBox: analysis.motion.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
            });
          }

          // モーションベクトル推定
          if (prevAnalysis) {
            const vector = this.estimateMotionVector(prevAnalysis, analysis, motionThreshold);
            if (vector) {
              motionVectors.push({
                frameRange: `${prevAnalysis.frame2} - ${analysis.frame2}`,
                ...vector,
              });
            }
          }
          prevAnalysis = analysis;

          // 進捗ログ
          if (process.env.NODE_ENV === 'development' && results.length % 10 === 0) {
            // eslint-disable-next-line no-console -- Intentional debug log in development
            console.log(`[FrameImageAnalyzerAdapter] Analyzed ${results.length} frame pairs...`);
          }
        }
      } catch (err) {
        if (process.env.NODE_ENV === 'development') {
          console.error(`[FrameImageAnalyzerAdapter] Error analyzing ${frame1Name} vs ${frame2Name}:`, err);
        }
      }
    }

    // 処理時間
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    // 統計計算
    const significantChanges = results.filter((r) => r.significantChange);
    const avgDiff = results.length > 0
      ? results.reduce((sum, r) => sum + parseFloat(r.diffPercentage), 0) / results.length
      : 0;

    // アニメーションゾーン検出
    const animationZones = this.detectAnimationZones(results, scrollPxPerFrame, sampleInterval);

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameImageAnalyzerAdapter] Analysis complete:', {
        totalFrames: frameFiles.length,
        analyzedPairs: results.length,
        avgDiff: avgDiff.toFixed(2),
        significantChanges: significantChanges.length,
        layoutShifts: layoutShifts.length,
        motionVectors: motionVectors.length,
        animationZones: animationZones.length,
        duration: `${duration}s`,
      });
    }

    return {
      metadata: {
        framesDir,
        totalFrames: frameFiles.length,
        analyzedPairs: results.length,
        sampleInterval,
        scrollPxPerFrame,
        analysisTime: `${duration}s`,
        analyzedAt: new Date().toISOString(),
      },
      statistics: {
        averageDiffPercentage: avgDiff.toFixed(2),
        significantChangeCount: significantChanges.length,
        significantChangePercentage: results.length > 0
          ? ((significantChanges.length / results.length) * 100).toFixed(2)
          : '0.00',
        layoutShiftCount: layoutShifts.length,
        motionVectorCount: motionVectors.length,
      },
      animationZones: animationZones.slice(0, maxAnimationZones),
      layoutShifts: layoutShifts.slice(0, maxLayoutShifts),
      motionVectors: motionVectors.slice(0, maxMotionVectors)
    };
  }

  /**
   * サービスが利用可能かどうかを確認
   */
  isAvailable(): boolean {
    return !this.disposed;
  }

  /**
   * リソースを解放
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameImageAnalyzerAdapter] Disposed');
    }
  }

  // ============================================================================
  // プライベートメソッド
  // ============================================================================

  /**
   * フレームを読み込み、RGBAバッファとして返す
   */
  private async loadFrameAsRawPixels(
    framePath: string
  ): Promise<{ data: Buffer; width: number; height: number }> {
    const { data, info } = await sharp(framePath)
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    return { data, width: info.width, height: info.height };
  }

  /**
   * 2フレーム間の差分を分析
   */
  private async analyzeFramePair(
    frame1Path: string,
    frame2Path: string,
    diffThreshold: number,
    clsThreshold: number
  ): Promise<FramePairAnalysis | null> {
    const [img1, img2] = await Promise.all([
      this.loadFrameAsRawPixels(frame1Path),
      this.loadFrameAsRawPixels(frame2Path),
    ]);

    // サイズ不一致チェック
    if (img1.width !== img2.width || img1.height !== img2.height) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(
          `[FrameImageAnalyzerAdapter] Dimension mismatch: ${frame1Path} vs ${frame2Path}`
        );
      }
      return null;
    }

    const { width, height } = img1;
    const diffBuffer = Buffer.alloc(width * height * 4);

    // Pixelmatchで差分計算
    const diffPixels = pixelmatch(
      img1.data,
      img2.data,
      diffBuffer,
      width,
      height,
      { threshold: 0.1 }
    );

    const totalPixels = width * height;
    const diffPercentage = (diffPixels / totalPixels) * 100;

    // 差分領域からモーション分析
    const motion = this.analyzeMotionFromDiff(diffBuffer, width, height, clsThreshold);

    return {
      frame1: path.basename(frame1Path),
      frame2: path.basename(frame2Path),
      width,
      height,
      diffPixels,
      totalPixels,
      diffPercentage: diffPercentage.toFixed(2),
      significantChange: diffPercentage > diffThreshold * 100,
      motion,
    };
  }

  /**
   * 差分バッファからモーション情報を抽出
   */
  private analyzeMotionFromDiff(
    diffBuffer: Buffer,
    width: number,
    height: number,
    clsThreshold: number
  ): MotionAnalysis {
    // 変化ピクセルの境界ボックスを計算
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let changedPixelCount = 0;
    let sumX = 0;
    let sumY = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        // Pixelmatchは差分ピクセルを赤(255,0,0)等でマークする
        const r = diffBuffer[idx] ?? 0;
        const g = diffBuffer[idx + 1] ?? 0;
        const b = diffBuffer[idx + 2] ?? 0;

        if (r > 0 || g > 0 || b > 0) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          changedPixelCount++;
          sumX += x;
          sumY += y;
        }
      }
    }

    if (changedPixelCount === 0) {
      return {
        detected: false,
        boundingBox: null,
        centroid: null,
        area: 0,
        areaPercentage: '0.00',
        impactFraction: '0.0000',
        isLayoutShift: false,
      };
    }

    const boundingBox: BoundingBox = {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };

    const centroid = {
      x: Math.round(sumX / changedPixelCount),
      y: Math.round(sumY / changedPixelCount),
    };

    // CLSライクな影響スコア計算
    const viewportArea = width * height;
    const changedArea = boundingBox.width * boundingBox.height;
    const impactFraction = changedArea / viewportArea;

    return {
      detected: true,
      boundingBox,
      centroid,
      area: changedPixelCount,
      areaPercentage: ((changedPixelCount / viewportArea) * 100).toFixed(2),
      impactFraction: impactFraction.toFixed(4),
      isLayoutShift: impactFraction > clsThreshold,
    };
  }

  /**
   * 連続フレーム間のモーションベクトルを推定
   */
  private estimateMotionVector(
    prevAnalysis: FramePairAnalysis,
    currAnalysis: FramePairAnalysis,
    motionThreshold: number
  ): { dx: number; dy: number; magnitude: string; direction: MotionDirection; angle: string } | null {
    if (!prevAnalysis.motion.detected || !currAnalysis.motion.detected) {
      return null;
    }

    const prev = prevAnalysis.motion.centroid;
    const curr = currAnalysis.motion.centroid;

    if (!prev || !curr) {
      return null;
    }

    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const magnitude = Math.sqrt(dx * dx + dy * dy);

    if (magnitude < motionThreshold) {
      return null;
    }

    // 方向を判定
    let direction: MotionDirection = 'stationary';
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    if (magnitude >= motionThreshold) {
      if (angle >= -45 && angle < 45) direction = 'right';
      else if (angle >= 45 && angle < 135) direction = 'down';
      else if (angle >= -135 && angle < -45) direction = 'up';
      else direction = 'left';
    }

    return {
      dx,
      dy,
      magnitude: magnitude.toFixed(2),
      direction,
      angle: angle.toFixed(2),
    };
  }

  /**
   * アニメーションゾーンを検出
   * 連続した有意な変化を持つフレーム範囲をグループ化
   */
  private detectAnimationZones(
    results: FramePairAnalysis[],
    scrollPxPerFrame: number,
    sampleInterval: number
  ): AnimationZone[] {
    const zones: AnimationZone[] = [];
    let currentZone: {
      frameStart: string;
      scrollStart: number;
      diffs: number[];
      frameEnd?: string;
      scrollEnd?: number;
    } | null = null;

    const ZONE_THRESHOLD = 1.0; // 1% 差分でアニメーション検出

    for (const result of results) {
      const diff = parseFloat(result.diffPercentage);
      const frameMatch = result.frame1.match(/frame-(\d+)/);
      const frameNumStr = frameMatch?.[1];
      const frameNum = frameNumStr ? parseInt(frameNumStr, 10) : 0;
      const scrollPos = frameNum * scrollPxPerFrame;

      if (diff > ZONE_THRESHOLD) {
        if (!currentZone) {
          currentZone = {
            frameStart: result.frame1,
            scrollStart: scrollPos,
            diffs: [diff],
          };
        } else {
          currentZone.diffs.push(diff);
        }
        currentZone.frameEnd = result.frame2;
        currentZone.scrollEnd = scrollPos + sampleInterval * scrollPxPerFrame;
      } else if (currentZone) {
        // ゾーン終了
        zones.push(this.finalizeZone(currentZone));
        currentZone = null;
      }
    }

    // 最後のゾーン処理
    if (currentZone) {
      zones.push(this.finalizeZone(currentZone));
    }

    return zones;
  }

  /**
   * アニメーションゾーンを確定
   */
  private finalizeZone(zone: {
    frameStart: string;
    scrollStart: number;
    diffs: number[];
    frameEnd?: string;
    scrollEnd?: number;
  }): AnimationZone {
    const avgDiff = zone.diffs.reduce((a, b) => a + b, 0) / zone.diffs.length;
    const peakDiff = Math.max(...zone.diffs);
    const duration = (zone.scrollEnd ?? zone.scrollStart) - zone.scrollStart;

    return {
      frameStart: zone.frameStart,
      frameEnd: zone.frameEnd ?? zone.frameStart,
      scrollStart: zone.scrollStart,
      scrollEnd: zone.scrollEnd ?? zone.scrollStart,
      duration,
      avgDiff: avgDiff.toFixed(2),
      peakDiff: peakDiff.toFixed(2),
      animationType: this.classifyAnimation(duration),
    };
  }

  /**
   * アニメーションタイプを分類
   * スクロール距離に基づく
   */
  private classifyAnimation(duration: number): AnimationType {
    if (duration < 500) return 'micro-interaction';
    if (duration < 1500) return 'fade/slide transition';
    if (duration < 3000) return 'scroll-linked animation';
    return 'long-form reveal';
  }

  /**
   * フレーム名からフレーム番号を抽出
   */
  private extractFrameNumber(frameName: string): number {
    const match = frameName.match(/frame-(\d+)/);
    const numStr = match?.[1];
    return numStr ? parseInt(numStr, 10) : 0;
  }
}

// ============================================================================
// ファクトリ関数
// ============================================================================

/**
 * FrameImageAnalyzerAdapterインスタンスを作成
 */
export function createFrameImageAnalyzerAdapter(): FrameImageAnalyzerAdapter {
  return new FrameImageAnalyzerAdapter();
}

// ============================================================================
// デフォルトエクスポート
// ============================================================================

export default FrameImageAnalyzerAdapter;
