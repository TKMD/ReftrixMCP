// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * narrative.analyze MCPツール
 *
 * URLまたはHTMLからWebデザインの世界観（WorldView）と
 * レイアウト構成（LayoutStructure）を分析します。
 *
 * 分析フロー:
 * 1. URL指定時: Playwrightでページ取得 + スクリーンショット
 * 2. Vision LLM分析（Ollama llama3.2-vision）
 * 3. CSS静的分析（フォールバック/補完）
 * 4. 信頼度スコア算出
 * 5. DB保存（オプション）
 *
 * @module tools/narrative/analyze.tool
 */

import { ZodError } from 'zod';
import { logger, isDevelopment } from '../../utils/logger';
import {
  narrativeAnalyzeInputSchema,
  NARRATIVE_MCP_ERROR_CODES,
  type NarrativeAnalyzeInput,
  type NarrativeAnalyzeOutput,
  type NarrativeAnalyzeData,
  type NarrativeAnalyzeWarning,
} from './schemas';
import type {
  INarrativeAnalysisService,
  NarrativeAnalysisInput,
  NarrativeAnalysisResult,
} from '../../services/narrative/types/narrative.types';

// ============================================================================
// Types
// ============================================================================

export type { NarrativeAnalyzeInput, NarrativeAnalyzeOutput };

/**
 * NarrativeAnalysisServiceファクトリー型
 */
export type INarrativeAnalyzeServiceFactory = () => INarrativeAnalysisService;

// ============================================================================
// Service Factory (DI)
// ============================================================================

/** デフォルトのサービスファクトリー */
let narrativeAnalyzeServiceFactory: INarrativeAnalyzeServiceFactory | null = null;

/**
 * サービスファクトリーを設定
 * @param factory - サービスファクトリー
 */
export function setNarrativeAnalyzeServiceFactory(
  factory: INarrativeAnalyzeServiceFactory
): void {
  narrativeAnalyzeServiceFactory = factory;
}

/**
 * サービスファクトリーをリセット（テスト用）
 */
export function resetNarrativeAnalyzeServiceFactory(): void {
  narrativeAnalyzeServiceFactory = null;
}

/**
 * NarrativeAnalysisServiceを取得
 */
async function getNarrativeAnalysisService(): Promise<INarrativeAnalysisService> {
  if (narrativeAnalyzeServiceFactory !== null) {
    return narrativeAnalyzeServiceFactory();
  }

  // デフォルト: 実サービスをインポート
  // NOTE: NarrativeAnalysisServiceはTask #2で実装予定
  // 現在は未実装のため、サービスファクトリ経由でのみ使用可能
  throw new Error(
    'NarrativeAnalysisService is not yet implemented. ' +
      'Please use setNarrativeAnalyzeServiceFactory() to provide a service instance.'
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 分析結果をMCPレスポンス形式に変換
 */
function convertToMcpResponse(
  result: NarrativeAnalysisResult,
  webPageId?: string,
  savedId?: string
): NarrativeAnalyzeData {
  return {
    id: savedId,
    webPageId,

    worldView: {
      moodCategory: result.worldView.moodCategory,
      moodDescription: result.worldView.moodDescription,
      colorImpression: {
        overall: result.worldView.colorImpression.overall,
        dominantEmotion: result.worldView.colorImpression.dominantEmotion,
        harmony: result.worldView.colorImpression.harmony,
      },
      typographyPersonality: {
        style: result.worldView.typographyPersonality.style,
        readability: result.worldView.typographyPersonality.readability,
        hierarchy: result.worldView.typographyPersonality.hierarchy,
      },
      motionEmotion: result.worldView.motionEmotion
        ? {
            overall: result.worldView.motionEmotion.overall,
            pace: result.worldView.motionEmotion.pace,
            intensity: result.worldView.motionEmotion.intensity,
            accessibility: result.worldView.motionEmotion.accessibility,
          }
        : undefined,
      overallTone: {
        primary: result.worldView.overallTone.primary,
        formality: result.worldView.overallTone.formality,
        energy: result.worldView.overallTone.energy,
      },
    },

    layoutStructure: {
      gridSystem: {
        type: result.layoutStructure.gridSystem.type,
        columns: result.layoutStructure.gridSystem.columns,
        gutterWidth: result.layoutStructure.gridSystem.gutterWidth,
        containerWidth: result.layoutStructure.gridSystem.containerWidth,
        breakpoints: result.layoutStructure.gridSystem.breakpoints,
      },
      visualHierarchy: {
        primaryElements: result.layoutStructure.visualHierarchy.primaryElements,
        secondaryElements: result.layoutStructure.visualHierarchy.secondaryElements,
        tertiaryElements: result.layoutStructure.visualHierarchy.tertiaryElements,
        sectionFlow: result.layoutStructure.visualHierarchy.sectionFlow,
        weightDistribution: result.layoutStructure.visualHierarchy.weightDistribution,
      },
      spacingRhythm: {
        baseUnit: result.layoutStructure.spacingRhythm.baseUnit,
        scale: result.layoutStructure.spacingRhythm.scale,
        scaleName: result.layoutStructure.spacingRhythm.scaleName,
        sectionGaps: result.layoutStructure.spacingRhythm.sectionGaps,
      },
      sectionRelationships: result.layoutStructure.sectionRelationships.map((r) => ({
        sourceId: r.sourceId,
        targetId: r.targetId,
        relationshipType: r.relationshipType,
        strength: r.strength,
      })),
      graphicElements: {
        imageLayout: {
          pattern: result.layoutStructure.graphicElements.imageLayout.pattern,
          aspectRatios: result.layoutStructure.graphicElements.imageLayout.aspectRatios,
          positions: result.layoutStructure.graphicElements.imageLayout.positions,
        },
        decorations: result.layoutStructure.graphicElements.decorations,
        visualBalance: result.layoutStructure.graphicElements.visualBalance,
      },
    },

    confidence: {
      overall: result.metadata.confidence.overall,
      worldView: result.metadata.confidence.worldView,
      layoutStructure: result.metadata.confidence.layoutStructure,
      breakdown: result.metadata.confidence.breakdown,
    },

    analyzedAt: new Date().toISOString(),
    analysisTimeMs: result.metadata.analysisTimeMs,
    visionUsed: result.metadata.visionUsed,
    fallbackReason: result.metadata.fallbackReason,
    analyzerVersion: '0.1.0',
  };
}

// ============================================================================
// Handler
// ============================================================================

/**
 * narrative.analyze ハンドラー
 *
 * URLまたはHTMLからWebデザインの世界観・レイアウト構成を分析
 *
 * @param input - 入力パラメータ
 * @returns 分析結果
 *
 * @example
 * ```typescript
 * // URL指定
 * const result = await narrativeAnalyzeHandler({
 *   url: 'https://example.com',
 *   options: { save_to_db: true }
 * });
 *
 * // HTML指定 + スクリーンショット
 * const result = await narrativeAnalyzeHandler({
 *   html: '<html>...</html>',
 *   screenshot: 'base64...',
 *   options: { include_vision: true }
 * });
 * ```
 */
export async function narrativeAnalyzeHandler(
  input: unknown
): Promise<NarrativeAnalyzeOutput> {
  const startTime = Date.now();
  const warnings: NarrativeAnalyzeWarning[] = [];

  if (isDevelopment()) {
    logger.info('[narrative.analyze] Handler called', {
      inputType: typeof input,
    });
  }

  try {
    // 1. 入力バリデーション
    const validatedInput = narrativeAnalyzeInputSchema.parse(input);

    if (isDevelopment()) {
      logger.info('[narrative.analyze] Input validated', {
        hasUrl: !!validatedInput.url,
        hasHtml: !!validatedInput.html,
        hasScreenshot: !!validatedInput.screenshot,
        options: validatedInput.options,
      });
    }

    // 1.5. urlまたはhtmlの少なくとも一方が必要（Zodのrefineでもチェック済みだが防御的に追加）
    if (!validatedInput.url && !validatedInput.html) {
      return {
        success: false,
        error: {
          code: NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: 'urlまたはhtmlのいずれかを指定してください',
        },
      };
    }

    // 2. サービス取得
    const service = await getNarrativeAnalysisService();

    // 3. 分析入力の準備
    const timeout = validatedInput.options?.timeout;
    const screenshot = validatedInput.screenshot;
    const analysisInput: NarrativeAnalysisInput = {
      html: validatedInput.html || '', // URL指定時はサービス内でHTML取得
      ...(screenshot !== undefined && { screenshot }),
      options: {
        forceVision: false,
        ...(timeout !== undefined && { visionTimeoutMs: timeout }),
        generateEmbedding: validatedInput.options?.save_to_db !== false,
      },
    };

    // URL指定時の追加処理
    // NOTE: 実際の実装ではPlaywrightでページ取得が必要
    // ここではサービス層に委譲する想定

    // 4. 分析実行
    let result: NarrativeAnalysisResult;
    let savedId: string | undefined;
    let webPageId: string | undefined;

    if (validatedInput.options?.save_to_db !== false) {
      // 分析 + DB保存
      const savedNarrative = await service.analyzeAndSave(analysisInput);
      savedId = savedNarrative.id;
      webPageId = savedNarrative.webPageId;

      // 分析結果を再取得（analyzeAndSaveはSavedNarrativeのみ返すため）
      result = await service.analyze(analysisInput);
    } else {
      // 分析のみ
      result = await service.analyze(analysisInput);
    }

    const analysisTimeMs = Date.now() - startTime;

    // 5. レスポンス生成
    const data = convertToMcpResponse(result, webPageId, savedId);
    data.analysisTimeMs = analysisTimeMs;

    // Vision未使用時の警告
    if (!result.metadata.visionUsed && validatedInput.options?.include_vision !== false) {
      warnings.push({
        code: 'VISION_FALLBACK',
        message: `Vision分析が使用されませんでした: ${result.metadata.fallbackReason || 'unknown'}`,
      });
    }

    if (isDevelopment()) {
      logger.info('[narrative.analyze] Analysis completed', {
        moodCategory: data.worldView.moodCategory,
        gridType: data.layoutStructure.gridSystem.type,
        confidence: data.confidence.overall,
        analysisTimeMs,
        visionUsed: result.metadata.visionUsed,
        savedToDb: !!savedId,
      });
    }

    return {
      success: true,
      data,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    // エラーハンドリング
    if (error instanceof ZodError) {
      const details = error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      }));

      if (isDevelopment()) {
        logger.warn('[narrative.analyze] Validation error', { details });
      }

      return {
        success: false,
        error: {
          code: NARRATIVE_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: 'バリデーションエラー',
          details,
        },
      };
    }

    // 特定エラータイプのハンドリング
    if (error instanceof Error) {
      const errorCode = mapErrorToCode(error);

      if (isDevelopment()) {
        logger.error('[narrative.analyze] Error', {
          code: errorCode,
          message: error.message,
          stack: error.stack,
        });
      }

      return {
        success: false,
        error: {
          code: errorCode,
          message: error.message,
        },
      };
    }

    // 未知のエラー
    logger.error('[narrative.analyze] Unknown error', { error });

    return {
      success: false,
      error: {
        code: NARRATIVE_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: '内部エラーが発生しました',
      },
    };
  }
}

/**
 * エラーをエラーコードにマッピング
 */
function mapErrorToCode(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes('timeout')) {
    return NARRATIVE_MCP_ERROR_CODES.TIMEOUT;
  }
  if (message.includes('ssrf') || message.includes('blocked')) {
    return NARRATIVE_MCP_ERROR_CODES.SSRF_BLOCKED;
  }
  if (message.includes('network') || message.includes('fetch')) {
    return NARRATIVE_MCP_ERROR_CODES.NETWORK_ERROR;
  }
  if (message.includes('vision')) {
    return NARRATIVE_MCP_ERROR_CODES.VISION_ANALYSIS_FAILED;
  }
  if (message.includes('embedding')) {
    return NARRATIVE_MCP_ERROR_CODES.EMBEDDING_FAILED;
  }
  if (message.includes('db') || message.includes('database') || message.includes('save')) {
    return NARRATIVE_MCP_ERROR_CODES.DB_SAVE_FAILED;
  }
  if (message.includes('not found')) {
    return NARRATIVE_MCP_ERROR_CODES.PAGE_NOT_FOUND;
  }

  return NARRATIVE_MCP_ERROR_CODES.ANALYSIS_FAILED;
}

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * narrative.analyze ツール定義
 * MCP Server初期化時に使用
 */
export const narrativeAnalyzeToolDefinition = {
  name: 'narrative.analyze',
  description:
    'URLまたはHTMLからWebデザインの世界観（WorldView）とレイアウト構成（LayoutStructure）を分析します。' +
    'Vision LLMとCSS静的分析を組み合わせ、ムードカテゴリ・色彩印象・グリッドシステム・視覚的階層等を抽出します。' +
    'DB-first設計: デフォルトでDB保存し、最小レスポンスを返却。',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: '分析対象URL（urlまたはhtmlのいずれか必須）',
      },
      html: {
        type: 'string',
        description: '分析対象HTML（urlまたはhtmlのいずれか必須、最大10MB）',
      },
      screenshot: {
        type: 'string',
        description: 'Base64エンコードスクリーンショット（urlなし + include_vision時に必須）',
      },
      options: {
        type: 'object',
        properties: {
          save_to_db: {
            type: 'boolean',
            default: true,
            description: '分析結果をDBに保存するか',
          },
          include_vision: {
            type: 'boolean',
            default: true,
            description: 'Vision LLM分析を使用するか',
          },
          css_variables: {
            type: 'object',
            description: '既存CSS変数分析結果（page.analyzeからの再利用）',
          },
          motion_patterns: {
            type: 'array',
            description: '既存モーション分析結果（page.analyzeからの再利用）',
          },
          timeout: {
            type: 'number',
            default: 60000,
            description: '分析タイムアウト（ms）',
          },
        },
      },
    },
  },
};
