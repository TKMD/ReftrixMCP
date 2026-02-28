// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionDetector - CSS Animation/Transition/Transform Detection Engine
 *
 * Webページのアニメーション・トランジション・モーションパターンを検出するコアエンジン
 *
 * @module @reftrix/webdesign-core/motion-detector
 */

import { load as loadCheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import * as csstree from 'css-tree';
import { v4 as uuidv4 } from 'uuid';

// =========================================
// Type Definitions - Re-exported from types.ts
// 循環依存を避けるため、型定義を types.ts に分離
// =========================================

export type {
  MotionProperty,
  MotionPattern,
  MotionDetectionResult,
  MotionWarning,
  KeyframeDefinition,
  KeyframeStep,
  MotionDetectorOptions,
  CSSStyleProperties,
} from './types';

// ローカルで使用するためインポート
import type {
  MotionProperty,
  MotionPattern,
  MotionDetectionResult,
  MotionWarning,
  KeyframeDefinition,
  KeyframeStep,
  MotionDetectorOptions,
  CSSStyleProperties,
} from './types';

// =========================================
// Constants
// =========================================

/** レイアウトトリガーするプロパティ（パフォーマンス警告対象） */
const LAYOUT_TRIGGERING_PROPERTIES = [
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'margin',
  'padding',
  'border-width',
  'font-size',
  'line-height',
];

/**
 * ペイントトリガーするプロパティ（パフォーマンス警告対象）
 * 将来の拡張用にエクスポート
 */
export const PAINT_TRIGGERING_PROPERTIES = [
  'color',
  'background-color',
  'background-image',
  'box-shadow',
  'text-shadow',
  'border-radius',
  'outline',
] as const;

/**
 * GPUアクセラレーション対応プロパティ（推奨）
 * 将来の拡張用にエクスポート
 */
export const GPU_ACCELERATED_PROPERTIES = [
  'transform',
  'opacity',
  'filter',
] as const;

/** 長時間アニメーションの閾値（ミリ秒） */
const LONG_DURATION_THRESHOLD = 5000;

/** 高速アニメーションの閾値（ミリ秒）- アクセシビリティ警告用 */
const FAST_ANIMATION_THRESHOLD = 300;

/** デフォルトオプション */
const DEFAULT_OPTIONS: Required<MotionDetectorOptions> = {
  includeInlineStyles: true,
  includeStyleSheets: true,
  minDuration: 0,
  maxDepth: 10,
};

// =========================================
// MotionDetector Class
// =========================================

/**
 * MotionDetector - CSS Animation/Transition/Transform Detection Engine
 *
 * @example
 * ```typescript
 * const detector = new MotionDetector();
 * const result = detector.detect(html, css);
 * console.log(result.patterns);
 * console.log(result.summary);
 * ```
 */
export class MotionDetector {
  private readonly options: Required<MotionDetectorOptions>;
  private keyframesMap: Map<string, KeyframeDefinition> = new Map();
  private hasVendorPrefixes = false;
  private hasScrollTimeline = false;

  constructor(options?: MotionDetectorOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[MotionDetector] Initialized with options:', this.options);
    }
  }

  /**
   * HTML/CSSからモーションパターンを検出
   *
   * @param html - 解析対象のHTML文字列
   * @param css - 追加のCSS文字列（オプション）
   * @returns モーション検出結果
   */
  public detect(html: string, css?: string): MotionDetectionResult {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[MotionDetector] Starting detection...');
    }

    // 状態をリセット
    this.hasVendorPrefixes = false;
    this.hasScrollTimeline = false;

    const patterns: MotionPattern[] = [];
    const warnings: MotionWarning[] = [];

    // オプションに応じて処理をスキップ
    if (!this.options.includeStyleSheets && !this.options.includeInlineStyles) {
      return this.createEmptyResult();
    }

    // Cheerioでパース
    const $ = loadCheerio(html);

    // スタイルシートからキーフレームとルールを抽出
    let combinedCss = '';
    if (this.options.includeStyleSheets) {
      $('style').each((_, el) => {
        const styleContent = $(el).text();
        combinedCss += styleContent + '\n';
      });
      if (css) {
        combinedCss += css;
      }
    }

    // ベンダープレフィックス検出
    if (
      combinedCss.includes('-webkit-') ||
      combinedCss.includes('-moz-') ||
      combinedCss.includes('-o-')
    ) {
      this.hasVendorPrefixes = true;
    }

    // scroll-timeline検出
    if (
      combinedCss.includes('animation-timeline') ||
      combinedCss.includes('scroll()')
    ) {
      this.hasScrollTimeline = true;
    }

    // キーフレームを解析
    this.keyframesMap = this.parseKeyframes(combinedCss);

    // スタイルシートからパターンを検出
    if (this.options.includeStyleSheets && combinedCss) {
      const stylesheetPatterns = this.detectFromStylesheet($, combinedCss);
      patterns.push(...stylesheetPatterns);
    }

    // インラインスタイルからパターンを検出
    if (this.options.includeInlineStyles) {
      const inlinePatterns = this.detectFromInlineStyles($);
      patterns.push(...inlinePatterns);
    }

    // minDurationでフィルタ
    const filteredPatterns = patterns.filter(
      (p) => p.duration >= this.options.minDuration
    );

    // 警告を生成
    const generatedWarnings = this.generateWarnings(filteredPatterns);
    warnings.push(...generatedWarnings);

    // 互換性警告：ベンダープレフィックス
    if (this.hasVendorPrefixes) {
      warnings.push({
        type: 'compatibility',
        severity: 'low',
        message:
          'Vendor prefixes detected (-webkit-, -moz-, -o-). Consider using autoprefixer for better maintainability.',
        suggestion:
          'Use autoprefixer or remove vendor prefixes if browser support is sufficient.',
      });
    }

    // 互換性警告：scroll-timeline
    if (this.hasScrollTimeline) {
      warnings.push({
        type: 'compatibility',
        severity: 'medium',
        message:
          'Scroll-linked animations (animation-timeline) detected. This is an experimental feature with limited browser support.',
        suggestion:
          'Provide a fallback for browsers that do not support scroll-linked animations.',
      });
    }

    // アクセシビリティ警告（prefers-reduced-motion）
    if (
      filteredPatterns.length > 0 &&
      !combinedCss.includes('prefers-reduced-motion')
    ) {
      warnings.push({
        type: 'accessibility',
        severity: 'medium',
        message:
          'No prefers-reduced-motion media query detected. Consider adding support for users who prefer reduced motion.',
        suggestion:
          '@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }',
      });
    }

    // サマリーを計算
    const summary = this.calculateSummary(filteredPatterns);

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log(
        '[MotionDetector] Detection complete. Patterns:',
        filteredPatterns.length
      );
    }

    return {
      patterns: filteredPatterns,
      summary,
      warnings,
    };
  }

  /**
   * 単一要素のモーションを検出
   *
   * @param selector - CSSセレクタ
   * @param styles - CSSStylePropertiesオブジェクト
   * @returns 検出されたパターン配列
   */
  public detectElement(
    selector: string,
    styles: CSSStyleProperties
  ): MotionPattern[] {
    const patterns: MotionPattern[] = [];

    // アニメーション検出
    const animationName =
      styles.animationName || this.extractAnimationName(styles.animation || '');
    if (animationName && animationName !== 'none') {
      const pattern = this.createAnimationPattern(
        selector,
        animationName,
        styles
      );
      patterns.push(pattern);
    }

    // トランジション検出
    const transitionProperty = styles.transitionProperty || 'all';
    const transitionDuration = styles.transitionDuration;
    if (transitionDuration && transitionDuration !== '0s') {
      const pattern = this.createTransitionPattern(
        selector,
        transitionProperty,
        styles
      );
      patterns.push(pattern);
    }

    return patterns;
  }

  /**
   * CSSからキーフレームを解析
   *
   * @param css - CSS文字列
   * @returns キーフレーム定義のMap
   */
  public parseKeyframes(css: string): Map<string, KeyframeDefinition> {
    const keyframes = new Map<string, KeyframeDefinition>();

    if (!css || css.trim() === '') {
      return keyframes;
    }

    try {
      const ast = csstree.parse(css, {
        parseRulePrelude: false,
        parseValue: false,
      });

      csstree.walk(ast, (node) => {
        if (node.type === 'Atrule' && node.name === 'keyframes') {
          const name = this.extractKeyframeName(node);
          if (name) {
            const steps = this.extractKeyframeSteps(node);
            keyframes.set(name, { name, steps });
          }
        }
        // ベンダープレフィックス付きキーフレーム
        if (
          node.type === 'Atrule' &&
          (node.name === '-webkit-keyframes' ||
            node.name === '-moz-keyframes' ||
            node.name === '-o-keyframes')
        ) {
          const name = this.extractKeyframeName(node);
          if (name && !keyframes.has(name)) {
            const steps = this.extractKeyframeSteps(node);
            keyframes.set(name, { name, steps });
          }
        }
      });
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[MotionDetector] Failed to parse keyframes:', error);
      }
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log(
        '[MotionDetector] Parsed keyframes:',
        Array.from(keyframes.keys())
      );
    }

    return keyframes;
  }

  /**
   * パターンに対する警告を生成
   *
   * @param patterns - モーションパターン配列
   * @returns 警告配列
   */
  public generateWarnings(patterns: MotionPattern[]): MotionWarning[] {
    const warnings: MotionWarning[] = [];

    for (const pattern of patterns) {
      // 長時間アニメーション警告
      if (pattern.duration > LONG_DURATION_THRESHOLD) {
        warnings.push({
          type: 'performance',
          severity: 'medium',
          message: `Animation "${pattern.name}" has a long duration (${pattern.duration}ms). Consider reducing for better user experience.`,
          pattern: pattern.name,
          suggestion:
            'Keep animations under 5 seconds for better user engagement.',
        });
      }

      // レイアウトトリガープロパティ警告
      const layoutProps = pattern.properties.filter((p) =>
        LAYOUT_TRIGGERING_PROPERTIES.some((lp) => p.name.includes(lp))
      );
      if (layoutProps.length > 0) {
        warnings.push({
          type: 'performance',
          severity: 'high',
          message: `Animation "${pattern.name}" animates layout-triggering properties (${layoutProps.map((p) => p.name).join(', ')}). This can cause performance issues.`,
          pattern: pattern.name,
          suggestion:
            'Use transform and opacity instead of width, height, top, left for better performance.',
        });
      }

      // box-shadow アニメーション警告
      const shadowProps = pattern.properties.filter(
        (p) => p.name === 'box-shadow' || p.name === 'text-shadow'
      );
      if (shadowProps.length > 0) {
        warnings.push({
          type: 'performance',
          severity: 'medium',
          message: `Animation "${pattern.name}" animates box-shadow/text-shadow. This can be expensive to render.`,
          pattern: pattern.name,
          suggestion:
            'Consider using a pseudo-element with opacity for shadow animations.',
        });
      }

      // 高速アニメーション + 無限ループ警告（アクセシビリティ）
      if (
        pattern.duration < FAST_ANIMATION_THRESHOLD &&
        pattern.iterations === 'infinite'
      ) {
        warnings.push({
          type: 'accessibility',
          severity: 'high',
          message: `Animation "${pattern.name}" is rapid (${pattern.duration}ms) and infinite. This may cause discomfort for users with vestibular disorders.`,
          pattern: pattern.name,
          suggestion:
            'Increase duration or limit iterations. Support prefers-reduced-motion.',
        });
      }
    }

    return warnings;
  }

  /**
   * 複雑度スコアを計算
   *
   * @param patterns - モーションパターン配列
   * @returns 複雑度スコア (0-100)
   */
  public calculateComplexity(patterns: MotionPattern[]): number {
    if (patterns.length === 0) {
      return 0;
    }

    let score = 0;

    // パターン数による基本スコア（各パターン7点）
    score += Math.min(patterns.length * 7, 35);

    for (const pattern of patterns) {
      // プロパティ数（各プロパティ3点）
      score += pattern.properties.length * 3;

      // キーフレーム数（2以上で追加点）
      for (const prop of pattern.properties) {
        if (prop.keyframes && prop.keyframes.length > 2) {
          score += (prop.keyframes.length - 2) * 2;
        }
      }

      // 無限ループ（12点追加）
      if (pattern.iterations === 'infinite') {
        score += 12;
      }

      // 長時間（2秒以上で7点追加）
      if (pattern.duration > 2000) {
        score += 7;
      }

      // 遅延によるチェーン（5点追加）
      if (pattern.delay > 0) {
        score += 5;
      }

      // 複雑なイージング（3点追加）
      if (pattern.easing.includes('cubic-bezier')) {
        score += 3;
      }

      // 複雑な方向（3点追加）
      if (
        pattern.direction === 'alternate' ||
        pattern.direction === 'alternate-reverse'
      ) {
        score += 3;
      }
    }

    // 100を超えないように制限
    return Math.min(score, 100);
  }

  // =========================================
  // Private Methods
  // =========================================

  /**
   * 空の結果を生成
   */
  private createEmptyResult(): MotionDetectionResult {
    return {
      patterns: [],
      summary: {
        totalPatterns: 0,
        byType: {
          animation: 0,
          transition: 0,
          transform: 0,
          scroll: 0,
          hover: 0,
          keyframe: 0,
        },
        byTrigger: {
          load: 0,
          hover: 0,
          scroll: 0,
          click: 0,
          focus: 0,
          custom: 0,
        },
        averageDuration: 0,
        hasInfiniteAnimations: false,
        complexityScore: 0,
      },
      warnings: [],
    };
  }

  /**
   * スタイルシートからパターンを検出
   */
  private detectFromStylesheet(
    _$: CheerioAPI,
    css: string
  ): MotionPattern[] {
    const patterns: MotionPattern[] = [];

    try {
      const ast = csstree.parse(css);

      csstree.walk(ast, (node) => {
        if (node.type === 'Rule') {
          const selector = csstree.generate(node.prelude);
          const declarations = this.extractDeclarations(node);

          // アニメーション検出
          const animationPattern = this.detectAnimationFromDeclarations(
            selector,
            declarations
          );
          if (animationPattern) {
            patterns.push(animationPattern);
          }

          // トランジション検出
          const transitionPattern = this.detectTransitionFromDeclarations(
            selector,
            declarations
          );
          if (transitionPattern) {
            patterns.push(transitionPattern);
          }
        }
      });

      // 擬似クラスからトリガーを更新
      this.updateTriggersFromPseudoClasses(patterns, css);
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[MotionDetector] Failed to parse stylesheet:', error);
      }
    }

    return patterns;
  }

  /**
   * インラインスタイルからパターンを検出
   */
  private detectFromInlineStyles($: CheerioAPI): MotionPattern[] {
    const patterns: MotionPattern[] = [];

    $('[style]').each((_, el) => {
      const element = el as Element;
      const style = $(element).attr('style') || '';
      const selector = this.generateSelector($, element);

      // animation プロパティ検出
      const animationMatch = style.match(
        /animation\s*:\s*([^;]+)/i
      );
      if (animationMatch?.[1]) {
        const animValue = animationMatch[1].trim();
        const pattern = this.parseAnimationShorthand(selector, animValue);
        if (pattern) {
          patterns.push(pattern);
        }
      }

      // transition プロパティ検出
      const transitionMatch = style.match(
        /transition\s*:\s*([^;]+)/i
      );
      if (transitionMatch?.[1]) {
        const transValue = transitionMatch[1].trim();
        const pattern = this.parseTransitionShorthand(selector, transValue);
        if (pattern) {
          patterns.push(pattern);
        }
      }
    });

    return patterns;
  }

  /**
   * 宣言からアニメーションパターンを検出
   */
  private detectAnimationFromDeclarations(
    selector: string,
    declarations: Map<string, string>
  ): MotionPattern | null {
    const animation = declarations.get('animation');
    const animationName =
      declarations.get('animation-name') ||
      (animation ? this.extractAnimationName(animation) : null);

    if (!animationName || animationName === 'none') {
      return null;
    }

    const duration = this.parseDuration(
      declarations.get('animation-duration') ||
        this.extractAnimationDuration(animation || '') ||
        '0s'
    );
    const delay = this.parseDuration(
      declarations.get('animation-delay') || '0s'
    );
    const easing =
      declarations.get('animation-timing-function') ||
      this.extractAnimationEasing(animation || '') ||
      'ease';

    // iteration-countの検出（ショートハンドから）
    let iterations: number | 'infinite' = this.parseIterations(
      declarations.get('animation-iteration-count') || '1'
    );
    if (iterations === 1 && animation && animation.includes('infinite')) {
      iterations = 'infinite';
    }

    // directionの検出（ショートハンドから）
    let direction = this.parseDirection(
      declarations.get('animation-direction') || 'normal'
    );
    if (direction === 'normal' && animation) {
      if (animation.includes('alternate-reverse')) {
        direction = 'alternate-reverse';
      } else if (animation.includes('alternate')) {
        direction = 'alternate';
      } else if (animation.match(/\breverse\b/)) {
        direction = 'reverse';
      }
    }

    // fillModeの検出（ショートハンドから）
    let fillMode = this.parseFillMode(
      declarations.get('animation-fill-mode') || 'none'
    );
    if (fillMode === 'none' && animation) {
      if (animation.includes('forwards')) {
        fillMode = 'forwards';
      } else if (animation.includes('backwards')) {
        fillMode = 'backwards';
      } else if (animation.match(/\bboth\b/)) {
        fillMode = 'both';
      }
    }

    const playState = this.parsePlayState(
      declarations.get('animation-play-state') || 'running'
    );

    // キーフレームからプロパティを取得
    const properties = this.getPropertiesFromKeyframes(animationName);

    // scroll関連のトリガー検出
    let trigger: MotionPattern['trigger'] = 'load';
    if (
      declarations.has('animation-timeline') &&
      (declarations.get('animation-timeline')?.includes('scroll') ||
        declarations.get('animation-timeline')?.includes('view'))
    ) {
      trigger = 'scroll';
    }

    return {
      id: uuidv4(),
      type: 'animation',
      name: animationName,
      selector,
      properties,
      duration,
      delay,
      easing,
      iterations,
      direction,
      fillMode,
      playState,
      trigger,
      confidence: 0.9,
    };
  }

  /**
   * 宣言からトランジションパターンを検出
   */
  private detectTransitionFromDeclarations(
    selector: string,
    declarations: Map<string, string>
  ): MotionPattern | null {
    const transition = declarations.get('transition');
    let transitionProperty = declarations.get('transition-property') || '';
    const transitionDuration =
      declarations.get('transition-duration') ||
      (transition ? this.extractTransitionDuration(transition) : null);

    if (!transitionDuration || transitionDuration === '0s') {
      return null;
    }

    // transitionショートハンドから複数プロパティを抽出
    if (!transitionProperty && transition) {
      transitionProperty = this.extractTransitionProperties(transition);
    }

    if (!transitionProperty) {
      transitionProperty = 'all';
    }

    const duration = this.parseDuration(transitionDuration);
    const delay = this.parseDuration(
      declarations.get('transition-delay') || '0s'
    );
    const easing =
      declarations.get('transition-timing-function') ||
      this.extractTransitionEasing(transition || '') ||
      'ease';

    const propertyList = transitionProperty.split(',');
    const properties: MotionProperty[] = propertyList.map((prop) => ({
      name: prop.trim(),
      from: '',
      to: '',
    }));

    const firstProperty = propertyList[0]?.trim() ?? 'all';

    return {
      id: uuidv4(),
      type: 'transition',
      name: `transition-${firstProperty}`,
      selector,
      properties,
      duration,
      delay,
      easing,
      iterations: 1,
      direction: 'normal',
      fillMode: 'none',
      playState: 'running',
      trigger: 'hover', // デフォルトはhover、後で更新される可能性
      confidence: 0.8,
    };
  }

  /**
   * transitionショートハンドから複数プロパティを抽出
   */
  private extractTransitionProperties(transition: string): string {
    // transition: background-color 0.3s ease, transform 0.2s ease-out;
    const segments = transition.split(',');
    const properties: string[] = [];

    for (const segment of segments) {
      const trimmed = segment.trim();
      // 最初のトークンがプロパティ名
      const firstToken = trimmed.split(/\s+/)[0];
      if (
        firstToken &&
        !firstToken.match(/^\d/) && // 数値で始まらない
        !firstToken.match(/^(ease|linear|cubic-bezier|steps)/i) // タイミング関数でない
      ) {
        properties.push(firstToken);
      }
    }

    return properties.length > 0 ? properties.join(', ') : 'all';
  }

  /**
   * 擬似クラスからトリガーを更新し、:hover等からプロパティを抽出
   */
  private updateTriggersFromPseudoClasses(
    patterns: MotionPattern[],
    css: string
  ): void {
    // 擬似クラスルールからプロパティを抽出するためのマップ
    const pseudoProperties = this.extractPseudoClassProperties(css);

    for (const pattern of patterns) {
      const selector = pattern.selector;
      const baseSelector = selector.replace(/:[a-z-]+/gi, '');

      // :hover チェック
      if (css.includes(`${selector}:hover`) || selector.includes(':hover') ||
          css.includes(`${baseSelector}:hover`)) {
        pattern.trigger = 'hover';
        // :hoverルールからプロパティを追加
        const hoverProps = pseudoProperties.get(`${baseSelector}:hover`);
        if (hoverProps) {
          this.mergePropertiesFromPseudo(pattern, hoverProps);
        }
      }

      // :focus / :focus-within チェック
      if (
        css.includes(`${selector}:focus`) ||
        css.includes(`${selector}:focus-within`) ||
        css.includes(`${baseSelector}:focus`) ||
        selector.includes(':focus')
      ) {
        pattern.trigger = 'focus';
      }

      // :active チェック
      if (css.includes(`${selector}:active`) || selector.includes(':active') ||
          css.includes(`${baseSelector}:active`)) {
        pattern.trigger = 'click';
      }

      // 属性セレクタ
      if (selector.includes('[data-') || selector.includes('[aria-')) {
        pattern.trigger = 'custom';
      }

      // scroll-timeline
      if (css.includes('animation-timeline') && css.includes('scroll')) {
        pattern.trigger = 'scroll';
      }
    }
  }

  /**
   * 擬似クラスルールからプロパティを抽出
   */
  private extractPseudoClassProperties(
    css: string
  ): Map<string, Map<string, string>> {
    const pseudoProps = new Map<string, Map<string, string>>();

    try {
      const ast = csstree.parse(css);

      csstree.walk(ast, (node) => {
        if (node.type === 'Rule') {
          const selectorText = csstree.generate(node.prelude);
          // 擬似クラスを含むセレクタを検出
          if (selectorText.match(/:(hover|focus|active|focus-within)/)) {
            const declarations = this.extractDeclarations(node);
            pseudoProps.set(selectorText, declarations);
          }
        }
      });
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[MotionDetector] Failed to extract pseudo properties:', error);
      }
    }

    return pseudoProps;
  }

  /**
   * 擬似クラスルールからプロパティをマージ
   */
  private mergePropertiesFromPseudo(
    pattern: MotionPattern,
    declarations: Map<string, string>
  ): void {
    // transform プロパティを追加
    const transform = declarations.get('transform');
    if (transform) {
      const existingTransform = pattern.properties.find(p => p.name === 'transform');
      if (existingTransform) {
        existingTransform.to = transform;
      } else {
        pattern.properties.push({
          name: 'transform',
          from: '',
          to: transform,
        });
      }
    }

    // その他のトランジションプロパティも追加可能
    for (const [prop, value] of declarations) {
      if (!['transform', 'transition', 'animation'].includes(prop)) {
        const existingProp = pattern.properties.find(p => p.name === prop);
        if (existingProp) {
          existingProp.to = value;
        }
      }
    }
  }

  /**
   * CSSルールから宣言を抽出
   */
  private extractDeclarations(
    rule: csstree.Rule
  ): Map<string, string> {
    const declarations = new Map<string, string>();

    if (rule.block) {
      csstree.walk(rule.block, (node) => {
        if (node.type === 'Declaration') {
          const property = node.property;
          const value = csstree.generate(node.value);
          declarations.set(property, value);
        }
      });
    }

    return declarations;
  }

  /**
   * キーフレーム名を抽出
   */
  private extractKeyframeName(atrule: csstree.Atrule): string | null {
    if (atrule.prelude && atrule.prelude.type === 'AtrulePrelude') {
      return csstree.generate(atrule.prelude).trim();
    }
    return null;
  }

  /**
   * キーフレームステップを抽出
   */
  private extractKeyframeSteps(atrule: csstree.Atrule): KeyframeStep[] {
    const steps: KeyframeStep[] = [];

    if (atrule.block) {
      csstree.walk(atrule.block, (node) => {
        if (node.type === 'Rule') {
          const prelude = csstree.generate(node.prelude);
          const offsets = this.parseKeyframeOffsets(prelude);
          const properties: { name: string; value: string }[] = [];
          let timingFunction: string | undefined;

          if (node.block) {
            csstree.walk(node.block, (declNode) => {
              if (declNode.type === 'Declaration') {
                if (declNode.property === 'animation-timing-function') {
                  timingFunction = csstree.generate(declNode.value);
                } else {
                  properties.push({
                    name: declNode.property,
                    value: csstree.generate(declNode.value),
                  });
                }
              }
            });
          }

          for (const offset of offsets) {
            const step: KeyframeStep = {
              offset,
              properties: [...properties],
            };
            if (timingFunction) {
              step.timingFunction = timingFunction;
            }
            steps.push(step);
          }
        }
      });
    }

    return steps.sort((a, b) => a.offset - b.offset);
  }

  /**
   * キーフレームオフセットを解析
   */
  private parseKeyframeOffsets(prelude: string): number[] {
    const offsets: number[] = [];
    const parts = prelude.split(',');

    for (const part of parts) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed === 'from') {
        offsets.push(0);
      } else if (trimmed === 'to') {
        offsets.push(1);
      } else if (trimmed.endsWith('%')) {
        const percent = parseFloat(trimmed);
        if (!isNaN(percent)) {
          offsets.push(percent / 100);
        }
      }
    }

    return offsets;
  }

  /**
   * キーフレームからプロパティを取得
   */
  private getPropertiesFromKeyframes(
    animationName: string
  ): MotionProperty[] {
    const keyframeDef = this.keyframesMap.get(animationName);
    if (!keyframeDef || keyframeDef.steps.length === 0) {
      return [];
    }

    const propertyMap = new Map<string, MotionProperty>();

    for (const step of keyframeDef.steps) {
      for (const prop of step.properties) {
        if (!propertyMap.has(prop.name)) {
          propertyMap.set(prop.name, {
            name: prop.name,
            from: '',
            to: '',
            keyframes: [],
          });
        }

        const motionProp = propertyMap.get(prop.name)!;

        if (step.offset === 0) {
          motionProp.from = prop.value;
        } else if (step.offset === 1) {
          motionProp.to = prop.value;
        }

        motionProp.keyframes?.push({
          offset: step.offset,
          value: prop.value,
        });
      }
    }

    return Array.from(propertyMap.values());
  }

  /**
   * animationショートハンドから名前を抽出
   */
  private extractAnimationName(animation: string): string {
    // animation: name duration timing delay iteration direction fill play-state
    const parts = animation.split(/\s+/);
    for (const part of parts) {
      // 時間値、数値、キーワードでないものを名前とする
      if (
        !part.match(/^\d/) &&
        !part.match(/^(ease|linear|step|cubic)/) &&
        !part.match(/^(normal|reverse|alternate|both|none|forwards|backwards)$/i) &&
        !part.match(/^(running|paused|infinite)$/i)
      ) {
        return part;
      }
    }
    return '';
  }

  /**
   * animationショートハンドから再生時間を抽出
   */
  private extractAnimationDuration(animation: string): string {
    const match = animation.match(/(\d+\.?\d*)(s|ms)/);
    return match ? match[0] : '0s';
  }

  /**
   * animationショートハンドからイージングを抽出
   */
  private extractAnimationEasing(animation: string): string {
    const easingMatch = animation.match(
      /(ease-in-out|ease-in|ease-out|ease|linear|cubic-bezier\([^)]+\)|steps\([^)]+\))/i
    );
    return easingMatch?.[1] ?? 'ease';
  }

  /**
   * transitionショートハンドから再生時間を抽出
   */
  private extractTransitionDuration(transition: string): string {
    const match = transition.match(/(\d+\.?\d*)(s|ms)/);
    return match ? match[0] : '0s';
  }

  /**
   * transitionショートハンドからイージングを抽出
   */
  private extractTransitionEasing(transition: string): string {
    const easingMatch = transition.match(
      /(ease-in-out|ease-in|ease-out|ease|linear|cubic-bezier\([^)]+\))/i
    );
    return easingMatch?.[1] ?? 'ease';
  }

  /**
   * animationショートハンドをパース
   */
  private parseAnimationShorthand(
    selector: string,
    animation: string
  ): MotionPattern | null {
    const name = this.extractAnimationName(animation);
    if (!name) return null;

    const duration = this.parseDuration(
      this.extractAnimationDuration(animation)
    );
    const easing = this.extractAnimationEasing(animation);
    const iterations = animation.includes('infinite') ? 'infinite' : 1;

    return {
      id: uuidv4(),
      type: 'animation',
      name,
      selector,
      properties: [],
      duration,
      delay: 0,
      easing,
      iterations: iterations as number | 'infinite',
      direction: 'normal',
      fillMode: 'none',
      playState: 'running',
      trigger: 'load',
      confidence: 0.7,
    };
  }

  /**
   * transitionショートハンドをパース
   */
  private parseTransitionShorthand(
    selector: string,
    transition: string
  ): MotionPattern | null {
    const duration = this.parseDuration(
      this.extractTransitionDuration(transition)
    );
    if (duration === 0) return null;

    const easing = this.extractTransitionEasing(transition);
    const property = transition.split(/\s+/)[0] || 'all';

    return {
      id: uuidv4(),
      type: 'transition',
      name: `transition-${property}`,
      selector,
      properties: [{ name: property, from: '', to: '' }],
      duration,
      delay: 0,
      easing,
      iterations: 1,
      direction: 'normal',
      fillMode: 'none',
      playState: 'running',
      trigger: 'hover',
      confidence: 0.7,
    };
  }

  /**
   * CSSStylePropertiesからアニメーションパターンを作成
   */
  private createAnimationPattern(
    selector: string,
    animationName: string,
    styles: CSSStyleProperties
  ): MotionPattern {
    return {
      id: uuidv4(),
      type: 'animation',
      name: animationName,
      selector,
      properties: this.getPropertiesFromKeyframes(animationName),
      duration: this.parseDuration(styles.animationDuration || '0s'),
      delay: this.parseDuration(styles.animationDelay || '0s'),
      easing: styles.animationTimingFunction || 'ease',
      iterations: this.parseIterations(styles.animationIterationCount || '1'),
      direction: this.parseDirection(styles.animationDirection || 'normal'),
      fillMode: this.parseFillMode(styles.animationFillMode || 'none'),
      playState: this.parsePlayState(styles.animationPlayState || 'running'),
      trigger: 'load',
      confidence: 0.85,
    };
  }

  /**
   * CSSStylePropertiesからトランジションパターンを作成
   */
  private createTransitionPattern(
    selector: string,
    transitionProperty: string,
    styles: CSSStyleProperties
  ): MotionPattern {
    const propList = transitionProperty.split(',');
    const firstProp = propList[0]?.trim() ?? 'all';

    return {
      id: uuidv4(),
      type: 'transition',
      name: `transition-${firstProp}`,
      selector,
      properties: propList.map((p) => ({
        name: p.trim(),
        from: '',
        to: '',
      })),
      duration: this.parseDuration(styles.transitionDuration ?? '0s'),
      delay: this.parseDuration(styles.transitionDelay ?? '0s'),
      easing: styles.transitionTimingFunction ?? 'ease',
      iterations: 1,
      direction: 'normal',
      fillMode: 'none',
      playState: 'running',
      trigger: 'hover',
      confidence: 0.85,
    };
  }

  /**
   * 再生時間を解析（ミリ秒に変換）
   */
  private parseDuration(value: string): number {
    const match = value.match(/^(\d+\.?\d*)(s|ms)$/);
    if (!match?.[1] || !match[2]) return 0;

    const num = parseFloat(match[1]);
    const unit = match[2];

    return unit === 's' ? num * 1000 : num;
  }

  /**
   * 繰り返し回数を解析
   */
  private parseIterations(value: string): number | 'infinite' {
    if (value === 'infinite') return 'infinite';
    const num = parseFloat(value);
    return isNaN(num) ? 1 : num;
  }

  /**
   * 再生方向を解析
   */
  private parseDirection(
    value: string
  ): MotionPattern['direction'] {
    const normalized = value.toLowerCase().trim();
    if (
      normalized === 'normal' ||
      normalized === 'reverse' ||
      normalized === 'alternate' ||
      normalized === 'alternate-reverse'
    ) {
      return normalized;
    }
    return 'normal';
  }

  /**
   * フィルモードを解析
   */
  private parseFillMode(value: string): MotionPattern['fillMode'] {
    const normalized = value.toLowerCase().trim();
    if (
      normalized === 'none' ||
      normalized === 'forwards' ||
      normalized === 'backwards' ||
      normalized === 'both'
    ) {
      return normalized;
    }
    return 'none';
  }

  /**
   * 再生状態を解析
   */
  private parsePlayState(
    value: string
  ): MotionPattern['playState'] {
    const normalized = value.toLowerCase().trim();
    return normalized === 'paused' ? 'paused' : 'running';
  }

  /**
   * 要素のセレクタを生成
   */
  private generateSelector(
    $: CheerioAPI,
    element: Element
  ): string {
    const tagName = element.tagName?.toLowerCase() || 'div';
    const id = $(element).attr('id');
    const classes = $(element).attr('class')?.split(/\s+/).filter(Boolean) || [];

    if (id) {
      return `#${id}`;
    }

    if (classes.length > 0) {
      return `${tagName}.${classes.join('.')}`;
    }

    return tagName;
  }

  /**
   * サマリーを計算
   */
  private calculateSummary(patterns: MotionPattern[]): MotionDetectionResult['summary'] {
    const byType: Record<MotionPattern['type'], number> = {
      animation: 0,
      transition: 0,
      transform: 0,
      scroll: 0,
      hover: 0,
      keyframe: 0,
    };

    const byTrigger: Record<MotionPattern['trigger'], number> = {
      load: 0,
      hover: 0,
      scroll: 0,
      click: 0,
      focus: 0,
      custom: 0,
    };

    let totalDuration = 0;
    let hasInfiniteAnimations = false;

    for (const pattern of patterns) {
      byType[pattern.type]++;
      byTrigger[pattern.trigger]++;
      totalDuration += pattern.duration;

      if (pattern.iterations === 'infinite') {
        hasInfiniteAnimations = true;
      }
    }

    const averageDuration =
      patterns.length > 0 ? totalDuration / patterns.length : 0;
    const complexityScore = this.calculateComplexity(patterns);

    return {
      totalPatterns: patterns.length,
      byType,
      byTrigger,
      averageDuration,
      hasInfiniteAnimations,
      complexityScore,
    };
  }
}

// Re-export from motion-embedding
export {
  MotionEmbedding,
  MotionFeatureExtractor,
  MOTION_EMBEDDING_DIM,
  type SimilarityResult,
} from './motion-embedding';

