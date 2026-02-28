// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGLAnimationDetectorService
 *
 * 既存のフレームキャプチャとフレーム差分分析を活用して、
 * WebGLアニメーションを検出・分析するサービス
 *
 * 機能:
 * - canvas要素のスクリーンショットベースのアニメーション検出
 * - フレーム差分分析によるアニメーションパターン特定
 * - アニメーションカテゴリ分類（fade, pulse, wave, particle, rotation, parallax, noise, complex）
 * - WebGLライブラリ検出との連携
 *
 * @module services/motion/webgl-animation-detector.service
 */

import type { Page } from 'playwright';
import { createLogger, isDevelopment } from '../../utils/logger';
import { FrameCaptureService } from './frame-capture.service';
import { FrameImageAnalysisService } from './frame-image-analysis.service';
import type { FrameAnalysisResult, DiffAnalysisSummary } from './types';
import {
  WebGLMotionAnalyzer,
  type WebGLMotionAnalysisResult,
} from './analyzers/webgl-motion-analyzer';
import {
  WebGLAnimationCategorizer,
  type WebGLAnimationCategory,
  type CategorizationResult,
} from './webgl-animation-categorizer';
import { WebGLDetectorService, type WebGLDetectionResult } from '../page/webgl-detector.service';

// =====================================================
// 型定義
// =====================================================

/**
 * WebGLアニメーション検出オプション
 */
export interface WebGLAnimationDetectionOptions {
  /** サンプリングフレーム数。デフォルト: 20 */
  sampleFrames?: number;
  /** サンプリング間隔 (ms)。デフォルト: 100 */
  sampleIntervalMs?: number;
  /** 変化検出閾値 (0-1)。デフォルト: 0.01 (1%) */
  changeThreshold?: number;
  /** タイムアウト (ms)。デフォルト: 30000 */
  timeoutMs?: number;
  /** DB保存フラグ。デフォルト: true */
  saveToDb?: boolean;
  /** 出力ディレクトリ（一時ファイル用）。デフォルト: /tmp/reftrix-webgl-frames/ */
  outputDir?: string;
  /** WebGL検出結果（既に検出済みの場合）*/
  webglDetection?: WebGLDetectionResult;
}

/**
 * ビジュアル特徴
 */
export interface VisualFeatures {
  /** 平均変化率 (0-1) */
  avgChangeRatio: number;
  /** 最大変化率 (0-1) */
  maxChangeRatio: number;
  /** 最小変化率 (0-1) */
  minChangeRatio: number;
  /** 標準偏差 */
  stdDeviation: number;
  /** 周期性スコア (0-1) */
  periodicityScore: number;
  /** 推定周期（ミリ秒）*/
  estimatedPeriodMs: number;
  /** 動的フレームの割合 (0-1) */
  dynamicFrameRatio: number;
}

/**
 * フレーム分析結果
 */
export interface FrameAnalysisResultData {
  /** 分析されたフレーム数 */
  frameCount: number;
  /** 差分分析サマリー */
  diffSummary: DiffAnalysisSummary;
  /** 変化率の時系列データ */
  changeRatioTimeSeries: number[];
  /** モーション分析結果 */
  motionAnalysis: WebGLMotionAnalysisResult;
}

/**
 * WebGLアニメーションパターンデータ
 */
export interface WebGLAnimationPatternData {
  /** パターン名（自動生成）*/
  name: string;
  /** カテゴリ */
  category: WebGLAnimationCategory;
  /** 説明 */
  description: string;
  /** canvas要素のセレクタ */
  canvasSelector: string;
  /** canvas幅 */
  canvasWidth: number;
  /** canvas高さ */
  canvasHeight: number;
  /** WebGLバージョン (1 or 2) */
  webglVersion: number;
  /** 検出されたライブラリ */
  detectedLibraries: string[];
  /** フレーム分析結果 */
  frameAnalysis: FrameAnalysisResultData;
  /** ビジュアル特徴 */
  visualFeatures: VisualFeatures;
  /** 信頼度 (0-1) */
  confidence: number;
}

/**
 * WebGLアニメーション検出結果
 */
export interface WebGLAnimationDetectionResult {
  /** 検出されたパターン */
  patterns: WebGLAnimationPatternData[];
  /** サマリー */
  summary: {
    /** パターン総数 */
    totalPatterns: number;
    /** カテゴリ別カウント */
    categories: Record<string, number>;
    /** 平均変化率 */
    avgChangeRatio: number;
    /** 検出処理時間 (ms) */
    detectionTimeMs: number;
  };
  /** 警告メッセージ */
  warnings?: string[];
}

// =====================================================
// 定数
// =====================================================

const logger = createLogger('WebGLAnimationDetector');

/** デフォルトオプション */
const DEFAULT_OPTIONS: Required<Omit<WebGLAnimationDetectionOptions, 'webglDetection'>> = {
  sampleFrames: 20,
  sampleIntervalMs: 100,
  changeThreshold: 0.01,
  timeoutMs: 30000,
  saveToDb: true,
  outputDir: '/tmp/reftrix-webgl-frames/',
};

// =====================================================
// WebGLAnimationDetectorService クラス
// =====================================================

/**
 * WebGLアニメーション検出サービス
 *
 * Playwrightを使用してcanvas要素のスクリーンショットを取得し、
 * フレーム差分分析によりアニメーションパターンを検出します。
 */
export class WebGLAnimationDetectorService {
  private frameCaptureService: FrameCaptureService | null = null;
  private frameAnalysisService: FrameImageAnalysisService | null = null;
  private motionAnalyzer: WebGLMotionAnalyzer | null = null;
  private categorizer: WebGLAnimationCategorizer | null = null;
  private webglDetector: WebGLDetectorService | null = null;

  constructor() {
    if (isDevelopment()) {
      logger.debug('[WebGLAnimationDetector] Initialized');
    }
  }

  /**
   * WebGLアニメーションを検出
   *
   * @param page - Playwrightページオブジェクト
   * @param options - 検出オプション
   * @returns 検出結果
   */
  async detect(
    page: Page,
    options?: WebGLAnimationDetectionOptions
  ): Promise<WebGLAnimationDetectionResult> {
    const startTime = Date.now();
    const opts = this.mergeOptions(options);
    const warnings: string[] = [];

    try {
      if (isDevelopment()) {
        logger.debug('[WebGLAnimationDetector] Starting detection', {
          sampleFrames: opts.sampleFrames,
          sampleIntervalMs: opts.sampleIntervalMs,
          changeThreshold: opts.changeThreshold,
        });
      }

      // サービスの遅延初期化
      this.ensureServicesInitialized();

      // WebGL検出（既存の結果がなければ実行）
      const webglDetection =
        options?.webglDetection ?? (await this.webglDetector!.detect(page));

      if (!webglDetection.hasCanvas) {
        return this.createEmptyResult(startTime, ['No canvas elements found on page']);
      }

      // canvas要素の情報を取得
      const canvasInfos = await this.getCanvasInfos(page);

      if (canvasInfos.length === 0) {
        return this.createEmptyResult(startTime, ['No valid canvas elements found']);
      }

      // 各canvasに対してアニメーション検出を実行
      const patterns: WebGLAnimationPatternData[] = [];

      for (let i = 0; i < canvasInfos.length; i++) {
        const canvasInfo = canvasInfos[i];
        if (!canvasInfo) continue;

        // タイムアウトチェック
        if (Date.now() - startTime > opts.timeoutMs) {
          warnings.push(`Detection timeout reached after processing ${i} canvases`);
          break;
        }

        try {
          const pattern = await this.detectCanvasAnimation(
            page,
            canvasInfo,
            webglDetection,
            opts,
            i
          );

          if (pattern) {
            patterns.push(pattern);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          warnings.push(`Failed to detect animation for canvas ${i}: ${message}`);
          if (isDevelopment()) {
            logger.warn('[WebGLAnimationDetector] Canvas detection failed', {
              canvasIndex: i,
              error: message,
            });
          }
        }
      }

      // サマリーを計算
      const summary = this.calculateSummary(patterns, startTime);

      if (isDevelopment()) {
        logger.info('[WebGLAnimationDetector] Detection complete', {
          totalPatterns: patterns.length,
          detectionTimeMs: summary.detectionTimeMs,
        });
      }

      const result: WebGLAnimationDetectionResult = {
        patterns,
        summary,
      };

      if (warnings.length > 0) {
        result.warnings = warnings;
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (isDevelopment()) {
        logger.error('[WebGLAnimationDetector] Detection failed', { error: message });
      }
      return this.createEmptyResult(startTime, [`Detection failed: ${message}`]);
    }
  }

  /**
   * リソースをクリーンアップ
   */
  async cleanup(): Promise<void> {
    if (this.frameAnalysisService) {
      await this.frameAnalysisService.dispose();
    }

    this.frameCaptureService = null;
    this.frameAnalysisService = null;
    this.motionAnalyzer = null;
    this.categorizer = null;
    this.webglDetector = null;

    if (isDevelopment()) {
      logger.debug('[WebGLAnimationDetector] Cleanup completed');
    }
  }

  // =====================================================
  // プライベートメソッド: 初期化
  // =====================================================

  /**
   * オプションをマージ
   */
  private mergeOptions(
    options?: WebGLAnimationDetectionOptions
  ): Required<Omit<WebGLAnimationDetectionOptions, 'webglDetection'>> {
    return {
      sampleFrames: options?.sampleFrames ?? DEFAULT_OPTIONS.sampleFrames,
      sampleIntervalMs: options?.sampleIntervalMs ?? DEFAULT_OPTIONS.sampleIntervalMs,
      changeThreshold: options?.changeThreshold ?? DEFAULT_OPTIONS.changeThreshold,
      timeoutMs: options?.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
      saveToDb: options?.saveToDb ?? DEFAULT_OPTIONS.saveToDb,
      outputDir: options?.outputDir ?? DEFAULT_OPTIONS.outputDir,
    };
  }

  /**
   * サービスの遅延初期化
   */
  private ensureServicesInitialized(): void {
    if (!this.frameCaptureService) {
      this.frameCaptureService = new FrameCaptureService();
    }
    if (!this.frameAnalysisService) {
      this.frameAnalysisService = new FrameImageAnalysisService();
    }
    if (!this.motionAnalyzer) {
      this.motionAnalyzer = new WebGLMotionAnalyzer();
    }
    if (!this.categorizer) {
      this.categorizer = new WebGLAnimationCategorizer();
    }
    if (!this.webglDetector) {
      this.webglDetector = new WebGLDetectorService();
    }
  }

  // =====================================================
  // プライベートメソッド: canvas情報取得
  // =====================================================

  /**
   * ページ上のcanvas要素の情報を取得
   */
  /* eslint-disable no-undef -- page.evaluate() runs in browser context */
  private async getCanvasInfos(page: Page): Promise<CanvasInfo[]> {
    return page.evaluate(() => {
      const canvases = document.querySelectorAll('canvas');
      const results: Array<{
        selector: string;
        width: number;
        height: number;
        webglVersion: number;
        boundingRect: { x: number; y: number; width: number; height: number };
      }> = [];

      canvases.forEach((canvas, index) => {
        // WebGLコンテキストを確認
        let webglVersion = 0;
        try {
          const gl2 = canvas.getContext('webgl2');
          if (gl2) {
            webglVersion = 2;
          } else {
            const gl1 = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (gl1) {
              webglVersion = 1;
            }
          }
        } catch {
          // コンテキスト取得失敗
        }

        // WebGLコンテキストを持つcanvasのみ
        if (webglVersion > 0) {
          const rect = canvas.getBoundingClientRect();

          // v0.1.0: CSSセレクタサニタイズ - 特殊文字をエスケープ
          // CSS.escape()が利用可能な場合は使用、そうでなければフォールバック
          const escapeCss = (value: string): string => {
            if (typeof CSS !== 'undefined' && CSS.escape) {
              return CSS.escape(value);
            }
            // フォールバック: CSS特殊文字をエスケープ
            return value.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~\s]/g, '\\$&');
          };

          // セレクタを生成（:nth-of-type を優先して安全性を確保）
          let selector = `canvas:nth-of-type(${index + 1})`;
          if (canvas.id) {
            // idが安全な場合のみ使用
            const escapedId = escapeCss(canvas.id);
            if (escapedId && !/[<>]/.test(canvas.id)) {
              selector = `#${escapedId}`;
            }
          } else if (canvas.className && typeof canvas.className === 'string') {
            // classNameが安全な場合のみ使用
            const classes = canvas.className.trim().split(/\s+/).filter(Boolean);
            if (classes.length > 0 && classes.every(c => !/[<>]/.test(c))) {
              const escapedClasses = classes.map(c => escapeCss(c)).join('.');
              selector = `canvas.${escapedClasses}`;
            }
          }

          results.push({
            selector,
            width: canvas.width || canvas.clientWidth,
            height: canvas.height || canvas.clientHeight,
            webglVersion,
            boundingRect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          });
        }
      });

      return results;
    });
  }
  /* eslint-enable no-undef */

  // =====================================================
  // プライベートメソッド: アニメーション検出
  // =====================================================

  /**
   * 単一canvasのアニメーションを検出
   */
  private async detectCanvasAnimation(
    page: Page,
    canvasInfo: CanvasInfo,
    webglDetection: WebGLDetectionResult,
    options: Required<Omit<WebGLAnimationDetectionOptions, 'webglDetection'>>,
    canvasIndex: number
  ): Promise<WebGLAnimationPatternData | null> {
    if (isDevelopment()) {
      logger.debug('[WebGLAnimationDetector] Detecting canvas animation', {
        selector: canvasInfo.selector,
        width: canvasInfo.width,
        height: canvasInfo.height,
      });
    }

    // フレームをキャプチャ（canvas要素のスクリーンショット）
    const frameResult = await this.captureCanvasFrames(
      page,
      canvasInfo,
      options
    );

    if (!frameResult.success || !frameResult.data) {
      if (isDevelopment()) {
        logger.debug('[WebGLAnimationDetector] Frame capture failed or no data', {
          selector: canvasInfo.selector,
          error: frameResult.error,
        });
      }
      return null;
    }

    // changeRatioの時系列を抽出
    const changeRatios = frameResult.data.diffAnalysis?.results.map((r) => r.changeRatio) ?? [];

    if (changeRatios.length < 2) {
      return null;
    }

    // 変化がほとんどない場合はスキップ
    const avgChangeRatio = changeRatios.reduce((a, b) => a + b, 0) / changeRatios.length;
    if (avgChangeRatio < options.changeThreshold) {
      if (isDevelopment()) {
        logger.debug('[WebGLAnimationDetector] Skipping static canvas', {
          selector: canvasInfo.selector,
          avgChangeRatio,
        });
      }
      return null;
    }

    // モーション分析
    const motionAnalysis = this.motionAnalyzer!.analyzeFromRatios(changeRatios);

    // カテゴリ分類
    const categorization = this.categorizer!.categorize(changeRatios);

    // ビジュアル特徴を構築
    const visualFeatures = this.buildVisualFeatures(
      motionAnalysis,
      categorization
    );

    // フレーム分析結果を構築
    const frameAnalysis: FrameAnalysisResultData = {
      frameCount: frameResult.data.totalFrames,
      diffSummary: frameResult.data.diffAnalysis?.summary ?? this.createEmptyDiffSummary(),
      changeRatioTimeSeries: changeRatios,
      motionAnalysis,
    };

    // パターンデータを構築
    const pattern: WebGLAnimationPatternData = {
      name: this.generatePatternName(categorization.category, canvasIndex),
      category: categorization.category,
      description: this.generateDescription(categorization, canvasInfo),
      canvasSelector: canvasInfo.selector,
      canvasWidth: canvasInfo.width,
      canvasHeight: canvasInfo.height,
      webglVersion: canvasInfo.webglVersion,
      detectedLibraries: webglDetection.detectedLibraries,
      frameAnalysis,
      visualFeatures,
      confidence: categorization.confidence,
    };

    return pattern;
  }

  /**
   * canvasのフレームをキャプチャして分析
   */
  private async captureCanvasFrames(
    page: Page,
    canvasInfo: CanvasInfo,
    options: Required<Omit<WebGLAnimationDetectionOptions, 'webglDetection'>>
  ): Promise<FrameAnalysisResult> {
    const framePaths: string[] = [];
    const outputDir = `${options.outputDir}${Date.now()}/`;

    try {
      // canvas要素を取得
      const canvasElement = page.locator(canvasInfo.selector).first();

      // 複数フレームをキャプチャ
      for (let i = 0; i < options.sampleFrames; i++) {
        const framePath = `${outputDir}frame-${String(i).padStart(4, '0')}.png`;

        // canvasのスクリーンショットを取得
        await canvasElement.screenshot({
          path: framePath,
          type: 'png',
        });

        framePaths.push(framePath);

        // インターバル待機
        if (i < options.sampleFrames - 1) {
          await page.waitForTimeout(options.sampleIntervalMs);
        }
      }

      // フレーム分析を実行
      const analysisResult = await this.frameAnalysisService!.analyze({
        framePaths,
        fps: Math.round(1000 / options.sampleIntervalMs),
        analysisOptions: {
          diffAnalysis: true,
          diffThreshold: options.changeThreshold,
          layoutShift: false,
          colorChange: false,
        },
        summary: false,
      });

      return analysisResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          code: 'FRAME_ANALYSIS_INTERNAL_ERROR',
          message: `Frame capture failed: ${message}`,
        },
      };
    }
  }

  // =====================================================
  // プライベートメソッド: 結果構築
  // =====================================================

  /**
   * ビジュアル特徴を構築
   */
  private buildVisualFeatures(
    motionAnalysis: WebGLMotionAnalysisResult,
    categorization: CategorizationResult
  ): VisualFeatures {
    // Categorizerからの特徴を取得（なければ計算値を使用）
    const features = this.extractFeaturesFromScores(categorization);

    return {
      avgChangeRatio: motionAnalysis.statistics.avgChangeRatio,
      maxChangeRatio: motionAnalysis.statistics.maxChangeRatio,
      minChangeRatio: motionAnalysis.statistics.minChangeRatio,
      stdDeviation: motionAnalysis.statistics.stdDeviation,
      periodicityScore: motionAnalysis.periodicity.score,
      estimatedPeriodMs: motionAnalysis.periodicity.estimatedPeriodMs,
      dynamicFrameRatio: features.dynamicFrameRatio,
    };
  }

  /**
   * スコアから特徴を推定
   */
  private extractFeaturesFromScores(categorization: CategorizationResult): { dynamicFrameRatio: number } {
    // 動的フレーム割合を推定（スコアから逆算）
    const fadeScore = categorization.scores.fade;
    const particleScore = categorization.scores.particle;

    // fadeは低活動、particleは高活動
    const dynamicFrameRatio = Math.max(0, Math.min(1, 1 - fadeScore + particleScore * 0.5));

    return { dynamicFrameRatio };
  }

  /**
   * パターン名を生成
   */
  private generatePatternName(category: WebGLAnimationCategory, index: number): string {
    const categoryNames: Record<WebGLAnimationCategory, string> = {
      fade: 'Fade',
      pulse: 'Pulse',
      wave: 'Wave',
      particle: 'Particle',
      rotation: 'Rotation',
      parallax: 'Parallax',
      noise: 'Noise',
      complex: 'Complex',
    };

    return `WebGL ${categoryNames[category]} Animation #${index + 1}`;
  }

  /**
   * 説明を生成
   */
  private generateDescription(
    categorization: CategorizationResult,
    canvasInfo: CanvasInfo
  ): string {
    const categoryDescriptions: Record<WebGLAnimationCategory, string> = {
      fade: 'Gradual opacity or intensity change',
      pulse: 'Rhythmic pulsating effect',
      wave: 'Flowing wave-like motion',
      particle: 'Particle system with scattered motion',
      rotation: 'Rotating or spinning animation',
      parallax: 'Depth-based parallax effect',
      noise: 'Procedural noise animation',
      complex: 'Complex multi-pattern animation',
    };

    const reasons = categorization.reasons.join('. ');

    return `${categoryDescriptions[categorization.category]} on ${canvasInfo.width}x${canvasInfo.height} canvas. ${reasons}`;
  }

  /**
   * サマリーを計算
   */
  private calculateSummary(
    patterns: WebGLAnimationPatternData[],
    startTime: number
  ): WebGLAnimationDetectionResult['summary'] {
    const categories: Record<string, number> = {};

    let totalChangeRatio = 0;
    for (const pattern of patterns) {
      const category = pattern.category;
      categories[category] = (categories[category] ?? 0) + 1;
      totalChangeRatio += pattern.visualFeatures.avgChangeRatio;
    }

    return {
      totalPatterns: patterns.length,
      categories,
      avgChangeRatio: patterns.length > 0 ? totalChangeRatio / patterns.length : 0,
      detectionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 空の結果を作成
   */
  private createEmptyResult(
    startTime: number,
    warnings: string[]
  ): WebGLAnimationDetectionResult {
    return {
      patterns: [],
      summary: {
        totalPatterns: 0,
        categories: {},
        avgChangeRatio: 0,
        detectionTimeMs: Date.now() - startTime,
      },
      warnings,
    };
  }

  /**
   * 空の差分サマリーを作成
   */
  private createEmptyDiffSummary(): DiffAnalysisSummary {
    return {
      avgChangeRatio: 0,
      maxChangeRatio: 0,
      motionFrameCount: 0,
      motionFrameRatio: 0,
    };
  }
}

// =====================================================
// 内部型定義
// =====================================================

/**
 * Canvas要素情報
 */
interface CanvasInfo {
  selector: string;
  width: number;
  height: number;
  webglVersion: number;
  boundingRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// =====================================================
// ファクトリ関数
// =====================================================

/**
 * WebGLAnimationDetectorServiceインスタンスを作成
 */
export function createWebGLAnimationDetectorService(): WebGLAnimationDetectorService {
  return new WebGLAnimationDetectorService();
}

/**
 * シングルトンインスタンス
 */
let instance: WebGLAnimationDetectorService | null = null;

/**
 * シングルトンインスタンスを取得
 */
export function getWebGLAnimationDetectorService(): WebGLAnimationDetectorService {
  if (!instance) {
    instance = new WebGLAnimationDetectorService();
  }
  return instance;
}

/**
 * シングルトンインスタンスをリセット（テスト用）
 */
export function resetWebGLAnimationDetectorService(): void {
  if (instance) {
    instance.cleanup().catch(() => {
      // Cleanup error ignored
    });
  }
  instance = null;
}
