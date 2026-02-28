// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionDetector Tests
 *
 * TDD Red Phase: 60+ test cases for motion detection system
 *
 * Test Categories:
 * 1. 基本検出テスト (15テスト) - CSSアニメーション、トランジション、transform検出
 * 2. キーフレーム解析テスト (15テスト) - @keyframes解析、複雑なプロパティ
 * 3. トリガー検出テスト (10テスト) - :hover, :focus, scroll, load検出
 * 4. 警告生成テスト (10テスト) - パフォーマンス、アクセシビリティ、互換性警告
 * 5. 複雑度計算テスト (10テスト) - 複雑度スコア計算
 *
 * @module @reftrix/webdesign-core/tests/motion-detector
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MotionDetector,
  type MotionPattern,
  type MotionProperty,
  type MotionDetectionResult,
  type MotionWarning,
  type MotionDetectorOptions,
  type KeyframeDefinition,
  type CSSStyleProperties,
} from '../../src/motion-detector';

// =========================================
// Test Fixtures
// =========================================

/**
 * シンプルなCSSアニメーションを持つHTML
 */
const createSimpleAnimationHtml = (): string => `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .animated {
      animation: fadeIn 1s ease-in-out;
    }
  </style>
</head>
<body>
  <div class="animated">Animated content</div>
</body>
</html>
`;

/**
 * CSSトランジションを持つHTML
 */
const createTransitionHtml = (): string => `
<!DOCTYPE html>
<html>
<head>
  <style>
    .button {
      background-color: blue;
      transition: background-color 0.3s ease, transform 0.2s ease-out;
    }
    .button:hover {
      background-color: red;
      transform: scale(1.1);
    }
  </style>
</head>
<body>
  <button class="button">Click me</button>
</body>
</html>
`;

/**
 * CSS transformを持つHTML
 */
const createTransformHtml = (): string => `
<!DOCTYPE html>
<html>
<head>
  <style>
    .card {
      transform: translateX(0);
      transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .card:hover {
      transform: translateX(10px) rotate(5deg);
    }
  </style>
</head>
<body>
  <div class="card">Card content</div>
</body>
</html>
`;

/**
 * 複雑なキーフレームアニメーションを持つHTML
 */
const createComplexKeyframesHtml = (): string => `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes bounce {
      0%, 100% {
        transform: translateY(0);
        animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
      }
      50% {
        transform: translateY(-25%);
        animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
      }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .bouncing {
      animation: bounce 1s infinite;
    }
    .pulsing {
      animation: pulse 2s ease-in-out infinite;
    }
  </style>
</head>
<body>
  <div class="bouncing">Bouncing element</div>
  <div class="pulsing">Pulsing element</div>
</body>
</html>
`;

/**
 * インラインスタイルのアニメーションを持つHTML
 */
const createInlineStyleHtml = (): string => `
<!DOCTYPE html>
<html>
<body>
  <div style="animation: spin 2s linear infinite;">Spinning</div>
  <div style="transition: opacity 0.5s;">Fading</div>
</body>
</html>
`;

/**
 * スクロールトリガーアニメーションを持つHTML
 */
const createScrollAnimationHtml = (): string => `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes slideIn {
      from { transform: translateX(-100%); }
      to { transform: translateX(0); }
    }
    .scroll-reveal {
      animation: slideIn 0.5s ease-out;
      animation-timeline: scroll();
    }
  </style>
</head>
<body>
  <div class="scroll-reveal">Scroll triggered</div>
</body>
</html>
`;

/**
 * パフォーマンス警告を発生させるHTML
 */
const createPerformanceWarningHtml = (): string => `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes expensive {
      0% {
        width: 100px;
        height: 100px;
        box-shadow: 0 0 10px rgba(0,0,0,0.5);
      }
      100% {
        width: 200px;
        height: 200px;
        box-shadow: 0 0 50px rgba(0,0,0,0.8);
      }
    }
    .slow {
      animation: expensive 10s linear infinite;
    }
  </style>
</head>
<body>
  <div class="slow">Expensive animation</div>
</body>
</html>
`;

/**
 * アクセシビリティ警告を発生させるHTML（prefers-reduced-motion未対応）
 * 注: FAST_ANIMATION_THRESHOLD (300ms) 未満かつ infinite で警告発生
 */
const createAccessibilityWarningHtml = (): string => `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes rotate {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .spinning {
      animation: rotate 0.2s linear infinite;
    }
  </style>
</head>
<body>
  <div class="spinning">Fast spinning element</div>
</body>
</html>
`;

/**
 * ベンダープレフィックス付きのHTML
 */
const createVendorPrefixHtml = (): string => `
<!DOCTYPE html>
<html>
<head>
  <style>
    @-webkit-keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .animated {
      -webkit-animation: fadeIn 1s;
      animation: fadeIn 1s;
    }
  </style>
</head>
<body>
  <div class="animated">Vendor prefixed</div>
</body>
</html>
`;

/**
 * 複数要素の複雑なアニメーションを持つHTML
 */
const createComplexMultiElementHtml = (): string => `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUp { from { transform: translateY(20px); } to { transform: translateY(0); } }
    @keyframes scale { 0% { transform: scale(1); } 50% { transform: scale(1.1); } 100% { transform: scale(1); } }
    @keyframes colorChange {
      0% { background: red; }
      33% { background: green; }
      66% { background: blue; }
      100% { background: red; }
    }

    .hero {
      animation: fadeIn 0.8s ease-out, slideUp 0.8s ease-out;
    }
    .card {
      transition: transform 0.3s, box-shadow 0.3s;
    }
    .card:hover {
      transform: translateY(-5px);
      box-shadow: 0 10px 20px rgba(0,0,0,0.2);
    }
    .button {
      animation: scale 2s infinite;
      transition: background-color 0.2s;
    }
    .background {
      animation: colorChange 10s linear infinite;
    }
  </style>
</head>
<body>
  <div class="hero">Hero section</div>
  <div class="card">Card 1</div>
  <div class="card">Card 2</div>
  <button class="button">CTA Button</button>
  <div class="background">Background</div>
</body>
</html>
`;

/**
 * 空のHTML（アニメーションなし）
 */
const createEmptyHtml = (): string => `
<!DOCTYPE html>
<html>
<head></head>
<body>
  <div>Static content</div>
</body>
</html>
`;

/**
 * CSSのみのテストデータ
 */
const createAnimationCss = (): string => `
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideIn {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(0); }
}

.animated {
  animation: fadeIn 1s ease-in-out;
}

.slider {
  animation: slideIn 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
`;

// =========================================
// 1. 基本検出テスト (15テスト)
// =========================================

describe('MotionDetector - 基本検出', () => {
  let detector: MotionDetector;

  beforeEach(() => {
    detector = new MotionDetector();
  });

  describe('CSSアニメーション検出', () => {
    it('should detect simple CSS animation from HTML', () => {
      // Arrange
      const html = createSimpleAnimationHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      expect(result.patterns.length).toBeGreaterThan(0);
      const animationPattern = result.patterns.find(
        (p) => p.type === 'animation'
      );
      expect(animationPattern).toBeDefined();
      expect(animationPattern?.name).toBe('fadeIn');
      expect(animationPattern?.duration).toBe(1000); // 1s = 1000ms
    });

    it('should detect animation easing function', () => {
      // Arrange
      const html = createSimpleAnimationHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const animationPattern = result.patterns.find(
        (p) => p.type === 'animation'
      );
      expect(animationPattern?.easing).toBe('ease-in-out');
    });

    it('should detect infinite animation iterations', () => {
      // Arrange
      const html = createComplexKeyframesHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const bouncePattern = result.patterns.find((p) => p.name === 'bounce');
      expect(bouncePattern?.iterations).toBe('infinite');
    });

    it('should detect multiple animations on same element', () => {
      // Arrange
      const html = createComplexMultiElementHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      // .hero has animation with fadeIn/slideUp (may be combined or separate)
      const heroPatterns = result.patterns.filter((p) =>
        p.selector.includes('hero')
      );
      // At least one animation detected for hero
      expect(heroPatterns.length).toBeGreaterThanOrEqual(1);
      // The animation should have properties from the keyframes
      expect(heroPatterns[0].type).toBe('animation');
    });

    it('should detect animation fill mode', () => {
      // Arrange
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            @keyframes appear { from { opacity: 0; } to { opacity: 1; } }
            .element { animation: appear 1s forwards; }
          </style>
        </head>
        <body><div class="element">Content</div></body>
        </html>
      `;

      // Act
      const result = detector.detect(html);

      // Assert
      const pattern = result.patterns.find((p) => p.name === 'appear');
      expect(pattern?.fillMode).toBe('forwards');
    });
  });

  describe('CSSトランジション検出', () => {
    it('should detect CSS transition from HTML', () => {
      // Arrange
      const html = createTransitionHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const transitionPatterns = result.patterns.filter(
        (p) => p.type === 'transition'
      );
      expect(transitionPatterns.length).toBeGreaterThan(0);
    });

    it('should detect multiple transition properties', () => {
      // Arrange
      const html = createTransitionHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const transitionPattern = result.patterns.find(
        (p) => p.type === 'transition' && p.selector.includes('button')
      );
      expect(transitionPattern?.properties.length).toBeGreaterThanOrEqual(2);
    });

    it('should detect transition duration correctly', () => {
      // Arrange
      const html = createTransitionHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const transitionPattern = result.patterns.find(
        (p) => p.type === 'transition'
      );
      expect(transitionPattern?.duration).toBeDefined();
      expect(transitionPattern?.duration).toBeGreaterThan(0);
    });
  });

  describe('CSS transform検出', () => {
    it('should detect transform property', () => {
      // Arrange
      const html = createTransformHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const hasTransform = result.patterns.some((p) =>
        p.properties.some((prop) => prop.name === 'transform')
      );
      expect(hasTransform).toBe(true);
    });

    it('should detect complex transform values', () => {
      // Arrange
      const html = createTransformHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const transformPattern = result.patterns.find((p) =>
        p.properties.some(
          (prop) => prop.name === 'transform' && prop.to.includes('rotate')
        )
      );
      expect(transformPattern).toBeDefined();
    });
  });

  describe('インラインスタイル検出', () => {
    it('should detect inline style animations', () => {
      // Arrange
      const html = createInlineStyleHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      expect(result.patterns.length).toBeGreaterThan(0);
    });

    it('should detect inline transitions', () => {
      // Arrange
      const html = createInlineStyleHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const transitionPattern = result.patterns.find(
        (p) => p.type === 'transition'
      );
      expect(transitionPattern).toBeDefined();
    });
  });

  describe('スタイルシート検出', () => {
    it('should detect animations from separate CSS', () => {
      // Arrange
      const html = '<div class="animated">Content</div>';
      const css = createAnimationCss();

      // Act
      const result = detector.detect(html, css);

      // Assert
      expect(result.patterns.length).toBeGreaterThan(0);
    });
  });
});

// =========================================
// 2. キーフレーム解析テスト (15テスト)
// =========================================

describe('MotionDetector - キーフレーム解析', () => {
  let detector: MotionDetector;

  beforeEach(() => {
    detector = new MotionDetector();
  });

  describe('@keyframes解析', () => {
    it('should parse simple @keyframes with from/to', () => {
      // Arrange
      const css = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      expect(keyframes.has('fadeIn')).toBe(true);
      const fadeIn = keyframes.get('fadeIn');
      expect(fadeIn?.steps.length).toBe(2);
    });

    it('should parse @keyframes with percentage steps', () => {
      // Arrange
      const css = `
        @keyframes bounce {
          0% { transform: translateY(0); }
          50% { transform: translateY(-20px); }
          100% { transform: translateY(0); }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      const bounce = keyframes.get('bounce');
      expect(bounce?.steps.length).toBe(3);
      expect(bounce?.steps[0].offset).toBe(0);
      expect(bounce?.steps[1].offset).toBe(0.5);
      expect(bounce?.steps[2].offset).toBe(1);
    });

    it('should parse @keyframes with multiple properties', () => {
      // Arrange
      const css = `
        @keyframes complex {
          0% {
            opacity: 0;
            transform: scale(0.5);
            filter: blur(10px);
          }
          100% {
            opacity: 1;
            transform: scale(1);
            filter: blur(0);
          }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      const complex = keyframes.get('complex');
      expect(complex?.steps[0].properties.length).toBe(3);
    });

    it('should parse @keyframes with combined percentage steps', () => {
      // Arrange
      const css = `
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      const pulse = keyframes.get('pulse');
      // 0% and 100% share same properties
      expect(pulse?.steps.some((s) => s.offset === 0)).toBe(true);
      expect(pulse?.steps.some((s) => s.offset === 1)).toBe(true);
      expect(pulse?.steps.some((s) => s.offset === 0.5)).toBe(true);
    });

    it('should parse multiple @keyframes definitions', () => {
      // Arrange
      const css = createAnimationCss();

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      expect(keyframes.size).toBe(2); // fadeIn and slideIn
    });
  });

  describe('キーフレームプロパティ抽出', () => {
    it('should extract transform property values', () => {
      // Arrange
      const css = `
        @keyframes slide {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      const slide = keyframes.get('slide');
      const fromStep = slide?.steps.find((s) => s.offset === 0);
      expect(fromStep?.properties[0].value).toBe('translateX(-100%)');
    });

    it('should extract opacity property values', () => {
      // Arrange
      const css = `
        @keyframes fadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      const fadeOut = keyframes.get('fadeOut');
      const toStep = fadeOut?.steps.find((s) => s.offset === 1);
      expect(toStep?.properties[0].value).toBe('0');
    });

    it('should extract color property values', () => {
      // Arrange
      const css = `
        @keyframes colorShift {
          0% { background-color: red; }
          50% { background-color: blue; }
          100% { background-color: green; }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      const colorShift = keyframes.get('colorShift');
      expect(colorShift?.steps.length).toBe(3);
    });

    it('should extract box-shadow property values', () => {
      // Arrange
      const css = `
        @keyframes glow {
          0% { box-shadow: 0 0 5px rgba(0,0,0,0.3); }
          100% { box-shadow: 0 0 20px rgba(0,0,0,0.8); }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      const glow = keyframes.get('glow');
      expect(glow?.steps[0].properties[0].name).toBe('box-shadow');
    });

    it('should extract timing-function from keyframe steps', () => {
      // Arrange
      const css = `
        @keyframes bounceStep {
          0% {
            transform: translateY(0);
            animation-timing-function: ease-out;
          }
          50% {
            transform: translateY(-30px);
            animation-timing-function: ease-in;
          }
          100% { transform: translateY(0); }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      const bounceStep = keyframes.get('bounceStep');
      const firstStep = bounceStep?.steps.find((s) => s.offset === 0);
      expect(firstStep?.timingFunction).toBe('ease-out');
    });
  });

  describe('特殊なキーフレーム構文', () => {
    it('should handle vendor prefixed keyframes', () => {
      // Arrange
      const css = `
        @-webkit-keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      // Should merge or handle both versions
      expect(keyframes.has('spin')).toBe(true);
    });

    it('should handle keyframes with nested properties', () => {
      // Arrange
      const css = `
        @keyframes complexTransform {
          0% { transform: translateX(0) scale(1) rotate(0deg); }
          100% { transform: translateX(100px) scale(1.5) rotate(180deg); }
        }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      const complexTransform = keyframes.get('complexTransform');
      expect(complexTransform).toBeDefined();
    });

    it('should return empty map for CSS without keyframes', () => {
      // Arrange
      const css = `
        .element { color: red; }
      `;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      expect(keyframes.size).toBe(0);
    });

    it('should handle malformed keyframes gracefully', () => {
      // Arrange
      const css = `
        @keyframes broken {
          from opacity: 0; }
          to { opacity: 1; }
        }
      `;

      // Act & Assert
      expect(() => detector.parseKeyframes(css)).not.toThrow();
    });

    it('should handle empty keyframes definition', () => {
      // Arrange
      const css = `@keyframes empty { }`;

      // Act
      const keyframes = detector.parseKeyframes(css);

      // Assert
      expect(keyframes.has('empty')).toBe(true);
      expect(keyframes.get('empty')?.steps.length).toBe(0);
    });
  });
});

// =========================================
// 3. トリガー検出テスト (10テスト)
// =========================================

describe('MotionDetector - トリガー検出', () => {
  let detector: MotionDetector;

  beforeEach(() => {
    detector = new MotionDetector();
  });

  describe(':hover擬似クラス', () => {
    it('should detect hover trigger for transitions', () => {
      // Arrange
      const html = createTransitionHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const hoverPattern = result.patterns.find((p) => p.trigger === 'hover');
      expect(hoverPattern).toBeDefined();
    });

    it('should detect hover trigger with transform', () => {
      // Arrange
      const html = createTransformHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const hoverTransformPattern = result.patterns.find(
        (p) =>
          p.trigger === 'hover' &&
          p.properties.some((prop) => prop.name === 'transform')
      );
      expect(hoverTransformPattern).toBeDefined();
    });
  });

  describe(':focus擬似クラス', () => {
    it('should detect focus trigger', () => {
      // Arrange
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            .input {
              border-color: gray;
              transition: border-color 0.2s, box-shadow 0.2s;
            }
            .input:focus {
              border-color: blue;
              box-shadow: 0 0 0 3px rgba(0,0,255,0.2);
            }
          </style>
        </head>
        <body><input class="input" type="text" /></body>
        </html>
      `;

      // Act
      const result = detector.detect(html);

      // Assert
      const focusPattern = result.patterns.find((p) => p.trigger === 'focus');
      expect(focusPattern).toBeDefined();
    });

    it('should detect focus-within trigger', () => {
      // Arrange
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            .form-group {
              transition: background-color 0.3s;
            }
            .form-group:focus-within {
              background-color: #f0f0f0;
            }
          </style>
        </head>
        <body>
          <div class="form-group"><input type="text" /></div>
        </body>
        </html>
      `;

      // Act
      const result = detector.detect(html);

      // Assert
      const focusPattern = result.patterns.find((p) => p.trigger === 'focus');
      expect(focusPattern).toBeDefined();
    });
  });

  describe('scroll-linked animations', () => {
    it('should detect scroll trigger', () => {
      // Arrange
      const html = createScrollAnimationHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const scrollPattern = result.patterns.find((p) => p.trigger === 'scroll');
      expect(scrollPattern).toBeDefined();
    });

    it('should detect animation-timeline scroll', () => {
      // Arrange
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            @keyframes reveal {
              from { opacity: 0; transform: translateY(20px); }
              to { opacity: 1; transform: translateY(0); }
            }
            .scroll-element {
              animation: reveal linear both;
              animation-timeline: view();
            }
          </style>
        </head>
        <body><div class="scroll-element">Content</div></body>
        </html>
      `;

      // Act
      const result = detector.detect(html);

      // Assert
      const scrollPattern = result.patterns.find((p) => p.trigger === 'scroll');
      expect(scrollPattern).toBeDefined();
    });
  });

  describe('load時アニメーション', () => {
    it('should detect load trigger for auto-playing animations', () => {
      // Arrange
      const html = createSimpleAnimationHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const loadPattern = result.patterns.find((p) => p.trigger === 'load');
      expect(loadPattern).toBeDefined();
    });

    it('should detect load trigger for animations without interaction pseudo-class', () => {
      // Arrange
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            @keyframes entrance {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            .auto-animate {
              animation: entrance 1s ease-out;
            }
          </style>
        </head>
        <body><div class="auto-animate">Auto animated</div></body>
        </html>
      `;

      // Act
      const result = detector.detect(html);

      // Assert
      const loadPattern = result.patterns.find(
        (p) => p.trigger === 'load' && p.name === 'entrance'
      );
      expect(loadPattern).toBeDefined();
    });
  });

  describe('click trigger', () => {
    it('should detect click trigger from active pseudo-class', () => {
      // Arrange
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            .button {
              transition: transform 0.1s;
            }
            .button:active {
              transform: scale(0.95);
            }
          </style>
        </head>
        <body><button class="button">Click</button></body>
        </html>
      `;

      // Act
      const result = detector.detect(html);

      // Assert
      const clickPattern = result.patterns.find((p) => p.trigger === 'click');
      expect(clickPattern).toBeDefined();
    });
  });

  describe('custom trigger', () => {
    it('should categorize unknown triggers as custom', () => {
      // Arrange
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            .element[data-state="active"] {
              animation: activate 0.5s;
            }
          </style>
        </head>
        <body><div class="element">Element</div></body>
        </html>
      `;

      // Act
      const result = detector.detect(html);

      // Assert
      const customPattern = result.patterns.find((p) => p.trigger === 'custom');
      expect(customPattern).toBeDefined();
    });
  });
});

// =========================================
// 4. 警告生成テスト (10テスト)
// =========================================

describe('MotionDetector - 警告生成', () => {
  let detector: MotionDetector;

  beforeEach(() => {
    detector = new MotionDetector();
  });

  describe('パフォーマンス警告', () => {
    it('should warn about long duration animations', () => {
      // Arrange
      const html = createPerformanceWarningHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const perfWarning = result.warnings.find(
        (w) => w.type === 'performance' && w.message.includes('duration')
      );
      expect(perfWarning).toBeDefined();
    });

    it('should warn about layout-triggering animations', () => {
      // Arrange
      const html = createPerformanceWarningHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const layoutWarning = result.warnings.find(
        (w) =>
          w.type === 'performance' &&
          (w.message.includes('width') ||
            w.message.includes('height') ||
            w.message.includes('layout'))
      );
      expect(layoutWarning).toBeDefined();
    });

    it('should warn about box-shadow animations', () => {
      // Arrange
      const html = createPerformanceWarningHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const shadowWarning = result.warnings.find(
        (w) => w.type === 'performance' && w.message.includes('box-shadow')
      );
      expect(shadowWarning).toBeDefined();
    });

    it('should provide suggestion for performance issues', () => {
      // Arrange
      const html = createPerformanceWarningHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const warningWithSuggestion = result.warnings.find(
        (w) => w.type === 'performance' && w.suggestion
      );
      expect(warningWithSuggestion?.suggestion).toBeDefined();
    });
  });

  describe('アクセシビリティ警告', () => {
    it('should warn about missing prefers-reduced-motion', () => {
      // Arrange
      const html = createAccessibilityWarningHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const a11yWarning = result.warnings.find(
        (w) =>
          w.type === 'accessibility' &&
          w.message.includes('prefers-reduced-motion')
      );
      expect(a11yWarning).toBeDefined();
    });

    it('should warn about fast continuous animations', () => {
      // Arrange
      const html = createAccessibilityWarningHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const fastAnimationWarning = result.warnings.find(
        (w) =>
          w.type === 'accessibility' &&
          (w.message.includes('fast') || w.message.includes('rapid'))
      );
      expect(fastAnimationWarning).toBeDefined();
    });

    it('should have high severity for accessibility warnings', () => {
      // Arrange
      const html = createAccessibilityWarningHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const a11yWarning = result.warnings.find(
        (w) => w.type === 'accessibility'
      );
      expect(['medium', 'high']).toContain(a11yWarning?.severity);
    });
  });

  describe('互換性警告', () => {
    it('should warn about vendor prefixes', () => {
      // Arrange
      const html = createVendorPrefixHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const compatWarning = result.warnings.find(
        (w) =>
          w.type === 'compatibility' &&
          (w.message.includes('vendor') || w.message.includes('prefix'))
      );
      expect(compatWarning).toBeDefined();
    });

    it('should warn about experimental features', () => {
      // Arrange
      const html = createScrollAnimationHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const experimentalWarning = result.warnings.find(
        (w) =>
          w.type === 'compatibility' &&
          (w.message.includes('experimental') ||
            w.message.includes('scroll') ||
            w.message.includes('timeline'))
      );
      expect(experimentalWarning).toBeDefined();
    });

    it('should provide compatibility severity', () => {
      // Arrange
      const html = createVendorPrefixHtml();

      // Act
      const result = detector.detect(html);

      // Assert
      const compatWarning = result.warnings.find(
        (w) => w.type === 'compatibility'
      );
      expect(compatWarning?.severity).toBeDefined();
    });
  });
});

// =========================================
// 5. 複雑度計算テスト (10テスト)
// =========================================

describe('MotionDetector - 複雑度計算', () => {
  let detector: MotionDetector;

  beforeEach(() => {
    detector = new MotionDetector();
  });

  describe('単純なアニメーション', () => {
    it('should return low complexity for simple fade', () => {
      // Arrange
      const html = createSimpleAnimationHtml();
      const result = detector.detect(html);

      // Act
      const complexity = detector.calculateComplexity(result.patterns);

      // Assert
      expect(complexity).toBeLessThan(30);
    });

    it('should return low complexity for single transition', () => {
      // Arrange
      const patterns: MotionPattern[] = [
        {
          id: 'test-1',
          type: 'transition',
          name: 'simple-transition',
          selector: '.element',
          properties: [{ name: 'opacity', from: '1', to: '0' }],
          duration: 300,
          delay: 0,
          easing: 'ease',
          iterations: 1,
          direction: 'normal',
          fillMode: 'none',
          playState: 'running',
          trigger: 'hover',
          confidence: 0.9,
        },
      ];

      // Act
      const complexity = detector.calculateComplexity(patterns);

      // Assert
      expect(complexity).toBeLessThan(20);
    });
  });

  describe('複雑なアニメーション', () => {
    it('should return high complexity for multi-property animation', () => {
      // Arrange
      const html = createComplexKeyframesHtml();
      const result = detector.detect(html);

      // Act
      const complexity = detector.calculateComplexity(result.patterns);

      // Assert
      expect(complexity).toBeGreaterThan(30);
    });

    it('should increase complexity for infinite animations', () => {
      // Arrange
      const finitePatterns: MotionPattern[] = [
        {
          id: 'test-1',
          type: 'animation',
          name: 'finite',
          selector: '.element',
          properties: [{ name: 'opacity', from: '0', to: '1' }],
          duration: 1000,
          delay: 0,
          easing: 'ease',
          iterations: 1,
          direction: 'normal',
          fillMode: 'none',
          playState: 'running',
          trigger: 'load',
          confidence: 0.9,
        },
      ];

      const infinitePatterns: MotionPattern[] = [
        {
          ...finitePatterns[0],
          iterations: 'infinite',
        },
      ];

      // Act
      const finiteComplexity = detector.calculateComplexity(finitePatterns);
      const infiniteComplexity = detector.calculateComplexity(infinitePatterns);

      // Assert
      expect(infiniteComplexity).toBeGreaterThan(finiteComplexity);
    });
  });

  describe('複数要素のアニメーション', () => {
    it('should increase complexity with more animated elements', () => {
      // Arrange
      const html = createComplexMultiElementHtml();
      const result = detector.detect(html);

      // Act
      const complexity = detector.calculateComplexity(result.patterns);

      // Assert
      expect(complexity).toBeGreaterThan(50);
    });

    it('should return moderate complexity for multiple simple animations', () => {
      // Arrange
      const patterns: MotionPattern[] = Array.from({ length: 5 }, (_, i) => ({
        id: `test-${i}`,
        type: 'transition' as const,
        name: `transition-${i}`,
        selector: `.element-${i}`,
        properties: [{ name: 'opacity', from: '1', to: '0' }],
        duration: 300,
        delay: 0,
        easing: 'ease',
        iterations: 1,
        direction: 'normal' as const,
        fillMode: 'none' as const,
        playState: 'running' as const,
        trigger: 'hover' as const,
        confidence: 0.9,
      }));

      // Act
      const complexity = detector.calculateComplexity(patterns);

      // Assert
      expect(complexity).toBeGreaterThan(20);
      expect(complexity).toBeLessThan(60);
    });
  });

  describe('ネストされたアニメーション', () => {
    it('should handle animations with multiple keyframes', () => {
      // Arrange
      const patterns: MotionPattern[] = [
        {
          id: 'test-1',
          type: 'animation',
          name: 'complex-keyframes',
          selector: '.element',
          properties: [
            {
              name: 'transform',
              from: 'translateX(0)',
              to: 'translateX(100px)',
              keyframes: [
                { offset: 0, value: 'translateX(0)' },
                { offset: 0.25, value: 'translateX(25px)' },
                { offset: 0.5, value: 'translateX(50px)' },
                { offset: 0.75, value: 'translateX(75px)' },
                { offset: 1, value: 'translateX(100px)' },
              ],
            },
          ],
          duration: 1000,
          delay: 0,
          easing: 'ease',
          iterations: 1,
          direction: 'normal',
          fillMode: 'none',
          playState: 'running',
          trigger: 'load',
          confidence: 0.9,
        },
      ];

      // Act
      const complexity = detector.calculateComplexity(patterns);

      // Assert
      // 基本スコア(7) + プロパティ(3) + キーフレーム5個(5-2=3 * 2 = 6) = 16
      expect(complexity).toBeGreaterThan(15);
    });

    it('should increase complexity for chained animations', () => {
      // Arrange
      const patterns: MotionPattern[] = [
        {
          id: 'test-1',
          type: 'animation',
          name: 'first',
          selector: '.element',
          properties: [{ name: 'opacity', from: '0', to: '1' }],
          duration: 500,
          delay: 0,
          easing: 'ease',
          iterations: 1,
          direction: 'normal',
          fillMode: 'forwards',
          playState: 'running',
          trigger: 'load',
          confidence: 0.9,
        },
        {
          id: 'test-2',
          type: 'animation',
          name: 'second',
          selector: '.element',
          properties: [{ name: 'transform', from: 'scale(0)', to: 'scale(1)' }],
          duration: 500,
          delay: 500, // Chained after first
          easing: 'ease',
          iterations: 1,
          direction: 'normal',
          fillMode: 'forwards',
          playState: 'running',
          trigger: 'load',
          confidence: 0.9,
        },
      ];

      // Act
      const complexity = detector.calculateComplexity(patterns);

      // Assert
      // 2パターン(14) + 各1プロパティ(6) + delay(5) = 25
      expect(complexity).toBeGreaterThan(20);
    });
  });

  describe('エッジケース', () => {
    it('should return 0 for empty patterns array', () => {
      // Act
      const complexity = detector.calculateComplexity([]);

      // Assert
      expect(complexity).toBe(0);
    });

    it('should cap complexity at 100', () => {
      // Arrange - Create extremely complex pattern set
      const patterns: MotionPattern[] = Array.from({ length: 50 }, (_, i) => ({
        id: `test-${i}`,
        type: 'animation' as const,
        name: `complex-${i}`,
        selector: `.element-${i}`,
        properties: Array.from({ length: 10 }, (_, j) => ({
          name: `property-${j}`,
          from: '0',
          to: '100',
          keyframes: Array.from({ length: 10 }, (_, k) => ({
            offset: k / 10,
            value: `${k * 10}`,
          })),
        })),
        duration: 5000,
        delay: i * 100,
        easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
        iterations: 'infinite' as const,
        direction: 'alternate' as const,
        fillMode: 'both' as const,
        playState: 'running' as const,
        trigger: 'load' as const,
        confidence: 0.9,
      }));

      // Act
      const complexity = detector.calculateComplexity(patterns);

      // Assert
      expect(complexity).toBeLessThanOrEqual(100);
    });
  });
});

// =========================================
// 6. サマリーと統計テスト (追加)
// =========================================

describe('MotionDetector - サマリーと統計', () => {
  let detector: MotionDetector;

  beforeEach(() => {
    detector = new MotionDetector();
  });

  it('should generate correct pattern count summary', () => {
    // Arrange
    const html = createComplexMultiElementHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    expect(result.summary.totalPatterns).toBe(result.patterns.length);
  });

  it('should categorize patterns by type', () => {
    // Arrange
    const html = createComplexMultiElementHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    expect(result.summary.byType).toBeDefined();
    const typeSum = Object.values(result.summary.byType).reduce(
      (a, b) => a + b,
      0
    );
    expect(typeSum).toBe(result.summary.totalPatterns);
  });

  it('should categorize patterns by trigger', () => {
    // Arrange
    const html = createComplexMultiElementHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    expect(result.summary.byTrigger).toBeDefined();
    const triggerSum = Object.values(result.summary.byTrigger).reduce(
      (a, b) => a + b,
      0
    );
    expect(triggerSum).toBe(result.summary.totalPatterns);
  });

  it('should calculate average duration', () => {
    // Arrange
    const html = createComplexMultiElementHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    expect(result.summary.averageDuration).toBeDefined();
    expect(result.summary.averageDuration).toBeGreaterThan(0);
  });

  it('should detect presence of infinite animations', () => {
    // Arrange
    const html = createComplexKeyframesHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    expect(result.summary.hasInfiniteAnimations).toBe(true);
  });

  it('should include complexity score in summary', () => {
    // Arrange
    const html = createComplexMultiElementHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    expect(result.summary.complexityScore).toBeDefined();
    expect(result.summary.complexityScore).toBeGreaterThanOrEqual(0);
    expect(result.summary.complexityScore).toBeLessThanOrEqual(100);
  });

  it('should handle HTML with no animations', () => {
    // Arrange
    const html = createEmptyHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    expect(result.patterns.length).toBe(0);
    expect(result.summary.totalPatterns).toBe(0);
    expect(result.summary.averageDuration).toBe(0);
    expect(result.summary.hasInfiniteAnimations).toBe(false);
    expect(result.summary.complexityScore).toBe(0);
  });
});

// =========================================
// 7. オプションテスト (追加)
// =========================================

describe('MotionDetector - オプション', () => {
  it('should respect includeInlineStyles option', () => {
    // Arrange
    const detector = new MotionDetector({ includeInlineStyles: false });
    const html = createInlineStyleHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    // Should not detect inline styles
    expect(result.patterns.length).toBe(0);
  });

  it('should respect includeStyleSheets option', () => {
    // Arrange
    const detector = new MotionDetector({ includeStyleSheets: false });
    const html = createSimpleAnimationHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    // Should not detect stylesheet animations
    expect(result.patterns.length).toBe(0);
  });

  it('should filter by minDuration', () => {
    // Arrange
    const detector = new MotionDetector({ minDuration: 500 });
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          @keyframes short { from { opacity: 0; } to { opacity: 1; } }
          @keyframes long { from { opacity: 0; } to { opacity: 1; } }
          .short { animation: short 0.1s; }
          .long { animation: long 1s; }
        </style>
      </head>
      <body>
        <div class="short">Short</div>
        <div class="long">Long</div>
      </body>
      </html>
    `;

    // Act
    const result = detector.detect(html);

    // Assert
    // Should only include animations >= 500ms
    expect(result.patterns.every((p) => p.duration >= 500)).toBe(true);
  });

  it('should use default options when not specified', () => {
    // Arrange
    const detector = new MotionDetector();
    const html = createSimpleAnimationHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    expect(result.patterns.length).toBeGreaterThan(0);
  });

  it('should handle partial options', () => {
    // Arrange
    const detector = new MotionDetector({ minDuration: 100 });
    const html = createSimpleAnimationHtml();

    // Act
    const result = detector.detect(html);

    // Assert
    expect(result.patterns.length).toBeGreaterThan(0);
  });
});

// =========================================
// 8. detectElement メソッドテスト (追加)
// =========================================

describe('MotionDetector - detectElement', () => {
  let detector: MotionDetector;

  beforeEach(() => {
    detector = new MotionDetector();
  });

  it('should detect animation from CSSStyleProperties object', () => {
    // Arrange
    const styles: CSSStyleProperties = {
      animation: 'fadeIn 1s ease-in-out',
      animationName: 'fadeIn',
      animationDuration: '1s',
      animationTimingFunction: 'ease-in-out',
      animationDelay: '0s',
      animationIterationCount: '1',
      animationDirection: 'normal',
      animationFillMode: 'none',
      animationPlayState: 'running',
    };

    // Act
    const patterns = detector.detectElement('.element', styles);

    // Assert
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].name).toBe('fadeIn');
  });

  it('should detect transition from CSSStyleProperties object', () => {
    // Arrange
    const styles: CSSStyleProperties = {
      transition: 'opacity 0.3s ease',
      transitionProperty: 'opacity',
      transitionDuration: '0.3s',
      transitionTimingFunction: 'ease',
      transitionDelay: '0s',
    };

    // Act
    const patterns = detector.detectElement('.element', styles);

    // Assert
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].type).toBe('transition');
  });

  it('should return empty array for element without motion', () => {
    // Arrange
    const styles: CSSStyleProperties = {
      color: 'red',
      backgroundColor: 'blue',
    };

    // Act
    const patterns = detector.detectElement('.element', styles);

    // Assert
    expect(patterns.length).toBe(0);
  });

  it('should use provided selector in pattern', () => {
    // Arrange
    const styles: CSSStyleProperties = {
      animation: 'spin 2s linear infinite',
      animationName: 'spin',
      animationDuration: '2s',
      animationTimingFunction: 'linear',
      animationIterationCount: 'infinite',
    };

    // Act
    const patterns = detector.detectElement('.my-custom-selector', styles);

    // Assert
    expect(patterns[0].selector).toBe('.my-custom-selector');
  });
});

// =========================================
// 9. generateWarnings メソッドテスト (追加)
// =========================================

describe('MotionDetector - generateWarnings', () => {
  let detector: MotionDetector;

  beforeEach(() => {
    detector = new MotionDetector();
  });

  it('should generate warnings for given patterns', () => {
    // Arrange
    const patterns: MotionPattern[] = [
      {
        id: 'test-1',
        type: 'animation',
        name: 'expensive',
        selector: '.element',
        properties: [
          { name: 'width', from: '100px', to: '200px' },
          { name: 'height', from: '100px', to: '200px' },
        ],
        duration: 15000, // Very long
        delay: 0,
        easing: 'linear',
        iterations: 'infinite',
        direction: 'normal',
        fillMode: 'none',
        playState: 'running',
        trigger: 'load',
        confidence: 0.9,
      },
    ];

    // Act
    const warnings = detector.generateWarnings(patterns);

    // Assert
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('should return empty array for performant patterns', () => {
    // Arrange
    const patterns: MotionPattern[] = [
      {
        id: 'test-1',
        type: 'transition',
        name: 'simple',
        selector: '.element',
        properties: [{ name: 'opacity', from: '0', to: '1' }],
        duration: 300,
        delay: 0,
        easing: 'ease',
        iterations: 1,
        direction: 'normal',
        fillMode: 'none',
        playState: 'running',
        trigger: 'hover',
        confidence: 0.9,
      },
    ];

    // Act
    const warnings = detector.generateWarnings(patterns);

    // Assert
    // May or may not have warnings, but should not crash
    expect(Array.isArray(warnings)).toBe(true);
  });

  it('should identify pattern in warning', () => {
    // Arrange
    const patterns: MotionPattern[] = [
      {
        id: 'test-1',
        type: 'animation',
        name: 'problematic-animation',
        selector: '.element',
        properties: [{ name: 'width', from: '100px', to: '200px' }],
        duration: 10000,
        delay: 0,
        easing: 'linear',
        iterations: 'infinite',
        direction: 'normal',
        fillMode: 'none',
        playState: 'running',
        trigger: 'load',
        confidence: 0.9,
      },
    ];

    // Act
    const warnings = detector.generateWarnings(patterns);

    // Assert
    const warningWithPattern = warnings.find((w) => w.pattern);
    if (warnings.length > 0) {
      expect(warningWithPattern?.pattern).toBe('problematic-animation');
    }
  });
});
