// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Motion Detector Service
 *
 * CSS animation/transition detection service for page.analyze
 * Refactored: Delegates to CssAnimationParser, MotionPerformanceAnalyzer, MotionCategoryClassifier
 *
 * @module services/page/motion-detector.service
 */

import { v7 as uuidv7 } from 'uuid';
import { logger, isDevelopment } from '../../utils/logger';
import { getCssAnimationParser } from './css-animation-parser.service';
import { getMotionPerformanceAnalyzer } from './motion-performance-analyzer.service';
import { getMotionCategoryClassifier } from './motion-category-classifier.service';

// Re-export Types for API Compatibility
export type { KeyframeStep, EasingConfig } from './css-animation-parser.service';
export type { PerformanceLevel, PerformanceInfo, AccessibilityInfo, DetailedProperty } from './motion-performance-analyzer.service';
export type { TriggerType, MotionCategory } from './motion-category-classifier.service';

// Import types for internal use
import type { KeyframeStep } from './css-animation-parser.service';
import type { PerformanceInfo, DetailedProperty } from './motion-performance-analyzer.service';
import type { TriggerType, MotionCategory } from './motion-category-classifier.service';

/** Motion pattern type */
export type MotionPatternType = 'css_animation' | 'css_transition' | 'keyframes';

/** Warning severity level */
export type WarningSeverity = 'info' | 'warning' | 'error';

/** Detected motion pattern */
export interface MotionPattern {
  id: string;
  name: string;
  type: MotionPatternType;
  category: MotionCategory;
  trigger: TriggerType;
  selector?: string;
  duration: number;
  easing: string;
  delay?: number;
  iterations?: number | 'infinite';
  direction?: string;
  fillMode?: string;
  properties: string[];
  propertiesDetailed?: DetailedProperty[] | undefined;
  performance: PerformanceInfo;
  accessibility: { respectsReducedMotion: boolean };
  keyframes?: KeyframeStep[];
  rawCss?: string;
}

/** Motion warning */
export interface MotionWarning {
  code: string;
  severity: WarningSeverity;
  message: string;
  suggestion?: string;
}

/** Detection result */
export interface MotionDetectionResult {
  patterns: MotionPattern[];
  warnings: MotionWarning[];
  processingTimeMs: number;
}

/** Detection options */
export interface MotionDetectionOptions {
  includeInlineStyles?: boolean;
  includeStyleSheets?: boolean;
  minDuration?: number;
  maxPatterns?: number;
  verbose?: boolean;
}

export const MOTION_WARNING_CODES = {
  A11Y_NO_REDUCED_MOTION: 'A11Y_NO_REDUCED_MOTION',
  A11Y_INFINITE_ANIMATION: 'A11Y_INFINITE_ANIMATION',
  PERF_LAYOUT_TRIGGER: 'PERF_LAYOUT_TRIGGER',
  PERF_TOO_MANY_ANIMATIONS: 'PERF_TOO_MANY_ANIMATIONS',
} as const;

export class MotionDetectorService {
  private readonly cssParser = getCssAnimationParser();
  private readonly perfAnalyzer = getMotionPerformanceAnalyzer();
  private readonly classifier = getMotionCategoryClassifier();

  detect(
    html: string,
    options: MotionDetectionOptions = {},
    externalCss?: string
  ): MotionDetectionResult {
    const startTime = Date.now();
    const {
      includeInlineStyles = true,
      includeStyleSheets = true,
      minDuration = 0,
      maxPatterns = 100,
      verbose = false,
    } = options;

    if (isDevelopment()) {
      logger.info('[MotionDetector] Starting detection', {
        htmlLength: html.length,
        hasExternalCss: !!externalCss,
        options,
      });
    }

    const patterns: MotionPattern[] = [];
    const warnings: MotionWarning[] = [];

    if (!html) {
      return { patterns: [], warnings: [], processingTimeMs: Date.now() - startTime };
    }

    const combinedCss = this.collectCss(html, externalCss, includeStyleSheets, includeInlineStyles);
    const keyframesMap = this.cssParser.parseKeyframes(combinedCss);
    const styleRules = this.cssParser.extractStyleRules(combinedCss);
    const hasReducedMotion = /prefers-reduced-motion/i.test(combinedCss);

    this.processStyleRules(styleRules, keyframesMap, patterns, hasReducedMotion, minDuration, verbose);
    this.updateHoverTriggers(styleRules, patterns);
    this.addStandaloneKeyframes(keyframesMap, patterns, hasReducedMotion, verbose);
    this.generateWarnings(patterns, hasReducedMotion, warnings);

    const limitedPatterns = patterns.slice(0, maxPatterns);
    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[MotionDetector] Detection completed', {
        patternCount: limitedPatterns.length,
        warningCount: warnings.length,
        processingTimeMs,
      });
    }

    return { patterns: limitedPatterns, warnings, processingTimeMs };
  }

  private collectCss(
    html: string,
    externalCss: string | undefined,
    includeStyleSheets: boolean,
    includeInlineStyles: boolean
  ): string {
    let css = '';

    if (includeStyleSheets) {
      const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
      let match;
      while ((match = styleRegex.exec(html)) !== null) {
        if (match[1]) css += match[1] + '\n';
      }
    }

    if (externalCss) css += externalCss + '\n';

    if (includeInlineStyles) {
      const inlineRegex = /style="([^"]*)"/gi;
      let match, count = 0;
      while ((match = inlineRegex.exec(html)) !== null) {
        const style = match[1];
        if (style && (style.includes('animation') || style.includes('transition'))) {
          css += `.inline-style-${count++} { ${style} }\n`;
        }
      }
    }

    return css;
  }

  private processStyleRules(
    styleRules: Map<string, Record<string, string>>,
    keyframesMap: Map<string, KeyframeStep[]>,
    patterns: MotionPattern[],
    hasReducedMotion: boolean,
    minDuration: number,
    verbose: boolean
  ): void {
    for (const [selector, styles] of styleRules) {
      if (styles.animation || styles['animation-name']) {
        this.processAnimation(selector, styles, keyframesMap, patterns, hasReducedMotion, minDuration, verbose);
      }
      if (styles.transition) {
        this.processTransition(selector, styles, styleRules, patterns, hasReducedMotion, minDuration, verbose);
      }
    }
  }

  private processAnimation(
    selector: string,
    styles: Record<string, string>,
    keyframesMap: Map<string, KeyframeStep[]>,
    patterns: MotionPattern[],
    hasReducedMotion: boolean,
    minDuration: number,
    verbose: boolean
  ): void {
    const parsed = this.cssParser.parseAnimationProperty(styles.animation || styles['animation-name'] || '');
    if (parsed.duration < minDuration) return;

    const keyframes = keyframesMap.get(parsed.name);
    const properties = keyframes ? this.perfAnalyzer.extractPropertiesFromKeyframes(keyframes) : [];
    const propertiesDetailed = keyframes
      ? this.perfAnalyzer.extractDetailedPropertiesFromKeyframes(keyframes)
      : undefined;
    const trigger = this.classifier.inferTriggerType(selector, properties);
    const category = this.classifier.inferCategory(parsed.name, selector, properties, parsed.iterations);
    const performance = this.perfAnalyzer.analyzePerformance(properties);

    const pattern: MotionPattern = {
      id: uuidv7(),
      name: parsed.name || `animation-${patterns.length}`,
      type: 'css_animation',
      category,
      selector,
      trigger,
      duration: parsed.duration,
      delay: parsed.delay,
      easing: this.cssParser.formatEasing(parsed.easing),
      iterations: parsed.iterations,
      direction: parsed.direction,
      fillMode: parsed.fillMode,
      properties,
      propertiesDetailed,
      performance,
      accessibility: { respectsReducedMotion: hasReducedMotion },
    };

    if (verbose && keyframes) {
      pattern.keyframes = keyframes;
      pattern.rawCss = this.cssParser.generateKeyframesCss(parsed.name, keyframes);
    }

    patterns.push(pattern);
  }

  private processTransition(
    selector: string,
    styles: Record<string, string>,
    styleRules: Map<string, Record<string, string>>,
    patterns: MotionPattern[],
    hasReducedMotion: boolean,
    minDuration: number,
    verbose: boolean
  ): void {
    const transitions = this.cssParser.parseTransitionProperty(styles.transition ?? '');
    const validTransitions = transitions.filter((t) => t.duration >= minDuration);
    if (validTransitions.length === 0) return;

    const transitionProperties = validTransitions.map((t) => t.property);
    const hasHoverRule = styleRules.has(selector + ':hover') || selector.includes(':hover');

    const trigger: TriggerType = hasHoverRule ? 'hover' : this.classifier.inferTriggerType(selector, transitionProperties);
    const category = hasHoverRule ? 'hover_effect' : this.classifier.inferCategory('', selector, transitionProperties, 1);
    const performance = this.perfAnalyzer.analyzePerformance(transitionProperties);
    const maxDuration = Math.max(...validTransitions.map((t) => t.duration));
    const first = validTransitions[0];

    const pattern: MotionPattern = {
      id: uuidv7(),
      name: `transition-${patterns.length}`,
      type: 'css_transition',
      category,
      selector,
      trigger,
      duration: maxDuration,
      delay: first?.delay || 0,
      easing: this.cssParser.formatEasing(first?.easing || { type: 'ease' }),
      properties: transitionProperties,
      performance,
      accessibility: { respectsReducedMotion: hasReducedMotion },
    };

    if (verbose) pattern.rawCss = `${selector} { transition: ${styles.transition}; }`;
    patterns.push(pattern);
  }

  private updateHoverTriggers(
    styleRules: Map<string, Record<string, string>>,
    patterns: MotionPattern[]
  ): void {
    for (const [selector] of styleRules) {
      if (selector.includes(':hover')) {
        const base = selector.replace(/:hover$/, '').trim();
        for (const p of patterns) {
          if (p.type === 'css_transition' && p.selector === base) {
            p.trigger = 'hover';
            p.category = 'hover_effect';
          }
        }
      }
    }
  }

  private addStandaloneKeyframes(
    keyframesMap: Map<string, KeyframeStep[]>,
    patterns: MotionPattern[],
    hasReducedMotion: boolean,
    verbose: boolean
  ): void {
    for (const [name, steps] of keyframesMap) {
      if (patterns.some((p) => p.name === name)) continue;

      const properties = this.perfAnalyzer.extractPropertiesFromKeyframes(steps);
      const propertiesDetailed = this.perfAnalyzer.extractDetailedPropertiesFromKeyframes(steps);
      const pattern: MotionPattern = {
        id: uuidv7(),
        name,
        type: 'keyframes',
        category: this.classifier.inferCategory(name, '', properties, 1),
        trigger: 'unknown',
        duration: 0,
        easing: 'ease',
        properties,
        propertiesDetailed,
        performance: this.perfAnalyzer.analyzePerformance(properties),
        accessibility: { respectsReducedMotion: hasReducedMotion },
      };

      if (verbose) {
        pattern.keyframes = steps;
        pattern.rawCss = this.cssParser.generateKeyframesCss(name, steps);
      }
      patterns.push(pattern);
    }
  }

  private generateWarnings(
    patterns: MotionPattern[],
    hasReducedMotion: boolean,
    warnings: MotionWarning[]
  ): void {
    if (!hasReducedMotion && patterns.length > 0) {
      warnings.push({
        code: MOTION_WARNING_CODES.A11Y_NO_REDUCED_MOTION,
        severity: 'warning',
        message: 'prefers-reduced-motion is not configured',
        suggestion: 'Add @media (prefers-reduced-motion: reduce) to disable animations for users who prefer reduced motion',
      });
    }

    const infinite = patterns.filter((p) => p.iterations === 'infinite');
    if (infinite.length > 0) {
      warnings.push({
        code: MOTION_WARNING_CODES.A11Y_INFINITE_ANIMATION,
        severity: 'info',
        message: `${infinite.length} infinite animation(s) detected`,
        suggestion: 'Consider providing a way for users to pause or stop infinite animations',
      });
    }

    const layout = patterns.filter((p) => p.performance.triggersLayout);
    if (layout.length > 0) {
      warnings.push({
        code: MOTION_WARNING_CODES.PERF_LAYOUT_TRIGGER,
        severity: 'warning',
        message: `${layout.length} animation(s) trigger layout recalculation`,
        suggestion: 'Use transform and opacity for GPU-accelerated animations',
      });
    }

    if (patterns.length > 20) {
      warnings.push({
        code: MOTION_WARNING_CODES.PERF_TOO_MANY_ANIMATIONS,
        severity: 'warning',
        message: `${patterns.length} animations detected`,
        suggestion: 'Consider reducing the number of animations for better performance',
      });
    }
  }
}

let motionDetectorInstance: MotionDetectorService | null = null;

export function getMotionDetectorService(): MotionDetectorService {
  if (!motionDetectorInstance) motionDetectorInstance = new MotionDetectorService();
  return motionDetectorInstance;
}

export function resetMotionDetectorService(): void {
  motionDetectorInstance = null;
}
