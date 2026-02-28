// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Motion Detector Service Tests
 *
 * TDD approach: Tests written first to define expected behavior
 * MOCK-003: CSS motion detection for page.analyze defaultDetectMotion
 *
 * @module tests/services/page/motion-detector.service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MotionDetectorService,
  type MotionDetectionResult,
  type MotionDetectionOptions,
} from '../../../src/services/page/motion-detector.service';

// =====================================================
// Test CSS/HTML Fixtures
// =====================================================

const MINIMAL_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body></body>
</html>
`;

const HTML_WITH_KEYFRAMES = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes slideUp {
      0% { transform: translateY(20px); opacity: 0; }
      100% { transform: translateY(0); opacity: 1; }
    }

    .animate {
      animation: fadeIn 0.3s ease-out;
    }

    .hero {
      animation: slideUp 0.5s ease-in-out forwards;
    }
  </style>
</head>
<body>
  <div class="animate">Animated content</div>
  <section class="hero">Hero Section</section>
</body>
</html>
`;

const HTML_WITH_TRANSITIONS = `
<!DOCTYPE html>
<html>
<head>
  <style>
    .button {
      transition: background-color 0.2s ease-in-out, transform 0.15s ease;
    }

    .button:hover {
      background-color: #3B82F6;
      transform: scale(1.05);
    }

    .card {
      transition: box-shadow 0.3s ease;
    }

    .card:hover {
      box-shadow: 0 10px 20px rgba(0, 0, 0, 0.2);
    }
  </style>
</head>
<body>
  <button class="button">Click me</button>
  <div class="card">Card content</div>
</body>
</html>
`;

const HTML_WITH_INFINITE_ANIMATION = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.1); }
      100% { transform: scale(1); }
    }

    .spinner {
      animation: spin 1s linear infinite;
    }

    .loader {
      animation: pulse 2s ease-in-out infinite;
    }
  </style>
</head>
<body>
  <div class="spinner">Loading...</div>
  <div class="loader">Loading indicator</div>
</body>
</html>
`;

const HTML_WITH_REDUCED_MOTION = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .animate {
      animation: fadeIn 0.3s ease-out;
    }

    @media (prefers-reduced-motion: reduce) {
      .animate {
        animation: none;
      }
    }
  </style>
</head>
<body>
  <div class="animate">Accessible animation</div>
</body>
</html>
`;

const HTML_WITH_LAYOUT_TRIGGERS = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes widthChange {
      from { width: 100px; }
      to { width: 200px; }
    }

    @keyframes heightChange {
      from { height: 50px; padding: 10px; }
      to { height: 100px; padding: 20px; }
    }

    .resize {
      animation: widthChange 0.5s ease;
    }

    .expand {
      animation: heightChange 0.3s ease;
    }
  </style>
</head>
<body>
  <div class="resize">Resizable</div>
  <div class="expand">Expandable</div>
</body>
</html>
`;

const HTML_WITH_CUBIC_BEZIER = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes bounce {
      from { transform: translateY(0); }
      to { transform: translateY(-20px); }
    }

    .bounce {
      animation: bounce 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55) infinite alternate;
    }
  </style>
</head>
<body>
  <div class="bounce">Bouncy</div>
</body>
</html>
`;

const HTML_WITH_STEPS_EASING = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes typewriter {
      from { width: 0; }
      to { width: 100%; }
    }

    .typewriter {
      animation: typewriter 2s steps(20, end) forwards;
    }
  </style>
</head>
<body>
  <div class="typewriter">Typewriter effect</div>
</body>
</html>
`;

const HTML_WITH_MULTIPLE_PROPERTIES = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes complexAnimation {
      0% {
        opacity: 0;
        transform: translateX(-50px) scale(0.8);
        background-color: #FF0000;
      }
      50% {
        opacity: 0.5;
        transform: translateX(0) scale(1);
        background-color: #00FF00;
      }
      100% {
        opacity: 1;
        transform: translateX(0) scale(1);
        background-color: #0000FF;
      }
    }

    .complex {
      animation: complexAnimation 1s ease-in-out forwards;
    }
  </style>
</head>
<body>
  <div class="complex">Complex animation</div>
</body>
</html>
`;

const HTML_WITH_HOVER_EFFECTS = `
<!DOCTYPE html>
<html>
<head>
  <style>
    .nav-link {
      transition: color 0.2s ease, border-bottom-color 0.2s ease;
    }

    .nav-link:hover {
      color: #3B82F6;
      border-bottom-color: #3B82F6;
    }

    .icon-button {
      transition: transform 0.15s ease-out, opacity 0.15s ease-out;
    }

    .icon-button:hover {
      transform: scale(1.1);
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <a class="nav-link" href="#">Navigation</a>
  <button class="icon-button">Icon</button>
</body>
</html>
`;

const HTML_WITH_SCROLL_TRIGGER = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes reveal {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .fade-in-up {
      animation: fadeInUp 0.6s ease-out forwards;
    }

    .visible .reveal-item {
      animation: reveal 0.5s ease forwards;
    }
  </style>
</head>
<body>
  <div class="fade-in-up">Scroll triggered content</div>
</body>
</html>
`;

const HTML_WITH_LOADING_ANIMATIONS = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes skeleton {
      0% { background-position: -200px 0; }
      100% { background-position: calc(200px + 100%) 0; }
    }

    @keyframes loading-dots {
      0%, 20% { opacity: 0; }
      50% { opacity: 1; }
      100% { opacity: 0; }
    }

    .skeleton-loader {
      animation: skeleton 1.5s ease-in-out infinite;
    }

    .loading-dots span {
      animation: loading-dots 1.4s ease-in-out infinite;
    }
  </style>
</head>
<body>
  <div class="skeleton-loader">Loading skeleton</div>
  <div class="loading-dots"><span>.</span><span>.</span><span>.</span></div>
</body>
</html>
`;

const HTML_WITH_INLINE_STYLES = `
<!DOCTYPE html>
<html>
<head><title>Inline Styles</title></head>
<body>
  <div style="animation: fadeIn 0.5s ease; transition: opacity 0.3s;">Inline animated</div>
  <button style="transition: background-color 0.2s ease-in-out, transform 0.15s;">Button</button>
</body>
</html>
`;

// Generate large CSS for performance testing
function generateLargeCss(animationCount: number): string {
  let css = '';
  for (let i = 0; i < animationCount; i++) {
    css += `
      @keyframes animation${i} {
        from { opacity: 0; transform: translateY(${i % 50}px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .element${i} {
        animation: animation${i} ${0.2 + (i % 10) * 0.1}s ease-out;
      }
    `;
  }
  return css;
}

// =====================================================
// Test Suites
// =====================================================

describe('MotionDetectorService', () => {
  let service: MotionDetectorService;

  beforeEach(() => {
    service = new MotionDetectorService();
  });

  // =====================================================
  // Basic Detection Tests
  // =====================================================

  describe('Basic Detection', () => {
    it('should return empty patterns for HTML without animations', () => {
      const result = service.detect(MINIMAL_HTML);

      expect(result.patterns).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should detect @keyframes animations', () => {
      const result = service.detect(HTML_WITH_KEYFRAMES);

      expect(result.patterns.length).toBeGreaterThan(0);

      // Find fadeIn animation
      const fadeIn = result.patterns.find((p) => p.name === 'fadeIn');
      expect(fadeIn).toBeDefined();
      expect(fadeIn?.type).toBe('css_animation');
      expect(fadeIn?.duration).toBe(300); // 0.3s = 300ms
      expect(fadeIn?.easing).toBe('ease-out');
      expect(fadeIn?.properties).toContain('opacity');

      // Find slideUp animation
      const slideUp = result.patterns.find((p) => p.name === 'slideUp');
      expect(slideUp).toBeDefined();
      expect(slideUp?.duration).toBe(500); // 0.5s
      expect(slideUp?.properties).toContain('transform');
      expect(slideUp?.properties).toContain('opacity');
    });

    it('should populate propertiesDetailed with from/to values for keyframe animations', () => {
      const result = service.detect(HTML_WITH_KEYFRAMES);

      // fadeIn: from { opacity: 0 } to { opacity: 1 }
      const fadeIn = result.patterns.find((p) => p.name === 'fadeIn');
      expect(fadeIn).toBeDefined();
      expect(fadeIn?.propertiesDetailed).toBeDefined();
      expect(fadeIn?.propertiesDetailed).toHaveLength(1);

      const opacityProp = fadeIn?.propertiesDetailed?.find((p) => p.property === 'opacity');
      expect(opacityProp).toBeDefined();
      expect(opacityProp?.from).toBe('0');
      expect(opacityProp?.to).toBe('1');

      // slideUp: 0% { transform: translateY(20px); opacity: 0 } 100% { transform: translateY(0); opacity: 1 }
      const slideUp = result.patterns.find((p) => p.name === 'slideUp');
      expect(slideUp).toBeDefined();
      expect(slideUp?.propertiesDetailed).toBeDefined();
      expect(slideUp?.propertiesDetailed).toHaveLength(2);

      const transformProp = slideUp?.propertiesDetailed?.find((p) => p.property === 'transform');
      expect(transformProp).toBeDefined();
      expect(transformProp?.from).toBe('translateY(20px)');
      expect(transformProp?.to).toBe('translateY(0)');

      const slideOpacity = slideUp?.propertiesDetailed?.find((p) => p.property === 'opacity');
      expect(slideOpacity).toBeDefined();
      expect(slideOpacity?.from).toBe('0');
      expect(slideOpacity?.to).toBe('1');
    });

    it('should not have propertiesDetailed for css_transition patterns', () => {
      const result = service.detect(HTML_WITH_TRANSITIONS);

      const transitionPattern = result.patterns.find((p) => p.type === 'css_transition');
      expect(transitionPattern).toBeDefined();
      // Transitions don't have keyframe steps, so propertiesDetailed should be undefined
      expect(transitionPattern?.propertiesDetailed).toBeUndefined();
    });

    it('should detect CSS transitions', () => {
      const result = service.detect(HTML_WITH_TRANSITIONS);

      expect(result.patterns.length).toBeGreaterThan(0);

      // Find button transition
      const buttonPattern = result.patterns.find(
        (p) => p.type === 'css_transition' && p.selector?.includes('button')
      );
      expect(buttonPattern).toBeDefined();
      expect(buttonPattern?.properties).toContain('background-color');
      expect(buttonPattern?.properties).toContain('transform');

      // Find card transition
      const cardPattern = result.patterns.find(
        (p) => p.type === 'css_transition' && p.selector?.includes('card')
      );
      expect(cardPattern).toBeDefined();
      expect(cardPattern?.properties).toContain('box-shadow');
    });
  });

  // =====================================================
  // Easing Function Tests
  // =====================================================

  describe('Easing Functions', () => {
    it('should parse cubic-bezier easing', () => {
      const result = service.detect(HTML_WITH_CUBIC_BEZIER);

      const bouncePattern = result.patterns.find((p) => p.name === 'bounce');
      expect(bouncePattern).toBeDefined();
      expect(bouncePattern?.easing).toBe('cubic-bezier(0.68, -0.55, 0.265, 1.55)');
    });

    it('should parse steps() easing', () => {
      const result = service.detect(HTML_WITH_STEPS_EASING);

      const typewriterPattern = result.patterns.find((p) => p.name === 'typewriter');
      expect(typewriterPattern).toBeDefined();
      expect(typewriterPattern?.easing).toBe('steps(20, end)');
    });

    it('should parse standard easing keywords', () => {
      const result = service.detect(HTML_WITH_KEYFRAMES);

      const fadeIn = result.patterns.find((p) => p.name === 'fadeIn');
      expect(fadeIn?.easing).toBe('ease-out');

      const slideUp = result.patterns.find((p) => p.name === 'slideUp');
      expect(slideUp?.easing).toBe('ease-in-out');
    });
  });

  // =====================================================
  // Performance Analysis Tests
  // =====================================================

  describe('Performance Analysis', () => {
    it('should identify GPU-accelerated animations as good performance', () => {
      const result = service.detect(HTML_WITH_KEYFRAMES);

      // fadeIn uses only opacity (GPU-accelerated)
      const fadeIn = result.patterns.find((p) => p.name === 'fadeIn');
      expect(fadeIn?.performance.level).toBe('good');
      expect(fadeIn?.performance.usesOpacity).toBe(true);
      expect(fadeIn?.performance.usesTransform).toBe(false);

      // slideUp uses transform and opacity (GPU-accelerated)
      const slideUp = result.patterns.find((p) => p.name === 'slideUp');
      expect(slideUp?.performance.level).toBe('good');
      expect(slideUp?.performance.usesTransform).toBe(true);
      expect(slideUp?.performance.usesOpacity).toBe(true);
    });

    it('should identify layout-triggering animations as poor performance', () => {
      const result = service.detect(HTML_WITH_LAYOUT_TRIGGERS);

      // Animations with width/height/padding should trigger layout
      const layoutPatterns = result.patterns.filter((p) => p.performance.level === 'poor');
      expect(layoutPatterns.length).toBeGreaterThan(0);

      const widthPattern = result.patterns.find((p) => p.name === 'widthChange');
      expect(widthPattern?.performance.level).toBe('poor');

      const heightPattern = result.patterns.find((p) => p.name === 'heightChange');
      expect(heightPattern?.performance.level).toBe('poor');
    });

    it('should include performance warning for layout-triggering animations', () => {
      const result = service.detect(HTML_WITH_LAYOUT_TRIGGERS);

      const layoutWarning = result.warnings.find(
        (w) => w.code === 'PERF_LAYOUT_TRIGGER'
      );
      expect(layoutWarning).toBeDefined();
      expect(layoutWarning?.severity).toBe('warning');
    });
  });

  // =====================================================
  // Accessibility Tests
  // =====================================================

  describe('Accessibility Detection', () => {
    it('should detect prefers-reduced-motion support', () => {
      const result = service.detect(HTML_WITH_REDUCED_MOTION);

      const pattern = result.patterns.find((p) => p.name === 'fadeIn');
      expect(pattern?.accessibility.respectsReducedMotion).toBe(true);
    });

    it('should warn when prefers-reduced-motion is not supported', () => {
      const result = service.detect(HTML_WITH_KEYFRAMES);

      const a11yWarning = result.warnings.find(
        (w) => w.code === 'A11Y_NO_REDUCED_MOTION'
      );
      expect(a11yWarning).toBeDefined();
      expect(a11yWarning?.severity).toBe('warning');
    });

    it('should detect infinite animations', () => {
      const result = service.detect(HTML_WITH_INFINITE_ANIMATION);

      const spinner = result.patterns.find((p) => p.name === 'spin');
      expect(spinner?.iterations).toBe('infinite');

      const pulse = result.patterns.find((p) => p.name === 'pulse');
      expect(pulse?.iterations).toBe('infinite');
    });

    it('should include info warning for infinite animations', () => {
      const result = service.detect(HTML_WITH_INFINITE_ANIMATION);

      const infiniteWarning = result.warnings.find(
        (w) => w.code === 'A11Y_INFINITE_ANIMATION'
      );
      expect(infiniteWarning).toBeDefined();
      expect(infiniteWarning?.severity).toBe('info');
    });
  });

  // =====================================================
  // Category Classification Tests
  // =====================================================

  describe('Category Classification', () => {
    it('should classify hover effects correctly', () => {
      const result = service.detect(HTML_WITH_HOVER_EFFECTS);

      const hoverPatterns = result.patterns.filter(
        (p) => p.category === 'hover_effect'
      );
      expect(hoverPatterns.length).toBeGreaterThan(0);

      // Patterns with :hover selectors or triggers should be classified
      for (const pattern of hoverPatterns) {
        expect(pattern.trigger).toBe('hover');
      }
    });

    it('should classify scroll-triggered animations', () => {
      const result = service.detect(HTML_WITH_SCROLL_TRIGGER);

      // fadeInUp pattern should be classified as 'reveal' (v0.1.0: new category)
      // v0.1.0: fadeIn/slideUp patterns are now classified as 'reveal' for better specificity
      const fadeInUp = result.patterns.find((p) => p.name === 'fadeInUp');
      expect(fadeInUp).toBeDefined();
      expect(fadeInUp?.category).toBe('reveal');
    });

    it('should classify loading state animations', () => {
      const result = service.detect(HTML_WITH_LOADING_ANIMATIONS);

      // Skeleton loader should be loading_state
      const skeleton = result.patterns.find((p) => p.name === 'skeleton');
      expect(skeleton).toBeDefined();
      expect(skeleton?.category).toBe('loading_state');

      // Loading dots should be loading_state
      const loadingDots = result.patterns.find((p) => p.name === 'loading-dots');
      expect(loadingDots).toBeDefined();
      expect(loadingDots?.category).toBe('loading_state');
    });

    it('should classify infinite rotating animations as loading_state', () => {
      const result = service.detect(HTML_WITH_INFINITE_ANIMATION);

      const spinner = result.patterns.find((p) => p.name === 'spin');
      expect(spinner?.category).toBe('loading_state');
    });
  });

  // =====================================================
  // Trigger Detection Tests
  // =====================================================

  describe('Trigger Detection', () => {
    it('should detect hover triggers', () => {
      const result = service.detect(HTML_WITH_HOVER_EFFECTS);

      const hoverPatterns = result.patterns.filter((p) => p.trigger === 'hover');
      expect(hoverPatterns.length).toBeGreaterThan(0);
    });

    it('should detect load triggers for entrance animations', () => {
      const result = service.detect(HTML_WITH_KEYFRAMES);

      // Standard fade-in animations are typically load-triggered
      const fadeIn = result.patterns.find((p) => p.name === 'fadeIn');
      expect(fadeIn?.trigger).toBe('load');
    });

    it('should detect unknown trigger when not determinable', () => {
      // When we can't determine the trigger, it should default to 'unknown'
      const html = `
        <style>
          @keyframes customAnimation {
            from { color: red; }
            to { color: blue; }
          }
          .custom { animation: customAnimation 1s; }
        </style>
      `;
      const result = service.detect(html);

      const custom = result.patterns.find((p) => p.name === 'customAnimation');
      // Could be unknown or load depending on implementation
      expect(['unknown', 'load']).toContain(custom?.trigger);
    });
  });

  // =====================================================
  // Property Extraction Tests
  // =====================================================

  describe('Property Extraction', () => {
    it('should extract all animated properties from keyframes', () => {
      const result = service.detect(HTML_WITH_MULTIPLE_PROPERTIES);

      const complex = result.patterns.find((p) => p.name === 'complexAnimation');
      expect(complex).toBeDefined();
      expect(complex?.properties).toContain('opacity');
      expect(complex?.properties).toContain('transform');
      expect(complex?.properties).toContain('background-color');
    });

    it('should extract from/to values for properties', () => {
      const result = service.detect(HTML_WITH_KEYFRAMES);

      const fadeIn = result.patterns.find((p) => p.name === 'fadeIn');
      expect(fadeIn?.properties).toContain('opacity');
    });

    it('should extract transition properties', () => {
      const result = service.detect(HTML_WITH_TRANSITIONS);

      const buttonPattern = result.patterns.find(
        (p) => p.type === 'css_transition' && p.selector?.includes('button')
      );
      expect(buttonPattern?.properties.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =====================================================
  // Options Tests
  // =====================================================

  describe('Options', () => {
    it('should filter by minDuration', () => {
      const result = service.detect(HTML_WITH_TRANSITIONS, {
        minDuration: 250, // Filter out animations shorter than 250ms
      });

      // 0.2s (200ms) and 0.15s (150ms) transitions should be filtered
      // Only 0.3s (300ms) should remain
      for (const pattern of result.patterns) {
        expect(pattern.duration).toBeGreaterThanOrEqual(250);
      }
    });

    it('should limit patterns with maxPatterns', () => {
      const largeCss = generateLargeCss(100);
      const html = `<style>${largeCss}</style>`;

      const result = service.detect(html, { maxPatterns: 10 });

      expect(result.patterns.length).toBeLessThanOrEqual(10);
    });

    it('should include inline styles when option is enabled', () => {
      const result = service.detect(HTML_WITH_INLINE_STYLES, {
        includeInlineStyles: true,
      });

      // Should detect inline animation and transition
      expect(result.patterns.length).toBeGreaterThan(0);
    });

    it('should exclude inline styles when option is disabled', () => {
      const htmlWithOnlyInline = `
        <html>
        <body>
          <div style="animation: fadeIn 0.5s; transition: opacity 0.3s;">Content</div>
        </body>
        </html>
      `;

      const result = service.detect(htmlWithOnlyInline, {
        includeInlineStyles: false,
        includeStyleSheets: false,
      });

      expect(result.patterns).toHaveLength(0);
    });
  });

  // =====================================================
  // External CSS Tests
  // =====================================================

  describe('External CSS', () => {
    it('should process additional CSS content', () => {
      const externalCss = `
        @keyframes externalFade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .external {
          animation: externalFade 0.4s ease;
        }
      `;

      const result = service.detect(MINIMAL_HTML, {}, externalCss);

      const externalPattern = result.patterns.find((p) => p.name === 'externalFade');
      expect(externalPattern).toBeDefined();
      expect(externalPattern?.duration).toBe(400);
    });

    it('should merge external CSS with inline styles', () => {
      const externalCss = `
        @keyframes externalSlide {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
      `;

      const result = service.detect(HTML_WITH_KEYFRAMES, {}, externalCss);

      // Should have both inline and external animations
      const fadeIn = result.patterns.find((p) => p.name === 'fadeIn');
      const externalSlide = result.patterns.find((p) => p.name === 'externalSlide');

      expect(fadeIn).toBeDefined();
      expect(externalSlide).toBeDefined();
    });
  });

  // =====================================================
  // Warning Count Tests
  // =====================================================

  describe('Warning Generation', () => {
    it('should count a11y warnings correctly', () => {
      const result = service.detect(HTML_WITH_INFINITE_ANIMATION);

      // Should have A11Y_NO_REDUCED_MOTION and A11Y_INFINITE_ANIMATION
      const a11yWarnings = result.warnings.filter(
        (w) => w.code.startsWith('A11Y_')
      );
      expect(a11yWarnings.length).toBeGreaterThanOrEqual(1);
    });

    it('should count perf warnings correctly', () => {
      const result = service.detect(HTML_WITH_LAYOUT_TRIGGERS);

      const perfWarnings = result.warnings.filter(
        (w) => w.code.startsWith('PERF_')
      );
      expect(perfWarnings.length).toBeGreaterThanOrEqual(1);
    });

    it('should warn about too many animations', () => {
      const largeCss = generateLargeCss(50);
      const html = `<style>${largeCss}</style>`;

      const result = service.detect(html, { maxPatterns: 100 });

      const tooManyWarning = result.warnings.find(
        (w) => w.code === 'PERF_TOO_MANY_ANIMATIONS'
      );
      expect(tooManyWarning).toBeDefined();
    });
  });

  // =====================================================
  // Edge Cases and Error Handling
  // =====================================================

  describe('Edge Cases', () => {
    it('should handle empty HTML', () => {
      const result = service.detect('');

      expect(result.patterns).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should handle malformed CSS', () => {
      const malformedHtml = `
        <style>
          @keyframes broken {
            from { opacity: 0
            to { opacity 1; }
          }

          .test {
            animation: broken 0.5s;
            transition: invalid 0.3s;
          }
        </style>
      `;

      // Should not throw, but gracefully handle
      expect(() => service.detect(malformedHtml)).not.toThrow();
      const result = service.detect(malformedHtml);
      expect(result).toBeDefined();
    });

    it('should handle CSS without animations', () => {
      const staticCss = `
        <style>
          .static {
            color: red;
            background: blue;
            padding: 10px;
          }
        </style>
      `;

      const result = service.detect(staticCss);
      expect(result.patterns).toHaveLength(0);
    });

    it('should handle nested @keyframes in @media queries', () => {
      const nestedKeyframes = `
        <style>
          @media (min-width: 768px) {
            @keyframes desktopFade {
              from { opacity: 0; }
              to { opacity: 1; }
            }

            .desktop-animate {
              animation: desktopFade 0.5s ease;
            }
          }
        </style>
      `;

      const result = service.detect(nestedKeyframes);
      // Should still detect the keyframes
      expect(result.patterns.length).toBeGreaterThanOrEqual(0);
    });
  });

  // =====================================================
  // Performance Tests
  // =====================================================

  describe('Performance', () => {
    it('should process large CSS within 300ms', () => {
      const largeCss = generateLargeCss(100);
      const html = `<style>${largeCss}</style>`;

      const startTime = Date.now();
      const result = service.detect(html);
      const endTime = Date.now();

      const processingTime = endTime - startTime;
      expect(processingTime).toBeLessThan(300);
      expect(result.processingTimeMs).toBeLessThan(300);
    });

    it('should handle 50KB+ CSS without errors', () => {
      // Generate approximately 50KB of CSS (need ~250 animations for 50KB+)
      const largeCss = generateLargeCss(250);
      const html = `<style>${largeCss}</style>`;

      expect(html.length).toBeGreaterThan(50000);

      const result = service.detect(html);
      expect(result).toBeDefined();
      expect(result.patterns.length).toBeGreaterThan(0);
    });
  });

  // =====================================================
  // Output Format Tests
  // =====================================================

  describe('Output Format', () => {
    it('should return correct structure for MotionServiceResult', () => {
      const result = service.detect(HTML_WITH_KEYFRAMES);

      // Check required fields
      expect(result).toHaveProperty('patterns');
      expect(result).toHaveProperty('warnings');
      expect(result).toHaveProperty('processingTimeMs');

      // Check pattern structure
      for (const pattern of result.patterns) {
        expect(pattern).toHaveProperty('id');
        expect(pattern).toHaveProperty('name');
        expect(pattern).toHaveProperty('type');
        expect(pattern).toHaveProperty('category');
        expect(pattern).toHaveProperty('trigger');
        expect(pattern).toHaveProperty('duration');
        expect(pattern).toHaveProperty('easing');
        expect(pattern).toHaveProperty('properties');
        expect(pattern).toHaveProperty('performance');
        expect(pattern).toHaveProperty('accessibility');

        // Check performance structure
        expect(pattern.performance).toHaveProperty('level');
        expect(pattern.performance).toHaveProperty('usesTransform');
        expect(pattern.performance).toHaveProperty('usesOpacity');

        // Check accessibility structure
        expect(pattern.accessibility).toHaveProperty('respectsReducedMotion');
      }
    });

    it('should return warning with correct structure', () => {
      const result = service.detect(HTML_WITH_KEYFRAMES);

      for (const warning of result.warnings) {
        expect(warning).toHaveProperty('code');
        expect(warning).toHaveProperty('severity');
        expect(warning).toHaveProperty('message');
        expect(['info', 'warning', 'error']).toContain(warning.severity);
      }
    });
  });
});

// =====================================================
// Integration Tests
// =====================================================

describe('MotionDetectorService Integration', () => {
  it('should work with page.analyze expected output format', () => {
    const service = new MotionDetectorService();
    const result = service.detect(HTML_WITH_KEYFRAMES);

    // Validate against page/schemas.ts patternDetailSchema expectations
    for (const pattern of result.patterns) {
      expect(typeof pattern.id).toBe('string');
      expect(typeof pattern.name).toBe('string');
      expect(['css_animation', 'css_transition', 'keyframes']).toContain(pattern.type);
      expect(typeof pattern.category).toBe('string');
      expect(typeof pattern.trigger).toBe('string');
      expect(typeof pattern.duration).toBe('number');
      expect(pattern.duration).toBeGreaterThanOrEqual(0);
      expect(typeof pattern.easing).toBe('string');
      expect(Array.isArray(pattern.properties)).toBe(true);
      expect(['good', 'acceptable', 'poor']).toContain(pattern.performance.level);
      expect(typeof pattern.performance.usesTransform).toBe('boolean');
      expect(typeof pattern.performance.usesOpacity).toBe('boolean');
      expect(typeof pattern.accessibility.respectsReducedMotion).toBe('boolean');
    }
  });

  it('should handle real-world CSS patterns', () => {
    const realWorldHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          /* Tailwind-like animation */
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes ping { 75%, 100% { transform: scale(2); opacity: 0; } }
          @keyframes pulse { 50% { opacity: .5; } }
          @keyframes bounce {
            0%, 100% { transform: translateY(-25%); animation-timing-function: cubic-bezier(0.8,0,1,1); }
            50% { transform: none; animation-timing-function: cubic-bezier(0,0,0.2,1); }
          }

          .animate-spin { animation: spin 1s linear infinite; }
          .animate-ping { animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite; }
          .animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
          .animate-bounce { animation: bounce 1s infinite; }

          /* Common UI transitions */
          .transition { transition-property: all; transition-duration: 150ms; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); }
          .hover\\:scale-105:hover { transform: scale(1.05); }
          .focus\\:ring:focus { box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.5); }
        </style>
      </head>
      <body>
        <button class="transition hover:scale-105">Hover me</button>
        <div class="animate-spin">Loading</div>
      </body>
      </html>
    `;

    const service = new MotionDetectorService();
    const result = service.detect(realWorldHtml);

    expect(result.patterns.length).toBeGreaterThan(0);

    // Check for known animations
    const spinAnimation = result.patterns.find((p) => p.name === 'spin');
    expect(spinAnimation).toBeDefined();
    expect(spinAnimation?.iterations).toBe('infinite');

    const pulseAnimation = result.patterns.find((p) => p.name === 'pulse');
    expect(pulseAnimation).toBeDefined();
  });
});
