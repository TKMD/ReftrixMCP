// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisualDesignAnalyzer Service
 *
 * HTML+CSS文字列の静的解析による視覚デザイン品質メトリクス算出サービス。
 * 外部リソースフェッチなし、正規表現/DOM解析のみで動作。
 *
 * 5つのメトリクス:
 * - visualDensity: 視覚的密度（メディア要素/セクション比）
 * - typographyContrast: タイポグラフィコントラスト（フォントサイズ・ウェイト階層）
 * - colorVariety: 色彩豊富度（ユニークカラー数・色相分散）
 * - whitespaceIntentionality: 余白の意図性（スペーシングスケール一貫性）
 * - visualDepth: 視覚的深度（シャドウ・グラデーション・トランスフォーム）
 *
 * @module services/quality/visual-design-analyzer.service
 */

import { isDevelopment, logger } from '../../utils/logger';

// =====================================================
// Interfaces
// =====================================================

/**
 * 視覚デザインメトリクス結果
 */
export interface VisualDesignMetrics {
  /** 視覚的密度 0-100 */
  visualDensity: number;
  /** タイポグラフィコントラスト 0-100 */
  typographyContrast: number;
  /** 色彩豊富度 0-100 */
  colorVariety: number;
  /** 余白の意図性 0-100 */
  whitespaceIntentionality: number;
  /** 視覚的深度 0-100 */
  visualDepth: number;
  /** 加重平均 0-100 */
  overall: number;
  /** 各メトリクスの根拠 */
  details: string[];
}

/**
 * VisualDesignAnalyzerサービスインターフェース
 */
export interface IVisualDesignAnalyzerService {
  analyze(html: string, css?: string): VisualDesignMetrics;
}

// =====================================================
// Constants
// =====================================================

/** メディア要素セレクタ正規表現 */
const MEDIA_ELEMENT_RE =
  /<(?:img|svg|picture|video|canvas|i\b|span\b)[^>]*class\s*=\s*["'][^"']*(?:icon|ico)[^"']*["'][^>]*>|<(?:img|svg|picture|video|canvas)\b[^>]*>/gi;

/** 装飾的img正規表現（alt=""） */
const DECORATIVE_IMG_RE = /<img[^>]*\balt\s*=\s*["']\s*["'][^>]*>/gi;

/** セクション要素正規表現 */
const SECTION_ELEMENT_RE =
  /<(?:section|article|main|header|footer|nav)\b[^>]*>|<[^>]*\brole\s*=\s*["'](?:region|main|banner|contentinfo|navigation)["'][^>]*>/gi;

/** font-size値の正規表現 */
const FONT_SIZE_RE =
  /font-size\s*:\s*([\d.]+(?:px|rem|em|vw|vh|%)|clamp\([^)]+\))/gi;

/** font-weight値の正規表現 */
const FONT_WEIGHT_RE = /font-weight\s*:\s*(\d{3}|bold|bolder|lighter|normal)/gi;

/** line-height値の正規表現 */
const LINE_HEIGHT_RE = /line-height\s*:\s*([\d.]+(?:px|rem|em|%)?)/gi;

/** カラー値の正規表現（hex, rgb, rgba, hsl, hsla） */
const COLOR_VALUE_RE =
  /#(?:[0-9a-fA-F]{3,4}){1,2}\b|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)|hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%(?:\s*,\s*[\d.]+)?\s*\)/gi;

/** CSS名前付きカラー（主要なもの） */
const NAMED_COLORS = new Set([
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple',
  'pink', 'gray', 'grey', 'brown', 'cyan', 'magenta', 'lime', 'navy',
  'teal', 'olive', 'maroon', 'silver', 'gold', 'coral', 'salmon',
  'tomato', 'crimson', 'indigo', 'violet', 'turquoise', 'tan', 'khaki',
  'beige', 'ivory', 'lavender', 'plum', 'orchid', 'sienna', 'peru',
  'chocolate', 'firebrick', 'darkred', 'darkblue', 'darkgreen',
  'darkgray', 'darkgrey', 'lightgray', 'lightgrey', 'whitesmoke',
  'ghostwhite', 'aliceblue', 'mintcream', 'honeydew', 'azure',
  'mistyrose', 'linen', 'seashell', 'snow', 'floralwhite',
]);

/** 名前付きカラー検出正規表現（CSSプロパティ値内） */
const NAMED_COLOR_IN_CSS_RE =
  /(?:color|background(?:-color)?|border(?:-color)?|outline-color|fill|stroke)\s*:\s*([a-zA-Z]+)\b/gi;

/** padding/margin/gap値の正規表現 */
const SPACING_VALUE_RE =
  /(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?\s*:\s*([^;}{]+)/gi;

/** clamp()使用の正規表現 */
const CLAMP_RE = /clamp\([^)]+\)/gi;

/** CSS変数使用の正規表現 */
const CSS_VAR_RE = /var\(--[^)]+\)/gi;

/** box-shadow正規表現 */
const BOX_SHADOW_RE = /box-shadow\s*:[^;}{]+/gi;

/** text-shadow正規表現 */
const TEXT_SHADOW_RE = /text-shadow\s*:[^;}{]+/gi;

/** filter正規表現 */
const FILTER_RE = /(?:^|[^-])filter\s*:[^;}{]+/gi;

/** backdrop-filter正規表現 */
const BACKDROP_FILTER_RE = /backdrop-filter\s*:[^;}{]+/gi;

/** gradient正規表現 */
const GRADIENT_RE =
  /(?:linear|radial|conic)-gradient\([^)]*(?:\([^)]*\))*[^)]*\)/gi;

/** transform正規表現 */
const TRANSFORM_RE = /transform\s*:[^;}{]+/gi;

/** z-index正規表現 */
const Z_INDEX_RE = /z-index\s*:\s*-?\d+/gi;

/** 疑似要素正規表現 */
const PSEUDO_ELEMENT_RE = /::(?:before|after)\s*\{[^}]*\}/gi;

/** <style>タグ内のCSS抽出正規表現 */
const STYLE_TAG_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;

/** inline style属性の抽出正規表現 */
const INLINE_STYLE_RE = /style\s*=\s*["']([^"']+)["']/gi;

// =====================================================
// Helper Functions
// =====================================================

/**
 * HTML内の<style>タグとinline styleからCSS文字列を結合抽出
 */
function extractCssFromHtml(html: string): string {
  const parts: string[] = [];

  // <style>タグ内のCSS
  let match: RegExpExecArray | null;
  const styleTagRe = new RegExp(STYLE_TAG_RE.source, STYLE_TAG_RE.flags);
  while ((match = styleTagRe.exec(html)) !== null) {
    if (match[1]) parts.push(match[1]);
  }

  // inline style属性
  const inlineStyleRe = new RegExp(INLINE_STYLE_RE.source, INLINE_STYLE_RE.flags);
  while ((match = inlineStyleRe.exec(html)) !== null) {
    if (match[1]) parts.push(match[1]);
  }

  return parts.join('\n');
}

/**
 * 正規表現のグローバルマッチをカウント
 */
function countMatches(text: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags);
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/**
 * 正規表現のグローバルマッチを配列で取得
 */
function getAllMatches(text: string, pattern: RegExp): string[] {
  const re = new RegExp(pattern.source, pattern.flags);
  return text.match(re) ?? [];
}

/**
 * font-sizeをpx換算（概算）
 * rem/emは16px基準、clamp()は中間値を使用
 */
function normalizeFontSizeToPx(value: string): number {
  const trimmed = value.trim().toLowerCase();

  // clamp()の場合は中間値（preferred）を使用
  if (trimmed.startsWith('clamp(')) {
    const inner = trimmed.slice(6, -1);
    const parts = inner.split(',').map((s) => s.trim());
    const preferred = parts[1];
    if (parts.length >= 2 && preferred) {
      return normalizeFontSizeToPx(preferred);
    }
    return 16;
  }

  const numMatch = trimmed.match(/([\d.]+)(px|rem|em|vw|vh|%)?/);
  if (!numMatch || !numMatch[1]) return 16;

  const num = parseFloat(numMatch[1]);
  const unit = numMatch[2] ?? 'px';

  switch (unit) {
    case 'px':
      return num;
    case 'rem':
    case 'em':
      return num * 16;
    case 'vw':
    case 'vh':
      return num * 10; // 1000px viewport概算
    case '%':
      return (num / 100) * 16;
    default:
      return num;
  }
}

/**
 * font-weightを数値に変換
 */
function normalizeWeight(value: string): number {
  const trimmed = value.trim().toLowerCase();
  switch (trimmed) {
    case 'normal':
      return 400;
    case 'bold':
      return 700;
    case 'bolder':
      return 800;
    case 'lighter':
      return 300;
    default: {
      const parsed = parseInt(trimmed, 10);
      return isNaN(parsed) ? 400 : parsed;
    }
  }
}

/**
 * hex/rgb/hsl色をHSLに変換（色相抽出用）
 * 簡易実装: 色相の分散計算に使用
 */
function extractHue(colorStr: string): number | null {
  const trimmed = colorStr.trim().toLowerCase();

  // HSL形式
  const hslMatch = trimmed.match(/hsla?\(\s*([\d.]+)/);
  if (hslMatch && hslMatch[1]) {
    return parseFloat(hslMatch[1]) % 360;
  }

  // RGB形式
  const rgbMatch = trimmed.match(
    /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/
  );
  if (rgbMatch && rgbMatch[1] && rgbMatch[2] && rgbMatch[3]) {
    return rgbToHue(
      parseInt(rgbMatch[1], 10),
      parseInt(rgbMatch[2], 10),
      parseInt(rgbMatch[3], 10)
    );
  }

  // Hex形式
  const hexMatch = trimmed.match(/^#([0-9a-f]{3,8})$/);
  if (hexMatch && hexMatch[1]) {
    const hex = hexMatch[1];
    let r: number, g: number, b: number;
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex.charAt(0) + hex.charAt(0), 16);
      g = parseInt(hex.charAt(1) + hex.charAt(1), 16);
      b = parseInt(hex.charAt(2) + hex.charAt(2), 16);
    } else {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
    return rgbToHue(r, g, b);
  }

  return null;
}

/**
 * RGB → Hue (0-360) 変換
 */
function rgbToHue(r: number, g: number, b: number): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  if (delta === 0) return 0;

  let hue: number;
  if (max === rn) {
    hue = ((gn - bn) / delta) % 6;
  } else if (max === gn) {
    hue = (bn - rn) / delta + 2;
  } else {
    hue = (rn - gn) / delta + 4;
  }

  hue *= 60;
  if (hue < 0) hue += 360;

  return hue;
}

/**
 * 色相の分散（標準偏差）を計算（circular statistics）
 */
function calculateHueVariance(hues: number[]): number {
  if (hues.length < 2) return 0;

  // 円形統計: sinとcosの平均を使用
  let sinSum = 0;
  let cosSum = 0;
  for (const h of hues) {
    const rad = (h * Math.PI) / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
  }

  const meanSin = sinSum / hues.length;
  const meanCos = cosSum / hues.length;
  const r = Math.sqrt(meanSin * meanSin + meanCos * meanCos);

  // r = 1: 全て同じ方向 → 分散低, r = 0: 均等分散 → 分散高
  // 分散 = 1 - r (0-1)
  return 1 - r;
}

/**
 * spacing値をpx換算
 */
function normalizeSpacingToPx(value: string): number {
  const trimmed = value.trim().toLowerCase();

  if (trimmed.startsWith('clamp(')) {
    const inner = trimmed.slice(6, -1);
    const parts = inner.split(',').map((s) => s.trim());
    const preferred = parts[1];
    if (parts.length >= 2 && preferred) {
      return normalizeSpacingToPx(preferred);
    }
    return 0;
  }

  if (trimmed.startsWith('var(')) {
    return -1; // CSS変数はスコア加算用のシグナル
  }

  const numMatch = trimmed.match(/([\d.]+)(px|rem|em|%|vw|vh)?/);
  if (!numMatch || !numMatch[1]) return 0;

  const num = parseFloat(numMatch[1]);
  const unit = numMatch[2] ?? 'px';

  switch (unit) {
    case 'px':
      return num;
    case 'rem':
    case 'em':
      return num * 16;
    case '%':
    case 'vw':
    case 'vh':
      return num * 10;
    default:
      return num;
  }
}

/**
 * 値を0-100にクランプ
 */
function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// =====================================================
// Metric Calculators
// =====================================================

/**
 * 1. visualDensity: 視覚的密度メトリクス
 */
function calculateVisualDensity(html: string): { score: number; detail: string } {
  // メディア要素カウント
  const allMedia = getAllMatches(html, MEDIA_ELEMENT_RE);
  const decorativeImgs = getAllMatches(html, DECORATIVE_IMG_RE);

  // 装飾的imgを除外したメディア数
  const effectiveMediaCount = Math.max(0, allMedia.length - decorativeImgs.length);

  // セクション要素カウント
  const sectionCount = Math.max(1, countMatches(html, SECTION_ELEMENT_RE));

  // セクションあたりの密度
  const density = effectiveMediaCount / sectionCount;

  let score: number;
  if (effectiveMediaCount === 0) {
    score = 0;
  } else if (density < 0.5) {
    score = Math.round(density * 80);
  } else if (density < 1) {
    score = Math.round(40 + (density - 0.5) * 40);
  } else if (density < 2) {
    score = Math.round(60 + (density - 1) * 20);
  } else if (density < 3) {
    score = Math.round(80 + (density - 2) * 15);
  } else {
    score = Math.round(Math.min(100, 95 + (density - 3) * 2));
  }

  score = clampScore(score);

  const detail =
    `visualDensity: ${score} (media=${effectiveMediaCount}, sections=${sectionCount}, density=${density.toFixed(2)})`;

  return { score, detail };
}

/**
 * 2. typographyContrast: タイポグラフィコントラスト
 */
function calculateTypographyContrast(
  css: string,
  html: string
): { score: number; detail: string } {
  // font-size値を全て抽出
  const fontSizes: number[] = [];
  let match: RegExpExecArray | null;

  const fontSizeRe = new RegExp(FONT_SIZE_RE.source, FONT_SIZE_RE.flags);
  while ((match = fontSizeRe.exec(css)) !== null) {
    if (match[1]) fontSizes.push(normalizeFontSizeToPx(match[1]));
  }

  // HTMLからも抽出（style属性等）
  const htmlFontSizeRe = new RegExp(FONT_SIZE_RE.source, FONT_SIZE_RE.flags);
  while ((match = htmlFontSizeRe.exec(html)) !== null) {
    if (match[1]) fontSizes.push(normalizeFontSizeToPx(match[1]));
  }

  // font-weight値を抽出
  const weights: number[] = [];
  const fontWeightRe = new RegExp(FONT_WEIGHT_RE.source, FONT_WEIGHT_RE.flags);
  while ((match = fontWeightRe.exec(css)) !== null) {
    if (match[1]) weights.push(normalizeWeight(match[1]));
  }
  const htmlWeightRe = new RegExp(FONT_WEIGHT_RE.source, FONT_WEIGHT_RE.flags);
  while ((match = htmlWeightRe.exec(html)) !== null) {
    if (match[1]) weights.push(normalizeWeight(match[1]));
  }

  // line-height値を抽出
  const lineHeights = countMatches(css, LINE_HEIGHT_RE) + countMatches(html, LINE_HEIGHT_RE);

  if (fontSizes.length === 0) {
    return {
      score: 10,
      detail: 'typographyContrast: 10 (no font-size declarations found)',
    };
  }

  // ユニークサイズ数
  const uniqueSizes = [...new Set(fontSizes.map((s) => Math.round(s)))];
  const uniqueWeights = [...new Set(weights)];

  const maxSize = Math.max(...fontSizes);
  const minSize = Math.min(...fontSizes);

  // サイズ比（最大/最小）: h1/body相当
  const sizeRatio = minSize > 0 ? maxSize / minSize : 1;

  let score = 0;

  // サイズ比スコア (0-40)
  if (sizeRatio >= 3) {
    score += 40;
  } else if (sizeRatio >= 2) {
    score += 25 + Math.round((sizeRatio - 2) * 15);
  } else if (sizeRatio >= 1.5) {
    score += 15 + Math.round((sizeRatio - 1.5) * 20);
  } else {
    score += Math.round(sizeRatio * 10);
  }

  // ユニークサイズ数ボーナス (0-25)
  score += Math.min(25, uniqueSizes.length * 5);

  // font-weightバリエーションボーナス (0-20)
  score += Math.min(20, uniqueWeights.length * 7);

  // line-height使用ボーナス (0-15)
  score += Math.min(15, lineHeights * 3);

  score = clampScore(score);

  const detail =
    `typographyContrast: ${score} (sizes=${uniqueSizes.length}, ratio=${sizeRatio.toFixed(1)}, weights=${uniqueWeights.length}, lineHeights=${lineHeights})`;

  return { score, detail };
}

/**
 * 3. colorVariety: 色彩豊富度
 */
function calculateColorVariety(
  css: string,
  html: string
): { score: number; detail: string } {
  const combined = css + '\n' + html;

  // カラー値を抽出
  const colorMatches = getAllMatches(combined, COLOR_VALUE_RE);

  // 名前付きカラーを検出
  const namedColorMatches: string[] = [];
  let match: RegExpExecArray | null;
  const namedRe = new RegExp(NAMED_COLOR_IN_CSS_RE.source, NAMED_COLOR_IN_CSS_RE.flags);
  while ((match = namedRe.exec(combined)) !== null) {
    if (!match[1]) continue;
    const colorName = match[1].toLowerCase();
    if (NAMED_COLORS.has(colorName)) {
      namedColorMatches.push(colorName);
    }
  }

  // ユニークカラー集合
  const uniqueColors = new Set([
    ...colorMatches.map((c) => c.toLowerCase().replace(/\s+/g, '')),
    ...namedColorMatches,
  ]);

  const uniqueCount = uniqueColors.size;

  // 色相抽出
  const hues: number[] = [];
  for (const color of uniqueColors) {
    const hue = extractHue(color);
    if (hue !== null) {
      hues.push(hue);
    }
  }

  // 色相の分散
  const hueVariance = calculateHueVariance(hues);

  let score = 0;

  // ユニークカラー数スコア (0-50)
  if (uniqueCount <= 1) {
    score += 5;
  } else if (uniqueCount <= 3) {
    score += 15 + (uniqueCount - 1) * 5;
  } else if (uniqueCount <= 6) {
    score += 25 + (uniqueCount - 3) * 5;
  } else if (uniqueCount <= 10) {
    score += 40 + (uniqueCount - 6) * 2;
  } else {
    score += Math.min(50, 48 + Math.floor(uniqueCount / 10));
  }

  // 色相分散スコア (0-50)
  // hueVariance: 0 (全て同色) ～ 1 (均等分散)
  score += Math.round(hueVariance * 50);

  score = clampScore(score);

  const detail =
    `colorVariety: ${score} (uniqueColors=${uniqueCount}, hueVariance=${hueVariance.toFixed(2)}, hues=${hues.length})`;

  return { score, detail };
}

/**
 * 4. whitespaceIntentionality: 余白の意図性
 */
function calculateWhitespaceIntentionality(
  css: string,
  html: string
): { score: number; detail: string } {
  const combined = css + '\n' + html;

  // spacing値を抽出
  const spacingDeclarations = getAllMatches(combined, SPACING_VALUE_RE);
  const spacingValues: number[] = [];
  let clampCount = 0;
  let cssVarCount = 0;

  for (const decl of spacingDeclarations) {
    // プロパティ名部分を除去して値部分のみ取得
    const colonIndex = decl.indexOf(':');
    if (colonIndex === -1) continue;
    const rawValue = decl.slice(colonIndex + 1).trim();

    // 複数値（shorthand）を個別に処理
    const values = rawValue.split(/\s+/).filter((v) => v && v !== '0' && v !== 'auto' && v !== 'inherit');

    for (const v of values) {
      if (CLAMP_RE.test(v)) {
        clampCount++;
        // clamp正規表現のlastIndexをリセット
        CLAMP_RE.lastIndex = 0;
      }
      if (CSS_VAR_RE.test(v)) {
        cssVarCount++;
        CSS_VAR_RE.lastIndex = 0;
      }
      const px = normalizeSpacingToPx(v);
      if (px > 0) {
        spacingValues.push(px);
      }
    }
  }

  // 追加: combined全体からclamp/var使用をカウント
  const totalClamps = countMatches(combined, CLAMP_RE);
  const totalVars = countMatches(combined, CSS_VAR_RE);
  clampCount = Math.max(clampCount, totalClamps);
  cssVarCount = Math.max(cssVarCount, totalVars);

  if (spacingValues.length === 0 && clampCount === 0 && cssVarCount === 0) {
    return {
      score: 10,
      detail: 'whitespaceIntentionality: 10 (no spacing declarations found)',
    };
  }

  let score = 0;

  // 基本スペーシング宣言数 (0-25)
  score += Math.min(25, spacingDeclarations.length * 2);

  // clamp()使用ボーナス (0-25)
  score += Math.min(25, clampCount * 8);

  // CSS変数使用ボーナス (0-20)
  score += Math.min(20, cssVarCount * 5);

  // 一貫したスケール検出 (0-20)
  // 8pxの倍数パターンの検出
  if (spacingValues.length >= 3) {
    const roundedValues = spacingValues.map((v) => Math.round(v));
    const multiplesOf8 = roundedValues.filter((v) => v % 8 === 0 || v % 4 === 0);
    const scaleConsistency = multiplesOf8.length / roundedValues.length;
    score += Math.round(scaleConsistency * 20);
  }

  // 大きなセクションパディング検出 (0-10)
  const largeSpacings = spacingValues.filter((v) => v >= 80);
  if (largeSpacings.length > 0) {
    score += Math.min(10, largeSpacings.length * 3);
  }

  score = clampScore(score);

  const detail =
    `whitespaceIntentionality: ${score} (declarations=${spacingDeclarations.length}, clamp=${clampCount}, cssVar=${cssVarCount}, values=${spacingValues.length})`;

  return { score, detail };
}

/**
 * 5. visualDepth: 視覚的深度
 */
function calculateVisualDepth(
  css: string,
  html: string
): { score: number; detail: string } {
  const combined = css + '\n' + html;

  // 各プロパティの使用数をカウント
  const boxShadowCount = countMatches(combined, BOX_SHADOW_RE);
  const textShadowCount = countMatches(combined, TEXT_SHADOW_RE);
  const filterCount = countMatches(combined, FILTER_RE);
  const backdropFilterCount = countMatches(combined, BACKDROP_FILTER_RE);
  const gradients = getAllMatches(combined, GRADIENT_RE);
  const transformCount = countMatches(combined, TRANSFORM_RE);
  const zIndexCount = countMatches(combined, Z_INDEX_RE);
  const pseudoElements = getAllMatches(combined, PSEUDO_ELEMENT_RE);

  let score = 0;

  // box-shadow (0-20)
  score += Math.min(20, boxShadowCount * 8);

  // text-shadow (0-10)
  score += Math.min(10, textShadowCount * 5);

  // filter / backdrop-filter (0-15)
  score += Math.min(10, filterCount * 5);
  score += Math.min(5, backdropFilterCount * 5);

  // gradient複雑度 (0-20)
  if (gradients.length > 0) {
    let gradientScore = Math.min(10, gradients.length * 4);

    // グラデーション内のstop数
    for (const grad of gradients) {
      const commaCount = (grad.match(/,/g) ?? []).length;
      if (commaCount >= 3) {
        gradientScore += 3; // 多段グラデーション
      }
    }
    score += Math.min(20, gradientScore);
  }

  // transform (0-15)
  score += Math.min(15, transformCount * 5);

  // z-index（レイヤリング意識） (0-10)
  score += Math.min(10, zIndexCount * 3);

  // 疑似要素の装飾利用 (0-10)
  let pseudoDecorationScore = 0;
  for (const pseudo of pseudoElements) {
    if (
      /content\s*:\s*["'][^"']*["']/.test(pseudo) ||
      /background/.test(pseudo) ||
      /border/.test(pseudo) ||
      /position\s*:\s*absolute/.test(pseudo)
    ) {
      pseudoDecorationScore += 3;
    }
  }
  score += Math.min(10, pseudoDecorationScore);

  score = clampScore(score);

  const detail =
    `visualDepth: ${score} (shadow=${boxShadowCount}+${textShadowCount}, filter=${filterCount}+${backdropFilterCount}, gradients=${gradients.length}, transform=${transformCount}, zIndex=${zIndexCount}, pseudo=${pseudoElements.length})`;

  return { score, detail };
}

// =====================================================
// Service Implementation
// =====================================================

/**
 * VisualDesignAnalyzerService
 *
 * HTML+CSS文字列から視覚デザイン品質メトリクスを算出。
 * 外部リソースフェッチなし、正規表現ベースの静的解析。
 *
 * @example
 * ```typescript
 * const service = getVisualDesignAnalyzerService();
 * const metrics = service.analyze(html, css);
 * console.log(metrics.overall); // 0-100
 * ```
 */
export class VisualDesignAnalyzerService implements IVisualDesignAnalyzerService {
  /**
   * HTML+CSSから視覚デザインメトリクスを算出
   *
   * @param html - 分析対象のHTML文字列
   * @param css - 追加のCSS文字列（オプション）
   * @returns 5つのメトリクス + overall + details
   */
  analyze(html: string, css?: string): VisualDesignMetrics {
    if (!html || html.trim() === '') {
      return this.createEmptyResult();
    }

    const startTime = Date.now();

    // HTMLからCSSを抽出し、外部CSSと結合
    const extractedCss = extractCssFromHtml(html);
    const combinedCss = css ? `${extractedCss}\n${css}` : extractedCss;

    // 各メトリクスを計算
    const density = calculateVisualDensity(html);
    const typography = calculateTypographyContrast(combinedCss, html);
    const color = calculateColorVariety(combinedCss, html);
    const whitespace = calculateWhitespaceIntentionality(combinedCss, html);
    const depth = calculateVisualDepth(combinedCss, html);

    // 加重平均
    const overall = clampScore(
      density.score * 0.25 +
      typography.score * 0.20 +
      color.score * 0.15 +
      whitespace.score * 0.15 +
      depth.score * 0.25
    );

    const elapsed = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[VisualDesignAnalyzer] Analysis completed', {
        overall,
        elapsed: `${elapsed}ms`,
        htmlLength: html.length,
        cssLength: combinedCss.length,
      });
    }

    return {
      visualDensity: density.score,
      typographyContrast: typography.score,
      colorVariety: color.score,
      whitespaceIntentionality: whitespace.score,
      visualDepth: depth.score,
      overall,
      details: [
        density.detail,
        typography.detail,
        color.detail,
        whitespace.detail,
        depth.detail,
        `overall: ${overall} (weighted average, elapsed=${elapsed}ms)`,
      ],
    };
  }

  /**
   * 空の結果を作成
   */
  private createEmptyResult(): VisualDesignMetrics {
    return {
      visualDensity: 0,
      typographyContrast: 0,
      colorVariety: 0,
      whitespaceIntentionality: 0,
      visualDepth: 0,
      overall: 0,
      details: ['No HTML content provided'],
    };
  }
}

// =====================================================
// Factory Functions (DI Pattern)
// =====================================================

/** ファクトリ関数（テスト時のDI用） */
let visualDesignAnalyzerServiceFactory:
  | (() => IVisualDesignAnalyzerService)
  | null = null;

/**
 * VisualDesignAnalyzerServiceファクトリを設定（テスト用）
 */
export function setVisualDesignAnalyzerServiceFactory(
  factory: () => IVisualDesignAnalyzerService
): void {
  visualDesignAnalyzerServiceFactory = factory;
}

/**
 * VisualDesignAnalyzerServiceファクトリをリセット（テスト用）
 */
export function resetVisualDesignAnalyzerServiceFactory(): void {
  visualDesignAnalyzerServiceFactory = null;
}

/**
 * VisualDesignAnalyzerServiceインスタンスを取得
 *
 * ファクトリが設定されている場合はそれを使用、
 * なければデフォルトのVisualDesignAnalyzerServiceを返す。
 */
export function getVisualDesignAnalyzerService(): IVisualDesignAnalyzerService {
  if (visualDesignAnalyzerServiceFactory) {
    return visualDesignAnalyzerServiceFactory();
  }
  return new VisualDesignAnalyzerService();
}

/**
 * VisualDesignAnalyzerServiceのインスタンスを直接作成
 */
export function createVisualDesignAnalyzerService(): VisualDesignAnalyzerService {
  return new VisualDesignAnalyzerService();
}
