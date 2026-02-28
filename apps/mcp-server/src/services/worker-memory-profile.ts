// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Memory Profile - システムメモリに基づく動的閾値計算
 *
 * os.totalmem() でシステムメモリを検出し、ワーカープロセスの
 * メモリ閾値・チャンクサイズを動的に計算するモジュール。
 *
 * 32GBマシン（開発基準）では従来のハードコード値と一致し、
 * 8GB/16GB/64GB+マシンでは自動スケールする。
 *
 * 環境変数によるオーバーライドも可能（resolveMemoryConfig）。
 *
 * @module services/worker-memory-profile
 */

import os from 'node:os';
import { safeParseInt } from '../utils/safe-parse-int';
import { logger, isDevelopment } from '../utils/logger';

// =====================================================
// Types
// =====================================================

/**
 * メモリプロファイル - ワーカープロセスの全メモリ閾値
 */
export interface MemoryProfile {
  /** システム総メモリ（MB） */
  totalMemoryMb: number;
  /** 段階的劣化閾値（MB） - メモリ圧力時にチャンクサイズ半減 */
  degradationThresholdMb: number;
  /** 緊急停止閾値（MB） - Embedding処理ループ停止 */
  criticalThresholdMb: number;
  /** ジョブ後自動終了閾値（MB） - shouldExitForMemory() */
  selfExitThresholdMb: number;
  /** V8ヒープ上限（MB） - --max-old-space-size */
  maxOldSpaceSizeMb: number;
  /** Embedding チャンクサイズ（5-30） */
  embeddingChunkSize: number;
  /** JS Animation Embedding チャンクサイズ（5-50） */
  jsAnimationEmbeddingChunkSize: number;
  /** マシン分類 */
  tier: '8gb' | '16gb' | '32gb' | '64gb+';
}

// =====================================================
// Constants
// =====================================================

/** 段階的劣化: 60% of total, cap 12288MB */
const DEGRADATION_RATIO = 0.60;
const DEGRADATION_CAP_MB = 12288;

/** 緊急停止: 70% of total, cap 14336MB */
const CRITICAL_RATIO = 0.70;
const CRITICAL_CAP_MB = 14336;

/** ジョブ後自動終了: 70% of total, cap 12288MB */
const SELF_EXIT_RATIO = 0.70;
const SELF_EXIT_CAP_MB = 12288;

/** V8ヒープ上限: 50% of total, cap 8192MB */
const MAX_OLD_SPACE_RATIO = 0.50;
const MAX_OLD_SPACE_CAP_MB = 8192;

/** Embedding チャンク: 基準マシン 32768MB で 30 */
const EMBED_CHUNK_BASE_MEMORY_MB = 32768;
const EMBED_CHUNK_BASE_SIZE = 30;
const EMBED_CHUNK_MIN = 5;
const EMBED_CHUNK_MAX = 30;

/** JS Animation チャンク: 基準マシン 32768MB で 50 */
const JS_CHUNK_BASE_SIZE = 50;
const JS_CHUNK_MIN = 5;
const JS_CHUNK_MAX = 50;

// =====================================================
// Tier Classification
// =====================================================

const TIER_THRESHOLDS = [
  { maxMb: 12288, tier: '8gb' as const },
  { maxMb: 24576, tier: '16gb' as const },
  { maxMb: 49152, tier: '32gb' as const },
] as const;

/**
 * システムメモリ容量からtierを分類する
 */
function classifyTier(totalMb: number): MemoryProfile['tier'] {
  for (const { maxMb, tier } of TIER_THRESHOLDS) {
    if (totalMb < maxMb) {
      return tier;
    }
  }
  return '64gb+';
}

// =====================================================
// Helper: clamp
// =====================================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// =====================================================
// Core: computeMemoryProfile
// =====================================================

/**
 * システムメモリに基づきワーカーメモリプロファイルを計算する。
 *
 * 32GBマシン（開発基準）では従来のハードコード定数と一致する:
 * - degradation: 12288MB
 * - critical: 14336MB
 * - selfExit: 12288MB
 * - maxOldSpace: 8192MB
 * - embeddingChunkSize: 30
 * - jsAnimationEmbeddingChunkSize: 50
 *
 * @param totalMemoryBytes - 総メモリ（バイト）。省略時は os.totalmem() を使用。
 * @returns MemoryProfile
 */
export function computeMemoryProfile(totalMemoryBytes?: number): MemoryProfile {
  const totalBytes = totalMemoryBytes ?? os.totalmem();
  const totalMb = Math.floor(totalBytes / (1024 * 1024));

  const degradationThresholdMb = Math.min(
    Math.floor(totalMb * DEGRADATION_RATIO),
    DEGRADATION_CAP_MB,
  );

  const criticalThresholdMb = Math.min(
    Math.floor(totalMb * CRITICAL_RATIO),
    CRITICAL_CAP_MB,
  );

  const selfExitThresholdMb = Math.min(
    Math.floor(totalMb * SELF_EXIT_RATIO),
    SELF_EXIT_CAP_MB,
  );

  const maxOldSpaceSizeMb = Math.min(
    Math.floor(totalMb * MAX_OLD_SPACE_RATIO),
    MAX_OLD_SPACE_CAP_MB,
  );

  const embeddingChunkSize = clamp(
    Math.round((totalMb / EMBED_CHUNK_BASE_MEMORY_MB) * EMBED_CHUNK_BASE_SIZE),
    EMBED_CHUNK_MIN,
    EMBED_CHUNK_MAX,
  );

  const jsAnimationEmbeddingChunkSize = clamp(
    Math.round((totalMb / EMBED_CHUNK_BASE_MEMORY_MB) * JS_CHUNK_BASE_SIZE),
    JS_CHUNK_MIN,
    JS_CHUNK_MAX,
  );

  const tier = classifyTier(totalMb);

  return {
    totalMemoryMb: totalMb,
    degradationThresholdMb,
    criticalThresholdMb,
    selfExitThresholdMb,
    maxOldSpaceSizeMb,
    embeddingChunkSize,
    jsAnimationEmbeddingChunkSize,
    tier,
  };
}

// =====================================================
// resolveMemoryConfig: 環境変数オーバーライド付き
// =====================================================

/**
 * 環境変数が設定されていればそれを優先、未設定なら computeMemoryProfile() の値を使う。
 *
 * 対応環境変数:
 * - WORKER_MEMORY_DEGRADATION_MB
 * - WORKER_MEMORY_CRITICAL_MB
 * - WORKER_SELF_EXIT_THRESHOLD_MB
 * - WORKER_MAX_OLD_SPACE_MB
 * - WORKER_EMBEDDING_CHUNK_SIZE
 * - WORKER_JS_ANIMATION_CHUNK_SIZE
 *
 * @returns MemoryProfile（環境変数オーバーライド適用済み）
 */
export function resolveMemoryConfig(): MemoryProfile {
  const baseline = computeMemoryProfile();

  const degradationThresholdMb = safeParseInt(
    process.env.WORKER_MEMORY_DEGRADATION_MB,
    baseline.degradationThresholdMb,
    { min: 1 },
  );

  const criticalThresholdMb = safeParseInt(
    process.env.WORKER_MEMORY_CRITICAL_MB,
    baseline.criticalThresholdMb,
    { min: 1 },
  );

  const selfExitThresholdMb = safeParseInt(
    process.env.WORKER_SELF_EXIT_THRESHOLD_MB,
    baseline.selfExitThresholdMb,
    { min: 1 },
  );

  const maxOldSpaceSizeMb = safeParseInt(
    process.env.WORKER_MAX_OLD_SPACE_MB,
    baseline.maxOldSpaceSizeMb,
    { min: 1 },
  );

  const embeddingChunkSize = safeParseInt(
    process.env.WORKER_EMBEDDING_CHUNK_SIZE,
    baseline.embeddingChunkSize,
    { min: 1 },
  );

  const jsAnimationEmbeddingChunkSize = safeParseInt(
    process.env.WORKER_JS_ANIMATION_CHUNK_SIZE,
    baseline.jsAnimationEmbeddingChunkSize,
    { min: 1 },
  );

  return {
    totalMemoryMb: baseline.totalMemoryMb,
    degradationThresholdMb,
    criticalThresholdMb,
    selfExitThresholdMb,
    maxOldSpaceSizeMb,
    embeddingChunkSize,
    jsAnimationEmbeddingChunkSize,
    tier: baseline.tier,
  };
}

// =====================================================
// Startup Log (1回のみ)
// =====================================================

let logged = false;

/**
 * 起動時ログを1回出力する。
 * 開発環境: 全閾値の詳細ログ
 * 本番環境: tier + totalMb のみ
 */
export function logMemoryProfile(profile: MemoryProfile): void {
  if (logged) return;
  logged = true;

  if (isDevelopment()) {
    logger.info('[WorkerMemoryProfile] Resolved memory profile', {
      tier: profile.tier,
      totalMemoryMb: profile.totalMemoryMb,
      degradationThresholdMb: profile.degradationThresholdMb,
      criticalThresholdMb: profile.criticalThresholdMb,
      selfExitThresholdMb: profile.selfExitThresholdMb,
      maxOldSpaceSizeMb: profile.maxOldSpaceSizeMb,
      embeddingChunkSize: profile.embeddingChunkSize,
      jsAnimationEmbeddingChunkSize: profile.jsAnimationEmbeddingChunkSize,
    });
  } else {
    logger.info(`[WorkerMemoryProfile] tier=${profile.tier} totalMb=${profile.totalMemoryMb}`);
  }
}
