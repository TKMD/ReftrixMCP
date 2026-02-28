// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * QualityEvaluatorService
 *
 * Webデザインの品質を3軸（独自性・技巧・文脈適合性）で評価し、
 * AIクリシェ検出・推奨事項生成を行うサービス
 *
 * page.analyze の defaultEvaluateQuality で使用される
 *
 * @module services/page/quality-evaluator.service
 */

import { logger, isDevelopment } from '../../utils/logger';
import { scoreToGrade, type Grade } from '../../tools/page/schemas';

// =====================================================
// 型定義
// =====================================================

/**
 * クリシェパターン定義
 */
interface ClichePattern {
  type: 'gradient' | 'text' | 'button' | 'shadow' | 'layout';
  description: string;
  severity: 'high' | 'medium' | 'low';
  pattern: RegExp;
}

/**
 * 検出されたクリシェ
 */
export interface DetectedCliche {
  type: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
}

/**
 * 推奨事項
 */
export interface Recommendation {
  id: string;
  category: 'originality' | 'craftsmanship' | 'contextuality';
  priority: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  /** 期待される改善効果（例: "+5 points"） */
  expectedImpact: string;
}

/**
 * 軸別スコア
 */
export interface AxisScores {
  originality: number;
  craftsmanship: number;
  contextuality: number;
}

/**
 * 軸別グレード
 */
export interface AxisGrades {
  originality: Grade;
  craftsmanship: Grade;
  contextuality: Grade;
}

/**
 * 軸別詳細
 */
export interface AxisDetails {
  originality: string[];
  craftsmanship: string[];
  contextuality: string[];
}

/**
 * 品質評価オプション
 */
export interface QualityEvaluatorOptions {
  /** strictモード: クリシェ検出を厳格化 */
  strict?: boolean;
  /** 重み付け */
  weights?: {
    originality?: number;
    craftsmanship?: number;
    contextuality?: number;
  };
  /** 業界 */
  targetIndustry?: string;
  /** ターゲットオーディエンス */
  targetAudience?: string;
  /** 推奨事項を含める */
  includeRecommendations?: boolean;
}

/**
 * 品質評価結果
 */
export interface QualityEvaluatorResult {
  success: boolean;
  overallScore: number;
  grade: Grade;
  axisScores: AxisScores;
  clicheCount: number;
  processingTimeMs: number;
  axisGrades?: AxisGrades;
  axisDetails?: AxisDetails;
  cliches?: DetectedCliche[];
  recommendations?: Recommendation[];
  error?: {
    code: string;
    message: string;
  };
}

// =====================================================
// AIクリシェパターン定義
// =====================================================

/** グラデーションクリシェ */
const GRADIENT_CLICHES: ClichePattern[] = [
  {
    type: 'gradient',
    description: 'AI典型のパープル-ピンクグラデーション（#667eea, #764ba2）',
    severity: 'high',
    pattern: /#667eea|#764ba2|667eea|764ba2/i,
  },
  {
    type: 'gradient',
    description: 'AI典型のピンク-オレンジグラデーション（#f857a6, #ff5858）',
    severity: 'high',
    pattern: /#f857a6|#ff5858|f857a6|ff5858/i,
  },
  {
    type: 'gradient',
    description: 'AI典型の青-紫グラデーション',
    severity: 'medium',
    pattern: /linear-gradient\s*\([^)]*(?:#6366f1|#8b5cf6|#a855f7)[^)]*\)/i,
  },
];

/** テキストクリシェ */
const TEXT_CLICHES: ClichePattern[] = [
  {
    type: 'text',
    description: 'AI典型フレーズ: "Transform Your Business"',
    severity: 'high',
    pattern: /transform\s+your\s+business/i,
  },
  {
    type: 'text',
    description: 'AI典型フレーズ: "Unlock the power"',
    severity: 'high',
    pattern: /unlock\s+the\s+power/i,
  },
  {
    type: 'text',
    description: 'AI典型フレーズ: "cutting-edge solutions"',
    severity: 'medium',
    pattern: /cutting-edge\s+solutions?/i,
  },
  {
    type: 'text',
    description: 'AI典型フレーズ: "seamless integration"',
    severity: 'medium',
    pattern: /seamless(?:ly)?\s+integrat/i,
  },
  {
    type: 'text',
    description: 'AI典型フレーズ: "Get Started Today"',
    severity: 'medium',
    pattern: /get\s+started\s+today/i,
  },
  {
    type: 'text',
    description: 'AI典型フレーズ: "Scale effortlessly"',
    severity: 'low',
    pattern: /scale\s+effortlessly/i,
  },
];

/** スタイルクリシェ */
const STYLE_CLICHES: ClichePattern[] = [
  {
    type: 'button',
    description: 'AI典型のピル型ボタン（border-radius: 9999px）',
    severity: 'medium',
    pattern: /border-radius:\s*9999px/i,
  },
  {
    type: 'shadow',
    description: 'AI典型のシャドウパターン',
    severity: 'low',
    pattern: /box-shadow:\s*0\s+4px\s+6px\s+rgba\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.1\s*\)/i,
  },
];

/** 全クリシェパターン */
const ALL_CLICHE_PATTERNS: ClichePattern[] = [
  ...GRADIENT_CLICHES,
  ...TEXT_CLICHES,
  ...STYLE_CLICHES,
];

// =====================================================
// デフォルト値
// =====================================================

const DEFAULT_WEIGHTS = {
  originality: 0.35,
  craftsmanship: 0.4,
  contextuality: 0.25,
};

const DEFAULT_BASE_SCORES = {
  originality: 80, // v0.1.0: AIクリシェなし=80点スタート（積極的評価で最大100点）
  craftsmanship: 65, // v0.1.0: 65点スタート（問題なし=一定の品質、積極的評価で最大100点）
  contextuality: 70,
};

// =====================================================
// スコア調整値
// =====================================================

const SCORE_ADJUSTMENTS = {
  // クリシェペナルティ（通常モード）
  CLICHE_HIGH_PENALTY: 15,
  CLICHE_MEDIUM_PENALTY: 8,
  CLICHE_LOW_PENALTY: 3,
  // クリシェペナルティ（strictモード）
  CLICHE_HIGH_PENALTY_STRICT: 20,
  CLICHE_MEDIUM_PENALTY_STRICT: 12,
  CLICHE_LOW_PENALTY_STRICT: 5,
  // ===================================
  // 積極的評価ボーナス（originality）v0.1.0
  // ベース80点 + 最大20点ボーナス = 100点
  // ===================================
  // カスタムカラースキーム（標準的なBootstrapカラー以外）
  CUSTOM_COLOR_SCHEME_BONUS: 5,
  // カスタムフォント使用（Google Fonts等）
  CUSTOM_FONTS_BONUS: 3,
  // ユニークなレイアウト構造（CSS Grid/Subgrid/Container Queries）
  UNIQUE_LAYOUT_BONUS: 5,
  // カスタムアニメーション/トランジション（@keyframes、複雑なtransition）
  CUSTOM_ANIMATIONS_BONUS: 4,
  // オリジナルのイラスト/グラフィック（SVGインライン、Canvas）
  ORIGINAL_GRAPHICS_BONUS: 3,
  // ===================================
  // 既存ボーナス（originality）- 小規模ボーナス
  // ===================================
  CUSTOM_COLOR_PALETTE_BONUS: 5,
  CUSTOM_ANIMATION_BONUS: 3,
  CSS_VARIABLES_BONUS: 2,
  // ボーナス（craftsmanship）- 既存
  SEMANTIC_HEADER_BONUS: 5,
  SEMANTIC_MAIN_BONUS: 5,
  SEMANTIC_NAV_BONUS: 5,
  SEMANTIC_FOOTER_BONUS: 3,
  ARIA_LABEL_BONUS: 5,
  ARIA_DESCRIBEDBY_BONUS: 3,
  ALL_IMAGES_ALT_BONUS: 5,
  RESPONSIVE_BONUS: 5,
  REDUCED_MOTION_BONUS: 5,
  VIEWPORT_META_BONUS: 3,
  LANG_ATTR_BONUS: 3,
  CLAMP_FUNCTION_BONUS: 3,
  CSS_GRID_BONUS: 3,
  FLEXBOX_BONUS: 2,
  // ===================================
  // v0.1.0: Craftsmanship ポジティブ評価ボーナス
  // ===================================
  // モダンCSS機能ボーナス
  CONTAINER_QUERIES_BONUS: 4, // Container Queries（@container, container-type）
  GAP_PROPERTY_BONUS: 2, // gap プロパティ（Flex/Grid用）
  ASPECT_RATIO_BONUS: 3, // aspect-ratio プロパティ
  SCROLL_SNAP_BONUS: 3, // scroll-snap-type, scroll-snap-align
  OBJECT_FIT_BONUS: 2, // object-fit プロパティ
  SCROLL_BEHAVIOR_BONUS: 2, // scroll-behavior: smooth
  PLACE_ITEMS_BONUS: 2, // place-items, place-content（モダンセンタリング）
  // アクセシビリティ強化ボーナス
  TABINDEX_BONUS: 2, // tabindex 属性
  FOCUS_VISIBLE_BONUS: 3, // :focus-visible 疑似クラス
  SKIP_LINK_BONUS: 4, // スキップリンク（Skip to main content等）
  PREFERS_COLOR_SCHEME_BONUS: 3, // prefers-color-scheme（ダークモード対応）
  ARIA_LIVE_BONUS: 3, // aria-live 属性（ライブリージョン）
  // パフォーマンス最適化ボーナス
  LAZY_LOADING_BONUS: 3, // loading="lazy" 属性
  FETCHPRIORITY_BONUS: 3, // fetchpriority 属性
  RESOURCE_HINTS_BONUS: 3, // preload, prefetch, dns-prefetch
  ASYNC_DEFER_BONUS: 2, // async/defer スクリプト
  MODERN_IMAGE_FORMAT_BONUS: 2, // WebP/AVIF（picture要素）
  FONT_DISPLAY_BONUS: 3, // font-display: swap/optional/fallback等
  IMAGE_DIMENSIONS_BONUS: 3, // 画像のwidth/height属性（CLSパフォーマンス）
  // ペナルティ（craftsmanship）
  MISSING_ALT_PENALTY: 5,
  ONCLICK_PENALTY: 3,
  DIV_OVERUSE_PENALTY: 5,
  // ボーナス（contextuality）
  INDUSTRY_MATCH_BONUS: 10,
  INDUSTRY_COLOR_BONUS: 5,
  AUDIENCE_MATCH_BONUS: 5,
  CLEAR_STRUCTURE_BONUS: 5,
  CLEAR_CTA_BONUS: 3,
};

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * スコアを0-100の範囲に制限
 */
function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

/**
 * クリシェを検出する
 */
function detectCliches(html: string, strict: boolean): DetectedCliche[] {
  const detected: DetectedCliche[] = [];

  for (const cliche of ALL_CLICHE_PATTERNS) {
    // strictモードでない場合、lowレベルはスキップ
    if (!strict && cliche.severity === 'low') {
      continue;
    }

    if (cliche.pattern.test(html)) {
      detected.push({
        type: cliche.type,
        description: cliche.description,
        severity: cliche.severity,
      });
    }
  }

  return detected;
}

// =====================================================
// Bootstrapカラー定義（除外対象）
// =====================================================

/** Bootstrap標準カラー（これらは独自カラーとみなさない） */
const BOOTSTRAP_COLORS = [
  // Primary/Secondary
  '#0d6efd', '#6c757d', '#198754', '#dc3545', '#ffc107', '#0dcaf0',
  // Light/Dark
  '#f8f9fa', '#212529',
  // 標準的なグレー
  '#ffffff', '#000000', '#333333', '#666666', '#999999', '#cccccc',
  // Bootstrap v4互換
  '#007bff', '#6c757d', '#28a745', '#dc3545', '#ffc107', '#17a2b8',
];

/**
 * カスタムカラースキームを検出
 * Bootstrap標準カラー以外のHEXカラーが3色以上使用されているか
 */
function hasCustomColorScheme(html: string): boolean {
  const hexColors = html.match(/#[0-9a-fA-F]{6}/gi) || [];
  const uniqueColors = [...new Set(hexColors.map((c) => c.toLowerCase()))];
  const customColors = uniqueColors.filter(
    (color) => !BOOTSTRAP_COLORS.includes(color)
  );
  return customColors.length >= 3;
}

/**
 * カスタムフォントを検出
 * Google Fonts、Adobe Fonts、@font-faceの使用を検出
 */
function hasCustomFonts(html: string): boolean {
  // Google Fonts
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(html)) {
    return true;
  }
  // Adobe Fonts (Typekit)
  if (/use\.typekit\.net|fonts\.adobe\.com/i.test(html)) {
    return true;
  }
  // @font-face定義
  if (/@font-face\s*\{/i.test(html)) {
    return true;
  }
  // カスタムフォントファミリー（システムフォント以外）
  const customFontFamilies = /font-family:\s*["']?(?!(?:Arial|Helvetica|Times|Georgia|Verdana|system-ui|sans-serif|serif|monospace)['";\s,])/i;
  return customFontFamilies.test(html);
}

/**
 * ユニークなレイアウト構造を検出
 * CSS Grid (Subgrid含む)、Container Queries、複雑なGrid設定
 */
function hasUniqueLayout(html: string): boolean {
  // CSS Subgrid（高度なグリッド機能）
  if (/subgrid/i.test(html)) {
    return true;
  }
  // Container Queries（モダンなレスポンシブ手法）
  if (/@container\s/i.test(html) || /container-type:/i.test(html)) {
    return true;
  }
  // 複雑なGrid Template（3行以上のgrid-template-areas）
  const gridAreas = html.match(/grid-template-areas:\s*["'][^"']+["']/gi) || [];
  for (const area of gridAreas) {
    const rows = (area.match(/["']/g) || []).length / 2;
    if (rows >= 3) {
      return true;
    }
  }
  // 複雑なgrid-template-columns（auto-fit/fill + minmax）
  if (/grid-template-columns:[^;]*(?:auto-fit|auto-fill)[^;]*minmax/i.test(html)) {
    return true;
  }
  // aspect-ratio（モダンなレイアウト手法）
  if (/aspect-ratio:\s*\d/i.test(html)) {
    return true;
  }
  return false;
}

/**
 * カスタムアニメーション/トランジションを検出
 * @keyframes、複雑なtransition、cubic-bezierイージング
 */
function hasCustomAnimations(html: string): boolean {
  // @keyframes定義（2つ以上）
  const keyframesCount = (html.match(/@keyframes\s+[a-z]/gi) || []).length;
  if (keyframesCount >= 2) {
    return true;
  }
  // カスタムcubic-bezierイージング
  if (/cubic-bezier\s*\(\s*[0-9.]+\s*,\s*[0-9.-]+\s*,\s*[0-9.]+\s*,\s*[0-9.-]+\s*\)/i.test(html)) {
    return true;
  }
  // 複雑なtransition（3つ以上のプロパティ）
  const transitionMatch = html.match(/transition:\s*([^;]+)/gi) || [];
  for (const t of transitionMatch) {
    const commas = (t.match(/,/g) || []).length;
    if (commas >= 2) {
      return true;
    }
  }
  // animation-timeline（スクロール駆動アニメーション）
  if (/animation-timeline:/i.test(html)) {
    return true;
  }
  return false;
}

/**
 * オリジナルのイラスト/グラフィックを検出
 * インラインSVG（パスを含む）、Canvas要素
 */
function hasOriginalGraphics(html: string): boolean {
  // インラインSVG（pathを含む）
  if (/<svg[^>]*>[\s\S]*<path[^>]*d=/i.test(html)) {
    return true;
  }
  // Canvas要素
  if (/<canvas[^>]*>/i.test(html)) {
    return true;
  }
  // clip-path（複雑な形状）
  if (/clip-path:\s*(?:polygon|ellipse|circle|path)\s*\(/i.test(html)) {
    return true;
  }
  // mask-image（マスク効果）
  if (/mask-image:/i.test(html)) {
    return true;
  }
  // filter（SVGフィルター）
  if (/filter:\s*url\s*\(/i.test(html)) {
    return true;
  }
  return false;
}

/**
 * Originality（独自性）を評価
 *
 * v0.1.0: 積極的評価を追加
 * - ベーススコア: 80点（AIクリシェなし）
 * - 積極的評価で最大+20点のボーナス
 * - 最終スコア: 0-100点
 */
function evaluateOriginality(
  html: string,
  cliches: DetectedCliche[],
  strict: boolean
): { score: number; details: string[] } {
  let score = DEFAULT_BASE_SCORES.originality; // 80点スタート
  const details: string[] = [];

  // ===================================
  // 1. クリシェペナルティ（減点）
  // ===================================
  for (const cliche of cliches) {
    switch (cliche.severity) {
      case 'high':
        score -= strict
          ? SCORE_ADJUSTMENTS.CLICHE_HIGH_PENALTY_STRICT
          : SCORE_ADJUSTMENTS.CLICHE_HIGH_PENALTY;
        details.push(`高クリシェ検出: ${cliche.description}`);
        break;
      case 'medium':
        score -= strict
          ? SCORE_ADJUSTMENTS.CLICHE_MEDIUM_PENALTY_STRICT
          : SCORE_ADJUSTMENTS.CLICHE_MEDIUM_PENALTY;
        details.push(`中クリシェ検出: ${cliche.description}`);
        break;
      case 'low':
        score -= strict
          ? SCORE_ADJUSTMENTS.CLICHE_LOW_PENALTY_STRICT
          : SCORE_ADJUSTMENTS.CLICHE_LOW_PENALTY;
        details.push(`低クリシェ検出: ${cliche.description}`);
        break;
    }
  }

  // ===================================
  // 2. 積極的評価（加点）- v0.1.0新規
  // 最大20点のボーナス
  // ===================================

  // カスタムカラースキーム（+5点）
  if (hasCustomColorScheme(html)) {
    score += SCORE_ADJUSTMENTS.CUSTOM_COLOR_SCHEME_BONUS;
    details.push(`カスタムカラースキーム使用（+${SCORE_ADJUSTMENTS.CUSTOM_COLOR_SCHEME_BONUS}）`);
  }

  // カスタムフォント使用（+3点）
  if (hasCustomFonts(html)) {
    score += SCORE_ADJUSTMENTS.CUSTOM_FONTS_BONUS;
    details.push(`カスタムフォント使用（+${SCORE_ADJUSTMENTS.CUSTOM_FONTS_BONUS}）`);
  }

  // ユニークなレイアウト構造（+5点）
  if (hasUniqueLayout(html)) {
    score += SCORE_ADJUSTMENTS.UNIQUE_LAYOUT_BONUS;
    details.push(`ユニークなレイアウト構造（+${SCORE_ADJUSTMENTS.UNIQUE_LAYOUT_BONUS}）`);
  }

  // カスタムアニメーション（+4点）
  if (hasCustomAnimations(html)) {
    score += SCORE_ADJUSTMENTS.CUSTOM_ANIMATIONS_BONUS;
    details.push(`カスタムアニメーション/トランジション（+${SCORE_ADJUSTMENTS.CUSTOM_ANIMATIONS_BONUS}）`);
  }

  // オリジナルグラフィック（+3点）
  if (hasOriginalGraphics(html)) {
    score += SCORE_ADJUSTMENTS.ORIGINAL_GRAPHICS_BONUS;
    details.push(`オリジナルグラフィック/SVG（+${SCORE_ADJUSTMENTS.ORIGINAL_GRAPHICS_BONUS}）`);
  }

  // ===================================
  // 3. 既存ボーナス（小規模）
  // ===================================

  // カスタムカラーパレット検出（CSS変数での色定義）
  const customColorVars = html.match(/--[a-z-]*color[a-z-]*:\s*#[0-9a-fA-F]{6}/gi);
  if (customColorVars && customColorVars.length >= 3) {
    score += SCORE_ADJUSTMENTS.CUSTOM_COLOR_PALETTE_BONUS;
    details.push(`CSS変数でカラーパレット定義（+${SCORE_ADJUSTMENTS.CUSTOM_COLOR_PALETTE_BONUS}）`);
  }

  // カスタムアニメーション検出（@keyframes単体）
  // 注: hasCustomAnimationsで2つ以上はカバー済み、ここでは1つの場合のボーナス
  const keyframesCount = (html.match(/@keyframes\s+[a-z]/gi) || []).length;
  if (keyframesCount === 1) {
    score += SCORE_ADJUSTMENTS.CUSTOM_ANIMATION_BONUS;
    details.push(`@keyframesアニメーション使用（+${SCORE_ADJUSTMENTS.CUSTOM_ANIMATION_BONUS}）`);
  }

  // CSS変数使用
  const cssVars = html.match(/var\(--[a-z-]+\)/gi);
  if (cssVars && cssVars.length >= 5) {
    score += SCORE_ADJUSTMENTS.CSS_VARIABLES_BONUS;
    details.push(`CSS変数を積極活用（+${SCORE_ADJUSTMENTS.CSS_VARIABLES_BONUS}）`);
  }

  // 最大100点に制限
  return { score: clampScore(score), details };
}

/**
 * Craftsmanship（技巧）を評価
 */
function evaluateCraftsmanship(html: string): { score: number; details: string[] } {
  let score = DEFAULT_BASE_SCORES.craftsmanship;
  const details: string[] = [];

  // === セマンティックHTML評価 ===
  if (/<header[^>]*(?:role="banner")?[^>]*>/i.test(html)) {
    score += SCORE_ADJUSTMENTS.SEMANTIC_HEADER_BONUS;
    details.push('セマンティックなheader使用');
  }

  if (/<main[^>]*(?:role="main")?[^>]*>/i.test(html)) {
    score += SCORE_ADJUSTMENTS.SEMANTIC_MAIN_BONUS;
    details.push('セマンティックなmain使用');
  }

  if (/<nav[^>]*(?:role="navigation")?[^>]*>/i.test(html)) {
    score += SCORE_ADJUSTMENTS.SEMANTIC_NAV_BONUS;
    details.push('セマンティックなnav使用');
  }

  if (/<footer[^>]*(?:role="contentinfo")?[^>]*>/i.test(html)) {
    score += SCORE_ADJUSTMENTS.SEMANTIC_FOOTER_BONUS;
    details.push('セマンティックなfooter使用');
  }

  // section, article, aside の検出
  if (/<section[^>]*>/i.test(html)) {
    score += 2;
    details.push('section要素使用');
  }

  if (/<article[^>]*>/i.test(html)) {
    score += 2;
    details.push('article要素使用');
  }

  if (/<aside[^>]*>/i.test(html)) {
    score += 2;
    details.push('aside要素使用');
  }

  // === ARIA属性評価 ===
  if (/aria-label(ledby)?=/i.test(html)) {
    score += SCORE_ADJUSTMENTS.ARIA_LABEL_BONUS;
    details.push('ARIA属性(aria-label/labelledby)使用');
  }

  if (/aria-describedby=/i.test(html)) {
    score += SCORE_ADJUSTMENTS.ARIA_DESCRIBEDBY_BONUS;
    details.push('ARIA属性(aria-describedby)使用');
  }

  // role属性
  if (/role="(?:banner|main|navigation|contentinfo)"/i.test(html)) {
    score += 2;
    details.push('WAI-ARIA role属性使用');
  }

  // === 画像alt属性評価 ===
  const imgTags = html.match(/<img[^>]*>/gi) || [];
  const imgsWithAlt = imgTags.filter((img) => /alt=/i.test(img));

  if (imgTags.length > 0 && imgsWithAlt.length === imgTags.length) {
    score += SCORE_ADJUSTMENTS.ALL_IMAGES_ALT_BONUS;
    details.push('全ての画像にalt属性');
  } else if (imgTags.length > 0 && imgsWithAlt.length < imgTags.length) {
    score -= SCORE_ADJUSTMENTS.MISSING_ALT_PENALTY;
    details.push('一部の画像にalt属性がない');
  }

  // === レスポンシブデザイン評価 ===
  if (/@media\s*\([^)]*(?:max|min)-width/i.test(html)) {
    score += SCORE_ADJUSTMENTS.RESPONSIVE_BONUS;
    details.push('レスポンシブデザイン（@media）対応');
  }

  if (/prefers-reduced-motion/i.test(html)) {
    score += SCORE_ADJUSTMENTS.REDUCED_MOTION_BONUS;
    details.push('モーション軽減（prefers-reduced-motion）対応');
  }

  if (/<meta[^>]*name="viewport"/i.test(html)) {
    score += SCORE_ADJUSTMENTS.VIEWPORT_META_BONUS;
    details.push('viewport meta設定');
  }

  if (/<html[^>]*lang=/i.test(html)) {
    score += SCORE_ADJUSTMENTS.LANG_ATTR_BONUS;
    details.push('lang属性設定');
  }

  // === モダンCSS機能評価（既存） ===
  if (/clamp\s*\(/i.test(html)) {
    score += SCORE_ADJUSTMENTS.CLAMP_FUNCTION_BONUS;
    details.push('clamp()関数使用');
  }

  if (/grid-template-columns|display:\s*grid/i.test(html)) {
    score += SCORE_ADJUSTMENTS.CSS_GRID_BONUS;
    details.push('CSS Grid使用');
  }

  if (/display:\s*flex/i.test(html)) {
    score += SCORE_ADJUSTMENTS.FLEXBOX_BONUS;
    details.push('Flexbox使用');
  }

  // ===================================
  // v0.1.0: モダンCSS機能ボーナス（新規）
  // ===================================

  // Container Queries（@container, container-type）
  if (/@container\s/i.test(html) || /container-type:/i.test(html)) {
    score += SCORE_ADJUSTMENTS.CONTAINER_QUERIES_BONUS;
    details.push(`Container Queries使用（+${SCORE_ADJUSTMENTS.CONTAINER_QUERIES_BONUS}）`);
  }

  // gap プロパティ（Flex/Grid用モダンスペーシング）
  if (/\bgap:\s*\d/i.test(html)) {
    score += SCORE_ADJUSTMENTS.GAP_PROPERTY_BONUS;
    details.push(`gap プロパティ使用（モダンスペーシング）（+${SCORE_ADJUSTMENTS.GAP_PROPERTY_BONUS}）`);
  }

  // aspect-ratio プロパティ
  if (/aspect-ratio:\s*[\d/]/i.test(html)) {
    score += SCORE_ADJUSTMENTS.ASPECT_RATIO_BONUS;
    details.push(`aspect-ratio使用（+${SCORE_ADJUSTMENTS.ASPECT_RATIO_BONUS}）`);
  }

  // scroll-snap（scroll-snap-type, scroll-snap-align）
  if (/scroll-snap-(?:type|align):/i.test(html)) {
    score += SCORE_ADJUSTMENTS.SCROLL_SNAP_BONUS;
    details.push(`scroll-snap使用（スクロールスナップ）（+${SCORE_ADJUSTMENTS.SCROLL_SNAP_BONUS}）`);
  }

  // object-fit プロパティ
  if (/object-fit:\s*(?:cover|contain|fill|none|scale-down)/i.test(html)) {
    score += SCORE_ADJUSTMENTS.OBJECT_FIT_BONUS;
    details.push(`object-fit使用（+${SCORE_ADJUSTMENTS.OBJECT_FIT_BONUS}）`);
  }

  // scroll-behavior: smooth
  if (/scroll-behavior:\s*smooth/i.test(html)) {
    score += SCORE_ADJUSTMENTS.SCROLL_BEHAVIOR_BONUS;
    details.push(`scroll-behavior: smooth使用（スムーススクロール）（+${SCORE_ADJUSTMENTS.SCROLL_BEHAVIOR_BONUS}）`);
  }

  // place-items, place-content（モダンセンタリング）
  if (/place-(?:items|content):/i.test(html)) {
    score += SCORE_ADJUSTMENTS.PLACE_ITEMS_BONUS;
    details.push(`place-items/place-content使用（モダンセンタリング）（+${SCORE_ADJUSTMENTS.PLACE_ITEMS_BONUS}）`);
  }

  // ===================================
  // v0.1.0: アクセシビリティ強化ボーナス（新規）
  // ===================================

  // tabindex 属性（キーボードナビゲーション）
  if (/tabindex=/i.test(html)) {
    score += SCORE_ADJUSTMENTS.TABINDEX_BONUS;
    details.push(`tabindex属性使用（キーボードナビゲーション）（+${SCORE_ADJUSTMENTS.TABINDEX_BONUS}）`);
  }

  // :focus-visible 疑似クラス（フォーカス表示）
  if (/:focus-visible/i.test(html)) {
    score += SCORE_ADJUSTMENTS.FOCUS_VISIBLE_BONUS;
    details.push(`:focus-visible使用（フォーカス表示）（+${SCORE_ADJUSTMENTS.FOCUS_VISIBLE_BONUS}）`);
  }

  // スキップリンク（Skip to main content等）
  if (/skip[^"']*(?:to[^"']*)?(?:main|content|navigation)/i.test(html) ||
      /href="#(?:main|content|navigation)"/i.test(html)) {
    score += SCORE_ADJUSTMENTS.SKIP_LINK_BONUS;
    details.push(`スキップリンク使用（+${SCORE_ADJUSTMENTS.SKIP_LINK_BONUS}）`);
  }

  // prefers-color-scheme（ダークモード対応）
  if (/prefers-color-scheme/i.test(html) || /color-scheme:\s*(?:light|dark)/i.test(html)) {
    score += SCORE_ADJUSTMENTS.PREFERS_COLOR_SCHEME_BONUS;
    details.push(`prefers-color-scheme対応（ダークモード）（+${SCORE_ADJUSTMENTS.PREFERS_COLOR_SCHEME_BONUS}）`);
  }

  // aria-live 属性（ライブリージョン）
  if (/aria-live=/i.test(html)) {
    score += SCORE_ADJUSTMENTS.ARIA_LIVE_BONUS;
    details.push(`aria-live使用（ライブリージョン）（+${SCORE_ADJUSTMENTS.ARIA_LIVE_BONUS}）`);
  }

  // ===================================
  // v0.1.0: パフォーマンス最適化ボーナス（新規）
  // ===================================

  // loading="lazy" 属性（遅延読み込み）
  if (/loading=["']?lazy["']?/i.test(html)) {
    score += SCORE_ADJUSTMENTS.LAZY_LOADING_BONUS;
    details.push(`loading="lazy"使用（遅延読み込み）（+${SCORE_ADJUSTMENTS.LAZY_LOADING_BONUS}）`);
  }

  // fetchpriority 属性（リソース優先度）
  if (/fetchpriority=/i.test(html)) {
    score += SCORE_ADJUSTMENTS.FETCHPRIORITY_BONUS;
    details.push(`fetchpriority使用（リソース優先度）（+${SCORE_ADJUSTMENTS.FETCHPRIORITY_BONUS}）`);
  }

  // preload, prefetch, dns-prefetch（リソースヒント）
  if (/rel=["']?(?:preload|prefetch|dns-prefetch)["']?/i.test(html)) {
    score += SCORE_ADJUSTMENTS.RESOURCE_HINTS_BONUS;
    details.push(`preload/prefetch使用（リソースヒント）（+${SCORE_ADJUSTMENTS.RESOURCE_HINTS_BONUS}）`);
  }

  // async/defer スクリプト（非同期スクリプト）
  if (/<script[^>]*(?:async|defer)/i.test(html)) {
    score += SCORE_ADJUSTMENTS.ASYNC_DEFER_BONUS;
    details.push(`async/deferスクリプト使用（非同期スクリプト）（+${SCORE_ADJUSTMENTS.ASYNC_DEFER_BONUS}）`);
  }

  // WebP/AVIF（モダン画像フォーマット）- picture要素内のsource
  if (/<source[^>]*type=["']?image\/(?:webp|avif)["']?/i.test(html)) {
    score += SCORE_ADJUSTMENTS.MODERN_IMAGE_FORMAT_BONUS;
    details.push(`WebP/AVIF使用（モダン画像フォーマット）（+${SCORE_ADJUSTMENTS.MODERN_IMAGE_FORMAT_BONUS}）`);
  }

  // font-display（フォント表示戦略）
  if (/font-display:\s*(?:swap|optional|fallback|block|auto)/i.test(html)) {
    score += SCORE_ADJUSTMENTS.FONT_DISPLAY_BONUS;
    details.push(`font-display使用（フォント表示戦略）（+${SCORE_ADJUSTMENTS.FONT_DISPLAY_BONUS}）`);
  }

  // 画像のwidth/height属性（CLSパフォーマンス改善）
  if (/<img[^>]+width=["']?\d+["']?[^>]+height=["']?\d+["']?/i.test(html) ||
      /<img[^>]+height=["']?\d+["']?[^>]+width=["']?\d+["']?/i.test(html)) {
    score += SCORE_ADJUSTMENTS.IMAGE_DIMENSIONS_BONUS;
    details.push(`画像サイズ属性使用（CLS対策）（+${SCORE_ADJUSTMENTS.IMAGE_DIMENSIONS_BONUS}）`);
  }

  // === ネガティブ評価 ===
  // onclick属性（非推奨）
  const onclickCount = (html.match(/onclick=/gi) || []).length;
  if (onclickCount > 0) {
    score -= onclickCount * SCORE_ADJUSTMENTS.ONCLICK_PENALTY;
    details.push(`インラインonclick使用（非推奨）: ${onclickCount}箇所`);
  }

  // divの過剰使用
  const divCount = (html.match(/<div[^>]*>/gi) || []).length;
  const semanticCount = (
    html.match(/<(header|main|nav|footer|section|article|aside)[^>]*>/gi) || []
  ).length;

  if (divCount > 10 && semanticCount < 3) {
    score -= SCORE_ADJUSTMENTS.DIV_OVERUSE_PENALTY;
    details.push('divの過剰使用（セマンティック要素が少ない）');
  }

  return { score: clampScore(score), details };
}

/**
 * Contextuality（文脈適合性）を評価
 */
function evaluateContextuality(
  html: string,
  targetIndustry?: string,
  targetAudience?: string
): { score: number; details: string[] } {
  let score = DEFAULT_BASE_SCORES.contextuality;
  const details: string[] = [];

  // === 業界固有評価 ===
  if (targetIndustry) {
    const industryLower = targetIndustry.toLowerCase();

    // ヘルスケア
    if (industryLower === 'healthcare' || industryLower === 'health') {
      if (/certification|certified|licensed|trust|secure/i.test(html)) {
        score += SCORE_ADJUSTMENTS.INDUSTRY_MATCH_BONUS;
        details.push('ヘルスケア業界の信頼性要素');
      }
      if (/#[0-9a-f]{6}/gi.test(html)) {
        score += SCORE_ADJUSTMENTS.INDUSTRY_COLOR_BONUS;
        details.push('業界適切なカラー使用');
      }
    }

    // 金融
    if (industryLower === 'finance' || industryLower === 'financial') {
      if (/security|secure|encrypt|protect|compliance/i.test(html)) {
        score += SCORE_ADJUSTMENTS.INDUSTRY_MATCH_BONUS;
        details.push('金融業界のセキュリティ要素');
      }
    }

    // テクノロジー
    if (industryLower === 'technology' || industryLower === 'tech') {
      if (/api|integration|developer|documentation/i.test(html)) {
        score += SCORE_ADJUSTMENTS.AUDIENCE_MATCH_BONUS;
        details.push('テクノロジー業界の技術要素');
      }
      if (/linear-gradient|grid|flex/i.test(html)) {
        score += SCORE_ADJUSTMENTS.AUDIENCE_MATCH_BONUS;
        details.push('モダンなデザイン（テック業界向け）');
      }
    }
  }

  // === オーディエンス評価 ===
  if (targetAudience) {
    const audienceLower = targetAudience.toLowerCase();

    // エンタープライズ/ビジネス
    if (audienceLower === 'enterprise' || audienceLower === 'business') {
      if (/professional|enterprise|business|solutions/i.test(html)) {
        score += SCORE_ADJUSTMENTS.AUDIENCE_MATCH_BONUS;
        details.push('エンタープライズ向けコンテンツ');
      }
      if (/<button[^>]*>/i.test(html) && /contact|demo|trial/i.test(html)) {
        score += SCORE_ADJUSTMENTS.AUDIENCE_MATCH_BONUS;
        details.push('ビジネス向けCTA');
      }
    }

    // 一般消費者
    if (audienceLower === 'consumer' || audienceLower === 'general') {
      if (/simple|easy|free|try/i.test(html)) {
        score += SCORE_ADJUSTMENTS.AUDIENCE_MATCH_BONUS;
        details.push('消費者向けメッセージ');
      }
    }

    // 開発者/専門家
    if (
      audienceLower === 'developers' ||
      audienceLower === 'developer' ||
      audienceLower === 'professionals' ||
      audienceLower === 'expert'
    ) {
      if (/advanced|professional|expert|technical|api|documentation/i.test(html)) {
        score += SCORE_ADJUSTMENTS.AUDIENCE_MATCH_BONUS;
        details.push('専門家/開発者向けコンテンツ');
      }
    }
  }

  // === 一般的な品質評価 ===
  // 明確なページ構造
  if (/<header/i.test(html) && /<main/i.test(html) && /<footer/i.test(html)) {
    score += SCORE_ADJUSTMENTS.CLEAR_STRUCTURE_BONUS;
    details.push('明確なページ構造');
  }

  // CTA存在
  if (/<button/i.test(html) || /<a[^>]*class="[^"]*(?:cta|btn|button)/i.test(html)) {
    score += SCORE_ADJUSTMENTS.CLEAR_CTA_BONUS;
    details.push('明確なCTA');
  }

  return { score: clampScore(score), details };
}

// =====================================================
// 推奨事項生成（v0.1.0: 最低3件保証、expectedImpact追加）
// =====================================================

/**
 * 推奨事項カテゴリ別のベース推奨事項
 * 条件に関わらず最低3件を保証するためのフォールバック
 */
const BASE_RECOMMENDATIONS: {
  originality: Array<{
    title: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
    impact: number;
    condition?: (score: number, details: string[]) => boolean;
  }>;
  craftsmanship: Array<{
    title: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
    impact: number;
    condition?: (score: number, details: string[]) => boolean;
  }>;
  contextuality: Array<{
    title: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
    impact: number;
    condition?: (score: number, details: string[]) => boolean;
  }>;
} = {
  originality: [
    {
      title: '独自のカラーパレットを定義する',
      description: 'ブランド固有のカラーをCSS変数として定義し、一貫性のある配色を実現してください。Bootstrap標準カラーを避け、独自性を高めましょう。',
      priority: 'high',
      impact: 8,
      condition: (score) => score < 85,
    },
    {
      title: 'カスタムアニメーションを追加する',
      description: '@keyframesでユニークなアニメーションを定義し、サイトの個性を演出してください。cubic-bezierイージングでより洗練された動きを実現できます。',
      priority: 'medium',
      impact: 5,
      condition: (_score, details) => !details.some((d) => d.includes('アニメーション')),
    },
    {
      title: 'オリジナルのビジュアル要素を検討する',
      description: 'インラインSVGやCanvasを活用してユニークなグラフィック要素を追加し、AIが生成した一般的なデザインとの差別化を図りましょう。',
      priority: 'low',
      impact: 3,
    },
  ],
  craftsmanship: [
    {
      title: 'アクセシビリティを強化する',
      description: 'ARIA属性（aria-label, aria-describedby等）を追加し、スクリーンリーダーユーザーのナビゲーション体験を向上させてください。',
      priority: 'high',
      impact: 8,
      condition: (score) => score < 85,
    },
    {
      title: 'セマンティックHTML構造を最適化する',
      description: 'section, article, aside, nav要素を適切に使用し、ドキュメント構造を明確にしてください。検索エンジン最適化にも効果的です。',
      priority: 'medium',
      impact: 5,
      condition: (_score, details) => !details.some((d) => d.includes('section') && d.includes('article')),
    },
    {
      title: 'レスポンシブデザインを拡充する',
      description: 'Container Queries、clamp()関数、prefers-reduced-motionなどのモダンCSS機能を活用し、より柔軟なレイアウトを実現してください。',
      priority: 'low',
      impact: 3,
    },
  ],
  contextuality: [
    {
      title: 'ターゲットオーディエンスを明確化する',
      description: '業界やユーザー層に適したトーン、用語、ビジュアルスタイルを採用し、コンテンツの訴求力を高めてください。',
      priority: 'medium',
      impact: 6,
      condition: (score) => score < 85,
    },
    {
      title: 'CTAの視認性を向上させる',
      description: 'Call-to-Actionボタンのコントラスト、サイズ、配置を最適化し、ユーザーの行動を促進してください。',
      priority: 'medium',
      impact: 4,
      condition: (_score, details) => !details.some((d) => d.includes('CTA')),
    },
    {
      title: 'コンテンツ階層を明確にする',
      description: '見出し構造（h1-h6）、段落間隔、セクション分けを改善し、ユーザーが情報を素早く把握できるようにしてください。',
      priority: 'low',
      impact: 3,
    },
  ],
};

/**
 * 推奨事項を生成
 *
 * v0.1.0: 最低3件の推奨事項を保証
 * - 3カテゴリ（originality, craftsmanship, contextuality）をカバー
 * - expectedImpactフィールドを追加
 * - 高品質HTMLでも改善提案を提供
 */
function generateRecommendations(
  originalityScore: number,
  craftsmanshipScore: number,
  contextualityScore: number,
  cliches: DetectedCliche[],
  details: AxisDetails
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  let recId = 1;

  // =====================================================
  // 1. 条件付き推奨事項（問題が検出された場合）
  // =====================================================

  // Originalityに関する推奨（クリシェ検出時）
  if (cliches.length > 0) {
    for (const cliche of cliches.slice(0, 2)) {
      const impact = cliche.severity === 'high' ? 10 : cliche.severity === 'medium' ? 6 : 3;
      recommendations.push({
        id: `rec-${recId++}`,
        category: 'originality',
        priority: cliche.severity,
        title: `AIクリシェを回避: ${cliche.type}`,
        description: `${cliche.description}。独自のスタイルに置き換えることでデザインの独自性が向上します。`,
        expectedImpact: `+${impact} points`,
      });
    }
  }

  // Craftsmanshipに関する推奨（問題検出時）
  if (details.craftsmanship.some((d) => d.includes('onclick'))) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: 'craftsmanship',
      priority: 'medium',
      title: 'インラインイベントハンドラを削除する',
      description: 'onclick属性の代わりにaddEventListenerを使用してください。コードの保守性とセキュリティが向上します。',
      expectedImpact: '+4 points',
    });
  }

  if (details.craftsmanship.some((d) => d.includes('alt') && d.includes('ない'))) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: 'craftsmanship',
      priority: 'high',
      title: '画像にalt属性を追加する',
      description: 'すべての画像に適切なalt属性を設定してください。アクセシビリティとSEOの両方に重要です。',
      expectedImpact: '+8 points',
    });
  }

  if (details.craftsmanship.some((d) => d.includes('div') && d.includes('過剰'))) {
    recommendations.push({
      id: `rec-${recId++}`,
      category: 'craftsmanship',
      priority: 'medium',
      title: 'セマンティックHTML要素を使用する',
      description: 'divの代わりにsection, article, nav, asideなどを活用してください。ドキュメント構造が明確になります。',
      expectedImpact: '+5 points',
    });
  }

  // =====================================================
  // 2. カテゴリ別の基本推奨事項を追加（最低3件保証）
  // =====================================================

  const scores = {
    originality: originalityScore,
    craftsmanship: craftsmanshipScore,
    contextuality: contextualityScore,
  };

  // 各カテゴリから最低1件の推奨事項を追加
  const categories: Array<'originality' | 'craftsmanship' | 'contextuality'> = [
    'originality',
    'craftsmanship',
    'contextuality',
  ];

  for (const category of categories) {
    const categoryRecs = recommendations.filter((r) => r.category === category);

    // このカテゴリにまだ推奨事項がない場合、追加
    if (categoryRecs.length === 0) {
      const baseRecs = BASE_RECOMMENDATIONS[category];
      const score = scores[category];
      const categoryDetails =
        category === 'originality'
          ? details.originality
          : category === 'craftsmanship'
            ? details.craftsmanship
            : details.contextuality;

      // 条件に合う推奨事項を探す
      for (const baseRec of baseRecs) {
        if (!baseRec.condition || baseRec.condition(score, categoryDetails)) {
          recommendations.push({
            id: `rec-${recId++}`,
            category,
            priority: baseRec.priority,
            title: baseRec.title,
            description: baseRec.description,
            expectedImpact: `+${baseRec.impact} points`,
          });
          break; // 1件追加したら次のカテゴリへ
        }
      }

      // 条件に合うものがない場合、フォールバックとして最後の推奨事項を追加
      if (recommendations.filter((r) => r.category === category).length === 0) {
        const fallbackRec = baseRecs[baseRecs.length - 1]!;
        recommendations.push({
          id: `rec-${recId++}`,
          category,
          priority: fallbackRec.priority,
          title: fallbackRec.title,
          description: fallbackRec.description,
          expectedImpact: `+${fallbackRec.impact} points`,
        });
      }
    }
  }

  // =====================================================
  // 3. 最低3件を保証
  // =====================================================

  // 推奨事項が3件未満の場合、追加の推奨事項を補充
  if (recommendations.length < 3) {
    const additionalRecs = [
      {
        category: 'originality' as const,
        priority: 'low' as const,
        title: 'ブランドの視覚的アイデンティティを強化する',
        description: '一貫したカラースキーム、タイポグラフィ、スペーシングを適用し、ブランド認知度を高めてください。',
        impact: 3,
      },
      {
        category: 'craftsmanship' as const,
        priority: 'low' as const,
        title: 'パフォーマンス最適化を検討する',
        description: '画像の遅延読み込み、CSSの最適化、不要なスクリプトの削除を検討してください。',
        impact: 3,
      },
      {
        category: 'contextuality' as const,
        priority: 'low' as const,
        title: 'ユーザーフィードバックを収集する仕組みを追加',
        description: 'フォーム、チャットウィジェット、フィードバックボタンなどを追加し、ユーザーの声を収集してください。',
        impact: 2,
      },
    ];

    for (const addRec of additionalRecs) {
      if (recommendations.length >= 3) break;

      // 同じタイトルの推奨事項がないか確認
      if (!recommendations.some((r) => r.title === addRec.title)) {
        recommendations.push({
          id: `rec-${recId++}`,
          category: addRec.category,
          priority: addRec.priority,
          title: addRec.title,
          description: addRec.description,
          expectedImpact: `+${addRec.impact} points`,
        });
      }
    }
  }

  // =====================================================
  // 4. 優先度順にソートして返却
  // =====================================================

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // 最大10件
  return recommendations.slice(0, 10);
}

// =====================================================
// QualityEvaluatorService クラス
// =====================================================

/**
 * 品質評価サービス
 *
 * Webデザインの品質を3軸で評価し、AIクリシェ検出と推奨事項生成を行う
 */
export class QualityEvaluatorService {
  /**
   * HTMLを評価し、品質スコアと詳細を返す
   *
   * @param html - 評価対象のHTML
   * @param options - 評価オプション
   * @returns 品質評価結果
   */
  async evaluate(
    html: string,
    options: QualityEvaluatorOptions = {}
  ): Promise<QualityEvaluatorResult> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.debug('[QualityEvaluatorService] evaluate called', {
        htmlLength: html.length,
        strict: options.strict,
        targetIndustry: options.targetIndustry,
        targetAudience: options.targetAudience,
      });
    }

    try {
      const strict = options.strict ?? false;
      const includeRecommendations = options.includeRecommendations ?? true;

      // 重み付け
      const weights = {
        originality: options.weights?.originality ?? DEFAULT_WEIGHTS.originality,
        craftsmanship: options.weights?.craftsmanship ?? DEFAULT_WEIGHTS.craftsmanship,
        contextuality: options.weights?.contextuality ?? DEFAULT_WEIGHTS.contextuality,
      };

      // クリシェ検出
      const cliches = detectCliches(html, strict);

      // 3軸評価
      const originalityResult = evaluateOriginality(html, cliches, strict);
      const craftsmanshipResult = evaluateCraftsmanship(html);
      const contextualityResult = evaluateContextuality(
        html,
        options.targetIndustry,
        options.targetAudience
      );

      // 軸別スコア
      const axisScores: AxisScores = {
        originality: originalityResult.score,
        craftsmanship: craftsmanshipResult.score,
        contextuality: contextualityResult.score,
      };

      // 総合スコア計算
      const overallScore = Math.round(
        axisScores.originality * weights.originality +
          axisScores.craftsmanship * weights.craftsmanship +
          axisScores.contextuality * weights.contextuality
      );

      // グレード
      const grade = scoreToGrade(overallScore);
      const axisGrades: AxisGrades = {
        originality: scoreToGrade(axisScores.originality),
        craftsmanship: scoreToGrade(axisScores.craftsmanship),
        contextuality: scoreToGrade(axisScores.contextuality),
      };

      // 詳細
      const axisDetails: AxisDetails = {
        originality: originalityResult.details,
        craftsmanship: craftsmanshipResult.details,
        contextuality: contextualityResult.details,
      };

      // 処理時間
      const processingTimeMs = Date.now() - startTime;

      // 結果構築
      const result: QualityEvaluatorResult = {
        success: true,
        overallScore,
        grade,
        axisScores,
        clicheCount: cliches.length,
        processingTimeMs,
        axisGrades,
        axisDetails,
        cliches,
      };

      // 推奨事項
      if (includeRecommendations) {
        result.recommendations = generateRecommendations(
          axisScores.originality,
          axisScores.craftsmanship,
          axisScores.contextuality,
          cliches,
          axisDetails
        );
      }

      if (isDevelopment()) {
        logger.debug('[QualityEvaluatorService] evaluate completed', {
          overallScore,
          grade,
          clicheCount: cliches.length,
          processingTimeMs,
        });
      }

      return result;
    } catch (error) {
      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.error('[QualityEvaluatorService] evaluate error', { error });
      }

      return {
        success: false,
        overallScore: 0,
        grade: 'F',
        axisScores: {
          originality: 0,
          craftsmanship: 0,
          contextuality: 0,
        },
        clicheCount: 0,
        processingTimeMs,
        error: {
          code: 'QUALITY_EVALUATION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }
}

// =====================================================
// シングルトンインスタンス
// =====================================================

let sharedInstance: QualityEvaluatorService | null = null;

/**
 * 共有インスタンスを取得
 */
export function getQualityEvaluatorService(): QualityEvaluatorService {
  if (!sharedInstance) {
    sharedInstance = new QualityEvaluatorService();
  }
  return sharedInstance;
}

/**
 * 共有インスタンスをリセット（テスト用）
 */
export function resetQualityEvaluatorService(): void {
  sharedInstance = null;
}
