// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect DI (Dependency Injection) ファクトリ
 *
 * サービスファクトリとインターフェースを管理するモジュール。
 * テスト時のモック差し替えを容易にするためのDIパターンを実装。
 *
 * @module tools/motion/di-factories
 */

import type { Page } from "playwright";
import { createDIFactory } from "../../utils/di-factory";
import { logger, isDevelopment } from "../../utils/logger";
import type { MotionPattern, LighthouseMetrics } from "./schemas";
import type { MotionPatternPersistenceService } from "../../services/motion-persistence.service";
import { getMotionPersistenceService } from "../../services/motion-persistence.service";
import type { RecordOptions, RecordResult } from "../../services/page/video-recorder.service";
import { VideoRecorderService } from "../../services/page/video-recorder.service";
import type {
  ExtractOptions,
  ExtractResult,
  AnalyzeOptions,
  AnalyzeResult,
} from "../../services/page/frame-analyzer.service";
import { FrameAnalyzerService } from "../../services/page/frame-analyzer.service";
import type {
  RuntimeAnimationResult,
  RuntimeAnimationOptions,
} from "../../services/page/runtime-animation-detector.service";
import { RuntimeAnimationDetectorService } from "../../services/page/runtime-animation-detector.service";
import type {
  FrameCaptureServiceOptions,
  FrameCaptureServiceResult,
} from "../../services/motion/frame-capture.service";
import { createFrameCaptureService } from "../../services/motion/frame-capture.service";
import { createFrameImageAnalyzerAdapter } from "../../services/motion/frame-image-analyzer.adapter";
import {
  getFrameEmbeddingService,
  type SaveFrameAnalysisInput,
  type SavedFrameAnalysisResult,
} from "../../services/motion/frame-embedding.service";
import type {
  JSAnimationResult,
  JSAnimationDetectOptions,
} from "../../services/motion/js-animation-detector";
import { createJSAnimationDetector } from "../../services/motion/js-animation-detector";
import type { IWebPageService, FindOrCreateResult } from "../../services/web-page.service";
import { createWebPageService } from "../../services/web-page.service";

// =====================================================
// 型定義
// =====================================================

/**
 * 検出結果インターフェース
 */
export interface DetectionResult {
  patterns: MotionPattern[];
  warnings: MotionWarning[];
  summary?: Partial<MotionSummary>;
  runtime_info?: RuntimeInfo;
}

/**
 * MotionWarning型（schemasからimportできない場合の型定義）
 */
export interface MotionWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  context?: Record<string, unknown> | undefined;
  suggestion?: string | undefined;
}

/**
 * MotionSummary型
 */
export interface MotionSummary {
  totalPatterns: number;
  byType: Record<string, number>;
  byTrigger: Record<string, number>;
  byCategory: Record<string, number>;
  averageDuration: number;
  hasInfiniteAnimations: boolean;
  complexityScore: number;
}

/**
 * RuntimeInfo型
 */
export interface RuntimeInfo {
  wait_time_used: number;
  animations_captured: number;
  scroll_positions_checked?: number[] | undefined;
  patterns_by_scroll_position?: Record<string, number> | undefined;
  total_scroll_patterns?: number | undefined;
}

/**
 * 検出オプション
 */
export interface DetectOptions {
  includeInlineStyles: boolean;
  includeStyleSheets: boolean;
  minDuration: number;
  maxPatterns: number;
  verbose: boolean;
}

// =====================================================
// サービスインターフェース
// =====================================================

/**
 * モーション検出サービスインターフェース
 */
export interface IMotionDetectService {
  getPageById?: (
    id: string
  ) => Promise<{ id: string; htmlContent: string; cssContent?: string } | null>;
  detect?: (
    html: string,
    css?: string,
    options?: DetectOptions
  ) => DetectionResult | Promise<DetectionResult>;
}

/**
 * VideoRecorderServiceインターフェース
 */
export interface IVideoRecorderService {
  record: (url: string, options?: RecordOptions) => Promise<RecordResult>;
  cleanup: (videoPath: string) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * FrameAnalyzerServiceインターフェース
 */
export interface IFrameAnalyzerService {
  extractFrames: (videoPath: string, options?: ExtractOptions) => Promise<ExtractResult>;
  analyzeMotion: (extractResult: ExtractResult, options?: AnalyzeOptions) => Promise<AnalyzeResult>;
  analyze?: (videoPath: string, options?: AnalyzeOptions) => Promise<AnalyzeResult>;
  cleanup: (extractResult: ExtractResult) => Promise<void>;
}

/**
 * RuntimeAnimationDetectorServiceインターフェース
 */
export interface IRuntimeAnimationDetectorService {
  detect: (page: Page, options?: RuntimeAnimationOptions) => Promise<RuntimeAnimationResult>;
}

/**
 * FrameCaptureServiceインターフェース
 */
export interface IFrameCaptureService {
  capture: (page: Page, options: FrameCaptureServiceOptions) => Promise<FrameCaptureServiceResult>;
}

/**
 * Lighthouse検出結果の詳細型
 */
export interface LighthouseDetailedResult {
  metrics: {
    fcp: number;
    lcp: number;
    cls: number;
    tbt: number;
    si: number;
    tti: number;
    performance_score: number;
    fetched_at: string;
  };
  audits: Record<
    string,
    {
      score: number;
      numericValue: number;
      displayValue: string;
    }
  >;
  processingTimeMs: number;
  rawReport: unknown | null;
}

/**
 * LighthouseDetectorServiceインターフェース
 */
export interface ILighthouseDetectorService {
  analyze: (
    url: string,
    options?: {
      categories?: string[];
      throttling?: boolean;
      timeout?: number;
    }
  ) => Promise<LighthouseDetailedResult>;
  isAvailable: () => Promise<boolean>;
}

/**
 * AnimationMetricsCollectorインターフェース
 */
export interface IAnimationMetricsCollector {
  analyze: (input: {
    patterns: MotionPattern[];
    lighthouseMetrics: LighthouseMetrics | null;
  }) => Promise<{
    patternImpacts: Array<{
      patternId: string;
      patternName: string;
      score: number;
      impactLevel: "high" | "medium" | "low";
      factors: string[];
    }>;
    overallScore: number;
    clsContributors: Array<{
      patternId: string;
      patternName: string;
      estimatedContribution: number;
      reason: string;
    }>;
    layoutTriggeringProperties: string[];
    recommendations: Array<{
      priority: "high" | "medium" | "low";
      category: string;
      description: string;
      affectedPatternIds: string[];
      estimatedImprovement?: string;
    }>;
    lighthouseAvailable: boolean;
    analyzedAt: string;
  }>;
}

/**
 * Frame Image Analysis出力型
 */
export interface FrameImageAnalysisOutput {
  metadata: {
    /** フレームディレクトリパス */
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
  animationZones: Array<{
    frameStart: string;
    frameEnd: string;
    scrollStart: number;
    scrollEnd: number;
    duration: number;
    avgDiff: string;
    peakDiff: string;
    animationType:
      | "micro-interaction"
      | "fade/slide transition"
      | "scroll-linked animation"
      | "long-form reveal";
  }>;
  layoutShifts: Array<{
    frameRange: string;
    scrollRange: string;
    impactFraction: string;
    boundingBox: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  motionVectors: Array<{
    frameRange: string;
    dx: number;
    dy: number;
    magnitude: string;
    direction: "up" | "down" | "left" | "right" | "stationary";
    angle: string;
  }>;
}

/**
 * FrameImageAnalysisServiceインターフェース
 */
export interface IFrameImageAnalysisService {
  analyze: (
    frameDir: string,
    options?: {
      sampleInterval?: number;
      diffThreshold?: number;
      clsThreshold?: number;
      motionThreshold?: number;
      outputDiffImages?: boolean;
      parallel?: boolean;
      scrollPxPerFrame?: number;
      /**
       * 分析対象のフレーム数上限
       * FrameCaptureServiceからキャプチャされたフレーム数を渡すことで、
       * 古いフレームと混在することを防ぐ
       */
      maxFrames?: number;
    }
  ) => Promise<FrameImageAnalysisOutput>;
  isAvailable: () => boolean;
  dispose: () => Promise<void>;
}

/**
 * FrameEmbeddingServiceインターフェース
 */
export interface IFrameEmbeddingService {
  saveFrameAnalysis: (input: SaveFrameAnalysisInput) => Promise<SavedFrameAnalysisResult>;
  isAvailable: () => boolean;
}

/**
 * JSAnimationDetectorServiceインターフェース
 * CDP + Web Animations API + ライブラリ検出の統合サービス
 */
export interface IJSAnimationDetectorService {
  detect: (page: Page, options?: JSAnimationDetectOptions) => Promise<JSAnimationResult>;
  cleanup: () => Promise<void>;
}

// Re-export types for consumers
export type { SaveFrameAnalysisInput, SavedFrameAnalysisResult };
export type { JSAnimationResult, JSAnimationDetectOptions };
export type { IWebPageService, FindOrCreateResult };

// =====================================================
// ファクトリ変数
// =====================================================

const serviceFactoryDI = createDIFactory<IMotionDetectService>("MotionDetectService");
const persistenceServiceDI = createDIFactory<MotionPatternPersistenceService>(
  "MotionPersistenceService"
);
const videoRecorderServiceDI = createDIFactory<IVideoRecorderService>("VideoRecorderService");
const frameAnalyzerServiceDI = createDIFactory<IFrameAnalyzerService>("FrameAnalyzerService");
const runtimeAnimationDetectorDI = createDIFactory<IRuntimeAnimationDetectorService>(
  "RuntimeAnimationDetector"
);
const frameCaptureServiceDI = createDIFactory<IFrameCaptureService>("FrameCaptureService");
const lighthouseDetectorServiceDI = createDIFactory<ILighthouseDetectorService>(
  "LighthouseDetectorService"
);
const animationMetricsCollectorDI = createDIFactory<IAnimationMetricsCollector>(
  "AnimationMetricsCollector"
);
const frameImageAnalysisServiceDI = createDIFactory<IFrameImageAnalysisService>(
  "FrameImageAnalysisService"
);
const frameEmbeddingServiceDI = createDIFactory<IFrameEmbeddingService>("FrameEmbeddingService");
const jsAnimationDetectorDI = createDIFactory<IJSAnimationDetectorService>("JSAnimationDetector");
const webPageServiceDI = createDIFactory<IWebPageService>("WebPageService");

// =====================================================
// Motion Detect Service
// =====================================================

export const setMotionDetectServiceFactory = serviceFactoryDI.set;
export const resetMotionDetectServiceFactory = serviceFactoryDI.reset;
export const getMotionDetectServiceFactory = serviceFactoryDI.get;

// =====================================================
// Persistence Service
// =====================================================

export function setMotionPersistenceServiceFactory(
  factory: () => MotionPatternPersistenceService
): void {
  persistenceServiceDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect persistence service factory SET", {
      factoryExists: factory !== null,
    });
  }
}

export const resetMotionPersistenceServiceFactory = persistenceServiceDI.reset;

export function getPersistenceService(): MotionPatternPersistenceService | null {
  if (persistenceServiceDI.get()) {
    try {
      const service = persistenceServiceDI.get()!();
      if (isDevelopment()) {
        logger.debug("[DI] motion.detect factory returned service", {
          isAvailable: service?.isAvailable?.() ?? false,
        });
      }
      return service;
    } catch (error) {
      if (isDevelopment()) {
        logger.error("[DI] motion.detect factory error", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
      return null;
    }
  }
  // デフォルトサービスを試す
  try {
    const service = getMotionPersistenceService();
    if (service.isAvailable()) {
      return service;
    }
  } catch {
    if (isDevelopment()) {
      logger.debug("[DI] motion.detect persistence service not available");
    }
  }
  return null;
}

export function getPersistenceServiceFactoryExists(): boolean {
  return persistenceServiceDI.get() !== null;
}

// =====================================================
// Video Recorder Service
// =====================================================

export function setVideoRecorderServiceFactory(factory: () => IVideoRecorderService): void {
  videoRecorderServiceDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect video recorder factory SET");
  }
}

export const resetVideoRecorderServiceFactory = videoRecorderServiceDI.reset;

export function getVideoRecorderService(): IVideoRecorderService {
  if (videoRecorderServiceDI.get()) {
    return videoRecorderServiceDI.get()!();
  }
  return new VideoRecorderService();
}

// =====================================================
// Frame Analyzer Service
// =====================================================

export function setFrameAnalyzerServiceFactory(factory: () => IFrameAnalyzerService): void {
  frameAnalyzerServiceDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect frame analyzer factory SET");
  }
}

export const resetFrameAnalyzerServiceFactory = frameAnalyzerServiceDI.reset;

export function getFrameAnalyzerService(): IFrameAnalyzerService {
  if (frameAnalyzerServiceDI.get()) {
    return frameAnalyzerServiceDI.get()!();
  }
  return new FrameAnalyzerService();
}

// =====================================================
// Runtime Animation Detector Service
// =====================================================

export function setRuntimeAnimationDetectorFactory(
  factory: () => IRuntimeAnimationDetectorService
): void {
  runtimeAnimationDetectorDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect runtime animation detector factory SET");
  }
}

export const resetRuntimeAnimationDetectorFactory = runtimeAnimationDetectorDI.reset;

export function getRuntimeAnimationDetectorService(): IRuntimeAnimationDetectorService {
  if (runtimeAnimationDetectorDI.get()) {
    return runtimeAnimationDetectorDI.get()!();
  }
  return new RuntimeAnimationDetectorService();
}

// =====================================================
// Frame Capture Service
// =====================================================

export function setFrameCaptureServiceFactory(factory: () => IFrameCaptureService): void {
  frameCaptureServiceDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect frame capture service factory SET");
  }
}

export const resetFrameCaptureServiceFactory = frameCaptureServiceDI.reset;

export function getFrameCaptureServiceInstance(): IFrameCaptureService {
  if (frameCaptureServiceDI.get()) {
    return frameCaptureServiceDI.get()!();
  }
  return createFrameCaptureService();
}

// =====================================================
// Lighthouse Detector Service
// =====================================================

export function setLighthouseDetectorServiceFactory(
  factory: () => ILighthouseDetectorService
): void {
  lighthouseDetectorServiceDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect lighthouse detector factory SET");
  }
}

export const resetLighthouseDetectorServiceFactory = lighthouseDetectorServiceDI.reset;

export function getLighthouseDetectorService(): ILighthouseDetectorService | null {
  if (lighthouseDetectorServiceDI.get()) {
    return lighthouseDetectorServiceDI.get()!();
  }
  return null;
}

// =====================================================
// Animation Metrics Collector
// =====================================================

export function setAnimationMetricsCollectorFactory(
  factory: () => IAnimationMetricsCollector
): void {
  animationMetricsCollectorDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect animation metrics collector factory SET");
  }
}

export const resetAnimationMetricsCollectorFactory = animationMetricsCollectorDI.reset;

export function getAnimationMetricsCollector(): IAnimationMetricsCollector | null {
  if (animationMetricsCollectorDI.get()) {
    return animationMetricsCollectorDI.get()!();
  }
  return null;
}

// =====================================================
// Frame Image Analysis Service
// =====================================================

export function setFrameImageAnalysisServiceFactory(
  factory: () => IFrameImageAnalysisService
): void {
  frameImageAnalysisServiceDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect frame image analysis factory SET");
  }
}

export const resetFrameImageAnalysisServiceFactory = frameImageAnalysisServiceDI.reset;

export function getFrameImageAnalysisService(): IFrameImageAnalysisService | null {
  if (frameImageAnalysisServiceDI.get()) {
    return frameImageAnalysisServiceDI.get()!();
  }

  // デフォルト実装: FrameImageAnalyzerAdapter を使用
  const adapter = createFrameImageAnalyzerAdapter();

  return {
    async analyze(
      frameDir: string,
      options?: {
        sampleInterval?: number;
        diffThreshold?: number;
        clsThreshold?: number;
        motionThreshold?: number;
        outputDiffImages?: boolean;
        parallel?: boolean;
        scrollPxPerFrame?: number;
        /**
         * 分析対象のフレーム数上限
         * FrameCaptureServiceからキャプチャされたフレーム数を渡すことで、
         * 古いフレームと混在することを防ぐ
         */
        maxFrames?: number;
      }
    ): Promise<FrameImageAnalysisOutput> {
      const result = await adapter.analyze(frameDir, options);

      return {
        metadata: {
          framesDir: result.metadata.framesDir,
          totalFrames: result.metadata.totalFrames,
          analyzedPairs: result.metadata.analyzedPairs,
          sampleInterval: result.metadata.sampleInterval,
          scrollPxPerFrame: result.metadata.scrollPxPerFrame,
          analysisTime: result.metadata.analysisTime,
          analyzedAt: result.metadata.analyzedAt,
        },
        statistics: result.statistics,
        animationZones: result.animationZones,
        layoutShifts: result.layoutShifts,
        motionVectors: result.motionVectors,
      };
    },
    isAvailable(): boolean {
      return adapter.isAvailable();
    },
    async dispose(): Promise<void> {
      return adapter.dispose();
    },
  };
}

// =====================================================
// Frame Embedding Service
// =====================================================

export function setFrameEmbeddingServiceFactory(factory: () => IFrameEmbeddingService): void {
  frameEmbeddingServiceDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect frame embedding service factory SET");
  }
}

export const resetFrameEmbeddingServiceFactory = frameEmbeddingServiceDI.reset;

export function getFrameEmbeddingServiceInstance(): IFrameEmbeddingService | null {
  if (frameEmbeddingServiceDI.get()) {
    return frameEmbeddingServiceDI.get()!();
  }

  // デフォルト実装: FrameEmbeddingService を使用
  try {
    const service = getFrameEmbeddingService();
    if (service.isAvailable()) {
      return service;
    }
  } catch {
    if (isDevelopment()) {
      logger.debug("[DI] motion.detect frame embedding service not available");
    }
  }
  return null;
}

// =====================================================
// JS Animation Detector Service (v0.1.0)
// =====================================================

export function setJSAnimationDetectorFactory(factory: () => IJSAnimationDetectorService): void {
  jsAnimationDetectorDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect JS animation detector factory SET");
  }
}

export const resetJSAnimationDetectorFactory = jsAnimationDetectorDI.reset;

export function getJSAnimationDetectorService(): IJSAnimationDetectorService {
  if (jsAnimationDetectorDI.get()) {
    return jsAnimationDetectorDI.get()!();
  }
  // デフォルト実装: JSAnimationDetectorService を使用
  return createJSAnimationDetector();
}

// =====================================================
// WebPage Service (v0.1.0)
// URL mode でWebPage自動作成・web_page_idセット用
// =====================================================

export function setWebPageServiceFactory(factory: () => IWebPageService): void {
  webPageServiceDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect WebPage service factory SET");
  }
}

export const resetWebPageServiceFactory = webPageServiceDI.reset;

export function getWebPageService(): IWebPageService {
  if (webPageServiceDI.get()) {
    return webPageServiceDI.get()!();
  }
  // デフォルト実装: WebPageService を使用
  return createWebPageService();
}

// =====================================================
// JS Animation Persistence Prisma Client (v0.1.0)
// JSアニメーションDB保存用のPrismaClientファクトリ
// page.analyze と共有する IPageAnalyzePrismaClient を使用
// =====================================================

const jsAnimationPrismaClientDI = createDIFactory<IJSAnimationPersistencePrismaClient>(
  "JSAnimationPersistencePrismaClient"
);

/**
 * JSAnimation Persistence用PrismaClientインターフェース
 * page/handlers/types.ts の IPageAnalyzePrismaClient と互換
 */
export interface IJSAnimationPersistencePrismaClient {
  jSAnimationPattern: {
    createMany: (args: { data: unknown[]; skipDuplicates?: boolean }) => Promise<{ count: number }>;
    deleteMany: (args: { where: { webPageId: string } }) => Promise<{ count: number }>;
    findMany: (args: { where: { webPageId: string } }) => Promise<Array<{ id: string }>>;
  };
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $transaction: <T>(
    fn: (tx: IJSAnimationPersistencePrismaClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
    }
  ) => Promise<T>;
}

export function setJSAnimationPersistencePrismaClientFactory(
  factory: () => IJSAnimationPersistencePrismaClient
): void {
  jsAnimationPrismaClientDI.set(factory);
  if (isDevelopment()) {
    logger.info("[DI] motion.detect JS animation persistence prisma factory SET");
  }
}

export const resetJSAnimationPersistencePrismaClientFactory = jsAnimationPrismaClientDI.reset;

export function getJSAnimationPersistencePrismaClient(): IJSAnimationPersistencePrismaClient | null {
  if (jsAnimationPrismaClientDI.get()) {
    return jsAnimationPrismaClientDI.get()!();
  }
  return null;
}
