// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * narrative.* MCP Tools Zod Schema Definitions
 * Webデザインの世界観・レイアウト構成分析ツールの入力/出力バリデーションスキーマ
 *
 * @module @reftrix/mcp-server/tools/narrative/schemas
 *
 * 対応ツール:
 * - narrative.analyze: URLまたはHTMLから世界観・レイアウト構成を分析
 * - narrative.search: 世界観・レイアウト構成でセマンティック検索
 *
 * 分析対象:
 * - WorldView: 世界観・雰囲気（moodCategory, colorImpression, typographyPersonality等）
 * - LayoutStructure: レイアウト構成（gridSystem, visualHierarchy, spacingRhythm等）
 */
import { z } from 'zod';

// ============================================================================
// Enum Schemas
// ============================================================================

/**
 * ムードカテゴリ
 * Webデザインの全体的な雰囲気を分類
 *
 * @see services/narrative/types/narrative.types.ts
 */
export const moodCategorySchema = z.enum([
  'professional',    // ビジネス、企業
  'playful',         // 遊び心、カジュアル
  'premium',         // 高級、ラグジュアリー
  'tech',            // テクノロジー、先進的
  'organic',         // 自然、オーガニック
  'minimal',         // ミニマル、シンプル
  'bold',            // 大胆、インパクト
  'elegant',         // 上品、洗練
  'friendly',        // 親しみやすい
  'artistic',        // アート、クリエイティブ
  'trustworthy',     // 信頼、安心
  'energetic',       // エネルギッシュ、活発
]);
export type MoodCategory = z.infer<typeof moodCategorySchema>;

/**
 * 色彩調和タイプ
 */
export const colorHarmonySchema = z.enum([
  'complementary',      // 補色
  'analogous',          // 類似色
  'monochromatic',      // モノクロマティック
  'triadic',            // トライアド
  'split-complementary', // スプリットコンプリメンタリー
  'mixed',              // 混合
]);
export type ColorHarmony = z.infer<typeof colorHarmonySchema>;

/**
 * グリッドタイプ
 */
export const gridTypeSchema = z.enum([
  'css-grid',   // CSS Grid
  'flexbox',    // Flexbox
  'float',      // Float
  'mixed',      // 混合
  'none',       // なし
]);
export type GridType = z.infer<typeof gridTypeSchema>;

/**
 * セクション配置パターン
 */
export const sectionFlowSchema = z.enum([
  'linear',     // 線形
  'modular',    // モジュラー
  'asymmetric', // 非対称
]);
export type SectionFlow = z.infer<typeof sectionFlowSchema>;

/**
 * 検索モード
 */
export const narrativeSearchModeSchema = z.enum([
  'vector',     // Vectorのみ
  'hybrid',     // Vector + Full-text（RRF統合）
]);
export type NarrativeSearchMode = z.infer<typeof narrativeSearchModeSchema>;

// ============================================================================
// narrative.analyze Input Schemas
// ============================================================================

/**
 * narrative.analyze オプションスキーマ
 *
 * @property saveToDb - DB保存（デフォルトtrue）
 * @property includeVision - Vision LLM分析を使用（デフォルトtrue）
 * @property cssVariables - 既存CSS変数分析結果（オプション）
 * @property motionPatterns - 既存モーション分析結果（オプション）
 * @property timeout - タイムアウト（デフォルト60000ms）
 */
export const narrativeAnalyzeOptionsSchema = z.object({
  /** DB保存（デフォルトtrue） */
  save_to_db: z
    .boolean()
    .optional()
    .default(true)
    .describe('分析結果をDBに保存するか（デフォルト: true）'),

  /** Vision LLM分析を使用（デフォルトtrue） */
  include_vision: z
    .boolean()
    .optional()
    .default(true)
    .describe('Vision LLM分析を使用するか。falseの場合はCSS静的分析のみ（デフォルト: true）'),

  /** 既存CSS変数分析結果（オプション、page.analyzeから再利用） */
  css_variables: z
    .record(z.string(), z.string())
    .optional()
    .describe('既存CSS変数分析結果（page.analyzeからの再利用）'),

  /** 既存モーション分析結果（オプション、page.analyzeから再利用） */
  motion_patterns: z
    .array(z.object({
      type: z.string(),
      category: z.string().optional(),
      properties: z.array(z.string()).optional(),
      duration: z.number().optional(),
      easing: z.string().optional(),
    }))
    .optional()
    .describe('既存モーション分析結果（page.analyzeからの再利用）'),

  /** タイムアウト（ms） */
  timeout: z
    .number()
    .int({ message: 'timeoutは整数である必要があります' })
    .min(5000, { message: 'timeoutは5000以上120000以下である必要があります' })
    .max(120000, { message: 'timeoutは5000以上120000以下である必要があります' })
    .optional()
    .default(60000)
    .describe('分析タイムアウト（ms）（デフォルト: 60000）'),
});
export type NarrativeAnalyzeOptions = z.infer<typeof narrativeAnalyzeOptionsSchema>;

/**
 * narrative.analyze 入力スキーマ
 *
 * urlまたはhtmlのいずれか一方のみ指定可能
 *
 * @property url - 分析対象URL（urlまたはhtmlのいずれか必須）
 * @property html - HTMLコンテンツ（urlまたはhtmlのいずれか必須）
 * @property screenshot - スクリーンショット（Base64、urlなしの場合必須）
 * @property options - オプション
 */
export const narrativeAnalyzeInputSchema = z
  .object({
    /** 分析対象URL */
    url: z
      .string()
      .url({ message: '有効なURL形式を指定してください' })
      .optional()
      .describe('分析対象URL（urlまたはhtmlのいずれか必須）'),

    /** HTMLコンテンツ（最大10MB） */
    html: z
      .string()
      .min(1, { message: 'HTMLコンテンツは1文字以上必要です' })
      .max(10_000_000, { message: 'HTMLコンテンツは10MB以下にしてください' })
      .optional()
      .describe('分析対象HTML（urlまたはhtmlのいずれか必須）'),

    /** スクリーンショット（Base64エンコード） */
    screenshot: z
      .string()
      .min(1, { message: 'スクリーンショットは空文字列にできません' })
      .optional()
      .describe('Base64エンコードスクリーンショット（urlなし + include_vision時に必須）'),

    /** オプション */
    options: narrativeAnalyzeOptionsSchema.optional(),
  })
  .refine(
    (data) => {
      const hasUrl = data.url !== undefined;
      const hasHtml = data.html !== undefined;
      // urlまたはhtmlのいずれか一方が必須
      return hasUrl || hasHtml;
    },
    {
      message: 'urlまたはhtmlのいずれかを指定してください',
    }
  )
  .refine(
    (data) => {
      const hasUrl = data.url !== undefined;
      const hasHtml = data.html !== undefined;
      // 両方同時に指定は不可
      return !(hasUrl && hasHtml);
    },
    {
      message: 'urlとhtmlを同時に指定することはできません',
    }
  )
  .refine(
    (data) => {
      // html指定 + include_vision = true の場合、screenshotが必須
      const hasUrl = data.url !== undefined;
      const includeVision = data.options?.include_vision !== false; // デフォルトtrue
      const hasScreenshot = data.screenshot !== undefined;

      if (!hasUrl && includeVision) {
        return hasScreenshot;
      }
      return true;
    },
    {
      message: 'html指定時にVision分析を使用する場合はscreenshotが必須です',
      path: ['screenshot'],
    }
  );
export type NarrativeAnalyzeInput = z.infer<typeof narrativeAnalyzeInputSchema>;

// ============================================================================
// narrative.analyze Output Schemas
// ============================================================================

/**
 * 色彩印象スキーマ
 */
export const colorImpressionSchema = z.object({
  /** 全体的な印象 */
  overall: z.string().describe('全体的な色彩印象（例: "warm and inviting"）'),
  /** 支配的な感情 */
  dominantEmotion: z.string().describe('支配的な感情（例: "trust", "excitement"）'),
  /** 配色調和タイプ */
  harmony: colorHarmonySchema,
});
export type ColorImpression = z.infer<typeof colorImpressionSchema>;

/**
 * タイポグラフィの性格スキーマ
 */
export const typographyPersonalitySchema = z.object({
  /** スタイル */
  style: z.string().describe('タイポグラフィスタイル（例: "modern", "classic"）'),
  /** 読みやすさ */
  readability: z.enum(['high', 'medium', 'low']),
  /** 階層の明確さ */
  hierarchy: z.enum(['clear', 'subtle', 'flat']),
});
export type TypographyPersonality = z.infer<typeof typographyPersonalitySchema>;

/**
 * モーションの感情スキーマ
 */
export const motionEmotionSchema = z.object({
  /** 全体的な印象 */
  overall: z.string().describe('モーションの全体印象（例: "smooth and elegant"）'),
  /** ペース */
  pace: z.enum(['slow', 'moderate', 'fast']),
  /** 強度（0-1） */
  intensity: z.number().min(0).max(1),
  /** prefers-reduced-motion対応 */
  accessibility: z.boolean(),
});
export type MotionEmotion = z.infer<typeof motionEmotionSchema>;

/**
 * 全体的なトーンスキーマ
 */
export const overallToneSchema = z.object({
  /** プライマリートーン */
  primary: z.string().describe('プライマリートーン（例: "professional"）'),
  /** フォーマル度（0-1） */
  formality: z.number().min(0).max(1),
  /** エネルギー度（0-1） */
  energy: z.number().min(0).max(1),
});
export type OverallTone = z.infer<typeof overallToneSchema>;

/**
 * 世界観・雰囲気スキーマ
 */
export const worldViewSchema = z.object({
  /** ムードカテゴリ */
  moodCategory: moodCategorySchema,
  /** セカンダリームードカテゴリ（オプション） */
  secondaryMoodCategory: moodCategorySchema.optional(),
  /** ムードの説明 */
  moodDescription: z.string().describe('ムードの自然言語説明'),
  /** 色彩印象 */
  colorImpression: colorImpressionSchema,
  /** タイポグラフィの性格 */
  typographyPersonality: typographyPersonalitySchema,
  /** モーションの感情（モーションがある場合） */
  motionEmotion: motionEmotionSchema.optional(),
  /** 全体的なトーン */
  overallTone: overallToneSchema,
});
export type WorldView = z.infer<typeof worldViewSchema>;

/**
 * ブレークポイントスキーマ
 */
export const breakpointsSchema = z.object({
  mobile: z.string().optional(),
  tablet: z.string().optional(),
  desktop: z.string().optional(),
  wide: z.string().optional(),
});
export type Breakpoints = z.infer<typeof breakpointsSchema>;

/**
 * グリッドシステムスキーマ
 */
export const gridSystemSchema = z.object({
  /** グリッドタイプ */
  type: gridTypeSchema,
  /** カラム数（'fluid'も許容） */
  columns: z.union([z.number().int().positive(), z.literal('fluid')]),
  /** ガター幅 */
  gutterWidth: z.string().optional(),
  /** コンテナ幅 */
  containerWidth: z.string().optional(),
  /** ブレークポイント */
  breakpoints: breakpointsSchema.optional(),
});
export type GridSystem = z.infer<typeof gridSystemSchema>;

/**
 * 視覚的重み分布スキーマ
 */
export const weightDistributionSchema = z.object({
  top: z.number().min(0).max(1),
  middle: z.number().min(0).max(1),
  bottom: z.number().min(0).max(1),
});
export type WeightDistribution = z.infer<typeof weightDistributionSchema>;

/**
 * 視覚的階層スキーマ
 */
export const visualHierarchySchema = z.object({
  /** 主要要素 */
  primaryElements: z.array(z.string()),
  /** 二次要素 */
  secondaryElements: z.array(z.string()),
  /** 三次要素 */
  tertiaryElements: z.array(z.string()),
  /** セクション配置パターン */
  sectionFlow: sectionFlowSchema,
  /** 視覚的重み分布 */
  weightDistribution: weightDistributionSchema,
});
export type VisualHierarchy = z.infer<typeof visualHierarchySchema>;

/**
 * セクション間スペーシングスキーマ
 */
export const sectionGapsSchema = z.object({
  min: z.string(),
  max: z.string(),
  average: z.string(),
});
export type SectionGaps = z.infer<typeof sectionGapsSchema>;

/**
 * スペーシングリズムスキーマ
 */
export const spacingRhythmSchema = z.object({
  /** 基準単位 */
  baseUnit: z.string(),
  /** スケール倍率 */
  scale: z.array(z.number()),
  /** スケール名 */
  scaleName: z.enum(['fibonacci', 'linear', 'geometric', 'custom']).optional(),
  /** セクション間スペーシング */
  sectionGaps: sectionGapsSchema,
});
export type SpacingRhythm = z.infer<typeof spacingRhythmSchema>;

/**
 * セクション間関係性スキーマ
 */
export const sectionRelationshipSchema = z.object({
  /** ソースセクションID */
  sourceId: z.string(),
  /** ターゲットセクションID */
  targetId: z.string(),
  /** 関係タイプ */
  relationshipType: z.enum(['follows', 'contains', 'parallels', 'contrasts']),
  /** 関係の強さ（0-1） */
  strength: z.number().min(0).max(1),
});
export type SectionRelationship = z.infer<typeof sectionRelationshipSchema>;

/**
 * 画像配置パターンスキーマ
 */
export const imageLayoutSchema = z.object({
  /** パターン */
  pattern: z.enum(['full-bleed', 'contained', 'scattered', 'grid', 'none']),
  /** アスペクト比 */
  aspectRatios: z.array(z.string()),
  /** 配置位置 */
  positions: z.array(z.enum(['hero', 'inline', 'background', 'decorative'])),
});
export type ImageLayout = z.infer<typeof imageLayoutSchema>;

/**
 * 装飾要素スキーマ
 */
export const decorationsSchema = z.object({
  hasGradients: z.boolean(),
  hasShadows: z.boolean(),
  hasBorders: z.boolean(),
  hasIllustrations: z.boolean(),
});
export type Decorations = z.infer<typeof decorationsSchema>;

/**
 * 視覚的バランススキーマ
 */
export const visualBalanceSchema = z.object({
  /** 対称性 */
  symmetry: z.enum(['symmetric', 'asymmetric', 'dynamic']),
  /** 密度 */
  density: z.enum(['sparse', 'balanced', 'dense']),
  /** ホワイトスペース比率（0-1） */
  whitespace: z.number().min(0).max(1),
});
export type VisualBalance = z.infer<typeof visualBalanceSchema>;

/**
 * グラフィック要素スキーマ
 */
export const graphicElementsSchema = z.object({
  /** 画像配置パターン */
  imageLayout: imageLayoutSchema,
  /** 装飾要素 */
  decorations: decorationsSchema,
  /** 視覚的バランス */
  visualBalance: visualBalanceSchema,
});
export type GraphicElements = z.infer<typeof graphicElementsSchema>;

/**
 * レイアウト構成スキーマ
 */
export const layoutStructureSchema = z.object({
  /** グリッドシステム */
  gridSystem: gridSystemSchema,
  /** 視覚的階層 */
  visualHierarchy: visualHierarchySchema,
  /** スペーシングリズム */
  spacingRhythm: spacingRhythmSchema,
  /** セクション間関係性 */
  sectionRelationships: z.array(sectionRelationshipSchema),
  /** グラフィック要素 */
  graphicElements: graphicElementsSchema,
});
export type LayoutStructure = z.infer<typeof layoutStructureSchema>;

/**
 * 信頼度内訳スキーマ
 */
export const confidenceBreakdownSchema = z.object({
  /** Vision LLM分析信頼度 */
  visionAnalysis: z.number().min(0).max(1),
  /** CSS静的分析信頼度 */
  cssStaticAnalysis: z.number().min(0).max(1),
  /** HTML構造分析信頼度 */
  htmlStructureAnalysis: z.number().min(0).max(1),
  /** モーション分析信頼度 */
  motionAnalysis: z.number().min(0).max(1),
});
export type ConfidenceBreakdown = z.infer<typeof confidenceBreakdownSchema>;

/**
 * 信頼度スキーマ
 */
export const confidenceScoreSchema = z.object({
  /** 総合信頼度 */
  overall: z.number().min(0).max(1),
  /** 世界観分析信頼度 */
  worldView: z.number().min(0).max(1),
  /** レイアウト分析信頼度 */
  layoutStructure: z.number().min(0).max(1),
  /** 詳細内訳 */
  breakdown: confidenceBreakdownSchema,
});
export type ConfidenceScore = z.infer<typeof confidenceScoreSchema>;

/**
 * narrative.analyze 成功レスポンスデータスキーマ
 */
export const narrativeAnalyzeDataSchema = z.object({
  /** DB保存時のID（save_to_db: true時のみ） */
  id: z.string().uuid().optional(),
  /** 関連WebPageのID（存在する場合） */
  webPageId: z.string().uuid().optional(),

  // 世界観・雰囲気
  /** 世界観 */
  worldView: worldViewSchema,

  // レイアウト構成
  /** レイアウト構成 */
  layoutStructure: layoutStructureSchema,

  // メタデータ
  /** 信頼度 */
  confidence: confidenceScoreSchema,
  /** 分析日時 */
  analyzedAt: z.string().datetime(),
  /** 分析所要時間（ms） */
  analysisTimeMs: z.number().nonnegative().optional(),
  /** Vision分析が使用されたか */
  visionUsed: z.boolean().optional(),
  /** フォールバック理由（Vision未使用時） */
  fallbackReason: z.string().optional(),
  /** 分析器バージョン */
  analyzerVersion: z.string().optional(),
});
export type NarrativeAnalyzeData = z.infer<typeof narrativeAnalyzeDataSchema>;

/**
 * narrative.analyze 警告スキーマ
 */
export const narrativeAnalyzeWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type NarrativeAnalyzeWarning = z.infer<typeof narrativeAnalyzeWarningSchema>;

/**
 * narrative.analyze エラー情報スキーマ
 */
export const narrativeAnalyzeErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type NarrativeAnalyzeErrorInfo = z.infer<typeof narrativeAnalyzeErrorInfoSchema>;

/**
 * narrative.analyze 成功レスポンススキーマ
 */
export const narrativeAnalyzeSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: narrativeAnalyzeDataSchema,
  warnings: z.array(narrativeAnalyzeWarningSchema).optional(),
});

/**
 * narrative.analyze 失敗レスポンススキーマ
 */
export const narrativeAnalyzeErrorOutputSchema = z.object({
  success: z.literal(false),
  error: narrativeAnalyzeErrorInfoSchema,
});

/**
 * narrative.analyze 出力スキーマ（統合）
 */
export const narrativeAnalyzeOutputSchema = z.discriminatedUnion('success', [
  narrativeAnalyzeSuccessOutputSchema,
  narrativeAnalyzeErrorOutputSchema,
]);
export type NarrativeAnalyzeOutput = z.infer<typeof narrativeAnalyzeOutputSchema>;

// ============================================================================
// narrative.search Input Schemas
// ============================================================================

/**
 * narrative.search フィルタースキーマ
 */
export const narrativeSearchFiltersSchema = z.object({
  /** ムードカテゴリでフィルター */
  moodCategory: moodCategorySchema.optional(),
  /** 最小信頼度 */
  minConfidence: z
    .number()
    .min(0, { message: 'minConfidenceは0以上1以下である必要があります' })
    .max(1, { message: 'minConfidenceは0以上1以下である必要があります' })
    .optional()
    .describe('最小信頼度フィルター（0-1）'),
});
export type NarrativeSearchFilters = z.infer<typeof narrativeSearchFiltersSchema>;

/**
 * narrative.search オプションスキーマ
 */
export const narrativeSearchOptionsSchema = z.object({
  /** 結果数（デフォルト10） */
  limit: z
    .number()
    .int({ message: 'limitは整数である必要があります' })
    .min(1, { message: 'limitは1以上50以下である必要があります' })
    .max(50, { message: 'limitは1以上50以下である必要があります' })
    .optional()
    .default(10),

  /** 最小類似度（デフォルト0.6） */
  minSimilarity: z
    .number()
    .min(0, { message: 'minSimilarityは0以上1以下である必要があります' })
    .max(1, { message: 'minSimilarityは0以上1以下である必要があります' })
    .optional()
    .default(0.6),

  /** 検索モード（デフォルトhybrid） */
  searchMode: narrativeSearchModeSchema.optional().default('hybrid'),

  /** Vector検索の重み（hybridモード時、デフォルト0.6） */
  vectorWeight: z
    .number()
    .min(0, { message: 'vectorWeightは0以上1以下である必要があります' })
    .max(1, { message: 'vectorWeightは0以上1以下である必要があります' })
    .optional()
    .default(0.6),

  /** Full-text検索の重み（hybridモード時、デフォルト0.4） */
  fulltextWeight: z
    .number()
    .min(0, { message: 'fulltextWeightは0以上1以下である必要があります' })
    .max(1, { message: 'fulltextWeightは0以上1以下である必要があります' })
    .optional()
    .default(0.4),
});
export type NarrativeSearchOptions = z.infer<typeof narrativeSearchOptionsSchema>;

/**
 * narrative.search 入力スキーマ
 *
 * queryまたはembeddingのいずれか一方のみ指定可能
 */
export const narrativeSearchInputSchema = z
  .object({
    /** 自然言語クエリ */
    query: z
      .string()
      .min(1, { message: 'クエリは1文字以上必要です' })
      .max(500, { message: 'クエリは500文字以下にしてください' })
      .optional()
      .describe('検索クエリ（例: "サイバーセキュリティ感のあるダークなデザイン"）'),

    /** 直接Embedding指定（768次元） */
    embedding: z
      .array(z.number())
      .length(768, { message: 'embeddingは768次元である必要があります' })
      .optional()
      .describe('直接Embedding指定（768次元）'),

    /** フィルター */
    filters: narrativeSearchFiltersSchema.optional(),

    /** オプション */
    options: narrativeSearchOptionsSchema.optional(),
  })
  .refine(
    (data) => {
      const hasQuery = data.query !== undefined;
      const hasEmbedding = data.embedding !== undefined;
      // queryまたはembeddingのいずれか一方が必須
      return hasQuery || hasEmbedding;
    },
    {
      message: 'queryまたはembeddingのいずれかを指定してください',
    }
  )
  .refine(
    (data) => {
      const hasQuery = data.query !== undefined;
      const hasEmbedding = data.embedding !== undefined;
      // 両方同時に指定は不可
      return !(hasQuery && hasEmbedding);
    },
    {
      message: 'queryとembeddingを同時に指定することはできません',
    }
  );
export type NarrativeSearchInput = z.infer<typeof narrativeSearchInputSchema>;

// ============================================================================
// narrative.search Output Schemas
// ============================================================================

/**
 * 検索結果の世界観サマリースキーマ
 */
export const worldViewSummarySchema = z.object({
  moodCategory: moodCategorySchema,
  moodDescription: z.string(),
  overallTone: z.string(),
});
export type WorldViewSummary = z.infer<typeof worldViewSummarySchema>;

/**
 * 検索結果のレイアウトサマリースキーマ
 */
export const layoutStructureSummarySchema = z.object({
  gridType: gridTypeSchema,
  columns: z.union([z.number().int().positive(), z.literal('fluid')]),
});
export type LayoutStructureSummary = z.infer<typeof layoutStructureSummarySchema>;

/**
 * 検索結果アイテムスキーマ
 */
export const narrativeSearchResultItemSchema = z.object({
  /** DesignNarrative ID */
  id: z.string().uuid(),
  /** WebPage ID */
  webPageId: z.string().uuid(),
  /** ソースURL */
  sourceUrl: z.string().url(),
  /** 類似度 */
  similarity: z.number().min(0).max(1),

  /** 世界観サマリー */
  worldView: worldViewSummarySchema,

  /** レイアウト構成サマリー */
  layoutStructure: layoutStructureSummarySchema,

  /** 信頼度 */
  confidence: z.number().min(0).max(1),
});
export type NarrativeSearchResultItem = z.infer<typeof narrativeSearchResultItemSchema>;

/**
 * 検索情報スキーマ
 */
export const narrativeSearchInfoSchema = z.object({
  /** 検索クエリ（embedding指定時は"[embedding]"） */
  query: z.string(),
  /** 検索モード */
  searchMode: narrativeSearchModeSchema,
  /** 総結果数 */
  totalResults: z.number().int().nonnegative(),
  /** 検索所要時間（ms） */
  searchTimeMs: z.number().nonnegative(),
});
export type NarrativeSearchInfo = z.infer<typeof narrativeSearchInfoSchema>;

/**
 * narrative.search 成功レスポンスデータスキーマ
 */
export const narrativeSearchDataSchema = z.object({
  /** 検索結果 */
  results: z.array(narrativeSearchResultItemSchema),
  /** 検索情報 */
  searchInfo: narrativeSearchInfoSchema,
});
export type NarrativeSearchData = z.infer<typeof narrativeSearchDataSchema>;

/**
 * narrative.search エラー情報スキーマ
 */
export const narrativeSearchErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type NarrativeSearchErrorInfo = z.infer<typeof narrativeSearchErrorInfoSchema>;

/**
 * narrative.search 成功レスポンススキーマ
 */
export const narrativeSearchSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: narrativeSearchDataSchema,
});

/**
 * narrative.search 失敗レスポンススキーマ
 */
export const narrativeSearchErrorOutputSchema = z.object({
  success: z.literal(false),
  error: narrativeSearchErrorInfoSchema,
});

/**
 * narrative.search 出力スキーマ（統合）
 */
export const narrativeSearchOutputSchema = z.discriminatedUnion('success', [
  narrativeSearchSuccessOutputSchema,
  narrativeSearchErrorOutputSchema,
]);
export type NarrativeSearchOutput = z.infer<typeof narrativeSearchOutputSchema>;

// ============================================================================
// Error Codes
// ============================================================================

/**
 * narrative.* ツール用エラーコード
 */
export const NARRATIVE_MCP_ERROR_CODES = {
  /** バリデーションエラー */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** 分析失敗 */
  ANALYSIS_FAILED: 'ANALYSIS_FAILED',
  /** Vision分析失敗 */
  VISION_ANALYSIS_FAILED: 'VISION_ANALYSIS_FAILED',
  /** タイムアウト */
  TIMEOUT: 'TIMEOUT',
  /** ページが見つからない */
  PAGE_NOT_FOUND: 'PAGE_NOT_FOUND',
  /** Narrativeが見つからない */
  NARRATIVE_NOT_FOUND: 'NARRATIVE_NOT_FOUND',
  /** DB保存失敗 */
  DB_SAVE_FAILED: 'DB_SAVE_FAILED',
  /** 検索失敗 */
  SEARCH_FAILED: 'SEARCH_FAILED',
  /** Embedding生成失敗 */
  EMBEDDING_FAILED: 'EMBEDDING_FAILED',
  /** SSRF対策によりブロック */
  SSRF_BLOCKED: 'SSRF_BLOCKED',
  /** ネットワークエラー */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** 内部エラー */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type NarrativeMcpErrorCode =
  (typeof NARRATIVE_MCP_ERROR_CODES)[keyof typeof NARRATIVE_MCP_ERROR_CODES];

// ============================================================================
// MCP Tool Definitions
// ============================================================================

/**
 * MCP Tool definitions for narrative.* tools
 * MCPプロトコル準拠のツール定義
 */
export const narrativeMcpTools = {
  'narrative.analyze': {
    name: 'narrative.analyze',
    description:
      'URLまたはHTMLからWebデザインの世界観（WorldView）とレイアウト構成（LayoutStructure）を分析します。' +
      'Vision LLMとCSS静的分析を組み合わせ、ムードカテゴリ・色彩印象・グリッドシステム・視覚的階層等を抽出します。',
    inputSchema: narrativeAnalyzeInputSchema,
  },
  'narrative.search': {
    name: 'narrative.search',
    description:
      '世界観・レイアウト構成でセマンティック検索します。' +
      '自然言語クエリ（例: "サイバーセキュリティ感のあるダークなデザイン"）または768次元Embeddingで検索可能。' +
      'Hybrid Search（Vector + Full-text）でRRF統合。',
    inputSchema: narrativeSearchInputSchema,
  },
} as const;

export type NarrativeMcpToolName = keyof typeof narrativeMcpTools;

// ============================================================================
// page.analyze 統合用オプションスキーマ
// ============================================================================

/**
 * page.analyze のnarrative分析オプションスキーマ
 *
 * 既存のpage.analyzeツールに追加するオプション
 */
export const pageAnalyzeNarrativeOptionsSchema = z.object({
  /** narrative分析有効化（デフォルトtrue） — page/schemas.tsと一致 */
  enabled: z.boolean().optional().default(true),
  /** DB保存（デフォルトtrue） */
  save_to_db: z.boolean().optional().default(true),
  /** Vision LLM分析使用（デフォルトtrue） */
  include_vision: z.boolean().optional().default(true),
});
export type PageAnalyzeNarrativeOptions = z.infer<typeof pageAnalyzeNarrativeOptionsSchema>;
