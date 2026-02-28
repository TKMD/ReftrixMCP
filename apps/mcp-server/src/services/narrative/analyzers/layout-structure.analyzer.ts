// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layout Structure Analyzer
 *
 * HTML/CSSからレイアウト構成（グリッドシステム、視覚的階層、スペーシング）を
 * 分析するサービス。
 *
 * 分析対象:
 * - グリッドシステム（CSS Grid, Flexbox, カラム数）
 * - 視覚的階層（プライマリ/セカンダリ要素、セクションフロー）
 * - スペーシングリズム（ベース単位、スケール）
 * - セクション間関係性
 * - グラフィック要素（画像配置、装飾）
 *
 * @module services/narrative/analyzers/layout-structure.analyzer
 */

import type {
  LayoutStructureResult,
  GridSystem,
  VisualHierarchy,
  SpacingRhythm,
  SectionRelationship,
  GraphicElements,
} from '../types/narrative.types';
import type { CSSVariableExtractionResult } from '../../visual/css-variable-extractor.service';
import type { DetectedSection } from '@reftrix/webdesign-core';
import { isDevelopment, logger } from '../../../utils/logger';

// =============================================================================
// Types
// =============================================================================

/**
 * LayoutStructure分析入力
 */
export interface LayoutStructureAnalysisInput {
  /** サニタイズ済みHTML */
  html: string;
  /** CSS変数抽出結果 */
  cssVariables?: CSSVariableExtractionResult;
  /** 外部CSS（取得済みの場合） */
  externalCss?: string;
  /** 検出済みセクション */
  sections?: DetectedSection[];
}

/**
 * LayoutStructure分析メタデータ
 */
export interface LayoutStructureAnalysisMetadata {
  /** 処理時間（ms） */
  processingTimeMs: number;
  /** 分析されたセクション数 */
  sectionCount: number;
  /** 検出されたCSS変数数 */
  cssVariableCount: number;
}

/**
 * LayoutStructure分析結果（メタデータ付き）
 */
export interface LayoutStructureAnalysisOutput {
  /** 分析結果 */
  result: LayoutStructureResult;
  /** メタデータ */
  metadata: LayoutStructureAnalysisMetadata;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * 一般的なブレークポイント（文字列形式）
 */
const DEFAULT_BREAKPOINTS: GridSystem['breakpoints'] = {
  mobile: '640px',
  tablet: '768px',
  desktop: '1024px',
  wide: '1280px',
};

/**
 * スペーシング関連のCSSプロパティ名
 */
const SPACING_PROPERTY_PATTERNS = [
  'space',
  'spacing',
  'gap',
  'padding',
  'margin',
] as const;

// =============================================================================
// Grid System Analysis
// =============================================================================

/**
 * CSS変数とHTMLからグリッドシステムを検出
 */
function analyzeGridSystem(
  _html: string,
  css: string,
  cssVariables?: CSSVariableExtractionResult
): GridSystem {
  // CSS Grid検出
  const hasDisplayGrid = css.includes('display: grid') || css.includes('display:grid');

  // Flexbox検出
  const hasDisplayFlex = css.includes('display: flex') || css.includes('display:flex');

  // Float検出（レガシー）
  const hasFloat = css.includes('float:') || css.includes('float :');

  // グリッドタイプを決定
  let type: GridSystem['type'] = 'none';
  if (hasDisplayGrid && hasDisplayFlex) {
    type = 'mixed';
  } else if (hasDisplayGrid) {
    type = 'css-grid';
  } else if (hasDisplayFlex) {
    type = 'flexbox';
  } else if (hasFloat) {
    type = 'float';
  }

  // CSS変数からグリッド設定を抽出
  let columns: number | 'fluid' = 12;
  let gutterWidth = '1rem';
  let containerWidth = '1280px';

  if (cssVariables?.variables) {
    for (const variable of cssVariables.variables) {
      const name = variable.name.toLowerCase();
      const value = variable.value;

      // カラム数
      if (name.includes('column') && name.includes('count')) {
        const num = parseInt(value, 10);
        if (!isNaN(num) && num > 0 && num <= 24) {
          columns = num;
        }
      }

      // ガター幅
      if (name.includes('gutter') || name.includes('gap')) {
        gutterWidth = value;
      }

      // コンテナ幅
      if (name.includes('container') || name.includes('max-width')) {
        containerWidth = value;
      }
    }
  }

  // grid-template-columnsからカラム数を推定
  const gridTemplateMatch = css.match(/grid-template-columns:\s*repeat\((\d+)/);
  if (gridTemplateMatch?.[1]) {
    const num = parseInt(gridTemplateMatch[1], 10);
    if (!isNaN(num) && num > 0 && num <= 24) {
      columns = num;
    }
  }

  // ブレークポイントを検出
  const breakpoints: GridSystem['breakpoints'] = {};
  const mediaQueryPattern = /@media[^{]*\(min-width:\s*(\d+)px\)/g;
  let match;
  const detectedBreakpoints: number[] = [];

  while ((match = mediaQueryPattern.exec(css)) !== null) {
    if (match[1]) {
      detectedBreakpoints.push(parseInt(match[1], 10));
    }
  }

  if (detectedBreakpoints.length >= 2) {
    detectedBreakpoints.sort((a, b) => a - b);
    if (detectedBreakpoints[0]) {
      breakpoints.mobile = `${detectedBreakpoints[0]}px`;
    }
    if (detectedBreakpoints[1]) {
      breakpoints.tablet = `${detectedBreakpoints[1]}px`;
    }
    if (detectedBreakpoints[2]) {
      breakpoints.desktop = `${detectedBreakpoints[2]}px`;
    }
    if (detectedBreakpoints[3]) {
      breakpoints.wide = `${detectedBreakpoints[3]}px`;
    }
  }

  // 検出されたブレークポイントがある場合はそれを使用、なければデフォルトを使用
  // exactOptionalPropertyTypes対応: 常に値を持つオブジェクトを渡す
  const finalBreakpoints = Object.keys(breakpoints).length > 0
    ? breakpoints
    : { ...DEFAULT_BREAKPOINTS };

  // 結果オブジェクトを構築
  const result: GridSystem = {
    type,
    columns,
  };

  if (gutterWidth) {
    result.gutterWidth = gutterWidth;
  }

  if (containerWidth) {
    result.containerWidth = containerWidth;
  }

  // breakpointsは常に値を持つオブジェクトを設定
  result.breakpoints = finalBreakpoints;

  return result;
}

// =============================================================================
// Visual Hierarchy Analysis
// =============================================================================

/**
 * セクションから視覚的階層を分析
 */
function analyzeVisualHierarchy(
  sections?: DetectedSection[]
): VisualHierarchy {
  // デフォルト結果
  const defaultHierarchy: VisualHierarchy = {
    primaryElements: [],
    secondaryElements: [],
    tertiaryElements: [],
    sectionFlow: 'linear',
    weightDistribution: {
      top: 0.4,
      middle: 0.4,
      bottom: 0.2,
    },
  };

  if (!sections || sections.length === 0) {
    return defaultHierarchy;
  }

  // セクションタイプごとに分類
  const heroSections: string[] = [];
  const contentSections: string[] = [];
  const supportSections: string[] = [];

  for (const section of sections) {
    const type = section.type.toLowerCase();

    if (type === 'hero' || type === 'header' || type === 'banner') {
      heroSections.push(section.type);
    } else if (
      type === 'content' ||
      type === 'features' ||
      type === 'services' ||
      type === 'products' ||
      type === 'about'
    ) {
      contentSections.push(section.type);
    } else {
      supportSections.push(section.type);
    }
  }

  // 視覚的重み分布を計算
  const total = sections.length;
  const heroWeight = heroSections.length / total;
  const contentWeight = contentSections.length / total;
  const supportWeight = supportSections.length / total;

  // セクションフローを決定
  let sectionFlow: VisualHierarchy['sectionFlow'] = 'linear';
  if (sections.some(s => s.type.toLowerCase().includes('grid'))) {
    sectionFlow = 'modular';
  } else if (heroWeight > 0.3 || supportWeight > heroWeight) {
    sectionFlow = 'asymmetric';
  }

  return {
    primaryElements: heroSections.slice(0, 3),
    secondaryElements: contentSections.slice(0, 5),
    tertiaryElements: supportSections.slice(0, 3),
    sectionFlow,
    weightDistribution: {
      top: Math.max(0.1, Math.min(0.6, heroWeight + 0.2)),
      middle: Math.max(0.2, Math.min(0.6, contentWeight + 0.2)),
      bottom: Math.max(0.1, Math.min(0.4, supportWeight + 0.1)),
    },
  };
}

// =============================================================================
// Spacing Rhythm Analysis
// =============================================================================

/**
 * CSS変数からスペーシングリズムを分析
 */
function analyzeSpacingRhythm(
  cssVariables?: CSSVariableExtractionResult
): SpacingRhythm {
  // デフォルト結果
  const defaultRhythm: SpacingRhythm = {
    baseUnit: '1rem',
    scale: [0.25, 0.5, 1, 1.5, 2, 3, 4],
    sectionGaps: {
      min: '2rem',
      max: '6rem',
      average: '4rem',
    },
  };

  if (!cssVariables?.variables) {
    return defaultRhythm;
  }

  // スペーシング変数を抽出
  const spacingVars = cssVariables.variables.filter(v =>
    SPACING_PROPERTY_PATTERNS.some(p => v.name.toLowerCase().includes(p))
  );

  if (spacingVars.length === 0) {
    return defaultRhythm;
  }

  // 値をパースして数値配列を作成
  const parsedValues: number[] = [];
  let baseUnit = 'rem';

  for (const v of spacingVars) {
    const value = v.value.toLowerCase();
    const numMatch = value.match(/^([\d.]+)(px|rem|em)?$/);

    if (numMatch?.[1]) {
      const num = parseFloat(numMatch[1]);
      if (!isNaN(num) && num > 0) {
        parsedValues.push(num);
        if (numMatch[2]) {
          baseUnit = numMatch[2];
        }
      }
    }
  }

  if (parsedValues.length === 0) {
    return defaultRhythm;
  }

  // ソートして最小値をベースとみなす
  parsedValues.sort((a, b) => a - b);
  const base = parsedValues[0] ?? 1;

  // スケールを計算
  const scale = parsedValues.map(v => Math.round((v / base) * 4) / 4);
  const uniqueScale = [...new Set(scale)].slice(0, 10);

  // スケール名を推定
  let scaleName: SpacingRhythm['scaleName'] = 'custom';
  const ratios = uniqueScale.slice(1).map((v, i) => v / (uniqueScale[i] ?? 1));

  if (ratios.every(r => Math.abs(r - 1.618) < 0.1)) {
    scaleName = 'fibonacci';
  } else if (ratios.every(r => Math.abs(r - 2) < 0.1)) {
    scaleName = 'geometric';
  } else if (ratios.every((r, i, arr) => i === 0 || Math.abs(r - (arr[i - 1] ?? 1)) < 0.1)) {
    scaleName = 'linear';
  }

  // セクションギャップを推定
  const maxValue = parsedValues[parsedValues.length - 1] ?? 4;
  const minGap = Math.max(2, base * 2);
  const maxGap = Math.min(maxValue * 1.5, 8);
  const avgGap = (minGap + maxGap) / 2;

  return {
    baseUnit: `${base}${baseUnit}`,
    scale: uniqueScale,
    scaleName,
    sectionGaps: {
      min: `${minGap}${baseUnit}`,
      max: `${maxGap}${baseUnit}`,
      average: `${avgGap.toFixed(1)}${baseUnit}`,
    },
  };
}

// =============================================================================
// Section Relationships Analysis
// =============================================================================

/**
 * セクション間の関係性を分析
 */
function analyzeSectionRelationships(
  sections?: DetectedSection[]
): SectionRelationship[] {
  if (!sections || sections.length < 2) {
    return [];
  }

  const relationships: SectionRelationship[] = [];

  for (let i = 0; i < sections.length - 1; i++) {
    const current = sections[i];
    const next = sections[i + 1];

    if (!current || !next) continue;

    // 基本的な「follows」関係
    relationships.push({
      sourceId: current.id,
      targetId: next.id,
      relationshipType: 'follows',
      strength: 0.8,
    });

    // タイプが同じ場合は「parallels」関係も追加
    if (current.type === next.type) {
      relationships.push({
        sourceId: current.id,
        targetId: next.id,
        relationshipType: 'parallels',
        strength: 0.6,
      });
    }

    // hero→contentのような自然な流れは強い関係
    if (
      current.type.toLowerCase() === 'hero' &&
      ['content', 'features', 'about'].includes(next.type.toLowerCase())
    ) {
      relationships.push({
        sourceId: current.id,
        targetId: next.id,
        relationshipType: 'contrasts',
        strength: 0.9,
      });
    }
  }

  return relationships;
}

// =============================================================================
// Graphic Elements Analysis
// =============================================================================

/**
 * HTMLとCSSからグラフィック要素を分析
 */
function analyzeGraphicElements(
  html: string,
  css: string
): GraphicElements {
  // 画像パターンを検出
  const imgCount = (html.match(/<img/gi) || []).length;
  const bgImageCount = (css.match(/background-image/gi) || []).length;
  const svgCount = (html.match(/<svg/gi) || []).length;

  // 画像配置パターンを決定
  let imagePattern: GraphicElements['imageLayout']['pattern'] = 'none';
  if (imgCount > 0 || bgImageCount > 0) {
    if (bgImageCount > imgCount) {
      imagePattern = 'full-bleed';
    } else if (imgCount >= 6) {
      imagePattern = 'grid';
    } else if (imgCount >= 3) {
      imagePattern = 'scattered';
    } else {
      imagePattern = 'contained';
    }
  }

  // アスペクト比を検出（一般的なパターン）
  const aspectRatios: string[] = [];
  if (css.includes('aspect-ratio')) {
    const ratioMatches = css.match(/aspect-ratio:\s*([\d/.]+)/g);
    if (ratioMatches) {
      for (const match of ratioMatches) {
        const ratio = match.replace('aspect-ratio:', '').trim();
        if (ratio && !aspectRatios.includes(ratio)) {
          aspectRatios.push(ratio);
        }
      }
    }
  }

  // 装飾要素を検出
  const hasGradients = css.includes('linear-gradient') ||
    css.includes('radial-gradient') ||
    css.includes('conic-gradient');
  const hasShadows = css.includes('box-shadow') || css.includes('text-shadow');
  const hasBorders = css.includes('border-radius') || css.includes('border:');
  const hasIllustrations = svgCount > 2;

  // 視覚的バランスを推定
  let symmetry: GraphicElements['visualBalance']['symmetry'] = 'symmetric';
  if (html.includes('flex') && html.includes('justify-between')) {
    symmetry = 'asymmetric';
  } else if (imgCount % 2 !== 0) {
    symmetry = 'dynamic';
  }

  // コンテンツ密度を推定
  const elementCount = (html.match(/<(div|section|article|p|h\d)/gi) || []).length;
  let density: GraphicElements['visualBalance']['density'] = 'balanced';
  if (elementCount < 20) {
    density = 'sparse';
  } else if (elementCount > 100) {
    density = 'dense';
  }

  // ホワイトスペース比率を推定（ヒューリスティック）
  const paddingCount = (css.match(/padding/gi) || []).length;
  const marginCount = (css.match(/margin/gi) || []).length;
  const spacingScore = Math.min(1, (paddingCount + marginCount) / 50);

  return {
    imageLayout: {
      pattern: imagePattern,
      aspectRatios: aspectRatios.length > 0 ? aspectRatios : ['16/9', '4/3'],
      positions: imgCount > 0 ? ['inline'] : [],
    },
    decorations: {
      hasGradients,
      hasShadows,
      hasBorders,
      hasIllustrations,
    },
    visualBalance: {
      symmetry,
      density,
      whitespace: spacingScore,
    },
  };
}

// =============================================================================
// LayoutStructureAnalyzer Class
// =============================================================================

/**
 * Layout Structure Analyzer
 *
 * HTML/CSSからレイアウト構成を分析
 */
export class LayoutStructureAnalyzer {
  constructor() {
    if (isDevelopment()) {
      logger.info('[LayoutStructureAnalyzer] Initialized');
    }
  }

  /**
   * LayoutStructureを分析
   *
   * @param input - 分析入力
   * @returns 分析結果とメタデータ
   */
  analyze(input: LayoutStructureAnalysisInput): LayoutStructureAnalysisOutput {
    const startTime = Date.now();

    // CSSを結合
    const combinedCss = this.extractAndCombineCss(input.html, input.externalCss);

    // 各コンポーネントを分析
    const gridSystem = analyzeGridSystem(input.html, combinedCss, input.cssVariables);
    const visualHierarchy = analyzeVisualHierarchy(input.sections);
    const spacingRhythm = analyzeSpacingRhythm(input.cssVariables);
    const sectionRelationships = analyzeSectionRelationships(input.sections);
    const graphicElements = analyzeGraphicElements(input.html, combinedCss);

    const result: LayoutStructureResult = {
      gridSystem,
      visualHierarchy,
      spacingRhythm,
      sectionRelationships,
      graphicElements,
    };

    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[LayoutStructureAnalyzer] Analysis complete', {
        processingTimeMs,
        gridType: gridSystem.type,
        sectionCount: input.sections?.length ?? 0,
        cssVariableCount: input.cssVariables?.variables.length ?? 0,
      });
    }

    return {
      result,
      metadata: {
        processingTimeMs,
        sectionCount: input.sections?.length ?? 0,
        cssVariableCount: input.cssVariables?.variables.length ?? 0,
      },
    };
  }

  /**
   * HTMLからstyleタグを抽出してCSSを結合
   */
  private extractAndCombineCss(html: string, externalCss?: string): string {
    let combinedCss = externalCss ?? '';

    // HTMLからstyleタグを抽出
    const styleTagPattern = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let match;

    while ((match = styleTagPattern.exec(html)) !== null) {
      if (match[1]) {
        combinedCss += '\n' + match[1];
      }
    }

    // インラインスタイルを抽出
    const inlineStylePattern = /style\s*=\s*["']([^"']+)["']/gi;
    while ((match = inlineStylePattern.exec(html)) !== null) {
      if (match[1]) {
        combinedCss += '\n.inline { ' + match[1] + ' }';
      }
    }

    return combinedCss;
  }
}

/**
 * デフォルトのLayoutStructureAnalyzerインスタンスを作成
 */
export function createLayoutStructureAnalyzer(): LayoutStructureAnalyzer {
  return new LayoutStructureAnalyzer();
}
