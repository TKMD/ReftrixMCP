// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.search MCPツール
 * モーションパターンを類似検索します
 *
 * 機能:
 * - 自然言語クエリによる検索
 * - サンプルパターンによる類似検索
 * - フィルタリング（タイプ、duration範囲、トリガー）
 * - 類似度しきい値によるフィルタリング
 * - Phase3-3: コード生成機能の統合（action: 'generate'）
 *
 * @module tools/motion/search.tool
 */

import { logger, isDevelopment } from '../../utils/logger';

import {
  motionSearchInputSchema,
  MOTION_SEARCH_ERROR_CODES,
  MOTION_MCP_ERROR_CODES,
  type MotionSearchInput,
  type MotionSearchOutput,
  type MotionSearchResultItem,
  type MotionSearchQueryInfo,
  type MotionSearchFilters,
  type SamplePattern,
  type MotionPatternInput,
  type ImplementationFormat,
  type ImplementationOptions,
  type ImplementationMetadata,
  type JSAnimationFilters,
  type JSAnimationInfo,
  type WebGLAnimationFilters,
  type WebGLAnimationInfo,
  type GenerationOptions,
  type DuplicateCheckResult,
  type MotionImplementation,
  type MotionPattern,
  type MotionCategory,
} from './schemas';

import {
  ExistingAnimationDetectorService,
  type NewAnimationPattern,
} from '../../services/motion/existing-animation-detector.service';

// =====================================================
// 型定義
// =====================================================

export type { MotionSearchInput, MotionSearchOutput };

/**
 * 検索パラメータ
 */
export interface MotionSearchParams {
  query?: string | undefined;
  samplePattern?: SamplePattern | undefined;
  filters?: MotionSearchFilters | undefined;
  limit: number;
  minSimilarity: number;
  /** JSアニメーションを検索に含めるか（v0.1.0） */
  include_js_animations?: boolean;
  /** JSアニメーション検索フィルター（v0.1.0） */
  js_animation_filters?: JSAnimationFilters | undefined;
  /** WebGLアニメーションを検索に含めるか（v0.1.0） */
  include_webgl_animations?: boolean;
  /** WebGLアニメーション検索フィルター（v0.1.0） */
  webgl_animation_filters?: WebGLAnimationFilters | undefined;
  /** 検索結果に実装コードを含めるか（v0.1.0） */
  include_implementation?: boolean;
  /** 結果の多様性しきい値（v0.1.0、0.0-1.0、デフォルト: 0.3） */
  diversity_threshold?: number;
  /** カテゴリ分散を強制するか（v0.1.0、デフォルト: true） */
  ensure_category_diversity?: boolean;
}

/**
 * JSアニメーション検索結果アイテム
 * MotionSearchResultItemにJSアニメーション情報を追加
 */
export interface JSAnimationSearchResultItem extends Omit<MotionSearchResultItem, 'pattern'> {
  /** パターン情報 */
  pattern: MotionSearchResultItem['pattern'];
  /** JSアニメーション固有情報 */
  jsAnimationInfo?: JSAnimationInfo;
}

/**
 * WebGLアニメーション検索結果アイテム
 * MotionSearchResultItemにWebGLアニメーション情報を追加
 * v0.1.0
 */
export interface WebGLAnimationSearchResultItem extends Omit<MotionSearchResultItem, 'pattern'> {
  /** パターン情報 */
  pattern: MotionSearchResultItem['pattern'];
  /** WebGLアニメーション固有情報 */
  webglAnimationInfo?: WebGLAnimationInfo;
}

/**
 * 検索結果
 */
export interface MotionSearchResult {
  results: MotionSearchResultItem[];
  total: number;
  query?: MotionSearchQueryInfo;
}

// =====================================================
// サービスインターフェース（DI用）
// =====================================================

/**
 * モーション検索サービスインターフェース
 */
export interface IMotionSearchService {
  /**
   * モーションパターンを検索
   */
  search: (params: MotionSearchParams) => Promise<MotionSearchResult>;

  /**
   * ハイブリッド検索（ベクトル + 全文検索、RRFマージ）
   * 利用可能な場合に search() の代わりに使用される
   */
  searchHybrid?: (params: MotionSearchParams) => Promise<MotionSearchResult>;

  /**
   * テキストからEmbeddingを取得（オプショナル）
   */
  getEmbedding?: (text: string) => Promise<number[]>;
}

/**
 * コード生成結果インターフェース
 */
export interface GenerationResult {
  code: string;
  metadata: ImplementationMetadata;
}

/**
 * コード生成サービスインターフェース（Phase3-3統合用）
 */
export interface IMotionImplementationService {
  generate: (
    pattern: MotionPatternInput,
    format: ImplementationFormat,
    options: ImplementationOptions
  ) => GenerationResult | null;
}

/**
 * サービスファクトリ型
 */
type MotionSearchServiceFactory = () => IMotionSearchService;
type MotionImplementationServiceFactory = () => IMotionImplementationService | null;

let serviceFactory: MotionSearchServiceFactory | null = null;
let implementationServiceFactory: MotionImplementationServiceFactory | null = null;

/**
 * サービスファクトリを設定
 */
export function setMotionSearchServiceFactory(
  factory: MotionSearchServiceFactory
): void {
  serviceFactory = factory;
}

/**
 * サービスファクトリをリセット
 */
export function resetMotionSearchServiceFactory(): void {
  serviceFactory = null;
}

/**
 * コード生成サービスファクトリを設定（Phase3-3統合用）
 */
export function setMotionImplementationServiceFactory(
  factory: MotionImplementationServiceFactory
): void {
  implementationServiceFactory = factory;
}

/**
 * コード生成サービスファクトリをリセット
 */
export function resetMotionImplementationServiceFactory(): void {
  implementationServiceFactory = null;
}

// =====================================================
// デフォルトコード生成実装（Phase3-3統合用）
// =====================================================

/**
 * ミリ秒をCSS時間単位に変換
 */
function formatDuration(ms: number): string {
  if (ms >= 1000 && ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }
  return `${ms}ms`;
}

/**
 * キーフレームのパーセンテージを計算
 */
function offsetToPercent(offset: number): string {
  return `${Math.round(offset * 100)}%`;
}

/**
 * 行数をカウント
 */
function countLines(code: string): number {
  return code.split('\n').length;
}

/**
 * PascalCaseに変換
 */
function toPascalCase(str: string): string {
  return str
    .replace(/[-_](\w)/g, (_, c) => c.toUpperCase())
    .replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * CSS生成
 */
function generateCSS(
  pattern: MotionPatternInput,
  options: ImplementationOptions
): GenerationResult {
  const lines: string[] = [];
  const selector = options.selector || '.animated';
  const hasKeyframes = pattern.properties.some((p) => p.keyframes && p.keyframes.length > 0);

  // @keyframes 生成
  if (pattern.type !== 'transition') {
    lines.push(`@keyframes ${pattern.name} {`);

    if (hasKeyframes) {
      const allOffsets = new Set<number>();
      pattern.properties.forEach((prop) => {
        prop.keyframes?.forEach((kf) => allOffsets.add(kf.offset));
      });
      allOffsets.add(0);
      allOffsets.add(1);

      const sortedOffsets = Array.from(allOffsets).sort((a, b) => a - b);

      for (const offset of sortedOffsets) {
        lines.push(`  ${offsetToPercent(offset)} {`);
        for (const prop of pattern.properties) {
          const kf = prop.keyframes?.find((k) => k.offset === offset);
          if (kf) {
            lines.push(`    ${prop.name}: ${kf.value};`);
          } else if (offset === 0) {
            lines.push(`    ${prop.name}: ${prop.from};`);
          } else if (offset === 1) {
            lines.push(`    ${prop.name}: ${prop.to};`);
          }
        }
        lines.push('  }');
      }
    } else {
      lines.push('  from {');
      for (const prop of pattern.properties) {
        lines.push(`    ${prop.name}: ${prop.from};`);
      }
      lines.push('  }');
      lines.push('  to {');
      for (const prop of pattern.properties) {
        lines.push(`    ${prop.name}: ${prop.to};`);
      }
      lines.push('  }');
    }

    lines.push('}');
    lines.push('');

    // ベンダープレフィックス
    if (options.includeVendorPrefixes) {
      lines.push(`@-webkit-keyframes ${pattern.name} {`);
      if (hasKeyframes) {
        const allOffsets = new Set<number>();
        pattern.properties.forEach((prop) => {
          prop.keyframes?.forEach((kf) => allOffsets.add(kf.offset));
        });
        allOffsets.add(0);
        allOffsets.add(1);

        const sortedOffsets = Array.from(allOffsets).sort((a, b) => a - b);

        for (const offset of sortedOffsets) {
          lines.push(`  ${offsetToPercent(offset)} {`);
          for (const prop of pattern.properties) {
            const kf = prop.keyframes?.find((k) => k.offset === offset);
            if (kf) {
              lines.push(`    ${prop.name}: ${kf.value};`);
            } else if (offset === 0) {
              lines.push(`    ${prop.name}: ${prop.from};`);
            } else if (offset === 1) {
              lines.push(`    ${prop.name}: ${prop.to};`);
            }
          }
          lines.push('  }');
        }
      } else {
        lines.push('  from {');
        for (const prop of pattern.properties) {
          lines.push(`    ${prop.name}: ${prop.from};`);
        }
        lines.push('  }');
        lines.push('  to {');
        for (const prop of pattern.properties) {
          lines.push(`    ${prop.name}: ${prop.to};`);
        }
        lines.push('  }');
      }
      lines.push('}');
      lines.push('');
    }
  }

  // セレクタルール
  lines.push(`${selector} {`);

  if (pattern.type === 'transition') {
    const props = pattern.properties.map((p) => p.name).join(', ');
    lines.push(
      `  transition: ${props} ${formatDuration(pattern.duration)} ${pattern.easing};`
    );
    if (options.includeVendorPrefixes) {
      lines.push(
        `  -webkit-transition: ${props} ${formatDuration(pattern.duration)} ${pattern.easing};`
      );
    }
  } else {
    const iterations = pattern.iterations === 'infinite' ? 'infinite' : pattern.iterations;
    const animationValue = [
      pattern.name,
      formatDuration(pattern.duration),
      pattern.easing,
      pattern.delay > 0 ? formatDuration(pattern.delay) : null,
      iterations !== 1 ? iterations : null,
      pattern.direction !== 'normal' ? pattern.direction : null,
      pattern.fillMode !== 'none' ? pattern.fillMode : null,
    ]
      .filter(Boolean)
      .join(' ');

    lines.push(`  animation: ${animationValue};`);
    if (options.includeVendorPrefixes) {
      lines.push(`  -webkit-animation: ${animationValue};`);
    }
  }

  lines.push('}');

  // hover/scroll タイプの追加ルール
  if (pattern.type === 'hover') {
    lines.push('');
    lines.push(`${selector}:hover {`);
    for (const prop of pattern.properties) {
      lines.push(`  ${prop.name}: ${prop.to};`);
    }
    lines.push('}');
  }

  // prefers-reduced-motion
  if (options.includeReducedMotion) {
    lines.push('');
    lines.push('@media (prefers-reduced-motion: reduce) {');
    lines.push(`  ${selector} {`);
    if (pattern.type === 'transition') {
      lines.push('    transition: none;');
    } else {
      lines.push('    animation: none;');
    }
    lines.push('  }');
    lines.push('}');
  }

  const code = lines.join('\n');

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: pattern.type !== 'transition',
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: [],
    },
  };
}

/**
 * CSS Module生成
 */
function generateCSSModule(
  pattern: MotionPatternInput,
  options: ImplementationOptions
): GenerationResult {
  const result = generateCSS(pattern, {
    ...options,
    selector: `.${pattern.name}`,
  });

  return {
    ...result,
    metadata: {
      ...result.metadata,
      dependencies: [],
    },
  };
}

/**
 * Tailwind生成
 */
function generateTailwind(
  pattern: MotionPatternInput,
  options: ImplementationOptions
): GenerationResult {
  const lines: string[] = [];

  lines.push('/* Add to tailwind.config.js */');
  lines.push('module.exports = {');
  lines.push('  theme: {');
  lines.push('    extend: {');

  lines.push('      animation: {');
  const iterations = pattern.iterations === 'infinite' ? 'infinite' : '';
  const direction = pattern.direction !== 'normal' ? pattern.direction : '';
  lines.push(
    `        '${pattern.name}': '${pattern.name} ${formatDuration(pattern.duration)} ${pattern.easing} ${iterations} ${direction}'.trim(),`
  );
  lines.push('      },');

  lines.push('      keyframes: {');
  lines.push(`        '${pattern.name}': {`);

  if (pattern.properties.some((p) => p.keyframes && p.keyframes.length > 0)) {
    const allOffsets = new Set<number>();
    pattern.properties.forEach((prop) => {
      prop.keyframes?.forEach((kf) => allOffsets.add(kf.offset));
    });
    allOffsets.add(0);
    allOffsets.add(1);

    const sortedOffsets = Array.from(allOffsets).sort((a, b) => a - b);

    for (const offset of sortedOffsets) {
      lines.push(`          '${offsetToPercent(offset)}': {`);
      for (const prop of pattern.properties) {
        const kf = prop.keyframes?.find((k) => k.offset === offset);
        if (kf) {
          lines.push(`            ${prop.name}: '${kf.value}',`);
        } else if (offset === 0) {
          lines.push(`            ${prop.name}: '${prop.from}',`);
        } else if (offset === 1) {
          lines.push(`            ${prop.name}: '${prop.to}',`);
        }
      }
      lines.push('          },');
    }
  } else {
    lines.push("          '0%': {");
    for (const prop of pattern.properties) {
      lines.push(`            ${prop.name}: '${prop.from}',`);
    }
    lines.push('          },');
    lines.push("          '100%': {");
    for (const prop of pattern.properties) {
      lines.push(`            ${prop.name}: '${prop.to}',`);
    }
    lines.push('          },');
  }

  lines.push('        },');
  lines.push('      },');
  lines.push('    },');
  lines.push('  },');
  lines.push('};');
  lines.push('');
  lines.push('/* Usage in JSX */');
  lines.push(`<div className="animate-${pattern.name}">Content</div>`);

  if (options.includeReducedMotion) {
    lines.push('');
    lines.push('/* For reduced motion support */');
    lines.push(`<div className="animate-${pattern.name} motion-reduce:animate-none">Content</div>`);
  }

  const code = lines.join('\n');

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: true,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: ['tailwindcss'],
    },
  };
}

/**
 * styled-components生成
 */
function generateStyledComponents(
  pattern: MotionPatternInput,
  options: ImplementationOptions
): GenerationResult {
  const lines: string[] = [];
  const componentName = options.componentName || toPascalCase(pattern.name) + 'Animation';
  const ts = options.typescript ?? true;

  lines.push("import styled, { keyframes } from 'styled-components';");
  if (ts) {
    lines.push("import type { FC, ReactNode } from 'react';");
  }
  lines.push('');

  lines.push(`const ${pattern.name}Keyframes = keyframes\``);

  if (pattern.properties.some((p) => p.keyframes && p.keyframes.length > 0)) {
    const allOffsets = new Set<number>();
    pattern.properties.forEach((prop) => {
      prop.keyframes?.forEach((kf) => allOffsets.add(kf.offset));
    });
    allOffsets.add(0);
    allOffsets.add(1);

    const sortedOffsets = Array.from(allOffsets).sort((a, b) => a - b);

    for (const offset of sortedOffsets) {
      lines.push(`  ${offsetToPercent(offset)} {`);
      for (const prop of pattern.properties) {
        const kf = prop.keyframes?.find((k) => k.offset === offset);
        if (kf) {
          lines.push(`    ${prop.name}: ${kf.value};`);
        } else if (offset === 0) {
          lines.push(`    ${prop.name}: ${prop.from};`);
        } else if (offset === 1) {
          lines.push(`    ${prop.name}: ${prop.to};`);
        }
      }
      lines.push('  }');
    }
  } else {
    lines.push('  from {');
    for (const prop of pattern.properties) {
      lines.push(`    ${prop.name}: ${prop.from};`);
    }
    lines.push('  }');
    lines.push('  to {');
    for (const prop of pattern.properties) {
      lines.push(`    ${prop.name}: ${prop.to};`);
    }
    lines.push('  }');
  }

  lines.push('`;');
  lines.push('');

  const iterationsVal = pattern.iterations === 'infinite' ? 'infinite' : pattern.iterations;
  const directionVal = pattern.direction !== 'normal' ? pattern.direction : '';
  const fillModeVal = pattern.fillMode !== 'none' ? pattern.fillMode : '';

  lines.push(`const ${componentName}Container = styled.div\``);
  lines.push(
    `  animation: \${${pattern.name}Keyframes} ${formatDuration(pattern.duration)} ${pattern.easing}${pattern.delay > 0 ? ` ${formatDuration(pattern.delay)}` : ''}${iterationsVal !== 1 ? ` ${iterationsVal}` : ''}${directionVal ? ` ${directionVal}` : ''}${fillModeVal ? ` ${fillModeVal}` : ''};`
  );

  if (options.includeReducedMotion) {
    lines.push('');
    lines.push('  @media (prefers-reduced-motion: reduce) {');
    lines.push('    animation: none;');
    lines.push('  }');
  }

  lines.push('`;');
  lines.push('');

  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push('  children: ReactNode;');
    lines.push('  className?: string;');
    lines.push('}');
    lines.push('');
    lines.push(`export const ${componentName}: FC<${componentName}Props> = ({ children, className }) => {`);
  } else {
    lines.push(`export const ${componentName} = ({ children, className }) => {`);
  }
  lines.push(`  return <${componentName}Container className={className}>{children}</${componentName}Container>;`);
  lines.push('};');

  const code = lines.join('\n');

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: true,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: ['styled-components'],
    },
  };
}

/**
 * Emotion生成
 */
function generateEmotion(
  pattern: MotionPatternInput,
  options: ImplementationOptions
): GenerationResult {
  const lines: string[] = [];
  const componentName = options.componentName || toPascalCase(pattern.name) + 'Animation';
  const ts = options.typescript ?? true;

  lines.push("/** @jsxImportSource @emotion/react */");
  lines.push("import { css, keyframes } from '@emotion/react';");
  if (ts) {
    lines.push("import type { FC, ReactNode } from 'react';");
  }
  lines.push('');

  lines.push(`const ${pattern.name}Keyframes = keyframes\``);

  if (pattern.properties.some((p) => p.keyframes && p.keyframes.length > 0)) {
    const allOffsets = new Set<number>();
    pattern.properties.forEach((prop) => {
      prop.keyframes?.forEach((kf) => allOffsets.add(kf.offset));
    });
    allOffsets.add(0);
    allOffsets.add(1);

    const sortedOffsets = Array.from(allOffsets).sort((a, b) => a - b);

    for (const offset of sortedOffsets) {
      lines.push(`  ${offsetToPercent(offset)} {`);
      for (const prop of pattern.properties) {
        const kf = prop.keyframes?.find((k) => k.offset === offset);
        if (kf) {
          lines.push(`    ${prop.name}: ${kf.value};`);
        } else if (offset === 0) {
          lines.push(`    ${prop.name}: ${prop.from};`);
        } else if (offset === 1) {
          lines.push(`    ${prop.name}: ${prop.to};`);
        }
      }
      lines.push('  }');
    }
  } else {
    lines.push('  from {');
    for (const prop of pattern.properties) {
      lines.push(`    ${prop.name}: ${prop.from};`);
    }
    lines.push('  }');
    lines.push('  to {');
    for (const prop of pattern.properties) {
      lines.push(`    ${prop.name}: ${prop.to};`);
    }
    lines.push('  }');
  }

  lines.push('`;');
  lines.push('');

  const iterationsVal = pattern.iterations === 'infinite' ? 'infinite' : pattern.iterations;
  const directionVal = pattern.direction !== 'normal' ? pattern.direction : '';
  const fillModeVal = pattern.fillMode !== 'none' ? pattern.fillMode : '';

  lines.push(`const ${pattern.name}Style = css\``);
  lines.push(
    `  animation: \${${pattern.name}Keyframes} ${formatDuration(pattern.duration)} ${pattern.easing}${pattern.delay > 0 ? ` ${formatDuration(pattern.delay)}` : ''}${iterationsVal !== 1 ? ` ${iterationsVal}` : ''}${directionVal ? ` ${directionVal}` : ''}${fillModeVal ? ` ${fillModeVal}` : ''};`
  );

  if (options.includeReducedMotion) {
    lines.push('');
    lines.push('  @media (prefers-reduced-motion: reduce) {');
    lines.push('    animation: none;');
    lines.push('  }');
  }

  lines.push('`;');
  lines.push('');

  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push('  children: ReactNode;');
    lines.push('  className?: string;');
    lines.push('}');
    lines.push('');
    lines.push(`export const ${componentName}: FC<${componentName}Props> = ({ children, className }) => {`);
  } else {
    lines.push(`export const ${componentName} = ({ children, className }) => {`);
  }
  lines.push(`  return <div css={${pattern.name}Style} className={className}>{children}</div>;`);
  lines.push('};');

  const code = lines.join('\n');

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: true,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: ['@emotion/react'],
    },
  };
}

/**
 * Framer Motion生成
 */
function generateFramerMotion(
  pattern: MotionPatternInput,
  options: ImplementationOptions
): GenerationResult {
  const lines: string[] = [];
  const componentName = options.componentName || toPascalCase(pattern.name) + 'Motion';
  const ts = options.typescript ?? true;
  const isScroll = pattern.type === 'scroll';

  lines.push("import { motion } from 'framer-motion';");
  if (ts) {
    lines.push("import type { FC, ReactNode } from 'react';");
  }
  lines.push('');

  lines.push(`const ${pattern.name}Variants = {`);
  lines.push('  initial: {');
  for (const prop of pattern.properties) {
    const cssName = prop.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    lines.push(`    ${cssName}: ${JSON.stringify(prop.from)},`);
  }
  lines.push('  },');
  lines.push('  animate: {');
  for (const prop of pattern.properties) {
    const cssName = prop.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    lines.push(`    ${cssName}: ${JSON.stringify(prop.to)},`);
  }
  lines.push('  },');
  lines.push('};');
  lines.push('');

  lines.push(`const ${pattern.name}Transition = {`);
  lines.push(`  duration: ${pattern.duration / 1000},`);
  lines.push(`  ease: ${JSON.stringify(pattern.easing)},`);
  if (pattern.delay > 0) {
    lines.push(`  delay: ${pattern.delay / 1000},`);
  }
  if (pattern.iterations === 'infinite') {
    lines.push('  repeat: Infinity,');
  } else if (pattern.iterations > 1) {
    lines.push(`  repeat: ${pattern.iterations - 1},`);
  }
  if (pattern.direction === 'alternate' || pattern.direction === 'alternate-reverse') {
    lines.push("  repeatType: 'reverse',");
  }
  lines.push('};');
  lines.push('');

  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push('  children: ReactNode;');
    lines.push('  className?: string;');
    lines.push('}');
    lines.push('');
    lines.push(`export const ${componentName}: FC<${componentName}Props> = ({ children, className }) => {`);
  } else {
    lines.push(`export const ${componentName} = ({ children, className }) => {`);
  }
  lines.push('  return (');
  lines.push('    <motion.div');
  lines.push(`      variants={${pattern.name}Variants}`);
  lines.push('      initial="initial"');

  if (isScroll) {
    lines.push('      whileInView="animate"');
    lines.push('      viewport={{ once: true }}');
  } else {
    lines.push('      animate="animate"');
  }

  lines.push(`      transition={${pattern.name}Transition}`);
  lines.push('      className={className}');
  lines.push('    >');
  lines.push('      {children}');
  lines.push('    </motion.div>');
  lines.push('  );');
  lines.push('};');

  if (options.includeReducedMotion) {
    lines.push('');
    lines.push('/* Note: Framer Motion automatically respects prefers-reduced-motion */');
    lines.push('/* Set reducedMotion="user" in AnimatePresence or MotionConfig for custom handling */');
  }

  const code = lines.join('\n');

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: false,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: ['framer-motion'],
    },
  };
}

/**
 * GSAP生成
 */
function generateGSAP(
  pattern: MotionPatternInput,
  options: ImplementationOptions
): GenerationResult {
  const lines: string[] = [];
  const componentName = options.componentName || toPascalCase(pattern.name) + 'GSAP';
  const ts = options.typescript ?? true;
  const isScroll = pattern.type === 'scroll';

  lines.push("import { gsap } from 'gsap';");
  if (isScroll) {
    lines.push("import { ScrollTrigger } from 'gsap/ScrollTrigger';");
    lines.push('');
    lines.push('gsap.registerPlugin(ScrollTrigger);');
  }
  if (ts) {
    lines.push("import { useRef, useEffect } from 'react';");
    lines.push("import type { FC, ReactNode } from 'react';");
  } else {
    lines.push("import { useRef, useEffect } from 'react';");
  }
  lines.push('');

  lines.push(`const use${toPascalCase(pattern.name)}Animation = (ref${ts ? ': React.RefObject<HTMLDivElement>' : ''}) => {`);
  lines.push('  useEffect(() => {');
  lines.push('    if (!ref.current) return;');
  lines.push('');

  const toProps: string[] = [];
  for (const prop of pattern.properties) {
    const propName = prop.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    toProps.push(`      ${propName}: ${JSON.stringify(prop.to)}`);
  }

  const fromProps: string[] = [];
  for (const prop of pattern.properties) {
    const propName = prop.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    fromProps.push(`      ${propName}: ${JSON.stringify(prop.from)}`);
  }

  lines.push('    const animation = gsap.fromTo(');
  lines.push('      ref.current,');
  lines.push('      {');
  lines.push(fromProps.join(',\n'));
  lines.push('      },');
  lines.push('      {');
  lines.push(toProps.join(',\n') + ',');
  lines.push(`        duration: ${pattern.duration / 1000},`);
  lines.push(`        ease: ${JSON.stringify(pattern.easing)},`);
  if (pattern.delay > 0) {
    lines.push(`        delay: ${pattern.delay / 1000},`);
  }
  if (pattern.iterations === 'infinite') {
    lines.push('        repeat: -1,');
  } else if (pattern.iterations > 1) {
    lines.push(`        repeat: ${pattern.iterations - 1},`);
  }
  if (pattern.direction === 'alternate' || pattern.direction === 'alternate-reverse') {
    lines.push('        yoyo: true,');
  }

  if (isScroll) {
    lines.push('        scrollTrigger: {');
    lines.push('          trigger: ref.current,');
    lines.push("          start: 'top 80%',");
    lines.push("          end: 'bottom 20%',");
    lines.push("          toggleActions: 'play none none reverse',");
    lines.push('        },');
  }

  lines.push('      }');
  lines.push('    );');
  lines.push('');
  lines.push('    return () => {');
  lines.push('      animation.kill();');
  lines.push('    };');
  lines.push('  }, [ref]);');
  lines.push('};');
  lines.push('');

  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push('  children: ReactNode;');
    lines.push('  className?: string;');
    lines.push('}');
    lines.push('');
    lines.push(`export const ${componentName}: FC<${componentName}Props> = ({ children, className }) => {`);
  } else {
    lines.push(`export const ${componentName} = ({ children, className }) => {`);
  }
  lines.push(`  const ref = useRef${ts ? '<HTMLDivElement>' : ''}(null);`);
  lines.push(`  use${toPascalCase(pattern.name)}Animation(ref);`);
  lines.push('');
  lines.push('  return (');
  lines.push('    <div ref={ref} className={className}>');
  lines.push('      {children}');
  lines.push('    </div>');
  lines.push('  );');
  lines.push('};');

  if (options.includeReducedMotion) {
    lines.push('');
    lines.push('/* Add reduced motion check */');
    lines.push('// const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;');
    lines.push('// if (prefersReducedMotion) return;');
  }

  const code = lines.join('\n');
  const dependencies = isScroll ? ['gsap', 'gsap/ScrollTrigger'] : ['gsap'];

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: false,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies,
    },
  };
}

/**
 * Three.js (React Three Fiber) 生成
 *
 * @react-three/fiber を使用した3Dアニメーションコードを生成
 * - useFrame によるアニメーションループ
 * - scroll-driven アニメーション対応
 * - TypeScript 型定義付き
 */
function generateThreeJS(
  pattern: MotionPatternInput,
  options: ImplementationOptions
): GenerationResult {
  const lines: string[] = [];
  const componentName = options.componentName || toPascalCase(pattern.name) + 'Scene';
  const ts = options.typescript ?? true;
  const isScroll = pattern.type === 'scroll';

  // Imports
  lines.push("import { useRef } from 'react';");
  lines.push("import { Canvas, useFrame } from '@react-three/fiber';");
  if (isScroll) {
    lines.push("import { useScroll } from '@react-three/drei';");
  }
  if (ts) {
    lines.push("import type { FC } from 'react';");
    lines.push("import type { Mesh, Group } from 'three';");
  }
  lines.push('');

  // Extract animation properties and convert to Three.js-compatible values
  const positionProps = pattern.properties.filter((p) =>
    ['translateX', 'translateY', 'translateZ', 'x', 'y', 'z'].includes(p.name)
  );
  const rotationProps = pattern.properties.filter((p) =>
    ['rotateX', 'rotateY', 'rotateZ', 'rotate'].includes(p.name)
  );
  const scaleProps = pattern.properties.filter((p) =>
    ['scale', 'scaleX', 'scaleY', 'scaleZ'].includes(p.name)
  );
  const opacityProps = pattern.properties.filter((p) =>
    ['opacity'].includes(p.name)
  );

  // Helper function name
  const animatedObjectName = toPascalCase(pattern.name) + 'Object';

  // Animated Object Component
  if (ts) {
    lines.push(`interface ${animatedObjectName}Props {`);
    lines.push('  children?: React.ReactNode;');
    lines.push('}');
    lines.push('');
  }

  lines.push(`const ${animatedObjectName}${ts ? `: FC<${animatedObjectName}Props>` : ''} = ({ children }) => {`);
  lines.push(`  const meshRef = useRef${ts ? '<Mesh>' : ''}(null);`);

  if (isScroll) {
    lines.push('  const scroll = useScroll();');
    lines.push('');
    lines.push('  useFrame(() => {');
    lines.push('    if (!meshRef.current) return;');
    lines.push('    const progress = scroll.offset;');
  } else {
    lines.push(`  const duration = ${pattern.duration / 1000}; // seconds`);
    lines.push(`  const startTime = useRef${ts ? '<number>' : ''}(0);`);
    lines.push('');
    lines.push('  useFrame((state) => {');
    lines.push('    if (!meshRef.current) return;');
    lines.push('    if (startTime.current === 0) startTime.current = state.clock.elapsedTime;');
    lines.push('');
    lines.push('    const elapsed = state.clock.elapsedTime - startTime.current;');
    if (pattern.iterations === 'infinite') {
      lines.push('    const progress = (elapsed % duration) / duration;');
    } else {
      lines.push('    const progress = Math.min(elapsed / duration, 1);');
    }
  }

  lines.push('');

  // Apply easing
  lines.push('    // Apply easing function');
  lines.push(`    const eased = ease${toPascalCase(pattern.easing.replace(/[^a-zA-Z]/g, ''))}(progress);`);
  lines.push('');

  // Position animations
  if (positionProps.length > 0) {
    lines.push('    // Position animation');
    for (const prop of positionProps) {
      const axis = prop.name.replace(/translate|[XYZ]/gi, '').toLowerCase() ||
                   prop.name.charAt(prop.name.length - 1).toLowerCase();
      const fromVal = parseFloat(prop.from) || 0;
      const toVal = parseFloat(prop.to) || 0;
      lines.push(`    meshRef.current.position.${axis} = ${fromVal} + (${toVal} - ${fromVal}) * eased;`);
    }
  }

  // Rotation animations
  if (rotationProps.length > 0) {
    lines.push('    // Rotation animation');
    for (const prop of rotationProps) {
      const axis = prop.name.replace('rotate', '').toLowerCase() || 'y';
      const fromVal = parseFloat(prop.from) || 0;
      const toVal = parseFloat(prop.to) || Math.PI * 2;
      lines.push(`    meshRef.current.rotation.${axis} = ${fromVal} + (${toVal} - ${fromVal}) * eased;`);
    }
  }

  // Scale animations
  const scaleProp = scaleProps[0];
  if (scaleProp) {
    lines.push('    // Scale animation');
    const fromVal = parseFloat(scaleProp.from) || 1;
    const toVal = parseFloat(scaleProp.to) || 1;
    lines.push(`    const scaleValue = ${fromVal} + (${toVal} - ${fromVal}) * eased;`);
    lines.push('    meshRef.current.scale.setScalar(scaleValue);');
  }

  // Opacity animations (material)
  const opacityProp = opacityProps[0];
  if (opacityProp) {
    lines.push('    // Opacity animation');
    const fromVal = parseFloat(opacityProp.from) || 1;
    const toVal = parseFloat(opacityProp.to) || 0;
    lines.push(`    if (meshRef.current.material && 'opacity' in meshRef.current.material) {`);
    lines.push(`      (meshRef.current.material as any).opacity = ${fromVal} + (${toVal} - ${fromVal}) * eased;`);
    lines.push('    }');
  }

  lines.push('  });');
  lines.push('');
  lines.push('  return (');
  lines.push('    <mesh ref={meshRef}>');
  lines.push('      {children || (');
  lines.push('        <>');
  lines.push('          <boxGeometry args={[1, 1, 1]} />');
  lines.push('          <meshStandardMaterial color="#4f46e5" transparent />');
  lines.push('        </>');
  lines.push('      )}');
  lines.push('    </mesh>');
  lines.push('  );');
  lines.push('};');
  lines.push('');

  // Easing function
  lines.push('// Easing function');
  const easingName = `ease${toPascalCase(pattern.easing.replace(/[^a-zA-Z]/g, ''))}`;
  lines.push(`function ${easingName}(t${ts ? ': number' : ''})${ts ? ': number' : ''} {`);
  switch (pattern.easing) {
    case 'ease-in':
      lines.push('  return t * t;');
      break;
    case 'ease-out':
      lines.push('  return t * (2 - t);');
      break;
    case 'ease-in-out':
      lines.push('  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;');
      break;
    case 'linear':
      lines.push('  return t;');
      break;
    default:
      // Default to ease-out for unknown easing
      lines.push('  return t * (2 - t);');
  }
  lines.push('}');
  lines.push('');

  // Main Scene Component
  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push('  className?: string;');
    lines.push('}');
    lines.push('');
  }

  lines.push(`export const ${componentName}${ts ? `: FC<${componentName}Props>` : ''} = ({ className }) => {`);

  if (options.includeReducedMotion) {
    lines.push('  // Check for reduced motion preference');
    lines.push('  const prefersReducedMotion = typeof window !== "undefined"');
    lines.push('    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;');
    lines.push('');
    lines.push('  if (prefersReducedMotion) {');
    lines.push('    return (');
    lines.push('      <div className={className} style={{ width: "100%", height: "400px", background: "#1a1a2e" }}>');
    lines.push('        {/* Static fallback for reduced motion */}');
    lines.push('      </div>');
    lines.push('    );');
    lines.push('  }');
    lines.push('');
  }

  lines.push('  return (');
  lines.push('    <div className={className} style={{ width: "100%", height: "400px" }}>');
  lines.push('      <Canvas camera={{ position: [0, 0, 5], fov: 50 }}>');
  lines.push('        <ambientLight intensity={0.5} />');
  lines.push('        <pointLight position={[10, 10, 10]} />');
  lines.push(`        <${animatedObjectName} />`);
  lines.push('      </Canvas>');
  lines.push('    </div>');
  lines.push('  );');
  lines.push('};');

  const code = lines.join('\n');
  const dependencies = isScroll
    ? ['@react-three/fiber', '@react-three/drei', 'three']
    : ['@react-three/fiber', 'three'];

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: false,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies,
    },
  };
}

/**
 * Lottie (lottie-react) 生成
 *
 * lottie-react を使用したアニメーションコンポーネントを生成
 * - アニメーションデータ構造生成（Lottie JSON形式）
 * - React コンポーネントラッパー
 * - TypeScript 型定義付き
 */
function generateLottie(
  pattern: MotionPatternInput,
  options: ImplementationOptions
): GenerationResult {
  const lines: string[] = [];
  const componentName = options.componentName || toPascalCase(pattern.name) + 'Animation';
  const ts = options.typescript ?? true;

  // Imports
  lines.push("import Lottie from 'lottie-react';");
  if (ts) {
    lines.push("import type { FC } from 'react';");
    lines.push("import type { LottieComponentProps } from 'lottie-react';");
  }
  lines.push('');

  // Convert CSS animation properties to Lottie keyframes format
  // Note: This generates a simplified Lottie JSON structure
  lines.push('/**');
  lines.push(' * Lottie Animation Data');
  lines.push(' * Generated from CSS animation pattern.');
  lines.push(' * For complex animations, replace with actual Lottie JSON export from After Effects/Figma.');
  lines.push(' */');

  // Generate Lottie-like animation data structure
  const durationInFrames = Math.round((pattern.duration / 1000) * 60); // 60fps
  const startFrame = Math.round((pattern.delay / 1000) * 60);

  lines.push(`const ${pattern.name}AnimationData = {`);
  lines.push('  v: "5.7.8",');
  lines.push(`  fr: 60,`); // Frame rate
  lines.push(`  ip: ${startFrame},`); // In point
  lines.push(`  op: ${startFrame + durationInFrames},`); // Out point
  lines.push('  w: 200,'); // Width
  lines.push('  h: 200,'); // Height
  lines.push('  nm: "' + pattern.name + '",');
  lines.push('  ddd: 0,');
  lines.push('  assets: [],');
  lines.push('  layers: [');
  lines.push('    {');
  lines.push('      ddd: 0,');
  lines.push('      ind: 1,');
  lines.push('      ty: 4,'); // Shape layer
  lines.push(`      nm: "${pattern.name}",`);
  lines.push(`      sr: 1,`);
  lines.push('      ks: {'); // Transform

  // Opacity animation
  const opacityProp = pattern.properties.find((p) => p.name === 'opacity');
  if (opacityProp) {
    const fromOpacity = parseFloat(opacityProp.from) * 100 || 0;
    const toOpacity = parseFloat(opacityProp.to) * 100 || 100;
    lines.push('        o: {'); // Opacity
    lines.push('          a: 1,'); // Animated
    lines.push('          k: [');
    lines.push(`            { i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] }, t: ${startFrame}, s: [${fromOpacity}] },`);
    lines.push(`            { t: ${startFrame + durationInFrames}, s: [${toOpacity}] }`);
    lines.push('          ]');
    lines.push('        },');
  } else {
    lines.push('        o: { a: 0, k: 100 },');
  }

  // Position animation (transform: translate)
  const translateXProp = pattern.properties.find((p) => p.name === 'translateX');
  const translateYProp = pattern.properties.find((p) => p.name === 'translateY');
  if (translateXProp || translateYProp) {
    const fromX = translateXProp ? parseFloat(translateXProp.from) || 0 : 0;
    const toX = translateXProp ? parseFloat(translateXProp.to) || 0 : 0;
    const fromY = translateYProp ? parseFloat(translateYProp.from) || 0 : 0;
    const toY = translateYProp ? parseFloat(translateYProp.to) || 0 : 0;
    lines.push('        p: {'); // Position
    lines.push('          a: 1,');
    lines.push('          k: [');
    lines.push(`            { i: { x: 0.4, y: 1 }, o: { x: 0.6, y: 0 }, t: ${startFrame}, s: [${100 + fromX}, ${100 + fromY}, 0] },`);
    lines.push(`            { t: ${startFrame + durationInFrames}, s: [${100 + toX}, ${100 + toY}, 0] }`);
    lines.push('          ]');
    lines.push('        },');
  } else {
    lines.push('        p: { a: 0, k: [100, 100, 0] },');
  }

  // Scale animation
  const scaleProp = pattern.properties.find((p) => p.name === 'scale');
  if (scaleProp) {
    const fromScale = parseFloat(scaleProp.from) * 100 || 100;
    const toScale = parseFloat(scaleProp.to) * 100 || 100;
    lines.push('        s: {'); // Scale
    lines.push('          a: 1,');
    lines.push('          k: [');
    lines.push(`            { i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] }, t: ${startFrame}, s: [${fromScale}, ${fromScale}, 100] },`);
    lines.push(`            { t: ${startFrame + durationInFrames}, s: [${toScale}, ${toScale}, 100] }`);
    lines.push('          ]');
    lines.push('        },');
  } else {
    lines.push('        s: { a: 0, k: [100, 100, 100] },');
  }

  // Rotation animation
  const rotateProp = pattern.properties.find((p) => p.name === 'rotate');
  if (rotateProp) {
    const fromRotate = parseFloat(rotateProp.from) || 0;
    const toRotate = parseFloat(rotateProp.to) || 0;
    lines.push('        r: {'); // Rotation
    lines.push('          a: 1,');
    lines.push('          k: [');
    lines.push(`            { i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] }, t: ${startFrame}, s: [${fromRotate}] },`);
    lines.push(`            { t: ${startFrame + durationInFrames}, s: [${toRotate}] }`);
    lines.push('          ]');
    lines.push('        },');
  } else {
    lines.push('        r: { a: 0, k: 0 },');
  }

  lines.push('        a: { a: 0, k: [100, 100, 0] }'); // Anchor point
  lines.push('      },');

  // Shape contents (simple rectangle)
  lines.push('      shapes: [');
  lines.push('        {');
  lines.push('          ty: "rc",'); // Rectangle
  lines.push('          d: 1,');
  lines.push('          s: { a: 0, k: [100, 100] },'); // Size
  lines.push('          p: { a: 0, k: [0, 0] },'); // Position
  lines.push('          r: { a: 0, k: 8 },'); // Corner radius
  lines.push('          nm: "Rectangle"');
  lines.push('        },');
  lines.push('        {');
  lines.push('          ty: "fl",'); // Fill
  lines.push('          c: { a: 0, k: [0.31, 0.275, 0.898, 1] },'); // Color (#4f46e5)
  lines.push('          o: { a: 0, k: 100 },');
  lines.push('          nm: "Fill"');
  lines.push('        }');
  lines.push('      ],');
  lines.push(`      ip: ${startFrame},`);
  lines.push(`      op: ${startFrame + durationInFrames},`);
  lines.push('      st: 0');
  lines.push('    }');
  lines.push('  ]');
  lines.push('};');
  lines.push('');

  // React component
  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push('  className?: string;');
    lines.push('  loop?: boolean;');
    lines.push('  autoplay?: boolean;');
    lines.push('}');
    lines.push('');
  }

  lines.push(`export const ${componentName}${ts ? `: FC<${componentName}Props>` : ''} = ({`);
  lines.push('  className,');
  lines.push(`  loop = ${pattern.iterations === 'infinite'},`);
  lines.push('  autoplay = true,');
  lines.push('}) => {');

  if (options.includeReducedMotion) {
    lines.push('  // Check for reduced motion preference');
    lines.push('  const prefersReducedMotion = typeof window !== "undefined"');
    lines.push('    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;');
    lines.push('');
    lines.push('  if (prefersReducedMotion) {');
    lines.push('    return (');
    lines.push('      <div className={className} style={{ width: 200, height: 200 }}>');
    lines.push('        {/* Static fallback for reduced motion */}');
    lines.push('        <div style={{ width: 100, height: 100, background: "#4f46e5", borderRadius: 8, margin: "auto" }} />');
    lines.push('      </div>');
    lines.push('    );');
    lines.push('  }');
    lines.push('');
  }

  lines.push('  return (');
  lines.push('    <Lottie');
  lines.push(`      animationData={${pattern.name}AnimationData}`);
  lines.push('      loop={loop}');
  lines.push('      autoplay={autoplay}');
  lines.push('      className={className}');
  lines.push('      style={{ width: 200, height: 200 }}');
  lines.push('    />');
  lines.push('  );');
  lines.push('};');
  lines.push('');

  // Usage instructions
  lines.push('/**');
  lines.push(' * Usage:');
  lines.push(` * import { ${componentName} } from './path-to-component';`);
  lines.push(' *');
  lines.push(` * <${componentName} />`);
  lines.push(` * <${componentName} loop={false} autoplay={true} />`);
  lines.push(' *');
  lines.push(' * Note: For production use, export your animation from After Effects with');
  lines.push(' * Bodymovin plugin or from Figma, and replace the animationData above.');
  lines.push(' */');

  const code = lines.join('\n');

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: false,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: ['lottie-react'],
    },
  };
}

/**
 * メイン生成関数
 */
function generateImplementation(
  pattern: MotionPatternInput,
  format: ImplementationFormat,
  options: ImplementationOptions
): GenerationResult {
  switch (format) {
    case 'css':
      return generateCSS(pattern, options);
    case 'css-module':
      return generateCSSModule(pattern, options);
    case 'tailwind':
      return generateTailwind(pattern, options);
    case 'styled-components':
      return generateStyledComponents(pattern, options);
    case 'emotion':
      return generateEmotion(pattern, options);
    case 'framer-motion':
      return generateFramerMotion(pattern, options);
    case 'gsap':
      return generateGSAP(pattern, options);
    case 'three-js':
      return generateThreeJS(pattern, options);
    case 'lottie':
      return generateLottie(pattern, options);
    default:
      return generateCSS(pattern, options);
  }
}

// =====================================================
// 実装コード生成ヘルパー（v0.1.0: include_implementation用）
// =====================================================

/**
 * MotionTypeをMotionPatternInput用のtypeに変換
 * @param type MotionType
 * @returns MotionPatternInputType
 */
function mapMotionType(
  type: MotionPattern['type']
): MotionPatternInput['type'] {
  switch (type) {
    case 'css_animation':
    case 'library_animation':
    case 'video_motion':
      return 'animation';
    case 'css_transition':
      return 'transition';
    case 'keyframes':
      return 'keyframe';
    default:
      return 'animation';
  }
}

/**
 * MotionPatternからMotionPatternInputに変換
 * @param pattern 検索結果のパターン
 * @returns コード生成用のパターン入力
 */
function patternToPatternInput(pattern: MotionPattern): MotionPatternInput {
  // animationオブジェクトから値を抽出、easingはオブジェクトの可能性あり
  const duration = pattern.animation?.duration ?? 300;
  const easingConfig = pattern.animation?.easing;
  // easingConfigがオブジェクトの場合はtypeまたはcubicBezierを使用
  let easing = 'ease';
  if (easingConfig) {
    if (easingConfig.cubicBezier) {
      easing = `cubic-bezier(${easingConfig.cubicBezier.join(', ')})`;
    } else if (easingConfig.type && easingConfig.type !== 'cubic-bezier') {
      easing = easingConfig.type;
    }
  }
  const delay = pattern.animation?.delay ?? 0;
  const iterations = pattern.animation?.iterations ?? 1;
  const direction = pattern.animation?.direction ?? 'normal';
  const fillMode = pattern.animation?.fillMode ?? 'none';

  return {
    type: mapMotionType(pattern.type),
    name: pattern.name ?? 'unnamed',
    duration,
    delay,
    easing,
    iterations,
    direction,
    fillMode,
    // propertiesのpropertyをnameに変換
    properties: pattern.properties?.map((p) => ({
      name: p.property ?? 'opacity',
      from: String(p.from ?? '0'),
      to: String(p.to ?? '1'),
    })) ?? [{ name: 'opacity', from: '0', to: '1' }],
  };
}

/**
 * 検索結果のパターンから実装コード情報を生成
 * @param pattern 検索結果のパターン
 * @returns 実装コード情報
 */
function generateImplementationForPattern(
  pattern: MotionPattern
): MotionImplementation {
  const patternInput = patternToPatternInput(pattern);
  const implementation: MotionImplementation = {};

  // transitionタイプの場合（css_transition）
  if (pattern.type === 'css_transition') {
    const props = patternInput.properties.map((p) => p.name).join(', ');
    implementation.transition = `transition: ${props} ${formatDuration(patternInput.duration)} ${patternInput.easing};`;
    return implementation;
  }

  // animation/@keyframesタイプの場合
  // @keyframes生成
  const keyframeLines: string[] = [];
  keyframeLines.push(`@keyframes ${pattern.name} {`);
  keyframeLines.push('  from {');
  for (const prop of patternInput.properties) {
    keyframeLines.push(`    ${prop.name}: ${prop.from};`);
  }
  keyframeLines.push('  }');
  keyframeLines.push('  to {');
  for (const prop of patternInput.properties) {
    keyframeLines.push(`    ${prop.name}: ${prop.to};`);
  }
  keyframeLines.push('  }');
  keyframeLines.push('}');
  implementation.keyframes = keyframeLines.join('\n');

  // animationプロパティ生成
  implementation.animation = `animation: ${pattern.name} ${formatDuration(patternInput.duration)} ${patternInput.easing};`;

  // Tailwindクラス生成
  implementation.tailwind = `animate-${pattern.name}`;

  return implementation;
}

// =====================================================
// 多様性フィルタリング (MMR強化)
// =====================================================

/**
 * 2つの文字列の類似度を計算（Levenshtein距離ベース）
 * @param a 比較元文字列
 * @param b 比較先文字列
 * @returns 類似度 (0.0-1.0)
 */
function calculateNameSimilarity(a: string | undefined, b: string | undefined): number {
  if (!a || !b) {
    return 0;
  }
  const normalizedA = a.toLowerCase().replace(/[-_\s]/g, '');
  const normalizedB = b.toLowerCase().replace(/[-_\s]/g, '');

  if (normalizedA === normalizedB) {
    return 1.0;
  }

  // 共通のプレフィックスをチェック（例: fadeIn, fadeInUp → 高い類似度）
  let commonPrefixLen = 0;
  const minLen = Math.min(normalizedA.length, normalizedB.length);
  for (let i = 0; i < minLen; i++) {
    if (normalizedA[i] === normalizedB[i]) {
      commonPrefixLen++;
    } else {
      break;
    }
  }

  // プレフィックス類似度（4文字以上の共通プレフィックスで高い類似度）
  if (commonPrefixLen >= 4) {
    return 0.6 + 0.4 * (commonPrefixLen / Math.max(normalizedA.length, normalizedB.length));
  }

  // 部分文字列チェック
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) {
    return 0.7;
  }

  return 0;
}

/**
 * 2つのモーションパターン間の類似度を計算
 * 名前、カテゴリ、トリガー、アニメーション設定を比較
 * @param a 比較元パターン
 * @param b 比較先パターン
 * @returns 類似度 (0.0-1.0)
 */
function calculatePatternSimilarity(
  a: MotionSearchResultItem,
  b: MotionSearchResultItem
): number {
  let similarityScore = 0;
  let weightTotal = 0;

  // 名前の類似度 (重み: 0.25) - v0.1.0追加
  const nameWeight = 0.25;
  const nameSimilarity = calculateNameSimilarity(a.pattern.name, b.pattern.name);
  similarityScore += nameWeight * nameSimilarity;
  weightTotal += nameWeight;

  // カテゴリの一致 (重み: 0.25)
  const categoryWeight = 0.25;
  if (a.pattern.category === b.pattern.category) {
    similarityScore += categoryWeight;
  }
  weightTotal += categoryWeight;

  // トリガーの一致 (重み: 0.15)
  const triggerWeight = 0.15;
  if (a.pattern.trigger === b.pattern.trigger) {
    similarityScore += triggerWeight;
  }
  weightTotal += triggerWeight;

  // タイプの一致 (重み: 0.1)
  const typeWeight = 0.1;
  if (a.pattern.type === b.pattern.type) {
    similarityScore += typeWeight;
  }
  weightTotal += typeWeight;

  // duration類似度 (重み: 0.1)
  const durationWeight = 0.1;
  const durationA = a.pattern.animation?.duration ?? 0;
  const durationB = b.pattern.animation?.duration ?? 0;
  if (durationA > 0 && durationB > 0) {
    const durationRatio = Math.min(durationA, durationB) / Math.max(durationA, durationB);
    similarityScore += durationWeight * durationRatio;
  } else if (durationA === 0 && durationB === 0) {
    similarityScore += durationWeight;
  }
  weightTotal += durationWeight;

  // easing類似度 (重み: 0.075)
  const easingWeight = 0.075;
  const easingA = a.pattern.animation?.easing?.type ?? 'unknown';
  const easingB = b.pattern.animation?.easing?.type ?? 'unknown';
  if (easingA === easingB) {
    similarityScore += easingWeight;
  }
  weightTotal += easingWeight;

  // プロパティ類似度 (重み: 0.075)
  const propertiesWeight = 0.075;
  const propsA = new Set(a.pattern.properties?.map((p) => p.property) ?? []);
  const propsB = new Set(b.pattern.properties?.map((p) => p.property) ?? []);
  if (propsA.size > 0 && propsB.size > 0) {
    const intersection = [...propsA].filter((p) => propsB.has(p)).length;
    const union = new Set([...propsA, ...propsB]).size;
    similarityScore += propertiesWeight * (intersection / union);
  } else if (propsA.size === 0 && propsB.size === 0) {
    similarityScore += propertiesWeight;
  }
  weightTotal += propertiesWeight;

  return weightTotal > 0 ? similarityScore / weightTotal : 0;
}

/**
 * MMR (Maximal Marginal Relevance) アルゴリズムで多様性フィルタリングを適用
 *
 * MMRスコア = λ * relevance - (1-λ) * max_similarity_to_selected
 *
 * @param results 検索結果配列（類似度順）
 * @param lambda λ値（0.0-1.0）- 0.0で最大多様性、1.0で関連度のみ
 * @param ensureCategoryDiversity カテゴリ分散を強制するか
 * @param limit 最大結果数
 * @returns フィルタリング後の検索結果
 */
function applyDiversityFilter(
  results: MotionSearchResultItem[],
  lambda: number,
  ensureCategoryDiversity: boolean,
  limit: number
): MotionSearchResultItem[] {
  if (results.length === 0) {
    return results;
  }

  // λ=1.0 の場合、多様性フィルタなし（関連度順のまま）
  if (lambda >= 1.0) {
    return results.slice(0, limit);
  }

  // λ=0.0 かつ ensureCategoryDiversity=false の場合、類似度順でフィルタリングのみ
  // ただし、同一名パターンは除外
  if (lambda <= 0.0 && !ensureCategoryDiversity) {
    const selected: MotionSearchResultItem[] = [];
    const usedNames = new Set<string>();

    for (const result of results) {
      if (selected.length >= limit) break;

      const name = result.pattern.name?.toLowerCase() ?? '';
      if (!usedNames.has(name)) {
        selected.push(result);
        if (name) usedNames.add(name);
      }
    }
    return selected;
  }

  // MMRアルゴリズムによる選択
  const selected: MotionSearchResultItem[] = [];
  const remaining = [...results];
  const usedCategories = new Map<MotionCategory, number>();

  while (remaining.length > 0 && selected.length < limit) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      if (!candidate) continue;

      // 関連度スコア（検索結果の類似度）
      const relevance = candidate.similarity;

      // 選択済み結果との最大類似度を計算
      let maxSimilarityToSelected = 0;
      for (const sel of selected) {
        const sim = calculatePatternSimilarity(sel, candidate);
        if (sim > maxSimilarityToSelected) {
          maxSimilarityToSelected = sim;
        }
      }

      // MMRスコア計算: λ * relevance - (1-λ) * max_similarity_to_selected
      let mmrScore = lambda * relevance - (1 - lambda) * maxSimilarityToSelected;

      // カテゴリ分散ボーナス（ensureCategoryDiversity=true の場合）
      if (ensureCategoryDiversity) {
        const category = candidate.pattern.category;
        const categoryCount = usedCategories.get(category) ?? 0;

        // 未使用カテゴリにはボーナス
        if (categoryCount === 0) {
          mmrScore += 0.1;
        } else if (categoryCount >= 2) {
          // 同一カテゴリ3件以上は大きくペナルティ
          mmrScore -= 0.2 * categoryCount;
        }
      }

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    // 最良候補を選択
    const chosenItem = remaining.splice(bestIdx, 1)[0];
    if (!chosenItem) break;
    selected.push(chosenItem);

    // カテゴリカウントを更新
    const category = chosenItem.pattern.category;
    usedCategories.set(category, (usedCategories.get(category) ?? 0) + 1);
  }

  if (isDevelopment()) {
    logger.info('[MCP Tool] motion.search MMR diversity filter applied', {
      originalCount: results.length,
      filteredCount: selected.length,
      lambda,
      ensureCategoryDiversity,
      categoryDistribution: Object.fromEntries(usedCategories),
    });
  }

  return selected;
}

/**
 * 検索結果に実装コードを付与
 * @param results 検索結果配列
 * @returns 実装コードが付与された検索結果
 */
function enrichResultsWithImplementation(
  results: MotionSearchResultItem[]
): MotionSearchResultItem[] {
  return results.map((result) => ({
    ...result,
    implementation: generateImplementationForPattern(result.pattern),
  }));
}

// =====================================================
// ハンドラー
// =====================================================

/**
 * motion.search ツールハンドラー
 *
 * Phase3-3: action パラメータによる機能統合
 * - action: 'search' (デフォルト) → 検索機能
 * - action: 'generate' → コード生成機能
 */
export async function motionSearchHandler(
  input: unknown
): Promise<MotionSearchOutput> {
  if (isDevelopment()) {
    logger.info('[MCP Tool] motion.search called', {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: MotionSearchInput;
  try {
    validated = motionSearchInputSchema.parse(input);
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] motion.search validation error', { error });
    }
    return {
      success: false,
      error: {
        code: MOTION_SEARCH_ERROR_CODES.VALIDATION_ERROR,
        message: error instanceof Error ? error.message : 'Invalid input',
      },
    };
  }

  // Phase3-3: action分岐
  const action = validated.action ?? 'search';

  if (action === 'generate') {
    // コード生成処理
    return handleGenerateAction(validated);
  }

  // 検索処理（既存ロジック）
  return handleSearchAction(validated);
}

/**
 * action: 'search' の処理
 */
async function handleSearchAction(
  validated: MotionSearchInput
): Promise<MotionSearchOutput> {
  // サービスファクトリのチェック
  if (!serviceFactory) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] motion.search service factory not set');
    }
    return {
      success: false,
      error: {
        code: MOTION_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: 'Motion search service is not available',
      },
    };
  }

  try {
    const service = serviceFactory();

    // 検索パラメータを構築（v0.1.0: JSアニメーション検索パラメータ追加、v0.1.0: WebGLアニメーション検索パラメータ追加、v0.1.0: include_implementation追加）
    const searchParams: MotionSearchParams = {
      query: validated.query,
      samplePattern: validated.samplePattern,
      filters: validated.filters,
      limit: validated.limit,
      minSimilarity: validated.minSimilarity,
      include_js_animations: validated.include_js_animations,
      js_animation_filters: validated.js_animation_filters,
      include_webgl_animations: validated.include_webgl_animations,
      webgl_animation_filters: validated.webgl_animation_filters,
      include_implementation: validated.include_implementation,
    };

    if (isDevelopment()) {
      logger.info('[MCP Tool] motion.search executing search', {
        hasQuery: !!searchParams.query,
        hasSamplePattern: !!searchParams.samplePattern,
        hasFilters: !!searchParams.filters,
        limit: searchParams.limit,
        minSimilarity: searchParams.minSimilarity,
        includeJsAnimations: searchParams.include_js_animations,
        hasJsAnimationFilters: !!searchParams.js_animation_filters,
        includeWebglAnimations: searchParams.include_webgl_animations,
        hasWebglAnimationFilters: !!searchParams.webgl_animation_filters,
        includeImplementation: searchParams.include_implementation,
        diversityThreshold: validated.diversity_threshold ?? 0.3,
        ensureCategoryDiversity: validated.ensure_category_diversity ?? true,
      });
    }

    // 検索実行（ハイブリッド検索優先）
    const searchResult = service.searchHybrid
      ? await service.searchHybrid(searchParams)
      : await service.search(searchParams);

    // v0.1.0: 多様性フィルタリングを適用
    const diversityThreshold = validated.diversity_threshold ?? 0.3;
    const ensureCategoryDiversity = validated.ensure_category_diversity ?? true;
    const diverseResults = applyDiversityFilter(
      searchResult.results,
      diversityThreshold,
      ensureCategoryDiversity,
      validated.limit
    );

    // v0.1.0: include_implementation が true の場合、実装コードを付与
    const results = validated.include_implementation
      ? enrichResultsWithImplementation(diverseResults)
      : diverseResults;

    if (isDevelopment()) {
      logger.info('[MCP Tool] motion.search completed', {
        resultsCount: results.length,
        originalCount: searchResult.results.length,
        total: searchResult.total,
        includeImplementation: validated.include_implementation,
        diversityThreshold,
        ensureCategoryDiversity,
      });
    }

    return {
      success: true,
      data: {
        results,
        total: searchResult.total,
        query: searchResult.query,
      },
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] motion.search error', { error });
    }

    // エラータイプに基づいてエラーコードを決定
    const errorCode =
      error instanceof Error && error.message.includes('Embedding')
        ? MOTION_SEARCH_ERROR_CODES.EMBEDDING_ERROR
        : MOTION_SEARCH_ERROR_CODES.SEARCH_ERROR;

    return {
      success: false,
      error: {
        code: errorCode,
        message: error instanceof Error ? error.message : 'Search failed',
      },
    };
  }
}

/**
 * action: 'generate' の処理（Phase3-3統合）
 * v0.1.0: 重複検出機能追加
 */
async function handleGenerateAction(
  validated: MotionSearchInput
): Promise<MotionSearchOutput> {
  if (isDevelopment()) {
    logger.info('[MCP Tool] motion.search action: generate', {
      hasPattern: !!validated.pattern,
      format: validated.format,
      checkDuplicates: validated.generation_options?.check_duplicates,
    });
  }

  // pattern が必須
  if (!validated.pattern) {
    return {
      success: false,
      error: {
        code: MOTION_MCP_ERROR_CODES.VALIDATION_ERROR,
        message: 'action: generate には pattern パラメータが必要です',
      },
    };
  }

  try {
    const pattern = validated.pattern;
    const format = validated.format ?? 'css';
    const options: ImplementationOptions = {
      selector: validated.options?.selector ?? '.animated',
      includeVendorPrefixes: validated.options?.includeVendorPrefixes ?? false,
      includeReducedMotion: validated.options?.includeReducedMotion ?? true,
      typescript: validated.options?.typescript ?? true,
      componentName: validated.options?.componentName,
    };
    const generationOptions = validated.generation_options;

    // v0.1.0: 重複チェック実行
    let duplicateCheckResult: DuplicateCheckResult | undefined;

    if (generationOptions?.check_duplicates) {
      try {
        duplicateCheckResult = await performDuplicateCheck(pattern, generationOptions);

        if (isDevelopment()) {
          logger.info('[MCP Tool] motion.search duplicate check completed', {
            hasDuplicates: duplicateCheckResult.has_duplicates,
            matchCount: duplicateCheckResult.existing_matches.length,
          });
        }
      } catch (error) {
        if (isDevelopment()) {
          logger.warn('[MCP Tool] motion.search duplicate check failed, continuing generation', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
        // 重複チェック失敗時は警告のみでコード生成は続行
      }
    }

    // サービス経由で生成（DIパターン）
    let result: GenerationResult | null = null;
    const service = implementationServiceFactory?.();

    if (service?.generate) {
      try {
        result = service.generate(pattern, format, options);
      } catch (error) {
        if (isDevelopment()) {
          logger.error('[MCP Tool] motion.search generate service error', { error });
        }
        return {
          success: false,
          error: {
            code: MOTION_MCP_ERROR_CODES.INTERNAL_ERROR,
            message: error instanceof Error ? error.message : 'Generation failed',
          },
        };
      }
    } else {
      // デフォルト実装
      result = generateImplementation(pattern, format, options);
    }

    if (!result) {
      return {
        success: false,
        error: {
          code: MOTION_MCP_ERROR_CODES.INTERNAL_ERROR,
          message: 'Generation returned null',
        },
      };
    }

    if (isDevelopment()) {
      logger.info('[MCP Tool] motion.search generate completed', {
        format,
        linesOfCode: result.metadata.linesOfCode,
        hasDuplicateCheck: !!duplicateCheckResult,
      });
    }

    return {
      success: true,
      data: {
        code: result.code,
        format,
        metadata: result.metadata,
        duplicate_check: duplicateCheckResult,
      },
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[MCP Tool] motion.search generate error', { error });
    }
    return {
      success: false,
      error: {
        code: MOTION_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Generation failed',
      },
    };
  }
}

/**
 * 重複チェックを実行
 * v0.1.0: ExistingAnimationDetectorServiceを使用
 */
async function performDuplicateCheck(
  pattern: MotionPatternInput,
  generationOptions: GenerationOptions
): Promise<DuplicateCheckResult> {
  const detector = new ExistingAnimationDetectorService();

  // MotionPatternInput を NewAnimationPattern に変換
  const newPattern: NewAnimationPattern = {
    name: pattern.name,
    type: pattern.type,
    duration: pattern.duration,
    easing: pattern.easing,
    properties: pattern.properties.map((p) => {
      const prop: NewAnimationPattern['properties'][number] = {
        name: p.name,
        from: p.from,
        to: p.to,
      };
      // keyframesがundefinedでない場合のみ設定
      if (p.keyframes) {
        prop.keyframes = p.keyframes;
      }
      return prop;
    }),
  };

  // オプションを構築（undefinedフィールドを除外）
  const checkOptions: {
    projectCSSPath?: string;
    projectCSSPaths?: string[];
    similarityThreshold?: number;
  } = {
    similarityThreshold: generationOptions.similarity_threshold,
  };

  if (generationOptions.project_css_path) {
    checkOptions.projectCSSPath = generationOptions.project_css_path;
  }
  if (generationOptions.project_css_paths) {
    checkOptions.projectCSSPaths = generationOptions.project_css_paths;
  }

  const result = await detector.checkDuplicates(newPattern, checkOptions);

  // DuplicateCheckResult スキーマ形式に変換
  return {
    has_duplicates: result.hasDuplicates,
    existing_matches: result.existingMatches.map((match) => ({
      animation_name: match.animationName,
      file_path: match.filePath,
      similarity: match.similarity,
      suggestion: match.suggestion,
    })),
    warnings: result.warnings,
  };
}

// =====================================================
// ツール定義
// =====================================================

export const motionSearchToolDefinition = {
  name: 'motion.search',
  description:
    'モーションパターンを類似検索、または実装コードを生成します。action: search（デフォルト）で検索、action: generateでCSS/JS実装コードを生成します。',
  annotations: {
    title: 'Motion Search',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      // Phase3-3: action parameter for consolidation
      action: {
        type: 'string',
        enum: ['search', 'generate'],
        default: 'search',
        description:
          'アクション: search（デフォルト）= モーション検索、generate = 実装コード生成',
      },
      // === Search parameters (action: search) ===
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: '検索クエリ（自然言語、1-500文字）。action: searchで使用。',
      },
      samplePattern: {
        type: 'object',
        description: 'サンプルパターンで類似検索。action: searchで使用。',
        properties: {
          type: {
            type: 'string',
            enum: ['animation', 'transition', 'transform', 'scroll', 'hover', 'keyframe'],
            description: 'モーションタイプ',
          },
          duration: {
            type: 'number',
            minimum: 0,
            description: 'アニメーション時間（ms）',
          },
          easing: {
            type: 'string',
            description: 'イージング関数',
          },
          properties: {
            type: 'array',
            items: { type: 'string' },
            description: 'アニメーション対象プロパティ',
          },
        },
      },
      filters: {
        type: 'object',
        description: '検索フィルター。action: searchで使用。',
        properties: {
          type: {
            type: 'string',
            enum: ['animation', 'transition', 'transform', 'scroll', 'hover', 'keyframe'],
            description: 'タイプでフィルタリング',
          },
          minDuration: {
            type: 'number',
            minimum: 0,
            description: '最小duration（ms）',
          },
          maxDuration: {
            type: 'number',
            minimum: 0,
            description: '最大duration（ms）',
          },
          trigger: {
            type: 'string',
            enum: ['load', 'hover', 'scroll', 'click', 'focus', 'custom'],
            description: 'トリガーでフィルタリング',
          },
        },
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: '結果制限（1-50、デフォルト: 10）。action: searchで使用。',
      },
      minSimilarity: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        default: 0.5,
        description: '最小類似度しきい値（0-1、デフォルト: 0.5）。action: searchで使用。',
      },
      // === JSAnimation search parameters (v0.1.0) ===
      include_js_animations: {
        type: 'boolean',
        default: true,
        description:
          'JSアニメーションパターンを検索結果に含める（デフォルト: true）。action: searchで使用。',
      },
      js_animation_filters: {
        type: 'object',
        description: 'JSアニメーション検索フィルター。action: searchで使用。',
        properties: {
          libraryType: {
            type: 'string',
            enum: [
              'gsap',
              'framer_motion',
              'anime_js',
              'three_js',
              'lottie',
              'web_animations_api',
              'unknown',
            ],
            description:
              'ライブラリタイプでフィルタリング（gsap, framer_motion, anime_js, three_js, lottie, web_animations_api, unknown）',
          },
          animationType: {
            type: 'string',
            enum: [
              'tween',
              'timeline',
              'spring',
              'physics',
              'keyframe',
              'morphing',
              'path',
              'scroll_driven',
              'gesture',
            ],
            description:
              'アニメーションタイプでフィルタリング（tween, timeline, spring, physics, keyframe, morphing, path, scroll_driven, gesture）',
          },
        },
      },
      // === WebGLAnimation search parameters (v0.1.0) ===
      include_webgl_animations: {
        type: 'boolean',
        default: true,
        description:
          'WebGLアニメーションパターンを検索結果に含める（デフォルト: true）。action: searchで使用。',
      },
      webgl_animation_filters: {
        type: 'object',
        description: 'WebGLアニメーション検索フィルター。action: searchで使用。',
        properties: {
          category: {
            type: 'string',
            enum: [
              'fade',
              'pulse',
              'wave',
              'particle',
              'morph',
              'rotation',
              'parallax',
              'noise',
              'complex',
            ],
            description:
              'カテゴリでフィルタリング（fade, pulse, wave, particle, morph, rotation, parallax, noise, complex）',
          },
          detectedLibrary: {
            type: 'string',
            description: '検出されたライブラリでフィルタリング（例: three.js, babylon.js）',
          },
          minConfidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: '最小信頼度しきい値（0-1）',
          },
        },
      },
      // === Implementation code parameter (v0.1.0) ===
      include_implementation: {
        type: 'boolean',
        default: false,
        description:
          '検索結果に実装コード（@keyframes, animation, tailwindクラス）を含める（デフォルト: false）。action: searchで使用。',
      },
      // === Generate parameters (action: generate) ===
      pattern: {
        type: 'object',
        description: 'モーションパターン定義。action: generateで必須。',
        properties: {
          type: {
            type: 'string',
            enum: ['animation', 'transition', 'transform', 'scroll', 'hover', 'keyframe'],
            description: 'パターンタイプ',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'アニメーション名（1-100文字）',
          },
          properties: {
            type: 'array',
            minItems: 1,
            description: 'アニメーション対象プロパティ',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'CSSプロパティ名' },
                from: { type: 'string', description: '開始値' },
                to: { type: 'string', description: '終了値' },
                keyframes: {
                  type: 'array',
                  description: '中間キーフレーム（オプション）',
                  items: {
                    type: 'object',
                    properties: {
                      offset: { type: 'number', minimum: 0, maximum: 1 },
                      value: { type: 'string' },
                    },
                  },
                },
              },
              required: ['name', 'from', 'to'],
            },
          },
          duration: {
            type: 'number',
            minimum: 0,
            maximum: 60000,
            default: 300,
            description: 'アニメーション時間（ms、デフォルト: 300）',
          },
          delay: {
            type: 'number',
            minimum: 0,
            maximum: 60000,
            default: 0,
            description: '遅延時間（ms、デフォルト: 0）',
          },
          easing: {
            type: 'string',
            default: 'ease',
            description: 'イージング関数（デフォルト: ease）',
          },
          iterations: {
            oneOf: [
              { type: 'number', minimum: 1 },
              { type: 'string', enum: ['infinite'] },
            ],
            default: 1,
            description: '繰り返し回数（デフォルト: 1、またはinfinite）',
          },
          direction: {
            type: 'string',
            enum: ['normal', 'reverse', 'alternate', 'alternate-reverse'],
            default: 'normal',
            description: 'アニメーション方向（デフォルト: normal）',
          },
          fillMode: {
            type: 'string',
            enum: ['none', 'forwards', 'backwards', 'both'],
            default: 'none',
            description: 'フィルモード（デフォルト: none）',
          },
        },
        required: ['type', 'name', 'properties'],
      },
      format: {
        type: 'string',
        enum: ['css', 'css-module', 'tailwind', 'styled-components', 'emotion', 'framer-motion', 'gsap'],
        default: 'css',
        description: '出力フォーマット（デフォルト: css）。action: generateで使用。',
      },
      options: {
        type: 'object',
        description: '生成オプション。action: generateで使用。',
        properties: {
          selector: {
            type: 'string',
            default: '.animated',
            description: 'CSSセレクタ（デフォルト: .animated）',
          },
          componentName: {
            type: 'string',
            description: 'コンポーネント名（JSライブラリ用、省略時は自動生成）',
          },
          typescript: {
            type: 'boolean',
            default: true,
            description: 'TypeScriptコードを生成（デフォルト: true）',
          },
          includeReducedMotion: {
            type: 'boolean',
            default: true,
            description: 'prefers-reduced-motion対応を含める（デフォルト: true）',
          },
          includeVendorPrefixes: {
            type: 'boolean',
            default: false,
            description: 'ベンダープレフィックスを含める（デフォルト: false）',
          },
        },
      },
    },
  },
};
