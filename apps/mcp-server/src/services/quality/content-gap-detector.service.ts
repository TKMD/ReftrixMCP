// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ContentGapDetectorService
 *
 * HTMLコンテンツ要素のギャップ（不足）を検出するサービス
 *
 * 機能:
 * - コンテンツ要素カウント（img, svg, video, canvas, picture, icon fonts, CSS background-image）
 * - セクション別密度計算
 * - ギャップ検出（critical / high / medium / low）
 * - ギャップベースのスコア計算（0-100）
 *
 * @module services/quality/content-gap-detector.service
 */

import { JSDOM } from 'jsdom';
import { isDevelopment, logger } from '../../utils/logger';

// =====================================================
// Types
// =====================================================

/**
 * コンテンツギャップ情報
 */
export interface ContentGap {
  /** ギャップ対象の要素タイプ */
  type: 'image' | 'svg' | 'icon' | 'video' | 'background';
  /** 重要度 */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** ギャップの説明メッセージ */
  message: string;
  /** 現在の要素数 */
  count: number;
  /** 期待される最小数 */
  expectedMin: number;
}

/**
 * コンテンツギャップ検出結果
 */
export interface ContentGapResult {
  /** 画像タグ数（装飾的alt=""を除く） */
  totalImages: number;
  /** インラインSVG数 */
  totalSvgs: number;
  /** アイコン要素数（アイコンフォント含む） */
  totalIcons: number;
  /** ビデオ/キャンバス要素数 */
  totalVideos: number;
  /** CSSのbackground-image数 */
  totalBackgroundImages: number;
  /** セクション数 */
  sectionCount: number;
  /** コンテンツ密度（総コンテンツ要素 / セクション数） */
  contentDensity: number;
  /** 検出されたギャップ配列 */
  gaps: ContentGap[];
  /** ギャップベーススコア（0-100） */
  score: number;
  /** 詳細説明配列 */
  details: string[];
}

/**
 * ContentGapDetectorServiceのインターフェース
 */
export interface IContentGapDetectorService {
  detect(html: string, css?: string): ContentGapResult;
}

// =====================================================
// 正規表現パターン
// =====================================================

/** CSS background-image: url() 検出用正規表現 */
const BG_IMAGE_REGEX = /background(-image)?\s*:\s*[^;]*url\s*\(/gi;

/** inline style 内の background-image 検出用正規表現 */
const INLINE_STYLE_BG_REGEX = /style\s*=\s*["'][^"']*background(-image)?\s*:\s*[^"']*url\s*\([^"']*/gi;

// =====================================================
// サービス実装
// =====================================================

/**
 * ContentGapDetectorService
 *
 * HTML+CSSからコンテンツ要素のギャップを検出し、
 * スコアと改善提案を返す
 *
 * @example
 * ```typescript
 * const service = getContentGapDetectorService();
 * const result = service.detect('<html>...</html>', 'body { background-image: url(...) }');
 * console.log(result.score); // 0-100
 * console.log(result.gaps);  // ContentGap[]
 * ```
 */
export class ContentGapDetectorService implements IContentGapDetectorService {
  /**
   * HTML+CSSからコンテンツギャップを検出
   *
   * @param html - 分析対象のHTML文字列
   * @param css - 外部CSS文字列（オプション）
   * @returns コンテンツギャップ検出結果
   */
  detect(html: string, css?: string): ContentGapResult {
    if (!html || html.trim() === '') {
      return this.createEmptyResult();
    }

    if (isDevelopment()) {
      logger.info('[ContentGapDetector] Starting detection', {
        htmlLength: html.length,
        cssLength: css?.length ?? 0,
      });
    }

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // コンテンツ要素カウント
    const totalImages = this.countImages(doc);
    const totalSvgs = this.countSvgs(doc);
    const totalIcons = this.countIcons(doc);
    const totalVideos = this.countVideos(doc);
    const totalBackgroundImages = this.countBackgroundImages(html, css);

    // セクション検出
    const sectionCount = this.countSections(doc);

    // コンテンツ密度計算
    const totalContentElements =
      totalImages + totalSvgs + totalIcons + totalVideos + totalBackgroundImages;
    const effectiveSectionCount = Math.max(1, sectionCount);
    const contentDensity = totalContentElements / effectiveSectionCount;

    // ギャップ検出
    const gaps = this.detectGaps({
      totalImages,
      totalSvgs,
      totalIcons,
      totalVideos,
      totalBackgroundImages,
      sectionCount: effectiveSectionCount,
      contentDensity,
      totalContentElements,
    });

    // スコア計算
    const score = this.calculateScore(gaps, contentDensity);

    // 詳細情報生成
    const details = this.generateDetails({
      totalImages,
      totalSvgs,
      totalIcons,
      totalVideos,
      totalBackgroundImages,
      sectionCount,
      contentDensity,
      gaps,
    });

    // DOMクリーンアップ
    dom.window.close();

    const result: ContentGapResult = {
      totalImages,
      totalSvgs,
      totalIcons,
      totalVideos,
      totalBackgroundImages,
      sectionCount,
      contentDensity,
      gaps,
      score,
      details,
    };

    if (isDevelopment()) {
      logger.info('[ContentGapDetector] Detection completed', {
        score,
        gapCount: gaps.length,
        contentDensity: contentDensity.toFixed(2),
      });
    }

    return result;
  }

  // =====================================================
  // プライベートメソッド: 要素カウント
  // =====================================================

  /**
   * 実質的画像数をカウント（装飾的alt=""を除く）
   */
  private countImages(doc: Document): number {
    const allImages = doc.querySelectorAll('img');
    let count = 0;
    for (const img of allImages) {
      // alt="" は装飾的画像として除外
      if (img.getAttribute('alt') !== '') {
        count++;
      }
    }
    return count;
  }

  /**
   * インラインSVG数をカウント
   */
  private countSvgs(doc: Document): number {
    return doc.querySelectorAll('svg').length;
  }

  /**
   * アイコン要素数をカウント（アイコンフォント含む）
   */
  private countIcons(doc: Document): number {
    const iconSelectors = [
      '[class*="icon"]',
      '[class*="fa-"]',
      '[class*="material-icons"]',
    ];
    const selector = iconSelectors.join(', ');
    return doc.querySelectorAll(selector).length;
  }

  /**
   * ビデオ/キャンバス要素数をカウント
   */
  private countVideos(doc: Document): number {
    return doc.querySelectorAll('video, canvas').length;
  }

  /**
   * CSS background-image数をカウント（外部CSS + インラインstyle）
   */
  private countBackgroundImages(html: string, css?: string): number {
    let count = 0;

    // 外部CSS内のbackground-image
    if (css) {
      const cssMatches = css.match(BG_IMAGE_REGEX);
      count += cssMatches?.length ?? 0;
    }

    // HTML内のstyleタグのbackground-image
    const styleTagRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let styleMatch: RegExpExecArray | null;
    while ((styleMatch = styleTagRegex.exec(html)) !== null) {
      const styleContent = styleMatch[1] ?? '';
      const bgMatches = styleContent.match(BG_IMAGE_REGEX);
      count += bgMatches?.length ?? 0;
    }

    // インラインstyle属性内のbackground-image
    const inlineMatches = html.match(INLINE_STYLE_BG_REGEX);
    count += inlineMatches?.length ?? 0;

    return count;
  }

  /**
   * セクション数をカウント
   */
  private countSections(doc: Document): number {
    return doc.querySelectorAll(
      'section, article, [role="region"], [role="main"]'
    ).length;
  }

  // =====================================================
  // プライベートメソッド: ギャップ検出
  // =====================================================

  /**
   * ギャップ検出ロジック
   */
  private detectGaps(params: {
    totalImages: number;
    totalSvgs: number;
    totalIcons: number;
    totalVideos: number;
    totalBackgroundImages: number;
    sectionCount: number;
    contentDensity: number;
    totalContentElements: number;
  }): ContentGap[] {
    const gaps: ContentGap[] = [];

    // 画像0枚 → critical
    if (params.totalImages === 0) {
      gaps.push({
        type: 'image',
        severity: 'critical',
        message:
          'No content images found. Professional websites typically include product photos, illustrations, or hero images.',
        count: 0,
        expectedMin: Math.max(1, Math.floor(params.sectionCount * 0.3)),
      });
    }

    // SVG/アイコン0個 → high
    if (params.totalSvgs === 0 && params.totalIcons === 0) {
      gaps.push({
        type: 'icon',
        severity: 'high',
        message:
          'No SVG icons or icon fonts found. Icons improve visual communication and scannability.',
        count: 0,
        expectedMin: Math.max(2, Math.floor(params.sectionCount * 0.5)),
      });
    }

    // コンテンツ密度 < 0.5 → medium
    if (params.contentDensity < 0.5) {
      gaps.push({
        type: 'image',
        severity: 'medium',
        message: `Low content density: ${params.contentDensity.toFixed(2)} visual elements per section. Target: >= 1.0`,
        count: params.totalContentElements,
        expectedMin: params.sectionCount,
      });
    }

    // background-image 0個 → low
    if (params.totalBackgroundImages === 0) {
      gaps.push({
        type: 'background',
        severity: 'low',
        message:
          'No CSS background images found. Background imagery adds visual depth.',
        count: 0,
        expectedMin: 1,
      });
    }

    return gaps;
  }

  // =====================================================
  // プライベートメソッド: スコア計算
  // =====================================================

  /**
   * ギャップベースのスコア計算
   *
   * 基本スコア100から、ギャップの重要度に応じてペナルティを適用
   * 密度ボーナスで加算
   */
  private calculateScore(gaps: ContentGap[], contentDensity: number): number {
    let score = 100;

    // ギャップペナルティ
    for (const gap of gaps) {
      switch (gap.severity) {
        case 'critical':
          score -= 30;
          break;
        case 'high':
          score -= 20;
          break;
        case 'medium':
          score -= 10;
          break;
        case 'low':
          score -= 5;
          break;
      }
    }

    // 密度ボーナス
    if (contentDensity >= 2.0) {
      score = Math.min(100, score + 10);
    } else if (contentDensity >= 1.0) {
      score = Math.min(100, score + 5);
    }

    return Math.max(0, Math.min(100, score));
  }

  // =====================================================
  // プライベートメソッド: 詳細生成
  // =====================================================

  /**
   * 分析詳細情報を生成
   */
  private generateDetails(params: {
    totalImages: number;
    totalSvgs: number;
    totalIcons: number;
    totalVideos: number;
    totalBackgroundImages: number;
    sectionCount: number;
    contentDensity: number;
    gaps: ContentGap[];
  }): string[] {
    const details: string[] = [];

    details.push(`Content images: ${params.totalImages}`);
    details.push(`Inline SVGs: ${params.totalSvgs}`);
    details.push(`Icon elements: ${params.totalIcons}`);
    details.push(`Video/Canvas elements: ${params.totalVideos}`);
    details.push(`CSS background images: ${params.totalBackgroundImages}`);
    details.push(`Sections detected: ${params.sectionCount}`);
    details.push(`Content density: ${params.contentDensity.toFixed(2)} elements/section`);

    if (params.gaps.length > 0) {
      details.push(`Gaps found: ${params.gaps.length}`);
      for (const gap of params.gaps) {
        details.push(`  [${gap.severity.toUpperCase()}] ${gap.type}: ${gap.message}`);
      }
    } else {
      details.push('No content gaps detected.');
    }

    return details;
  }

  // =====================================================
  // プライベートメソッド: 空結果
  // =====================================================

  /**
   * 空の結果を作成
   */
  private createEmptyResult(): ContentGapResult {
    return {
      totalImages: 0,
      totalSvgs: 0,
      totalIcons: 0,
      totalVideos: 0,
      totalBackgroundImages: 0,
      sectionCount: 0,
      contentDensity: 0,
      gaps: [],
      score: 0,
      details: ['Empty HTML provided. No content to analyze.'],
    };
  }
}

// =====================================================
// DI ファクトリ関数
// =====================================================

/**
 * ContentGapDetectorServiceのファクトリ関数
 * テスト時にモック差し替え可能
 */
let contentGapDetectorServiceFactory: (() => IContentGapDetectorService) | null = null;

/**
 * ファクトリ関数を設定（DI用）
 *
 * @param factory - IContentGapDetectorServiceを返すファクトリ関数
 */
export function setContentGapDetectorServiceFactory(
  factory: () => IContentGapDetectorService
): void {
  contentGapDetectorServiceFactory = factory;
}

/**
 * ファクトリ関数をリセット（テスト用）
 */
export function resetContentGapDetectorServiceFactory(): void {
  contentGapDetectorServiceFactory = null;
}

/**
 * ContentGapDetectorServiceインスタンスを取得
 *
 * ファクトリが設定されていればそれを使用し、
 * なければデフォルトインスタンスを生成
 *
 * @returns IContentGapDetectorServiceインスタンス
 */
export function getContentGapDetectorService(): IContentGapDetectorService {
  if (contentGapDetectorServiceFactory) {
    return contentGapDetectorServiceFactory();
  }
  return new ContentGapDetectorService();
}
