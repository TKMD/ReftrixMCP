// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Handler for page.analyze
 * SectionEmbedding/MotionEmbedding/VisionEmbedding/BackgroundDesignEmbedding生成・保存ロジックを分離
 *
 * analyze.tool.tsから抽出した単一責任モジュール
 * - SectionEmbedding生成・保存（text_embedding列）
 * - MotionEmbedding生成・保存
 * - VisionEmbedding生成・保存（vision_embedding列）
 * - BackgroundDesignEmbedding生成・保存（embedding列）
 * - テキスト表現生成ヘルパー
 *
 * @module tools/page/handlers/embedding-handler
 */

import { isDevelopment, logger } from '../../../utils/logger';
import {
  LayoutEmbeddingService,
  saveSectionEmbedding,
  sectionToTextRepresentationWithVision,
  convertToVisionFeaturesForEmbedding,
  type SectionWithVision,
} from '../../../services/layout-embedding.service';
import { getMotionPersistenceService } from '../../../services/motion-persistence.service';
import { saveMotionEmbedding } from '../../../services/motion/frame-embedding.service';
import {
  generateAndSaveVisionEmbedding,
  hasValidVisualFeatures,
} from '../../../services/vision-embedding.service';
import {
  generateBackgroundDesignEmbeddings as generateBgEmbeddings,
  type BackgroundDesignForText,
  type BackgroundDesignEmbeddingResult,
} from '../../../services/background/background-design-embedding.service';
import type { VisualFeatures } from '../../page/schemas';
import type { MotionPatternForEmbedding } from './types';

// Re-export for backward compatibility
export type { MotionPatternForEmbedding };

// =====================================================
// 型定義
// =====================================================

/**
 * セクションデータ（analyze.tool.tsのLayoutServiceResult.sectionsから抽出）
 */
export interface SectionDataForEmbedding {
  id: string;
  type: string;
  positionIndex: number;
  heading?: string;
  confidence: number;
  htmlSnippet?: string;
  visionFeatures?: {
    success: boolean;
    features: Array<{
      type: string;
      confidence: number;
      description?: string;
    }>;
    textRepresentation?: string;
    error?: string;
    processingTimeMs: number;
    modelName: string;
  };
  /** Phase 3-3: VisualFeatures（カラー、テーマ、密度、グラデーション、ムード、ブランドトーン） */
  visualFeatures?: VisualFeatures;
}

/**
 * SectionEmbedding生成オプション
 */
export interface GenerateSectionEmbeddingsOptions {
  /** WebPageのID（exactOptionalPropertyTypes対応: undefined許可） */
  webPageId?: string | undefined;
  /** Granular progress callback: called after each section embedding is processed */
  onProgress?: ((completed: number, total: number) => void) | undefined;
  /**
   * DI: 外部から注入されたLayoutEmbeddingServiceインスタンス。
   * Worker環境ではsharedLayoutEmbeddingServiceを渡してONNXセッションの重複生成を防ぐ。
   * 未指定の場合は内部でフォールバック生成する（同期モードanalyze.tool.ts用）。
   */
  layoutEmbeddingService?: LayoutEmbeddingService | undefined;
}

/**
 * MotionEmbedding生成オプション
 */
export interface GenerateMotionEmbeddingsOptions {
  /** WebPageのID（exactOptionalPropertyTypes対応: undefined許可） */
  webPageId?: string | undefined;
  /** ソースURL */
  sourceUrl: string;
  /**
   * 元のモーションパターンID -> DB保存済みのMotionPattern ID（UUIDv7）のマッピング
   * db-handler.tsで保存済みのパターンIDを使用してEmbeddingのみ生成・保存する
   */
  motionPatternIdMapping?: Map<string, string> | undefined;
  /** Granular progress callback: called after each motion embedding is processed */
  onProgress?: ((completed: number, total: number) => void) | undefined;
}

/**
 * SectionEmbedding生成結果
 */
export interface SectionEmbeddingResult {
  success: boolean;
  generatedCount: number;
  failedCount: number;
  errors: Array<{
    sectionId: string;
    error: string;
  }>;
  /** Phase 3-3: VisionEmbedding生成結果 */
  visionEmbedding?: {
    generatedCount: number;
    failedCount: number;
    errors: Array<{
      sectionId: string;
      error: string;
    }>;
  };
}

/**
 * MotionEmbedding生成結果
 */
export interface MotionEmbeddingResult {
  success: boolean;
  savedCount: number;
  patternIds: string[];
  embeddingIds: string[];
  errors: Array<{
    patternId: string;
    error: string;
  }>;
}

// =====================================================
// SectionPatternInput型（analyze.tool.tsからの再エクスポート用）
// =====================================================

/**
 * セクションパターン入力型（既存のgenerateSectionTextRepresentationと互換）
 */
export interface SectionPatternInput {
  id: string;
  type: string;
  positionIndex: number;
  heading?: string;
  confidence: number;
}

// =====================================================
// MotionEmbedding用 LayoutEmbeddingService DI
// =====================================================

/**
 * LayoutEmbeddingServiceインターフェース（MotionEmbedding用）
 */
export interface ILayoutEmbeddingServiceForMotion {
  generateFromText(text: string): Promise<{ embedding: number[]; modelName: string }>;
}

let motionLayoutEmbeddingServiceFactory: (() => ILayoutEmbeddingServiceForMotion) | null = null;
let motionLayoutEmbeddingServiceSingleton: ILayoutEmbeddingServiceForMotion | null = null;

/**
 * MotionEmbedding用LayoutEmbeddingServiceファクトリを設定（テスト用）
 */
export function setMotionLayoutEmbeddingServiceFactory(
  factory: () => ILayoutEmbeddingServiceForMotion
): void {
  motionLayoutEmbeddingServiceFactory = factory;
  motionLayoutEmbeddingServiceSingleton = null;
}

/**
 * MotionEmbedding用LayoutEmbeddingServiceファクトリをリセット（テスト用）
 */
export function resetMotionLayoutEmbeddingServiceFactory(): void {
  motionLayoutEmbeddingServiceFactory = null;
  motionLayoutEmbeddingServiceSingleton = null;
}

/**
 * MotionEmbedding用LayoutEmbeddingServiceを取得（DI対応、singleton）
 */
function getMotionLayoutEmbeddingService(): ILayoutEmbeddingServiceForMotion {
  if (motionLayoutEmbeddingServiceFactory) {
    return motionLayoutEmbeddingServiceFactory();
  }
  // シングルトンで再利用（毎回new LayoutEmbeddingService()するとメモリリスク）
  if (!motionLayoutEmbeddingServiceSingleton) {
    motionLayoutEmbeddingServiceSingleton = new LayoutEmbeddingService();
  }
  return motionLayoutEmbeddingServiceSingleton;
}

// =====================================================
// テキスト表現生成関数
// =====================================================

/**
 * セクションからEmbedding用テキスト表現を生成（基本版）
 *
 * E5モデル用にpassage:プレフィックスを付与
 * 768次元ベクトル生成に最適化されたテキスト形式
 *
 * @param section - セクションパターン情報
 * @returns Embedding用テキスト表現（passage:プレフィックス付き）
 */
export function generateSectionTextRepresentation(section: SectionPatternInput): string {
  const parts: string[] = [];

  // セクションタイプ
  parts.push(`Section type: ${section.type}`);

  // 見出し
  if (section.heading) {
    parts.push(`Heading: ${section.heading}`);
  }

  // 位置インデックス
  parts.push(`Position: ${section.positionIndex}`);

  // 信頼度
  parts.push(`Confidence: ${(section.confidence * 100).toFixed(0)}%`);

  return `passage: ${parts.join('. ')}.`;
}

// =====================================================
// SectionEmbedding生成・保存
// =====================================================

/**
 * SectionEmbeddingを生成・保存
 *
 * analyze.tool.tsから抽出したロジック
 * - Vision特徴がある場合はリッチなテキスト表現を使用
 * - Vision特徴がない場合は基本情報のみ
 * - Graceful degradation: 個別セクションの失敗は全体を止めない
 *
 * @param sections - セクションデータ配列
 * @param sectionIdMapping - 元ID→DB保存後ID のマッピング
 * @param options - 生成オプション
 * @returns 生成結果
 */
export async function generateSectionEmbeddings(
  sections: SectionDataForEmbedding[],
  sectionIdMapping: Map<string, string>,
  options: GenerateSectionEmbeddingsOptions = {}
): Promise<SectionEmbeddingResult> {
  const result: SectionEmbeddingResult = {
    success: true,
    generatedCount: 0,
    failedCount: 0,
    errors: [],
  };

  if (isDevelopment()) {
    logger.info('[EmbeddingHandler] Starting SectionEmbedding generation', {
      sectionCount: sections.length,
      pageId: options.webPageId,
      idMappingSize: sectionIdMapping.size,
    });
  }

  try {
    let embeddingService: LayoutEmbeddingService;

    if (options.layoutEmbeddingService) {
      // DI: Worker環境ではsharedLayoutEmbeddingServiceを使用
      // P0-1: ジョブ毎のONNXセッション重複生成（~65-100MB/インスタンス）を防ぐ
      // Worker起動時に初期化済みのため検証をスキップ
      embeddingService = options.layoutEmbeddingService;
    } else {
      // フォールバック: 同期モード（analyze.tool.ts）用に新規生成
      // キャッシュ無効にして初期化検証でキャッシュヒットを避ける
      embeddingService = new LayoutEmbeddingService({ cacheEnabled: false });
      // EmbeddingServiceの初期化を検証（ファクトリエラーを早期検出）
      await embeddingService.generateFromText('__init_validation__');
    }

    // Phase 1: テキスト表現を一括生成し、有効なセクションを収集
    const validSections: Array<{
      section: SectionDataForEmbedding;
      dbSectionId: string;
      textRepresentation: string;
      hasVisionFeatures: boolean;
    }> = [];

    for (const section of sections) {
      const dbSectionId = sectionIdMapping.get(section.id);
      if (!dbSectionId) {
        if (isDevelopment()) {
          logger.warn('[EmbeddingHandler] Section ID mapping not found, skipping embedding', {
            originalId: section.id,
          });
        }
        result.failedCount++;
        result.errors.push({
          sectionId: section.id,
          error: 'Section ID mapping not found',
        });
        try { options.onProgress?.(result.generatedCount + result.failedCount, sections.length); } catch { /* fire-and-forget */ }
        continue;
      }

      const hasVisionFeatures = section.visionFeatures?.success === true;
      let textRepresentation: string;

      if (hasVisionFeatures) {
        const sectionWithVision: SectionWithVision = {
          id: section.id,
          type: section.type,
        };
        if (section.heading) {
          sectionWithVision.content = {
            headings: [{ text: section.heading, level: 1 }],
          };
        }
        const convertedVisionFeatures = convertToVisionFeaturesForEmbedding(section.visionFeatures);
        if (convertedVisionFeatures) {
          sectionWithVision.visionFeatures = convertedVisionFeatures;
        }
        textRepresentation = sectionToTextRepresentationWithVision(sectionWithVision);
      } else {
        textRepresentation = generateSectionTextRepresentation(section);
      }

      validSections.push({ section, dbSectionId, textRepresentation, hasVisionFeatures });
    }

    // Phase 2: バッチ推論 — 全テキストを一括でONNX推論
    // generateBatchFromTexts は内部で EmbeddingService.generateBatchEmbeddings() を呼び、
    // BATCH_SIZE=32 ごとにまとめて推論するため、1件ずつ generateFromText() を呼ぶより
    // モデル呼び出しオーバーヘッドが大幅に削減される。
    const allTexts = validSections.map(v => v.textRepresentation);
    let batchEmbeddings: Array<{ embedding: number[] }> = [];

    if (allTexts.length > 0) {
      try {
        batchEmbeddings = await embeddingService.generateBatchFromTexts(allTexts);
      } catch (batchError) {
        // バッチ推論失敗時は個別フォールバック（後続ループで1件ずつ生成）
        if (isDevelopment()) {
          logger.warn('[EmbeddingHandler] Batch embedding failed, falling back to individual', {
            error: batchError instanceof Error ? batchError.message : 'Unknown error',
          });
        }
        batchEmbeddings = [];
      }
    }

    // Phase 3: DB保存 + VisionEmbedding生成（セクションごと）
    for (let i = 0; i < validSections.length; i++) {
      const entry = validSections[i];
      if (!entry) continue;
      const { section, dbSectionId, textRepresentation, hasVisionFeatures } = entry;

      try {
        // バッチ結果があればそれを使用、なければ個別生成（フォールバック）
        let embedding: number[];
        const batchResult = batchEmbeddings[i];
        if (batchResult && batchResult.embedding.length > 0) {
          embedding = batchResult.embedding;
        } else {
          const individualResult = await embeddingService.generateFromText(textRepresentation);
          embedding = individualResult.embedding;
        }

        // DB保存（DB保存後のUUIDv7を使用）
        // Phase 6 P2-4: textRepresentationも永続化
        await saveSectionEmbedding(
          dbSectionId,
          embedding,
          'multilingual-e5-base',
          textRepresentation
        );

        result.generatedCount++;

        if (isDevelopment()) {
          logger.info('[EmbeddingHandler] SectionEmbedding saved', {
            originalSectionId: section.id,
            dbSectionId: dbSectionId,
            sectionType: section.type,
            embeddingDimensions: embedding.length,
            usedVisionFeatures: hasVisionFeatures,
          });
        }

        // =====================================================
        // Phase 3-3: VisionEmbedding生成（visualFeaturesがある場合）
        // =====================================================
        if (hasValidVisualFeatures(section.visualFeatures)) {
          try {
            const visionEmbeddingId = await generateAndSaveVisionEmbedding(
              dbSectionId,
              section.visualFeatures
            );

            // VisionEmbedding結果を初期化（初回のみ）
            if (!result.visionEmbedding) {
              result.visionEmbedding = {
                generatedCount: 0,
                failedCount: 0,
                errors: [],
              };
            }

            if (visionEmbeddingId) {
              result.visionEmbedding.generatedCount++;

              if (isDevelopment()) {
                logger.info('[EmbeddingHandler] VisionEmbedding saved', {
                  originalSectionId: section.id,
                  dbSectionId: dbSectionId,
                  visionEmbeddingId,
                });
              }
            } else {
              result.visionEmbedding.failedCount++;
              result.visionEmbedding.errors.push({
                sectionId: section.id,
                error: 'VisionEmbedding generation returned null (internal error)',
              });

              if (isDevelopment()) {
                logger.warn('[EmbeddingHandler] VisionEmbedding generation returned null', {
                  originalSectionId: section.id,
                  dbSectionId: dbSectionId,
                });
              }
            }
          } catch (visionError) {
            // VisionEmbedding失敗時もtext_embeddingは保存済み（部分成功）
            if (!result.visionEmbedding) {
              result.visionEmbedding = {
                generatedCount: 0,
                failedCount: 0,
                errors: [],
              };
            }
            result.visionEmbedding.failedCount++;
            const visionErrorMessage = visionError instanceof Error ? visionError.message : 'Unknown error';
            result.visionEmbedding.errors.push({
              sectionId: section.id,
              error: visionErrorMessage,
            });

            if (isDevelopment()) {
              logger.warn('[EmbeddingHandler] VisionEmbedding generation failed (partial success)', {
                originalSectionId: section.id,
                dbSectionId: dbSectionId,
                error: visionErrorMessage,
              });
            }
          }
        }
      } catch (embeddingError) {
        // Embedding生成失敗時もSectionPatternは保存済み（部分成功）
        result.failedCount++;
        const errorMessage = embeddingError instanceof Error ? embeddingError.message : 'Unknown error';
        result.errors.push({
          sectionId: section.id,
          error: errorMessage,
        });

        if (isDevelopment()) {
          logger.warn('[EmbeddingHandler] SectionEmbedding generation failed (partial success)', {
            originalSectionId: section.id,
            dbSectionId: dbSectionId,
            error: errorMessage,
          });
        }
      }

      // Granular progress: report after each section (fire-and-forget)
      try { options.onProgress?.(result.generatedCount + result.failedCount, sections.length); } catch { /* fire-and-forget */ }
    }
  } catch (serviceError) {
    // EmbeddingService初期化失敗時
    result.success = false;
    const errorMessage = serviceError instanceof Error ? serviceError.message : 'Unknown error';

    if (isDevelopment()) {
      logger.warn('[EmbeddingHandler] EmbeddingService not available', {
        error: errorMessage,
      });
    }
  }

  return result;
}

// =====================================================
// MotionEmbedding生成・保存
// =====================================================

/**
 * モーションパターンからEmbedding用テキスト表現を生成
 *
 * E5モデル用にpassage:プレフィックスを付与
 * 768次元ベクトル生成に最適化されたテキスト形式
 *
 * @param pattern - モーションパターン情報
 * @returns Embedding用テキスト表現（passage:プレフィックス付き）
 */
export function generateMotionTextRepresentation(pattern: MotionPatternForEmbedding): string {
  const parts: string[] = [];

  // パターンタイプ
  parts.push(`Motion type: ${pattern.type}`);

  // パターン名
  if (pattern.name) {
    parts.push(`Name: ${pattern.name}`);
  }

  // カテゴリ
  parts.push(`Category: ${pattern.category}`);

  // トリガー
  parts.push(`Trigger: ${pattern.trigger}`);

  // Duration
  if (pattern.duration !== undefined) {
    parts.push(`Duration: ${pattern.duration}ms`);
  }

  // Easing
  if (pattern.easing) {
    parts.push(`Easing: ${pattern.easing}`);
  }

  // プロパティ
  if (pattern.properties && pattern.properties.length > 0) {
    parts.push(`Properties: ${pattern.properties.join(', ')}`);
  }

  return `passage: ${parts.join('. ')}.`;
}

/**
 * MotionEmbeddingを生成・保存
 *
 * 修正版: db-handler.tsで保存済みのパターンIDを使用してEmbeddingのみ生成・保存
 * - パターン保存は行わない（二重保存防止）
 * - motionPatternIdMappingから保存済みのパターンIDを取得
 * - Embedding生成・保存のみ実行
 *
 * @param patterns - モーションパターンデータ配列
 * @param options - 生成オプション（motionPatternIdMapping必須）
 * @returns 生成結果
 */
export async function generateMotionEmbeddings(
  patterns: MotionPatternForEmbedding[],
  options: GenerateMotionEmbeddingsOptions
): Promise<MotionEmbeddingResult> {
  const result: MotionEmbeddingResult = {
    success: true,
    savedCount: 0,
    patternIds: [],
    embeddingIds: [],
    errors: [],
  };

  const { motionPatternIdMapping } = options;

  if (isDevelopment()) {
    logger.info('[EmbeddingHandler] Starting MotionEmbedding generation (embedding-only mode)', {
      patternCount: patterns.length,
      hasIdMapping: !!motionPatternIdMapping,
      idMappingSize: motionPatternIdMapping?.size ?? 0,
    });
  }

  // IDマッピングがない場合はEmbedding生成をスキップ
  // db-handler.tsでパターンが保存されていない可能性がある
  if (!motionPatternIdMapping || motionPatternIdMapping.size === 0) {
    if (isDevelopment()) {
      logger.warn('[EmbeddingHandler] No motionPatternIdMapping provided, skipping embedding generation');
    }
    return result;
  }

  try {
    const motionPersistenceService = getMotionPersistenceService();

    if (!motionPersistenceService.isAvailable()) {
      result.success = false;
      if (isDevelopment()) {
        logger.warn('[EmbeddingHandler] MotionPersistenceService not available');
      }
      return result;
    }

    // 各パターンに対してEmbeddingのみ生成・保存
    let processedCount = 0;
    for (const pattern of patterns) {
      // 10パターンごとにGCを実行してメモリ解放（OOM防止）
      if (processedCount > 0 && processedCount % 10 === 0 && global.gc) {
        global.gc();
      }
      processedCount++;

      // 保存済みのパターンIDを取得
      const dbPatternId = motionPatternIdMapping.get(pattern.id);
      if (!dbPatternId) {
        if (isDevelopment()) {
          logger.warn('[EmbeddingHandler] Pattern ID mapping not found, skipping embedding', {
            originalId: pattern.id,
          });
        }
        result.errors.push({
          patternId: pattern.id,
          error: 'Pattern ID mapping not found',
        });
        continue;
      }

      try {
        // テキスト表現を生成
        const textRepresentation = generateMotionTextRepresentation(pattern);

        // Embedding生成（DIパターン経由でLayoutEmbeddingServiceを取得）
        const embeddingService = getMotionLayoutEmbeddingService();
        const embeddingResult = await embeddingService.generateFromText(textRepresentation);

        // DB保存
        const embeddingId = await saveMotionEmbedding(
          dbPatternId,
          embeddingResult.embedding,
          'multilingual-e5-base'
        );

        result.savedCount++;
        result.patternIds.push(dbPatternId);
        result.embeddingIds.push(embeddingId);

        if (isDevelopment()) {
          logger.info('[EmbeddingHandler] MotionEmbedding saved', {
            originalPatternId: pattern.id,
            dbPatternId: dbPatternId,
            embeddingId: embeddingId,
            embeddingDimensions: embeddingResult.embedding.length,
          });
        }
      } catch (embeddingError) {
        // Embedding生成失敗時もパターンは保存済み（部分成功）
        const errorMessage = embeddingError instanceof Error ? embeddingError.message : 'Unknown error';
        result.errors.push({
          patternId: pattern.id,
          error: errorMessage,
        });

        if (isDevelopment()) {
          logger.warn('[EmbeddingHandler] MotionEmbedding generation failed (partial success)', {
            originalPatternId: pattern.id,
            dbPatternId: dbPatternId,
            error: errorMessage,
          });
        }
      }

      // Granular progress: report after each motion pattern (fire-and-forget)
      try { options.onProgress?.(result.savedCount + result.errors.length, patterns.length); } catch { /* fire-and-forget */ }
    }

    if (isDevelopment()) {
      logger.info('[EmbeddingHandler] MotionEmbedding generation completed', {
        savedCount: result.savedCount,
        errorCount: result.errors.length,
        patternIds: result.patternIds,
        embeddingIds: result.embeddingIds,
      });
    }
  } catch (serviceError) {
    // サービス初期化失敗時
    result.success = false;
    const errorMessage = serviceError instanceof Error ? serviceError.message : 'Unknown error';

    if (isDevelopment()) {
      logger.warn('[EmbeddingHandler] MotionEmbedding service error', {
        error: errorMessage,
      });
    }
  }

  return result;
}

// =====================================================
// BackgroundDesignEmbedding生成・保存
// =====================================================

/**
 * BackgroundDesignEmbedding生成オプション
 */
export interface GenerateBackgroundDesignEmbeddingsOptions {
  /** WebPageのID（exactOptionalPropertyTypes対応: undefined許可） */
  webPageId?: string | undefined;
  /**
   * DB保存済みのBackgroundDesign ID配列（backgrounds配列と1:1対応）。
   * 指定された場合はidMappingよりも優先使用し、name重複によるマッピング欠落を回避する。
   */
  backgroundDesignIds?: string[] | undefined;
  /** Granular progress callback: called after each background design embedding is processed */
  onProgress?: ((completed: number, total: number) => void) | undefined;
}

/**
 * BackgroundDesignEmbeddingを生成・保存
 *
 * page.analyzeパイプラインで検出された背景デザインに対して
 * Embeddingを生成し、background_design_embeddingsテーブルに保存する。
 *
 * @param backgrounds - 背景デザインデータ配列
 * @param backgroundDesignIdMapping - name -> BackgroundDesign DB IDのマッピング
 * @param options - 生成オプション
 * @returns 生成結果
 */
export async function generateBackgroundDesignEmbeddings(
  backgrounds: BackgroundDesignForText[],
  backgroundDesignIdMapping: Map<string, string>,
  options: GenerateBackgroundDesignEmbeddingsOptions = {}
): Promise<BackgroundDesignEmbeddingResult> {
  if (isDevelopment()) {
    logger.info('[EmbeddingHandler] Starting BackgroundDesignEmbedding generation', {
      backgroundCount: backgrounds.length,
      idMappingSize: backgroundDesignIdMapping.size,
      pageId: options.webPageId,
      usingDirectIds: options.backgroundDesignIds !== undefined,
    });
  }

  const result = await generateBgEmbeddings(
    backgrounds,
    backgroundDesignIdMapping,
    options.backgroundDesignIds,
    options.onProgress
  );

  if (isDevelopment()) {
    logger.info('[EmbeddingHandler] BackgroundDesignEmbedding generation completed', {
      generatedCount: result.generatedCount,
      failedCount: result.failedCount,
      errorCount: result.errors.length,
    });
  }

  return result;
}

// Re-export BackgroundDesign embedding types
export type {
  BackgroundDesignForText,
  BackgroundDesignEmbeddingResult,
  BackgroundDesignSearchResult,
  BackgroundDesignSearchOptions,
} from '../../../services/background/background-design-embedding.service';

export {
  generateBackgroundDesignTextRepresentation,
  searchSimilarBackgroundDesigns,
  setBackgroundEmbeddingServiceFactory,
  resetBackgroundEmbeddingServiceFactory,
  setBackgroundPrismaClientFactory,
  resetBackgroundPrismaClientFactory,
} from '../../../services/background/background-design-embedding.service';

// =====================================================
// VisionEmbedding関連の再エクスポート
// =====================================================

// Phase 3-3: vision-embedding.serviceから再エクスポート
export {
  generateAndSaveVisionEmbedding,
  hasValidVisualFeatures,
} from '../../../services/vision-embedding.service';

export type {
  VisionEmbeddingResult,
  VisionBatchOptions,
  VisionEmbeddingBatchItem,
  VisionEmbeddingBatchResult,
} from '../../../services/vision-embedding.service';
