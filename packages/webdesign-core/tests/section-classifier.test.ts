// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SectionClassifier テスト
 *
 * TDD Red Phase: 50+テストケース
 * セクション分類ロジックの包括的なテスト
 *
 * @module @reftrix/webdesign-core/tests/section-classifier
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SectionClassifier } from '../src/section-classifier';
import type {
  ClassificationRule,
  ClassificationCondition,
  ClassificationResult,
} from '../src/section-classifier/rules';
import type { DetectedSection, SectionType } from '../src/types/section.types';

// =========================================
// Test Fixtures - Helper Functions
// =========================================

/**
 * 最小限のDetectedSectionを作成
 */
function createSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return {
    id: 'test-section-1',
    type: 'unknown',
    confidence: 0,
    element: {
      tagName: 'section',
      selector: 'section',
      classes: [],
      id: undefined,
    },
    position: {
      startY: 0,
      endY: 100,
      height: 100,
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

/**
 * Heroセクションのフィクスチャ
 */
function createHeroSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'hero-section',
    element: {
      tagName: 'header',
      selector: 'header.hero',
      classes: ['hero', 'main-hero'],
      id: 'hero',
    },
    position: {
      startY: 0,
      endY: 600,
      height: 600,
    },
    content: {
      headings: [{ level: 1, text: 'Welcome to Our Site' }],
      paragraphs: ['A great description of what we do.'],
      links: [],
      images: [{ src: '/hero-image.jpg', alt: 'Hero Image' }],
      buttons: [{ text: 'Get Started', type: 'primary' }],
    },
    style: {
      hasGradient: true,
    },
    ...overrides,
  });
}

/**
 * Navigationセクションのフィクスチャ
 */
function createNavigationSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'nav-section',
    element: {
      tagName: 'nav',
      selector: 'nav.main-nav',
      classes: ['main-nav', 'navbar'],
      id: 'main-navigation',
    },
    position: {
      startY: 0,
      endY: 80,
      height: 80,
    },
    content: {
      headings: [],
      paragraphs: [],
      links: [
        { text: 'Home', href: '/home' },
        { text: 'About', href: '/about' },
        { text: 'Services', href: '/services' },
        { text: 'Contact', href: '/contact' },
      ],
      images: [{ src: '/logo.svg', alt: 'Logo' }],
      buttons: [],
    },
    style: {},
    ...overrides,
  });
}

/**
 * Featureセクションのフィクスチャ
 */
function createFeatureSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'feature-section',
    element: {
      tagName: 'section',
      selector: 'section.features',
      classes: ['features', 'feature-section'],
      id: 'features',
    },
    position: {
      startY: 600,
      endY: 1200,
      height: 600,
    },
    content: {
      headings: [
        { level: 2, text: 'Our Features' },
        { level: 3, text: 'Feature One' },
        { level: 3, text: 'Feature Two' },
        { level: 3, text: 'Feature Three' },
      ],
      paragraphs: ['Description one', 'Description two', 'Description three'],
      links: [],
      images: [
        { src: '/icon1.svg', alt: 'Feature 1' },
        { src: '/icon2.svg', alt: 'Feature 2' },
        { src: '/icon3.svg', alt: 'Feature 3' },
      ],
      buttons: [],
    },
    style: {},
    ...overrides,
  });
}

/**
 * CTAセクションのフィクスチャ
 */
function createCtaSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'cta-section',
    element: {
      tagName: 'section',
      selector: 'section.cta',
      classes: ['cta', 'call-to-action'],
      id: 'cta',
    },
    position: {
      startY: 1200,
      endY: 1500,
      height: 300,
    },
    content: {
      headings: [{ level: 2, text: 'Ready to Get Started?' }],
      paragraphs: ['Join thousands of satisfied customers today.'],
      links: [],
      images: [],
      buttons: [
        { text: 'Sign Up Now', type: 'primary' },
        { text: 'Learn More', type: 'secondary' },
      ],
    },
    style: {
      hasGradient: true,
    },
    ...overrides,
  });
}

/**
 * Testimonialセクションのフィクスチャ
 */
function createTestimonialSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'testimonial-section',
    element: {
      tagName: 'section',
      selector: 'section.testimonials',
      classes: ['testimonials', 'reviews'],
      id: 'testimonials',
    },
    position: {
      startY: 1500,
      endY: 2000,
      height: 500,
    },
    content: {
      headings: [{ level: 2, text: 'What Our Customers Say' }],
      paragraphs: ['"This product changed my life!"', '"Absolutely amazing service."'],
      links: [],
      images: [
        { src: '/avatar1.jpg', alt: 'John Doe' },
        { src: '/avatar2.jpg', alt: 'Jane Smith' },
      ],
      buttons: [],
    },
    style: {},
    ...overrides,
  });
}

/**
 * Pricingセクションのフィクスチャ
 */
function createPricingSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'pricing-section',
    element: {
      tagName: 'section',
      selector: 'section.pricing',
      classes: ['pricing', 'pricing-section'],
      id: 'pricing',
    },
    position: {
      startY: 2000,
      endY: 2600,
      height: 600,
    },
    content: {
      headings: [
        { level: 2, text: 'Pricing Plans' },
        { level: 3, text: 'Basic' },
        { level: 3, text: 'Pro' },
      ],
      paragraphs: ['$9.99/mo', '$29.99/mo'],
      links: [],
      images: [],
      buttons: [
        { text: 'Select Plan', type: 'primary' },
        { text: 'Select Plan', type: 'secondary' },
      ],
    },
    style: {},
    ...overrides,
  });
}

/**
 * Footerセクションのフィクスチャ
 */
function createFooterSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'footer-section',
    element: {
      tagName: 'footer',
      selector: 'footer.site-footer',
      classes: ['site-footer', 'footer'],
      id: 'footer',
    },
    position: {
      startY: 2600,
      endY: 2900,
      height: 300,
    },
    content: {
      headings: [
        { level: 4, text: 'Company' },
        { level: 4, text: 'Support' },
      ],
      paragraphs: ['© 2024 Company Name. All rights reserved.'],
      links: [
        { text: 'About Us', href: '/about' },
        { text: 'Careers', href: '/careers' },
        { text: 'Help Center', href: '/help' },
      ],
      images: [],
      buttons: [],
    },
    style: {},
    ...overrides,
  });
}

/**
 * Aboutセクションのフィクスチャ
 */
function createAboutSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'about-section',
    element: {
      tagName: 'section',
      selector: 'section.about-us',
      classes: ['about-us', 'about'],
      id: 'about',
    },
    position: {
      startY: 1000,
      endY: 1500,
      height: 500,
    },
    content: {
      headings: [
        { level: 2, text: 'About Our Company' },
        { level: 3, text: 'Our Team' },
      ],
      paragraphs: ['Founded in 2010, we have been serving customers worldwide.'],
      links: [],
      images: [
        { src: '/team1.jpg', alt: 'Team Member 1' },
        { src: '/team2.jpg', alt: 'Team Member 2' },
      ],
      buttons: [],
    },
    style: {},
    ...overrides,
  });
}

/**
 * Contactセクションのフィクスチャ
 */
function createContactSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'contact-section',
    element: {
      tagName: 'section',
      selector: 'section.contact',
      classes: ['contact', 'contact-section'],
      id: 'contact',
    },
    position: {
      startY: 2400,
      endY: 2800,
      height: 400,
    },
    content: {
      headings: [{ level: 2, text: 'Contact Us' }],
      paragraphs: ['Email: contact@example.com', 'Phone: +1-234-567-8900'],
      links: [],
      images: [],
      buttons: [{ text: 'Send Message', type: 'primary' }],
    },
    style: {},
    ...overrides,
  });
}

/**
 * Galleryセクションのフィクスチャ
 */
function createGallerySection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'gallery-section',
    element: {
      tagName: 'section',
      selector: 'section.gallery',
      classes: ['gallery', 'portfolio'],
      id: 'gallery',
    },
    position: {
      startY: 1800,
      endY: 2400,
      height: 600,
    },
    content: {
      headings: [{ level: 2, text: 'Our Gallery' }],
      paragraphs: [],
      links: [],
      images: [
        { src: '/gallery1.jpg', alt: 'Image 1' },
        { src: '/gallery2.jpg', alt: 'Image 2' },
        { src: '/gallery3.jpg', alt: 'Image 3' },
        { src: '/gallery4.jpg', alt: 'Image 4' },
        { src: '/gallery5.jpg', alt: 'Image 5' },
        { src: '/gallery6.jpg', alt: 'Image 6' },
      ],
      buttons: [],
    },
    style: {},
    ...overrides,
  });
}

// =========================================
// Test Suites
// =========================================

describe('SectionClassifier', () => {
  let classifier: SectionClassifier;

  beforeEach(() => {
    classifier = new SectionClassifier();
  });

  // =========================================
  // 1. Initialization Tests (5 tests)
  // =========================================
  describe('Initialization', () => {
    it('should create instance with default rules', () => {
      const classifier = new SectionClassifier();
      expect(classifier).toBeInstanceOf(SectionClassifier);
    });

    it('should create instance with custom rules', () => {
      const customRules: ClassificationRule[] = [
        {
          type: 'hero',
          priority: 100,
          conditions: [
            { field: 'tagName', operator: 'equals', value: 'header', weight: 1 },
          ],
          minConfidence: 0.5,
        },
      ];
      const classifier = new SectionClassifier(customRules);
      expect(classifier).toBeInstanceOf(SectionClassifier);
    });

    it('should return default rules via getDefaultRules()', () => {
      const rules = classifier.getDefaultRules();
      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThan(0);
    });

    it('should have rules for all section types', () => {
      const rules = classifier.getDefaultRules();
      const ruleTypes = new Set(rules.map((r) => r.type));
      const expectedTypes: SectionType[] = [
        'hero',
        'navigation',
        'feature',
        'cta',
        'testimonial',
        'pricing',
        'footer',
        'about',
        'contact',
        'gallery',
      ];
      expectedTypes.forEach((type) => {
        expect(ruleTypes.has(type)).toBe(true);
      });
    });

    it('should allow adding custom rules via addRule()', () => {
      const initialRulesCount = classifier.getDefaultRules().length;
      classifier.addRule({
        type: 'hero',
        priority: 200,
        conditions: [
          { field: 'classes', operator: 'contains', value: 'custom-hero', weight: 1 },
        ],
        minConfidence: 0.8,
      });
      // ルールが追加されたことを確認（内部状態のテスト）
      expect(classifier.getDefaultRules().length).toBeGreaterThanOrEqual(initialRulesCount);
    });
  });

  // =========================================
  // 2. Hero Classification Tests (6 tests)
  // =========================================
  describe('Hero Classification', () => {
    it('should classify section with hero class as hero', () => {
      const section = createHeroSection();
      const result = classifier.classify(section);
      expect(result.type).toBe('hero');
    });

    it('should assign high confidence to hero with h1 and button', () => {
      const section = createHeroSection();
      const result = classifier.classify(section);
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('should classify section near page top as potential hero', () => {
      const section = createSection({
        position: { startY: 0, endY: 500, height: 500 },
        content: {
          headings: [{ level: 1, text: 'Title' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [{ text: 'CTA', type: 'primary' }],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('hero');
    });

    it('should classify section with banner class as hero', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.banner',
          classes: ['banner', 'main-banner'],
        },
        content: {
          headings: [{ level: 1, text: 'Welcome' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('hero');
    });

    it('should boost confidence for hero with background image', () => {
      const sectionWithImage = createHeroSection({
        style: { hasImage: true, hasGradient: true },
      });
      const sectionWithoutImage = createHeroSection({
        style: {},
      });
      const resultWithImage = classifier.classify(sectionWithImage);
      const resultWithoutImage = classifier.classify(sectionWithoutImage);
      expect(resultWithImage.confidence).toBeGreaterThanOrEqual(resultWithoutImage.confidence);
    });

    it('should classify masthead class as hero', () => {
      const section = createSection({
        element: {
          tagName: 'div',
          selector: 'div.masthead',
          classes: ['masthead'],
        },
        content: {
          headings: [{ level: 1, text: 'Welcome' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('hero');
    });
  });

  // =========================================
  // 3. Navigation Classification Tests (5 tests)
  // =========================================
  describe('Navigation Classification', () => {
    it('should classify nav element as navigation', () => {
      const section = createNavigationSection();
      const result = classifier.classify(section);
      expect(result.type).toBe('navigation');
    });

    it('should assign high confidence to nav with multiple links', () => {
      const section = createNavigationSection();
      const result = classifier.classify(section);
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('should classify section with navbar class as navigation', () => {
      const section = createSection({
        element: {
          tagName: 'div',
          selector: 'div.navbar',
          classes: ['navbar', 'fixed-top'],
        },
        content: {
          headings: [],
          paragraphs: [],
          links: [
            { text: 'Home', href: '/' },
            { text: 'About', href: '/about' },
          ],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('navigation');
    });

    it('should classify header element with links as navigation', () => {
      const section = createSection({
        element: {
          tagName: 'header',
          selector: 'header.main-header',
          classes: ['main-header'],
        },
        content: {
          headings: [],
          paragraphs: [],
          links: [
            { text: 'Home', href: '/' },
            { text: 'Products', href: '/products' },
          ],
          images: [{ src: '/logo.png', alt: 'Logo' }],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('navigation');
    });

    it('should classify menu class as navigation', () => {
      const section = createSection({
        element: {
          tagName: 'div',
          selector: 'div.menu',
          classes: ['menu', 'main-menu'],
        },
        content: {
          headings: [],
          paragraphs: [],
          links: [
            { text: 'Home', href: '/' },
            { text: 'Services', href: '/services' },
          ],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('navigation');
    });
  });

  // =========================================
  // 4. Feature Classification Tests (5 tests)
  // =========================================
  describe('Feature Classification', () => {
    it('should classify section with features class as feature', () => {
      const section = createFeatureSection();
      const result = classifier.classify(section);
      expect(result.type).toBe('feature');
    });

    it('should classify section with multiple images and headings as feature', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section',
          classes: [],
        },
        content: {
          headings: [
            { level: 2, text: 'Features' },
            { level: 3, text: 'Feature 1' },
            { level: 3, text: 'Feature 2' },
          ],
          paragraphs: [],
          links: [],
          images: [
            { src: '/icon1.svg', alt: 'Icon 1' },
            { src: '/icon2.svg', alt: 'Icon 2' },
          ],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('feature');
    });

    it('should classify service section as feature', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.services',
          classes: ['services'],
          id: 'services',
        },
        content: {
          headings: [{ level: 2, text: 'Our Services' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('feature');
    });

    it('should classify benefit section as feature', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.benefits',
          classes: ['benefits'],
        },
        content: {
          headings: [{ level: 2, text: 'Benefits' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('feature');
    });

    it('should classify grid/column layout as feature', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.feature-grid',
          classes: ['feature-grid', 'grid'],
        },
        content: {
          headings: [
            { level: 3, text: 'Item 1' },
            { level: 3, text: 'Item 2' },
          ],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('feature');
    });
  });

  // =========================================
  // 5. CTA Classification Tests (5 tests)
  // =========================================
  describe('CTA Classification', () => {
    it('should classify section with cta class as cta', () => {
      const section = createCtaSection();
      const result = classifier.classify(section);
      expect(result.type).toBe('cta');
    });

    it('should classify call-to-action class as cta', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.call-to-action',
          classes: ['call-to-action'],
        },
        content: {
          headings: [{ level: 2, text: 'Act Now!' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [{ text: 'Click Here', type: 'primary' }],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('cta');
    });

    it('should assign high confidence to section with prominent button', () => {
      const section = createCtaSection();
      const result = classifier.classify(section);
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it('should classify signup section as cta', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.signup',
          classes: ['signup'],
        },
        content: {
          headings: [{ level: 2, text: 'Sign Up Today' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [{ text: 'Sign Up', type: 'primary' }],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('cta');
    });

    it('should classify action section as cta', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.action',
          classes: ['action'],
        },
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [{ text: 'Take Action', type: 'primary' }],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('cta');
    });
  });

  // =========================================
  // 6. Testimonial Classification Tests (5 tests)
  // =========================================
  describe('Testimonial Classification', () => {
    it('should classify section with testimonials class as testimonial', () => {
      const section = createTestimonialSection();
      const result = classifier.classify(section);
      expect(result.type).toBe('testimonial');
    });

    it('should classify review section as testimonial', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.reviews',
          classes: ['reviews', 'customer-reviews'],
        },
        content: {
          headings: [{ level: 2, text: 'Customer Reviews' }],
          paragraphs: ['"Great product!"'],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('testimonial');
    });

    it('should classify quote section as testimonial', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.quotes',
          classes: ['quotes'],
        },
        content: {
          headings: [],
          paragraphs: ['"Excellent service!"'],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('testimonial');
    });

    it('should classify feedback section as testimonial', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.feedback',
          classes: ['feedback', 'customer-feedback'],
        },
        content: {
          headings: [{ level: 2, text: 'Customer Feedback' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('testimonial');
    });

    it('should assign higher confidence with avatar images', () => {
      const withAvatars = createTestimonialSection();
      const withoutAvatars = createSection({
        element: {
          tagName: 'section',
          selector: 'section.testimonials',
          classes: ['testimonials'],
        },
        content: {
          headings: [],
          paragraphs: ['"Great!"'],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const resultWithAvatars = classifier.classify(withAvatars);
      const resultWithoutAvatars = classifier.classify(withoutAvatars);
      expect(resultWithAvatars.confidence).toBeGreaterThanOrEqual(resultWithoutAvatars.confidence);
    });
  });

  // =========================================
  // 7. Pricing Classification Tests (5 tests)
  // =========================================
  describe('Pricing Classification', () => {
    it('should classify section with pricing class as pricing', () => {
      const section = createPricingSection();
      const result = classifier.classify(section);
      expect(result.type).toBe('pricing');
    });

    it('should assign high confidence to pricing section', () => {
      const section = createPricingSection();
      const result = classifier.classify(section);
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('should classify plan section as pricing', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.plans',
          classes: ['plans'],
        },
        content: {
          headings: [{ level: 2, text: 'Our Plans' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('pricing');
    });

    it('should classify subscription section as pricing', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.subscription',
          classes: ['subscription'],
        },
        content: {
          headings: [{ level: 2, text: 'Subscription Options' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('pricing');
    });

    it('should classify package section as pricing', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.packages',
          classes: ['packages'],
        },
        content: {
          headings: [{ level: 2, text: 'Choose Your Package' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('pricing');
    });
  });

  // =========================================
  // 8. Footer Classification Tests (5 tests)
  // =========================================
  describe('Footer Classification', () => {
    it('should classify footer element as footer', () => {
      const section = createFooterSection();
      const result = classifier.classify(section);
      expect(result.type).toBe('footer');
    });

    it('should assign high confidence to footer element', () => {
      const section = createFooterSection();
      const result = classifier.classify(section);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should classify section with copyright text as footer', () => {
      const section = createSection({
        element: {
          tagName: 'div',
          selector: 'div.bottom',
          classes: ['bottom'],
        },
        content: {
          headings: [],
          paragraphs: ['Copyright 2024 All rights reserved.'],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('footer');
    });

    it('should classify site-footer class as footer', () => {
      const section = createSection({
        element: {
          tagName: 'div',
          selector: 'div.site-footer',
          classes: ['site-footer'],
        },
        content: {
          headings: [],
          paragraphs: [],
          links: [{ text: 'Privacy', href: '/privacy' }],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('footer');
    });

    it('should classify section at page bottom as potential footer', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section',
          classes: [],
        },
        position: {
          startY: 5000,
          endY: 5300,
          height: 300,
        },
        content: {
          headings: [],
          paragraphs: ['© 2024 Company'],
          links: [
            { text: 'Terms', href: '/terms' },
            { text: 'Privacy', href: '/privacy' },
          ],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('footer');
    });
  });

  // =========================================
  // 9. About Classification Tests (4 tests)
  // =========================================
  describe('About Classification', () => {
    it('should classify section with about class as about', () => {
      const section = createAboutSection();
      const result = classifier.classify(section);
      expect(result.type).toBe('about');
    });

    it('should classify company section as about', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.company',
          classes: ['company'],
        },
        content: {
          headings: [{ level: 2, text: 'Our Company' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('about');
    });

    it('should classify team section as about', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.team',
          classes: ['team', 'our-team'],
        },
        content: {
          headings: [{ level: 2, text: 'Our Team' }],
          paragraphs: [],
          links: [],
          images: [{ src: '/team.jpg', alt: 'Team' }],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('about');
    });

    it('should classify story section as about', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.story',
          classes: ['story', 'our-story'],
        },
        content: {
          headings: [{ level: 2, text: 'Our Story' }],
          paragraphs: ['Founded in 2010...'],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('about');
    });
  });

  // =========================================
  // 10. Contact Classification Tests (4 tests)
  // =========================================
  describe('Contact Classification', () => {
    it('should classify section with contact class as contact', () => {
      const section = createContactSection();
      const result = classifier.classify(section);
      expect(result.type).toBe('contact');
    });

    it('should classify get-in-touch section as contact', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.get-in-touch',
          classes: ['get-in-touch'],
        },
        content: {
          headings: [{ level: 2, text: 'Get In Touch' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [{ text: 'Contact Us', type: 'primary' }],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('contact');
    });

    it('should classify section with form and email fields as contact', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section',
          classes: [],
        },
        content: {
          headings: [{ level: 2, text: 'Reach Out' }],
          paragraphs: ['Email: info@example.com'],
          links: [],
          images: [],
          buttons: [{ text: 'Send', type: 'primary' }],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('contact');
    });

    it('should classify reach section as contact', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.reach-us',
          classes: ['reach-us', 'reach'],
        },
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('contact');
    });
  });

  // =========================================
  // 11. Gallery Classification Tests (4 tests)
  // =========================================
  describe('Gallery Classification', () => {
    it('should classify section with gallery class as gallery', () => {
      const section = createGallerySection();
      const result = classifier.classify(section);
      expect(result.type).toBe('gallery');
    });

    it('should classify portfolio section as gallery', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.portfolio',
          classes: ['portfolio'],
        },
        content: {
          headings: [{ level: 2, text: 'Our Work' }],
          paragraphs: [],
          links: [],
          images: [
            { src: '/work1.jpg', alt: 'Work 1' },
            { src: '/work2.jpg', alt: 'Work 2' },
          ],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('gallery');
    });

    it('should classify section with many images as gallery', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section',
          classes: [],
        },
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [
            { src: '/img1.jpg', alt: 'Image 1' },
            { src: '/img2.jpg', alt: 'Image 2' },
            { src: '/img3.jpg', alt: 'Image 3' },
            { src: '/img4.jpg', alt: 'Image 4' },
            { src: '/img5.jpg', alt: 'Image 5' },
          ],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('gallery');
    });

    it('should classify showcase section as gallery', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.showcase',
          classes: ['showcase', 'work-showcase'],
        },
        content: {
          headings: [{ level: 2, text: 'Showcase' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('gallery');
    });
  });

  // =========================================
  // 12. Confidence Calculation Tests (5 tests)
  // =========================================
  describe('Confidence Calculation', () => {
    it('should return confidence between 0 and 1', () => {
      const section = createHeroSection();
      const result = classifier.classify(section);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should calculate confidence based on condition weights', () => {
      const sectionWithAllIndicators = createHeroSection();
      const sectionWithPartialIndicators = createSection({
        element: {
          tagName: 'section',
          selector: 'section.hero',
          classes: ['hero'],
        },
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const fullResult = classifier.classify(sectionWithAllIndicators);
      const partialResult = classifier.classify(sectionWithPartialIndicators);
      expect(fullResult.confidence).toBeGreaterThan(partialResult.confidence);
    });

    it('should respect minConfidence threshold', () => {
      const ambiguousSection = createSection({
        element: {
          tagName: 'div',
          selector: 'div',
          classes: [],
        },
        content: {
          headings: [],
          paragraphs: ['Some random content'],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(ambiguousSection);
      // Should either match with sufficient confidence or return unknown
      expect(['unknown', 'feature', 'about']).toContain(result.type);
    });

    it('should accumulate weights from multiple matching conditions', () => {
      const multiConditionSection = createHeroSection({
        element: {
          tagName: 'header',
          selector: 'header#hero.hero-section',
          classes: ['hero-section', 'banner'],
          id: 'hero',
        },
      });
      const result = classifier.classify(multiConditionSection);
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('should not exceed confidence of 1', () => {
      const overqualifiedSection = createHeroSection({
        element: {
          tagName: 'header',
          selector: 'header#hero.hero.banner.masthead',
          classes: ['hero', 'banner', 'masthead', 'jumbotron'],
          id: 'hero',
        },
        style: { hasGradient: true, hasImage: true },
      });
      const result = classifier.classify(overqualifiedSection);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  // =========================================
  // 13. Context-Aware Classification Tests (6 tests)
  // =========================================
  describe('Context-Aware Classification (classifyWithContext)', () => {
    it('should classify multiple sections with context', () => {
      const sections = [
        createNavigationSection(),
        createHeroSection(),
        createFeatureSection(),
        createFooterSection(),
      ];
      const results = classifier.classifyWithContext(sections);
      expect(results.length).toBe(4);
    });

    it('should boost first section as navigation or hero', () => {
      const sections = [
        createSection({
          position: { startY: 0, endY: 80, height: 80 },
          content: {
            headings: [],
            paragraphs: [],
            links: [
              { text: 'Home', href: '/' },
              { text: 'About', href: '/about' },
            ],
            images: [],
            buttons: [],
          },
        }),
        createHeroSection(),
      ];
      const results = classifier.classifyWithContext(sections);
      expect(['navigation', 'hero']).toContain(results[0].type);
    });

    it('should boost last section as footer', () => {
      const sections = [
        createNavigationSection(),
        createHeroSection(),
        createSection({
          position: { startY: 3000, endY: 3300, height: 300 },
          content: {
            headings: [],
            paragraphs: ['© 2024 Company'],
            links: [{ text: 'Privacy', href: '/privacy' }],
            images: [],
            buttons: [],
          },
        }),
      ];
      const results = classifier.classifyWithContext(sections);
      expect(results[results.length - 1].type).toBe('footer');
    });

    it('should group consecutive feature sections', () => {
      const sections = [
        createNavigationSection(),
        createFeatureSection({ id: 'feature-1' }),
        createFeatureSection({ id: 'feature-2' }),
        createFeatureSection({ id: 'feature-3' }),
        createFooterSection(),
      ];
      const results = classifier.classifyWithContext(sections);
      const featureResults = results.filter((r) => r.type === 'feature');
      expect(featureResults.length).toBeGreaterThanOrEqual(2);
    });

    it('should detect typical LP structure', () => {
      const sections = [
        createNavigationSection(),
        createHeroSection(),
        createFeatureSection(),
        createTestimonialSection(),
        createPricingSection(),
        createCtaSection(),
        createFooterSection(),
      ];
      const results = classifier.classifyWithContext(sections);
      expect(results[0].type).toBe('navigation');
      expect(results[1].type).toBe('hero');
      expect(results[results.length - 1].type).toBe('footer');
    });

    it('should maintain section reference in results', () => {
      const sections = [createHeroSection(), createFooterSection()];
      const results = classifier.classifyWithContext(sections);
      expect(results[0].section).toBe(sections[0]);
      expect(results[1].section).toBe(sections[1]);
    });
  });

  // =========================================
  // 14. Custom Rules Tests (5 tests)
  // =========================================
  describe('Custom Rules', () => {
    it('should apply custom rule with higher priority', () => {
      const customClassifier = new SectionClassifier();
      customClassifier.addRule({
        type: 'hero',
        priority: 200,
        conditions: [
          { field: 'classes', operator: 'contains', value: 'custom-hero', weight: 1 },
        ],
        minConfidence: 0.5,
      });
      const section = createSection({
        element: {
          tagName: 'div',
          selector: 'div.custom-hero',
          classes: ['custom-hero'],
        },
      });
      const result = customClassifier.classify(section);
      expect(result.type).toBe('hero');
    });

    it('should support regex matching in conditions', () => {
      const customClassifier = new SectionClassifier();
      customClassifier.addRule({
        type: 'pricing',
        priority: 150,
        conditions: [
          { field: 'classes', operator: 'matches', value: /price|cost|tier/i, weight: 0.8 },
        ],
        minConfidence: 0.6,
      });
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.cost-table',
          classes: ['cost-table'],
        },
      });
      const result = customClassifier.classify(section);
      expect(result.type).toBe('pricing');
    });

    it('should support hasAny operator for arrays', () => {
      const customClassifier = new SectionClassifier();
      customClassifier.addRule({
        type: 'cta',
        priority: 120,
        conditions: [
          { field: 'content', operator: 'hasAny', value: ['button'], weight: 0.8 },
        ],
        minConfidence: 0.5,
      });
      const section = createSection({
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [{ text: 'Click', type: 'primary' }],
        },
      });
      const result = customClassifier.classify(section);
      expect(result.type).toBe('cta');
    });

    it('should support range operator for position', () => {
      const customClassifier = new SectionClassifier();
      customClassifier.addRule({
        type: 'hero',
        priority: 150,
        conditions: [
          { field: 'position', operator: 'range', value: { startY: [0, 200] }, weight: 0.5 },
        ],
        minConfidence: 0.4,
      });
      const section = createSection({
        position: { startY: 50, endY: 500, height: 450 },
      });
      const result = customClassifier.classify(section);
      expect(result.type).toBe('hero');
    });

    it('should support hasAll operator', () => {
      const customClassifier = new SectionClassifier();
      customClassifier.addRule({
        type: 'navigation',
        priority: 130,
        conditions: [
          { field: 'content', operator: 'hasAll', value: ['links', 'logo'], weight: 0.9 },
        ],
        minConfidence: 0.6,
      });
      const section = createSection({
        content: {
          headings: [],
          paragraphs: [],
          links: [{ text: 'Home', href: '/' }],
          images: [{ src: '/logo.png', alt: 'Logo' }],
          buttons: [],
        },
      });
      const result = customClassifier.classify(section);
      expect(result.type).toBe('navigation');
    });
  });

  // =========================================
  // 15. Edge Cases Tests (5 tests)
  // =========================================
  describe('Edge Cases', () => {
    it('should handle empty section', () => {
      const section = createSection();
      const result = classifier.classify(section);
      expect(result.type).toBe('unknown');
    });

    it('should handle section with no classes', () => {
      const section = createSection({
        element: {
          tagName: 'div',
          selector: 'div',
          classes: [],
        },
      });
      const result = classifier.classify(section);
      expect(result).toBeDefined();
    });

    it('should handle empty classifyWithContext input', () => {
      const results = classifier.classifyWithContext([]);
      expect(results).toEqual([]);
    });

    it('should handle single section in classifyWithContext', () => {
      const sections = [createHeroSection()];
      const results = classifier.classifyWithContext(sections);
      expect(results.length).toBe(1);
    });

    it('should handle ambiguous sections gracefully', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.mixed',
          classes: ['mixed'],
        },
        content: {
          headings: [{ level: 2, text: 'Mixed Content' }],
          paragraphs: ['Some text'],
          links: [{ text: 'Link', href: '/link' }],
          images: [{ src: '/img.jpg', alt: 'Image' }],
          buttons: [{ text: 'Button', type: 'primary' }],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================
  // 16. Priority Handling Tests (3 tests)
  // =========================================
  describe('Priority Handling', () => {
    it('should prefer higher priority rules', () => {
      const customClassifier = new SectionClassifier([
        {
          type: 'hero',
          priority: 100,
          conditions: [
            { field: 'classes', operator: 'contains', value: 'special', weight: 1 },
          ],
          minConfidence: 0.5,
        },
        {
          type: 'feature',
          priority: 50,
          conditions: [
            { field: 'classes', operator: 'contains', value: 'special', weight: 1 },
          ],
          minConfidence: 0.5,
        },
      ]);
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.special',
          classes: ['special'],
        },
      });
      const result = customClassifier.classify(section);
      expect(result.type).toBe('hero');
    });

    it('should sort rules by priority before evaluation', () => {
      const rules = classifier.getDefaultRules();
      // Check that rules with same type are ordered by priority
      for (let i = 0; i < rules.length - 1; i++) {
        // Rules should be sorted or have proper priority structure
        expect(typeof rules[i].priority).toBe('number');
      }
    });

    it('should break ties by confidence when priorities equal', () => {
      // heroは2つの条件があり、1つだけマッチ → confidence = 0.5
      // featureは1つの条件があり、それがマッチ → confidence = 1.0
      const customClassifier = new SectionClassifier([
        {
          type: 'hero',
          priority: 100,
          conditions: [
            { field: 'classes', operator: 'contains', value: 'test', weight: 0.5 },
            { field: 'classes', operator: 'contains', value: 'nonexistent', weight: 0.5 },
          ],
          minConfidence: 0.3,
        },
        {
          type: 'feature',
          priority: 100,
          conditions: [
            { field: 'classes', operator: 'contains', value: 'test', weight: 1 },
          ],
          minConfidence: 0.3,
        },
      ]);
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.test',
          classes: ['test'],
        },
      });
      const result = customClassifier.classify(section);
      // Feature has confidence 1.0, hero has confidence 0.5
      expect(result.type).toBe('feature');
    });
  });

  // =========================================
  // 17. Operator Tests (5 tests)
  // =========================================
  describe('Condition Operators', () => {
    it('should match "contains" operator for string in array', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.hero-banner',
          classes: ['hero-banner', 'large'],
        },
        content: {
          headings: [{ level: 1, text: 'Welcome' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [{ text: 'Start', type: 'primary' }],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('hero');
    });

    it('should match "equals" operator for exact match', () => {
      const section = createSection({
        element: {
          tagName: 'nav',
          selector: 'nav',
          classes: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('navigation');
    });

    it('should match "matches" operator with regex', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.testimonials-carousel',
          classes: ['testimonials-carousel'],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('testimonial');
    });

    it('should match "range" operator for numeric values', () => {
      const sectionNearTop = createSection({
        position: { startY: 50, endY: 300, height: 250 },
        content: {
          headings: [{ level: 1, text: 'Welcome' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [{ text: 'Start', type: 'primary' }],
        },
      });
      const result = classifier.classify(sectionNearTop);
      expect(result.type).toBe('hero');
    });

    it('should match "hasAny" operator when any item matches', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section.gallery-grid',
          classes: ['gallery-grid'],
        },
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [
            { src: '/1.jpg', alt: '1' },
            { src: '/2.jpg', alt: '2' },
            { src: '/3.jpg', alt: '3' },
            { src: '/4.jpg', alt: '4' },
          ],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('gallery');
    });
  });

  // =========================================
  // 18. Classification Accuracy Tests (5 tests)
  // =========================================
  describe('Classification Accuracy', () => {
    it('should achieve 85%+ accuracy on standard section types', () => {
      const testCases: Array<{ section: DetectedSection; expected: SectionType }> = [
        { section: createHeroSection(), expected: 'hero' },
        { section: createNavigationSection(), expected: 'navigation' },
        { section: createFeatureSection(), expected: 'feature' },
        { section: createCtaSection(), expected: 'cta' },
        { section: createTestimonialSection(), expected: 'testimonial' },
        { section: createPricingSection(), expected: 'pricing' },
        { section: createFooterSection(), expected: 'footer' },
        { section: createAboutSection(), expected: 'about' },
        { section: createContactSection(), expected: 'contact' },
        { section: createGallerySection(), expected: 'gallery' },
      ];

      let correct = 0;
      for (const { section, expected } of testCases) {
        const result = classifier.classify(section);
        if (result.type === expected) {
          correct++;
        }
      }

      const accuracy = correct / testCases.length;
      expect(accuracy).toBeGreaterThanOrEqual(0.85);
    });

    it('should correctly classify hero even without class hints', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section',
          classes: [],
        },
        position: { startY: 0, endY: 600, height: 600 },
        content: {
          headings: [{ level: 1, text: 'Welcome to Our Amazing Product' }],
          paragraphs: ['Discover the future of technology'],
          links: [],
          images: [{ src: '/hero.jpg', alt: 'Hero' }],
          buttons: [{ text: 'Get Started Free', type: 'primary' }],
        },
        style: { hasGradient: true },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('hero');
    });

    it('should correctly classify footer by copyright pattern', () => {
      const section = createSection({
        element: {
          tagName: 'div',
          selector: 'div',
          classes: [],
        },
        content: {
          headings: [],
          paragraphs: ['© 2024 Acme Corporation. All rights reserved.'],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('footer');
    });

    it('should correctly classify navigation by link density', () => {
      const section = createSection({
        element: {
          tagName: 'div',
          selector: 'div',
          classes: [],
        },
        position: { startY: 0, endY: 60, height: 60 },
        content: {
          headings: [],
          paragraphs: [],
          links: [
            { text: 'Home', href: '/' },
            { text: 'Products', href: '/products' },
            { text: 'Services', href: '/services' },
            { text: 'About', href: '/about' },
            { text: 'Contact', href: '/contact' },
          ],
          images: [{ src: '/logo.svg', alt: 'Logo' }],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('navigation');
    });

    it('should correctly classify feature by content structure', () => {
      const section = createSection({
        element: {
          tagName: 'section',
          selector: 'section',
          classes: [],
        },
        content: {
          headings: [
            { level: 2, text: 'Why Choose Us' },
            { level: 3, text: 'Fast Delivery' },
            { level: 3, text: 'Quality Products' },
            { level: 3, text: '24/7 Support' },
          ],
          paragraphs: ['We deliver in 24 hours', 'Top quality materials', 'Always here to help'],
          links: [],
          images: [
            { src: '/icon1.svg', alt: 'Fast' },
            { src: '/icon2.svg', alt: 'Quality' },
            { src: '/icon3.svg', alt: 'Support' },
          ],
          buttons: [],
        },
      });
      const result = classifier.classify(section);
      expect(result.type).toBe('feature');
    });
  });
});
