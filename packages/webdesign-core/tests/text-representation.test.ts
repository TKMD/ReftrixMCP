// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TextRepresentationGenerator テスト
 *
 * TDD Red Phase: 40テストケース以上
 * Embedding用のテキスト表現を生成するサービスのテスト
 *
 * @module @reftrix/webdesign-core/tests/text-representation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TextRepresentationGenerator,
  type TextRepresentationOptions,
  type TextRepresentationResult,
} from '../src/text-representation';
import type { DetectedSection, SectionType } from '../src/types/section.types';

// =========================================
// Test Fixtures - DetectedSection
// =========================================

/**
 * テスト用のDetectedSectionを作成するヘルパー
 */
function createSection(
  type: SectionType,
  overrides: Partial<DetectedSection> = {}
): DetectedSection {
  return {
    id: `section-${Math.random().toString(36).slice(2, 9)}`,
    type,
    confidence: 0.9,
    element: {
      tagName: 'section',
      selector: 'section.test',
      classes: ['test'],
      id: undefined,
    },
    position: {
      startY: 0,
      endY: 400,
      height: 400,
    },
    content: {
      headings: [],
      paragraphs: [],
      links: [],
      images: [],
      buttons: [],
    },
    style: {},
    ...overrides,
  };
}

const HERO_SECTION: DetectedSection = createSection('hero', {
  content: {
    headings: [{ level: 1, text: 'Welcome to Our Platform' }],
    paragraphs: ['A powerful solution for modern businesses.'],
    links: [],
    images: [{ src: '/hero.jpg', alt: 'Hero Image' }],
    buttons: [{ text: 'Get Started', type: 'primary' }],
  },
  style: {
    backgroundColor: '#3B82F6',
    textColor: '#FFFFFF',
    hasGradient: true,
  },
  position: { startY: 0, endY: 600, height: 600 },
});

const FEATURE_SECTION: DetectedSection = createSection('feature', {
  content: {
    headings: [
      { level: 2, text: 'Our Features' },
      { level: 3, text: 'Fast Performance' },
      { level: 3, text: 'Secure Data' },
      { level: 3, text: 'Easy Integration' },
    ],
    paragraphs: [
      'Lightning fast response times.',
      'Enterprise-grade security.',
      'Connect with any platform.',
    ],
    links: [],
    images: [
      { src: '/icon1.svg', alt: 'Speed Icon' },
      { src: '/icon2.svg', alt: 'Security Icon' },
      { src: '/icon3.svg', alt: 'Integration Icon' },
    ],
    buttons: [],
  },
  position: { startY: 600, endY: 1000, height: 400 },
});

const CTA_SECTION: DetectedSection = createSection('cta', {
  content: {
    headings: [{ level: 2, text: 'Ready to begin?' }],
    paragraphs: ['Join thousands of satisfied customers today.'],
    links: [],
    images: [],
    buttons: [
      { text: 'Sign Up Now', type: 'primary' },
      { text: 'Learn More', type: 'secondary' },
    ],
  },
  style: {
    backgroundColor: '#1F2937',
    textColor: '#FFFFFF',
  },
  position: { startY: 1000, endY: 1300, height: 300 },
});

const FOOTER_SECTION: DetectedSection = createSection('footer', {
  content: {
    headings: [],
    paragraphs: ['Copyright 2024 Company Name. All rights reserved.'],
    links: [
      { text: 'Privacy Policy', href: '/privacy' },
      { text: 'Terms of Service', href: '/terms' },
    ],
    images: [{ src: '/social-icons.svg', alt: 'Social Media' }],
    buttons: [],
  },
  position: { startY: 1300, endY: 1500, height: 200 },
});

const NAVIGATION_SECTION: DetectedSection = createSection('navigation', {
  content: {
    headings: [],
    paragraphs: [],
    links: [
      { text: 'Home', href: '/' },
      { text: 'About', href: '/about' },
      { text: 'Services', href: '/services' },
      { text: 'Contact', href: '/contact' },
    ],
    images: [{ src: '/logo.svg', alt: 'Company Logo' }],
    buttons: [],
  },
  position: { startY: 0, endY: 80, height: 80 },
});

const TESTIMONIAL_SECTION: DetectedSection = createSection('testimonial', {
  content: {
    headings: [{ level: 2, text: 'What Our Customers Say' }],
    paragraphs: [
      '"This product changed my life!" - John Doe, CEO',
      '"Absolutely amazing service." - Jane Smith, Designer',
    ],
    links: [],
    images: [
      { src: '/avatar1.jpg', alt: 'John Doe' },
      { src: '/avatar2.jpg', alt: 'Jane Smith' },
    ],
    buttons: [],
  },
});

const PRICING_SECTION: DetectedSection = createSection('pricing', {
  content: {
    headings: [
      { level: 2, text: 'Pricing Plans' },
      { level: 3, text: 'Basic' },
      { level: 3, text: 'Pro' },
      { level: 3, text: 'Enterprise' },
    ],
    paragraphs: ['$9.99/mo', '$29.99/mo', '$99.99/mo'],
    links: [],
    images: [],
    buttons: [
      { text: 'Select Basic', type: 'secondary' },
      { text: 'Select Pro', type: 'primary' },
      { text: 'Contact Sales', type: 'secondary' },
    ],
  },
});

const GALLERY_SECTION: DetectedSection = createSection('gallery', {
  content: {
    headings: [{ level: 2, text: 'Our Gallery' }],
    paragraphs: [],
    links: [],
    images: [
      { src: '/gallery1.jpg', alt: 'Project 1' },
      { src: '/gallery2.jpg', alt: 'Project 2' },
      { src: '/gallery3.jpg', alt: 'Project 3' },
      { src: '/gallery4.jpg', alt: 'Project 4' },
    ],
    buttons: [],
  },
});

const CONTACT_SECTION: DetectedSection = createSection('contact', {
  content: {
    headings: [{ level: 2, text: 'Contact Us' }],
    paragraphs: [
      'Email: contact@example.com',
      'Phone: +1-234-567-8900',
      'Address: 123 Main St, City',
    ],
    links: [],
    images: [],
    buttons: [{ text: 'Send Message', type: 'primary' }],
  },
});

const ABOUT_SECTION: DetectedSection = createSection('about', {
  content: {
    headings: [
      { level: 2, text: 'About Our Company' },
      { level: 3, text: 'Our Mission' },
    ],
    paragraphs: [
      'Founded in 2010, we have been serving customers worldwide.',
      'Our mission is to make technology accessible to everyone.',
    ],
    links: [],
    images: [{ src: '/team.jpg', alt: 'Our Team' }],
    buttons: [],
  },
});

// Mock LayoutInspectOutput for color/typography/grid testing
const MOCK_INSPECT_RESULT = {
  colors: {
    palette: [
      { hex: '#3B82F6', count: 10, role: 'primary' },
      { hex: '#FFFFFF', count: 20, role: 'background' },
      { hex: '#1F2937', count: 15, role: 'text' },
    ],
    dominant: '#3B82F6',
    background: '#FFFFFF',
    text: '#1F2937',
    accent: '#10B981',
  },
  typography: {
    fonts: [{ family: 'Inter', weights: [400, 500, 600, 700] }],
    headingScale: [48, 36, 24, 20, 18, 16],
    bodySize: 16,
    lineHeight: 1.5,
  },
  grid: {
    type: 'grid' as const,
    columns: 12,
    gutterWidth: 24,
    maxWidth: 1280,
    breakpoints: [
      { name: 'sm', minWidth: 640 },
      { name: 'md', minWidth: 768 },
      { name: 'lg', minWidth: 1024 },
    ],
  },
};

// =========================================
// Test Suites
// =========================================

describe('TextRepresentationGenerator', () => {
  let generator: TextRepresentationGenerator;

  beforeEach(() => {
    generator = new TextRepresentationGenerator();
  });

  // =========================================
  // 1. Initialization Tests (5 tests)
  // =========================================
  describe('Initialization', () => {
    it('should create instance with default options', () => {
      const gen = new TextRepresentationGenerator();
      expect(gen).toBeInstanceOf(TextRepresentationGenerator);
    });

    it('should create instance with custom maxLength', () => {
      const gen = new TextRepresentationGenerator({ maxLength: 1000 });
      expect(gen).toBeInstanceOf(TextRepresentationGenerator);
    });

    it('should create instance with language option', () => {
      const gen = new TextRepresentationGenerator({ language: 'ja' });
      expect(gen).toBeInstanceOf(TextRepresentationGenerator);
    });

    it('should create instance with format option', () => {
      const gen = new TextRepresentationGenerator({ format: 'structured' });
      expect(gen).toBeInstanceOf(TextRepresentationGenerator);
    });

    it('should create instance with all options', () => {
      const gen = new TextRepresentationGenerator({
        maxLength: 1500,
        includeColors: true,
        includeTypography: true,
        includeGrid: true,
        language: 'en',
        format: 'natural',
      });
      expect(gen).toBeInstanceOf(TextRepresentationGenerator);
    });
  });

  // =========================================
  // 2. Basic Generation Tests (6 tests)
  // =========================================
  describe('Basic Generation', () => {
    it('should generate text from single section', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.text).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);
    });

    it('should generate text from multiple sections', () => {
      const sections = [HERO_SECTION, FEATURE_SECTION, CTA_SECTION, FOOTER_SECTION];
      const result = generator.generate(sections);
      expect(result.text).toBeDefined();
      expect(result.sections.length).toBe(4);
    });

    it('should return sections array matching input count', () => {
      const sections = [HERO_SECTION, FEATURE_SECTION];
      const result = generator.generate(sections);
      expect(result.sections.length).toBe(2);
    });

    it('should include metadata in result', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.metadata).toBeDefined();
      expect(result.metadata.totalLength).toBeGreaterThan(0);
      expect(result.metadata.sectionCount).toBe(1);
      expect(result.metadata.language).toBe('en');
    });

    it('should handle empty sections array', () => {
      const result = generator.generate([]);
      expect(result.text).toBe('');
      expect(result.sections).toEqual([]);
      expect(result.metadata.sectionCount).toBe(0);
    });

    it('should respect maxLength option', () => {
      const gen = new TextRepresentationGenerator({ maxLength: 100 });
      const sections = [HERO_SECTION, FEATURE_SECTION, CTA_SECTION];
      const result = gen.generate(sections);
      expect(result.text.length).toBeLessThanOrEqual(100);
    });
  });

  // =========================================
  // 3. Natural Format Tests - English (8 tests)
  // =========================================
  describe('Natural Format - English', () => {
    beforeEach(() => {
      generator = new TextRepresentationGenerator({ format: 'natural', language: 'en' });
    });

    it('should generate natural language for hero section', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.text).toContain('Hero');
      expect(result.text).toContain('Welcome to Our Platform');
    });

    it('should include CTA button text in hero description', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.text).toContain('Get Started');
    });

    it('should describe feature section with item count', () => {
      const result = generator.generate([FEATURE_SECTION]);
      expect(result.text).toMatch(/feature|Feature/i);
    });

    it('should describe CTA section with buttons', () => {
      const result = generator.generate([CTA_SECTION]);
      expect(result.text).toMatch(/call.to.action|CTA|cta/i);
      expect(result.text).toContain('Sign Up Now');
    });

    it('should describe footer section', () => {
      const result = generator.generate([FOOTER_SECTION]);
      expect(result.text).toMatch(/footer|Footer/i);
    });

    it('should describe navigation with links', () => {
      const result = generator.generate([NAVIGATION_SECTION]);
      expect(result.text).toMatch(/navigation|Navigation|nav/i);
    });

    it('should generate coherent multi-section description', () => {
      const sections = [NAVIGATION_SECTION, HERO_SECTION, FEATURE_SECTION, FOOTER_SECTION];
      const result = generator.generate(sections);
      // Should mention section count or structure
      expect(result.text.length).toBeGreaterThan(50);
    });

    it('should describe gradient background when present', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.text).toMatch(/gradient/i);
    });
  });

  // =========================================
  // 4. Natural Format Tests - Japanese (8 tests)
  // =========================================
  describe('Natural Format - Japanese', () => {
    beforeEach(() => {
      generator = new TextRepresentationGenerator({ format: 'natural', language: 'ja' });
    });

    it('should generate Japanese text for hero section', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.text).toMatch(/ヒーロー|ヒーローセクション/);
    });

    it('should include heading text in Japanese description', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.text).toContain('Welcome to Our Platform');
    });

    it('should describe feature section in Japanese', () => {
      const result = generator.generate([FEATURE_SECTION]);
      expect(result.text).toMatch(/フィーチャー|特徴|機能/);
    });

    it('should describe CTA section in Japanese', () => {
      const result = generator.generate([CTA_SECTION]);
      expect(result.text).toMatch(/CTA|コールトゥアクション|アクション/);
    });

    it('should describe footer section in Japanese', () => {
      const result = generator.generate([FOOTER_SECTION]);
      expect(result.text).toMatch(/フッター/);
    });

    it('should describe navigation in Japanese', () => {
      const result = generator.generate([NAVIGATION_SECTION]);
      expect(result.text).toMatch(/ナビゲーション|ナビ/);
    });

    it('should set Japanese language in metadata', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.metadata.language).toBe('ja');
    });

    it('should describe testimonial section in Japanese', () => {
      const result = generator.generate([TESTIMONIAL_SECTION]);
      expect(result.text).toMatch(/お客様の声|テスティモニアル|レビュー/);
    });
  });

  // =========================================
  // 5. Structured Format Tests (6 tests)
  // =========================================
  describe('Structured Format', () => {
    beforeEach(() => {
      generator = new TextRepresentationGenerator({ format: 'structured' });
    });

    it('should generate structured format with section tags', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.text).toContain('[SECTION:hero]');
    });

    it('should include position information in structured format', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.text).toMatch(/position:top/i);
    });

    it('should include heading in structured format', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.text).toContain('heading:');
    });

    it('should include button info in structured format', () => {
      const result = generator.generate([CTA_SECTION]);
      expect(result.text).toMatch(/buttons?:\d/);
    });

    it('should format feature section with column count', () => {
      const result = generator.generate([FEATURE_SECTION]);
      expect(result.text).toContain('[SECTION:feature]');
    });

    it('should include style info in structured format', () => {
      const result = generator.generate([HERO_SECTION]);
      expect(result.text).toMatch(/style:|gradient/);
    });
  });

  // =========================================
  // 6. Color Information Tests (4 tests)
  // =========================================
  describe('Color Information', () => {
    it('should include color info when option enabled', () => {
      const gen = new TextRepresentationGenerator({ includeColors: true });
      const result = gen.generate([HERO_SECTION], MOCK_INSPECT_RESULT);
      expect(result.text).toMatch(/#3B82F6|primary|blue/i);
    });

    it('should not include color info when option disabled', () => {
      const gen = new TextRepresentationGenerator({ includeColors: false });
      const result = gen.generate([HERO_SECTION], MOCK_INSPECT_RESULT);
      expect(result.text).not.toMatch(/\[COLORS\]/);
    });

    it('should generate color description correctly', () => {
      const gen = new TextRepresentationGenerator({ includeColors: true });
      const description = gen.generateColorDescription(MOCK_INSPECT_RESULT.colors);
      expect(description).toContain('#3B82F6');
      expect(description).toContain('#FFFFFF');
    });

    it('should include accent color when present', () => {
      const gen = new TextRepresentationGenerator({ includeColors: true });
      const description = gen.generateColorDescription(MOCK_INSPECT_RESULT.colors);
      expect(description).toContain('#10B981');
    });
  });

  // =========================================
  // 7. Typography Information Tests (4 tests)
  // =========================================
  describe('Typography Information', () => {
    it('should include typography info when option enabled', () => {
      const gen = new TextRepresentationGenerator({ includeTypography: true });
      const result = gen.generate([HERO_SECTION], MOCK_INSPECT_RESULT);
      expect(result.text).toMatch(/Inter|font|typography/i);
    });

    it('should not include typography info when option disabled', () => {
      const gen = new TextRepresentationGenerator({ includeTypography: false });
      const result = gen.generate([HERO_SECTION], MOCK_INSPECT_RESULT);
      expect(result.text).not.toMatch(/\[TYPOGRAPHY\]/);
    });

    it('should generate typography description correctly', () => {
      const gen = new TextRepresentationGenerator({ includeTypography: true });
      const description = gen.generateTypographyDescription(MOCK_INSPECT_RESULT.typography);
      expect(description).toContain('Inter');
      expect(description).toMatch(/48|heading/i);
    });

    it('should include font weights in description', () => {
      const gen = new TextRepresentationGenerator({ includeTypography: true });
      const description = gen.generateTypographyDescription(MOCK_INSPECT_RESULT.typography);
      expect(description).toMatch(/400|700|weight/i);
    });
  });

  // =========================================
  // 8. Grid Information Tests (4 tests)
  // =========================================
  describe('Grid Information', () => {
    it('should include grid info when option enabled', () => {
      const gen = new TextRepresentationGenerator({ includeGrid: true });
      const result = gen.generate([HERO_SECTION], MOCK_INSPECT_RESULT);
      expect(result.text).toMatch(/grid|12.column|columns/i);
    });

    it('should not include grid info when option disabled', () => {
      const gen = new TextRepresentationGenerator({ includeGrid: false });
      const result = gen.generate([HERO_SECTION], MOCK_INSPECT_RESULT);
      expect(result.text).not.toMatch(/\[GRID\]/);
    });

    it('should generate grid description correctly', () => {
      const gen = new TextRepresentationGenerator({ includeGrid: true });
      const description = gen.generateGridDescription(MOCK_INSPECT_RESULT.grid);
      expect(description).toContain('12');
      expect(description).toContain('1280');
    });

    it('should include gutter width in description', () => {
      const gen = new TextRepresentationGenerator({ includeGrid: true });
      const description = gen.generateGridDescription(MOCK_INSPECT_RESULT.grid);
      expect(description).toMatch(/24|gutter/i);
    });
  });

  // =========================================
  // 9. Section-Specific Generation Tests (8 tests)
  // =========================================
  describe('Section-Specific Generation', () => {
    it('should generate text for testimonial section', () => {
      const text = generator.generateForSection(TESTIMONIAL_SECTION);
      expect(text).toContain('What Our Customers Say');
    });

    it('should generate text for pricing section', () => {
      const text = generator.generateForSection(PRICING_SECTION);
      expect(text).toMatch(/pricing|Pricing|plan/i);
    });

    it('should generate text for gallery section', () => {
      const text = generator.generateForSection(GALLERY_SECTION);
      expect(text).toMatch(/gallery|Gallery/i);
      expect(text).toMatch(/4|image/i);
    });

    it('should generate text for contact section', () => {
      const text = generator.generateForSection(CONTACT_SECTION);
      expect(text).toMatch(/contact|Contact/i);
    });

    it('should generate text for about section', () => {
      const text = generator.generateForSection(ABOUT_SECTION);
      expect(text).toMatch(/about|About/i);
    });

    it('should include image count when relevant', () => {
      const text = generator.generateForSection(GALLERY_SECTION);
      expect(text).toMatch(/4|four|images/i);
    });

    it('should include button count when relevant', () => {
      const text = generator.generateForSection(CTA_SECTION);
      expect(text).toMatch(/2|two|buttons/i);
    });

    it('should handle unknown section type', () => {
      const unknownSection = createSection('unknown', {
        content: {
          headings: [{ level: 2, text: 'Generic Section' }],
          paragraphs: ['Some content here.'],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const text = generator.generateForSection(unknownSection);
      expect(text).toBeDefined();
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 10. Edge Cases Tests (6 tests)
  // =========================================
  describe('Edge Cases', () => {
    it('should handle section with no content', () => {
      const emptySection = createSection('hero', {
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = generator.generate([emptySection]);
      expect(result.text).toBeDefined();
    });

    it('should handle very long heading text', () => {
      const longHeading = 'A'.repeat(500);
      const section = createSection('hero', {
        content: {
          headings: [{ level: 1, text: longHeading }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = generator.generate([section]);
      expect(result.text.length).toBeLessThanOrEqual(2000);
    });

    it('should handle special characters in content', () => {
      const section = createSection('hero', {
        content: {
          headings: [{ level: 1, text: 'Welcome <script>alert("xss")</script>' }],
          paragraphs: ['Content with "quotes" and \'apostrophes\''],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = generator.generate([section]);
      expect(result.text).toBeDefined();
    });

    it('should handle unicode characters', () => {
      const section = createSection('hero', {
        content: {
          headings: [{ level: 1, text: 'Welcome to Platform' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = generator.generate([section]);
      expect(result.text).toContain('Welcome');
    });

    it('should handle many sections', () => {
      const sections = Array(20)
        .fill(null)
        .map((_, i) =>
          createSection('feature', {
            content: {
              headings: [{ level: 2, text: `Feature ${i + 1}` }],
              paragraphs: [`Description for feature ${i + 1}`],
              links: [],
              images: [],
              buttons: [],
            },
          })
        );
      const result = generator.generate(sections);
      expect(result.metadata.sectionCount).toBe(20);
    });

    it('should handle section with only images', () => {
      const imageOnlySection = createSection('gallery', {
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [
            { src: '/img1.jpg', alt: 'Image 1' },
            { src: '/img2.jpg', alt: 'Image 2' },
          ],
          buttons: [],
        },
      });
      const result = generator.generate([imageOnlySection]);
      expect(result.text).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 11. Length Limit Tests (4 tests)
  // =========================================
  describe('Length Limits', () => {
    it('should respect default maxLength of 2000', () => {
      const sections = Array(50)
        .fill(null)
        .map(() => HERO_SECTION);
      const result = generator.generate(sections);
      expect(result.text.length).toBeLessThanOrEqual(2000);
    });

    it('should respect custom maxLength', () => {
      const gen = new TextRepresentationGenerator({ maxLength: 500 });
      const sections = [HERO_SECTION, FEATURE_SECTION, CTA_SECTION, FOOTER_SECTION];
      const result = gen.generate(sections);
      expect(result.text.length).toBeLessThanOrEqual(500);
    });

    it('should prioritize important sections when truncating', () => {
      const gen = new TextRepresentationGenerator({ maxLength: 200 });
      const sections = [HERO_SECTION, FEATURE_SECTION, FOOTER_SECTION];
      const result = gen.generate(sections);
      // Hero should be included as it's first and important
      expect(result.text).toMatch(/hero|Hero|Welcome/i);
    });

    it('should indicate truncation in metadata', () => {
      const gen = new TextRepresentationGenerator({ maxLength: 50 });
      const sections = [HERO_SECTION, FEATURE_SECTION];
      const result = gen.generate(sections);
      expect(result.metadata.totalLength).toBeLessThanOrEqual(50);
    });
  });

  // =========================================
  // 12. Integration with InspectResult Tests (4 tests)
  // =========================================
  describe('Integration with InspectResult', () => {
    it('should generate comprehensive output with all options enabled', () => {
      const gen = new TextRepresentationGenerator({
        includeColors: true,
        includeTypography: true,
        includeGrid: true,
        format: 'natural',
      });
      const result = gen.generate([HERO_SECTION, FEATURE_SECTION], MOCK_INSPECT_RESULT);
      expect(result.text).toMatch(/Inter|font/i);
      expect(result.text).toMatch(/#3B82F6|blue|primary/i);
      expect(result.text).toMatch(/12|column|grid/i);
    });

    it('should handle missing inspectResult gracefully', () => {
      const gen = new TextRepresentationGenerator({
        includeColors: true,
        includeTypography: true,
        includeGrid: true,
      });
      const result = gen.generate([HERO_SECTION]);
      expect(result.text).toBeDefined();
    });

    it('should handle partial inspectResult', () => {
      const partialResult = {
        colors: MOCK_INSPECT_RESULT.colors,
      };
      const gen = new TextRepresentationGenerator({
        includeColors: true,
        includeTypography: true,
      });
      const result = gen.generate([HERO_SECTION], partialResult as any);
      expect(result.text).toBeDefined();
    });

    it('should generate structured format with all metadata', () => {
      const gen = new TextRepresentationGenerator({
        format: 'structured',
        includeColors: true,
        includeTypography: true,
        includeGrid: true,
      });
      const result = gen.generate([HERO_SECTION], MOCK_INSPECT_RESULT);
      expect(result.text).toContain('[SECTION:hero]');
      expect(result.text).toContain('[COLORS]');
      expect(result.text).toContain('[TYPOGRAPHY]');
      expect(result.text).toContain('[GRID]');
    });
  });

  // =========================================
  // 13. Output Quality Tests (4 tests)
  // =========================================
  describe('Output Quality', () => {
    it('should generate human-readable natural language', () => {
      const gen = new TextRepresentationGenerator({ format: 'natural', language: 'en' });
      const result = gen.generate([HERO_SECTION, FEATURE_SECTION]);
      // Should contain complete sentences
      expect(result.text).toMatch(/\./);
      // Should not have excessive technical jargon
      expect(result.text).not.toMatch(/\[\[|\]\]/);
    });

    it('should generate parseable structured format', () => {
      const gen = new TextRepresentationGenerator({ format: 'structured' });
      const result = gen.generate([HERO_SECTION]);
      // Should have consistent tag format
      expect(result.text).toMatch(/\[SECTION:\w+\]/);
    });

    it('should include meaningful content for embeddings', () => {
      const result = generator.generate([HERO_SECTION, FEATURE_SECTION, CTA_SECTION]);
      // Should include key semantic information
      expect(result.text).toContain('Welcome to Our Platform');
      expect(result.text).toContain('Get Started');
    });

    it('should maintain section order in output', () => {
      const sections = [NAVIGATION_SECTION, HERO_SECTION, FEATURE_SECTION, FOOTER_SECTION];
      const result = generator.generate(sections);
      const navIndex = result.text.toLowerCase().indexOf('navigation');
      const footerIndex = result.text.toLowerCase().indexOf('footer');
      if (navIndex !== -1 && footerIndex !== -1) {
        expect(navIndex).toBeLessThan(footerIndex);
      }
    });
  });

  // =========================================
  // 14. Language Consistency Tests (3 tests)
  // =========================================
  describe('Language Consistency', () => {
    it('should maintain consistent language throughout output', () => {
      const gen = new TextRepresentationGenerator({ language: 'ja', format: 'natural' });
      const result = gen.generate([HERO_SECTION, FEATURE_SECTION]);
      // Japanese output should not mix with English section names
      const hasJapaneseSection = /ヒーロー|フィーチャー|セクション/.test(result.text);
      expect(hasJapaneseSection).toBe(true);
    });

    it('should keep original content language regardless of output language', () => {
      const gen = new TextRepresentationGenerator({ language: 'ja' });
      const result = gen.generate([HERO_SECTION]);
      // Original English heading should still be present
      expect(result.text).toContain('Welcome to Our Platform');
    });

    it('should use English for structured format regardless of language option', () => {
      const gen = new TextRepresentationGenerator({ language: 'ja', format: 'structured' });
      const result = gen.generate([HERO_SECTION]);
      // Structured format uses English tags for consistency
      expect(result.text).toContain('[SECTION:hero]');
    });
  });

  // =========================================
  // 15. Incomplete Section Fallback Tests (TDD RED Phase)
  // =========================================
  describe('Incomplete Section Fallback', () => {
    /**
     * Issue: Sections with incomplete content (images only, empty text, etc.)
     * result in empty or meaningless text_representation, affecting layout.search accuracy.
     *
     * Requirements:
     * - Generate fallback text containing section type + structure info
     * - Output should be 50-500 characters for 768-dimension embedding
     * - Maintain API compatibility
     */

    it('should generate fallback text for image-only sections with structure info', () => {
      const imageOnlySection = createSection('gallery', {
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [
            { src: '/img1.jpg', alt: 'Product showcase' },
            { src: '/img2.jpg', alt: 'Team photo' },
            { src: '/img3.jpg', alt: 'Office interior' },
          ],
          buttons: [],
        },
      });
      const result = generator.generate([imageOnlySection]);

      // Fallback should include section type
      expect(result.text).toMatch(/gallery|Gallery/i);

      // Fallback should include image count
      expect(result.text).toMatch(/3|three/i);

      // Fallback should include image alt texts for semantic meaning
      expect(result.text).toMatch(/Product|Team|Office/i);

      // Length should be appropriate for embeddings (50-500 chars)
      expect(result.text.length).toBeGreaterThanOrEqual(50);
      expect(result.text.length).toBeLessThanOrEqual(500);
    });

    it('should generate fallback text for empty content sections with section type', () => {
      const emptySection = createSection('hero', {
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
        style: {
          backgroundColor: '#1a1a1a',
          hasGradient: true,
        },
      });
      const result = generator.generate([emptySection]);

      // Should still have meaningful text even with no content
      expect(result.text).toMatch(/hero|Hero/i);

      // Should include style information as fallback
      expect(result.text).toMatch(/gradient|dark|background/i);

      // Length should be appropriate for embeddings
      expect(result.text.length).toBeGreaterThanOrEqual(50);
    });

    it('should generate fallback text for sections with only links', () => {
      const linkOnlySection = createSection('navigation', {
        content: {
          headings: [],
          paragraphs: [],
          links: [
            { text: 'Home', href: '/' },
            { text: 'Products', href: '/products' },
            { text: 'About', href: '/about' },
            { text: 'Contact', href: '/contact' },
          ],
          images: [],
          buttons: [],
        },
      });
      const result = generator.generate([linkOnlySection]);

      // Should include navigation info
      expect(result.text).toMatch(/navigation|Navigation/i);

      // Should include link count
      expect(result.text).toMatch(/4|four/i);

      // Should include link text for semantic meaning
      expect(result.text).toMatch(/Home|Products|About|Contact/i);

      // Length check
      expect(result.text.length).toBeGreaterThanOrEqual(50);
    });

    it('should generate fallback text for sections with only style/position info', () => {
      const styleOnlySection = createSection('feature', {
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
        style: {
          backgroundColor: '#f5f5f5',
          textColor: '#333333',
        },
        position: {
          startY: 500,
          endY: 900,
          height: 400,
        },
      });
      const result = generator.generate([styleOnlySection]);

      // Should describe section type
      expect(result.text).toMatch(/feature|Feature/i);

      // Should describe position
      expect(result.text).toMatch(/middle|center/i);

      // Should describe layout/style properties
      expect(result.text).toMatch(/400|height|pixels?/i);

      // Length check
      expect(result.text.length).toBeGreaterThanOrEqual(50);
    });

    it('should include grid info in fallback when available', () => {
      const gridSection = createSection('feature', {
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [
            { src: '/icon1.svg', alt: '' },
            { src: '/icon2.svg', alt: '' },
            { src: '/icon3.svg', alt: '' },
          ],
          buttons: [],
        },
      });

      const inspectResult = {
        grid: {
          type: 'grid' as const,
          columns: 3,
          gutterWidth: 24,
          maxWidth: 1200,
        },
      };

      const gen = new TextRepresentationGenerator({ includeGrid: true });
      const result = gen.generate([gridSection], inspectResult);

      // Should include grid column info
      expect(result.text).toMatch(/3.column|3-column|three.column/i);

      // Length check
      expect(result.text.length).toBeGreaterThanOrEqual(50);
    });

    it('should generate fallback in Japanese for empty sections', () => {
      const emptySection = createSection('testimonial', {
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [{ src: '/avatar.jpg', alt: 'User avatar' }],
          buttons: [],
        },
      });

      const gen = new TextRepresentationGenerator({ language: 'ja' });
      const result = gen.generate([emptySection]);

      // Should use Japanese labels
      expect(result.text).toMatch(/お客様の声|テスティモニアル/);

      // Should include image info in Japanese context
      expect(result.text.length).toBeGreaterThanOrEqual(50);
    });

    it('should generate fallback in structured format for incomplete sections', () => {
      const incompleteSection = createSection('pricing', {
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [
            { text: 'Select Plan', type: 'primary' },
          ],
        },
      });

      const gen = new TextRepresentationGenerator({ format: 'structured' });
      const result = gen.generate([incompleteSection]);

      // Should include section tag
      expect(result.text).toContain('[SECTION:pricing]');

      // Should include button info
      expect(result.text).toMatch(/buttons?:1/);

      // Should include CTA text
      expect(result.text).toContain('Select Plan');

      // Length check
      expect(result.text.length).toBeGreaterThanOrEqual(50);
    });

    it('should combine multiple incomplete elements for richer fallback', () => {
      const mixedIncompleteSection = createSection('about', {
        content: {
          headings: [],
          paragraphs: [],
          links: [{ text: 'Learn more', href: '/about' }],
          images: [
            { src: '/team1.jpg', alt: 'Team member' },
            { src: '/team2.jpg', alt: 'Team member' },
          ],
          buttons: [],
        },
        style: {
          backgroundColor: '#ffffff',
        },
        position: {
          startY: 1000,
          endY: 1500,
          height: 500,
        },
      });
      const result = generator.generate([mixedIncompleteSection]);

      // Should include section type
      expect(result.text).toMatch(/about|About/i);

      // Should include image count
      expect(result.text).toMatch(/2|two|images?/i);

      // Should include link info
      expect(result.text).toMatch(/link|Learn more/i);

      // Should describe position
      expect(result.text).toMatch(/bottom|lower/i);

      // Length should be appropriate
      expect(result.text.length).toBeGreaterThanOrEqual(50);
      expect(result.text.length).toBeLessThanOrEqual(500);
    });

    it('should ensure minimum text length for embedding quality', () => {
      // Create minimal sections that might generate very short text
      const minimalSections = [
        createSection('unknown', {
          content: {
            headings: [],
            paragraphs: [],
            links: [],
            images: [],
            buttons: [],
          },
        }),
        createSection('footer', {
          content: {
            headings: [],
            paragraphs: [],
            links: [],
            images: [],
            buttons: [],
          },
        }),
      ];

      const result = generator.generate(minimalSections);

      // Even minimal sections should generate enough text for embeddings
      // 50 characters minimum for meaningful embedding
      expect(result.text.length).toBeGreaterThanOrEqual(50);
    });
  });
});
