// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scroll Vision Persistence Service
 *
 * ScrollVisionAnalyzer の分析結果をDBに保存するサービス。
 * スクロールトリガーアニメーションを MotionPattern テーブルに保存する。
 *
 * パターン:
 * - クリーンスレート（deleteMany → createMany）でBackgroundDesignと同パターン
 * - vision_detected タイプでCSS検出と区別
 * - Graceful Degradation（保存失敗時もpage.analyzeは継続）
 *
 * @module services/vision/scroll-vision-persistence.service
 */

import { v7 as uuidv7 } from 'uuid';
import { logger, isDevelopment } from '../../utils/logger';
import type { ScrollVisionResult, AggregatedScrollAnimation } from './scroll-vision.analyzer.js';

// =============================================================================
// Types
// =============================================================================

/**
 * 保存結果
 */
export interface SaveScrollVisionResult {
  success: boolean;
  count: number;
  ids: string[];
  /** animationIndex → DB UUIDv7 のマッピング（Embedding生成で使用） */
  idMapping: Map<string, string>;
  error?: string | undefined;
}

/**
 * Prismaクライアントインターフェース（scroll vision保存用）
 *
 * テスト可能にするための最小インターフェース
 */
export interface ScrollVisionPrismaClient {
  motionPattern: {
    deleteMany: (args: { where: { webPageId: string; type: string } }) => Promise<{ count: number }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Vision検出のMotionPatternタイプ識別子
 * CSS静的解析で検出されたものと区別する
 */
const VISION_DETECTED_TYPE = 'vision_detected';

/**
 * ScrollChangeType → MotionPattern category マッピング
 */
const CHANGE_TYPE_TO_CATEGORY: Record<string, string> = {
  appear: 'reveal',
  animate: 'scroll_trigger',
  transform: 'scroll_trigger',
  'lazy-load': 'entrance',
  parallax: 'parallax',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * AggregatedScrollAnimation を MotionPattern のDB保存用データに変換
 */
function animationToMotionPatternData(
  animation: AggregatedScrollAnimation,
  webPageId: string,
  sourceUrl: string
): Record<string, unknown> {
  const id = uuidv7();
  const category = CHANGE_TYPE_TO_CATEGORY[animation.animationType] ?? 'scroll_trigger';

  return {
    id,
    webPageId,
    name: `Scroll-triggered ${animation.animationType}: ${animation.element.slice(0, 100)}`,
    type: VISION_DETECTED_TYPE,
    category,
    triggerType: 'scroll',
    triggerConfig: {
      scrollY: animation.triggerScrollY,
      source: 'scroll_vision',
    },
    animation: {
      duration: 0,
      delay: 0,
      easing: { type: 'unknown' },
      iterations: 1,
      direction: 'normal',
      fill_mode: 'forwards',
      source: 'vision_detected',
    },
    properties: [],
    implementation: {},
    accessibility: {
      respects_reduced_motion: false,
      note: 'Detected via Vision analysis, CSS properties unknown',
    },
    performance: {},
    sourceUrl,
    usageScope: 'inspiration_only',
    tags: ['scroll-vision', animation.animationType],
    metadata: {
      visionConfidence: animation.confidence,
      scrollY: animation.triggerScrollY,
      detectionSource: 'scroll_vision_analyzer',
    },
  };
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * スクロールVision分析結果をDBに保存
 *
 * 1. 既存のvision_detected MotionPatternsを削除（クリーンスレート）
 * 2. 新しいMotionPatternレコードをバッチ作成（createMany）
 *
 * @param prisma - Prismaクライアント（motionPatternモデルを含む）
 * @param webPageId - 対象WebPageのID
 * @param visionResult - ScrollVisionAnalyzerの分析結果
 * @param sourceUrl - 元URL
 * @returns 保存結果
 */
export async function saveScrollVisionResults(
  prisma: ScrollVisionPrismaClient,
  webPageId: string,
  visionResult: ScrollVisionResult,
  sourceUrl: string
): Promise<SaveScrollVisionResult> {
  const animations = visionResult.scrollTriggeredAnimations;

  // 空配列の場合はDB操作をスキップ
  if (animations.length === 0) {
    return { success: true, count: 0, ids: [], idMapping: new Map() };
  }

  try {
    // 1. 既存のvision_detected MotionPatternsを削除（クリーンスレート）
    // CSS検出のMotionPatternsは残す
    await prisma.motionPattern.deleteMany({
      where: { webPageId, type: VISION_DETECTED_TYPE },
    });

    if (isDevelopment()) {
      logger.debug('[ScrollVisionPersistence] Existing vision-detected patterns deleted', {
        webPageId,
      });
    }

    // 2. データ変換
    const ids: string[] = [];
    const idMapping = new Map<string, string>();
    const data = animations.map((animation, index) => {
      const record = animationToMotionPatternData(animation, webPageId, sourceUrl);
      const recordId = record.id as string;
      ids.push(recordId);
      // Embedding生成用: animationのインデックスベースのキーでマッピング
      idMapping.set(`vision_detected_${index}`, recordId);
      return record;
    });

    // 3. バッチインサート
    const result = await prisma.motionPattern.createMany({ data });

    if (isDevelopment()) {
      logger.info('[ScrollVisionPersistence] Saved scroll vision motion patterns', {
        webPageId,
        count: result.count,
        idCount: ids.length,
      });
    }

    return {
      success: true,
      count: result.count,
      ids,
      idMapping,
    };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : 'Failed to save scroll vision results';

    if (isDevelopment()) {
      logger.error('[ScrollVisionPersistence] Save failed', {
        webPageId,
        error: errorMessage,
      });
    }

    return {
      success: false,
      count: 0,
      ids: [],
      idMapping: new Map(),
      error: errorMessage,
    };
  }
}
