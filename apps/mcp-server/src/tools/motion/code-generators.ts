// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.search コード生成モジュール
 * 9つのフォーマット（CSS, CSSModule, Tailwind, StyledComponents, Emotion, FramerMotion, GSAP, Three.js, Lottie）の
 * コード生成関数を提供します。
 *
 * @module tools/motion/code-generators
 */

import type {
  MotionPatternInput,
  ImplementationFormat,
  ImplementationOptions,
  ImplementationMetadata,
} from "./schemas";

// =====================================================
// 型定義
// =====================================================

/**
 * コード生成結果インターフェース
 */
export interface GenerationResult {
  code: string;
  metadata: ImplementationMetadata;
}

// =====================================================
// ユーティリティ関数
// =====================================================

/**
 * ミリ秒をCSS時間単位に変換
 */
export function formatDuration(ms: number): string {
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
  return code.split("\n").length;
}

/**
 * PascalCaseに変換
 */
function toPascalCase(str: string): string {
  return str.replace(/[-_](\w)/g, (_, c) => c.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase());
}

// =====================================================
// コード生成関数
// =====================================================

/**
 * CSS生成
 */
function generateCSS(
  pattern: MotionPatternInput,
  options: ImplementationOptions
): GenerationResult {
  const lines: string[] = [];
  const selector = options.selector || ".animated";
  const hasKeyframes = pattern.properties.some((p) => p.keyframes && p.keyframes.length > 0);

  // @keyframes 生成
  if (pattern.type !== "transition") {
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
        lines.push("  }");
      }
    } else {
      lines.push("  from {");
      for (const prop of pattern.properties) {
        lines.push(`    ${prop.name}: ${prop.from};`);
      }
      lines.push("  }");
      lines.push("  to {");
      for (const prop of pattern.properties) {
        lines.push(`    ${prop.name}: ${prop.to};`);
      }
      lines.push("  }");
    }

    lines.push("}");
    lines.push("");

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
          lines.push("  }");
        }
      } else {
        lines.push("  from {");
        for (const prop of pattern.properties) {
          lines.push(`    ${prop.name}: ${prop.from};`);
        }
        lines.push("  }");
        lines.push("  to {");
        for (const prop of pattern.properties) {
          lines.push(`    ${prop.name}: ${prop.to};`);
        }
        lines.push("  }");
      }
      lines.push("}");
      lines.push("");
    }
  }

  // セレクタルール
  lines.push(`${selector} {`);

  if (pattern.type === "transition") {
    const props = pattern.properties.map((p) => p.name).join(", ");
    lines.push(`  transition: ${props} ${formatDuration(pattern.duration)} ${pattern.easing};`);
    if (options.includeVendorPrefixes) {
      lines.push(
        `  -webkit-transition: ${props} ${formatDuration(pattern.duration)} ${pattern.easing};`
      );
    }
  } else {
    const iterations = pattern.iterations === "infinite" ? "infinite" : pattern.iterations;
    const animationValue = [
      pattern.name,
      formatDuration(pattern.duration),
      pattern.easing,
      pattern.delay > 0 ? formatDuration(pattern.delay) : null,
      iterations !== 1 ? iterations : null,
      pattern.direction !== "normal" ? pattern.direction : null,
      pattern.fillMode !== "none" ? pattern.fillMode : null,
    ]
      .filter(Boolean)
      .join(" ");

    lines.push(`  animation: ${animationValue};`);
    if (options.includeVendorPrefixes) {
      lines.push(`  -webkit-animation: ${animationValue};`);
    }
  }

  lines.push("}");

  // hover/scroll タイプの追加ルール
  if (pattern.type === "hover") {
    lines.push("");
    lines.push(`${selector}:hover {`);
    for (const prop of pattern.properties) {
      lines.push(`  ${prop.name}: ${prop.to};`);
    }
    lines.push("}");
  }

  // prefers-reduced-motion
  if (options.includeReducedMotion) {
    lines.push("");
    lines.push("@media (prefers-reduced-motion: reduce) {");
    lines.push(`  ${selector} {`);
    if (pattern.type === "transition") {
      lines.push("    transition: none;");
    } else {
      lines.push("    animation: none;");
    }
    lines.push("  }");
    lines.push("}");
  }

  const code = lines.join("\n");

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: pattern.type !== "transition",
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

  lines.push("/* Add to tailwind.config.js */");
  lines.push("module.exports = {");
  lines.push("  theme: {");
  lines.push("    extend: {");

  lines.push("      animation: {");
  const iterations = pattern.iterations === "infinite" ? "infinite" : "";
  const direction = pattern.direction !== "normal" ? pattern.direction : "";
  lines.push(
    `        '${pattern.name}': '${pattern.name} ${formatDuration(pattern.duration)} ${pattern.easing} ${iterations} ${direction}'.trim(),`
  );
  lines.push("      },");

  lines.push("      keyframes: {");
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
      lines.push("          },");
    }
  } else {
    lines.push("          '0%': {");
    for (const prop of pattern.properties) {
      lines.push(`            ${prop.name}: '${prop.from}',`);
    }
    lines.push("          },");
    lines.push("          '100%': {");
    for (const prop of pattern.properties) {
      lines.push(`            ${prop.name}: '${prop.to}',`);
    }
    lines.push("          },");
  }

  lines.push("        },");
  lines.push("      },");
  lines.push("    },");
  lines.push("  },");
  lines.push("};");
  lines.push("");
  lines.push("/* Usage in JSX */");
  lines.push(`<div className="animate-${pattern.name}">Content</div>`);

  if (options.includeReducedMotion) {
    lines.push("");
    lines.push("/* For reduced motion support */");
    lines.push(`<div className="animate-${pattern.name} motion-reduce:animate-none">Content</div>`);
  }

  const code = lines.join("\n");

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: true,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: ["tailwindcss"],
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
  const componentName = options.componentName || toPascalCase(pattern.name) + "Animation";
  const ts = options.typescript ?? true;

  lines.push("import styled, { keyframes } from 'styled-components';");
  if (ts) {
    lines.push("import type { FC, ReactNode } from 'react';");
  }
  lines.push("");

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
      lines.push("  }");
    }
  } else {
    lines.push("  from {");
    for (const prop of pattern.properties) {
      lines.push(`    ${prop.name}: ${prop.from};`);
    }
    lines.push("  }");
    lines.push("  to {");
    for (const prop of pattern.properties) {
      lines.push(`    ${prop.name}: ${prop.to};`);
    }
    lines.push("  }");
  }

  lines.push("`;");
  lines.push("");

  const iterationsVal = pattern.iterations === "infinite" ? "infinite" : pattern.iterations;
  const directionVal = pattern.direction !== "normal" ? pattern.direction : "";
  const fillModeVal = pattern.fillMode !== "none" ? pattern.fillMode : "";

  lines.push(`const ${componentName}Container = styled.div\``);
  lines.push(
    `  animation: \${${pattern.name}Keyframes} ${formatDuration(pattern.duration)} ${pattern.easing}${pattern.delay > 0 ? ` ${formatDuration(pattern.delay)}` : ""}${iterationsVal !== 1 ? ` ${iterationsVal}` : ""}${directionVal ? ` ${directionVal}` : ""}${fillModeVal ? ` ${fillModeVal}` : ""};`
  );

  if (options.includeReducedMotion) {
    lines.push("");
    lines.push("  @media (prefers-reduced-motion: reduce) {");
    lines.push("    animation: none;");
    lines.push("  }");
  }

  lines.push("`;");
  lines.push("");

  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push("  children: ReactNode;");
    lines.push("  className?: string;");
    lines.push("}");
    lines.push("");
    lines.push(
      `export const ${componentName}: FC<${componentName}Props> = ({ children, className }) => {`
    );
  } else {
    lines.push(`export const ${componentName} = ({ children, className }) => {`);
  }
  lines.push(
    `  return <${componentName}Container className={className}>{children}</${componentName}Container>;`
  );
  lines.push("};");

  const code = lines.join("\n");

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: true,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: ["styled-components"],
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
  const componentName = options.componentName || toPascalCase(pattern.name) + "Animation";
  const ts = options.typescript ?? true;

  lines.push("/** @jsxImportSource @emotion/react */");
  lines.push("import { css, keyframes } from '@emotion/react';");
  if (ts) {
    lines.push("import type { FC, ReactNode } from 'react';");
  }
  lines.push("");

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
      lines.push("  }");
    }
  } else {
    lines.push("  from {");
    for (const prop of pattern.properties) {
      lines.push(`    ${prop.name}: ${prop.from};`);
    }
    lines.push("  }");
    lines.push("  to {");
    for (const prop of pattern.properties) {
      lines.push(`    ${prop.name}: ${prop.to};`);
    }
    lines.push("  }");
  }

  lines.push("`;");
  lines.push("");

  const iterationsVal = pattern.iterations === "infinite" ? "infinite" : pattern.iterations;
  const directionVal = pattern.direction !== "normal" ? pattern.direction : "";
  const fillModeVal = pattern.fillMode !== "none" ? pattern.fillMode : "";

  lines.push(`const ${pattern.name}Style = css\``);
  lines.push(
    `  animation: \${${pattern.name}Keyframes} ${formatDuration(pattern.duration)} ${pattern.easing}${pattern.delay > 0 ? ` ${formatDuration(pattern.delay)}` : ""}${iterationsVal !== 1 ? ` ${iterationsVal}` : ""}${directionVal ? ` ${directionVal}` : ""}${fillModeVal ? ` ${fillModeVal}` : ""};`
  );

  if (options.includeReducedMotion) {
    lines.push("");
    lines.push("  @media (prefers-reduced-motion: reduce) {");
    lines.push("    animation: none;");
    lines.push("  }");
  }

  lines.push("`;");
  lines.push("");

  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push("  children: ReactNode;");
    lines.push("  className?: string;");
    lines.push("}");
    lines.push("");
    lines.push(
      `export const ${componentName}: FC<${componentName}Props> = ({ children, className }) => {`
    );
  } else {
    lines.push(`export const ${componentName} = ({ children, className }) => {`);
  }
  lines.push(`  return <div css={${pattern.name}Style} className={className}>{children}</div>;`);
  lines.push("};");

  const code = lines.join("\n");

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: true,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: ["@emotion/react"],
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
  const componentName = options.componentName || toPascalCase(pattern.name) + "Motion";
  const ts = options.typescript ?? true;
  const isScroll = pattern.type === "scroll";

  lines.push("import { motion } from 'framer-motion';");
  if (ts) {
    lines.push("import type { FC, ReactNode } from 'react';");
  }
  lines.push("");

  lines.push(`const ${pattern.name}Variants = {`);
  lines.push("  initial: {");
  for (const prop of pattern.properties) {
    const cssName = prop.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    lines.push(`    ${cssName}: ${JSON.stringify(prop.from)},`);
  }
  lines.push("  },");
  lines.push("  animate: {");
  for (const prop of pattern.properties) {
    const cssName = prop.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    lines.push(`    ${cssName}: ${JSON.stringify(prop.to)},`);
  }
  lines.push("  },");
  lines.push("};");
  lines.push("");

  lines.push(`const ${pattern.name}Transition = {`);
  lines.push(`  duration: ${pattern.duration / 1000},`);
  lines.push(`  ease: ${JSON.stringify(pattern.easing)},`);
  if (pattern.delay > 0) {
    lines.push(`  delay: ${pattern.delay / 1000},`);
  }
  if (pattern.iterations === "infinite") {
    lines.push("  repeat: Infinity,");
  } else if (pattern.iterations > 1) {
    lines.push(`  repeat: ${pattern.iterations - 1},`);
  }
  if (pattern.direction === "alternate" || pattern.direction === "alternate-reverse") {
    lines.push("  repeatType: 'reverse',");
  }
  lines.push("};");
  lines.push("");

  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push("  children: ReactNode;");
    lines.push("  className?: string;");
    lines.push("}");
    lines.push("");
    lines.push(
      `export const ${componentName}: FC<${componentName}Props> = ({ children, className }) => {`
    );
  } else {
    lines.push(`export const ${componentName} = ({ children, className }) => {`);
  }
  lines.push("  return (");
  lines.push("    <motion.div");
  lines.push(`      variants={${pattern.name}Variants}`);
  lines.push('      initial="initial"');

  if (isScroll) {
    lines.push('      whileInView="animate"');
    lines.push("      viewport={{ once: true }}");
  } else {
    lines.push('      animate="animate"');
  }

  lines.push(`      transition={${pattern.name}Transition}`);
  lines.push("      className={className}");
  lines.push("    >");
  lines.push("      {children}");
  lines.push("    </motion.div>");
  lines.push("  );");
  lines.push("};");

  if (options.includeReducedMotion) {
    lines.push("");
    lines.push("/* Note: Framer Motion automatically respects prefers-reduced-motion */");
    lines.push(
      '/* Set reducedMotion="user" in AnimatePresence or MotionConfig for custom handling */'
    );
  }

  const code = lines.join("\n");

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: false,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: ["framer-motion"],
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
  const componentName = options.componentName || toPascalCase(pattern.name) + "GSAP";
  const ts = options.typescript ?? true;
  const isScroll = pattern.type === "scroll";

  lines.push("import { gsap } from 'gsap';");
  if (isScroll) {
    lines.push("import { ScrollTrigger } from 'gsap/ScrollTrigger';");
    lines.push("");
    lines.push("gsap.registerPlugin(ScrollTrigger);");
  }
  if (ts) {
    lines.push("import { useRef, useEffect } from 'react';");
    lines.push("import type { FC, ReactNode } from 'react';");
  } else {
    lines.push("import { useRef, useEffect } from 'react';");
  }
  lines.push("");

  lines.push(
    `const use${toPascalCase(pattern.name)}Animation = (ref${ts ? ": React.RefObject<HTMLDivElement>" : ""}) => {`
  );
  lines.push("  useEffect(() => {");
  lines.push("    if (!ref.current) return;");
  lines.push("");

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

  lines.push("    const animation = gsap.fromTo(");
  lines.push("      ref.current,");
  lines.push("      {");
  lines.push(fromProps.join(",\n"));
  lines.push("      },");
  lines.push("      {");
  lines.push(toProps.join(",\n") + ",");
  lines.push(`        duration: ${pattern.duration / 1000},`);
  lines.push(`        ease: ${JSON.stringify(pattern.easing)},`);
  if (pattern.delay > 0) {
    lines.push(`        delay: ${pattern.delay / 1000},`);
  }
  if (pattern.iterations === "infinite") {
    lines.push("        repeat: -1,");
  } else if (pattern.iterations > 1) {
    lines.push(`        repeat: ${pattern.iterations - 1},`);
  }
  if (pattern.direction === "alternate" || pattern.direction === "alternate-reverse") {
    lines.push("        yoyo: true,");
  }

  if (isScroll) {
    lines.push("        scrollTrigger: {");
    lines.push("          trigger: ref.current,");
    lines.push("          start: 'top 80%',");
    lines.push("          end: 'bottom 20%',");
    lines.push("          toggleActions: 'play none none reverse',");
    lines.push("        },");
  }

  lines.push("      }");
  lines.push("    );");
  lines.push("");
  lines.push("    return () => {");
  lines.push("      animation.kill();");
  lines.push("    };");
  lines.push("  }, [ref]);");
  lines.push("};");
  lines.push("");

  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push("  children: ReactNode;");
    lines.push("  className?: string;");
    lines.push("}");
    lines.push("");
    lines.push(
      `export const ${componentName}: FC<${componentName}Props> = ({ children, className }) => {`
    );
  } else {
    lines.push(`export const ${componentName} = ({ children, className }) => {`);
  }
  lines.push(`  const ref = useRef${ts ? "<HTMLDivElement>" : ""}(null);`);
  lines.push(`  use${toPascalCase(pattern.name)}Animation(ref);`);
  lines.push("");
  lines.push("  return (");
  lines.push("    <div ref={ref} className={className}>");
  lines.push("      {children}");
  lines.push("    </div>");
  lines.push("  );");
  lines.push("};");

  if (options.includeReducedMotion) {
    lines.push("");
    lines.push("/* Add reduced motion check */");
    lines.push(
      '// const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;'
    );
    lines.push("// if (prefersReducedMotion) return;");
  }

  const code = lines.join("\n");
  const dependencies = isScroll ? ["gsap", "gsap/ScrollTrigger"] : ["gsap"];

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
  const componentName = options.componentName || toPascalCase(pattern.name) + "Scene";
  const ts = options.typescript ?? true;
  const isScroll = pattern.type === "scroll";

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
  lines.push("");

  // Extract animation properties and convert to Three.js-compatible values
  const positionProps = pattern.properties.filter((p) =>
    ["translateX", "translateY", "translateZ", "x", "y", "z"].includes(p.name)
  );
  const rotationProps = pattern.properties.filter((p) =>
    ["rotateX", "rotateY", "rotateZ", "rotate"].includes(p.name)
  );
  const scaleProps = pattern.properties.filter((p) =>
    ["scale", "scaleX", "scaleY", "scaleZ"].includes(p.name)
  );
  const opacityProps = pattern.properties.filter((p) => ["opacity"].includes(p.name));

  // Helper function name
  const animatedObjectName = toPascalCase(pattern.name) + "Object";

  // Animated Object Component
  if (ts) {
    lines.push(`interface ${animatedObjectName}Props {`);
    lines.push("  children?: React.ReactNode;");
    lines.push("}");
    lines.push("");
  }

  lines.push(
    `const ${animatedObjectName}${ts ? `: FC<${animatedObjectName}Props>` : ""} = ({ children }) => {`
  );
  lines.push(`  const meshRef = useRef${ts ? "<Mesh>" : ""}(null);`);

  if (isScroll) {
    lines.push("  const scroll = useScroll();");
    lines.push("");
    lines.push("  useFrame(() => {");
    lines.push("    if (!meshRef.current) return;");
    lines.push("    const progress = scroll.offset;");
  } else {
    lines.push(`  const duration = ${pattern.duration / 1000}; // seconds`);
    lines.push(`  const startTime = useRef${ts ? "<number>" : ""}(0);`);
    lines.push("");
    lines.push("  useFrame((state) => {");
    lines.push("    if (!meshRef.current) return;");
    lines.push("    if (startTime.current === 0) startTime.current = state.clock.elapsedTime;");
    lines.push("");
    lines.push("    const elapsed = state.clock.elapsedTime - startTime.current;");
    if (pattern.iterations === "infinite") {
      lines.push("    const progress = (elapsed % duration) / duration;");
    } else {
      lines.push("    const progress = Math.min(elapsed / duration, 1);");
    }
  }

  lines.push("");

  // Apply easing
  lines.push("    // Apply easing function");
  lines.push(
    `    const eased = ease${toPascalCase(pattern.easing.replace(/[^a-zA-Z]/g, ""))}(progress);`
  );
  lines.push("");

  // Position animations
  if (positionProps.length > 0) {
    lines.push("    // Position animation");
    for (const prop of positionProps) {
      const axis =
        prop.name.replace(/translate|[XYZ]/gi, "").toLowerCase() ||
        prop.name.charAt(prop.name.length - 1).toLowerCase();
      const fromVal = parseFloat(prop.from) || 0;
      const toVal = parseFloat(prop.to) || 0;
      lines.push(
        `    meshRef.current.position.${axis} = ${fromVal} + (${toVal} - ${fromVal}) * eased;`
      );
    }
  }

  // Rotation animations
  if (rotationProps.length > 0) {
    lines.push("    // Rotation animation");
    for (const prop of rotationProps) {
      const axis = prop.name.replace("rotate", "").toLowerCase() || "y";
      const fromVal = parseFloat(prop.from) || 0;
      const toVal = parseFloat(prop.to) || Math.PI * 2;
      lines.push(
        `    meshRef.current.rotation.${axis} = ${fromVal} + (${toVal} - ${fromVal}) * eased;`
      );
    }
  }

  // Scale animations
  const scaleProp = scaleProps[0];
  if (scaleProp) {
    lines.push("    // Scale animation");
    const fromVal = parseFloat(scaleProp.from) || 1;
    const toVal = parseFloat(scaleProp.to) || 1;
    lines.push(`    const scaleValue = ${fromVal} + (${toVal} - ${fromVal}) * eased;`);
    lines.push("    meshRef.current.scale.setScalar(scaleValue);");
  }

  // Opacity animations (material)
  const opacityProp = opacityProps[0];
  if (opacityProp) {
    lines.push("    // Opacity animation");
    const fromVal = parseFloat(opacityProp.from) || 1;
    const toVal = parseFloat(opacityProp.to) || 0;
    lines.push(`    if (meshRef.current.material && 'opacity' in meshRef.current.material) {`);
    lines.push(
      `      (meshRef.current.material as any).opacity = ${fromVal} + (${toVal} - ${fromVal}) * eased;`
    );
    lines.push("    }");
  }

  lines.push("  });");
  lines.push("");
  lines.push("  return (");
  lines.push("    <mesh ref={meshRef}>");
  lines.push("      {children || (");
  lines.push("        <>");
  lines.push("          <boxGeometry args={[1, 1, 1]} />");
  lines.push('          <meshStandardMaterial color="#4f46e5" transparent />');
  lines.push("        </>");
  lines.push("      )}");
  lines.push("    </mesh>");
  lines.push("  );");
  lines.push("};");
  lines.push("");

  // Easing function
  lines.push("// Easing function");
  const easingName = `ease${toPascalCase(pattern.easing.replace(/[^a-zA-Z]/g, ""))}`;
  lines.push(`function ${easingName}(t${ts ? ": number" : ""})${ts ? ": number" : ""} {`);
  switch (pattern.easing) {
    case "ease-in":
      lines.push("  return t * t;");
      break;
    case "ease-out":
      lines.push("  return t * (2 - t);");
      break;
    case "ease-in-out":
      lines.push("  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;");
      break;
    case "linear":
      lines.push("  return t;");
      break;
    default:
      // Default to ease-out for unknown easing
      lines.push("  return t * (2 - t);");
  }
  lines.push("}");
  lines.push("");

  // Main Scene Component
  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push("  className?: string;");
    lines.push("}");
    lines.push("");
  }

  lines.push(
    `export const ${componentName}${ts ? `: FC<${componentName}Props>` : ""} = ({ className }) => {`
  );

  if (options.includeReducedMotion) {
    lines.push("  // Check for reduced motion preference");
    lines.push('  const prefersReducedMotion = typeof window !== "undefined"');
    lines.push('    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;');
    lines.push("");
    lines.push("  if (prefersReducedMotion) {");
    lines.push("    return (");
    lines.push(
      '      <div className={className} style={{ width: "100%", height: "400px", background: "#1a1a2e" }}>'
    );
    lines.push("        {/* Static fallback for reduced motion */}");
    lines.push("      </div>");
    lines.push("    );");
    lines.push("  }");
    lines.push("");
  }

  lines.push("  return (");
  lines.push('    <div className={className} style={{ width: "100%", height: "400px" }}>');
  lines.push("      <Canvas camera={{ position: [0, 0, 5], fov: 50 }}>");
  lines.push("        <ambientLight intensity={0.5} />");
  lines.push("        <pointLight position={[10, 10, 10]} />");
  lines.push(`        <${animatedObjectName} />`);
  lines.push("      </Canvas>");
  lines.push("    </div>");
  lines.push("  );");
  lines.push("};");

  const code = lines.join("\n");
  const dependencies = isScroll
    ? ["@react-three/fiber", "@react-three/drei", "three"]
    : ["@react-three/fiber", "three"];

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

// =====================================================
// Lottie 生成ヘルパー
// =====================================================

/**
 * Lottie トランスフォームキーフレームを生成する
 * CSSアニメーションプロパティをLottie JSON形式のトランスフォーム(ks)に変換する
 *
 * Generates Lottie transform keyframes from CSS animation properties.
 * Converts opacity, translate, scale, and rotation to Lottie JSON transform (ks) format.
 */
function buildLottieTransformLines(
  pattern: MotionPatternInput,
  startFrame: number,
  durationInFrames: number
): string[] {
  const lines: string[] = [];

  // Opacity animation
  const opacityProp = pattern.properties.find((p) => p.name === "opacity");
  if (opacityProp) {
    const fromOpacity = parseFloat(opacityProp.from) * 100 || 0;
    const toOpacity = parseFloat(opacityProp.to) * 100 || 100;
    lines.push("        o: {"); // Opacity
    lines.push("          a: 1,"); // Animated
    lines.push("          k: [");
    lines.push(
      `            { i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] }, t: ${startFrame}, s: [${fromOpacity}] },`
    );
    lines.push(`            { t: ${startFrame + durationInFrames}, s: [${toOpacity}] }`);
    lines.push("          ]");
    lines.push("        },");
  } else {
    lines.push("        o: { a: 0, k: 100 },");
  }

  // Position animation (transform: translate)
  const translateXProp = pattern.properties.find((p) => p.name === "translateX");
  const translateYProp = pattern.properties.find((p) => p.name === "translateY");
  if (translateXProp || translateYProp) {
    const fromX = translateXProp ? parseFloat(translateXProp.from) || 0 : 0;
    const toX = translateXProp ? parseFloat(translateXProp.to) || 0 : 0;
    const fromY = translateYProp ? parseFloat(translateYProp.from) || 0 : 0;
    const toY = translateYProp ? parseFloat(translateYProp.to) || 0 : 0;
    lines.push("        p: {"); // Position
    lines.push("          a: 1,");
    lines.push("          k: [");
    lines.push(
      `            { i: { x: 0.4, y: 1 }, o: { x: 0.6, y: 0 }, t: ${startFrame}, s: [${100 + fromX}, ${100 + fromY}, 0] },`
    );
    lines.push(
      `            { t: ${startFrame + durationInFrames}, s: [${100 + toX}, ${100 + toY}, 0] }`
    );
    lines.push("          ]");
    lines.push("        },");
  } else {
    lines.push("        p: { a: 0, k: [100, 100, 0] },");
  }

  // Scale animation
  const scaleProp = pattern.properties.find((p) => p.name === "scale");
  if (scaleProp) {
    const fromScale = parseFloat(scaleProp.from) * 100 || 100;
    const toScale = parseFloat(scaleProp.to) * 100 || 100;
    lines.push("        s: {"); // Scale
    lines.push("          a: 1,");
    lines.push("          k: [");
    lines.push(
      `            { i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] }, t: ${startFrame}, s: [${fromScale}, ${fromScale}, 100] },`
    );
    lines.push(
      `            { t: ${startFrame + durationInFrames}, s: [${toScale}, ${toScale}, 100] }`
    );
    lines.push("          ]");
    lines.push("        },");
  } else {
    lines.push("        s: { a: 0, k: [100, 100, 100] },");
  }

  // Rotation animation
  const rotateProp = pattern.properties.find((p) => p.name === "rotate");
  if (rotateProp) {
    const fromRotate = parseFloat(rotateProp.from) || 0;
    const toRotate = parseFloat(rotateProp.to) || 0;
    lines.push("        r: {"); // Rotation
    lines.push("          a: 1,");
    lines.push("          k: [");
    lines.push(
      `            { i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] }, t: ${startFrame}, s: [${fromRotate}] },`
    );
    lines.push(`            { t: ${startFrame + durationInFrames}, s: [${toRotate}] }`);
    lines.push("          ]");
    lines.push("        },");
  } else {
    lines.push("        r: { a: 0, k: 0 },");
  }

  lines.push("        a: { a: 0, k: [100, 100, 0] }"); // Anchor point

  return lines;
}

/**
 * Lottie アニメーションデータオブジェクト(JSON)のコード行を生成する
 * Lottie v5.7.8 形式のレイヤー・シェイプ構造を出力する
 *
 * Generates Lottie animation data object (JSON) code lines.
 * Outputs layer and shape structure in Lottie v5.7.8 format.
 */
function buildLottieAnimationDataLines(
  pattern: MotionPatternInput,
  startFrame: number,
  durationInFrames: number
): string[] {
  const lines: string[] = [];

  lines.push("/**");
  lines.push(" * Lottie Animation Data");
  lines.push(" * Generated from CSS animation pattern.");
  lines.push(
    " * For complex animations, replace with actual Lottie JSON export from After Effects/Figma."
  );
  lines.push(" */");

  lines.push(`const ${pattern.name}AnimationData = {`);
  lines.push('  v: "5.7.8",');
  lines.push(`  fr: 60,`); // Frame rate
  lines.push(`  ip: ${startFrame},`); // In point
  lines.push(`  op: ${startFrame + durationInFrames},`); // Out point
  lines.push("  w: 200,"); // Width
  lines.push("  h: 200,"); // Height
  lines.push('  nm: "' + pattern.name + '",');
  lines.push("  ddd: 0,");
  lines.push("  assets: [],");
  lines.push("  layers: [");
  lines.push("    {");
  lines.push("      ddd: 0,");
  lines.push("      ind: 1,");
  lines.push("      ty: 4,"); // Shape layer
  lines.push(`      nm: "${pattern.name}",`);
  lines.push(`      sr: 1,`);
  lines.push("      ks: {"); // Transform

  lines.push(...buildLottieTransformLines(pattern, startFrame, durationInFrames));

  lines.push("      },");

  // Shape contents (simple rectangle)
  lines.push("      shapes: [");
  lines.push("        {");
  lines.push('          ty: "rc",'); // Rectangle
  lines.push("          d: 1,");
  lines.push("          s: { a: 0, k: [100, 100] },"); // Size
  lines.push("          p: { a: 0, k: [0, 0] },"); // Position
  lines.push("          r: { a: 0, k: 8 },"); // Corner radius
  lines.push('          nm: "Rectangle"');
  lines.push("        },");
  lines.push("        {");
  lines.push('          ty: "fl",'); // Fill
  lines.push("          c: { a: 0, k: [0.31, 0.275, 0.898, 1] },"); // Color (#4f46e5)
  lines.push("          o: { a: 0, k: 100 },");
  lines.push('          nm: "Fill"');
  lines.push("        }");
  lines.push("      ],");
  lines.push(`      ip: ${startFrame},`);
  lines.push(`      op: ${startFrame + durationInFrames},`);
  lines.push("      st: 0");
  lines.push("    }");
  lines.push("  ]");
  lines.push("};");

  return lines;
}

/**
 * Lottie Reactコンポーネントのコード行を生成する
 * TypeScript型定義、prefers-reduced-motion対応、使用例コメントを含む
 *
 * Generates Lottie React component code lines.
 * Includes TypeScript type definitions, prefers-reduced-motion support, and usage comments.
 */
function buildLottieComponentLines(
  pattern: MotionPatternInput,
  options: ImplementationOptions,
  componentName: string,
  ts: boolean
): string[] {
  const lines: string[] = [];

  // React component
  if (ts) {
    lines.push(`interface ${componentName}Props {`);
    lines.push("  className?: string;");
    lines.push("  loop?: boolean;");
    lines.push("  autoplay?: boolean;");
    lines.push("}");
    lines.push("");
  }

  lines.push(`export const ${componentName}${ts ? `: FC<${componentName}Props>` : ""} = ({`);
  lines.push("  className,");
  lines.push(`  loop = ${pattern.iterations === "infinite"},`);
  lines.push("  autoplay = true,");
  lines.push("}) => {");

  if (options.includeReducedMotion) {
    lines.push("  // Check for reduced motion preference");
    lines.push('  const prefersReducedMotion = typeof window !== "undefined"');
    lines.push('    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;');
    lines.push("");
    lines.push("  if (prefersReducedMotion) {");
    lines.push("    return (");
    lines.push("      <div className={className} style={{ width: 200, height: 200 }}>");
    lines.push("        {/* Static fallback for reduced motion */}");
    lines.push(
      '        <div style={{ width: 100, height: 100, background: "#4f46e5", borderRadius: 8, margin: "auto" }} />'
    );
    lines.push("      </div>");
    lines.push("    );");
    lines.push("  }");
    lines.push("");
  }

  lines.push("  return (");
  lines.push("    <Lottie");
  lines.push(`      animationData={${pattern.name}AnimationData}`);
  lines.push("      loop={loop}");
  lines.push("      autoplay={autoplay}");
  lines.push("      className={className}");
  lines.push("      style={{ width: 200, height: 200 }}");
  lines.push("    />");
  lines.push("  );");
  lines.push("};");
  lines.push("");

  // Usage instructions
  lines.push("/**");
  lines.push(" * Usage:");
  lines.push(` * import { ${componentName} } from './path-to-component';`);
  lines.push(" *");
  lines.push(` * <${componentName} />`);
  lines.push(` * <${componentName} loop={false} autoplay={true} />`);
  lines.push(" *");
  lines.push(" * Note: For production use, export your animation from After Effects with");
  lines.push(" * Bodymovin plugin or from Figma, and replace the animationData above.");
  lines.push(" */");

  return lines;
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
  const componentName = options.componentName || toPascalCase(pattern.name) + "Animation";
  const ts = options.typescript ?? true;

  // Imports
  lines.push("import Lottie from 'lottie-react';");
  if (ts) {
    lines.push("import type { FC } from 'react';");
    lines.push("import type { LottieComponentProps } from 'lottie-react';");
  }
  lines.push("");

  // Generate Lottie-like animation data structure
  const durationInFrames = Math.round((pattern.duration / 1000) * 60); // 60fps
  const startFrame = Math.round((pattern.delay / 1000) * 60);

  lines.push(...buildLottieAnimationDataLines(pattern, startFrame, durationInFrames));
  lines.push("");

  lines.push(...buildLottieComponentLines(pattern, options, componentName, ts));

  const code = lines.join("\n");

  return {
    code,
    metadata: {
      linesOfCode: countLines(code),
      hasKeyframes: false,
      hasReducedMotion: options.includeReducedMotion ?? true,
      dependencies: ["lottie-react"],
    },
  };
}

// =====================================================
// メイン生成関数
// =====================================================

/**
 * メイン生成関数 — フォーマットに応じて適切なコード生成関数にディスパッチする
 */
export function generateImplementation(
  pattern: MotionPatternInput,
  format: ImplementationFormat,
  options: ImplementationOptions
): GenerationResult {
  switch (format) {
    case "css":
      return generateCSS(pattern, options);
    case "css-module":
      return generateCSSModule(pattern, options);
    case "tailwind":
      return generateTailwind(pattern, options);
    case "styled-components":
      return generateStyledComponents(pattern, options);
    case "emotion":
      return generateEmotion(pattern, options);
    case "framer-motion":
      return generateFramerMotion(pattern, options);
    case "gsap":
      return generateGSAP(pattern, options);
    case "three-js":
      return generateThreeJS(pattern, options);
    case "lottie":
      return generateLottie(pattern, options);
    default:
      return generateCSS(pattern, options);
  }
}
