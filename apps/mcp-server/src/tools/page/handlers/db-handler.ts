// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DB Handler for page.analyze
 * 分析結果のデータベース保存ロジックを分離
 *
 * analyze.tool.tsから抽出した単一責任モジュール
 * - WebPage保存（upsert）
 * - SectionPattern保存（createMany）
 * - MotionPattern保存（createMany）
 * - QualityEvaluation保存
 *
 * @module tools/page/handlers/db-handler
 */

import { v7 as uuidv7 } from 'uuid';
import { logger, isDevelopment } from '../../../utils/logger';
import { normalizeUrlForStorage } from '../../../utils/url-normalizer';
import type {
  QualityServiceResult,
  IPageAnalyzePrismaClient,
  VisionFeatureBase,
} from './types';
import type { VisualFeatures } from '../schemas';
import type { BackgroundDesignForSave } from '../../../services/background/background-design-db.service';

// =====================================================
// 型定義
// =====================================================

/**
 * DB保存結果（exactOptionalPropertyTypes対応）
 */
export interface SaveToDbResult {
  success: boolean;
  webPageId?: string | undefined;
  sectionPatternCount?: number | undefined;
  motionPatternCount?: number | undefined;
  qualityEvaluationId?: string | undefined;
  error?: string | undefined;
  /** 元のセクションID -> DB保存後のSectionPattern ID（UUIDv7）のマッピング */
  sectionIdMapping?: Map<string, string> | undefined;
  /** 元のモーションパターンID -> DB保存後のMotionPattern ID（UUIDv7）のマッピング */
  motionPatternIdMapping?: Map<string, string> | undefined;
  /** 保存されたBackgroundDesignの件数 */
  backgroundDesignCount?: number | undefined;
}

/**
 * DB保存用のVision解析結果（SectionVisionFeaturesのサブセット）
 * processingTimeMs/modelNameはオプショナル（DB保存時には不要な場合がある）
 */
export interface SectionVisionFeaturesForSave {
  success: boolean;
  features: VisionFeatureBase[];
  textRepresentation?: string;
  processingTimeMs?: number;
  modelName?: string;
}

/**
 * CSSフレームワーク検出メタデータ（DB保存用）
 */
export interface CssFrameworkMetaForSave {
  confidence: number;
  evidence: string[];
}

/**
 * 外部CSSメタ情報（DB保存用）
 */
export interface ExternalCssMetaForSave {
  fetchedCount: number;
  failedCount: number;
  totalSize: number;
  urls: Array<{ url: string; size?: number; success?: boolean }>;
  fetchedAt: string;
}

/**
 * セクション情報（DB保存用拡張、exactOptionalPropertyTypes対応）
 */
export interface SectionForSave {
  id: string;
  type: string;
  positionIndex: number;
  heading?: string | undefined;
  confidence: number;
  htmlSnippet?: string | undefined;
  /** CSSスニペット（style/link/inline styles） */
  cssSnippet?: string | undefined;
  /** 外部CSSコンテンツ */
  externalCssContent?: string | undefined;
  /** 外部CSSメタ情報 */
  externalCssMeta?: ExternalCssMetaForSave | undefined;
  /** CSSフレームワーク（tailwind, bootstrap, css_modules, styled_components, vanilla, unknown） */
  cssFramework?: string | undefined;
  /** CSSフレームワーク検出メタデータ（confidence, evidence） */
  cssFrameworkMeta?: CssFrameworkMetaForSave | undefined;
  /** Vision API解析結果から抽出した視覚的特徴（useVision=true時） */
  visionFeatures?: SectionVisionFeaturesForSave | undefined;
  /**
   * 画像処理アルゴリズムによる視覚特徴抽出結果（Phase 3-2追加）
   * visionFeaturesとは別物:
   * - visionFeatures: Vision API（Ollama）による直接的な画像解析結果
   * - visualFeatures: 画像処理アルゴリズムによる特徴抽出結果
   */
  visualFeatures?: VisualFeatures | undefined;
}

/**
 * モーションパターン情報（DB保存用拡張、exactOptionalPropertyTypes対応）
 */
export interface MotionPatternForSave {
  id: string;
  name: string;
  // v0.1.0: library_animation と video_motion を追加（motion.detect統合）
  // v0.1.0: vision_detected を追加（scroll-vision-persistence経由のパターン）
  type: 'css_animation' | 'css_transition' | 'keyframes' | 'library_animation' | 'video_motion' | 'vision_detected';
  category: string;
  trigger: string;
  // v0.1.0: video/runtime mode では duration が undefined になり得る
  duration?: number | undefined;
  easing: string;
  properties: string[];
  propertiesDetailed?: Array<{ property: string; from?: string; to?: string }> | undefined;
  rawCss?: string | undefined;
  performance: {
    // v0.1.0: 'high' を追加（video/runtime mode で使用）
    level: 'good' | 'acceptable' | 'poor' | 'high';
    usesTransform: boolean;
    usesOpacity: boolean;
  };
  accessibility: {
    respectsReducedMotion: boolean;
  };
}

// Re-export QualityServiceResult for backward compatibility
export type { QualityServiceResult };
// Re-export BackgroundDesignForSave for use in analyze.tool.ts
export type { BackgroundDesignForSave };

/**
 * DB保存オプション
 */
export interface SaveToDatabaseOptions {
  url: string;
  title?: string | undefined;
  htmlContent: string;
  screenshot?: string | undefined;
  sourceType: string;
  usageScope: string;
  layoutSaveToDb: boolean;
  motionSaveToDb: boolean;
  sections?: SectionForSave[] | undefined;
  motionPatterns?: MotionPatternForSave[] | undefined;
  qualityResult?: QualityServiceResult | undefined;
  /**
   * ページ全体の視覚特徴抽出結果（Phase 3-2追加）
   * 各セクションのvisualFeaturesカラムに保存される
   */
  visualFeatures?: VisualFeatures | undefined;
  /**
   * 背景デザイン検出結果（BackgroundDesignテーブルに保存）
   */
  backgroundDesigns?: BackgroundDesignForSave[] | undefined;
}

// =====================================================
// Prismaクライアントインターフェース
// =====================================================

/**
 * Prismaクライアントインターフェース（DB保存用）
 * IPageAnalyzePrismaClient のサブセットとして定義
 *
 * NOTE: このインターフェースはPrismaスキーマ（packages/database/prisma/schema.prisma）の
 * WebPage, SectionPattern, MotionPattern, QualityEvaluationモデルと同期する必要があります
 */
export type IDbHandlerPrismaClient = IPageAnalyzePrismaClient;

// =====================================================
// メイン関数
// =====================================================

/**
 * 分析結果をDBに保存（トランザクション内）
 *
 * Graceful Degradation: 保存失敗でも分析結果は返す
 *
 * @param prisma - Prismaクライアントインスタンス
 * @param options - 保存オプション
 * @returns 保存結果
 */
export async function saveToDatabase(
  prisma: IDbHandlerPrismaClient,
  options: SaveToDatabaseOptions
): Promise<SaveToDbResult> {
  const {
    url: rawUrl,
    title,
    htmlContent,
    screenshot,
    sourceType,
    usageScope,
    layoutSaveToDb,
    motionSaveToDb,
    sections,
    motionPatterns,
    qualityResult,
    visualFeatures,
    backgroundDesigns,
  } = options;

  // URL正規化（末尾スラッシュ除去等）で重複防止
  const url = normalizeUrlForStorage(rawUrl);

  if (isDevelopment()) {
    logger.info('[page.analyze] Starting DB save', {
      layoutSaveToDb,
      motionSaveToDb,
      sectionCount: sections?.length ?? 0,
      motionPatternCount: motionPatterns?.length ?? 0,
      hasQualityResult: !!qualityResult,
      hasVisualFeatures: !!visualFeatures,
      backgroundDesignCount: backgroundDesigns?.length ?? 0,
    });
  }

  try {
    // トランザクションタイムアウトを30秒に延長（デフォルト5秒では大量セクション保存時にタイムアウト）
    return await prisma.$transaction(async (tx) => {
      let webPageId: string | undefined;
      let sectionPatternCount = 0;
      let motionPatternCount = 0;
      let backgroundDesignCount = 0;
      let qualityEvaluationId: string | undefined;
      // IDマッピングを作成: 元のセクションID -> DB保存後のUUIDv7
      const sectionIdMapping = new Map<string, string>();

      // 1. WebPage保存（layoutSaveToDb=true の場合）
      if (layoutSaveToDb) {
        const webPageData: {
          id: string;
          url: string;
          title?: string;
          htmlContent?: string;
          screenshotFullUrl?: string;
          sourceType: string;
          usageScope: string;
        } = {
          id: uuidv7(),
          url,
          sourceType,
          usageScope,
        };

        if (title !== undefined) {
          webPageData.title = title;
        }
        // htmlContentはOptionalフィールド
        if (htmlContent !== undefined && htmlContent.length > 0) {
          webPageData.htmlContent = htmlContent;
        }
        // screenshotはscreenshotFullUrlにマッピング
        if (screenshot !== undefined) {
          webPageData.screenshotFullUrl = screenshot;
        }

        // upsert: URLが既存の場合は更新、新規の場合は作成
        const savedWebPage = await tx.webPage.upsert({
          where: { url },
          create: webPageData,
          update: {
            title: webPageData.title,
            htmlContent: webPageData.htmlContent,
            screenshotFullUrl: webPageData.screenshotFullUrl,
            sourceType: webPageData.sourceType,
            usageScope: webPageData.usageScope,
            updatedAt: new Date(),
          },
        });
        webPageId = savedWebPage.id;

        if (isDevelopment()) {
          logger.info('[page.analyze] WebPage saved (upsert)', { webPageId, url });
        }

        // 既存のSectionPatternを削除（再分析時にクリーンな状態から開始）
        await tx.sectionPattern.deleteMany({
          where: { webPageId },
        });

        if (isDevelopment()) {
          logger.info('[page.analyze] Existing SectionPatterns deleted', { webPageId });
        }

        // 2. SectionPattern保存（WebPageが保存された場合のみ）
        if (sections && sections.length > 0) {
          const sectionData = sections.map((section) => {
            const dbId = uuidv7();
            // 元のセクションID（section-0等）とDB IDのマッピングを保存
            sectionIdMapping.set(section.id, dbId);

            // layoutInfoを構築（Vision分析結果を含む場合は拡張）
            const layoutInfo: {
              type: string;
              confidence: number;
              visionAnalysis?: {
                success: boolean;
                features: Array<{
                  type: string;
                  confidence: number;
                  description?: string;
                }>;
                textRepresentation?: string;
                processingTimeMs?: number;
                modelName?: string;
              };
            } = {
              type: section.type,
              confidence: section.confidence ?? 0,
            };

            // Vision分析結果がある場合はlayoutInfoに含める
            if (section.visionFeatures && section.visionFeatures.success) {
              const visionAnalysis: {
                success: boolean;
                features: Array<{
                  type: string;
                  confidence: number;
                  description?: string;
                }>;
                textRepresentation?: string;
                processingTimeMs?: number;
                modelName?: string;
              } = {
                success: section.visionFeatures.success,
                features: section.visionFeatures.features,
              };
              // exactOptionalPropertyTypes対応: undefinedの場合はプロパティを含めない
              if (section.visionFeatures.textRepresentation !== undefined) {
                visionAnalysis.textRepresentation = section.visionFeatures.textRepresentation;
              }
              if (section.visionFeatures.processingTimeMs !== undefined) {
                visionAnalysis.processingTimeMs = section.visionFeatures.processingTimeMs;
              }
              if (section.visionFeatures.modelName !== undefined) {
                visionAnalysis.modelName = section.visionFeatures.modelName;
              }
              layoutInfo.visionAnalysis = visionAnalysis;
            }

            // exactOptionalPropertyTypes対応: undefinedの場合はプロパティを含めない
            const sectionData: {
              id: string;
              webPageId: string;
              sectionType: string;
              positionIndex: number;
              htmlSnippet?: string;
              cssSnippet?: string;
              externalCssContent?: string;
              externalCssMeta?: ExternalCssMetaForSave;
              cssFramework?: string;
              cssFrameworkMeta?: { confidence: number; evidence: string[] };
              layoutInfo: typeof layoutInfo;
              visualFeatures?: VisualFeatures;
            } = {
              id: dbId,
              webPageId: webPageId!,
              sectionType: section.type, // Prismaスキーマに合わせてsectionTypeを使用
              positionIndex: section.positionIndex,
              // layoutInfoは必須フィールド - Vision分析結果を含む拡張構造
              layoutInfo,
            };

            // htmlSnippetが存在する場合のみ追加
            if (section.htmlSnippet !== undefined) {
              sectionData.htmlSnippet = section.htmlSnippet;
            }

            // cssSnippetが存在する場合のみ追加
            if (section.cssSnippet !== undefined) {
              sectionData.cssSnippet = section.cssSnippet;
            }

            if (section.externalCssContent !== undefined) {
              sectionData.externalCssContent = section.externalCssContent;
            }

            if (section.externalCssMeta !== undefined) {
              sectionData.externalCssMeta = section.externalCssMeta;
            }

            // cssFrameworkが存在する場合のみ追加
            if (section.cssFramework !== undefined) {
              sectionData.cssFramework = section.cssFramework;
            }

            // cssFrameworkMetaが存在する場合のみ追加
            if (section.cssFrameworkMeta !== undefined) {
              sectionData.cssFrameworkMeta = section.cssFrameworkMeta;
            }

            // visualFeatures（ページレベル）をセクションに保存
            // 優先順位: セクション固有 > ページレベル（options.visualFeatures）
            if (section.visualFeatures !== undefined) {
              sectionData.visualFeatures = section.visualFeatures;
            } else if (visualFeatures !== undefined) {
              sectionData.visualFeatures = visualFeatures;
            }

            if (isDevelopment()) {
              logger.debug('[page.analyze] Section data prepared for save', {
                sectionId: dbId,
                sectionType: section.type,
                hasCssSnippet: !!section.cssSnippet,
                cssSnippetLength: section.cssSnippet?.length ?? 0,
                hasExternalCssContent: !!section.externalCssContent,
                externalCssContentLength: section.externalCssContent?.length ?? 0,
                cssFramework: section.cssFramework,
                hasCssFrameworkMeta: !!section.cssFrameworkMeta,
                hasVisualFeatures: !!sectionData.visualFeatures,
              });
            }

            return sectionData;
          });

          const result = await tx.sectionPattern.createMany({
            data: sectionData,
          });
          sectionPatternCount = result.count;

          if (isDevelopment()) {
            logger.info('[page.analyze] SectionPatterns saved', {
              count: sectionPatternCount,
              idMappingSize: sectionIdMapping.size,
            });
          }
        }

        // 3. BackgroundDesign保存（WebPageが保存された場合のみ）
        if (webPageId && backgroundDesigns && backgroundDesigns.length > 0) {
          // 既存のBackgroundDesignsを削除（クリーンスレート）
          await tx.backgroundDesign.deleteMany({
            where: { webPageId },
          });

          const bgData = backgroundDesigns.map((bg) => {
            const record: Record<string, unknown> = {
              id: uuidv7(),
              webPageId,
              name: bg.name,
              designType: bg.designType,
              cssValue: bg.cssValue,
              positionIndex: bg.positionIndex,
              colorInfo: bg.colorInfo,
              visualProperties: bg.visualProperties,
              performance: bg.performance,
              usageScope: bg.usageScope ?? 'inspiration_only',
              tags: bg.tags ?? [],
              metadata: {},
            };

            // exactOptionalPropertyTypes対応: undefinedの場合はプロパティを含めない
            if (bg.selector !== undefined) {
              record.selector = bg.selector;
            }
            if (bg.gradientInfo !== undefined) {
              record.gradientInfo = bg.gradientInfo;
            }
            if (bg.animationInfo !== undefined) {
              record.animationInfo = bg.animationInfo;
            }
            if (bg.cssImplementation !== undefined) {
              record.cssImplementation = bg.cssImplementation;
            }
            if (bg.confidence !== undefined) {
              record.confidence = bg.confidence;
            }
            if (bg.sourceUrl !== undefined) {
              record.sourceUrl = bg.sourceUrl;
            }

            return record;
          });

          const bgResult = await tx.backgroundDesign.createMany({
            data: bgData,
          });
          backgroundDesignCount = bgResult.count;

          if (isDevelopment()) {
            logger.info('[page.analyze] BackgroundDesigns saved', {
              count: backgroundDesignCount,
              webPageId,
            });
          }
        }

        // 4. QualityEvaluation保存（WebPageが保存され、qualityResultがある場合）
        if (qualityResult && qualityResult.success) {
          // Prismaスキーマに準拠したデータ構造
          const qualityData = {
            id: uuidv7(),
            targetType: 'web_page',
            targetId: webPageId!,
            overallScore: qualityResult.overallScore,
            grade: qualityResult.grade,
            // antiAiCliche: クリシェ検出結果（必須）
            antiAiCliche: {
              cliches: qualityResult.cliches || [],
              clicheCount: qualityResult.clicheCount,
            },
            // designQuality: 3軸評価の詳細（オプション）
            designQuality: {
              axisScores: qualityResult.axisScores,
              axisGrades: qualityResult.axisGrades,
              axisDetails: qualityResult.axisDetails,
            },
            // recommendations: 改善提案（文字列配列）
            recommendations: (qualityResult.recommendations || []).map(
              (r) => `[${r.priority}] ${r.category}: ${r.title} - ${r.description}`
            ),
            // 評価メタデータ
            evaluatorVersion: '0.1.0',
            evaluationMode: 'standard',
          };

          const createdQuality = await tx.qualityEvaluation.create({
            data: qualityData,
          });
          qualityEvaluationId = createdQuality.id;

          if (isDevelopment()) {
            logger.info('[page.analyze] QualityEvaluation saved', {
              qualityEvaluationId,
            });
          }
        }
      }

      // 4. MotionPattern保存（motionSaveToDb=true の場合）
      // IDマッピングを作成: 元のモーションパターンID -> DB保存後のUUIDv7
      const motionPatternIdMapping = new Map<string, string>();

      if (motionSaveToDb && motionPatterns && motionPatterns.length > 0) {
        const motionData = motionPatterns.map((pattern) => {
          const dbId = uuidv7();
          // 元のパターンID（motion-0等）とDB IDのマッピングを保存
          motionPatternIdMapping.set(pattern.id, dbId);

          return {
            id: dbId,
            // webPageIdはnullable: layoutSaveToDb=falseの場合はnullを設定
            // Prismaでundefinedは「フィールド省略」、nullは「明示的にnull」の意味
            webPageId: webPageId ?? null,
            name: pattern.name,
            category: pattern.category,
            triggerType: pattern.trigger,
            triggerConfig: {},
            animation: {
              duration: pattern.duration,
              easing: pattern.easing,
            },
            properties: pattern.propertiesDetailed
              ? pattern.propertiesDetailed.map((p) => ({
                  property: p.property,
                  from: p.from ?? '',
                  to: p.to ?? '',
                }))
              : pattern.properties.map((prop) => ({
                  property: prop,
                  from: '',
                  to: '',
                })),
            implementation: {
              rawCss: pattern.rawCss,
            },
            accessibility: pattern.accessibility,
            performance: pattern.performance,
            sourceUrl: url,
            usageScope: usageScope,
            tags: [],
            metadata: {
              type: pattern.type,
            },
          };
        });

        const result = await tx.motionPattern.createMany({
          data: motionData,
        });
        motionPatternCount = result.count;

        if (isDevelopment()) {
          logger.info('[page.analyze] MotionPatterns saved', {
            count: motionPatternCount,
            idMappingSize: motionPatternIdMapping.size,
          });
        }
      }

      return {
        success: true,
        webPageId,
        sectionPatternCount,
        motionPatternCount,
        backgroundDesignCount,
        qualityEvaluationId,
        sectionIdMapping,
        motionPatternIdMapping,
      };
    }, {
      maxWait: 10000,  // トランザクション開始まで最大10秒待機
      timeout: 30000,  // トランザクション実行最大30秒
    });
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[page.analyze] DB save failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'DB save failed',
    };
  }
}
