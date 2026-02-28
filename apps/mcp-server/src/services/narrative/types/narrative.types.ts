// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Narrative Types - DesignNarrative分析の型定義
 *
 * 世界観・雰囲気（WorldView）とレイアウト構成（LayoutStructure）の
 * 構造化データ型を定義。
 *
 * @module services/narrative/types/narrative.types
 */

import type { CSSVariableExtractionResult } from '../../visual/css-variable-extractor.service';
import type { TypographyExtractionResult } from '../../visual/typography-extractor.service';
import type { MotionDetectionResult } from '../../page/motion-detector.service';
import type { DetectedSection } from '@reftrix/webdesign-core';
import type { VisualFeatures } from '../../../tools/page/schemas';

// =============================================================================
// MoodCategory ENUM
// =============================================================================

/**
 * ムードカテゴリ（DesignNarrative.mood_category）
 *
 * Webデザインの全体的な雰囲気を分類
 */
export type MoodCategory =
  | 'professional'    // ビジネス、企業
  | 'playful'         // 遊び心、カジュアル
  | 'premium'         // 高級、ラグジュアリー
  | 'tech'            // テクノロジー、先進的
  | 'organic'         // 自然、オーガニック
  | 'minimal'         // ミニマル、シンプル
  | 'bold'            // 大胆、インパクト
  | 'elegant'         // 上品、洗練
  | 'friendly'        // 親しみやすい
  | 'artistic'        // アート、クリエイティブ
  | 'trustworthy'     // 信頼、安心
  | 'energetic';      // エネルギッシュ、活発

/**
 * MoodCategoryの日本語名マッピング
 */
export const MoodCategoryLabels: Record<MoodCategory, string> = {
  professional: 'プロフェッショナル',
  playful: '遊び心',
  premium: 'プレミアム',
  tech: 'テクノロジー',
  organic: 'オーガニック',
  minimal: 'ミニマル',
  bold: '大胆',
  elegant: 'エレガント',
  friendly: 'フレンドリー',
  artistic: 'アーティスティック',
  trustworthy: '信頼感',
  energetic: 'エネルギッシュ',
};

// =============================================================================
// WorldView Types（世界観・雰囲気）
// =============================================================================

/**
 * 色彩印象
 */
export interface ColorImpression {
  /** 全体的な印象（"warm and inviting", "cool and professional"等） */
  overall: string;
  /** 支配的な感情（"trust", "excitement", "calm"等） */
  dominantEmotion: string;
  /** 配色調和タイプ */
  harmony: 'complementary' | 'analogous' | 'monochromatic' | 'triadic' | 'split-complementary' | 'mixed';
}

/**
 * タイポグラフィの性格
 */
export interface TypographyPersonality {
  /** スタイル（"modern", "classic", "playful", "technical"等） */
  style: string;
  /** 読みやすさ */
  readability: 'high' | 'medium' | 'low';
  /** 階層の明確さ */
  hierarchy: 'clear' | 'subtle' | 'flat';
}

/**
 * モーションの感情
 */
export interface MotionEmotion {
  /** 全体的な印象（"smooth and elegant", "dynamic and playful"等） */
  overall: string;
  /** ペース */
  pace: 'slow' | 'moderate' | 'fast';
  /** 強度（0-1） */
  intensity: number;
  /** prefers-reduced-motion対応 */
  accessibility: boolean;
}

/**
 * 全体的なトーン
 */
export interface OverallTone {
  /** プライマリートーン（"professional", "casual", "luxury"等） */
  primary: string;
  /** フォーマル度（0-1、0=カジュアル、1=フォーマル） */
  formality: number;
  /** エネルギー度（0-1、0=静的、1=動的） */
  energy: number;
}

/**
 * 世界観・雰囲気の分析結果
 */
export interface WorldViewResult {
  /** ムードカテゴリ */
  moodCategory: MoodCategory;
  /** ムードの説明（自然言語） */
  moodDescription: string;
  /** 色彩印象 */
  colorImpression: ColorImpression;
  /** タイポグラフィの性格 */
  typographyPersonality: TypographyPersonality;
  /** モーションの感情（オプション、モーションがある場合） */
  motionEmotion?: MotionEmotion;
  /** 全体的なトーン */
  overallTone: OverallTone;
}

// =============================================================================
// LayoutStructure Types（レイアウト構成）
// =============================================================================

/**
 * グリッドシステム
 */
export interface GridSystem {
  /** グリッドタイプ */
  type: 'css-grid' | 'flexbox' | 'float' | 'mixed' | 'none';
  /** カラム数（'fluid'はフルードグリッド） */
  columns: number | 'fluid';
  /** ガター幅 */
  gutterWidth?: string;
  /** コンテナ幅 */
  containerWidth?: string;
  /** ブレークポイント */
  breakpoints?: {
    mobile?: string;
    tablet?: string;
    desktop?: string;
    wide?: string;
  };
}

/**
 * 視覚的階層
 */
export interface VisualHierarchy {
  /** 主要要素（最も目立つ要素） */
  primaryElements: string[];
  /** 二次要素 */
  secondaryElements: string[];
  /** 三次要素 */
  tertiaryElements: string[];
  /** セクション配置パターン */
  sectionFlow: 'linear' | 'modular' | 'asymmetric';
  /** 視覚的重み分布 */
  weightDistribution: {
    /** 上部（hero area）の重み（0-1） */
    top: number;
    /** 中部（content area）の重み（0-1） */
    middle: number;
    /** 下部（footer area）の重み（0-1） */
    bottom: number;
  };
}

/**
 * スペーシングリズム
 */
export interface SpacingRhythm {
  /** 基準単位（'8px', '1rem'等） */
  baseUnit: string;
  /** スケール倍率 */
  scale: number[];
  /** スケール名（検出された場合） */
  scaleName?: 'fibonacci' | 'linear' | 'geometric' | 'custom';
  /** セクション間スペーシング */
  sectionGaps: {
    min: string;
    max: string;
    average: string;
  };
}

/**
 * セクション間関係性
 */
export interface SectionRelationship {
  /** ソースセクションID */
  sourceId: string;
  /** ターゲットセクションID */
  targetId: string;
  /** 関係タイプ */
  relationshipType: 'follows' | 'contains' | 'parallels' | 'contrasts';
  /** 関係の強さ（0-1） */
  strength: number;
}

/**
 * グラフィック要素
 */
export interface GraphicElements {
  /** 画像配置パターン */
  imageLayout: {
    /** パターン */
    pattern: 'full-bleed' | 'contained' | 'scattered' | 'grid' | 'none';
    /** アスペクト比 */
    aspectRatios: string[];
    /** 配置位置 */
    positions: ('hero' | 'inline' | 'background' | 'decorative')[];
  };
  /** 装飾要素 */
  decorations: {
    hasGradients: boolean;
    hasShadows: boolean;
    hasBorders: boolean;
    hasIllustrations: boolean;
  };
  /** 視覚的バランス */
  visualBalance: {
    /** 対称性 */
    symmetry: 'symmetric' | 'asymmetric' | 'dynamic';
    /** 密度 */
    density: 'sparse' | 'balanced' | 'dense';
    /** ホワイトスペース比率（0-1） */
    whitespace: number;
  };
}

/**
 * レイアウト構成の分析結果
 */
export interface LayoutStructureResult {
  /** グリッドシステム */
  gridSystem: GridSystem;
  /** 視覚的階層 */
  visualHierarchy: VisualHierarchy;
  /** スペーシングリズム */
  spacingRhythm: SpacingRhythm;
  /** セクション間関係性 */
  sectionRelationships: SectionRelationship[];
  /** グラフィック要素 */
  graphicElements: GraphicElements;
}

// =============================================================================
// Confidence Types（信頼度）
// =============================================================================

/**
 * 信頼度スコア
 */
export interface ConfidenceScore {
  /** 総合信頼度（0-1） */
  overall: number;
  /** 世界観分析信頼度（0-1） */
  worldView: number;
  /** レイアウト分析信頼度（0-1） */
  layoutStructure: number;
  /** 詳細内訳 */
  breakdown: {
    /** Vision LLM分析信頼度 */
    visionAnalysis: number;
    /** CSS静的分析信頼度 */
    cssStaticAnalysis: number;
    /** HTML構造分析信頼度 */
    htmlStructureAnalysis: number;
    /** モーション分析信頼度 */
    motionAnalysis: number;
  };
}

// =============================================================================
// Analysis Input/Output Types
// =============================================================================

/**
 * 既存分析結果（page.analyzeから渡す場合）
 */
export interface ExistingAnalysisResults {
  cssVariables?: CSSVariableExtractionResult;
  typography?: TypographyExtractionResult;
  motionPatterns?: MotionDetectionResult;
  sections?: DetectedSection[];
  visualFeatures?: VisualFeatures;
}

/**
 * 分析オプション
 */
export interface NarrativeAnalysisOptions {
  /** Vision分析を強制（フォールバックなし） */
  forceVision?: boolean;
  /** Vision分析タイムアウト（ms） */
  visionTimeoutMs?: number;
  /** Embedding生成を含むか（default: true） */
  generateEmbedding?: boolean;
}

/**
 * 分析入力
 */
export interface NarrativeAnalysisInput {
  /** WebPage ID（既存WebPageレコードがある場合） */
  webPageId?: string;
  /** Base64スクリーンショット */
  screenshot?: string;
  /** サニタイズ済みHTML */
  html: string;
  /** 外部CSS（取得済みの場合） */
  externalCss?: string;
  /** 既存分析結果 */
  existingAnalysis?: ExistingAnalysisResults;
  /** 分析オプション */
  options?: NarrativeAnalysisOptions;
}

/**
 * 分析メタデータ
 */
export interface NarrativeAnalysisMetadata {
  /** Embedding生成に使用したテキスト表現 */
  textRepresentation: string;
  /** 768次元Embedding（生成した場合） */
  embedding?: number[];
  /** 信頼度スコア */
  confidence: ConfidenceScore;
  /** 分析所要時間（ms） */
  analysisTimeMs: number;
  /** Vision分析が使用されたか */
  visionUsed: boolean;
  /** フォールバック理由（Vision未使用時） */
  fallbackReason?: string;
}

/**
 * 分析結果
 */
export interface NarrativeAnalysisResult {
  /** 世界観・雰囲気 */
  worldView: WorldViewResult;
  /** レイアウト構成 */
  layoutStructure: LayoutStructureResult;
  /** メタデータ */
  metadata: NarrativeAnalysisMetadata;
}

// =============================================================================
// Persistence Types
// =============================================================================

/**
 * 保存済みNarrative
 */
export interface SavedNarrative {
  /** DesignNarrative ID */
  id: string;
  /** WebPage ID */
  webPageId: string;
  /** Embedding がDBに保存されたか */
  embeddingSaved: boolean;
  /** 作成日時 */
  createdAt: Date;
  /** 更新日時 */
  updatedAt: Date;
}

// =============================================================================
// Search Types
// =============================================================================

/**
 * 検索オプション
 */
export interface NarrativeSearchOptions {
  /** 検索クエリ */
  query: string;
  /** 取得件数（default: 10） */
  limit?: number;
  /** Vector検索の重み（default: 0.6） */
  vectorWeight?: number;
  /** Full-text検索の重み（default: 0.4） */
  fulltextWeight?: number;
  /** フィルター */
  filters?: {
    /** ムードカテゴリでフィルター */
    moodCategory?: MoodCategory[];
    /** 最小信頼度でフィルター */
    minConfidence?: number;
  };
}

/**
 * 検索結果
 */
export interface NarrativeSearchResult {
  /** DesignNarrative ID */
  id: string;
  /** WebPage ID */
  webPageId: string;
  /** RRF結合スコア */
  score: number;
  /** Vector検索スコア */
  vectorScore: number;
  /** Full-text検索スコア */
  fulltextScore: number;
  /** ムードカテゴリ */
  moodCategory: MoodCategory;
  /** ムードの説明 */
  moodDescription: string;
  /** 信頼度 */
  confidence: number;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * NarrativeAnalysisService インターフェース
 */
export interface INarrativeAnalysisService {
  /**
   * Webページを分析してNarrativeを生成
   */
  analyze(input: NarrativeAnalysisInput): Promise<NarrativeAnalysisResult>;

  /**
   * 分析結果をDBに保存
   */
  save(
    webPageId: string,
    result: NarrativeAnalysisResult
  ): Promise<SavedNarrative>;

  /**
   * 分析と保存を一括実行
   */
  analyzeAndSave(input: NarrativeAnalysisInput): Promise<SavedNarrative>;

  /**
   * Narrative検索（ベクトル検索のみ）
   */
  search(options: NarrativeSearchOptions): Promise<NarrativeSearchResult[]>;

  /**
   * Narrative Hybrid検索（ベクトル + 全文検索 → RRF マージ）
   *
   * 全文検索が失敗した場合はベクトル検索のみにフォールバック。
   * メソッドが存在しない場合は search() にフォールバック。
   */
  searchHybrid?: (options: NarrativeSearchOptions) => Promise<NarrativeSearchResult[]>;
}
