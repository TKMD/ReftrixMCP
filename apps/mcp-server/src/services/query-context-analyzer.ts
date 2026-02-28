// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * QueryContextAnalyzer - クエリからコンテキストを自動推論
 * REFTRIX-LAYOUT-02: layout.searchのauto_detect_context機能
 *
 * 機能:
 * - 検索クエリから業界（industry）を推論
 * - 検索クエリからスタイル（style）を推論
 * - 推論結果の信頼度スコアを算出
 * - 検出キーワードのリストを返却
 *
 * @module services/query-context-analyzer
 */

import { logger, isDevelopment } from '../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * 推論された業界タイプ
 */
export type InferredIndustry =
  | 'technology'
  | 'ecommerce'
  | 'healthcare'
  | 'finance'
  | 'education'
  | 'media'
  | 'travel'
  | 'food'
  | 'real_estate'
  | 'automotive'
  | null;

/**
 * 推論されたスタイルタイプ
 */
export type InferredStyle =
  | 'minimal'
  | 'bold'
  | 'corporate'
  | 'playful'
  | 'elegant'
  | 'modern'
  | 'vintage'
  | 'tech'
  | null;

/**
 * 推論結果
 */
export interface InferredContext {
  /** 推論された業界 */
  industry: InferredIndustry;
  /** 推論されたスタイル */
  style: InferredStyle;
  /** 推論の信頼度（0-1） */
  confidence: number;
  /** 検出されたキーワード */
  detectedKeywords: string[];
}

/**
 * キーワードマッピング定義
 */
interface KeywordMapping {
  keywords: string[];
  weight: number;
}

// =====================================================
// キーワード辞書
// =====================================================

/**
 * 業界キーワードマッピング
 */
const INDUSTRY_KEYWORDS: Record<Exclude<InferredIndustry, null>, KeywordMapping> = {
  technology: {
    keywords: [
      'saas', 'software', 'tech', 'startup', 'app', 'platform', 'api',
      'cloud', 'ai', 'machine learning', 'devops', 'developer', 'coding',
      'dashboard', 'analytics', 'b2b', 'enterprise', 'workflow', 'automation',
      'integration', 'infrastructure', 'data', 'cybersecurity', 'blockchain',
      // 日本語
      'ソフトウェア', 'テック', 'スタートアップ', 'プラットフォーム',
      'クラウド', 'ダッシュボード', '分析', 'エンタープライズ',
    ],
    weight: 1.0,
  },
  ecommerce: {
    keywords: [
      'ecommerce', 'e-commerce', 'shop', 'store', 'product', 'cart', 'checkout',
      'marketplace', 'retail', 'shopping', 'buy', 'sell', 'merchant', 'inventory',
      'catalog', 'payment', 'order', 'customer', 'commerce', 'd2c', 'dtc',
      // 日本語
      'ショップ', 'ストア', '商品', 'カート', 'マーケットプレイス',
      '小売', 'ショッピング', '販売', '在庫', 'カタログ',
    ],
    weight: 1.0,
  },
  healthcare: {
    keywords: [
      'healthcare', 'health', 'medical', 'hospital', 'clinic', 'doctor',
      'patient', 'medicine', 'pharmaceutical', 'wellness', 'fitness',
      'telemedicine', 'diagnosis', 'treatment', 'therapy', 'nursing',
      // 日本語
      'ヘルスケア', '医療', '病院', 'クリニック', '医師',
      '患者', '医薬品', 'ウェルネス', 'フィットネス', '診断',
    ],
    weight: 1.0,
  },
  finance: {
    keywords: [
      'finance', 'fintech', 'bank', 'banking', 'investment', 'insurance',
      'trading', 'crypto', 'cryptocurrency', 'wallet', 'payment', 'loan',
      'mortgage', 'stock', 'fund', 'portfolio', 'wealth', 'credit',
      // 日本語
      '金融', '銀行', '投資', '保険', '取引',
      '暗号通貨', 'ウォレット', '決済', 'ローン', '株式',
    ],
    weight: 1.0,
  },
  education: {
    keywords: [
      'education', 'learning', 'course', 'school', 'university', 'student',
      'teacher', 'training', 'tutorial', 'lesson', 'class', 'academy',
      'e-learning', 'edtech', 'mooc', 'certification', 'skill',
      // 日本語
      '教育', '学習', 'コース', '学校', '大学',
      '学生', '先生', 'トレーニング', 'チュートリアル', 'レッスン',
    ],
    weight: 1.0,
  },
  media: {
    keywords: [
      'media', 'news', 'blog', 'magazine', 'podcast', 'video', 'streaming',
      'content', 'entertainment', 'music', 'film', 'publishing', 'journalist',
      'editor', 'broadcast', 'social media', 'influencer',
      // 日本語
      'メディア', 'ニュース', 'ブログ', '雑誌', 'ポッドキャスト',
      '動画', 'ストリーミング', 'コンテンツ', 'エンタメ', '音楽',
    ],
    weight: 0.9,
  },
  travel: {
    keywords: [
      'travel', 'hotel', 'booking', 'flight', 'vacation', 'tourism',
      'destination', 'resort', 'airline', 'cruise', 'adventure', 'trip',
      // 日本語
      '旅行', 'ホテル', '予約', 'フライト', 'バケーション',
      '観光', 'リゾート', '航空', 'クルーズ', '冒険',
    ],
    weight: 0.9,
  },
  food: {
    keywords: [
      'food', 'restaurant', 'recipe', 'cooking', 'delivery', 'menu',
      'cafe', 'bar', 'catering', 'chef', 'cuisine', 'dining',
      // 日本語
      'フード', 'レストラン', 'レシピ', '料理', 'デリバリー',
      'メニュー', 'カフェ', 'ケータリング', 'シェフ', 'ダイニング',
    ],
    weight: 0.9,
  },
  real_estate: {
    keywords: [
      'real estate', 'property', 'home', 'house', 'apartment', 'rent',
      'mortgage', 'listing', 'agent', 'realtor', 'building', 'construction',
      // 日本語
      '不動産', '物件', '住宅', 'マンション', '賃貸',
      'ローン', '物件情報', 'エージェント', '建設',
    ],
    weight: 0.9,
  },
  automotive: {
    keywords: [
      'automotive', 'car', 'vehicle', 'auto', 'motor', 'dealer', 'electric',
      'ev', 'hybrid', 'truck', 'suv', 'motorcycle', 'driving',
      // 日本語
      '自動車', '車', '電気自動車', 'EV', 'ディーラー',
      'トラック', 'バイク', 'ドライブ',
    ],
    weight: 0.9,
  },
};

/**
 * スタイルキーワードマッピング
 */
const STYLE_KEYWORDS: Record<Exclude<InferredStyle, null>, KeywordMapping> = {
  minimal: {
    keywords: [
      'minimal', 'minimalist', 'clean', 'simple', 'whitespace', 'sparse',
      'understated', 'subtle', 'refined', 'zen', 'calm', 'quiet',
      // 日本語
      'ミニマル', 'シンプル', 'クリーン', 'ホワイトスペース', '落ち着いた',
    ],
    weight: 1.0,
  },
  bold: {
    keywords: [
      'bold', 'dramatic', 'striking', 'intense', 'powerful',
      'strong', 'impactful', 'contrast', 'gradient', 'vivid',
      // 日本語
      'ボールド', 'ドラマチック', 'ビビッド', 'インパクト',
    ],
    weight: 1.0,
  },
  corporate: {
    keywords: [
      'corporate', 'professional', 'business', 'enterprise', 'formal',
      'trustworthy', 'reliable', 'established', 'traditional', 'conservative',
      // 日本語
      'コーポレート', 'プロフェッショナル', 'ビジネス', 'フォーマル', '信頼',
    ],
    weight: 1.0,
  },
  playful: {
    keywords: [
      'playful', 'fun', 'creative', 'whimsical', 'quirky', 'friendly',
      'casual', 'youthful', 'energetic', 'lively', 'cheerful', 'animated',
      'colorful', 'vibrant',
      // 日本語
      '遊び心', '楽しい', 'クリエイティブ', 'フレンドリー', 'カジュアル', 'カラフル',
    ],
    weight: 1.0,
  },
  elegant: {
    keywords: [
      'elegant', 'luxury', 'premium', 'sophisticated', 'refined', 'classy',
      'upscale', 'exclusive', 'high-end', 'chic', 'stylish', 'graceful',
      // 日本語
      'エレガント', 'ラグジュアリー', 'プレミアム', '洗練', '上品',
    ],
    weight: 1.0,
  },
  modern: {
    keywords: [
      'modern', 'contemporary', 'sleek', 'cutting-edge', 'innovative',
      'trendy', 'fresh', 'current', 'up-to-date', 'progressive',
      // 日本語
      'モダン', 'コンテンポラリー', 'スリーク', '革新的', 'トレンド',
    ],
    weight: 0.9,
  },
  vintage: {
    keywords: [
      'vintage', 'retro', 'classic', 'nostalgic', 'old-school', 'antique',
      'timeless', 'heritage', 'traditional', 'rustic',
      // 日本語
      'ビンテージ', 'レトロ', 'クラシック', 'ノスタルジック', '伝統的',
    ],
    weight: 0.9,
  },
  tech: {
    keywords: [
      'tech', 'futuristic', 'digital', 'cyber', 'neon', 'sci-fi',
      'dark mode', 'glassmorphism', 'neumorphism', 'gradient',
      // 日本語
      'テック', '未来的', 'デジタル', 'サイバー', 'ネオン',
    ],
    weight: 0.9,
  },
};

// =====================================================
// QueryContextAnalyzer クラス
// =====================================================

/**
 * クエリからコンテキストを自動推論するサービス
 */
export class QueryContextAnalyzer {
  /**
   * クエリからコンテキストを推論
   *
   * @param query - 検索クエリ
   * @returns 推論結果
   */
  inferContext(query: string): InferredContext {
    const normalizedQuery = this.normalizeQuery(query);
    const detectedKeywords: string[] = [];

    // 業界推論
    const industryResult = this.inferIndustry(normalizedQuery, detectedKeywords);

    // スタイル推論
    const styleResult = this.inferStyle(normalizedQuery, detectedKeywords);

    // 信頼度計算
    const confidence = this.calculateConfidence(industryResult, styleResult);

    if (isDevelopment()) {
      logger.debug('[QueryContextAnalyzer] inferContext', {
        query: normalizedQuery,
        industry: industryResult.industry,
        industryScore: industryResult.score,
        style: styleResult.style,
        styleScore: styleResult.score,
        confidence,
        detectedKeywords,
      });
    }

    return {
      industry: industryResult.industry,
      style: styleResult.style,
      confidence,
      detectedKeywords,
    };
  }

  /**
   * クエリを正規化
   */
  private normalizeQuery(query: string): string {
    return query
      .toLowerCase()
      .replace(/[^\w\s\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 業界を推論
   */
  private inferIndustry(
    normalizedQuery: string,
    detectedKeywords: string[]
  ): { industry: InferredIndustry; score: number } {
    let bestIndustry: InferredIndustry = null;
    let bestScore = 0;

    for (const [industry, mapping] of Object.entries(INDUSTRY_KEYWORDS)) {
      let score = 0;
      for (const keyword of mapping.keywords) {
        if (normalizedQuery.includes(keyword.toLowerCase())) {
          score += mapping.weight;
          if (!detectedKeywords.includes(keyword.toLowerCase())) {
            detectedKeywords.push(keyword.toLowerCase());
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndustry = industry as InferredIndustry;
      }
    }

    // スコアが閾値未満の場合はnull
    if (bestScore < 0.5) {
      return { industry: null, score: 0 };
    }

    return { industry: bestIndustry, score: bestScore };
  }

  /**
   * スタイルを推論
   */
  private inferStyle(
    normalizedQuery: string,
    detectedKeywords: string[]
  ): { style: InferredStyle; score: number } {
    let bestStyle: InferredStyle = null;
    let bestScore = 0;

    for (const [style, mapping] of Object.entries(STYLE_KEYWORDS)) {
      let score = 0;
      for (const keyword of mapping.keywords) {
        if (normalizedQuery.includes(keyword.toLowerCase())) {
          score += mapping.weight;
          if (!detectedKeywords.includes(keyword.toLowerCase())) {
            detectedKeywords.push(keyword.toLowerCase());
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestStyle = style as InferredStyle;
      }
    }

    // スコアが閾値未満の場合はnull
    if (bestScore < 0.5) {
      return { style: null, score: 0 };
    }

    return { style: bestStyle, score: bestScore };
  }

  /**
   * 信頼度を計算
   *
   * 信頼度スコアのガイドライン:
   * - 業界のみ推論: 0.5-0.7
   * - スタイルのみ推論: 0.5-0.7
   * - 両方推論: 0.7-0.95
   * - 何も推論できない: 0.0
   */
  private calculateConfidence(
    industryResult: { industry: InferredIndustry; score: number },
    styleResult: { style: InferredStyle; score: number }
  ): number {
    // 何も推論できなかった場合
    if (industryResult.industry === null && styleResult.style === null) {
      return 0;
    }

    let confidence = 0;

    // 業界が推論できた場合: ベース0.5 + スコアに応じたボーナス（最大0.2）
    if (industryResult.industry !== null) {
      confidence += 0.5 + Math.min(0.2, industryResult.score * 0.1);
    }

    // スタイルが推論できた場合: ベース0.5 + スコアに応じたボーナス（最大0.2）
    if (styleResult.style !== null) {
      // 業界も推論できている場合は追加分のみ
      if (industryResult.industry !== null) {
        confidence += 0.15 + Math.min(0.1, styleResult.score * 0.05);
      } else {
        confidence += 0.5 + Math.min(0.2, styleResult.score * 0.1);
      }
    }

    return Math.min(1.0, confidence);
  }
}

// =====================================================
// コンテキストブースト計算
// =====================================================

/**
 * コンテキストブースト計算用インターフェース
 */
export interface ContextBoostInput {
  /** 推論されたコンテキスト */
  context: InferredContext;
  /** 結果アイテムのメタデータ */
  resultMetadata: {
    heading?: string | undefined;
    description?: string | undefined;
    url?: string | undefined;
    sectionType?: string | undefined;
  };
}

/**
 * コンテキストに基づいてブーストスコアを計算
 *
 * @param input - ブースト計算入力
 * @returns ブーストスコア（0-0.15）
 */
export function calculateContextBoost(input: ContextBoostInput): number {
  const { context, resultMetadata } = input;

  // コンテキストが推論されていない場合はブーストなし
  if (context.industry === null && context.style === null) {
    return 0;
  }

  // 信頼度が低い場合はブーストなし
  if (context.confidence < 0.5) {
    return 0;
  }

  let boost = 0;

  // 結果メタデータのテキストを結合
  const resultText = [
    resultMetadata.heading || '',
    resultMetadata.description || '',
    resultMetadata.url || '',
  ]
    .join(' ')
    .toLowerCase();

  // 業界マッチングによるブースト
  if (context.industry !== null) {
    const industryKeywords = INDUSTRY_KEYWORDS[context.industry].keywords;
    const industryMatches = industryKeywords.filter((kw) =>
      resultText.includes(kw.toLowerCase())
    );
    if (industryMatches.length > 0) {
      boost += Math.min(0.1, industryMatches.length * 0.02);
    }
  }

  // スタイルマッチングによるブースト
  if (context.style !== null) {
    const styleKeywords = STYLE_KEYWORDS[context.style].keywords;
    const styleMatches = styleKeywords.filter((kw) =>
      resultText.includes(kw.toLowerCase())
    );
    if (styleMatches.length > 0) {
      boost += Math.min(0.05, styleMatches.length * 0.01);
    }
  }

  // 最大ブースト値を制限
  return Math.min(0.15, boost * context.confidence);
}

// =====================================================
// シングルトンインスタンス
// =====================================================

let queryContextAnalyzerInstance: QueryContextAnalyzer | null = null;

/**
 * QueryContextAnalyzer インスタンスを取得
 */
export function getQueryContextAnalyzer(): QueryContextAnalyzer {
  if (!queryContextAnalyzerInstance) {
    queryContextAnalyzerInstance = new QueryContextAnalyzer();
  }
  return queryContextAnalyzerInstance;
}

/**
 * QueryContextAnalyzer インスタンスをリセット（テスト用）
 */
export function resetQueryContextAnalyzer(): void {
  queryContextAnalyzerInstance = null;
}
