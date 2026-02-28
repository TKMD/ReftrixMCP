// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TextRepresentationGenerator
 *
 * Embedding用のテキスト表現を生成するサービス
 * セクション配列からセマンティック検索に適したテキストを生成する
 *
 * @module @reftrix/webdesign-core/text-representation
 */

import type {
  DetectedSection,
  SectionType,
} from '../types/section.types';

// =========================================
// Types
// =========================================

/**
 * 色情報（LayoutInspect結果から）
 */
export interface ColorInfo {
  palette: Array<{ hex: string; count: number; role?: string }>;
  dominant: string;
  background: string;
  text: string;
  accent?: string;
}

/**
 * タイポグラフィ情報（LayoutInspect結果から）
 */
export interface TypographyInfo {
  fonts: Array<{ family: string; weights: number[] }>;
  headingScale: number[];
  bodySize: number;
  lineHeight: number;
}

/**
 * グリッド情報（LayoutInspect結果から）
 */
export interface GridInfo {
  type: 'flex' | 'grid' | 'float' | 'unknown';
  columns?: number;
  gutterWidth?: number;
  maxWidth?: number;
  breakpoints?: Array<{ name: string; minWidth: number }>;
}

/**
 * LayoutInspect結果（オプショナル）
 */
export interface LayoutInspectOutput {
  colors?: ColorInfo;
  typography?: TypographyInfo;
  grid?: GridInfo;
}

/**
 * TextRepresentationGenerator オプション
 */
export interface TextRepresentationOptions {
  /** 最大文字数（デフォルト: 2000） */
  maxLength?: number;
  /** 色情報を含める */
  includeColors?: boolean;
  /** タイポグラフィ情報を含める */
  includeTypography?: boolean;
  /** グリッド情報を含める */
  includeGrid?: boolean;
  /** 出力言語 */
  language?: 'en' | 'ja';
  /** フォーマット: 自然言語 or 構造化 */
  format?: 'natural' | 'structured';
}

/**
 * TextRepresentationGenerator 結果
 */
export interface TextRepresentationResult {
  /** 生成されたテキスト */
  text: string;
  /** セクションごとのテキスト */
  sections: string[];
  /** メタデータ */
  metadata: {
    totalLength: number;
    sectionCount: number;
    language: string;
  };
}

// =========================================
// Constants - Section Type Labels
// =========================================

const SECTION_LABELS_EN: Record<SectionType, string> = {
  hero: 'Hero section',
  feature: 'Feature section',
  cta: 'Call-to-action section',
  testimonial: 'Testimonial section',
  pricing: 'Pricing section',
  footer: 'Footer',
  navigation: 'Navigation',
  about: 'About section',
  contact: 'Contact section',
  gallery: 'Gallery section',
  unknown: 'Content section',
  // 拡張タイプ
  partners: 'Partners section',
  portfolio: 'Portfolio section',
  team: 'Team section',
  stories: 'Stories section',
  research: 'Research section',
  subscribe: 'Subscribe section',
  stats: 'Stats section',
  faq: 'FAQ section',
};

const SECTION_LABELS_JA: Record<SectionType, string> = {
  hero: 'ヒーローセクション',
  feature: 'フィーチャーセクション',
  cta: 'CTAセクション',
  testimonial: 'お客様の声セクション',
  pricing: '料金プランセクション',
  footer: 'フッター',
  navigation: 'ナビゲーション',
  about: '会社概要セクション',
  contact: 'お問い合わせセクション',
  gallery: 'ギャラリーセクション',
  unknown: 'コンテンツセクション',
  // 拡張タイプ
  partners: 'パートナーセクション',
  portfolio: 'ポートフォリオセクション',
  team: 'チームセクション',
  stories: 'ストーリーセクション',
  research: 'リサーチセクション',
  subscribe: '購読セクション',
  stats: '統計セクション',
  faq: 'よくある質問セクション',
};

// =========================================
// TextRepresentationGenerator Class
// =========================================

/**
 * TextRepresentationGenerator クラス
 *
 * Embedding用のテキスト表現を生成する
 */
export class TextRepresentationGenerator {
  private options: Required<TextRepresentationOptions>;

  constructor(options: TextRepresentationOptions = {}) {
    this.options = {
      maxLength: options.maxLength ?? 2000,
      includeColors: options.includeColors ?? true,
      includeTypography: options.includeTypography ?? true,
      includeGrid: options.includeGrid ?? true,
      language: options.language ?? 'en',
      format: options.format ?? 'natural',
    };
  }

  /**
   * セクション配列からテキスト生成
   */
  generate(
    sections: DetectedSection[],
    inspectResult?: LayoutInspectOutput
  ): TextRepresentationResult {
    if (sections.length === 0) {
      return {
        text: '',
        sections: [],
        metadata: {
          totalLength: 0,
          sectionCount: 0,
          language: this.options.language,
        },
      };
    }

    const sectionTexts: string[] = [];

    // Generate text for each section
    for (const section of sections) {
      const sectionText = this.generateForSection(section);
      sectionTexts.push(sectionText);
    }

    // Build full text
    let fullText: string;
    if (this.options.format === 'structured') {
      fullText = this.buildStructuredText(sections, sectionTexts, inspectResult);
    } else {
      fullText = this.buildNaturalText(sections, sectionTexts, inspectResult);
    }

    // Truncate if necessary
    if (fullText.length > this.options.maxLength) {
      fullText = this.truncateText(fullText, this.options.maxLength);
    }

    return {
      text: fullText,
      sections: sectionTexts,
      metadata: {
        totalLength: fullText.length,
        sectionCount: sections.length,
        language: this.options.language,
      },
    };
  }

  /**
   * 単一セクションのテキスト生成
   */
  generateForSection(section: DetectedSection): string {
    if (this.options.format === 'structured') {
      return this.generateStructuredSection(section);
    }
    return this.generateNaturalSection(section);
  }

  /**
   * 色情報のテキスト生成
   */
  generateColorDescription(colors: ColorInfo): string {
    if (this.options.format === 'structured') {
      const parts = [`primary:${colors.dominant}`, `background:${colors.background}`, `text:${colors.text}`];
      if (colors.accent) {
        parts.push(`accent:${colors.accent}`);
      }
      return `[COLORS] ${parts.join(' ')}`;
    }

    // Natural format
    if (this.options.language === 'ja') {
      let desc = `カラーパレット: プライマリー ${colors.dominant}、背景 ${colors.background}、テキスト ${colors.text}`;
      if (colors.accent) {
        desc += `、アクセント ${colors.accent}`;
      }
      return desc + '。';
    }

    let desc = `Color palette: Primary ${colors.dominant}, background ${colors.background}, text ${colors.text}`;
    if (colors.accent) {
      desc += `, accent ${colors.accent}`;
    }
    return desc + '.';
  }

  /**
   * タイポグラフィ情報のテキスト生成
   */
  generateTypographyDescription(typography: TypographyInfo): string {
    const fontFamilies = typography.fonts.map((f) => f.family).join(', ');
    const weights = typography.fonts.flatMap((f) => f.weights);
    const uniqueWeights = [...new Set(weights)].sort((a, b) => a - b);
    const headingSizes = typography.headingScale.join(', ');

    if (this.options.format === 'structured') {
      return `[TYPOGRAPHY] family:${fontFamilies} sizes:${headingSizes} weights:${uniqueWeights.join(',')} bodySize:${typography.bodySize}px lineHeight:${typography.lineHeight}`;
    }

    // Natural format
    const weightsStr = uniqueWeights.length > 0 ? uniqueWeights.join(', ') : '400';
    if (this.options.language === 'ja') {
      return `タイポグラフィ: ${fontFamilies}フォント、ウェイト ${weightsStr}、見出しサイズ ${headingSizes}px、本文 ${typography.bodySize}px、行間 ${typography.lineHeight}。`;
    }

    return `Typography: ${fontFamilies} font family, weights ${weightsStr}, heading sizes from ${typography.headingScale[0] || 48}px to ${typography.headingScale[typography.headingScale.length - 1] || 16}px, body ${typography.bodySize}px, line-height ${typography.lineHeight}.`;
  }

  /**
   * グリッド情報のテキスト生成
   */
  generateGridDescription(grid: GridInfo): string {
    if (this.options.format === 'structured') {
      const parts = [`type:${grid.type}`];
      if (grid.columns) parts.push(`columns:${grid.columns}`);
      if (grid.gutterWidth) parts.push(`gutter:${grid.gutterWidth}px`);
      if (grid.maxWidth) parts.push(`maxWidth:${grid.maxWidth}px`);
      return `[GRID] ${parts.join(' ')}`;
    }

    // Natural format
    if (this.options.language === 'ja') {
      let desc = `レイアウト: ${grid.type}`;
      if (grid.columns) desc += `、${grid.columns}カラム`;
      if (grid.gutterWidth) desc += `、ガター ${grid.gutterWidth}px`;
      if (grid.maxWidth) desc += `、最大幅 ${grid.maxWidth}px`;
      return desc + '。';
    }

    let desc = `Layout: ${grid.type}`;
    if (grid.columns) desc += ` with ${grid.columns} columns`;
    if (grid.gutterWidth) desc += `, ${grid.gutterWidth}px gutters`;
    if (grid.maxWidth) desc += `, max-width ${grid.maxWidth}px`;
    return desc + '.';
  }

  // =========================================
  // Private Methods - Natural Format
  // =========================================

  private generateNaturalSection(section: DetectedSection): string {
    const label = this.options.language === 'ja'
      ? SECTION_LABELS_JA[section.type]
      : SECTION_LABELS_EN[section.type];

    const parts: string[] = [];
    const { style, position } = section;

    // Position description
    const positionDesc = this.getPositionDescription(position.startY);

    // Build section description
    if (this.options.language === 'ja') {
      parts.push(this.buildJapaneseDescription(section, label, positionDesc));
    } else {
      parts.push(this.buildEnglishDescription(section, label, positionDesc));
    }

    // Style information
    if (style.hasGradient) {
      parts.push(
        this.options.language === 'ja'
          ? 'グラデーション背景。'
          : 'Features a gradient background.'
      );
    }

    return parts.join(' ');
  }

  private buildEnglishDescription(
    section: DetectedSection,
    label: string,
    positionDesc: string
  ): string {
    const { content, type, style, position } = section;
    const parts: string[] = [];

    // Main heading
    const mainHeading = content.headings[0];
    if (mainHeading) {
      parts.push(`${label} ${positionDesc} with heading "${mainHeading.text}"`);
    } else {
      parts.push(`${label} ${positionDesc}`);
    }

    // Buttons
    if (content.buttons.length > 0) {
      const buttonTexts = content.buttons.map((b) => `"${b.text}"`).join(' and ');
      if (content.buttons.length === 1) {
        parts.push(`and a CTA button ${buttonTexts}`);
      } else {
        parts.push(`with ${content.buttons.length} buttons: ${buttonTexts}`);
      }
    }

    // Images - enhanced for incomplete sections
    if (content.images.length > 0 && type !== 'navigation') {
      if (type === 'gallery') {
        parts.push(`containing ${content.images.length} images`);
      } else if (type === 'feature') {
        parts.push(`with icons`);
      } else {
        // Fallback: include image count for other section types
        parts.push(`with ${content.images.length} images`);
      }

      // Include alt texts for semantic meaning (for incomplete sections)
      const altTexts = content.images
        .map((img) => img.alt)
        .filter((alt) => alt && alt.trim().length > 0);
      if (altTexts.length > 0 && !mainHeading) {
        const altDescription = altTexts.slice(0, 3).join(', ');
        parts.push(`showing ${altDescription}`);
      }
    }

    // Links - enhanced for navigation and other sections
    if (content.links.length > 0) {
      if (type === 'navigation') {
        parts.push(`with ${content.links.length} navigation links`);
        // Include link texts for semantic meaning
        const linkTexts = content.links
          .map((link) => link.text)
          .filter((text) => text && text.trim().length > 0);
        if (linkTexts.length > 0 && !mainHeading) {
          const linkDescription = linkTexts.slice(0, 4).join(', ');
          parts.push(`including ${linkDescription}`);
        }
      } else if (!mainHeading) {
        // Fallback: include link info for other section types
        parts.push(`with ${content.links.length} links`);
        const linkTexts = content.links
          .map((link) => link.text)
          .filter((text) => text && text.trim().length > 0);
        if (linkTexts.length > 0) {
          parts.push(`"${linkTexts[0]}"`);
        }
      }
    }

    // Feature items
    if (type === 'feature' && content.headings.length > 1) {
      const itemCount = content.headings.length - 1;
      parts.push(`showcasing ${itemCount} feature items`);
    }

    // Fallback: include style and position info for incomplete sections
    const hasContent = mainHeading || content.buttons.length > 0;
    if (!hasContent) {
      // Add style fallback
      if (style.hasGradient) {
        parts.push(`with gradient background`);
      } else if (style.backgroundColor) {
        const isDark = this.isColorDark(style.backgroundColor);
        parts.push(`with ${isDark ? 'dark' : 'light'} background`);
      }

      // Add position/height fallback
      if (position.height > 0) {
        parts.push(`spanning ${position.height} pixels in height`);
      }
    }

    // Ensure minimum content for embedding quality
    const result = parts.join(' ') + '.';
    if (result.length < 50 && !hasContent) {
      // Add section type description as fallback
      const typeDescription = this.getEnglishSectionTypeDescription(type);
      return `${label} ${positionDesc}. ${typeDescription}`;
    }

    return result;
  }

  private getEnglishSectionTypeDescription(type: SectionType): string {
    const descriptions: Record<SectionType, string> = {
      hero: 'A prominent banner section typically at the top of the page showcasing the main message.',
      feature: 'A section highlighting key features or capabilities of the product or service.',
      cta: 'A call-to-action section designed to encourage user engagement.',
      testimonial: 'A section displaying customer reviews and testimonials.',
      pricing: 'A section presenting pricing plans and subscription options.',
      footer: 'The bottom section containing site-wide links and information.',
      navigation: 'A navigation bar providing links to main site sections.',
      about: 'An about section describing the company or product.',
      contact: 'A contact section with ways to reach out.',
      gallery: 'A gallery section displaying visual content.',
      unknown: 'A content section with general information.',
      partners: 'A section showcasing partner logos and collaborations.',
      portfolio: 'A portfolio section displaying work samples.',
      team: 'A team section introducing team members.',
      stories: 'A stories section featuring articles or case studies.',
      research: 'A research section presenting studies and findings.',
      subscribe: 'A subscription section for newsletter sign-ups.',
      stats: 'A statistics section displaying key metrics.',
      faq: 'A frequently asked questions section.',
    };
    return descriptions[type] || descriptions.unknown;
  }

  private isColorDark(color: string): boolean {
    // Simple dark color detection based on hex value
    if (!color || !color.startsWith('#')) return false;
    const hex = color.replace('#', '');
    if (hex.length !== 6) return false;
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    // Use relative luminance formula
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.5;
  }

  private buildJapaneseDescription(
    section: DetectedSection,
    label: string,
    positionDesc: string
  ): string {
    const { content, type, style, position } = section;
    const parts: string[] = [];

    // Main heading
    const mainHeading = content.headings[0];
    if (mainHeading) {
      parts.push(`${positionDesc}の${label}。見出し「${mainHeading.text}」`);
    } else {
      parts.push(`${positionDesc}の${label}`);
    }

    // Buttons
    if (content.buttons.length > 0) {
      const buttonTexts = content.buttons.map((b) => `「${b.text}」`).join('と');
      parts.push(`CTAボタン${buttonTexts}`);
    }

    // Images - enhanced for incomplete sections
    if (content.images.length > 0 && type !== 'navigation') {
      if (type === 'gallery') {
        parts.push(`${content.images.length}枚の画像を含む`);
      } else if (type === 'feature') {
        parts.push(`アイコン付き`);
      } else {
        // Fallback: include image count for other section types
        parts.push(`${content.images.length}枚の画像を含む`);
      }

      // Include alt texts for semantic meaning (for incomplete sections)
      const altTexts = content.images
        .map((img) => img.alt)
        .filter((alt) => alt && alt.trim().length > 0);
      if (altTexts.length > 0 && !mainHeading) {
        const altDescription = altTexts.slice(0, 3).join('、');
        parts.push(`内容: ${altDescription}`);
      }
    }

    // Links - enhanced for navigation and other sections
    if (content.links.length > 0) {
      if (type === 'navigation') {
        parts.push(`${content.links.length}個のナビゲーションリンク`);
        // Include link texts for semantic meaning
        const linkTexts = content.links
          .map((link) => link.text)
          .filter((text) => text && text.trim().length > 0);
        if (linkTexts.length > 0 && !mainHeading) {
          const linkDescription = linkTexts.slice(0, 4).join('、');
          parts.push(`リンク先: ${linkDescription}`);
        }
      } else if (!mainHeading) {
        // Fallback: include link info for other section types
        parts.push(`${content.links.length}個のリンク`);
        const linkTexts = content.links
          .map((link) => link.text)
          .filter((text) => text && text.trim().length > 0);
        if (linkTexts.length > 0) {
          parts.push(`「${linkTexts[0]}」`);
        }
      }
    }

    // Fallback: include style and position info for incomplete sections
    const hasContent = mainHeading || content.buttons.length > 0;
    if (!hasContent) {
      // Add style fallback
      if (style.hasGradient) {
        parts.push(`グラデーション背景`);
      } else if (style.backgroundColor) {
        const isDark = this.isColorDark(style.backgroundColor);
        parts.push(`${isDark ? 'ダーク' : 'ライト'}背景`);
      }

      // Add position/height fallback
      if (position.height > 0) {
        parts.push(`高さ${position.height}ピクセル`);
      }
    }

    // Ensure minimum content for embedding quality
    const result = parts.join('、') + '。';
    if (result.length < 50 && !hasContent) {
      // Add section type description as fallback
      const typeDescription = this.getJapaneseSectionTypeDescription(type);
      return `${positionDesc}の${label}。${typeDescription}`;
    }

    return result;
  }

  private getJapaneseSectionTypeDescription(type: SectionType): string {
    const descriptions: Record<SectionType, string> = {
      hero: 'ページ上部に配置される主要なメッセージを表示するバナーセクション。',
      feature: '製品やサービスの主要な機能を紹介するセクション。',
      cta: 'ユーザーのアクションを促すコールトゥアクションセクション。',
      testimonial: 'お客様のレビューや声を表示するセクション。',
      pricing: '料金プランやサブスクリプションオプションを表示するセクション。',
      footer: 'サイト全体のリンクや情報を含むページ下部のセクション。',
      navigation: 'サイトの主要セクションへのリンクを提供するナビゲーションバー。',
      about: '会社や製品について説明するセクション。',
      contact: '連絡先情報を含むセクション。',
      gallery: 'ビジュアルコンテンツを表示するギャラリーセクション。',
      unknown: '一般的な情報を含むコンテンツセクション。',
      partners: 'パートナーロゴやコラボレーションを紹介するセクション。',
      portfolio: '作品サンプルを表示するポートフォリオセクション。',
      team: 'チームメンバーを紹介するセクション。',
      stories: '記事やケーススタディを紹介するセクション。',
      research: '研究や調査結果を表示するセクション。',
      subscribe: 'ニュースレター登録のための購読セクション。',
      stats: '主要な指標を表示する統計セクション。',
      faq: 'よくある質問と回答のセクション。',
    };
    return descriptions[type] || descriptions.unknown;
  }

  private getPositionDescription(startY: number): string {
    if (startY <= 100) {
      return this.options.language === 'ja' ? 'ページ上部' : 'at the top';
    }
    if (startY <= 600) {
      return this.options.language === 'ja' ? 'ページ中央付近' : 'in the middle';
    }
    return this.options.language === 'ja' ? 'ページ下部' : 'near the bottom';
  }

  // =========================================
  // Private Methods - Structured Format
  // =========================================

  private generateStructuredSection(section: DetectedSection): string {
    const { type, content, style, position } = section;
    const parts: string[] = [];

    // Section tag
    parts.push(`[SECTION:${type}]`);

    // Position
    const posDesc = position.startY <= 100 ? 'top' : position.startY <= 600 ? 'middle' : 'bottom';
    parts.push(`position:${posDesc}`);

    // Heading
    const mainHeading = content.headings[0];
    if (mainHeading) {
      parts.push(`heading:"${mainHeading.text}"`);
    }

    // Buttons - enhanced with CTA text always shown
    if (content.buttons.length > 0) {
      parts.push(`buttons:${content.buttons.length}`);
      const ctaButton = content.buttons.find((b) => b.type === 'primary') || content.buttons[0];
      if (ctaButton) {
        parts.push(`cta:"${ctaButton.text}"`);
      }
    }

    // Images - enhanced with alt texts for fallback
    if (content.images.length > 0) {
      parts.push(`images:${content.images.length}`);
      // Include alt texts for semantic meaning (for incomplete sections)
      const altTexts = content.images
        .map((img) => img.alt)
        .filter((alt) => alt && alt.trim().length > 0);
      if (altTexts.length > 0 && !mainHeading) {
        parts.push(`alt:"${altTexts.slice(0, 2).join(', ')}"`);
      }
    }

    // Links - enhanced with link texts for fallback
    if (content.links.length > 0) {
      parts.push(`links:${content.links.length}`);
      // Include link texts for semantic meaning (for incomplete sections)
      const linkTexts = content.links
        .map((link) => link.text)
        .filter((text) => text && text.trim().length > 0);
      if (linkTexts.length > 0 && !mainHeading) {
        parts.push(`navItems:"${linkTexts.slice(0, 3).join(', ')}"`);
      }
    }

    // Feature count (subheadings)
    if (type === 'feature' && content.headings.length > 1) {
      parts.push(`items:${content.headings.length - 1}`);
    }

    // Style - always include for incomplete sections
    if (style.hasGradient) {
      parts.push('style:gradient');
    } else if (style.backgroundColor) {
      parts.push(`style:bg(${style.backgroundColor})`);
    }

    // Height info for incomplete sections
    const hasContent = mainHeading || content.buttons.length > 0;
    if (!hasContent && position.height > 0) {
      parts.push(`height:${position.height}px`);
    }

    // Ensure minimum content - add type description as fallback
    const result = parts.join(' ');
    if (result.length < 50 && !hasContent) {
      const typeDesc = this.getStructuredTypeDescription(type);
      return `${result} desc:"${typeDesc}"`;
    }

    return result;
  }

  private getStructuredTypeDescription(type: SectionType): string {
    const descriptions: Record<SectionType, string> = {
      hero: 'Main banner with key message',
      feature: 'Feature highlights section',
      cta: 'Action-encouraging section',
      testimonial: 'Customer reviews display',
      pricing: 'Pricing plans section',
      footer: 'Site-wide links section',
      navigation: 'Navigation bar',
      about: 'Company information',
      contact: 'Contact information',
      gallery: 'Visual content display',
      unknown: 'Content section',
      partners: 'Partner showcase',
      portfolio: 'Work samples display',
      team: 'Team introduction',
      stories: 'Articles section',
      research: 'Research findings',
      subscribe: 'Newsletter signup',
      stats: 'Key metrics display',
      faq: 'FAQ section',
    };
    return descriptions[type] || descriptions.unknown;
  }

  // =========================================
  // Private Methods - Text Building
  // =========================================

  private buildNaturalText(
    _sections: DetectedSection[],
    sectionTexts: string[],
    inspectResult?: LayoutInspectOutput
  ): string {
    const parts: string[] = [];

    // Section descriptions
    parts.push(...sectionTexts);

    // Additional metadata
    if (inspectResult) {
      if (this.options.includeColors && inspectResult.colors) {
        parts.push(this.generateColorDescription(inspectResult.colors));
      }
      if (this.options.includeTypography && inspectResult.typography) {
        parts.push(this.generateTypographyDescription(inspectResult.typography));
      }
      if (this.options.includeGrid && inspectResult.grid) {
        parts.push(this.generateGridDescription(inspectResult.grid));
      }
    }

    return parts.join(' ');
  }

  private buildStructuredText(
    _sections: DetectedSection[],
    sectionTexts: string[],
    inspectResult?: LayoutInspectOutput
  ): string {
    const lines: string[] = [];

    // Section lines
    lines.push(...sectionTexts);

    // Additional metadata
    if (inspectResult) {
      if (this.options.includeColors && inspectResult.colors) {
        lines.push(this.generateColorDescription(inspectResult.colors));
      }
      if (this.options.includeTypography && inspectResult.typography) {
        lines.push(this.generateTypographyDescription(inspectResult.typography));
      }
      if (this.options.includeGrid && inspectResult.grid) {
        lines.push(this.generateGridDescription(inspectResult.grid));
      }
    }

    return lines.join('\n');
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }

    // Try to truncate at a sentence boundary
    const truncated = text.slice(0, maxLength);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline);

    if (cutPoint > maxLength * 0.5) {
      return truncated.slice(0, cutPoint + 1);
    }

    // Otherwise just cut at maxLength
    return truncated.slice(0, maxLength - 3) + '...';
  }
}
