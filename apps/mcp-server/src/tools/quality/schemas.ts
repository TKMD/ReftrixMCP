// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * quality.* MCP Tools Zod Schema Definitions
 * Webデザイン品質評価ツールの入力/出力バリデーションスキーマ
 *
 * @module @reftrix/mcp-server/tools/quality/schemas
 *
 * 対応ツール:
 * - quality.evaluate: Webデザインの品質を3軸で評価
 *
 * 評価軸:
 * - originality (独自性): AIクリシェの回避度、オリジナリティ
 * - craftsmanship (技巧): 実装品質、コード構造、アクセシビリティ
 * - contextuality (文脈適合性): 業界・ターゲット適合度
 */
import { z } from 'zod';

// ============================================================================
// Enum Schemas
// ============================================================================

/**
 * 評価グレード
 * A: 90-100, B: 80-89, C: 70-79, D: 60-69, F: 0-59
 */
export const gradeSchema = z.enum(['A', 'B', 'C', 'D', 'F']);
export type Grade = z.infer<typeof gradeSchema>;

/**
 * 推奨事項の優先度
 */
export const recommendationPrioritySchema = z.enum(['high', 'medium', 'low']);
export type RecommendationPriority = z.infer<typeof recommendationPrioritySchema>;

/**
 * 推奨事項のカテゴリ
 */
export const recommendationCategorySchema = z.enum([
  'originality',
  'craftsmanship',
  'contextuality',
  'accessibility',
  'performance',
  'general',
]);
export type RecommendationCategory = z.infer<typeof recommendationCategorySchema>;

/**
 * 改善提案のカテゴリ
 * (recommendationCategorySchemaと同一値だが、suggest_improvements専用に定義)
 */
export const improvementCategorySchema = z.enum([
  'originality',
  'craftsmanship',
  'contextuality',
  'accessibility',
  'performance',
  'general',
]);
export type ImprovementCategory = z.infer<typeof improvementCategorySchema>;

// ============================================================================
// quality.evaluate Input Schemas
// ============================================================================

/**
 * 重み付け設定スキーマ
 * 合計が1.0になる必要がある
 */
export const weightsSchema = z
  .object({
    originality: z
      .number()
      .min(0, { message: 'originality weightは0以上1以下である必要があります' })
      .max(1, { message: 'originality weightは0以上1以下である必要があります' })
      .default(0.35),
    craftsmanship: z
      .number()
      .min(0, { message: 'craftsmanship weightは0以上1以下である必要があります' })
      .max(1, { message: 'craftsmanship weightは0以上1以下である必要があります' })
      .default(0.4),
    contextuality: z
      .number()
      .min(0, { message: 'contextuality weightは0以上1以下である必要があります' })
      .max(1, { message: 'contextuality weightは0以上1以下である必要があります' })
      .default(0.25),
  })
  .refine(
    (data) => {
      const sum = data.originality + data.craftsmanship + data.contextuality;
      // 浮動小数点誤差を考慮して0.99-1.01の範囲を許容
      return sum >= 0.99 && sum <= 1.01;
    },
    {
      message: '重みの合計は1.0である必要があります',
    }
  );
export type Weights = z.infer<typeof weightsSchema>;

/**
 * quality.evaluate アクションタイプ
 *
 * - evaluate: 品質評価（デフォルト）
 * - suggest_improvements: 評価結果に基づく改善提案生成
 */
export const qualityEvaluateActionSchema = z.enum(['evaluate', 'suggest_improvements']);
export type QualityEvaluateAction = z.infer<typeof qualityEvaluateActionSchema>;

/**
 * パターン比較オプションスキーマ
 * パターン駆動評価のためのオプション設定
 */
export const patternComparisonSchema = z.object({
  /** パターン比較を有効にするか (default: true) */
  enabled: z.boolean().default(true),
  /** 最小類似度しきい値 (0-1, default: 0.7) */
  minSimilarity: z
    .number()
    .min(0, { message: 'minSimilarityは0以上1以下である必要があります' })
    .max(1, { message: 'minSimilarityは0以上1以下である必要があります' })
    .default(0.7),
  /** 取得するパターンの最大数 (1-20, default: 5) */
  maxPatterns: z
    .number()
    .int()
    .min(1, { message: 'maxPatternsは1以上20以下である必要があります' })
    .max(20, { message: 'maxPatternsは1以上20以下である必要があります' })
    .default(5),
});
export type PatternComparison = z.infer<typeof patternComparisonSchema>;

/**
 * 評価コンテキストスキーマ
 * 評価時のコンテキスト情報
 */
export const evaluationContextSchema = z.object({
  /** プロジェクトID (UUID) */
  projectId: z.string().uuid({ message: '有効なUUID形式のprojectIdを指定してください' }).optional(),
  /** ブランドパレットID (UUID) */
  brandPaletteId: z.string().uuid({ message: '有効なUUID形式のbrandPaletteIdを指定してください' }).optional(),
  /** ターゲット業界 */
  targetIndustry: z.string().max(100).optional(),
  /** ターゲットオーディエンス */
  targetAudience: z.string().max(100).optional(),
});
export type EvaluationContext = z.infer<typeof evaluationContextSchema>;

/**
 * レスポンシブ評価オプションスキーマ
 * Playwright実測定によるレスポンシブ品質評価
 */
export const responsiveEvaluationSchema = z.object({
  /** レスポンシブ評価を有効にするか (default: false) */
  enabled: z.boolean().default(false),
  /** 評価対象URL（pageId使用時は必須） */
  url: z
    .string()
    .url({ message: '有効なURLを指定してください' })
    .optional(),
  /** 評価対象のビューポート */
  viewports: z.array(z.object({
    name: z.string(),
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(480).max(2160),
  })).optional(),
  /** 実行するチェック項目 */
  checks: z.object({
    /** タッチターゲットサイズ検証 (WCAG 2.5.5: 44x44px) */
    touchTargets: z.boolean().default(true),
    /** モバイル読みやすさ評価 */
    readability: z.boolean().default(true),
    /** コンテンツオーバーフロー検出 */
    overflow: z.boolean().default(true),
    /** レスポンシブ画像チェック */
    images: z.boolean().default(true),
  }).optional(),
  /** タイムアウト (ms, default: 30000) */
  timeout: z
    .number()
    .int()
    .min(5000, { message: 'timeoutは5000ms以上にしてください' })
    .max(120000, { message: 'timeoutは120000ms以下にしてください' })
    .default(30000),
});
export type ResponsiveEvaluation = z.infer<typeof responsiveEvaluationSchema>;

/**
 * quality.evaluate 入力スキーマ（統合）
 *
 * actionパラメータに応じて異なるオプションを受け付ける:
 * - action: "evaluate" (デフォルト): weights, targetIndustry, targetAudience, includeRecommendations, strict
 * - action: "suggest_improvements": categories, minPriority, maxSuggestions, includeCodeExamples
 *
 * 後方互換性: 既存のaction未指定の呼び出しは自動的にaction: "evaluate"として扱われます。
 *
 * v0.1.0: パターン駆動評価サポート追加
 * - patternComparison: DBパターンとの比較オプション
 * - context: プロジェクト/ブランド/デザインシステムコンテキスト
 * - responsive_evaluation: Playwright実測定によるレスポンシブ品質評価
 */
export const qualityEvaluateInputSchema = z
  .object({
    // 共通フィールド
    action: qualityEvaluateActionSchema.optional().default('evaluate'),
    pageId: z
      .string()
      .uuid({ message: '有効なUUID形式のpageIdを指定してください' })
      .optional(),
    html: z
      .string()
      .min(1, { message: 'HTMLコンテンツは1文字以上必要です' })
      .max(10_000_000, { message: 'HTMLコンテンツは10MB以下にしてください' })
      .optional(),

    // action: "evaluate" 用オプション
    weights: weightsSchema.optional(),
    targetIndustry: z
      .string()
      .max(100, { message: 'targetIndustryは100文字以下にしてください' })
      .optional(),
    targetAudience: z
      .string()
      .max(100, { message: 'targetAudienceは100文字以下にしてください' })
      .optional(),
    includeRecommendations: z.boolean().default(true),
    strict: z.boolean().default(false),

    // パターン駆動評価オプション (v0.1.0新規)
    patternComparison: patternComparisonSchema.optional(),
    context: evaluationContextSchema.optional(),

    // アクセシビリティ検証オプション (v0.1.0新規)
    /** Playwrightを使用したランタイムaXe検証を有効化（デフォルト: false = JSDOM版を使用） */
    use_playwright: z.boolean().default(false),

    // レスポンス軽量化オプション (v0.1.0新規 MCP-RESP-01, v0.1.0 デフォルトtrue)
    /**
     * 軽量モード: 詳細情報を除外してサマリーのみ返却
     *
     * summary: true の場合 (v0.1.0よりデフォルト):
     * - recommendations: 最大3件に制限（高優先度のみ）
     * - contextualRecommendations: 最大3件に制限
     * - patternAnalysis.similarSections: 最大3件に制限
     * - patternAnalysis.similarMotions: 最大3件に制限
     * - patternAnalysis.benchmarksUsed: 最大3件に制限
     * - axeAccessibility.violations: 最大5件に制限
     * - clicheDetection.patterns: 最大3件に制限
     *
     * 詳細情報が必要な場合は summary: false を明示的に指定してください。
     */
    summary: z.boolean().default(true),

    // レスポンシブ品質評価オプション (v0.1.0新規)
    /**
     * Playwright実測定によるレスポンシブ品質評価
     *
     * responsive_evaluation.enabled: true の場合:
     * - Playwrightで複数ビューポートを実際に開いて計測
     * - タッチターゲット、読みやすさ、オーバーフロー、画像の4チェック
     * - craftsmanship スコアにレスポンシブデザイン品質を反映
     * - urlまたはpageId（+url）が必要
     */
    responsive_evaluation: responsiveEvaluationSchema.optional(),

    // DB永続化オプション (v0.1.0新規 MCP-QUALITY-02)
    /**
     * 評価結果をデータベースに保存
     *
     * save_to_db: true の場合:
     * - QualityEvaluation テーブルに評価結果を保存
     * - overall_score, grade, subscores, pattern_references を記録
     * - pageId が指定されている場合のみ有効（HTMLのみの場合はスキップ）
     * - 保存失敗時は警告ログを出力するが、評価結果は正常に返却（graceful degradation）
     */
    save_to_db: z.boolean().default(false).describe(
      'Save evaluation results to database (QualityEvaluation table). ' +
      'When true, saves overall score, grade, subscores, and pattern references.'
    ),

    // action: "suggest_improvements" 用オプション
    categories: z.array(improvementCategorySchema).optional(),
    minPriority: recommendationPrioritySchema.optional(),
    maxSuggestions: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10),
    includeCodeExamples: z.boolean().default(true),
  })
  .refine(
    (data) => {
      const hasPageId = data.pageId !== undefined;
      const hasHtml = data.html !== undefined;
      return hasPageId || hasHtml;
    },
    {
      message: 'pageIdまたはhtmlのいずれかを指定してください',
    }
  )
  .refine(
    (data) => {
      const hasPageId = data.pageId !== undefined;
      const hasHtml = data.html !== undefined;
      return !(hasPageId && hasHtml);
    },
    {
      message: 'pageIdとhtmlを同時に指定することはできません',
    }
  );
export type QualityEvaluateInput = z.infer<typeof qualityEvaluateInputSchema>;

// ============================================================================
// quality.evaluate Output Schemas
// ============================================================================

/**
 * 軸別スコアスキーマ
 */
export const axisScoreSchema = z.object({
  score: z.number().min(0).max(100),
  grade: gradeSchema,
  details: z.array(z.string()).optional(),
});
export type AxisScore = z.infer<typeof axisScoreSchema>;

// ============================================================================
// Pattern Analysis Schemas (v0.1.0)
// ============================================================================

/**
 * 類似セクションパターンスキーマ
 */
export const similarSectionSchema = z.object({
  /** パターンID (UUID) */
  id: z.string().uuid(),
  /** セクションタイプ (hero, feature, cta等) */
  type: z.string(),
  /** 類似度スコア (0-1) */
  similarity: z.number().min(0).max(1),
  /** 元のWebページURL */
  sourceUrl: z.string().url().optional(),
  /** 元のWebページID */
  webPageId: z.string().uuid().optional(),
});
export type SimilarSection = z.infer<typeof similarSectionSchema>;

/**
 * 類似モーションパターンスキーマ
 */
export const similarMotionSchema = z.object({
  /** パターンID (UUID) */
  id: z.string().uuid(),
  /** モーションタイプ (animation, transition等) */
  type: z.string(),
  /** カテゴリ (scroll, hover等) */
  category: z.string().optional(),
  /** 類似度スコア (0-1) */
  similarity: z.number().min(0).max(1),
  /** 元のWebページID */
  webPageId: z.string().uuid().optional(),
});
export type SimilarMotion = z.infer<typeof similarMotionSchema>;

/**
 * 使用ベンチマークスキーマ
 */
export const usedBenchmarkSchema = z.object({
  /** ベンチマークID (UUID) */
  id: z.string().uuid(),
  /** ベンチマーク名 */
  name: z.string(),
  /** タイプ (industry, general等) */
  type: z.string(),
  /** 評価時のスコア */
  score: z.number().min(0).max(100),
  /** 類似度 (0-1) */
  similarity: z.number().min(0).max(1).optional(),
});
export type UsedBenchmark = z.infer<typeof usedBenchmarkSchema>;

/**
 * パターン分析結果スキーマ
 */
export const patternAnalysisSchema = z.object({
  /** 類似セクションパターン */
  similarSections: z.array(similarSectionSchema),
  /** 類似モーションパターン */
  similarMotions: z.array(similarMotionSchema),
  /** 使用したベンチマーク */
  benchmarksUsed: z.array(usedBenchmarkSchema),
  /** ユニークネススコア (0-100) */
  uniquenessScore: z.number().min(0).max(100),
  /** パターン類似度平均 (0-1) */
  patternSimilarityAvg: z.number().min(0).max(1),
  /** パターン駆動評価が有効だったか */
  patternDrivenEnabled: z.boolean(),
  /** フォールバック使用フラグ */
  fallbackUsed: z.boolean(),
  /** フォールバック理由 */
  fallbackReason: z.string().optional(),
});
export type PatternAnalysis = z.infer<typeof patternAnalysisSchema>;

/**
 * コンテキスト付き推奨事項スキーマ
 */
export const contextualRecommendationSchema = z.object({
  id: z.string(),
  category: recommendationCategorySchema,
  priority: recommendationPrioritySchema,
  title: z.string(),
  description: z.string(),
  impact: z.number().min(0).max(100).optional(),
  /** 参照パターンID (存在する場合) */
  referencePatternId: z.string().uuid().optional(),
  /** 参照パターンのソースURL */
  referenceUrl: z.string().url().optional(),
  /** 参照パターンからの学び */
  patternInsight: z.string().optional(),
});
export type ContextualRecommendation = z.infer<typeof contextualRecommendationSchema>;

/**
 * AIクリシェ検出結果スキーマ
 */
export const clicheDetectionSchema = z.object({
  detected: z.boolean(),
  count: z.number().int().nonnegative(),
  patterns: z.array(
    z.object({
      type: z.string(),
      description: z.string(),
      severity: z.enum(['high', 'medium', 'low']),
      location: z.string().optional(),
    })
  ),
});
export type ClicheDetection = z.infer<typeof clicheDetectionSchema>;

/**
 * 推奨事項スキーマ
 */
export const recommendationSchema = z.object({
  id: z.string(),
  category: recommendationCategorySchema,
  priority: recommendationPrioritySchema,
  title: z.string(),
  description: z.string(),
  impact: z.number().min(0).max(100).optional(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

/**
 * aXe違反スキーマ
 * WCAG 2.1 AA準拠チェックで検出された違反
 */
export const axeViolationSchema = z.object({
  /** ルールID (e.g., 'image-alt', 'button-name') */
  id: z.string(),
  /** インパクトレベル */
  impact: z.enum(['minor', 'moderate', 'serious', 'critical']),
  /** 違反の説明 */
  description: z.string(),
  /** 修正方法のヘルプテキスト */
  help: z.string(),
  /** 詳細なヘルプURL */
  helpUrl: z.string().url(),
  /** 影響を受けるノード数 */
  nodes: z.number().int().nonnegative(),
});
export type AxeViolationOutput = z.infer<typeof axeViolationSchema>;

/**
 * aXeアクセシビリティ結果スキーマ
 * aXe-core によるWCAG 2.1 AA準拠チェック結果
 */
export const axeAccessibilityResultSchema = z.object({
  /** 検出された違反のリスト */
  violations: z.array(axeViolationSchema),
  /** 合格したルール数 */
  passes: z.number().int().nonnegative(),
  /** アクセシビリティスコア (0-100) */
  score: z.number().min(0).max(100),
  /** WCAGレベル (A, AA, AAA) */
  wcagLevel: z.enum(['A', 'AA', 'AAA']),
});
export type AxeAccessibilityResultOutput = z.infer<typeof axeAccessibilityResultSchema>;

/**
 * 評価データスキーマ (v0.1.0 拡張、v0.1.0 aXe統合)
 */
export const qualityEvaluateDataSchema = z.object({
  pageId: z.string().uuid().optional(),
  overall: z.number().min(0).max(100),
  grade: gradeSchema,
  originality: axisScoreSchema,
  craftsmanship: axisScoreSchema,
  contextuality: axisScoreSchema,
  clicheDetection: clicheDetectionSchema.optional(),
  /** 推奨事項（後方互換性のため通常のrecommendationSchemaも許容） */
  recommendations: z.array(recommendationSchema).optional(),
  /** コンテキスト付き推奨事項（v0.1.0新規、パターン参照付き） */
  contextualRecommendations: z.array(contextualRecommendationSchema).optional(),
  /** パターン分析結果（v0.1.0新規） */
  patternAnalysis: patternAnalysisSchema.optional(),
  /** aXeアクセシビリティ結果（v0.1.0新規、WCAG 2.1 AA準拠チェック） */
  axeAccessibility: axeAccessibilityResultSchema.optional(),
  /** レスポンシブデザイン品質評価結果（v0.1.0新規、Playwright実測定） */
  responsiveDesign: z.object({
    /** 総合レスポンシブスコア (0-100) */
    overallScore: z.number().min(0).max(100),
    /** 評価時間 (ms) */
    evaluationTimeMs: z.number().nonnegative(),
    /** ビューポート別結果サマリー */
    viewportSummaries: z.array(z.object({
      viewport: z.string(),
      touchTargetScore: z.number().min(0).max(100),
      readabilityScore: z.number().min(0).max(100),
      overflowOk: z.boolean(),
      responsiveImageScore: z.number().min(0).max(100),
    })),
  }).optional(),
  evaluatedAt: z.string().datetime(),
  weights: weightsSchema.optional(),
  targetIndustry: z.string().optional(),
  targetAudience: z.string().optional(),
  /** 評価コンテキスト（v0.1.0新規） */
  evaluationContext: evaluationContextSchema.optional(),
});
export type QualityEvaluateData = z.infer<typeof qualityEvaluateDataSchema>;

/**
 * エラー情報スキーマ
 */
export const qualityEvaluateErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type QualityEvaluateError = z.infer<typeof qualityEvaluateErrorSchema>;

/**
 * quality.evaluate 成功レスポンススキーマ
 */
export const qualityEvaluateSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: qualityEvaluateDataSchema,
});

/**
 * quality.evaluate 失敗レスポンススキーマ
 */
export const qualityEvaluateErrorOutputSchema = z.object({
  success: z.literal(false),
  error: qualityEvaluateErrorSchema,
});

/**
 * quality.evaluate 出力スキーマ（統合）
 */
export const qualityEvaluateOutputSchema = z.discriminatedUnion('success', [
  qualityEvaluateSuccessOutputSchema,
  qualityEvaluateErrorOutputSchema,
]);
export type QualityEvaluateOutput = z.infer<typeof qualityEvaluateOutputSchema>;

/**
 * action: "suggest_improvements" 成功レスポンススキーマ
 * (quality.evaluate統合後の出力形式)
 */
export const qualityEvaluateSuggestImprovementsSuccessOutputSchema = z.object({
  success: z.literal(true),
  action: z.literal('suggest_improvements'),
  data: z.object({
    improvements: z.array(z.object({
      id: z.string(),
      category: improvementCategorySchema,
      priority: recommendationPrioritySchema,
      title: z.string(),
      description: z.string(),
      originalCode: z.string().optional(),
      suggestedCode: z.string(),
      impact: z.number().min(0).max(100).optional(),
    })),
    summary: z.object({
      totalImprovements: z.number().int().nonnegative(),
      estimatedScoreGain: z.number().min(0).max(100),
      categoryCounts: z.object({
        originality: z.number().int().nonnegative().optional(),
        craftsmanship: z.number().int().nonnegative().optional(),
        contextuality: z.number().int().nonnegative().optional(),
        accessibility: z.number().int().nonnegative().optional(),
        performance: z.number().int().nonnegative().optional(),
        general: z.number().int().nonnegative().optional(),
      }),
    }),
    generatedAt: z.string().datetime(),
    evaluationId: z.string().uuid().optional(),
  }),
});

/**
 * quality.evaluate 統合出力スキーマ（action別）
 *
 * actionパラメータに応じた出力型:
 * - action: "evaluate" (デフォルト) → QualityEvaluateOutput
 * - action: "suggest_improvements" → SuggestImprovementsOutput形式
 */
export type QualityEvaluateUnifiedOutput =
  | QualityEvaluateOutput
  | z.infer<typeof qualityEvaluateSuggestImprovementsSuccessOutputSchema>
  | { success: false; error: QualityEvaluateError };

// ============================================================================
// Error Codes
// ============================================================================

/**
 * quality.* ツール用エラーコード
 */
export const QUALITY_MCP_ERROR_CODES = {
  /** バリデーションエラー */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** ページが見つからない */
  PAGE_NOT_FOUND: 'PAGE_NOT_FOUND',
  /** 無効なHTML */
  INVALID_HTML: 'INVALID_HTML',
  /** 無効な重み */
  INVALID_WEIGHTS: 'INVALID_WEIGHTS',
  /** 評価エラー */
  EVALUATION_ERROR: 'EVALUATION_ERROR',
  /** データベースエラー */
  DB_ERROR: 'DB_ERROR',
  /** 内部エラー */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** サービス利用不可 */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** 評価が見つからない */
  EVALUATION_NOT_FOUND: 'EVALUATION_NOT_FOUND',
  /** 改善提案生成エラー */
  SUGGESTION_GENERATION_ERROR: 'SUGGESTION_GENERATION_ERROR',
} as const;

export type QualityMcpErrorCode =
  (typeof QUALITY_MCP_ERROR_CODES)[keyof typeof QUALITY_MCP_ERROR_CODES];

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * スコアからグレードを計算
 */
export function scoreToGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * 重み付きスコア計算
 */
export function calculateWeightedScore(
  originality: number,
  craftsmanship: number,
  contextuality: number,
  weights: Weights
): number {
  const weighted =
    originality * weights.originality +
    craftsmanship * weights.craftsmanship +
    contextuality * weights.contextuality;
  return Math.round(weighted * 100) / 100;
}

// ============================================================================
// MCP Tool Definitions
// ============================================================================

/**
 * MCP Tool definitions for quality.* tools
 * MCPプロトコル準拠のツール定義
 */
export const qualityMcpTools = {
  'quality.evaluate': {
    name: 'quality.evaluate',
    description:
      'Webデザインの品質を3軸（独自性・技巧・文脈適合性）で評価し、AIクリシェ検出を行います',
    inputSchema: qualityEvaluateInputSchema,
  },
} as const;

export type QualityMcpToolName = keyof typeof qualityMcpTools;

// ============================================================================
// quality.suggest_improvements Schemas
// ============================================================================

/**
 * quality.suggest_improvements 入力スキーマ
 */
export const suggestImprovementsInputSchema = z
  .object({
    evaluationId: z
      .string()
      .uuid({ message: '有効なUUID形式のevaluationIdを指定してください' })
      .optional(),
    html: z
      .string()
      .min(1, { message: 'HTMLコンテンツは1文字以上必要です' })
      .max(10_000_000, { message: 'HTMLコンテンツは10MB以下にしてください' })
      .optional(),
    categories: z.array(improvementCategorySchema).optional(),
    minPriority: recommendationPrioritySchema.optional(),
    maxSuggestions: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10),
    includeCodeExamples: z.boolean().default(true),
  })
  .refine(
    (data) => {
      const hasEvaluationId = data.evaluationId !== undefined;
      const hasHtml = data.html !== undefined;
      return hasEvaluationId || hasHtml;
    },
    {
      message: 'evaluationIdまたはhtmlのいずれかを指定してください',
    }
  )
  .refine(
    (data) => {
      const hasEvaluationId = data.evaluationId !== undefined;
      const hasHtml = data.html !== undefined;
      return !(hasEvaluationId && hasHtml);
    },
    {
      message: 'evaluationIdとhtmlを同時に指定することはできません',
    }
  );
export type SuggestImprovementsInput = z.infer<typeof suggestImprovementsInputSchema>;

/**
 * 改善提案スキーマ
 */
export const improvementSchema = z.object({
  id: z.string(),
  category: improvementCategorySchema,
  priority: recommendationPrioritySchema,
  title: z.string(),
  description: z.string(),
  originalCode: z.string().optional(),
  suggestedCode: z.string(),
  impact: z.number().min(0).max(100).optional(),
});
export type Improvement = z.infer<typeof improvementSchema>;

/**
 * 改善サマリースキーマ
 */
export const improvementSummarySchema = z.object({
  totalImprovements: z.number().int().nonnegative(),
  estimatedScoreGain: z.number().min(0).max(100),
  categoryCounts: z.object({
    originality: z.number().int().nonnegative().optional(),
    craftsmanship: z.number().int().nonnegative().optional(),
    contextuality: z.number().int().nonnegative().optional(),
    accessibility: z.number().int().nonnegative().optional(),
    performance: z.number().int().nonnegative().optional(),
    general: z.number().int().nonnegative().optional(),
  }),
});
export type ImprovementSummary = z.infer<typeof improvementSummarySchema>;

/**
 * suggest_improvements データスキーマ
 */
export const suggestImprovementsDataSchema = z.object({
  improvements: z.array(improvementSchema),
  summary: improvementSummarySchema,
  generatedAt: z.string().datetime(),
  evaluationId: z.string().uuid().optional(),
});
export type SuggestImprovementsData = z.infer<typeof suggestImprovementsDataSchema>;

/**
 * suggest_improvements 成功レスポンス
 */
export const suggestImprovementsSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: suggestImprovementsDataSchema,
});

/**
 * suggest_improvements 失敗レスポンス
 */
export const suggestImprovementsErrorOutputSchema = z.object({
  success: z.literal(false),
  error: qualityEvaluateErrorSchema,
});

/**
 * suggest_improvements 出力スキーマ（統合）
 */
export const suggestImprovementsOutputSchema = z.discriminatedUnion('success', [
  suggestImprovementsSuccessOutputSchema,
  suggestImprovementsErrorOutputSchema,
]);
export type SuggestImprovementsOutput = z.infer<typeof suggestImprovementsOutputSchema>;

// ============================================================================
// Additional Error Codes
// ============================================================================

// QUALITY_MCP_ERROR_CODESに追加
// ============================================================================
// quality.batch_evaluate Schemas
// ============================================================================

/**
 * バッチ評価アイテムスキーマ
 */
export const batchEvaluateItemSchema = z
  .object({
    pageId: z
      .string()
      .uuid({ message: '有効なUUID形式のpageIdを指定してください' })
      .optional(),
    html: z
      .string()
      .min(1, { message: 'HTMLコンテンツは1文字以上必要です' })
      .max(10_000_000, { message: 'HTMLコンテンツは10MB以下にしてください' })
      .optional(),
  })
  .refine(
    (data) => {
      const hasPageId = data.pageId !== undefined;
      const hasHtml = data.html !== undefined;
      return hasPageId || hasHtml;
    },
    {
      message: 'pageIdまたはhtmlのいずれかを指定してください',
    }
  )
  .refine(
    (data) => {
      const hasPageId = data.pageId !== undefined;
      const hasHtml = data.html !== undefined;
      return !(hasPageId && hasHtml);
    },
    {
      message: 'pageIdとhtmlを同時に指定することはできません',
    }
  );
export type BatchEvaluateItem = z.infer<typeof batchEvaluateItemSchema>;

/**
 * バッチ評価入力スキーマ
 */
export const batchQualityEvaluateInputSchema = z.object({
  items: z
    .array(batchEvaluateItemSchema)
    .min(1, { message: '少なくとも1つのアイテムを指定してください' })
    .max(100, { message: '最大100件まで指定できます' }),
  batch_size: z
    .number()
    .int()
    .min(1, { message: 'batch_sizeは1以上50以下にしてください' })
    .max(50, { message: 'batch_sizeは1以上50以下にしてください' })
    .default(10),
  on_error: z.enum(['skip', 'abort']).default('skip'),
  weights: weightsSchema.optional(),
  strict: z.boolean().default(false),
});
export type BatchQualityEvaluateInput = z.infer<typeof batchQualityEvaluateInputSchema>;

/**
 * バッチジョブステータス
 */
export const batchQualityJobStatusSchema = z.object({
  job_id: z.string().uuid(),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled']),
  total_items: z.number().int().nonnegative(),
  processed_items: z.number().int().nonnegative(),
  success_items: z.number().int().nonnegative(),
  failed_items: z.number().int().nonnegative(),
  progress_percent: z.number().min(0).max(100),
  created_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  results: z.array(qualityEvaluateDataSchema).optional(),
  errors: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        error: qualityEvaluateErrorSchema,
      })
    )
    .optional(),
});
export type BatchQualityJobStatus = z.infer<typeof batchQualityJobStatusSchema>;

/**
 * バッチ評価成功レスポンスデータ
 */
export const batchQualityEvaluateDataSchema = z.object({
  job_id: z.string().uuid(),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled']),
  total_items: z.number().int().nonnegative(),
  batch_size: z.number().int().positive(),
  on_error: z.enum(['skip', 'abort']),
  created_at: z.string().datetime(),
  message: z.string(),
});
export type BatchQualityEvaluateData = z.infer<typeof batchQualityEvaluateDataSchema>;

/**
 * 非推奨警告スキーマ（quality.batch_evaluate用）
 */
export const deprecationWarningSchema = z.object({
  deprecated_tool: z.string(),
  replacement: z.string(),
  removal_version: z.string(),
  migration_guide: z.string(),
  message: z.string(),
});
export type DeprecationWarningSchema = z.infer<typeof deprecationWarningSchema>;

/**
 * バッチ評価成功レスポンス
 */
export const batchQualityEvaluateSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: batchQualityEvaluateDataSchema,
  deprecation_warning: deprecationWarningSchema.optional(),
});

/**
 * バッチ評価失敗レスポンス
 */
export const batchQualityEvaluateErrorOutputSchema = z.object({
  success: z.literal(false),
  error: qualityEvaluateErrorSchema,
});

/**
 * バッチ評価出力スキーマ（統合）
 */
export const batchQualityEvaluateOutputSchema = z.discriminatedUnion('success', [
  batchQualityEvaluateSuccessOutputSchema,
  batchQualityEvaluateErrorOutputSchema,
]);
export type BatchQualityEvaluateOutput = z.infer<typeof batchQualityEvaluateOutputSchema>;

// ============================================================================
// quality.getJobStatus Schemas
// ============================================================================

/**
 * ジョブステート（BullMQ互換）
 */
export const qualityJobStateSchema = z.enum([
  'waiting',    // キュー待ち
  'active',     // 処理中
  'completed',  // 完了
  'failed',     // 失敗
  'delayed',    // 遅延
  'unknown',    // 不明
]);
export type QualityJobState = z.infer<typeof qualityJobStateSchema>;

/**
 * quality.getJobStatus 入力スキーマ
 */
export const qualityGetJobStatusInputSchema = z.object({
  /**
   * ジョブID（quality.batch_evaluate で返されたjob_id）
   * MCP命名規約に沿ってsnake_case
   */
  job_id: z.string().uuid({ message: '有効なUUID形式のjob_idを指定してください' }),
});
export type QualityGetJobStatusInput = z.infer<typeof qualityGetJobStatusInputSchema>;

/**
 * バッチ評価結果アイテムスキーマ
 */
export const batchQualityResultItemSchema = z.object({
  /** アイテムインデックス */
  index: z.number().int().nonnegative(),
  /** 成功フラグ */
  success: z.boolean(),
  /** 評価結果（成功時のみ） */
  data: qualityEvaluateDataSchema.optional(),
  /** エラー情報（失敗時のみ） */
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
});
export type BatchQualityResultItem = z.infer<typeof batchQualityResultItemSchema>;

/**
 * バッチ評価結果サマリースキーマ
 */
export const batchQualityResultSummarySchema = z.object({
  /** ジョブID */
  jobId: z.string().uuid(),
  /** 全体の成功フラグ */
  success: z.boolean(),
  /** 総アイテム数 */
  totalItems: z.number().int().nonnegative(),
  /** 処理済みアイテム数 */
  processedItems: z.number().int().nonnegative(),
  /** 成功アイテム数 */
  successItems: z.number().int().nonnegative(),
  /** 失敗アイテム数 */
  failedItems: z.number().int().nonnegative(),
  /** 個別結果（オプション） */
  results: z.array(batchQualityResultItemSchema).optional(),
  /** 処理時間（ms） */
  processingTimeMs: z.number().nonnegative().optional(),
  /** 完了日時 */
  completedAt: z.string().datetime().optional(),
  /** エラーメッセージ（全体失敗時のみ） */
  error: z.string().optional(),
});
export type BatchQualityResultSummary = z.infer<typeof batchQualityResultSummarySchema>;

/**
 * quality.getJobStatus 出力データスキーマ
 */
export const qualityGetJobStatusDataSchema = z.object({
  /** ジョブID */
  jobId: z.string().uuid(),
  /** ジョブステート */
  status: qualityJobStateSchema,
  /** 進捗（0-100） */
  progress: z.number().min(0).max(100),
  /** 総アイテム数 */
  totalItems: z.number().int().nonnegative(),
  /** 処理済みアイテム数 */
  processedItems: z.number().int().nonnegative(),
  /** 成功アイテム数 */
  successItems: z.number().int().nonnegative(),
  /** 失敗アイテム数 */
  failedItems: z.number().int().nonnegative(),
  /** 結果（completed時のみ） */
  result: batchQualityResultSummarySchema.optional(),
  /** エラー理由（failed時のみ） */
  failedReason: z.string().optional(),
  /** タイムスタンプ */
  timestamps: z.object({
    created: z.number().optional(),
    started: z.number().optional(),
    completed: z.number().optional(),
    failed: z.number().optional(),
  }),
});
export type QualityGetJobStatusData = z.infer<typeof qualityGetJobStatusDataSchema>;

/**
 * quality.getJobStatus メタデータスキーマ
 */
export const qualityGetJobStatusMetadataSchema = z.object({
  /** リクエストID */
  request_id: z.string().optional(),
  /** Redis使用フラグ */
  redis_used: z.boolean().optional(),
  /** LRUストア使用フラグ（フォールバック時） */
  lru_fallback: z.boolean().optional(),
});
export type QualityGetJobStatusMetadata = z.infer<typeof qualityGetJobStatusMetadataSchema>;

/**
 * quality.getJobStatus 成功レスポンススキーマ
 */
export const qualityGetJobStatusSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: qualityGetJobStatusDataSchema,
  metadata: qualityGetJobStatusMetadataSchema.optional(),
});
export type QualityGetJobStatusSuccessOutput = z.infer<typeof qualityGetJobStatusSuccessOutputSchema>;

/**
 * quality.getJobStatus エラーレスポンススキーマ
 */
export const qualityGetJobStatusErrorOutputSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  metadata: qualityGetJobStatusMetadataSchema.optional(),
});
export type QualityGetJobStatusErrorOutput = z.infer<typeof qualityGetJobStatusErrorOutputSchema>;

/**
 * quality.getJobStatus 出力スキーマ（統合）
 */
export const qualityGetJobStatusOutputSchema = z.discriminatedUnion('success', [
  qualityGetJobStatusSuccessOutputSchema,
  qualityGetJobStatusErrorOutputSchema,
]);
export type QualityGetJobStatusOutput = z.infer<typeof qualityGetJobStatusOutputSchema>;
