// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Narrative Analysis Service
 *
 * WorldViewAnalyzerとLayoutStructureAnalyzerを統合し、
 * Webページの「世界観・雰囲気」と「レイアウト構成」を分析する統合サービス。
 *
 * 機能:
 * - WorldViewAnalyzer + LayoutStructureAnalyzer の統合
 * - text_representation生成（既存ジェネレーター使用）
 * - 信頼度スコア算出（既存カリキュレーター使用）
 * - Embedding生成（multilingual-e5-base、768次元）
 * - DB保存（DesignNarrative, DesignNarrativeEmbedding）
 *
 * @module services/narrative/narrative-analysis.service
 */

import type {
  NarrativeAnalysisInput,
  NarrativeAnalysisResult,
  NarrativeAnalysisMetadata,
  ExistingAnalysisResults,
  SavedNarrative,
  WorldViewResult,
  LayoutStructureResult,
  ConfidenceScore,
  INarrativeAnalysisService,
  NarrativeSearchOptions,
  NarrativeSearchResult,
} from './types/narrative.types';
import { WorldViewAnalyzer, type WorldViewAnalysisOutput } from './analyzers/worldview.analyzer';
import { LayoutStructureAnalyzer, type LayoutStructureAnalysisOutput } from './analyzers/layout-structure.analyzer';
import {
  generateTextRepresentation,
} from './generators/text-representation.generator';
import {
  calculateConfidence,
  type AnalysisMetadata,
} from './generators/confidence-calculator';
import { LayoutEmbeddingService } from '../layout-embedding.service';
import { NarrativeSearchService } from './narrative-search.service';
import { isDevelopment, logger } from '../../utils/logger';
import { prisma } from '@reftrix/database';
import type { MoodCategory as PrismaMoodCategory } from '@prisma/client';

// =============================================================================
// Types
// =============================================================================

/**
 * NarrativeAnalysisService設定
 */
export interface NarrativeAnalysisServiceConfig {
  /** Visionタイムアウト（ms） */
  visionTimeoutMs?: number;
  /** Embedding生成を有効にするか（デフォルト: true） */
  enableEmbedding?: boolean;
}

// =============================================================================
// NarrativeAnalysisService Class
// =============================================================================

/**
 * Narrative Analysis Service
 *
 * Webページの世界観・雰囲気とレイアウト構成を分析する統合サービス
 */
export class NarrativeAnalysisService implements INarrativeAnalysisService {
  private readonly worldViewAnalyzer: WorldViewAnalyzer;
  private readonly layoutStructureAnalyzer: LayoutStructureAnalyzer;
  private readonly config: Required<NarrativeAnalysisServiceConfig>;
  private embeddingService: LayoutEmbeddingService | null = null;
  private searchService: NarrativeSearchService | null = null;

  constructor(config?: NarrativeAnalysisServiceConfig) {
    // visionTimeoutMsが指定されている場合のみオプションを渡す（exactOptionalPropertyTypes対応）
    const worldViewOptions = config?.visionTimeoutMs !== undefined
      ? { visionTimeoutMs: config.visionTimeoutMs }
      : undefined;
    this.worldViewAnalyzer = new WorldViewAnalyzer(worldViewOptions);
    this.layoutStructureAnalyzer = new LayoutStructureAnalyzer();
    this.config = {
      visionTimeoutMs: config?.visionTimeoutMs ?? 180000,
      enableEmbedding: config?.enableEmbedding ?? true,
    };

    if (isDevelopment()) {
      logger.info('[NarrativeAnalysisService] Initialized', {
        visionTimeoutMs: this.config.visionTimeoutMs,
        enableEmbedding: this.config.enableEmbedding,
      });
    }
  }

  /**
   * Webページを分析してNarrativeを生成
   *
   * @param input - 分析入力
   * @returns 分析結果
   */
  async analyze(input: NarrativeAnalysisInput): Promise<NarrativeAnalysisResult> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[NarrativeAnalysisService] Starting analysis', {
        hasScreenshot: !!input.screenshot,
        hasHtml: !!input.html,
        hasExistingAnalysis: !!input.existingAnalysis,
        forceVision: input.options?.forceVision,
      });
    }

    // 1. WorldView分析
    const worldViewOutput = await this.analyzeWorldView(input);

    // 2. LayoutStructure分析
    const layoutStructureOutput = this.analyzeLayoutStructure(input);

    // 3. text_representation生成
    const textRepresentation = this.generateTextRepresentation(
      worldViewOutput.result,
      layoutStructureOutput.result
    );

    // 4. 信頼度スコア算出
    const confidence = this.calculateConfidenceScore(
      input.existingAnalysis ?? {},
      worldViewOutput,
      layoutStructureOutput
    );

    // 5. Embedding生成（オプション）
    let embedding: number[] | undefined;
    if (this.config.enableEmbedding && input.options?.generateEmbedding !== false) {
      try {
        embedding = await this.generateEmbedding(textRepresentation);
      } catch (error) {
        if (isDevelopment()) {
          logger.warn('[NarrativeAnalysisService] Embedding generation failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Embedding生成失敗は全体の失敗としない（Graceful Degradation）
      }
    }

    const analysisTimeMs = Date.now() - startTime;

    // exactOptionalPropertyTypes対応: undefinedのプロパティは含めない
    const metadata: NarrativeAnalysisMetadata = {
      textRepresentation,
      confidence,
      analysisTimeMs,
      visionUsed: worldViewOutput.metadata.visionUsed,
    };

    if (embedding !== undefined) {
      metadata.embedding = embedding;
    }

    if (worldViewOutput.metadata.fallbackReason !== undefined) {
      metadata.fallbackReason = worldViewOutput.metadata.fallbackReason;
    }

    const result: NarrativeAnalysisResult = {
      worldView: worldViewOutput.result,
      layoutStructure: layoutStructureOutput.result,
      metadata,
    };

    if (isDevelopment()) {
      logger.info('[NarrativeAnalysisService] Analysis complete', {
        analysisTimeMs,
        visionUsed: worldViewOutput.metadata.visionUsed,
        moodCategory: worldViewOutput.result.moodCategory,
        gridType: layoutStructureOutput.result.gridSystem.type,
        confidenceOverall: confidence.overall,
        hasEmbedding: !!embedding,
      });
    }

    return result;
  }

  /**
   * 分析結果をDBに保存
   *
   * @param webPageId - WebPage ID
   * @param result - 分析結果
   * @returns 保存済みNarrative
   */
  async save(
    webPageId: string,
    result: NarrativeAnalysisResult
  ): Promise<SavedNarrative> {
    if (isDevelopment()) {
      logger.info('[NarrativeAnalysisService] Saving narrative to DB', {
        webPageId,
        moodCategory: result.worldView.moodCategory,
        hasEmbedding: !!result.metadata.embedding,
      });
    }

    // MoodCategoryをDB Enumにマッピング
    const moodCategory = this.mapMoodCategoryToDb(result.worldView.moodCategory);

    // WorldView のオブジェクトを文字列に変換
    const colorImpression = this.serializeToString(result.worldView.colorImpression);
    const typographyPersonality = this.serializeToString(result.worldView.typographyPersonality);
    const motionEmotion = result.worldView.motionEmotion
      ? this.serializeToString(result.worldView.motionEmotion)
      : null;
    const overallTone = this.serializeToString(result.worldView.overallTone);

    // LayoutStructure をJSONBに変換
    const layoutStructure = {
      type: result.layoutStructure.gridSystem.type,
      columns: result.layoutStructure.gridSystem.columns,
      gutterWidth: result.layoutStructure.gridSystem.gutterWidth ?? null,
      containerWidth: result.layoutStructure.gridSystem.containerWidth ?? null,
      breakpoints: result.layoutStructure.gridSystem.breakpoints ?? null,
    };
    const visualHierarchy = result.layoutStructure.visualHierarchy
      ? JSON.parse(JSON.stringify(result.layoutStructure.visualHierarchy))
      : {};
    const spacingRhythm = result.layoutStructure.spacingRhythm
      ? JSON.parse(JSON.stringify(result.layoutStructure.spacingRhythm))
      : {};
    const sectionRelationships = result.layoutStructure.sectionRelationships
      ? JSON.parse(JSON.stringify(result.layoutStructure.sectionRelationships))
      : [];
    const graphicElements = result.layoutStructure.graphicElements
      ? JSON.parse(JSON.stringify(result.layoutStructure.graphicElements))
      : {};

    try {
      const saved = await prisma.designNarrative.upsert({
        where: { webPageId },
        create: {
          webPageId,
          moodCategory,
          moodDescription: result.worldView.moodDescription,
          colorImpression,
          typographyPersonality,
          motionEmotion,
          overallTone,
          layoutStructure,
          visualHierarchy,
          spacingRhythm,
          sectionRelationships,
          graphicElements,
          confidence: result.metadata.confidence.overall,
          analyzedAt: new Date(),
          analyzerVersion: '0.1.0',
        },
        update: {
          moodCategory,
          moodDescription: result.worldView.moodDescription,
          colorImpression,
          typographyPersonality,
          motionEmotion,
          overallTone,
          layoutStructure,
          visualHierarchy,
          spacingRhythm,
          sectionRelationships,
          graphicElements,
          confidence: result.metadata.confidence.overall,
          analyzedAt: new Date(),
          analyzerVersion: '0.1.0',
        },
      });

      if (isDevelopment()) {
        logger.info('[NarrativeAnalysisService] Narrative saved successfully', {
          id: saved.id,
          webPageId: saved.webPageId,
        });
      }

      // Embedding が存在する場合は DesignNarrativeEmbedding テーブルに保存
      let embeddingSaved = false;
      if (result.metadata.embedding && result.metadata.embedding.length > 0) {
        embeddingSaved = await this.saveNarrativeEmbedding(
          saved.id,
          result.metadata.textRepresentation,
          result.metadata.embedding
        );
      }

      return {
        id: saved.id,
        webPageId: saved.webPageId,
        embeddingSaved,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[NarrativeAnalysisService] Failed to save narrative', {
        webPageId,
        error: errorMessage,
      });
      throw new Error(`Failed to save narrative: ${errorMessage}`);
    }
  }

  /**
   * DesignNarrativeEmbedding テーブルに Embedding を保存
   *
   * 2段階で保存:
   * 1. Prisma upsert でレコード作成/更新（embedding列以外）
   * 2. Raw SQL で pgvector 形式のベクトルを保存
   *
   * @param designNarrativeId - DesignNarrative ID
   * @param textRepresentation - Embedding生成元テキスト
   * @param embedding - 768次元Embeddingベクトル
   * @returns Embedding が正常に保存されたか
   */
  private async saveNarrativeEmbedding(
    designNarrativeId: string,
    textRepresentation: string,
    embedding: number[]
  ): Promise<boolean> {
    try {
      // 1. DesignNarrativeEmbedding レコードを upsert
      const embeddingRecord = await prisma.designNarrativeEmbedding.upsert({
        where: { designNarrativeId },
        create: {
          designNarrativeId,
          textRepresentation,
          modelVersion: 'multilingual-e5-base',
        },
        update: {
          textRepresentation,
          modelVersion: 'multilingual-e5-base',
        },
      });

      // 2. pgvector 形式で Embedding ベクトルを更新
      const vectorString = `[${embedding.join(',')}]`;
      await prisma.$executeRawUnsafe(
        `UPDATE design_narrative_embeddings SET embedding = $1::vector WHERE id = $2::uuid`,
        vectorString,
        embeddingRecord.id
      );

      if (isDevelopment()) {
        logger.info('[NarrativeAnalysisService] Narrative embedding saved', {
          designNarrativeId,
          embeddingId: embeddingRecord.id,
          embeddingDimensions: embedding.length,
          textRepresentationLength: textRepresentation.length,
        });
      }

      return true;
    } catch (error) {
      // Graceful Degradation: Embedding保存失敗はNarrative保存全体を失敗させない
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (isDevelopment()) {
        logger.warn('[NarrativeAnalysisService] Failed to save narrative embedding (non-fatal)', {
          designNarrativeId,
          error: errorMessage,
        });
      }
      return false;
    }
  }

  /**
   * MoodCategoryをDB Enumにマッピング
   */
  private mapMoodCategoryToDb(category: string): PrismaMoodCategory {
    const mapping: Record<string, PrismaMoodCategory> = {
      professional: 'professional',
      playful: 'playful',
      premium: 'premium',
      tech: 'tech',
      organic: 'organic',
      minimal: 'minimalist',
      minimalist: 'minimalist',
      bold: 'bold',
      elegant: 'elegant',
      friendly: 'warm',
      warm: 'warm',
      artistic: 'artistic',
      trustworthy: 'trustworthy',
      innovative: 'innovative',
      energetic: 'energetic',
      mysterious: 'mysterious',
      serene: 'serene',
    };

    return mapping[category.toLowerCase()] ?? 'other';
  }

  /**
   * オブジェクトを人間が読める文字列に変換
   */
  private serializeToString(obj: unknown): string {
    if (typeof obj === 'string') {
      return obj;
    }
    if (obj === null || obj === undefined) {
      return '';
    }
    // オブジェクトの場合、人間が読める形式に変換
    if (typeof obj === 'object') {
      const entries = Object.entries(obj as Record<string, unknown>);
      return entries
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
    }
    return String(obj);
  }

  /**
   * 分析と保存を一括実行
   *
   * @param input - 分析入力
   * @returns 保存済みNarrative
   */
  async analyzeAndSave(input: NarrativeAnalysisInput): Promise<SavedNarrative> {
    const result = await this.analyze(input);

    if (!input.webPageId) {
      throw new Error('webPageId is required for saving');
    }

    return this.save(input.webPageId, result);
  }

  /**
   * Narrative検索
   *
   * NarrativeSearchServiceに委譲。DI経由でEmbeddingService/PrismaClientが
   * 設定されていない場合は空配列を返す（Graceful Degradation）。
   *
   * @param options - 検索オプション
   * @returns 検索結果
   */
  async search(options: NarrativeSearchOptions): Promise<NarrativeSearchResult[]> {
    if (isDevelopment()) {
      logger.info('[NarrativeAnalysisService] Delegating search to NarrativeSearchService', {
        query: options.query,
        limit: options.limit,
      });
    }

    try {
      if (!this.searchService) {
        this.searchService = new NarrativeSearchService();
      }
      return await this.searchService.search(options);
    } catch (error) {
      if (isDevelopment()) {
        logger.warn('[NarrativeAnalysisService] Search delegation failed, returning empty', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      // Graceful Degradation: DI未設定時は空配列を返す
      return [];
    }
  }

  /**
   * Ollamaサービスが利用可能かチェック
   */
  async isVisionAvailable(): Promise<boolean> {
    return this.worldViewAnalyzer.isAvailable();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * WorldView分析
   */
  private async analyzeWorldView(
    input: NarrativeAnalysisInput
  ): Promise<WorldViewAnalysisOutput> {
    // exactOptionalPropertyTypes対応: undefinedのプロパティは含めない
    const analysisInput: Parameters<typeof this.worldViewAnalyzer.analyze>[0] = {
      options: {
        visionTimeoutMs: input.options?.visionTimeoutMs ?? this.config.visionTimeoutMs,
        skipVision: input.options?.forceVision === false,
      },
    };

    if (input.screenshot !== undefined) {
      analysisInput.screenshot = input.screenshot;
    }

    if (input.existingAnalysis?.cssVariables !== undefined) {
      analysisInput.cssVariables = input.existingAnalysis.cssVariables;
    }

    if (input.existingAnalysis?.typography !== undefined) {
      analysisInput.typography = input.existingAnalysis.typography;
    }

    if (input.existingAnalysis?.motionPatterns !== undefined) {
      analysisInput.motionPatterns = input.existingAnalysis.motionPatterns;
    }

    return this.worldViewAnalyzer.analyze(analysisInput);
  }

  /**
   * LayoutStructure分析
   */
  private analyzeLayoutStructure(
    input: NarrativeAnalysisInput
  ): LayoutStructureAnalysisOutput {
    // exactOptionalPropertyTypes対応: undefinedのプロパティは含めない
    const analysisInput: Parameters<typeof this.layoutStructureAnalyzer.analyze>[0] = {
      html: input.html,
    };

    if (input.existingAnalysis?.cssVariables !== undefined) {
      analysisInput.cssVariables = input.existingAnalysis.cssVariables;
    }

    if (input.externalCss !== undefined) {
      analysisInput.externalCss = input.externalCss;
    }

    if (input.existingAnalysis?.sections !== undefined) {
      analysisInput.sections = input.existingAnalysis.sections;
    }

    return this.layoutStructureAnalyzer.analyze(analysisInput);
  }

  /**
   * text_representation生成
   */
  private generateTextRepresentation(
    worldView: WorldViewResult,
    layoutStructure: LayoutStructureResult
  ): string {
    // 既存のジェネレーターを使用
    return generateTextRepresentation({
      worldView,
      layoutStructure,
      metadata: {
        textRepresentation: '', // 生成中なので空
        confidence: {
          overall: 0,
          worldView: 0,
          layoutStructure: 0,
          breakdown: {
            visionAnalysis: 0,
            cssStaticAnalysis: 0,
            htmlStructureAnalysis: 0,
            motionAnalysis: 0,
          },
        },
        analysisTimeMs: 0,
        visionUsed: false,
      },
    });
  }

  /**
   * 信頼度スコア算出
   */
  private calculateConfidenceScore(
    existingAnalysis: ExistingAnalysisResults,
    worldViewOutput: WorldViewAnalysisOutput,
    layoutStructureOutput: LayoutStructureAnalysisOutput
  ): ConfidenceScore {
    // 既存のカリキュレーターを使用
    // exactOptionalPropertyTypes対応: undefinedのプロパティは含めない
    const metadata: AnalysisMetadata = {
      visionUsed: worldViewOutput.metadata.visionUsed,
      visionFallback: !worldViewOutput.metadata.visionUsed &&
        worldViewOutput.metadata.fallbackReason !== undefined,
    };

    if (worldViewOutput.metadata.visionConfidence !== undefined) {
      metadata.visionResult = { confidence: worldViewOutput.metadata.visionConfidence };
    }

    return calculateConfidence(
      existingAnalysis,
      metadata,
      worldViewOutput.result,
      layoutStructureOutput.result
    );
  }

  /**
   * Embedding生成
   */
  private async generateEmbedding(textRepresentation: string): Promise<number[]> {
    // EmbeddingServiceを遅延初期化
    if (!this.embeddingService) {
      this.embeddingService = new LayoutEmbeddingService();
    }

    const result = await this.embeddingService.generateFromText(textRepresentation);
    return result.embedding;
  }
}

/**
 * NarrativeAnalysisServiceインスタンスを作成
 */
export function createNarrativeAnalysisService(
  config?: NarrativeAnalysisServiceConfig
): NarrativeAnalysisService {
  return new NarrativeAnalysisService(config);
}
