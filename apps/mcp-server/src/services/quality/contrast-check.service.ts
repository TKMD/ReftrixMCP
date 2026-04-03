// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Contrast Check Service
 *
 * WCAG 2.1 AA/AAA準拠のコントラスト比計算サービス。
 * sRGB相対輝度ベースのコントラスト比算出と、不合格要素への代替色提案を提供。
 *
 * AA基準: 通常テキスト >= 4.5:1, 大テキスト >= 3:1
 * AAA基準: 通常テキスト >= 7.0:1, 大テキスト >= 4.5:1
 *
 * WCAG 2.1 AA/AAA compliant contrast ratio calculation service.
 * Provides sRGB relative luminance-based contrast ratio calculation
 * and alternative color suggestions for failing elements.
 *
 * @module services/quality/contrast-check.service
 */

import { JSDOM } from "jsdom";
import { logger, isDevelopment } from "../../utils/logger";

// =====================================================
// 型定義 / Type Definitions
// =====================================================

/**
 * RGB値 / RGB values
 */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * コントラスト問題 / Contrast issue
 */
export interface ContrastIssue {
  /** 対象要素のタグ名/セレクタ / Element tag/selector */
  element: string;
  /** 前景色 / Foreground color */
  fgColor: string;
  /** 背景色 / Background color */
  bgColor: string;
  /** コントラスト比 / Contrast ratio */
  ratio: number;
  /** WCAG AA 合格 / Meets WCAG AA */
  meetsAA: boolean;
  /** 大テキストかどうか / Is large text */
  isLargeText: boolean;
  /** 提案された代替前景色（不合格時のみ） / Suggested alternative (only when failing) */
  suggestedColor?: string;
}

/**
 * HTMLコントラストチェック結果 / HTML contrast check result
 */
export interface ContrastCheckResult {
  /** コントラスト問題リスト / List of contrast issues */
  issues: ContrastIssue[];
  /** チェックされた要素総数 / Total elements checked */
  totalElements: number;
}

// =====================================================
// Named colors マッピング / Named Colors Mapping
// =====================================================

const NAMED_COLORS: Record<string, RGB> = {
  black: { r: 0, g: 0, b: 0 },
  white: { r: 255, g: 255, b: 255 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  silver: { r: 192, g: 192, b: 192 },
  maroon: { r: 128, g: 0, b: 0 },
  olive: { r: 128, g: 128, b: 0 },
  lime: { r: 0, g: 255, b: 0 },
  aqua: { r: 0, g: 255, b: 255 },
  teal: { r: 0, g: 128, b: 128 },
  navy: { r: 0, g: 0, b: 128 },
  fuchsia: { r: 255, g: 0, b: 255 },
  purple: { r: 128, g: 0, b: 128 },
  orange: { r: 255, g: 165, b: 0 },
  transparent: { r: 0, g: 0, b: 0 },
};

// =====================================================
// WCAG AA/AAA 基準定数 / WCAG AA/AAA Threshold Constants
// =====================================================

/** 通常テキスト AA基準 / Normal text AA threshold */
const AA_NORMAL_TEXT_RATIO = 4.5;
/** 大テキスト AA基準 / Large text AA threshold */
const AA_LARGE_TEXT_RATIO = 3.0;
/** 通常テキスト AAA基準 / Normal text AAA threshold */
const AAA_NORMAL_TEXT_RATIO = 7.0;
/** 大テキスト AAA基準 / Large text AAA threshold */
const AAA_LARGE_TEXT_RATIO = 4.5;

// =====================================================
// サービス実装 / Service Implementation
// =====================================================

/**
 * Contrast Check Service
 *
 * sRGB相対輝度ベースのWCAG 2.1コントラスト比計算と代替色提案
 * sRGB relative luminance-based WCAG 2.1 contrast ratio calculation and alternative color suggestions
 */
export class ContrastCheckService {
  constructor() {
    if (isDevelopment()) {
      logger.info("[ContrastCheckService] Initialized");
    }
  }

  /**
   * 2色間のコントラスト比を計算
   * Calculate contrast ratio between two colors
   *
   * @param fg - 前景色（hex, rgb(), rgba(), named color） / Foreground color
   * @param bg - 背景色 / Background color
   * @returns コントラスト比 (1-21) / Contrast ratio
   */
  calculateContrastRatio(fg: string, bg: string): number {
    const fgRgb = this.parseColor(fg);
    const bgRgb = this.parseColor(bg);

    const fgLum = this.getRelativeLuminance(fgRgb.r, fgRgb.g, fgRgb.b);
    const bgLum = this.getRelativeLuminance(bgRgb.r, bgRgb.g, bgRgb.b);

    const lighter = Math.max(fgLum, bgLum);
    const darker = Math.min(fgLum, bgLum);

    // WCAG contrast ratio formula: (L1 + 0.05) / (L2 + 0.05)
    const ratio = (lighter + 0.05) / (darker + 0.05);

    // NaN/Infinity防御
    if (!Number.isFinite(ratio)) {
      return 1;
    }

    return ratio;
  }

  /**
   * WCAG AA基準を満たすか判定
   * Check if meets WCAG AA criteria
   *
   * @param ratio - コントラスト比 / Contrast ratio
   * @param isLargeText - 大テキストか / Is large text (18pt+ or 14pt+ bold)
   * @returns AA合格 / Meets AA
   */
  meetsWcagAA(ratio: number, isLargeText: boolean): boolean {
    const threshold = isLargeText ? AA_LARGE_TEXT_RATIO : AA_NORMAL_TEXT_RATIO;
    return ratio >= threshold;
  }

  /**
   * WCAG AAA基準を満たすか判定
   * Check if meets WCAG AAA criteria
   *
   * @param ratio - コントラスト比 / Contrast ratio
   * @param isLargeText - 大テキストか / Is large text
   * @returns AAA合格 / Meets AAA
   */
  meetsWcagAAA(ratio: number, isLargeText: boolean): boolean {
    const threshold = isLargeText ? AAA_LARGE_TEXT_RATIO : AAA_NORMAL_TEXT_RATIO;
    return ratio >= threshold;
  }

  /**
   * AA基準を満たす代替前景色を提案
   * Suggest alternative foreground color that meets AA criteria
   *
   * 最小変更でAA達成する色を二分探索で算出。
   * Uses binary search to find the minimum change needed to meet AA.
   *
   * @param fgColor - 現在の前景色 / Current foreground color
   * @param bgColor - 背景色 / Background color
   * @param isLargeText - 大テキストか / Is large text
   * @returns 提案色（hex） / Suggested color (hex)
   */
  suggestAlternativeColor(fgColor: string, bgColor: string, isLargeText: boolean): string {
    const currentRatio = this.calculateContrastRatio(fgColor, bgColor);
    const threshold = isLargeText ? AA_LARGE_TEXT_RATIO : AA_NORMAL_TEXT_RATIO;

    // 既にAA基準を満たしている
    if (currentRatio >= threshold) {
      return fgColor;
    }

    const fgRgb = this.parseColor(fgColor);
    const bgRgb = this.parseColor(bgColor);
    const bgLum = this.getRelativeLuminance(bgRgb.r, bgRgb.g, bgRgb.b);

    // 背景が明るいなら前景を暗くする、暗いなら明るくする
    const darken = bgLum > 0.5;

    // 二分探索で最小変更量を見つける
    let low = 0;
    let high = 1;

    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2;
      const adjusted = darken
        ? this.adjustBrightness(fgRgb, -mid)
        : this.adjustBrightness(fgRgb, mid);
      const adjustedHex = this.rgbToHex(adjusted);
      const ratio = this.calculateContrastRatio(adjustedHex, bgColor);

      if (ratio >= threshold) {
        high = mid;
      } else {
        low = mid;
      }
    }

    const finalAdjusted = darken
      ? this.adjustBrightness(fgRgb, -high)
      : this.adjustBrightness(fgRgb, high);

    return this.rgbToHex(finalAdjusted);
  }

  /**
   * HTMLからテキスト要素のコントラストをチェック
   * Check contrast of text elements in HTML
   *
   * @param html - チェック対象HTML / HTML to check
   * @returns コントラストチェック結果 / Contrast check result
   */
  async checkHtmlContrast(html: string): Promise<ContrastCheckResult> {
    if (!html || html.trim() === "") {
      return { issues: [], totalElements: 0 };
    }

    try {
      const dom = new JSDOM(html, {
        runScripts: "outside-only",
        pretendToBeVisual: true,
      });
      const document = dom.window.document;

      // テキスト要素を取得
      const textSelectors = "p, h1, h2, h3, h4, h5, h6, span, a, li, td, th, label, button, div";
      const elements = document.querySelectorAll(textSelectors);
      const issues: ContrastIssue[] = [];
      let totalElements = 0;

      for (const el of elements) {
        const htmlEl = el as unknown as { style?: { color?: string; backgroundColor?: string } };

        // インラインスタイルから色を取得
        const fgColor = htmlEl.style?.color;
        const bgColor = htmlEl.style?.backgroundColor;

        // 色が明示的に設定されている要素のみチェック
        if (fgColor && bgColor) {
          totalElements++;
          const ratio = this.calculateContrastRatio(fgColor, bgColor);
          const isLargeText = this.isLargeTextElement(el.tagName);
          const meetsAA = this.meetsWcagAA(ratio, isLargeText);

          const issue: ContrastIssue = {
            element: el.tagName.toLowerCase(),
            fgColor,
            bgColor,
            ratio: Math.round(ratio * 100) / 100,
            meetsAA,
            isLargeText,
          };

          if (!meetsAA) {
            issue.suggestedColor = this.suggestAlternativeColor(fgColor, bgColor, isLargeText);
          }

          // 不合格の問題のみ含める（合格はフィルタ）
          if (!meetsAA) {
            issues.push(issue);
          }
        } else if (fgColor) {
          // 前景色のみの場合、親の背景色を推定
          totalElements++;
        }
      }

      dom.window.close();

      return { issues, totalElements };
    } catch (error) {
      logger.warn("[ContrastCheckService] HTML contrast check error", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return { issues: [], totalElements: 0 };
    }
  }

  /**
   * sRGB相対輝度を計算
   * Calculate sRGB relative luminance
   *
   * WCAG 2.1 準拠: https://www.w3.org/WAI/GL/wiki/Relative_luminance
   *
   * @param r - 赤 (0-255)
   * @param g - 緑 (0-255)
   * @param b - 青 (0-255)
   * @returns 相対輝度 (0-1) / Relative luminance
   */
  getRelativeLuminance(r: number, g: number, b: number): number {
    // NaN防御
    const safeR = Number.isFinite(r) ? r : 0;
    const safeG = Number.isFinite(g) ? g : 0;
    const safeB = Number.isFinite(b) ? b : 0;

    const rLinear = this.srgbToLinear(safeR / 255);
    const gLinear = this.srgbToLinear(safeG / 255);
    const bLinear = this.srgbToLinear(safeB / 255);

    const luminance = 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;

    // NaN/Infinity防御
    if (!Number.isFinite(luminance)) {
      return 0;
    }

    return luminance;
  }

  /**
   * 色文字列をRGBにパース
   * Parse color string to RGB
   *
   * サポート形式: hex6, hex3, rgb(), rgba(), named colors
   * Supported formats: hex6, hex3, rgb(), rgba(), named colors
   *
   * @param color - 色文字列 / Color string
   * @returns RGB値 / RGB values
   */
  parseColor(color: string): RGB {
    if (!color || typeof color !== "string") {
      return { r: 0, g: 0, b: 0 };
    }

    const trimmed = color.trim().toLowerCase();

    // Named colors
    if (trimmed in NAMED_COLORS) {
      return { ...NAMED_COLORS[trimmed]! };
    }

    // Hex 6桁: #rrggbb
    const hex6Match = trimmed.match(/^#([0-9a-f]{6})$/);
    if (hex6Match) {
      const hex = hex6Match[1]!;
      return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16),
      };
    }

    // Hex 3桁: #rgb
    const hex3Match = trimmed.match(/^#([0-9a-f]{3})$/);
    if (hex3Match) {
      const hex = hex3Match[1]!;
      return {
        r: parseInt(hex[0]! + hex[0]!, 16),
        g: parseInt(hex[1]! + hex[1]!, 16),
        b: parseInt(hex[2]! + hex[2]!, 16),
      };
    }

    // rgb(r, g, b) or rgba(r, g, b, a)
    const rgbMatch = trimmed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
      return {
        r: Math.min(255, Math.max(0, parseInt(rgbMatch[1]!, 10))),
        g: Math.min(255, Math.max(0, parseInt(rgbMatch[2]!, 10))),
        b: Math.min(255, Math.max(0, parseInt(rgbMatch[3]!, 10))),
      };
    }

    // 未知の形式: デフォルト黒
    return { r: 0, g: 0, b: 0 };
  }

  // =====================================================
  // プライベートメソッド / Private Methods
  // =====================================================

  /**
   * sRGBガンマデコード（線形化）
   * sRGB gamma decode (linearize)
   */
  private srgbToLinear(value: number): number {
    if (value <= 0.04045) {
      return value / 12.92;
    }
    return Math.pow((value + 0.055) / 1.055, 2.4);
  }

  /**
   * 明度を調整
   * Adjust brightness
   *
   * @param rgb - 元のRGB / Original RGB
   * @param amount - 調整量 (-1 ~ 1) / Adjustment amount
   * @returns 調整後RGB / Adjusted RGB
   */
  private adjustBrightness(rgb: RGB, amount: number): RGB {
    if (amount > 0) {
      // 明るくする
      return {
        r: Math.min(255, Math.round(rgb.r + (255 - rgb.r) * amount)),
        g: Math.min(255, Math.round(rgb.g + (255 - rgb.g) * amount)),
        b: Math.min(255, Math.round(rgb.b + (255 - rgb.b) * amount)),
      };
    } else {
      // 暗くする
      const factor = 1 + amount;
      return {
        r: Math.max(0, Math.round(rgb.r * factor)),
        g: Math.max(0, Math.round(rgb.g * factor)),
        b: Math.max(0, Math.round(rgb.b * factor)),
      };
    }
  }

  /**
   * RGBをhex文字列に変換
   * Convert RGB to hex string
   */
  private rgbToHex(rgb: RGB): string {
    const r = Math.max(0, Math.min(255, rgb.r));
    const g = Math.max(0, Math.min(255, rgb.g));
    const b = Math.max(0, Math.min(255, rgb.b));
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  /**
   * 大テキスト要素かどうかを判定（簡易版）
   * Check if element is large text (simplified)
   *
   * h1-h3 は大テキストとみなす / h1-h3 are considered large text
   */
  private isLargeTextElement(tagName: string): boolean {
    const largeTextTags = ["H1", "H2", "H3"];
    return largeTextTags.includes(tagName.toUpperCase());
  }
}

// =====================================================
// ファクトリ関数 / Factory Function
// =====================================================

/**
 * ContrastCheckServiceのファクトリ関数
 */
export function createContrastCheckService(): ContrastCheckService {
  return new ContrastCheckService();
}
