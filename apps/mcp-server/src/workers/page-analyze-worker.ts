// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - BullMQ Worker for Async Page Analysis
 *
 * Phase3-2: Handles heavy page analysis jobs asynchronously.
 * Designed for WebGL-heavy sites (Linear, Vercel, Notion) that may timeout
 * in synchronous processing.
 *
 * Configuration:
 * - concurrency: 1 (singleton browser, avoid race condition)
 * - lockDuration: 2400000ms (40 min, extended for CPU-bound embedding phase), configurable via BULLMQ_LOCK_DURATION
 * - attempts: 1 (no retries for WebGL sites)
 *
 * Lock Extension Strategy (Hybrid Approach):
 * BullMQ v5.x provides automatic lock renewal via lockRenewTime (default: lockDuration/2).
 * However, CPU-bound processing (e.g., Ollama Vision 10.7B) may block the event loop,
 * preventing timer-based renewal. This module adds:
 * 1. createLockExtender: setInterval-based periodic lock extension (secondary protection)
 * 2. extendJobLock: explicit lock extension at async phase boundaries
 * Together they provide dual-layer stall prevention for long-running jobs (30+ minutes).
 *
 * Environment Variables:
 * - BULLMQ_LOCK_DURATION: Lock duration in ms (default: 2400000)
 * - BULLMQ_LOCK_EXTEND_INTERVAL_MS: Lock extend interval in ms (default: 300000)
 *
 * @module workers/page-analyze-worker
 */

import { Worker, type Job } from 'bullmq';
import { createHash } from 'crypto';
import { getRedisConfig, type RedisConfig } from '../config/redis';
import {
  PAGE_ANALYZE_QUEUE_NAME,
  type PageAnalyzeJobData,
  type PageAnalyzeJobResult,
  type AnalysisPhase,
} from '../queues/page-analyze-queue';
import { ExecutionStatusTrackerV2 } from '../tools/page/handlers/execution-status-tracker';
import { logger, isDevelopment } from '../utils/logger';
import { sanitizeHtml } from '../utils/html-sanitizer';
import { normalizeUrlForStorage } from '../utils/url-normalizer';
import { prisma } from '@reftrix/database';

// Service handlers (same as used in page.analyze synchronous mode)
import { defaultAnalyzeLayout } from '../tools/page/handlers/layout-handler';
import { defaultDetectMotion } from '../tools/page/handlers/motion-handler';
import { defaultEvaluateQuality } from '../tools/page/handlers/quality-handler';
import { pageIngestAdapter, type IngestAdapterOptions } from '../services/page-ingest-adapter';
import { saveBackgroundDesigns, type BackgroundDesignForSave, type BackgroundDesignPrismaClient, type SaveBackgroundDesignsResult } from '../services/background/background-design-db.service';
import { handleNarrativeAnalysis } from '../tools/page/handlers/narrative-handler';
import type { NarrativeHandlerInput, LayoutServiceResult, MotionServiceResult, MotionDetectionContext, IPageAnalyzePrismaClient } from '../tools/page/handlers/types';
// Scroll Vision Smart Capture
import { captureScrollPositions, type SectionBoundary, type ScrollCapture } from '../services/vision/scroll-vision-capture.service';
import { analyzeScrollCaptures, type ScrollVisionResult } from '../services/vision/scroll-vision.analyzer';
import { saveScrollVisionResults, type ScrollVisionPrismaClient, type SaveScrollVisionResult } from '../services/vision/scroll-vision-persistence.service';
// P2-8: VRAM状態チェック（Phase 2.5実行前のReadiness Probe）
import { OllamaReadinessProbe } from '../services/vision/ollama-readiness-probe';
// GPU Resource Manager: Vision/Embedding間のGPU動的切り替え
import { GpuResourceManager, gpuModeSignal } from '../services/gpu-resource-manager';
// Responsive Analysis
import {
  responsiveAnalysisService,
  responsivePersistenceService,
} from '../services/responsive';
import { validateExternalUrl } from '../utils/url-validator';
import { isUrlAllowedByRobotsTxt } from '@reftrix/core';
// EmbeddingService singleton for GPU provider switching (switchProvider/releaseGpu)
import { embeddingService as mlEmbeddingService } from '@reftrix/ml';
// DB保存ロジック（SectionPattern, MotionPattern, QualityEvaluation, JSAnimationPattern）
import {
  saveSectionPatterns,
  saveMotionPatterns,
  saveQualityEvaluation,
  saveQualityBenchmarks,
  buildQualityBenchmarkInputs,
  saveJsAnimationPatterns,
  type SectionPatternPrismaClient,
  type MotionPatternPrismaClient,
  type QualityEvaluationPrismaClient,
  type QualityBenchmarkPrismaClient,
  type JsAnimationPatternPrismaClient,
  type SaveResult,
} from '../services/worker-db-save.service';
// Embedding generation (reuse from synchronous flow)
import {
  generateSectionEmbeddings,
  generateMotionEmbeddings,
  generateBackgroundDesignEmbeddings,
  setBackgroundEmbeddingServiceFactory,
  setBackgroundPrismaClientFactory,
  setMotionLayoutEmbeddingServiceFactory,
  type SectionDataForEmbedding,
  type BackgroundDesignForText,
} from '../tools/page/handlers/embedding-handler';
import { LayoutEmbeddingService, setEmbeddingServiceFactory, setPrismaClientFactory as setLayoutPrismaClientFactory } from '../services/layout-embedding.service';
import { setFramePrismaClientFactory } from '../services/motion/frame-embedding.service';
import type { MotionPatternForEmbedding, JSAnimationFullResult } from '../tools/page/handlers/types';

// Worker Memory Self-Monitoring（OOM防止用）
import { performMemoryCheckAndExit } from '../services/worker-memory-monitor.service';
// Dynamic memory thresholds based on system RAM
import { resolveMemoryConfig, logMemoryProfile } from '../services/worker-memory-profile';
// 共通定数（DB保存済み判定閾値）
import { DB_SAVED_PROGRESS_THRESHOLD } from '../services/worker-constants';
// Stall recovery: BullMQ stalled event handler + periodic check
import {
  handleStalledJob,
  recoverOrphanedJobs,
  createPeriodicStallCheck,
  type OrphanedJobInfo,
  type StalledJobAccessor,
} from '../services/worker-stall-recovery.service';
import { createPageAnalyzeQueue } from '../queues/page-analyze-queue';
// SEC-M2: 安全な環境変数パース
import { safeParseInt } from '../utils/safe-parse-int';
// Post-embedding backfill: DB-driven embedding gap detection and repair
import { backfillWebPageEmbeddings, checkWebPageEmbeddingCoverage } from '../services/embedding-backfill.service';
// Responsive Analysis Embedding generation
import { generateResponsiveAnalysisEmbeddings } from '../services/responsive/responsive-analysis-embedding.service';
// Frame Analysis DB保存ヘルパー（同期/非同期モード共有）
import { saveFrameAnalysisToDb } from '../services/motion/frame-analysis-save.helper';

// Embedding DI factories initialization
// Worker runs in a separate process; factories must be set before use
// Single shared ONNX session to prevent memory leak from repeated LayoutEmbeddingService creation
// P0-1: All embedding sub-phases (Section, Motion, Background, JSAnimation) share this singleton
const sharedLayoutEmbeddingService = new LayoutEmbeddingService();
setEmbeddingServiceFactory(() => mlEmbeddingService);
setLayoutPrismaClientFactory(() => prisma as never);
setBackgroundEmbeddingServiceFactory(() => sharedLayoutEmbeddingService);
setMotionLayoutEmbeddingServiceFactory(() => sharedLayoutEmbeddingService);
setBackgroundPrismaClientFactory(() => prisma as never);
setFramePrismaClientFactory(() => prisma as never);

// GPU Resource Manager: Vision/Embedding間のGPU動的切り替え (singleton)
const gpuResourceManager = GpuResourceManager.getInstance();

// ============================================================================
// Pre-Return Pause: BullMQ moveToCompleted レースコンディション防止
// ============================================================================
//
// BullMQ v5 の moveToCompleted Lua スクリプトは fetchNext=true の場合、
// ジョブ完了と次のジョブ取得を1つのアトミック操作で行う。
// これにより Worker.on('completed') イベントが発火する前に次のジョブが
// active 状態に遷移してしまい、WorkerSupervisor の計画的再起動時に
// 新規ジョブが「ブラウザ閉鎖済み」エラーで失敗するレースコンディションが発生する。
//
// 解決: Processor内で return 前に worker.pause(true) を呼ぶことで
// BullMQ Worker.paused フラグを立て、fetchNext=false を保証する。
// worker.pause(doNotWaitActive=true) はProcessor内から安全に呼べる。
//
// WorkerSupervisor側では job-completed IPC で再起動をトリガーする従来の
// フローが維持され、shutdown処理中に新規ジョブが取得されることはない。
// ============================================================================

/**
 * Module-level reference to the BullMQ Worker instance.
 * Set by createPageAnalyzeWorker(), read by processPageAnalyzeJob().
 * This bridge enables the Processor to call worker.pause() before returning.
 */
let _workerInstanceRef: Worker<PageAnalyzeJobData, PageAnalyzeJobResult> | null = null;

/**
 * Whether pre-return pause is enabled (maxJobsBeforeRestart > 0).
 * Read from WORKER_MAX_JOBS_BEFORE_RESTART env var (default: 1).
 * When 0, pre-return pause is disabled (unlimited jobs per process).
 */
const _preReturnPauseEnabled = safeParseInt(process.env.WORKER_MAX_JOBS_BEFORE_RESTART, 1) > 0;

// ============================================================================
// Ollama Vision Model Unload (RAM recovery for CPU-only environments)
// ============================================================================
//
// CPU-only環境（16GB RAM）では Ollama Vision (llama3.2-vision: ~10.6GB RAM) が
// embedding フェーズのメモリを圧迫し ONNX Runtime OOM を引き起こす。
// GpuResourceManager.acquireForEmbedding() は GPU がない環境では
// unloadOllamaModel() をスキップするため、別途 RAM 解放用の関数を用意する。
//
// ============================================================================

/** Default Ollama URL */
const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

/** Ollama Vision model name (same as GpuResourceManager) */
const OLLAMA_VISION_MODEL_NAME = process.env.OLLAMA_VISION_MODEL ?? 'llama3.2-vision';

/** Ollama API timeout for unload request (ms) */
const OLLAMA_UNLOAD_TIMEOUT_MS = 10_000;

/** Allowed hostnames for Ollama API (SSRF prevention) */
const OLLAMA_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * SEC: Ollama URL のローカルホストバリデーション（SSRF 対策）
 *
 * GpuResourceManager.validateOllamaUrl() と同等の防御を提供する。
 * 外部 URL が指定された場合はデフォルト URL にフォールバックする。
 */
function validateOllamaLocalhostUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!OLLAMA_ALLOWED_HOSTS.includes(parsed.hostname)) {
      logger.warn('[PageAnalyzeWorker] Ollama URL rejected: must point to localhost', {
        hostname: parsed.hostname,
      });
      return OLLAMA_DEFAULT_URL;
    }
    return url;
  } catch {
    logger.warn('[PageAnalyzeWorker] Invalid Ollama URL, falling back to default', { url });
    return OLLAMA_DEFAULT_URL;
  }
}

/**
 * Ollama Vision モデルを RAM/VRAM からアンロードしてメモリを解放する
 *
 * CPU-only 環境では GpuResourceManager がアンロードをスキップするため、
 * Vision使用フェーズ完了後に明示的に呼び出す。
 * 呼び出し箇所: (1) Phase 2.5完了後、(2) Phase 4 (Narrative) 完了後。
 * 冪等: Ollama が起動していない環境や Vision 未ロード時は何もせず正常終了する (non-fatal)。
 *
 * @returns アンロード成功時 true、失敗/スキップ時 false
 */
async function unloadOllamaVisionModel(): Promise<boolean> {
  const ollamaUrl = validateOllamaLocalhostUrl(process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_URL);
  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_VISION_MODEL_NAME,
        keep_alive: '0',
        prompt: '',
      }),
      signal: AbortSignal.timeout(OLLAMA_UNLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn('[PageAnalyzeWorker] Ollama vision model unload request failed', {
        status: response.status,
        statusText: response.statusText,
      });
      return false;
    }

    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    logger.info('[PageAnalyzeWorker] Ollama vision model unloaded to free memory for embedding phase', {
      model: OLLAMA_VISION_MODEL_NAME,
      currentRssMb: rssMb,
    });
    return true;
  } catch (error) {
    // Ollama未起動やネットワークエラー: 警告のみ (non-fatal)
    logger.warn('[PageAnalyzeWorker] Failed to unload Ollama vision model (service may be unavailable)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// Connect gpuModeSignal to the @reftrix/ml EmbeddingService singleton.
// When GpuResourceManager requests a provider switch, the ONNX pipeline is
// disposed and re-initialized with the new execution provider (CPU/CUDA).
// We use mlEmbeddingService directly because LayoutEmbeddingService wraps
// IEmbeddingService which doesn't expose switchProvider/releaseGpu.
gpuModeSignal.onProviderSwitch = async (provider: 'cpu' | 'cuda'): Promise<void> => {
  if (provider === 'cuda') {
    await mlEmbeddingService.switchProvider('cuda');
  } else {
    await mlEmbeddingService.releaseGpu();
  }
};

// ============================================================================
// Types
// ============================================================================

/**
 * Lock extender interface for managing periodic lock renewal
 *
 * Provides start/stop lifecycle for a setInterval-based lock extension timer.
 * Used as secondary protection against job stalling when CPU-bound processing
 * may block the event loop and prevent BullMQ's built-in auto-renewal.
 */
export interface LockExtender {
  /** Start periodic lock extension */
  start: () => void;
  /** Stop periodic lock extension (safe to call multiple times) */
  stop: () => void;
}

/**
 * Worker configuration options
 */
export interface PageAnalyzeWorkerOptions {
  /** Redis configuration overrides */
  redisConfig?: Partial<RedisConfig>;
  /** Worker concurrency (default: 1) */
  concurrency?: number;
  /** Lock duration in ms (default: 2400000, configurable via BULLMQ_LOCK_DURATION) */
  lockDuration?: number;
  /** Enable verbose logging (default: isDevelopment()) */
  verbose?: boolean;
}

/**
 * Worker instance with lifecycle methods
 */
export interface PageAnalyzeWorkerInstance {
  /** BullMQ Worker instance */
  worker: Worker<PageAnalyzeJobData, PageAnalyzeJobResult>;
  /** Gracefully close the worker */
  close: () => Promise<void>;
  /** Pause the worker (stop accepting new jobs, current job continues) */
  pause: () => Promise<void>;
  /** Check if worker is running */
  isRunning: () => boolean;
}

/**
 * Prismaクライアントインターフェース（JSAnimationEmbedding保存用）
 * N+1解消: createMany によるバッチ挿入に対応
 */
interface JsAnimationEmbeddingPrismaClient {
  jSAnimationEmbedding: {
    createMany: (args: { data: Array<{ jsAnimationPatternId: string; textRepresentation: string; modelVersion: string }> }) => Promise<{ count: number }>;
  };
}

/**
 * Embedding phase のパラメータ
 *
 * processEmbeddingPhase に渡す必要なデータをまとめた型。
 * processPageAnalyzeJob から抽出された独立関数で使用する。
 */
export interface EmbeddingPhaseParams {
  /** 実際のWebPage DB ID（upsert結果） */
  webPageId: string;
  /** ソースURL */
  url: string;
  /** BullMQ Job インスタンス */
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>;
  /** Worker token for lock extension */
  effectiveToken: string;
  /** Lock duration (ms) */
  effectiveLockDuration: number;
  /** Section保存結果（embedding生成用） */
  sectionSaveResult: SaveResult | null;
  /** Motion保存結果（embedding生成用） */
  motionSaveResult: SaveResult | null;
  /** JSAnimation保存結果（embedding生成用） */
  jsSaveResult: SaveResult | null;
  /** BackgroundDesign保存結果（embedding生成用） */
  bgSaveResult: SaveBackgroundDesignsResult | null;
  /** ScrollVision保存結果（embedding生成用） */
  scrollVisionSaveResult: SaveScrollVisionResult | null;
  /** Layout結果（sections, backgroundDesigns for embedding） */
  layoutResultForNarrative: LayoutServiceResult | null;
  /** Motion結果（patterns for embedding） */
  motionResultForEmbedding: MotionServiceResult | null;
  /** JSAnimation検出結果（embedding生成用） */
  jsAnimationsForEmbedding: JSAnimationFullResult | null;
  /** ScrollVision解析結果（vision-detected motion embedding生成用） */
  scrollVisionResultForEmbedding: ScrollVisionResult | null;
  /** Responsive Analysis ID（Phase 4.5でDB保存済み、embedding生成用） */
  responsiveAnalysisId?: string | undefined;
  /** Granular progress callback for embedding sub-phases */
  onProgress?: ((completed: number, total: number) => void) | undefined;
}

/**
 * Embedding phase の結果
 */
export interface EmbeddingPhaseResult {
  /** Section embedding 生成数 */
  sectionEmbeddingsGenerated: number;
  /** Motion embedding 生成数 */
  motionEmbeddingsGenerated: number;
  /** BackgroundDesign embedding 生成数 */
  bgEmbeddingsGenerated: number;
  /** JSAnimation embedding 生成数 */
  jsAnimationEmbeddingsGenerated: number;
  /** Responsive Analysis embedding 生成数 */
  responsiveEmbeddingsGenerated: number;
  /** Embedding生成に失敗したチャンク数 */
  embeddingFailedChunks: number;
  /** Embedding phase が完了したか */
  completed: boolean;
}

/**
 * JSアニメーションからEmbedding用テキスト表現を生成
 *
 * CDP/Web Animations APIで検出されたアニメーション情報を
 * multilingual-e5-base用のテキスト表現に変換する。
 * E5モデル用にpassage:プレフィックスを付与。
 *
 * @param originalId - 元のアニメーションID
 * @param jsAnimations - JS Animation検出結果全体
 * @returns Embedding用テキスト表現（passage:プレフィックス付き）
 */
export function generateJsAnimationTextRepresentation(
  originalId: string,
  jsAnimations: JSAnimationFullResult
): string {
  const parts: string[] = [];

  // CDP AnimationsまたはWeb Animationsから該当アニメーションを検索
  const cdpAnim = jsAnimations.cdpAnimations.find((a) => a.id === originalId);
  const webAnim = jsAnimations.webAnimations.find((a) => a.id === originalId);

  if (cdpAnim) {
    parts.push(`JavaScript animation: ${cdpAnim.name || cdpAnim.type}`);
    parts.push(`Type: ${cdpAnim.type}`);
    if (cdpAnim.source.duration > 0) {
      parts.push(`Duration: ${Math.round(cdpAnim.source.duration)}ms`);
    }
    if (cdpAnim.source.easing) {
      parts.push(`Easing: ${cdpAnim.source.easing}`);
    }
    parts.push(`Play state: ${cdpAnim.playState}`);
  } else if (webAnim) {
    parts.push(`JavaScript animation: WebAnimation on ${webAnim.target.slice(0, 100)}`);
    parts.push(`Type: Web Animations API`);
    if (webAnim.timing.duration > 0) {
      parts.push(`Duration: ${Math.round(webAnim.timing.duration)}ms`);
    }
    if (webAnim.timing.easing) {
      parts.push(`Easing: ${webAnim.timing.easing}`);
    }
    if (webAnim.timing.iterations > 1) {
      parts.push(`Iterations: ${webAnim.timing.iterations}`);
    }
    // キーフレームからプロパティを抽出
    if (webAnim.keyframes.length > 0) {
      const propNames = new Set<string>();
      for (const kf of webAnim.keyframes) {
        for (const key of Object.keys(kf)) {
          if (!['offset', 'easing', 'composite'].includes(key)) {
            propNames.add(key);
          }
        }
      }
      if (propNames.size > 0) {
        parts.push(`Properties: ${Array.from(propNames).join(', ')}`);
      }
    }
    parts.push(`Play state: ${webAnim.playState}`);
  } else {
    // フォールバック
    parts.push(`JavaScript animation: pattern ${originalId}`);
  }

  // ライブラリ情報を追加
  const detectedLibs: string[] = [];
  if (jsAnimations.libraries.gsap.detected) detectedLibs.push('GSAP');
  if (jsAnimations.libraries.framerMotion.detected) detectedLibs.push('Framer Motion');
  if (jsAnimations.libraries.anime.detected) detectedLibs.push('anime.js');
  if (jsAnimations.libraries.three.detected) detectedLibs.push('Three.js');
  if (jsAnimations.libraries.lottie.detected) detectedLibs.push('Lottie');
  if (detectedLibs.length > 0) {
    parts.push(`Libraries: ${detectedLibs.join(', ')}`);
  }

  return `passage: ${parts.join('. ')}.`;
}

/**
 * JSAnimationEmbeddingのチャンクをDBに一括保存
 *
 * createMany による一括挿入 + バッチUPDATE によるベクトル更新を行う。
 * チャンク化（50件/バッチ）により、700+件のJSAnimationでもメモリ使用量を抑制する。
 *
 * @param chunk - 保存対象のEmbeddingアイテム配列
 * @param prismaClient - Prismaクライアント
 * @returns 保存されたアイテム数
 */
async function saveJsAnimationEmbeddingChunk(
  chunk: ReadonlyArray<{
    originalId: string;
    dbId: string;
    textRepresentation: string;
    embedding: number[];
  }>,
  prismaClient: typeof prisma,
): Promise<number> {
  if (chunk.length === 0) {
    return 0;
  }

  // createMany: 全レコードを一括挿入
  const createData = chunk.map((item) => ({
    jsAnimationPatternId: item.dbId,
    textRepresentation: item.textRepresentation,
    modelVersion: 'multilingual-e5-base',
  }));

  await (prismaClient as unknown as JsAnimationEmbeddingPrismaClient).jSAnimationEmbedding.createMany({
    data: createData,
  });

  // バッチUPDATE: Embeddingベクトルを一括更新
  const vectorUpdates = chunk.filter((item) => item.embedding.length > 0);
  if (vectorUpdates.length > 0) {
    // PostgreSQL parameter limit: 65,535. Current chunk size 50 × 2 params = 100 (safe).
    // If JS_ANIMATION_EMBEDDING_CHUNK_SIZE is increased, ensure total params stay under 65,535.
    // SEC: valuesClause contains only positional placeholders ($N::type) generated from
    // array indices, not user input. All data flows through parameterized ...params.
    const valuesClause = vectorUpdates.map(
      (_, idx) => `($${idx * 2 + 1}::vector, $${idx * 2 + 2}::uuid)`
    ).join(', ');

    const params: unknown[] = [];
    for (const item of vectorUpdates) {
      params.push(`[${item.embedding.join(',')}]`);
      params.push(item.dbId);
    }

    await (prismaClient as { $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number> }).$executeRawUnsafe(
      `UPDATE js_animation_embeddings AS e SET embedding = v.vec FROM (VALUES ${valuesClause}) AS v(vec, pattern_id) WHERE e.js_animation_pattern_id = v.pattern_id`,
      ...params
    );
  }

  return chunk.length;
}

// ============================================================================
// Dynamic Memory Configuration (resolved once at module load from system RAM)
// ============================================================================
const _memoryConfig = resolveMemoryConfig();
logMemoryProfile(_memoryConfig);

/** JSAnimation Embeddingチャンクサイズ（メモリ使用量抑制用、システムRAMに応じて動的決定） */
const JS_ANIMATION_EMBEDDING_CHUNK_SIZE = _memoryConfig.jsAnimationEmbeddingChunkSize;

/**
 * Universal embedding chunk size for sections/motions/backgrounds.
 *
 * All embedding sub-phases process items in chunks of this size to prevent
 * ONNX native arena memory from accumulating beyond the worker's memory threshold.
 *
 * With recycle threshold=30 and chunk size matching:
 * - pipeline recycles per chunk → chunk peak ~1GB native memory
 * - dispose+GC between chunks → RSS stays under safe limits
 *
 * Adaptive: reduced to half (min 5) under memory pressure.
 * Value is dynamically computed based on system RAM by resolveMemoryConfig().
 */
const EMBEDDING_CHUNK_SIZE = _memoryConfig.embeddingChunkSize;

// ============================================================================
// Constants
// ============================================================================

/**
 * Default worker concurrency
 *
 * Note: Set to 1 to avoid race condition with singleton browser instance.
 * BullMQ Worker + singleton Playwright browser causes "Target page, context
 * or browser has been closed" errors when concurrency > 1.
 *
 * Mid-term solution: Implement browser pool with concurrency > 1.
 */
const DEFAULT_CONCURRENCY = 1;

/** Default lock duration (2400 seconds = 40 minutes, extended for CPU-bound embedding phase).
 * Configurable via BULLMQ_LOCK_DURATION environment variable.
 * SEC-M2: safeParseInt による安全なパース（NaN/範囲チェック付き、min=60s） */
const DEFAULT_LOCK_DURATION = safeParseInt(process.env.BULLMQ_LOCK_DURATION, 2400000, { min: 60000 });

/** Default lock extend interval (300 seconds = 5 minutes).
 * The lock extender calls job.extendLock() at this interval.
 * Must be less than lockDuration to prevent stalling.
 * Configurable via BULLMQ_LOCK_EXTEND_INTERVAL_MS environment variable.
 * SEC-M2: safeParseInt による安全なパース（NaN/範囲チェック付き、min=10s） */
const DEFAULT_LOCK_EXTEND_INTERVAL = safeParseInt(process.env.BULLMQ_LOCK_EXTEND_INTERVAL_MS, 300000, { min: 10000 });

// ============================================================================
// Memory Degradation Constants (dynamically resolved from system RAM)
// ============================================================================

/**
 * RSS threshold for degradation - disable narrative/vision.
 *
 * 32GBマシンでは12288MB（12GB）、システムRAMに応じて自動スケール。
 * 根拠: ONNX Runtime + Playwright のベースRSSが約3GBのため、
 * 旧値3072MBではワーカー起動直後からdegradation状態になっていた。
 * 環境変数 WORKER_MEMORY_DEGRADATION_MB でオーバーライド可能。
 */
const MEMORY_DEGRADATION_THRESHOLD_MB = _memoryConfig.degradationThresholdMb;

/**
 * RSS threshold for critical abort - skip to DB save.
 *
 * 32GBマシンでは14336MB（14GB）、システムRAMに応じて自動スケール。
 * 根拠: degradation閾値 + バッファ。OOMキラー前に安全停止するための上限。
 * 環境変数 WORKER_MEMORY_CRITICAL_MB でオーバーライド可能。
 */
const MEMORY_CRITICAL_THRESHOLD_MB = _memoryConfig.criticalThresholdMb;

/**
 * HTML size threshold for disabling vision LLM. Default: 5000000 (5MB)
 *
 * 根拠: preStripDangerousTags導入により、DOMPurifyに渡される前にscript等が
 * regex事前除去されるため、5MBまでのHTMLでも妥当な時間でサニタイズ可能になった。
 * SEC-M2: safeParseInt による安全なパース（min=100000=100KB）
 */
const HTML_LARGE_THRESHOLD = safeParseInt(process.env.WORKER_HTML_LARGE_BYTES, 5000000, { min: 100000 });

/**
 * HTML size threshold for disabling narrative+vision. Default: 10000000 (10MB)
 *
 * 根拠: preStripDangerousTags導入後、10MBまでの生HTMLでも事前削減により
 * DOMPurify処理が数分以内に完了する。旧値2MBではlinear.app(2.6MB)等が
 * ナラティブ分析対象外になっていた。
 * SEC-M2: safeParseInt による安全なパース（min=100000=100KB）
 */
const HTML_HUGE_THRESHOLD = safeParseInt(process.env.WORKER_HTML_HUGE_BYTES, 10000000, { min: 100000 });

/**
 * Attempt to trigger garbage collection if --expose-gc flag is available.
 * Returns true if GC was triggered, false otherwise.
 */
function tryGarbageCollect(): boolean {
  if (typeof global.gc === 'function') {
    global.gc();
    return true;
  }
  return false;
}

/**
 * Check current memory pressure.
 * Returns whether degradation or abort is recommended.
 *
 * When global.gc is available (--expose-gc), triggers GC before measuring
 * to get a more accurate picture of actual memory usage vs cached garbage.
 *
 * Note: RSS calculation pattern is shared with MetricsCollector.getMemoryUsage(),
 * but kept separate as this function serves a different purpose (threshold-based
 * degradation control vs cumulative metrics collection).
 */
function checkMemoryPressure(): { shouldDegrade: boolean; shouldAbort: boolean; rssMb: number } {
  // Trigger GC before measurement for more accurate RSS reading
  tryGarbageCollect();
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  return {
    shouldDegrade: rssMb >= MEMORY_DEGRADATION_THRESHOLD_MB,
    shouldAbort: rssMb >= MEMORY_CRITICAL_THRESHOLD_MB,
    rssMb,
  };
}


// ============================================================================
// Lock Extension Utilities
// ============================================================================

/**
 * Create a lock extender that periodically extends the BullMQ job lock.
 *
 * BullMQ's built-in auto-renewal (lockRenewTime = lockDuration/2) may fail
 * when the event loop is blocked by CPU-bound processing (e.g., Ollama Vision).
 * This provides an additional layer of protection via setInterval.
 *
 * @param job - BullMQ Job instance
 * @param token - Worker token for lock ownership verification
 * @param lockDuration - Lock duration to extend by (in ms)
 * @param intervalMs - Interval between lock extensions (in ms)
 * @returns LockExtender with start() and stop() methods
 */
export function createLockExtender(
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>,
  token: string,
  lockDuration: number,
  intervalMs: number = DEFAULT_LOCK_EXTEND_INTERVAL
): LockExtender {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  return {
    start: (): void => {
      if (intervalId !== null) {
        return; // Already started
      }

      if (isDevelopment()) {
        logger.info('[PageAnalyzeWorker] Starting lock extender', {
          jobId: job.id,
          lockDuration,
          intervalMs,
        });
      }

      intervalId = setInterval(() => {
        job.extendLock(token, lockDuration).then(() => {
          if (isDevelopment()) {
            logger.debug('[PageAnalyzeWorker] Lock extended successfully', {
              jobId: job.id,
              lockDuration,
            });
          }
        }).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('[PageAnalyzeWorker] Lock extension failed', {
            jobId: job.id,
            error: message,
          });
        });
      }, intervalMs);

      // Ensure the interval does not prevent process exit
      if (intervalId && typeof intervalId === 'object' && 'unref' in intervalId) {
        intervalId.unref();
      }
    },
    stop: (): void => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;

        if (isDevelopment()) {
          logger.debug('[PageAnalyzeWorker] Lock extender stopped', {
            jobId: job.id,
          });
        }
      }
    },
  };
}

/**
 * Extend job lock at phase boundaries (explicit, one-shot extension).
 *
 * Called at async phase transitions to ensure the lock is fresh
 * before entering a potentially long-running phase (e.g., Scroll Vision, Narrative).
 * Failures are logged but do not interrupt job processing (graceful degradation).
 *
 * @param job - BullMQ Job instance
 * @param token - Worker token for lock ownership
 * @param lockDuration - Duration to extend the lock by (in ms)
 * @param phaseName - Name of the phase about to start (for logging)
 */
export async function extendJobLock(
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>,
  token: string,
  lockDuration: number,
  phaseName: string
): Promise<void> {
  try {
    await job.extendLock(token, lockDuration);
    if (isDevelopment()) {
      logger.debug('[PageAnalyzeWorker] Lock extended at phase boundary', {
        jobId: job.id,
        phaseName,
        lockDuration,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[PageAnalyzeWorker] Lock extension failed at phase boundary', {
      jobId: job.id,
      phaseName,
      error: message,
    });
  }
}

/** Phase progress percentages
 * EMBEDDING_START は DB_SAVED_PROGRESS_THRESHOLD と一致する必要がある。
 * progress >= DB_SAVED_PROGRESS_THRESHOLD のジョブはDB保存済みとみなされる。
 */
const PHASE_PROGRESS = {
  INGEST_START: 0,
  INGEST_COMPLETE: 15,
  LAYOUT_START: 15,
  LAYOUT_COMPLETE: 35,
  SCROLL_VISION_START: 35,
  SCROLL_VISION_COMPLETE: 45,
  MOTION_START: 45,
  MOTION_COMPLETE: 60,
  QUALITY_START: 60,
  QUALITY_COMPLETE: 75,
  NARRATIVE_START: 75,
  NARRATIVE_COMPLETE: 85,
  RESPONSIVE_START: 85,
  RESPONSIVE_COMPLETE: DB_SAVED_PROGRESS_THRESHOLD,
  EMBEDDING_START: DB_SAVED_PROGRESS_THRESHOLD,
  EMBEDDING_COMPLETE: 100,
} as const;

// ============================================================================
// Phase Progress Interpolation
// ============================================================================

/**
 * Create a progress interpolator for reporting granular progress within a phase.
 *
 * Converts (completed, total) sub-task progress into a numeric BullMQ progress
 * value interpolated between phaseStart and phaseEnd. Fire-and-forget: errors
 * from job.updateProgress are silently caught to never crash the worker.
 *
 * @param job - BullMQ Job instance
 * @param phaseStart - Progress percentage at phase start (e.g., 35)
 * @param phaseEnd - Progress percentage at phase end (e.g., 45)
 * @returns Callback (completed, total) => void
 */
export function createPhaseProgressInterpolator(
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>,
  phaseStart: number,
  phaseEnd: number,
): (completed: number, total: number) => void {
  const range = phaseEnd - phaseStart;
  return (completed: number, total: number): void => {
    if (total <= 0) return;
    const ratio = Math.max(0, Math.min(completed / total, 1));
    const interpolated = Math.round(phaseStart + range * ratio);
    if (!Number.isFinite(interpolated)) return;
    job.updateProgress(interpolated).catch(() => { /* fire-and-forget */ });
  };
}

// ============================================================================
// Embedding Phase (extracted for TDA-M1)
// ============================================================================

/**
 * Embedding phase を処理する独立関数
 *
 * processPageAnalyzeJob から抽出された embedding 生成ロジック。
 * Section, Motion, BackgroundDesign, JSAnimation の各 embedding を生成し、
 * DB に保存する。各サブフェーズの前に extendJobLock を呼び出して
 * ロック延長を行う。
 *
 * Graceful Degradation: 個別の embedding 生成失敗はジョブ全体を中断しない。
 *
 * @param params - Embedding phase のパラメータ
 * @returns Embedding phase の結果
 */
export async function processEmbeddingPhase(
  params: EmbeddingPhaseParams,
): Promise<EmbeddingPhaseResult> {
  const {
    webPageId,
    url,
    job,
    effectiveToken,
    effectiveLockDuration,
    sectionSaveResult,
    motionSaveResult,
    jsSaveResult,
    bgSaveResult,
    scrollVisionSaveResult,
    layoutResultForNarrative,
    motionResultForEmbedding,
    jsAnimationsForEmbedding,
    scrollVisionResultForEmbedding,
    responsiveAnalysisId,
    onProgress,
  } = params;

  const result: EmbeddingPhaseResult = {
    sectionEmbeddingsGenerated: 0,
    motionEmbeddingsGenerated: 0,
    bgEmbeddingsGenerated: 0,
    jsAnimationEmbeddingsGenerated: 0,
    responsiveEmbeddingsGenerated: 0,
    embeddingFailedChunks: 0,
    completed: false,
  };

  // Compound progress tracking: accumulate across all 4 embedding sub-phases
  // Calculate total expected items for proportional progress reporting
  const sectionCount = (sectionSaveResult && sectionSaveResult.idMapping.size > 0 && layoutResultForNarrative?.sections)
    ? (layoutResultForNarrative.sections as SectionDataForEmbedding[]).length : 0;
  const motionCount = (motionSaveResult && motionSaveResult.idMapping.size > 0 && motionResultForEmbedding?.patterns)
    ? motionResultForEmbedding.patterns.length : 0;
  const visionMotionCount = (scrollVisionSaveResult && scrollVisionSaveResult.idMapping.size > 0 && scrollVisionResultForEmbedding)
    ? scrollVisionResultForEmbedding.scrollTriggeredAnimations.length : 0;
  const bgCount = (bgSaveResult && bgSaveResult.ids.length > 0 && layoutResultForNarrative?.backgroundDesigns)
    ? (layoutResultForNarrative.backgroundDesigns as unknown[]).length : 0;
  const jsCount = (jsSaveResult && jsSaveResult.idMapping.size > 0 && jsAnimationsForEmbedding)
    ? jsSaveResult.idMapping.size : 0;
  const totalEmbeddingItems = sectionCount + motionCount + visionMotionCount + bgCount + jsCount;
  let completedEmbeddingItems = 0;

  /** Report compound embedding progress via parent onProgress callback */
  function reportEmbeddingSubProgress(_subCompleted: number, _subTotal: number): void {
    if (!onProgress || totalEmbeddingItems <= 0) return;
    // Each call increments the global counter by 1 item
    completedEmbeddingItems++;
    try { onProgress(completedEmbeddingItems, totalEmbeddingItems); } catch { /* fire-and-forget */ }
  }

  try {
    if (isDevelopment()) {
      logger.info('[PageAnalyzeWorker] Starting embedding generation', {
        sectionIdMappingSize: sectionSaveResult?.idMapping?.size ?? 0,
        motionIdMappingSize: motionSaveResult?.idMapping?.size ?? 0,
        jsIdMappingSize: jsSaveResult?.idMapping?.size ?? 0,
        bgIdMappingSize: bgSaveResult?.idMapping?.size ?? 0,
        scrollVisionIdMappingSize: scrollVisionSaveResult?.idMapping?.size ?? 0,
      });
    }

    // 1. SectionEmbedding生成（チャンク化: EMBEDDING_CHUNK_SIZE件ごとにdispose+GC）
    await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-sections');
    if (sectionSaveResult && sectionSaveResult.idMapping.size > 0 && layoutResultForNarrative?.sections) {
      const allSections = layoutResultForNarrative.sections as SectionDataForEmbedding[];
      let sectionChunkSize = EMBEDDING_CHUNK_SIZE;

      for (let offset = 0; offset < allSections.length; offset += sectionChunkSize) {
        // メモリ圧力チェック: degradation時はチャンクサイズ縮小
        const memCheck = checkMemoryPressure();
        if (memCheck.shouldAbort) {
          logger.warn('[PageAnalyzeWorker] Critical memory, stopping section embedding', { rssMb: memCheck.rssMb });
          break;
        }
        if (memCheck.shouldDegrade) {
          sectionChunkSize = Math.max(5, Math.floor(sectionChunkSize / 2));
          logger.warn('[PageAnalyzeWorker] Memory pressure, reducing section chunk size', {
            rssMb: memCheck.rssMb, newChunkSize: sectionChunkSize,
          });
        }

        const chunkSections = allSections.slice(offset, offset + sectionChunkSize);

        // チャンクごとに lock extension（大量アイテム処理での lockDuration 超過リスク回避）
        await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-sections');

        // チャンク用の idMapping サブセットを作成
        const chunkIdMapping = new Map<string, string>();
        for (const section of chunkSections) {
          const dbId = sectionSaveResult.idMapping.get(section.id);
          if (dbId) chunkIdMapping.set(section.id, dbId);
        }

        try {
          const sectionEmbResult = await generateSectionEmbeddings(
            chunkSections,
            chunkIdMapping,
            { webPageId, onProgress: reportEmbeddingSubProgress, layoutEmbeddingService: sharedLayoutEmbeddingService }
          );

          result.sectionEmbeddingsGenerated += sectionEmbResult.generatedCount;

          if (isDevelopment()) {
            logger.info('[PageAnalyzeWorker] SectionEmbeddings chunk completed', {
              chunkOffset: offset,
              chunkSize: chunkSections.length,
              generatedCount: sectionEmbResult.generatedCount,
              failedCount: sectionEmbResult.failedCount,
              totalSoFar: result.sectionEmbeddingsGenerated,
            });
          }
        } catch (sectionEmbError) {
          result.embeddingFailedChunks++;
          logger.warn('[PageAnalyzeWorker] SectionEmbedding chunk failed (non-fatal)', {
            chunkOffset: offset,
            error: sectionEmbError instanceof Error ? sectionEmbError.message : String(sectionEmbError),
          });
        }

        // チャンク間メモリ回復（最終チャンク以外）
        if (offset + sectionChunkSize < allSections.length) {
          await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
          tryGarbageCollect();
          // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    }

    // ONNX session dispose: Section embedding後のメモリ回復
    await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
    tryGarbageCollect();

    // 2. MotionEmbedding生成（チャンク化: EMBEDDING_CHUNK_SIZE件ごとにdispose+GC）
    await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-motions');
    if (motionSaveResult && motionSaveResult.idMapping.size > 0 && motionResultForEmbedding?.patterns) {
      const allMotionPatterns = motionResultForEmbedding.patterns as MotionPatternForEmbedding[];
      let motionChunkSize = EMBEDDING_CHUNK_SIZE;

      for (let offset = 0; offset < allMotionPatterns.length; offset += motionChunkSize) {
        // メモリ圧力チェック
        const memCheck = checkMemoryPressure();
        if (memCheck.shouldAbort) {
          logger.warn('[PageAnalyzeWorker] Critical memory, stopping motion embedding', { rssMb: memCheck.rssMb });
          break;
        }
        if (memCheck.shouldDegrade) {
          motionChunkSize = Math.max(5, Math.floor(motionChunkSize / 2));
          logger.warn('[PageAnalyzeWorker] Memory pressure, reducing motion chunk size', {
            rssMb: memCheck.rssMb, newChunkSize: motionChunkSize,
          });
        }

        const chunkPatterns = allMotionPatterns.slice(offset, offset + motionChunkSize);

        // チャンクごとに lock extension
        await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-motions');

        // チャンク用の idMapping サブセットを作成
        const chunkIdMapping = new Map<string, string>();
        for (const pattern of chunkPatterns) {
          const dbId = motionSaveResult.idMapping.get(pattern.id);
          if (dbId) chunkIdMapping.set(pattern.id, dbId);
        }

        try {
          const motionEmbResult = await generateMotionEmbeddings(
            chunkPatterns,
            {
              webPageId,
              sourceUrl: url,
              motionPatternIdMapping: chunkIdMapping,
              onProgress: reportEmbeddingSubProgress,
            }
          );

          result.motionEmbeddingsGenerated += motionEmbResult.savedCount;

          if (isDevelopment()) {
            logger.info('[PageAnalyzeWorker] MotionEmbeddings chunk completed', {
              chunkOffset: offset,
              chunkSize: chunkPatterns.length,
              savedCount: motionEmbResult.savedCount,
              errorCount: motionEmbResult.errors.length,
              totalSoFar: result.motionEmbeddingsGenerated,
            });
          }
        } catch (motionEmbError) {
          result.embeddingFailedChunks++;
          logger.warn('[PageAnalyzeWorker] MotionEmbedding chunk failed (non-fatal)', {
            chunkOffset: offset,
            error: motionEmbError instanceof Error ? motionEmbError.message : String(motionEmbError),
          });
        }

        // チャンク間メモリ回復（最終チャンク以外）
        if (offset + motionChunkSize < allMotionPatterns.length) {
          await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
          tryGarbageCollect();
          // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    }

    // 2.5. Vision-detected MotionEmbedding生成（scroll-vision由来、チャンク化対象）
    if (scrollVisionSaveResult && scrollVisionSaveResult.idMapping.size > 0 && scrollVisionResultForEmbedding) {
      // vision_detectedパターンをMotionPatternForEmbedding形式に変換
      const visionPatterns: MotionPatternForEmbedding[] = scrollVisionResultForEmbedding.scrollTriggeredAnimations.map(
        (animation, index) => ({
          id: `vision_detected_${index}`,
          name: `Scroll-triggered ${animation.animationType}: ${animation.element.slice(0, 100)}`,
          type: 'vision_detected' as const,
          category: animation.animationType === 'parallax' ? 'parallax'
            : animation.animationType === 'appear' ? 'reveal'
            : animation.animationType === 'lazy-load' ? 'entrance'
            : 'scroll_trigger',
          trigger: 'scroll',
          duration: 0,
          easing: 'unknown',
          properties: [],
          performance: {
            level: 'acceptable' as const,
            usesTransform: false,
            usesOpacity: false,
          },
          accessibility: {
            respectsReducedMotion: false,
          },
        })
      );

      let visionChunkSize = EMBEDDING_CHUNK_SIZE;

      for (let offset = 0; offset < visionPatterns.length; offset += visionChunkSize) {
        const memCheck = checkMemoryPressure();
        if (memCheck.shouldAbort) {
          logger.warn('[PageAnalyzeWorker] Critical memory, stopping vision motion embedding', { rssMb: memCheck.rssMb });
          break;
        }
        if (memCheck.shouldDegrade) {
          visionChunkSize = Math.max(5, Math.floor(visionChunkSize / 2));
          logger.warn('[PageAnalyzeWorker] Memory pressure detected, reducing vision-motion chunk size', {
            rssMb: memCheck.rssMb, newChunkSize: visionChunkSize,
          });
        }

        const chunkVisionPatterns = visionPatterns.slice(offset, offset + visionChunkSize);

        await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-motions');

        const chunkVisionIdMapping = new Map<string, string>();
        for (const pattern of chunkVisionPatterns) {
          const dbId = scrollVisionSaveResult.idMapping.get(pattern.id);
          if (dbId) chunkVisionIdMapping.set(pattern.id, dbId);
        }

        try {
          const visionEmbResult = await generateMotionEmbeddings(
            chunkVisionPatterns,
            {
              webPageId,
              sourceUrl: url,
              motionPatternIdMapping: chunkVisionIdMapping,
              onProgress: reportEmbeddingSubProgress,
            }
          );

          result.motionEmbeddingsGenerated += visionEmbResult.savedCount;

          if (isDevelopment()) {
            logger.info('[PageAnalyzeWorker] Vision-detected MotionEmbeddings chunk completed', {
              chunkOffset: offset,
              savedCount: visionEmbResult.savedCount,
              errorCount: visionEmbResult.errors.length,
            });
          }
        } catch (visionEmbError) {
          result.embeddingFailedChunks++;
          logger.warn('[PageAnalyzeWorker] Vision-detected MotionEmbedding chunk failed (non-fatal)', {
            chunkOffset: offset,
            error: visionEmbError instanceof Error ? visionEmbError.message : String(visionEmbError),
          });
        }

        // チャンク間メモリ回復（最終チャンク以外）
        if (offset + visionChunkSize < visionPatterns.length) {
          await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
          tryGarbageCollect();
          // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    }

    // ONNX session dispose: Motion embedding後のメモリ回復
    await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
    tryGarbageCollect();

    // 3. BackgroundDesignEmbedding生成（チャンク化: EMBEDDING_CHUNK_SIZE件ごとにdispose+GC）
    // bgSaveResult.ids を使用して name 重複による idMapping 欠落を回避
    await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-backgrounds');
    if (bgSaveResult && bgSaveResult.ids.length > 0 && layoutResultForNarrative?.backgroundDesigns) {
      // BackgroundDesignForText形式に変換（全件）
      const allBackgroundsForText: BackgroundDesignForText[] = layoutResultForNarrative.backgroundDesigns.map((bg: {
        name: string;
        designType: string;
        selector?: string;
        colorInfo?: { dominantColors?: string[]; colorCount?: number; hasAlpha?: boolean; colorSpace?: string };
        gradientInfo?: { type?: string; angle?: number; stops?: Array<{ color: string; position: number }>; repeating?: boolean };
      }) => ({
        name: bg.name,
        designType: bg.designType,
        selector: bg.selector,
        colorInfo: bg.colorInfo,
        gradientInfo: bg.gradientInfo,
      }));

      let bgChunkSize = EMBEDDING_CHUNK_SIZE;

      for (let offset = 0; offset < allBackgroundsForText.length; offset += bgChunkSize) {
        // メモリ圧力チェック
        const memCheck = checkMemoryPressure();
        if (memCheck.shouldAbort) {
          logger.warn('[PageAnalyzeWorker] Critical memory, stopping background embedding', { rssMb: memCheck.rssMb });
          break;
        }
        if (memCheck.shouldDegrade) {
          bgChunkSize = Math.max(5, Math.floor(bgChunkSize / 2));
          logger.warn('[PageAnalyzeWorker] Memory pressure, reducing background chunk size', {
            rssMb: memCheck.rssMb, newChunkSize: bgChunkSize,
          });
        }

        const chunkBgs = allBackgroundsForText.slice(offset, offset + bgChunkSize);
        const chunkIds = bgSaveResult.ids.slice(offset, offset + bgChunkSize);

        // チャンク用の idMapping サブセットを作成
        const chunkIdMapping = new Map<string, string>();
        for (const bg of chunkBgs) {
          const dbId = bgSaveResult.idMapping.get(bg.name);
          if (dbId) chunkIdMapping.set(bg.name, dbId);
        }

        // チャンクごとに lock extension
        await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-backgrounds');

        try {
          const bgEmbResult = await generateBackgroundDesignEmbeddings(
            chunkBgs,
            chunkIdMapping,
            { webPageId, backgroundDesignIds: chunkIds, onProgress: reportEmbeddingSubProgress }
          );

          result.bgEmbeddingsGenerated += bgEmbResult.generatedCount;

          if (isDevelopment()) {
            logger.info('[PageAnalyzeWorker] BackgroundDesignEmbeddings chunk completed', {
              chunkOffset: offset,
              chunkSize: chunkBgs.length,
              generatedCount: bgEmbResult.generatedCount,
              failedCount: bgEmbResult.failedCount,
              totalSoFar: result.bgEmbeddingsGenerated,
            });
          }
        } catch (bgEmbError) {
          result.embeddingFailedChunks++;
          logger.warn('[PageAnalyzeWorker] BackgroundDesignEmbedding chunk failed (non-fatal)', {
            chunkOffset: offset,
            error: bgEmbError instanceof Error ? bgEmbError.message : String(bgEmbError),
          });
        }

        // チャンク間メモリ回復（最終チャンク以外）
        if (offset + bgChunkSize < allBackgroundsForText.length) {
          await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
          tryGarbageCollect();
          // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    }

    // ONNX session dispose: Background embedding後のメモリ回復
    await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
    tryGarbageCollect();

    // 4. JSAnimationEmbedding生成（チャンク処理: 50件/バッチでメモリ抑制）
    await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-js-animations');
    if (jsSaveResult && jsSaveResult.idMapping.size > 0 && jsAnimationsForEmbedding) {
      try {
        const jsEmbService = sharedLayoutEmbeddingService;

        // チャンク化: 50件ずつ生成+DB保存を繰り返し、メモリを抑制
        const embeddingItems: Array<{
          originalId: string;
          dbId: string;
          textRepresentation: string;
          embedding: number[];
        }> = [];

        for (const [originalId, dbId] of jsSaveResult.idMapping) {
          const memCheck = checkMemoryPressure();
          if (memCheck.shouldAbort) {
            logger.warn('[PageAnalyzeWorker] Critical memory, stopping JS animation embedding', { rssMb: memCheck.rssMb });
            break;
          }
          if (memCheck.shouldDegrade) {
            logger.warn('[PageAnalyzeWorker] Memory pressure detected in JS animation embedding', {
              rssMb: memCheck.rssMb,
            });
            // Note: JSAnimation uses item-by-item processing, not chunk slicing,
            // so chunk size reduction is not applicable here. The warning is for monitoring.
          }

          try {
            const textRepresentation = generateJsAnimationTextRepresentation(
              originalId,
              jsAnimationsForEmbedding
            );

            const embeddingResult = await jsEmbService.generateFromText(textRepresentation);

            embeddingItems.push({
              originalId,
              dbId,
              textRepresentation,
              embedding: embeddingResult.embedding,
            });

            // Granular progress: report each JS animation embedding item
            try { reportEmbeddingSubProgress(0, 0); } catch { /* fire-and-forget */ }

            // チャンク境界: DB保存してメモリ解放
            if (embeddingItems.length >= JS_ANIMATION_EMBEDDING_CHUNK_SIZE) {
              const savedCount = await saveJsAnimationEmbeddingChunk(embeddingItems, prisma);
              result.jsAnimationEmbeddingsGenerated += savedCount;

              if (isDevelopment()) {
                logger.info('[PageAnalyzeWorker] JSAnimationEmbeddings chunk saved', {
                  chunkSize: savedCount,
                  totalSoFar: result.jsAnimationEmbeddingsGenerated,
                });
              }

              embeddingItems.length = 0; // 配列をクリアしてメモリ解放
              tryGarbageCollect();
              // Yield to event loop: allow BullMQ heartbeats and IPC between chunks
              await new Promise<void>(resolve => setImmediate(resolve));
            }
          } catch (jsEmbItemError) {
            // Granular progress: report failed item too
            try { reportEmbeddingSubProgress(0, 0); } catch { /* fire-and-forget */ }
            // Graceful Degradation: 個別パターンの失敗はジョブを止めない
            result.embeddingFailedChunks++;
            logger.warn('[PageAnalyzeWorker] JSAnimationEmbedding item generation failed (non-fatal)', {
              originalId,
              dbId,
              error: jsEmbItemError instanceof Error ? jsEmbItemError.message : String(jsEmbItemError),
            });
          }
        }

        // 残りのアイテムを保存
        if (embeddingItems.length > 0) {
          const savedCount = await saveJsAnimationEmbeddingChunk(embeddingItems, prisma);
          result.jsAnimationEmbeddingsGenerated += savedCount;
        }

        if (isDevelopment()) {
          logger.info('[PageAnalyzeWorker] JSAnimationEmbeddings generated', {
            generatedCount: result.jsAnimationEmbeddingsGenerated,
            totalPatterns: jsSaveResult.idMapping.size,
          });
        }
      } catch (jsEmbError) {
        result.embeddingFailedChunks++;
        logger.warn('[PageAnalyzeWorker] JSAnimationEmbedding generation failed (non-fatal)', {
          error: jsEmbError instanceof Error ? jsEmbError.message : String(jsEmbError),
        });
      }
    }

    // ONNX session dispose: JSAnimation embedding後のメモリ回復
    await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
    tryGarbageCollect();

    // 5. ResponsiveAnalysisEmbedding生成（Phase 4.5でDB保存済みの分析結果にEmbeddingを付与）
    if (responsiveAnalysisId) {
      await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-responsive');
      try {
        const memCheck = checkMemoryPressure();
        if (!memCheck.shouldAbort) {
          const responsiveEmbResult = await generateResponsiveAnalysisEmbeddings(
            [responsiveAnalysisId],
            sharedLayoutEmbeddingService,
            prisma,
          );
          result.responsiveEmbeddingsGenerated = responsiveEmbResult.generatedCount;

          if (isDevelopment()) {
            logger.info('[PageAnalyzeWorker] ResponsiveAnalysisEmbeddings generated', {
              generatedCount: responsiveEmbResult.generatedCount,
              responsiveAnalysisId,
            });
          }
        } else {
          logger.warn('[PageAnalyzeWorker] Critical memory, skipping responsive embedding', { rssMb: memCheck.rssMb });
        }
      } catch (respEmbError) {
        // Graceful Degradation: responsive embedding失敗はジョブを中断しない
        result.embeddingFailedChunks++;
        logger.warn('[PageAnalyzeWorker] ResponsiveAnalysisEmbedding generation failed (non-fatal)', {
          error: respEmbError instanceof Error ? respEmbError.message : String(respEmbError),
        });
      }

      // ONNX session dispose: Responsive embedding後の最終メモリ回復
      await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
      tryGarbageCollect();
    }

    result.completed = true;
  } catch (embeddingError) {
    // Graceful Degradation: Embedding失敗はジョブを中断しない
    result.embeddingFailedChunks++;
    logger.warn('[PageAnalyzeWorker] Embedding generation failed (non-fatal)', {
      error: embeddingError instanceof Error ? embeddingError.message : String(embeddingError),
    });
  }

  if (result.embeddingFailedChunks > 0) {
    logger.warn('[PageAnalyzeWorker] Embedding phase completed with failures', {
      embeddingFailedChunks: result.embeddingFailedChunks,
      sectionEmbeddingsGenerated: result.sectionEmbeddingsGenerated,
      motionEmbeddingsGenerated: result.motionEmbeddingsGenerated,
      bgEmbeddingsGenerated: result.bgEmbeddingsGenerated,
      jsAnimationEmbeddingsGenerated: result.jsAnimationEmbeddingsGenerated,
      responsiveEmbeddingsGenerated: result.responsiveEmbeddingsGenerated,
    });
  }

  return result;
}

// ============================================================================
// Worker Process Function
// ============================================================================

/**
 * Process a page analysis job
 *
 * @param job - BullMQ Job instance
 * @param token - Worker token for lock extension (provided by BullMQ Worker)
 * @returns Job result
 */
async function processPageAnalyzeJob(
  job: Job<PageAnalyzeJobData, PageAnalyzeJobResult>,
  token?: string
): Promise<PageAnalyzeJobResult> {
  const startTime = Date.now();
  const { webPageId, url, options } = job.data;

  // v0.1.0: actualWebPageId - upsert結果から取得した実際のDB ID
  // URLが既にDB内に存在する場合、既存のIDが使用される（webPageIdは新規作成時のみ）
  let actualWebPageId = webPageId;

  // Lock extension: Create periodic lock extender as secondary protection
  // BullMQ's built-in lockRenewTime (lockDuration/2) handles the primary case,
  // but CPU-bound phases (Ollama Vision) may block the event loop.
  const effectiveToken = token ?? job.token ?? '';
  const effectiveLockDuration = DEFAULT_LOCK_DURATION;
  const lockExtender = createLockExtender(
    job,
    effectiveToken,
    effectiveLockDuration,
    DEFAULT_LOCK_EXTEND_INTERVAL
  );

  // Start lock extender before processing phases
  lockExtender.start();

  if (isDevelopment()) {
    logger.info('[PageAnalyzeWorker] Processing job', {
      jobId: job.id,
      webPageId,
      url,
      options,
      lockExtension: {
        lockDuration: effectiveLockDuration,
        extendInterval: DEFAULT_LOCK_EXTEND_INTERVAL,
        hasToken: !!effectiveToken,
      },
    });
  }

  // Initialize status tracker for progress reporting
  // Send detailed progress data including currentPhase and phases for SSE clients
  const statusTracker = new ExecutionStatusTrackerV2({
    webPageId,
    url,
    onStatusChange: (status): void => {
      // Build detailed progress data for SSE consumers
      const progressData = {
        overallProgress: status.overallProgress,
        currentPhase: status.currentPhase,
        phases: status.phases,
        webPageId: status.webPageId,
        url: status.url,
        startedAt: status.startedAt.toISOString(),
        lastUpdatedAt: status.lastUpdatedAt.toISOString(),
        estimatedCompletion: status.estimatedCompletion?.toISOString(),
      };

      job.updateProgress(progressData).catch((err) => {
        if (isDevelopment()) {
          logger.warn('[PageAnalyzeWorker] Failed to update job progress', {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },
  });

  statusTracker.initialize();

  const completedPhases: AnalysisPhase[] = [];
  const failedPhases: AnalysisPhase[] = [];
  const results: PageAnalyzeJobResult['results'] = {};
  let layoutResultForNarrative: LayoutServiceResult | null = null;

  // Hoisted for Embedding phase access
  let sectionSaveResult: SaveResult | null = null;
  let motionSaveResult: SaveResult | null = null;
  let jsSaveResult: SaveResult | null = null;
  let bgSaveResult: SaveBackgroundDesignsResult | null = null;
  let motionResultForEmbedding: MotionServiceResult | null = null;
  let jsAnimationsForEmbedding: JSAnimationFullResult | null = null;
  let scrollVisionSaveResult: SaveScrollVisionResult | null = null;
  let scrollVisionResultForEmbedding: ScrollVisionResult | null = null;
  // P0-2: Deferred scroll vision analysis - captures stored here during Phase 1.5,
  // analyzed in Phase 2.5 after browser close to avoid VRAM conflict (Ollama + Chromium)
  let scrollVisionCapturesForDeferred: ScrollCapture[] | null = null;

  try {
    // =====================================================
    // Phase 0: Ingest (HTML取得)
    // =====================================================
    statusTracker.startPhase('initializing');
    await job.updateProgress(PHASE_PROGRESS.INGEST_START);

    if (isDevelopment()) {
      logger.debug('[PageAnalyzeWorker] Starting HTML fetch', { url });
    }

    const fetchTimeout = options.timeout ?? 60000;
    const ingestOptions: IngestAdapterOptions & { url: string } = {
      url,
      timeout: fetchTimeout,
      // PageIngestAdapter features: DOM stability, WebGL detection, user interaction
      waitForDomStable: true,
      simulateUserInteraction: true,
      skipScreenshot: false,
      ...(options.layoutOptions?.viewport ? {
        viewport: { width: options.layoutOptions.viewport.width, height: options.layoutOptions.viewport.height },
      } : {}),
    };
    const ingestResult = await pageIngestAdapter.ingest(ingestOptions);

    if (!ingestResult.success || !ingestResult.html) {
      throw new Error(ingestResult.error ?? 'Failed to fetch HTML content');
    }

    let html: string | null = ingestResult.html;
    // Extract screenshot reference early; ingestResult will be released after Phase 0.5
    let screenshotBase64: string | undefined = ingestResult.screenshots?.[0]?.data;
    statusTracker.completePhase('initializing');
    completedPhases.push('ingest');
    await job.updateProgress(PHASE_PROGRESS.INGEST_COMPLETE);

    // =====================================================
    // Browser sharing: PageIngestAdapterのブラウザを再利用（4→1プロセス削減）
    // ScrollVision, JSAnimation, WebGL検出で共有し、OOMクラッシュを防止
    // =====================================================
    const sharedBrowser = await pageIngestAdapter.getSharedBrowser();

    if (isDevelopment()) {
      logger.debug('[PageAnalyzeWorker] HTML fetch completed', {
        htmlLength: html.length,
        hasScreenshot: !!screenshotBase64,
        sharedBrowserConnected: sharedBrowser.isConnected(),
      });
    }

    // =====================================================
    // HTML size pre-degradation check
    // =====================================================
    // Heavy JS sites produce large HTML; preemptively disable expensive phases
    // to prevent OOM before memory pressure actually builds up
    let narrativePreDisabled = false;
    let visionPreDisabled = false;

    if (html.length > HTML_HUGE_THRESHOLD) {
      logger.warn('[PageAnalyzeWorker] [Large HTML] Disabling narrative+vision', {
        htmlLength: html.length,
        threshold: HTML_HUGE_THRESHOLD,
        url,
      });
      narrativePreDisabled = true;
      visionPreDisabled = true;
    } else if (html.length > HTML_LARGE_THRESHOLD) {
      logger.warn('[PageAnalyzeWorker] [Large HTML] Disabling vision LLM', {
        htmlLength: html.length,
        threshold: HTML_LARGE_THRESHOLD,
        url,
      });
      visionPreDisabled = true;
    }

    // =====================================================
    // Phase 0.5: WebPage DB保存（async mode固有）
    // =====================================================
    // saveToDb が明示的に false でない限り、WebPageレコードを保存
    // これにより layout.inspect(pageId=webPageId) でのNOT_FOUNDを防止
    if (options.layoutOptions?.saveToDb !== false) {
      try {
        // HTMLをサニタイズ（XSS対策 - DB保存用）
        // preserveDocumentStructure: true でドキュメント構造を保持
        // aXeアクセシビリティ検証で<html lang>と<title>が必要
        // セキュリティ契約: 1.5MB超のHTMLではDOMPurifyがバイパスされ、
        // preStripDangerousTagsのみ適用される。この場合、属性ベースXSS
        // (onerror, javascript:URL等)が残存する。このHTMLはDB保存専用であり、
        // ブラウザで直接レンダリングしてはならない。
        const sanitizedHtml = sanitizeHtml(html, { preserveDocumentStructure: true });
        const htmlHash = createHash('sha256').update(sanitizedHtml).digest('hex');

        // URLを正規化（末尾スラッシュ除去等）して重複を防止
        const normalizedUrl = normalizeUrlForStorage(url);

        // WebPageテーブルに保存（upsert: URLが重複する場合は更新）
        // v0.1.0: upsertの結果から実際のIDを取得（既存レコードの場合は既存IDが返される）
        const upsertResult = await prisma.webPage.upsert({
          where: { url: normalizedUrl },
          create: {
            id: webPageId,
            url: normalizedUrl,
            title: null,
            description: null,
            sourceType: 'user_provided',
            usageScope: 'inspiration_only',
            htmlContent: sanitizedHtml,
            htmlHash,
            crawledAt: new Date(),
            analysisStatus: 'pending',
          },
          update: {
            htmlContent: sanitizedHtml,
            htmlHash,
            crawledAt: new Date(),
            analysisStatus: 'pending',
          },
          select: { id: true },
        });

        // v0.1.0: actualWebPageIdを更新（layout.inspect等で正しいIDを使用するため）
        actualWebPageId = upsertResult.id;

        if (isDevelopment()) {
          logger.debug('[PageAnalyzeWorker] WebPage saved to DB', {
            requestedWebPageId: webPageId,
            actualWebPageId,
            isExistingRecord: webPageId !== actualWebPageId,
            url,
            htmlLength: sanitizedHtml.length,
          });
        }
      } catch (dbError) {
        // DB保存失敗時は警告ログのみ出力し、ジョブは続行
        // Graceful Degradation: DB保存は失敗してもLayout/Motion/Quality解析は実行可能
        const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
        logger.warn('[PageAnalyzeWorker] WebPage DB save failed (continuing job)', {
          webPageId,
          url,
          error: errorMessage,
        });
      }
    }

    // =====================================================
    // Memory Cleanup: Release ingestResult after Phase 0.5
    // html content is held in `html` variable, screenshot in `screenshotBase64`
    // =====================================================
    {
      const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      tryGarbageCollect();
      if (isDevelopment()) {
        const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        logger.debug('[PageAnalyzeWorker] [MemCleanup] ingestResult released', {
          beforeRssMb: beforeRss,
          afterRssMb: afterRss,
          reclaimedMb: beforeRss - afterRss,
        });
      }
    }

    // =====================================================
    // Phase 1: Layout Analysis
    // =====================================================
    if (options.features?.layout !== false) {
      statusTracker.startPhase('layout');
      await job.updateProgress(PHASE_PROGRESS.LAYOUT_START);

      try {
        if (isDevelopment()) {
          logger.debug('[PageAnalyzeWorker] Starting layout analysis');
        }

        const layoutResult = await defaultAnalyzeLayout(
          html,
          {
            useVision: options.layoutOptions?.useVision ?? true,
            fullPage: options.layoutOptions?.fullPage ?? true,
            // MCP-RESP-03: 両形式をサポート（snake_case優先）
            include_html: false,
            includeHtml: false,
            include_screenshot: false,
            includeScreenshot: false,
            fetchExternalCss: true,
            saveToDb: options.layoutOptions?.saveToDb ?? true,
            autoAnalyze: options.layoutOptions?.autoAnalyze ?? true,
            perSectionVision: false,
            visionBatchSize: 3,
            scrollVision: options.layoutOptions?.scrollVision ?? true,
            scrollVisionMaxCaptures: options.layoutOptions?.scrollVisionMaxCaptures ?? 10,
            viewport: options.layoutOptions?.viewport,
          },
          screenshotBase64 ? {
            base64: screenshotBase64,
            mimeType: 'image/png',
          } : undefined,
          undefined,  // computedStyles
          url,        // baseUrl
          undefined,  // preExtractedCssUrls
          undefined,  // visionOptions
          undefined,  // progressContext
          actualWebPageId   // v0.1.0: actualWebPageId（upsertで取得した実際のDB ID）
        );

        statusTracker.completePhase('layout');
        completedPhases.push('layout');
        layoutResultForNarrative = layoutResult; // Narrative分析用に保持
        results.layout = {
          sectionsDetected: layoutResult.sectionCount ?? 0,
          visionUsed: options.layoutOptions?.useVision ?? true,
        };

        if (isDevelopment()) {
          logger.debug('[PageAnalyzeWorker] Layout analysis completed', {
            sectionsDetected: results.layout.sectionsDetected,
          });
        }

        // BackgroundDesign DB保存（layoutResultに含まれる場合）
        if (actualWebPageId && layoutResult.backgroundDesigns && layoutResult.backgroundDesigns.length > 0) {
          try {
            const backgroundDesignsForSave: BackgroundDesignForSave[] = layoutResult.backgroundDesigns.map((bg) => ({
              name: bg.name,
              designType: bg.designType,
              cssValue: bg.cssValue,
              selector: bg.selector,
              positionIndex: bg.positionIndex,
              colorInfo: bg.colorInfo as unknown as Record<string, unknown>,
              gradientInfo: bg.gradientInfo as unknown as Record<string, unknown> | undefined,
              visualProperties: bg.visualProperties as unknown as Record<string, unknown>,
              animationInfo: bg.animationInfo as unknown as Record<string, unknown> | undefined,
              cssImplementation: bg.cssImplementation,
              performance: bg.performance as unknown as Record<string, unknown>,
              confidence: bg.confidence,
              sourceUrl: url,
              usageScope: 'inspiration_only',
            }));

            bgSaveResult = await saveBackgroundDesigns(prisma as unknown as BackgroundDesignPrismaClient, actualWebPageId, backgroundDesignsForSave);

            if (isDevelopment()) {
              logger.info('[PageAnalyzeWorker] BackgroundDesigns saved', {
                count: bgSaveResult.count,
                idMappingSize: bgSaveResult.idMapping.size,
                webPageId: actualWebPageId,
              });
            }
          } catch (bgError) {
            // Graceful Degradation: BackgroundDesign保存失敗はジョブを中断しない
            if (isDevelopment()) {
              logger.warn('[PageAnalyzeWorker] BackgroundDesign save failed', {
                error: bgError instanceof Error ? bgError.message : String(bgError),
              });
            }
          }
        }

        // SectionPattern DB保存（layoutResultに含まれる場合）
        if (actualWebPageId && layoutResult.sections && layoutResult.sections.length > 0) {
          try {
            sectionSaveResult = await saveSectionPatterns(
              prisma as unknown as SectionPatternPrismaClient,
              actualWebPageId,
              layoutResult.sections
            );

            if (isDevelopment()) {
              logger.info('[PageAnalyzeWorker] SectionPatterns saved', {
                count: sectionSaveResult.count,
                webPageId: actualWebPageId,
              });
            }
          } catch (sectionError) {
            // Graceful Degradation: SectionPattern保存失敗はジョブを中断しない
            if (isDevelopment()) {
              logger.warn('[PageAnalyzeWorker] SectionPattern save failed', {
                error: sectionError instanceof Error ? sectionError.message : String(sectionError),
              });
            }
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        statusTracker.failPhase('layout', errorMessage);
        failedPhases.push('layout');

        if (isDevelopment()) {
          logger.warn('[PageAnalyzeWorker] Layout analysis failed', { error: errorMessage });
        }
      }
      await job.updateProgress(PHASE_PROGRESS.LAYOUT_COMPLETE);
    } else {
      statusTracker.skipPhase('layout', 'Disabled by options');
    }

    // =====================================================
    // Ollama Vision Unload (1st point): Free VRAM after Phase 1 (Layout Analysis)
    // Phase 1でuseVision=true（page.analyzeのデフォルト）の場合、
    // Ollama VisionがVRAMにロードされたまま残る。
    // Phase 1.5 (Scroll Capture) のChromium VRAM確保 + Phase 2.5 (Scroll Vision Analysis) の
    // OllamaReadinessProbe VRAM閾値(8192MB)クリアのため、ここで解放する。
    // Phase 2.5でVisionが必要な場合はOllamaが自動再ロードする。
    // 冪等: useVision=falseでVision未ロード時もno-opで安全。
    // =====================================================
    await unloadOllamaVisionModel();

    // =====================================================
    // Phase 1.5: Scroll Vision Smart Capture
    // =====================================================
    // Extend lock before potentially long-running Scroll Vision phase
    await extendJobLock(job, effectiveToken, effectiveLockDuration, 'scroll-vision');

    // Runs after layout analysis to use section boundary positions.
    // Only when: useVision=true AND scrollVision !== false AND layout succeeded with sections.
    const scrollVisionEnabled =
      options.layoutOptions?.useVision !== false &&
      options.layoutOptions?.scrollVision !== false &&
      completedPhases.includes('layout') &&
      layoutResultForNarrative?.sections &&
      Array.isArray(layoutResultForNarrative.sections) &&
      layoutResultForNarrative.sections.length > 0;

    if (scrollVisionEnabled) {
      await job.updateProgress(PHASE_PROGRESS.SCROLL_VISION_START);

      try {
        const layoutSections = layoutResultForNarrative?.sections ?? [];

        if (isDevelopment()) {
          logger.debug('[PageAnalyzeWorker] Starting scroll vision capture (Phase 1.5)', {
            sectionCount: layoutSections.length,
            maxCaptures: options.layoutOptions?.scrollVisionMaxCaptures ?? 10,
          });
        }

        // Extract section boundaries from layout result
        const sectionBoundaries: SectionBoundary[] = layoutSections
          .filter((s: { position?: { startY: number; endY: number } }) =>
            s.position?.startY !== undefined && s.position?.endY !== undefined
          )
          .map((s: { position?: { startY: number; endY: number }; type?: string }, i: number) => ({
            sectionIndex: i,
            startY: s.position?.startY ?? 0,
            endY: s.position?.endY ?? 0,
            sectionType: s.type,
          }));

        if (sectionBoundaries.length >= 2) {
          // P0-2: Phase 1.5 captures only (browser required).
          // Vision analysis (Ollama) is deferred to Phase 2.5 after browser close
          // to avoid VRAM conflict (Chromium 2-4GB + Ollama 7.8GB > RTX 3060 12GB).
          const captureResult = await captureScrollPositions(url, sectionBoundaries, {
            maxCaptures: options.layoutOptions?.scrollVisionMaxCaptures ?? 10,
            waitAfterScrollMs: 800,
            viewport: options.layoutOptions?.viewport,
            sharedBrowser,
          });

          // Store captures for deferred analysis in Phase 2.5
          scrollVisionCapturesForDeferred = captureResult.captures;

          if (isDevelopment()) {
            logger.debug('[PageAnalyzeWorker] Scroll vision capture completed (analysis deferred to Phase 2.5)', {
              capturedPositions: captureResult.captures.length,
            });
          }
        } else {
          if (isDevelopment()) {
            logger.debug('[PageAnalyzeWorker] Scroll vision skipped: insufficient section boundaries', {
              boundaryCount: sectionBoundaries.length,
            });
          }
        }
      } catch (scrollVisionError) {
        // Graceful Degradation: Scroll Vision capture failure does NOT fail the overall job
        const errorMessage = scrollVisionError instanceof Error
          ? scrollVisionError.message
          : String(scrollVisionError);

        if (isDevelopment()) {
          logger.warn('[PageAnalyzeWorker] Scroll vision capture failed (non-fatal)', {
            error: errorMessage,
          });
        }
      }

      await job.updateProgress(PHASE_PROGRESS.SCROLL_VISION_COMPLETE);
    }

    // =====================================================
    // Memory Cleanup: GC after Layout + ScrollVision phases
    // Layout/ScrollVision local variables (layoutResult, captureResult) are
    // block-scoped and already eligible for GC. Trigger collection now
    // before Motion phase allocates new buffers.
    // =====================================================
    {
      const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      tryGarbageCollect();
      if (isDevelopment()) {
        const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        logger.debug('[PageAnalyzeWorker] [MemCleanup] Post-Layout/ScrollVision GC', {
          beforeRssMb: beforeRss,
          afterRssMb: afterRss,
          reclaimedMb: beforeRss - afterRss,
        });
      }
    }

    // =====================================================
    // Phase 2: Motion Detection
    // =====================================================
    if (options.features?.motion !== false) {
      statusTracker.startPhase('motion');
      await job.updateProgress(PHASE_PROGRESS.MOTION_START);

      try {
        if (isDevelopment()) {
          logger.debug('[PageAnalyzeWorker] Starting motion detection');
        }

        // Motion detection timeout: デフォルト3分、最大10分
        // MCP Protocol 60秒制限は async worker 内では適用されないため、長時間検出が可能
        const motionTimeout = Math.min(
          options.motionOptions?.timeout ?? 180000,
          600000 // 最大10分
        );

        const motionResult = await defaultDetectMotion(html, url, {
          fetchExternalCss: true,
          maxPatterns: options.motionOptions?.maxPatterns ?? 100,
          // v0.1.0: WebGLサイト対応 - hybrid modeでCSS+ランタイム検出を実行
          detection_mode: 'hybrid' as const,
          minDuration: 0,
          includeWarnings: true,
          enable_frame_capture: options.motionOptions?.enableFrameCapture ?? false,
          analyze_frames: (options.motionOptions?.enableFrameCapture ?? false) && (options.motionOptions?.analyzeFrames ?? false),
          // v0.1.0: JSアニメーション検出を有効化
          detect_js_animations: options.motionOptions?.detectJsAnimations ?? true,
          // v0.1.0: WebGLアニメーション検出を有効化
          detect_webgl_animations: options.motionOptions?.detectWebglAnimations ?? true,
          saveToDb: options.motionOptions?.saveToDb ?? true,
          // v0.1.0: Motion検出タイムアウト（async workerでは長時間検出可能）
          timeout: motionTimeout,
          // video_options は完全なオブジェクトとして渡す（Zod output型に合わせる）
          video_options: {
            timeout: motionTimeout,
            record_duration: 5000,
            scroll_page: true,
            move_mouse: true,
            wait_until: 'domcontentloaded' as const,
          },
        }, {
          prisma: prisma as unknown as IPageAnalyzePrismaClient,
          webPageId: actualWebPageId,
          sourceUrl: url,
        } satisfies MotionDetectionContext, undefined, undefined, sharedBrowser);

        motionResultForEmbedding = motionResult;

        // Granular progress: motion detection complete (halfway through motion phase)
        await job.updateProgress(55);

        statusTracker.completePhase('motion');
        completedPhases.push('motion');
        const patternsDetected = motionResult.patterns?.length ?? 0;
        const jsAnimationsDetected = motionResult.js_animations?.totalDetected ?? 0;
        const webglCount = motionResult.webgl_animation_summary?.totalPatterns ?? 0;
        results.motion = {
          patternsDetected,
          jsAnimationsDetected,
          webglAnimationsDetected: webglCount > 0 ? webglCount : undefined,
        };

        if (isDevelopment()) {
          logger.debug('[PageAnalyzeWorker] Motion detection completed', {
            patternsDetected,
            jsAnimationsDetected,
            webglAnimationsDetected: webglCount > 0 ? webglCount : undefined,
          });
        }

        // MotionPattern DB保存
        if (actualWebPageId && motionResult.patterns && motionResult.patterns.length > 0) {
          try {
            motionSaveResult = await saveMotionPatterns(
              prisma as unknown as MotionPatternPrismaClient,
              actualWebPageId,
              motionResult.patterns,
              url
            );

            if (isDevelopment()) {
              logger.info('[PageAnalyzeWorker] MotionPatterns saved', {
                count: motionSaveResult.count,
                webPageId: actualWebPageId,
              });
            }
          } catch (motionSaveError) {
            // Graceful Degradation: MotionPattern保存失敗はジョブを中断しない
            if (isDevelopment()) {
              logger.warn('[PageAnalyzeWorker] MotionPattern save failed', {
                error: motionSaveError instanceof Error ? motionSaveError.message : String(motionSaveError),
              });
            }
          }
        }

        // JSAnimationPattern DB保存
        if (actualWebPageId && motionResult.js_animations && motionResult.js_animations.totalDetected > 0) {
          jsAnimationsForEmbedding = motionResult.js_animations;

          // Path A (handler) で既に保存済みの場合はスキップ（double-save防止）
          // Path A は CDP + Web + Library パターンを保存するため、Path B より完全
          if (motionResult.jsSavedPatternCount !== undefined && motionResult.jsSavedPatternCount > 0) {
            jsSaveResult = {
              success: true,
              count: motionResult.jsSavedPatternCount,
              ids: [],
              idMapping: new Map(),
            };

            if (isDevelopment()) {
              logger.info('[PageAnalyzeWorker] JSAnimationPatterns already saved by handler (Path A), skipping worker save', {
                savedCount: motionResult.jsSavedPatternCount,
                webPageId: actualWebPageId,
              });
            }
          } else {
            // Path A が保存しなかった場合のフォールバック（Path B）
            try {
              jsSaveResult = await saveJsAnimationPatterns(
                prisma as unknown as JsAnimationPatternPrismaClient,
                actualWebPageId,
                motionResult.js_animations,
                url
              );

              if (isDevelopment()) {
                logger.info('[PageAnalyzeWorker] JSAnimationPatterns saved (Path B fallback)', {
                  count: jsSaveResult.count,
                  webPageId: actualWebPageId,
                  cdpCount: motionResult.js_animations.cdpAnimations.length,
                  webAnimCount: motionResult.js_animations.webAnimations.length,
                });
              }
            } catch (jsSaveError) {
              // Graceful Degradation: JSAnimationPattern保存失敗はジョブを中断しない
              if (isDevelopment()) {
                logger.warn('[PageAnalyzeWorker] JSAnimationPattern save failed', {
                  error: jsSaveError instanceof Error ? jsSaveError.message : String(jsSaveError),
                });
              }
            }
          }
        }

        // Frame Analysis DB保存（analyze_frames=true かつ frame_analysis結果がある場合）
        if (actualWebPageId && motionResult.frame_analysis) {
          const frameAnalysisSaveResult = await saveFrameAnalysisToDb({
            frameAnalysis: motionResult.frame_analysis,
            frameCapture: motionResult.frame_capture,
            webPageId: actualWebPageId,
            sourceUrl: url,
          });

          if (isDevelopment()) {
            logger.info('[PageAnalyzeWorker] Frame analysis DB save result', {
              saved: frameAnalysisSaveResult.saved,
              error: frameAnalysisSaveResult.error,
              skipped: frameAnalysisSaveResult.skipped,
            });
          }
        }

        // Granular progress: motion DB saves complete
        await job.updateProgress(60);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        statusTracker.failPhase('motion', errorMessage);
        failedPhases.push('motion');

        if (isDevelopment()) {
          logger.warn('[PageAnalyzeWorker] Motion detection failed', { error: errorMessage });
        }
      }
      await job.updateProgress(PHASE_PROGRESS.MOTION_COMPLETE);
    } else {
      statusTracker.skipPhase('motion', 'Disabled by options');
    }

    // =====================================================
    // Memory Cleanup: Close shared browser + GC after Motion phase
    // Chromium consumes 2-6GB RSS; releasing it before Phase 3+
    // prevents OOM during Quality/Narrative/Embedding phases.
    // motionResult (block-scoped) holds HTML buffers and intermediate detection data.
    // motionResultForEmbedding retains only patterns needed for embedding.
    // =====================================================
    {
      const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);

      // Close shared browser to reclaim Chromium memory (2-6GB)
      // pageIngestAdapter.close() sets this.browser = null after closing
      try {
        logger.info('[PageAnalyzeWorker] [MemCleanup] Closing shared browser after Motion phase');
        await pageIngestAdapter.close();
      } catch (browserCloseError) {
        // Browser close failure must not crash the worker
        logger.warn('[PageAnalyzeWorker] [MemCleanup] Failed to close shared browser (non-fatal)', {
          error: browserCloseError instanceof Error ? browserCloseError.message : String(browserCloseError),
        });
      }

      tryGarbageCollect();
      if (isDevelopment()) {
        const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        logger.debug('[PageAnalyzeWorker] [MemCleanup] Post-Motion GC (browser closed)', {
          beforeRssMb: beforeRss,
          afterRssMb: afterRss,
          reclaimedMb: beforeRss - afterRss,
        });
      }
    }

    // =====================================================
    // Phase 2.5: Scroll Vision Analysis (deferred from Phase 1.5)
    // P0-2: Ollama Vision analysis runs AFTER browser close to avoid
    // VRAM conflict (Chromium 2-4GB + Ollama llama3.2-vision 7.8GB > RTX 3060 12GB).
    // Captures were stored in scrollVisionCapturesForDeferred during Phase 1.5.
    // =====================================================
    if (scrollVisionCapturesForDeferred && scrollVisionCapturesForDeferred.length > 0) {
      await extendJobLock(job, effectiveToken, effectiveLockDuration, 'scroll-vision-analysis');

      try {
        // GPU Resource Manager: Acquire GPU for Vision analysis (unloads ONNX if on GPU)
        try {
          const visionAcquireResult = await gpuResourceManager.acquireForVision();
          logger.debug('[PageAnalyzeWorker] GPU acquired for vision', { result: visionAcquireResult });
        } catch (gpuError) {
          logger.warn('[PageAnalyzeWorker] GPU acquire for vision failed, continuing with default mode', {
            error: gpuError instanceof Error ? gpuError.message : String(gpuError),
          });
          // Continue without GPU management - Ollama will use whatever resources are available
        }

        // P2-8: VRAM Readiness Probe - Ollama Vision実行前にGPU VRAM空き容量を確認
        const readinessProbe = new OllamaReadinessProbe();
        const probeResult = await readinessProbe.check();

        if (!probeResult.ready) {
          if (isDevelopment()) {
            logger.warn('[PageAnalyzeWorker] Ollama readiness probe failed, skipping scroll vision analysis', {
              reason: probeResult.reason,
              vram: probeResult.vram,
              waitRetries: probeResult.waitRetries,
              totalWaitMs: probeResult.totalWaitMs,
            });
          }
          // Graceful Degradation: VRAM不足時はVision分析をスキップ（ジョブは継続）
          scrollVisionCapturesForDeferred = null;
        }

        if (scrollVisionCapturesForDeferred && scrollVisionCapturesForDeferred.length > 0) {
          if (isDevelopment()) {
            logger.debug('[PageAnalyzeWorker] Starting deferred scroll vision analysis (Phase 2.5)', {
              captureCount: scrollVisionCapturesForDeferred.length,
              vramFreeMb: probeResult.vram?.freeMb,
              probeWaitRetries: probeResult.waitRetries,
            });
          }

          const visionResult: ScrollVisionResult = await analyzeScrollCaptures(scrollVisionCapturesForDeferred, {
            onProgress: createPhaseProgressInterpolator(job, PHASE_PROGRESS.SCROLL_VISION_START, PHASE_PROGRESS.SCROLL_VISION_COMPLETE),
          });
          scrollVisionResultForEmbedding = visionResult;

          // Merge scroll vision results into layout results
          if (results.layout) {
            results.layout.scrollVisionAnalyzed = true;
            results.layout.scrollTriggeredAnimations = visionResult.scrollTriggeredAnimations.length;
          }

          // Save scroll vision results to DB (MotionPattern table)
          if (visionResult.scrollTriggeredAnimations.length > 0) {
            scrollVisionSaveResult = await saveScrollVisionResults(
              prisma as unknown as ScrollVisionPrismaClient,
              actualWebPageId,
              visionResult,
              url
            );

            if (isDevelopment()) {
              logger.debug('[PageAnalyzeWorker] Scroll vision DB save', {
                success: scrollVisionSaveResult.success,
                count: scrollVisionSaveResult.count,
                idMappingSize: scrollVisionSaveResult.idMapping.size,
                error: scrollVisionSaveResult.error,
              });
            }
          }

          if (isDevelopment()) {
            logger.debug('[PageAnalyzeWorker] Deferred scroll vision analysis completed (Phase 2.5)', {
              scrollTriggeredAnimations: visionResult.scrollTriggeredAnimations.length,
            });
          }
        }
      } catch (scrollVisionError) {
        // Graceful Degradation: Scroll Vision analysis failure does NOT fail the overall job
        const errorMessage = scrollVisionError instanceof Error
          ? scrollVisionError.message
          : String(scrollVisionError);

        if (isDevelopment()) {
          logger.warn('[PageAnalyzeWorker] Deferred scroll vision analysis failed (non-fatal)', {
            error: errorMessage,
          });
        }
      }

      // Release capture buffers after analysis (PNG screenshots can be 5-20MB total)
      scrollVisionCapturesForDeferred = null;
      tryGarbageCollect();
    }

    // =====================================================
    // Ollama Vision Unload (2nd point): Free RAM after Phase 2.5 (Scroll Vision Analysis)
    // Phase 2.5でOllama Visionを使用した場合、Phase 3 (Quality) に向けてメモリを解放。
    // CPU-only環境(16GB RAM)ではPhase 3実行時のOOM回避に寄与する。
    // Phase 4 (Narrative) でVisionが必要な場合はOllamaが自動再ロードする。
    // 冪等: Phase 2.5でVisionを使わなかった場合もno-opで安全。
    // Note: GpuResourceManager.currentOwnerは'vision'のまま残るが、
    // Phase 5のacquireForEmbedding()で再度unloadが呼ばれても冪等のため実害なし。
    // 3箇所戦略: 1st=Phase 1完了後, 2nd=ここ(Phase 2.5完了後), 3rd=Phase 4完了後
    // =====================================================
    await unloadOllamaVisionModel();

    // =====================================================
    // Memory Check 1: Before Phase 3 (Quality)
    // =====================================================
    let memoryAborted = false;
    {
      const memCheck1 = checkMemoryPressure();
      if (memCheck1.shouldAbort) {
        logger.warn('[PageAnalyzeWorker] [Memory Critical] Skipping quality/narrative, saving collected data', {
          rssMb: memCheck1.rssMb,
          threshold: MEMORY_CRITICAL_THRESHOLD_MB,
          url,
        });
        memoryAborted = true;
      }
    }

    // =====================================================
    // Phase 3: Quality Evaluation
    // =====================================================
    if (!memoryAborted && options.features?.quality !== false) {
      statusTracker.startPhase('quality');
      await job.updateProgress(PHASE_PROGRESS.QUALITY_START);

      try {
        if (isDevelopment()) {
          logger.debug('[PageAnalyzeWorker] Starting quality evaluation');
        }

        const qualityResult = await defaultEvaluateQuality(html, {
          strict: options.qualityOptions?.strict ?? false,
          includeRecommendations: true,
          weights: options.qualityOptions?.weights ? {
            originality: options.qualityOptions.weights.originality ?? 0.35,
            craftsmanship: options.qualityOptions.weights.craftsmanship ?? 0.4,
            contextuality: options.qualityOptions.weights.contextuality ?? 0.25,
          } : undefined,
          targetIndustry: options.qualityOptions?.targetIndustry,
          targetAudience: options.qualityOptions?.targetAudience,
        });

        statusTracker.completePhase('quality');
        completedPhases.push('quality');
        results.quality = {
          overallScore: qualityResult.overallScore ?? 0,
          grade: qualityResult.grade ?? 'F',
        };

        if (isDevelopment()) {
          logger.debug('[PageAnalyzeWorker] Quality evaluation completed', {
            overallScore: results.quality.overallScore,
            grade: results.quality.grade,
          });
        }

        // QualityEvaluation DB保存
        if (actualWebPageId && qualityResult.success) {
          try {
            const qualitySaveResult = await saveQualityEvaluation(
              prisma as unknown as QualityEvaluationPrismaClient,
              actualWebPageId,
              qualityResult,
              {
                strict: options.qualityOptions?.strict,
                targetIndustry: options.qualityOptions?.targetIndustry,
                targetAudience: options.qualityOptions?.targetAudience,
              }
            );

            if (isDevelopment()) {
              logger.info('[PageAnalyzeWorker] QualityEvaluation saved', {
                count: qualitySaveResult.count,
                webPageId: actualWebPageId,
              });
            }
          } catch (qualitySaveError) {
            // Graceful Degradation: QualityEvaluation save failed はジョブを中断しない
            if (isDevelopment()) {
              logger.warn('[PageAnalyzeWorker] QualityEvaluation save failed', {
                error: qualitySaveError instanceof Error ? qualitySaveError.message : String(qualitySaveError),
              });
            }
          }

          // QualityBenchmark DB保存
          try {
            const benchmarkInputs = buildQualityBenchmarkInputs(
              qualityResult,
              url,
              {
                targetIndustry: options.qualityOptions?.targetIndustry,
                targetAudience: options.qualityOptions?.targetAudience,
              }
            );

            if (benchmarkInputs.length > 0) {
              const benchmarkSaveResult = await saveQualityBenchmarks(
                prisma as unknown as QualityBenchmarkPrismaClient,
                actualWebPageId,
                benchmarkInputs
              );

              if (isDevelopment()) {
                logger.info('[PageAnalyzeWorker] QualityBenchmarks saved', {
                  count: benchmarkSaveResult.count,
                  webPageId: actualWebPageId,
                });
              }
            }
          } catch (benchmarkSaveError) {
            // Graceful Degradation: QualityBenchmark save failed はジョブを中断しない
            if (isDevelopment()) {
              logger.warn('[PageAnalyzeWorker] QualityBenchmark save failed', {
                error: benchmarkSaveError instanceof Error ? benchmarkSaveError.message : String(benchmarkSaveError),
              });
            }
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        statusTracker.failPhase('quality', errorMessage);
        failedPhases.push('quality');

        if (isDevelopment()) {
          logger.warn('[PageAnalyzeWorker] Quality evaluation failed', { error: errorMessage });
        }
      }
      await job.updateProgress(PHASE_PROGRESS.QUALITY_COMPLETE);
    } else if (memoryAborted) {
      statusTracker.skipPhase('quality', 'Skipped due to memory pressure');
    } else {
      statusTracker.skipPhase('quality', 'Disabled by options');
    }

    // =====================================================
    // Memory Cleanup: GC after Quality phase
    // qualityResult (block-scoped) holds evaluation data no longer needed.
    // This is the critical cleanup point before Narrative - the most
    // frequently skipped phase due to memory pressure.
    // =====================================================
    {
      const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      tryGarbageCollect();
      if (isDevelopment()) {
        const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        logger.debug('[PageAnalyzeWorker] [MemCleanup] Post-Quality GC', {
          beforeRssMb: beforeRss,
          afterRssMb: afterRss,
          reclaimedMb: beforeRss - afterRss,
        });
      }
    }

    // =====================================================
    // Memory Check 2: Before Phase 4 (Narrative)
    // =====================================================
    if (!memoryAborted) {
      const memCheck2 = checkMemoryPressure();
      if (memCheck2.shouldAbort) {
        logger.warn('[PageAnalyzeWorker] [Memory Critical] Skipping narrative, saving collected data', {
          rssMb: memCheck2.rssMb,
          threshold: MEMORY_CRITICAL_THRESHOLD_MB,
          url,
        });
        memoryAborted = true;
      } else if (memCheck2.shouldDegrade) {
        logger.warn('[PageAnalyzeWorker] [Memory Pressure] Disabling narrative/vision for this job', {
          rssMb: memCheck2.rssMb,
          threshold: MEMORY_DEGRADATION_THRESHOLD_MB,
          url,
        });
        narrativePreDisabled = true;
        visionPreDisabled = true;
      }
    }

    // =====================================================
    // Phase 4: Narrative Analysis
    // =====================================================
    // Extend lock before potentially long-running Narrative/Vision phase
    await extendJobLock(job, effectiveToken, effectiveLockDuration, 'narrative');

    // Narrative is disabled if: user opt-out, memory aborted, or pre-degradation disabled it
    const narrativeEnabled = !memoryAborted && !narrativePreDisabled && options.narrativeOptions?.enabled !== false;
    if (narrativeEnabled) {
      statusTracker.startPhase('narrative');
      await job.updateProgress(PHASE_PROGRESS.NARRATIVE_START);

      try {
        if (isDevelopment()) {
          logger.info('[PageAnalyzeWorker] Starting narrative analysis', {
            includeVision: options.narrativeOptions?.includeVision ?? true,
            saveToDb: options.narrativeOptions?.saveToDb ?? true,
          });
        }

        // Narrative分析入力を構築
        // visionPreDisabled が true の場合、vision を強制無効化（HTMLサイズ or メモリ圧迫）
        const effectiveIncludeVision = visionPreDisabled ? false : (options.narrativeOptions?.includeVision ?? true);
        const narrativeInput: NarrativeHandlerInput = {
          html,
          narrativeOptions: {
            enabled: true,
            saveToDb: options.narrativeOptions?.saveToDb ?? true,
            includeVision: effectiveIncludeVision,
            visionTimeoutMs: options.narrativeOptions?.visionTimeoutMs ?? 300000,
            generateEmbedding: options.narrativeOptions?.generateEmbedding ?? true,
          },
        };

        // スクリーンショットがある場合は渡す（Vision分析用）
        if (screenshotBase64) {
          narrativeInput.screenshot = screenshotBase64;
        }

        // webPageIdがある場合は渡す（DB保存用）
        if (actualWebPageId) {
          narrativeInput.webPageId = actualWebPageId;
        }

        // 既存分析結果を渡す（Narrative分析の精度向上）
        if (layoutResultForNarrative) {
          narrativeInput.existingAnalysis = {};
          if (layoutResultForNarrative.cssVariables) {
            narrativeInput.existingAnalysis.cssVariables = layoutResultForNarrative.cssVariables;
          }
          if (layoutResultForNarrative.sections) {
            narrativeInput.existingAnalysis.sections = layoutResultForNarrative.sections;
          }
          if (layoutResultForNarrative.visionFeatures) {
            narrativeInput.existingAnalysis.visualFeatures = layoutResultForNarrative.visionFeatures;
          }
          if (layoutResultForNarrative.externalCssContent) {
            narrativeInput.externalCss = layoutResultForNarrative.externalCssContent;
          }
        }

        const narrativeHandlerResult = await handleNarrativeAnalysis(narrativeInput);

        if (narrativeHandlerResult.success && narrativeHandlerResult.narrative) {
          statusTracker.completePhase('narrative');
          completedPhases.push('narrative');
          results.narrative = {
            moodCategory: narrativeHandlerResult.narrative.worldView.moodCategory,
            confidence: narrativeHandlerResult.narrative.confidence ?? 0,
            visionUsed: options.narrativeOptions?.includeVision ?? true,
          };

          if (isDevelopment()) {
            logger.info('[PageAnalyzeWorker] Narrative analysis completed', {
              moodCategory: results.narrative.moodCategory,
              confidence: results.narrative.confidence,
              processingTimeMs: narrativeHandlerResult.processingTimeMs,
              savedId: narrativeHandlerResult.savedId,
            });
          }
        } else if (narrativeHandlerResult.error) {
          throw new Error(narrativeHandlerResult.error.message);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        statusTracker.failPhase('narrative', errorMessage);
        failedPhases.push('narrative');

        if (isDevelopment()) {
          logger.warn('[PageAnalyzeWorker] Narrative analysis failed', { error: errorMessage });
        }
      }
      await job.updateProgress(PHASE_PROGRESS.NARRATIVE_COMPLETE);
    } else if (memoryAborted || narrativePreDisabled) {
      statusTracker.skipPhase('narrative', memoryAborted ? 'Skipped due to memory pressure' : 'Skipped due to large HTML pre-degradation');
    } else {
      statusTracker.skipPhase('narrative', 'Disabled by options');
    }

    // =====================================================
    // Memory Cleanup: GC after Narrative phase
    // narrativeInput and narrativeHandlerResult are block-scoped.
    // This cleanup prepares for the Embedding phase.
    // =====================================================
    {
      const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      tryGarbageCollect();
      if (isDevelopment()) {
        const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        logger.debug('[PageAnalyzeWorker] [MemCleanup] Post-Narrative GC', {
          beforeRssMb: beforeRss,
          afterRssMb: afterRss,
          reclaimedMb: beforeRss - afterRss,
        });
      }
    }

    // =====================================================
    // Ollama Vision Unload (3rd point): Free RAM before Embedding phase
    // CPU-only環境(16GB RAM)でOllama Vision(~10.6GB)がembeddingメモリを圧迫するのを防止。
    // GpuResourceManager.acquireForEmbedding()はGPU無し環境でunloadをスキップするため、
    // ここで明示的にアンロードする。失敗してもnon-fatalで続行。
    // Phase 4 (Narrative) でVisionが再ロードされるため、Embedding前に再度アンロードが必要。
    // 冪等なので多重呼び出しも安全。
    // 3箇所戦略: 1st=Phase 1完了後, 2nd=Phase 2.5完了後, 3rd=ここ(Phase 4完了後)
    // =====================================================
    await unloadOllamaVisionModel();

    // =====================================================
    // Memory Cleanup: Release large buffers before Phase 5 (Embedding)
    // html (15-50MB per large site) and screenshotBase64 (5-15MB)
    // are no longer needed after Phase 4 (Narrative).
    // layoutResultForNarrative is trimmed to keep only sections and
    // backgroundDesigns needed for embedding generation.
    // =====================================================
    {
      const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      html = null;
      screenshotBase64 = undefined;

      // Trim layoutResultForNarrative: keep only sections + backgroundDesigns for embedding
      // Release large fields: externalCssContent, cssSnippet, visionFeatures, cssVariables, etc.
      if (layoutResultForNarrative) {
        delete layoutResultForNarrative.html;
        delete layoutResultForNarrative.cssSnippet;
        delete layoutResultForNarrative.externalCssContent;
        delete layoutResultForNarrative.externalCssMeta;
        delete layoutResultForNarrative.screenshot;
        delete layoutResultForNarrative.visionFeatures;
        delete layoutResultForNarrative.textRepresentation;
        delete layoutResultForNarrative.visualFeatures;
        delete layoutResultForNarrative.cssVariables;
        delete layoutResultForNarrative.cssFramework;
      }

      tryGarbageCollect();
      if (isDevelopment()) {
        const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        logger.debug('[PageAnalyzeWorker] [MemCleanup] Pre-Embedding buffer release', {
          beforeRssMb: beforeRss,
          afterRssMb: afterRss,
          reclaimedMb: beforeRss - afterRss,
          releasedRefs: ['html', 'screenshotBase64'],
          trimmedRefs: ['layoutResultForNarrative (kept: sections, backgroundDesigns)'],
        });
      }
    }

    // =====================================================
    // Phase 4.5: Responsive Analysis
    // =====================================================
    const responsiveEnabled = options.responsiveOptions?.enabled !== false;
    if (responsiveEnabled && actualWebPageId && !memoryAborted) {
      statusTracker.startPhase('responsive');
      await job.updateProgress(PHASE_PROGRESS.RESPONSIVE_START);
      await extendJobLock(job, effectiveToken, effectiveLockDuration, 'responsive');

      try {
        // SSRF対策: URLを検証
        const urlValidation = validateExternalUrl(url);
        if (!urlValidation.valid) {
          if (isDevelopment()) {
            logger.warn('[PageAnalyzeWorker] Responsive SSRF blocked', { url, error: urlValidation.error });
          }
          statusTracker.skipPhase('responsive', `SSRF blocked: ${urlValidation.error}`);
        } else {
          // robots.txt チェック（respect_robots_txt パラメータを伝搬）
          const robotsResult = await isUrlAllowedByRobotsTxt(url, options.respectRobotsTxt);
          if (!robotsResult.allowed) {
            if (isDevelopment()) {
              logger.warn('[PageAnalyzeWorker] Responsive blocked by robots.txt', { url, reason: robotsResult.reason });
            }
            statusTracker.skipPhase('responsive',
              `Robots.txt blocked: ${robotsResult.reason}. ` +
              `Use respect_robots_txt: false to override. ` +
              `Note: Overriding may have legal implications (e.g., EU DSM Directive Article 4).`);
          } else {
            // crawl-delay を取得（秒→ミリ秒変換、上限30秒）
            const MAX_CRAWL_DELAY_MS = 30000;
            const crawlDelayMs = robotsResult.crawlDelay !== undefined
              ? Math.min(robotsResult.crawlDelay * 1000, MAX_CRAWL_DELAY_MS)
              : undefined;

            const responsiveOpts: {
              enabled: boolean;
              viewports?: Array<{ name: string; width: number; height: number }>;
              include_screenshots?: boolean;
              include_diff_images?: boolean;
              diff_threshold?: number;
              detect_navigation?: boolean;
              detect_visibility?: boolean;
              detect_layout?: boolean;
              crawlDelayMs?: number;
            } = { enabled: true };

            const rOpts = options.responsiveOptions;
            if (rOpts?.viewports !== undefined) responsiveOpts.viewports = rOpts.viewports;
            if (rOpts?.include_screenshots !== undefined) responsiveOpts.include_screenshots = rOpts.include_screenshots;
            if (rOpts?.include_diff_images !== undefined) responsiveOpts.include_diff_images = rOpts.include_diff_images;
            if (rOpts?.diff_threshold !== undefined) responsiveOpts.diff_threshold = rOpts.diff_threshold;
            if (rOpts?.detect_navigation !== undefined) responsiveOpts.detect_navigation = rOpts.detect_navigation;
            if (rOpts?.detect_visibility !== undefined) responsiveOpts.detect_visibility = rOpts.detect_visibility;
            if (rOpts?.detect_layout !== undefined) responsiveOpts.detect_layout = rOpts.detect_layout;
            if (crawlDelayMs !== undefined) responsiveOpts.crawlDelayMs = crawlDelayMs;

            // 最大2分のタイムアウト（clearTimeout でタイマーリーク防止）
            const responsiveTimeout = 120000;
            let responsiveTimerId: ReturnType<typeof setTimeout> | undefined;
            const responsiveResult = await Promise.race([
              responsiveAnalysisService.analyze(url, responsiveOpts),
              new Promise<never>((_, reject) => {
                responsiveTimerId = setTimeout(() => reject(new Error('Responsive analysis timeout')), responsiveTimeout);
              }),
            ]).finally(() => {
              if (responsiveTimerId) clearTimeout(responsiveTimerId);
            });

            // DB保存
            const saveToDb = options.responsiveOptions?.save_to_db !== false;
            let responsiveAnalysisId: string | undefined;
            if (saveToDb && responsiveResult) {
              try {
                responsiveAnalysisId = await responsivePersistenceService.save(
                  actualWebPageId,
                  responsiveResult,
                );
              } catch (saveError) {
                if (isDevelopment()) {
                  logger.warn('[PageAnalyzeWorker] Responsive DB save failed', {
                    error: saveError instanceof Error ? saveError.message : String(saveError),
                  });
                }
              }
            }

            results.responsive = {
              differencesDetected: responsiveResult.differences.length,
              breakpointsDetected: responsiveResult.breakpoints.length,
              viewportsAnalyzed: responsiveResult.viewportsAnalyzed.map((v) => ({
                name: v.name,
                width: v.width,
                height: v.height,
              })),
              analysisTimeMs: responsiveResult.analysisTimeMs,
              ...(responsiveAnalysisId ? { responsiveAnalysisId } : {}),
            };

            statusTracker.completePhase('responsive');
            completedPhases.push('responsive');
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        statusTracker.failPhase('responsive', errorMessage);
        if (isDevelopment()) {
          logger.warn('[PageAnalyzeWorker] Responsive analysis failed (graceful degradation)', { error: errorMessage });
        }
        // Graceful degradation: メイン結果に影響しない
      }
      await job.updateProgress(PHASE_PROGRESS.RESPONSIVE_COMPLETE);
    } else if (!responsiveEnabled) {
      statusTracker.skipPhase('responsive', 'Disabled by options');
    } else if (memoryAborted) {
      statusTracker.skipPhase('responsive', 'Skipped due to memory pressure');
    }

    // =====================================================
    // Memory Check 3: Before Phase 5 (Embedding)
    // =====================================================
    // Even under memory pressure, we want to attempt embedding generation
    // because it persists already-collected data to the DB.
    // Just log a warning for observability.
    {
      const memCheck3 = checkMemoryPressure();
      if (memCheck3.shouldAbort) {
        logger.warn('[PageAnalyzeWorker] [Memory Critical] RSS high before embedding, attempting minimal save', {
          rssMb: memCheck3.rssMb,
          threshold: MEMORY_CRITICAL_THRESHOLD_MB,
          url,
        });
      }
    }

    // =====================================================
    // Phase 5: Embedding Generation (delegated to processEmbeddingPhase)
    // =====================================================
    // Extend lock before Embedding phase
    await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding');

    const responsiveAnalysisIdForEmbedding = results.responsive?.responsiveAnalysisId;
    const embeddingEnabled = actualWebPageId &&
      ((sectionSaveResult?.idMapping?.size ?? 0) + (motionSaveResult?.idMapping?.size ?? 0) + (jsSaveResult?.idMapping?.size ?? 0) + (bgSaveResult?.idMapping?.size ?? 0) + (scrollVisionSaveResult?.idMapping?.size ?? 0) > 0
       || !!responsiveAnalysisIdForEmbedding);

    if (embeddingEnabled) {
      // GPU Resource Manager: Acquire GPU for Embedding (unloads Ollama, switches ONNX to CUDA)
      try {
        const embeddingAcquireResult = await gpuResourceManager.acquireForEmbedding();
        logger.debug('[PageAnalyzeWorker] GPU acquired for embedding', {
          acquired: embeddingAcquireResult.acquired,
          fallbackToCpu: embeddingAcquireResult.fallbackToCpu,
        });
      } catch (gpuError) {
        logger.warn('[PageAnalyzeWorker] GPU acquire for embedding failed, using CPU', {
          error: gpuError instanceof Error ? gpuError.message : String(gpuError),
        });
        // Continue with CPU mode - embedding will work, just slower
      }

      await job.updateProgress(PHASE_PROGRESS.EMBEDDING_START);

      const embeddingPhaseResult = await processEmbeddingPhase({
        webPageId: actualWebPageId,
        url,
        job,
        effectiveToken,
        effectiveLockDuration,
        sectionSaveResult,
        motionSaveResult,
        jsSaveResult,
        bgSaveResult,
        scrollVisionSaveResult,
        layoutResultForNarrative,
        motionResultForEmbedding,
        jsAnimationsForEmbedding,
        scrollVisionResultForEmbedding,
        responsiveAnalysisId: responsiveAnalysisIdForEmbedding,
        onProgress: createPhaseProgressInterpolator(job, PHASE_PROGRESS.EMBEDDING_START, PHASE_PROGRESS.EMBEDDING_COMPLETE),
      });

      // Map embedding phase result back to job results
      if (embeddingPhaseResult.sectionEmbeddingsGenerated > 0 ||
          embeddingPhaseResult.motionEmbeddingsGenerated > 0 ||
          embeddingPhaseResult.bgEmbeddingsGenerated > 0 ||
          embeddingPhaseResult.jsAnimationEmbeddingsGenerated > 0 ||
          embeddingPhaseResult.responsiveEmbeddingsGenerated > 0) {
        const embeddingResult: NonNullable<PageAnalyzeJobResult['results']>['embedding'] = {};
        if (embeddingPhaseResult.sectionEmbeddingsGenerated > 0) {
          embeddingResult!.sectionEmbeddingsGenerated = embeddingPhaseResult.sectionEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.motionEmbeddingsGenerated > 0) {
          embeddingResult!.motionEmbeddingsGenerated = embeddingPhaseResult.motionEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.bgEmbeddingsGenerated > 0) {
          embeddingResult!.backgroundDesignEmbeddingsGenerated = embeddingPhaseResult.bgEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.jsAnimationEmbeddingsGenerated > 0) {
          embeddingResult!.jsAnimationEmbeddingsGenerated = embeddingPhaseResult.jsAnimationEmbeddingsGenerated;
        }
        if (embeddingPhaseResult.responsiveEmbeddingsGenerated > 0) {
          embeddingResult!.responsiveEmbeddingsGenerated = embeddingPhaseResult.responsiveEmbeddingsGenerated;
        }
        results.embedding = embeddingResult;
      }

      if (embeddingPhaseResult.completed) {
        completedPhases.push('embedding' as AnalysisPhase);
      }

      await job.updateProgress(PHASE_PROGRESS.EMBEDDING_COMPLETE);

      // =====================================================
      // Post-Embedding Backfill: Detect and repair missing embeddings
      // If Phase 5 partially failed (OOM, memory pressure), some patterns
      // may have been saved to DB but lack embeddings. This step reads
      // from DB, generates embeddings in small chunks, and saves them back.
      // =====================================================
      {
        // Release all in-memory refs to minimize RSS before backfill
        // (backfill reads from DB, so pipeline data is no longer needed)
        layoutResultForNarrative = null;
        motionResultForEmbedding = null;
        jsAnimationsForEmbedding = null;
        scrollVisionResultForEmbedding = null;
        tryGarbageCollect();

        await extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-backfill');

        const coverage = await checkWebPageEmbeddingCoverage(actualWebPageId);
        const totalMissing = coverage.reduce((sum, c) => sum + c.missing, 0);

        if (totalMissing > 0) {
          logger.info('[PageAnalyzeWorker] Post-embedding backfill starting', {
            url,
            webPageId: actualWebPageId,
            totalMissing,
            coverage: coverage.map(c => `${c.type}: ${c.embedded}/${c.total}`),
          });

          const backfillResult = await backfillWebPageEmbeddings(actualWebPageId, {
            chunkSize: 5,
            onProgress: (_type, _done, _total) => {
              // Extend lock on each progress update to prevent stall during backfill
              extendJobLock(job, effectiveToken, effectiveLockDuration, 'backfill-progress').catch(() => {});
            },
          });

          logger.info('[PageAnalyzeWorker] Post-embedding backfill completed', {
            url,
            totalBackfilled: backfillResult.totalBackfilled,
            sectionBackfilled: backfillResult.sectionBackfilled,
            motionBackfilled: backfillResult.motionBackfilled,
            backgroundBackfilled: backfillResult.backgroundBackfilled,
            jsAnimationBackfilled: backfillResult.jsAnimationBackfilled,
            responsiveBackfilled: backfillResult.responsiveBackfilled,
            errors: backfillResult.errors.length,
          });

          // Add backfill results to embedding phase counters
          if (embeddingPhaseResult) {
            embeddingPhaseResult.sectionEmbeddingsGenerated += backfillResult.sectionBackfilled;
            embeddingPhaseResult.motionEmbeddingsGenerated += backfillResult.motionBackfilled;
            embeddingPhaseResult.bgEmbeddingsGenerated += backfillResult.backgroundBackfilled;
            embeddingPhaseResult.jsAnimationEmbeddingsGenerated += backfillResult.jsAnimationBackfilled;
            embeddingPhaseResult.responsiveEmbeddingsGenerated += backfillResult.responsiveBackfilled;

            // Update results object with new totals
            if (backfillResult.totalBackfilled > 0) {
              if (!results.embedding) {
                results.embedding = {};
              }
              results.embedding.sectionEmbeddingsGenerated = embeddingPhaseResult.sectionEmbeddingsGenerated;
              results.embedding.motionEmbeddingsGenerated = embeddingPhaseResult.motionEmbeddingsGenerated;
              results.embedding.backgroundDesignEmbeddingsGenerated = embeddingPhaseResult.bgEmbeddingsGenerated;
              results.embedding.jsAnimationEmbeddingsGenerated = embeddingPhaseResult.jsAnimationEmbeddingsGenerated;
              results.embedding.responsiveEmbeddingsGenerated = embeddingPhaseResult.responsiveEmbeddingsGenerated;
            }
          }
        } else {
          logger.debug('[PageAnalyzeWorker] Post-embedding backfill: no missing embeddings', {
            url,
            webPageId: actualWebPageId,
          });
        }
      }
    }

    // GPU Resource Manager: Release GPU resources for next job's Vision phase
    try {
      await gpuResourceManager.release();
    } catch (gpuError) {
      logger.warn('[PageAnalyzeWorker] GPU release failed (non-fatal)', {
        error: gpuError instanceof Error ? gpuError.message : String(gpuError),
      });
    }

    // =====================================================
    // Memory Cleanup: Release all remaining intermediate data
    // All analysis and embedding phases are complete; release large
    // objects before building the final result.
    // =====================================================
    {
      const beforeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      layoutResultForNarrative = null;
      motionResultForEmbedding = null;
      scrollVisionResultForEmbedding = null;
      jsAnimationsForEmbedding = null;
      tryGarbageCollect();
      if (isDevelopment()) {
        const afterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        logger.debug('[PageAnalyzeWorker] [MemCleanup] Post-Embedding final cleanup', {
          beforeRssMb: beforeRss,
          afterRssMb: afterRss,
          reclaimedMb: beforeRss - afterRss,
          releasedRefs: ['layoutResultForNarrative', 'motionResultForEmbedding', 'scrollVisionResultForEmbedding', 'jsAnimationsForEmbedding'],
        });
      }
    }

    // =====================================================
    // Finalize
    // =====================================================
    statusTracker.startPhase('finalizing');
    statusTracker.completePhase('finalizing');

    const processingTimeMs = Date.now() - startTime;
    const success = failedPhases.length === 0;
    const partialSuccess = !success && completedPhases.length > 0;

    const result: PageAnalyzeJobResult = {
      webPageId: actualWebPageId,  // v0.1.0: 実際のDB IDを返す
      success,
      partialSuccess,
      completedPhases,
      failedPhases,
      processingTimeMs,
      completedAt: new Date().toISOString(),
    };

    // Add results only if there are any (avoid undefined assignment with exactOptionalPropertyTypes)
    if (Object.keys(results).length > 0) {
      result.results = results;
    }

    if (isDevelopment()) {
      logger.info('[PageAnalyzeWorker] Job completed', {
        jobId: job.id,
        requestedWebPageId: webPageId,
        actualWebPageId,
        success,
        partialSuccess,
        completedPhases,
        failedPhases,
        processingTimeMs,
      });
    }

    // =====================================================
    // Pre-return pause: fetchNext=false を保証してレースコンディション防止
    // =====================================================
    // BullMQ moveToCompleted Lua スクリプトは fetchNext=true だと
    // ジョブ完了と同時に次ジョブを取得する。worker.pause(true) で
    // Worker.paused フラグを立てることで fetchNext=false が保証され、
    // WorkerSupervisor の計画的再起動が安全に実行できる。
    if (_preReturnPauseEnabled && _workerInstanceRef) {
      try {
        await _workerInstanceRef.pause(true);
        if (isDevelopment()) {
          logger.info('[PageAnalyzeWorker] Pre-return pause applied (fetchNext=false guaranteed)');
        }
      } catch (pauseError) {
        // pause失敗は致命的でない（WorkerSupervisor側のshutdownでフォールバック）
        logger.warn('[PageAnalyzeWorker] Pre-return pause failed (non-fatal)', {
          error: pauseError instanceof Error ? pauseError.message : String(pauseError),
        });
      }
    }

    // =====================================================
    // Post-job memory self-check (SEC監査 Low #2 対応)
    // =====================================================
    // WorkerSupervisorがジョブカウントで再起動するが、
    // メモリが閾値を超えた場合はワーカー自身でも graceful exit する。
    // これによりOOMキラーによる強制終了を防止する。
    // setImmediate で result を BullMQ に返却した後にチェックする。
    setImmediate(() => {
      performMemoryCheckAndExit();
    });

    return result;
  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('[PageAnalyzeWorker] Job failed with exception', {
      jobId: job.id,
      webPageId,
      error: errorMessage,
      processingTimeMs,
    });

    // Re-throw to let BullMQ record the failure
    // Note: BullMQ will capture the error message from the thrown error
    throw error;
  } finally {
    // Always stop the lock extender to prevent leaked intervals
    lockExtender.stop();
    // SEC-L1: Defensive cleanup - release capture buffers on any exit path
    scrollVisionCapturesForDeferred = null;
  }
}

// ============================================================================
// Worker Factory
// ============================================================================

/**
 * Create a PageAnalyzeWorker instance
 *
 * @param options - Worker configuration options
 * @returns Worker instance with lifecycle methods
 */
export function createPageAnalyzeWorker(
  options: PageAnalyzeWorkerOptions = {}
): PageAnalyzeWorkerInstance {
  const {
    redisConfig,
    concurrency = DEFAULT_CONCURRENCY,
    lockDuration = DEFAULT_LOCK_DURATION,
    verbose = isDevelopment(),
  } = options;

  const config = getRedisConfig(redisConfig);

  if (verbose) {
    logger.info('[PageAnalyzeWorker] Creating worker', {
      queueName: PAGE_ANALYZE_QUEUE_NAME,
      concurrency,
      lockDuration,
      redisHost: config.host,
      redisPort: config.port,
    });
  }

  const worker = new Worker<PageAnalyzeJobData, PageAnalyzeJobResult>(
    PAGE_ANALYZE_QUEUE_NAME,
    processPageAnalyzeJob,
    {
      connection: {
        host: config.host,
        port: config.port,
        maxRetriesPerRequest: config.maxRetriesPerRequest,
      },
      concurrency,
      lockDuration,
      // Stalled job settings (detect stuck jobs)
      // stalledInterval = lockDuration/4 to avoid false stall detection during legitimate long processing
      stalledInterval: Math.max(60000, Math.floor(lockDuration / 4)),
      maxStalledCount: 3, // Allow 3 stalls before failing (CPU-bound embedding phase may block event loop)
    }
  );

  // Set module-level reference for Processor→Worker bridge (pre-return pause)
  _workerInstanceRef = worker;

  // SEC-M1: Pre-return pause は concurrency=1 前提の設計。
  // concurrency > 1 では複数 Processor が同一 Worker に対して pause を呼ぶ可能性がある。
  // BullMQ の pause() は冪等であるため安全だが、設計意図として警告を出す。
  if (concurrency > 1 && _preReturnPauseEnabled) {
    logger.warn(
      '[PageAnalyzeWorker] Pre-return pause is designed for concurrency=1. ' +
      'concurrency > 1 may cause unexpected pause timing.',
      { concurrency }
    );
  }

  // Event handlers for monitoring
  worker.on('completed', (job, result) => {
    if (verbose) {
      logger.info('[PageAnalyzeWorker] Job completed event', {
        jobId: job.id,
        webPageId: result.webPageId,
        success: result.success,
        partialSuccess: result.partialSuccess,
      });
    }

    // P1-D: Notify parent process (WorkerSupervisor) of job completion via IPC
    // This enables maxJobsBeforeRestart planned restarts for OOM prevention
    try {
      process.send?.({ type: 'job-completed', jobId: job.id });
    } catch {
      // IPC channel may be closed if parent is shutting down; non-fatal
    }
  });

  worker.on('failed', (job, error) => {
    logger.error('[PageAnalyzeWorker] Job failed event', {
      jobId: job?.id,
      error: error.message,
    });
  });

  worker.on('error', (error) => {
    logger.error('[PageAnalyzeWorker] Worker error', {
      error: error.message,
    });
  });

  // Stall recovery: Create a Queue instance for job access during stall handling
  const recoveryQueue = createPageAnalyzeQueue(redisConfig);

  // Build StalledJobAccessor for handleStalledJob DI
  const stalledJobAccessor: StalledJobAccessor = {
    getJob: async (stalledJobId: string) => {
      const job = await recoveryQueue.getJob(stalledJobId);
      if (!job || !job.id) return null;
      return {
        id: job.id,
        progress: typeof job.progress === 'number' ? job.progress : 0,
        processedOn: job.processedOn,
        data: {
          webPageId: job.data?.webPageId ?? '',
          url: job.data?.url ?? '',
        },
        moveToFailed: async (err: Error, token: string, fetchNext?: boolean): Promise<void> => {
          await job.moveToFailed(err, token, fetchNext);
        },
        moveToCompleted: async (returnValue: unknown, token: string, fetchNext?: boolean): Promise<void> => {
          await job.moveToCompleted(returnValue as PageAnalyzeJobResult, token, fetchNext);
        },
        getState: async (): Promise<string> => job.getState(),
      };
    },
  };

  // Enhanced stalled event handler: trigger custom recovery
  worker.on('stalled', (jobId) => {
    logger.warn('[PageAnalyzeWorker] Job stalled — triggering recovery', { jobId });
    // Fire-and-forget: recovery runs asynchronously, errors are logged inside handleStalledJob
    handleStalledJob(jobId, stalledJobAccessor)
      .then((result) => {
        if (result.success) {
          logger.info('[PageAnalyzeWorker] Stalled job recovery result', {
            jobId: result.jobId,
            action: result.action,
            category: result.category,
          });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[PageAnalyzeWorker] Stalled job recovery error', { jobId, error: msg });
      });
  });

  // Build DI functions for periodic stall check (reuse from recoverOrphanedJobs pattern)
  const getActiveJobsFn = async (): Promise<OrphanedJobInfo[]> => {
    const activeJobs = await recoveryQueue.getJobs(['active'], 0, 100);
    return activeJobs
      .filter((job) => job.id !== undefined)
      .map((job) => ({
        jobId: job.id ?? '',
        state: 'active',
        progress: typeof job.progress === 'number' ? job.progress : 0,
        processedOn: job.processedOn,
        lockDurationMs: lockDuration,
        data: {
          webPageId: job.data?.webPageId ?? '',
          url: job.data?.url ?? '',
        },
      }));
  };

  const moveToFailedFn = async (failJobId: string, reason: string): Promise<void> => {
    const job = await recoveryQueue.getJob(failJobId);
    if (job) {
      await job.moveToFailed(new Error(reason), '0', false);
    }
  };

  const moveToCompletedFn = async (completeJobId: string): Promise<void> => {
    const job = await recoveryQueue.getJob(completeJobId);
    if (job) {
      await job.moveToCompleted(
        {
          webPageId: job.data?.webPageId ?? '',
          success: true,
          partialSuccess: true,
          completedPhases: [],
          failedPhases: [],
          processingTimeMs: 0,
          completedAt: new Date().toISOString(),
        },
        '0',
        false,
      );
    }
  };

  // Startup recovery: recover orphaned jobs from previous crash/restart
  recoverOrphanedJobs(getActiveJobsFn, moveToFailedFn, moveToCompletedFn, lockDuration)
    .then((result) => {
      if (result.recoveredCount > 0) {
        logger.info('[PageAnalyzeWorker] Startup recovery completed', {
          recoveredCount: result.recoveredCount,
          failedCount: result.failedCount,
        });
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[PageAnalyzeWorker] Startup recovery failed (non-fatal)', { error: msg });
    });

  // Periodic stall check: independent of BullMQ's internal stalledInterval
  const periodicCheck = createPeriodicStallCheck(
    getActiveJobsFn,
    moveToFailedFn,
    moveToCompletedFn,
    { lockDurationMs: lockDuration },
  );

  let isRunning = true;

  return {
    worker,
    close: async (): Promise<void> => {
      if (verbose) {
        logger.info('[PageAnalyzeWorker] Closing worker');
      }
      isRunning = false;
      periodicCheck.stop();
      // Release GPU resources before closing worker
      try {
        await gpuResourceManager.release();
      } catch {
        // Release failure during shutdown is non-fatal
      }
      await recoveryQueue.close();
      await worker.close();
    },
    pause: async (): Promise<void> => {
      if (verbose) {
        logger.info('[PageAnalyzeWorker] Pausing worker (no new jobs will be accepted)');
      }
      await worker.pause();
    },
    isRunning: (): boolean => isRunning,
  };
}

// ============================================================================
// Exports
// ============================================================================

export {
  processPageAnalyzeJob,
  checkMemoryPressure,
  tryGarbageCollect,
  DEFAULT_LOCK_DURATION,
  DEFAULT_LOCK_EXTEND_INTERVAL,
  MEMORY_DEGRADATION_THRESHOLD_MB,
  MEMORY_CRITICAL_THRESHOLD_MB,
  HTML_LARGE_THRESHOLD,
  HTML_HUGE_THRESHOLD,
  EMBEDDING_CHUNK_SIZE,
};
