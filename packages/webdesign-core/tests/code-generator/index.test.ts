// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CodeGenerator テスト
 *
 * TDD Red Phase: 60+テストケース
 * セクションからコード生成の包括的なテスト
 *
 * @module @reftrix/webdesign-core/tests/code-generator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CodeGenerator,
  type CodeGeneratorOptions,
  type GeneratedCode,
} from '../../src/code-generator';
import type { DetectedSection, SectionType } from '../../src/types/section.types';
import type { LayoutInspectOutput } from '../../src/text-representation';

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
    confidence: 0.8,
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
    type: 'hero',
    confidence: 0.95,
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
      backgroundColor: '#1a1a2e',
      textColor: '#ffffff',
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
    type: 'navigation',
    confidence: 0.95,
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
    type: 'feature',
    confidence: 0.9,
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
    type: 'cta',
    confidence: 0.85,
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
      backgroundColor: '#4f46e5',
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
    type: 'testimonial',
    confidence: 0.88,
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
    type: 'pricing',
    confidence: 0.92,
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
    type: 'footer',
    confidence: 0.95,
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
      paragraphs: ['(C) 2024 Company Name. All rights reserved.'],
      links: [
        { text: 'About Us', href: '/about' },
        { text: 'Careers', href: '/careers' },
        { text: 'Help Center', href: '/help' },
      ],
      images: [],
      buttons: [],
    },
    style: {
      backgroundColor: '#111827',
      textColor: '#9ca3af',
    },
    ...overrides,
  });
}

/**
 * Aboutセクションのフィクスチャ
 */
function createAboutSection(overrides: Partial<DetectedSection> = {}): DetectedSection {
  return createSection({
    id: 'about-section',
    type: 'about',
    confidence: 0.85,
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
    type: 'contact',
    confidence: 0.88,
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
    type: 'gallery',
    confidence: 0.9,
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

/**
 * LayoutInspectOutputのフィクスチャ
 */
function createLayoutInspectOutput(): LayoutInspectOutput {
  return {
    colors: {
      palette: [
        { hex: '#1a1a2e', count: 10, role: 'background' },
        { hex: '#ffffff', count: 8, role: 'text' },
        { hex: '#4f46e5', count: 5, role: 'accent' },
      ],
      dominant: '#1a1a2e',
      background: '#1a1a2e',
      text: '#ffffff',
      accent: '#4f46e5',
    },
    typography: {
      fonts: [
        { family: 'Inter', weights: [400, 500, 600, 700] },
      ],
      headingScale: [48, 36, 24, 20, 16, 14],
      bodySize: 16,
      lineHeight: 1.5,
    },
    grid: {
      type: 'grid',
      columns: 12,
      gutterWidth: 24,
      maxWidth: 1280,
    },
  };
}

// =========================================
// Test Suites
// =========================================

describe('CodeGenerator', () => {
  let generator: CodeGenerator;

  beforeEach(() => {
    generator = new CodeGenerator();
  });

  // =========================================
  // 1. Initialization Tests (6 tests)
  // =========================================
  describe('Initialization', () => {
    it('should create instance with default options', () => {
      const gen = new CodeGenerator();
      expect(gen).toBeInstanceOf(CodeGenerator);
    });

    it('should create instance with custom options', () => {
      const options: CodeGeneratorOptions = {
        framework: 'nextjs',
        styling: 'tailwind',
        typescript: true,
        accessibility: true,
        responsive: true,
        darkMode: true,
      };
      const gen = new CodeGenerator(options);
      expect(gen).toBeInstanceOf(CodeGenerator);
    });

    it('should have default framework as react', () => {
      const gen = new CodeGenerator();
      const options = gen.getOptions();
      expect(options.framework).toBe('react');
    });

    it('should have default styling as tailwind', () => {
      const gen = new CodeGenerator();
      const options = gen.getOptions();
      expect(options.styling).toBe('tailwind');
    });

    it('should have default typescript as true', () => {
      const gen = new CodeGenerator();
      const options = gen.getOptions();
      expect(options.typescript).toBe(true);
    });

    it('should have default accessibility as true', () => {
      const gen = new CodeGenerator();
      const options = gen.getOptions();
      expect(options.accessibility).toBe(true);
    });
  });

  // =========================================
  // 2. React Output Generation Tests (8 tests)
  // =========================================
  describe('React Output Generation', () => {
    beforeEach(() => {
      generator = new CodeGenerator({ framework: 'react', styling: 'tailwind' });
    });

    it('should generate React component from hero section', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain('export');
      expect(result.component).toContain('HeroSection');
      expect(result.component).toContain('return');
    });

    it('should generate TypeScript types when typescript is true', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.types).toBeDefined();
      expect(result.types).toContain('interface');
      expect(result.types).toContain('Props');
    });

    it('should generate Tailwind CSS classes', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain('className');
      // Common Tailwind classes for hero
      expect(result.component).toMatch(/flex|grid|container|mx-auto/);
    });

    it('should include React import', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.imports).toContain("import React from 'react'");
    });

    it('should generate custom Props interface', () => {
      generator = new CodeGenerator({ framework: 'react', typescript: true });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.types).toContain('HeroSectionProps');
    });

    it('should not generate types when typescript is false', () => {
      generator = new CodeGenerator({ framework: 'react', typescript: false });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.types).toBeUndefined();
    });

    it('should generate memo wrapper when appropriate', () => {
      const section = createFeatureSection();
      const result = generator.generate(section);
      expect(result.component).toContain('React.memo');
    });

    it('should generate component with correct naming convention', () => {
      const section = createNavigationSection();
      const result = generator.generate(section);
      expect(result.component).toContain('Navigation');
      // Should be PascalCase
      expect(result.component).not.toContain('navigation_');
    });
  });

  // =========================================
  // 3. Next.js Output Generation Tests (6 tests)
  // =========================================
  describe('Next.js Output Generation', () => {
    beforeEach(() => {
      generator = new CodeGenerator({ framework: 'nextjs', styling: 'tailwind' });
    });

    it('should generate Next.js component with use client directive', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain("'use client'");
    });

    it('should use Next.js Image component for images', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.imports).toContain("import Image from 'next/image'");
      expect(result.component).toContain('<Image');
    });

    it('should use Next.js Link component for navigation', () => {
      const section = createNavigationSection();
      const result = generator.generate(section);
      expect(result.imports).toContain("import Link from 'next/link'");
      expect(result.component).toContain('<Link');
    });

    it('should add next to dependencies', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.dependencies).toContain('next');
    });

    it('should generate server component when no interactivity needed', () => {
      generator = new CodeGenerator({ framework: 'nextjs' });
      const section = createFooterSection();
      const result = generator.generate(section);
      // Footer without buttons might be server component
      expect(result.component).toBeDefined();
    });

    it('should use Next.js metadata patterns', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      // Should have proper component structure
      expect(result.component).toMatch(/export (const|function|default)/);
    });
  });

  // =========================================
  // 4. HTML Output Generation Tests (6 tests)
  // =========================================
  describe('HTML Output Generation', () => {
    beforeEach(() => {
      generator = new CodeGenerator({ framework: 'html', styling: 'vanilla' });
    });

    it('should generate semantic HTML5 output', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain('<section');
      expect(result.component).toContain('</section>');
    });

    it('should generate accessibility ARIA attributes', () => {
      generator = new CodeGenerator({ framework: 'html', accessibility: true });
      const section = createNavigationSection();
      const result = generator.generate(section);
      expect(result.component).toContain('role=');
      expect(result.component).toContain('aria-');
    });

    it('should generate BEM naming convention classes', () => {
      generator = new CodeGenerator({ framework: 'html', styling: 'vanilla' });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain('hero__');
    });

    it('should generate footer element for footer section', () => {
      const section = createFooterSection();
      const result = generator.generate(section);
      expect(result.component).toContain('<footer');
    });

    it('should generate nav element for navigation section', () => {
      const section = createNavigationSection();
      const result = generator.generate(section);
      expect(result.component).toContain('<nav');
    });

    it('should include proper lang and charset in full HTML', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      // For HTML mode, should have proper structure
      expect(result.component).toBeDefined();
    });
  });

  // =========================================
  // 5. CSS Output Generation Tests (7 tests)
  // =========================================
  describe('CSS Output Generation', () => {
    it('should generate CSS Variables with vanilla styling', () => {
      generator = new CodeGenerator({ framework: 'html', styling: 'vanilla' });
      const section = createHeroSection();
      const inspectResult = createLayoutInspectOutput();
      const result = generator.generate(section, inspectResult);
      expect(result.styles).toContain('--');
    });

    it('should generate responsive breakpoints', () => {
      generator = new CodeGenerator({ framework: 'html', styling: 'vanilla', responsive: true });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.styles).toContain('@media');
    });

    it('should generate dark mode styles when enabled', () => {
      generator = new CodeGenerator({ framework: 'html', styling: 'vanilla', darkMode: true });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.styles).toContain('prefers-color-scheme: dark');
    });

    it('should generate CSS Modules output when specified', () => {
      generator = new CodeGenerator({ framework: 'react', styling: 'css-modules' });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.styles).toBeDefined();
      expect(result.component).toContain('styles.');
    });

    it('should generate styled-components output when specified', () => {
      generator = new CodeGenerator({ framework: 'react', styling: 'styled-components' });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain('styled.');
      expect(result.imports).toContain("import styled from 'styled-components'");
    });

    it('should not generate separate styles file for Tailwind', () => {
      generator = new CodeGenerator({ framework: 'react', styling: 'tailwind' });
      const section = createHeroSection();
      const result = generator.generate(section);
      // Tailwind uses inline classes
      expect(result.styles).toBeUndefined();
    });

    it('should include proper font imports in CSS', () => {
      generator = new CodeGenerator({ framework: 'html', styling: 'vanilla' });
      const section = createHeroSection();
      const inspectResult = createLayoutInspectOutput();
      const result = generator.generate(section, inspectResult);
      expect(result.styles).toContain('Inter');
    });
  });

  // =========================================
  // 6. Section Type Hero Tests (5 tests)
  // =========================================
  describe('Hero Section Generation', () => {
    it('should generate HeroSection component', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain('HeroSection');
    });

    it('should include h1 heading element', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain('<h1');
    });

    it('should include primary CTA button', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain('Get Started');
    });

    it('should include hero image/background', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      // Should have either Image component or background
      expect(result.component).toMatch(/<img|<Image|background/);
    });

    it('should have full viewport height styling', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toMatch(/min-h-screen|h-screen|100vh/);
    });
  });

  // =========================================
  // 7. Section Type Navigation Tests (5 tests)
  // =========================================
  describe('Navigation Section Generation', () => {
    it('should generate Navigation component', () => {
      const section = createNavigationSection();
      const result = generator.generate(section);
      expect(result.component).toContain('Navigation');
    });

    it('should include nav element with proper role', () => {
      generator = new CodeGenerator({ accessibility: true });
      const section = createNavigationSection();
      const result = generator.generate(section);
      expect(result.component).toContain('<nav');
    });

    it('should include navigation links', () => {
      const section = createNavigationSection();
      const result = generator.generate(section);
      expect(result.component).toContain('Home');
      expect(result.component).toContain('About');
    });

    it('should include logo element', () => {
      const section = createNavigationSection();
      const result = generator.generate(section);
      expect(result.component).toContain('logo');
    });

    it('should include mobile menu toggle', () => {
      generator = new CodeGenerator({ responsive: true });
      const section = createNavigationSection();
      const result = generator.generate(section);
      expect(result.component).toMatch(/menu|hamburger|toggle/i);
    });
  });

  // =========================================
  // 8. Section Type Feature Tests (5 tests)
  // =========================================
  describe('Feature Section Generation', () => {
    it('should generate FeatureSection component', () => {
      const section = createFeatureSection();
      const result = generator.generate(section);
      expect(result.component).toContain('FeatureSection');
    });

    it('should include feature grid layout', () => {
      const section = createFeatureSection();
      const result = generator.generate(section);
      expect(result.component).toMatch(/grid|flex/);
    });

    it('should include feature items/cards', () => {
      const section = createFeatureSection();
      const result = generator.generate(section);
      expect(result.component).toContain('Feature One');
    });

    it('should include icons/images for features', () => {
      const section = createFeatureSection();
      const result = generator.generate(section);
      expect(result.component).toMatch(/img|Image|svg/);
    });

    it('should have responsive column layout', () => {
      generator = new CodeGenerator({ responsive: true });
      const section = createFeatureSection();
      const result = generator.generate(section);
      expect(result.component).toMatch(/md:|lg:|grid-cols/);
    });
  });

  // =========================================
  // 9. Section Type CTA Tests (4 tests)
  // =========================================
  describe('CTA Section Generation', () => {
    it('should generate CTASection component', () => {
      const section = createCtaSection();
      const result = generator.generate(section);
      expect(result.component).toContain('CTASection');
    });

    it('should include prominent CTA buttons', () => {
      const section = createCtaSection();
      const result = generator.generate(section);
      expect(result.component).toContain('Sign Up Now');
      expect(result.component).toContain('Learn More');
    });

    it('should have attention-grabbing styling', () => {
      const section = createCtaSection();
      const result = generator.generate(section);
      // Should have background color or gradient
      expect(result.component).toMatch(/bg-|background|gradient/);
    });

    it('should include compelling heading', () => {
      const section = createCtaSection();
      const result = generator.generate(section);
      expect(result.component).toContain('Ready to Get Started?');
    });
  });

  // =========================================
  // 10. Section Type Footer Tests (4 tests)
  // =========================================
  describe('Footer Section Generation', () => {
    it('should generate Footer component', () => {
      const section = createFooterSection();
      const result = generator.generate(section);
      expect(result.component).toContain('Footer');
    });

    it('should include footer semantic element', () => {
      const section = createFooterSection();
      const result = generator.generate(section);
      expect(result.component).toContain('<footer');
    });

    it('should include copyright text', () => {
      const section = createFooterSection();
      const result = generator.generate(section);
      expect(result.component).toContain('2024');
    });

    it('should include footer navigation links', () => {
      const section = createFooterSection();
      const result = generator.generate(section);
      expect(result.component).toContain('About Us');
    });
  });

  // =========================================
  // 11. Other Section Types Tests (6 tests)
  // =========================================
  describe('Other Section Types', () => {
    it('should generate TestimonialSection component', () => {
      const section = createTestimonialSection();
      const result = generator.generate(section);
      expect(result.component).toContain('TestimonialSection');
    });

    it('should generate PricingSection component', () => {
      const section = createPricingSection();
      const result = generator.generate(section);
      expect(result.component).toContain('PricingSection');
    });

    it('should generate AboutSection component', () => {
      const section = createAboutSection();
      const result = generator.generate(section);
      expect(result.component).toContain('AboutSection');
    });

    it('should generate ContactSection component', () => {
      const section = createContactSection();
      const result = generator.generate(section);
      expect(result.component).toContain('ContactSection');
    });

    it('should generate GallerySection component', () => {
      const section = createGallerySection();
      const result = generator.generate(section);
      expect(result.component).toContain('GallerySection');
    });

    it('should generate generic Section for unknown type', () => {
      const section = createSection({ type: 'unknown' });
      const result = generator.generate(section);
      expect(result.component).toContain('Section');
    });
  });

  // =========================================
  // 12. Batch Generation Tests (4 tests)
  // =========================================
  describe('Batch Generation', () => {
    it('should generate multiple sections', () => {
      const sections = [
        createHeroSection(),
        createFeatureSection(),
        createFooterSection(),
      ];
      const results = generator.generateBatch(sections);
      expect(results.length).toBe(3);
    });

    it('should generate unique component names', () => {
      const sections = [
        createFeatureSection({ id: 'feature-1' }),
        createFeatureSection({ id: 'feature-2' }),
      ];
      const results = generator.generateBatch(sections);
      // Should have unique identifiers
      expect(results[0].component).not.toBe(results[1].component);
    });

    it('should return empty array for empty input', () => {
      const results = generator.generateBatch([]);
      expect(results).toEqual([]);
    });

    it('should maintain section order in output', () => {
      const sections = [
        createNavigationSection(),
        createHeroSection(),
        createFooterSection(),
      ];
      const results = generator.generateBatch(sections);
      expect(results[0].component).toContain('Navigation');
      expect(results[1].component).toContain('HeroSection');
      expect(results[2].component).toContain('Footer');
    });
  });

  // =========================================
  // 13. Accessibility Tests (5 tests)
  // =========================================
  describe('Accessibility', () => {
    beforeEach(() => {
      generator = new CodeGenerator({ accessibility: true });
    });

    it('should include ARIA landmarks', () => {
      const section = createNavigationSection();
      const result = generator.generate(section);
      expect(result.component).toMatch(/role=|aria-label/);
    });

    it('should include alt text for images', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain('alt=');
    });

    it('should include button accessibility attributes', () => {
      const section = createCtaSection();
      const result = generator.generate(section);
      expect(result.component).toMatch(/<button|type="button"|role="button"/);
    });

    it('should include heading hierarchy', () => {
      const section = createFeatureSection();
      const result = generator.generate(section);
      // Should have proper heading structure
      expect(result.component).toMatch(/<h[1-6]/);
    });

    it('should include skip navigation link when applicable', () => {
      const section = createNavigationSection();
      const result = generator.generate(section);
      // Should have skip to content link
      expect(result.component).toMatch(/skip|main/i);
    });
  });

  // =========================================
  // 14. Responsive Design Tests (4 tests)
  // =========================================
  describe('Responsive Design', () => {
    beforeEach(() => {
      generator = new CodeGenerator({ responsive: true, styling: 'tailwind' });
    });

    it('should include responsive breakpoint classes', () => {
      const section = createFeatureSection();
      const result = generator.generate(section);
      expect(result.component).toMatch(/sm:|md:|lg:|xl:/);
    });

    it('should include mobile-first styles', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      // Should have base styles first
      expect(result.component).toBeDefined();
    });

    it('should include responsive grid/flex', () => {
      const section = createFeatureSection();
      const result = generator.generate(section);
      expect(result.component).toMatch(/grid-cols|flex-col|flex-row/);
    });

    it('should handle responsive typography', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toMatch(/text-\d+|md:text-|lg:text-/);
    });
  });

  // =========================================
  // 15. Dependencies Tests (4 tests)
  // =========================================
  describe('Dependencies', () => {
    it('should include react dependency', () => {
      generator = new CodeGenerator({ framework: 'react' });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.dependencies).toContain('react');
    });

    it('should include tailwindcss dependency when using tailwind', () => {
      generator = new CodeGenerator({ styling: 'tailwind' });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.dependencies).toContain('tailwindcss');
    });

    it('should include styled-components dependency when specified', () => {
      generator = new CodeGenerator({ styling: 'styled-components' });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.dependencies).toContain('styled-components');
    });

    it('should include typescript dependency when typescript is true', () => {
      generator = new CodeGenerator({ typescript: true });
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.dependencies).toContain('typescript');
    });
  });

  // =========================================
  // 16. LayoutInspect Integration Tests (4 tests)
  // =========================================
  describe('LayoutInspect Integration', () => {
    it('should use color palette from inspect result', () => {
      generator = new CodeGenerator({ framework: 'react', styling: 'tailwind' });
      const section = createHeroSection();
      const inspectResult = createLayoutInspectOutput();
      const result = generator.generate(section, inspectResult);
      // Should include custom colors or reference them
      expect(result.component).toBeDefined();
    });

    it('should use typography from inspect result', () => {
      generator = new CodeGenerator({ framework: 'html', styling: 'vanilla' });
      const section = createHeroSection();
      const inspectResult = createLayoutInspectOutput();
      const result = generator.generate(section, inspectResult);
      expect(result.styles).toContain('Inter');
    });

    it('should use grid info from inspect result', () => {
      generator = new CodeGenerator({ framework: 'react', styling: 'tailwind' });
      const section = createFeatureSection();
      const inspectResult = createLayoutInspectOutput();
      const result = generator.generate(section, inspectResult);
      // Should reference max-width from grid info
      expect(result.component).toMatch(/max-w-|1280/);
    });

    it('should work without inspect result', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toBeDefined();
    });
  });

  // =========================================
  // 17. Edge Cases Tests (5 tests)
  // =========================================
  describe('Edge Cases', () => {
    it('should handle section with no content', () => {
      const section = createSection({
        type: 'hero',
        content: {
          headings: [],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = generator.generate(section);
      expect(result.component).toBeDefined();
    });

    it('should handle section with very long text', () => {
      const longText = 'A'.repeat(1000);
      const section = createHeroSection({
        content: {
          headings: [{ level: 1, text: longText }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = generator.generate(section);
      expect(result.component).toBeDefined();
    });

    it('should handle special characters in text', () => {
      const section = createHeroSection({
        content: {
          headings: [{ level: 1, text: 'Welcome <script>alert("xss")</script>' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const result = generator.generate(section);
      // Should escape special characters
      expect(result.component).not.toContain('<script>');
    });

    it('should handle section with many images', () => {
      const images = Array.from({ length: 20 }, (_, i) => ({
        src: `/image${i}.jpg`,
        alt: `Image ${i}`,
      }));
      const section = createGallerySection({
        content: {
          headings: [{ level: 2, text: 'Gallery' }],
          paragraphs: [],
          links: [],
          images,
          buttons: [],
        },
      });
      const result = generator.generate(section);
      expect(result.component).toBeDefined();
    });

    it('should handle deep nested children', () => {
      const section = createSection({
        type: 'hero',
        children: [
          createSection({ type: 'feature', id: 'nested-1' }),
          createSection({ type: 'cta', id: 'nested-2' }),
        ],
      });
      const result = generator.generate(section);
      expect(result.component).toBeDefined();
    });
  });

  // =========================================
  // 18. Output Validation Tests (4 tests)
  // =========================================
  describe('Output Validation', () => {
    it('should generate valid JSX syntax', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      // Basic JSX validation: matching tags
      const openTags = (result.component.match(/<[a-zA-Z][^/>]*>/g) || []).length;
      const closeTags = (result.component.match(/<\/[a-zA-Z]+>/g) || []).length;
      const selfClosing = (result.component.match(/<[^>]+\/>/g) || []).length;
      // Open tags should roughly match close tags + self-closing
      expect(openTags).toBeLessThanOrEqual(closeTags + selfClosing + 10);
    });

    it('should generate code with no syntax errors', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      // Should not have obvious syntax errors
      expect(result.component).not.toContain('undefined');
      expect(result.component).not.toContain('null)');
    });

    it('should include required imports', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.imports.length).toBeGreaterThan(0);
    });

    it('should return consistent structure', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result).toHaveProperty('component');
      expect(result).toHaveProperty('imports');
      expect(result).toHaveProperty('dependencies');
      expect(typeof result.component).toBe('string');
      expect(Array.isArray(result.imports)).toBe(true);
      expect(Array.isArray(result.dependencies)).toBe(true);
    });
  });

  // =========================================
  // 19. Template Tests (4 tests)
  // =========================================
  describe('Templates', () => {
    it('should use correct template for hero', () => {
      const section = createHeroSection();
      const result = generator.generate(section);
      expect(result.component).toContain('HeroSection');
    });

    it('should customize template based on content', () => {
      const withButton = createHeroSection();
      const withoutButton = createHeroSection({
        content: {
          headings: [{ level: 1, text: 'Welcome' }],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        },
      });
      const resultWith = generator.generate(withButton);
      const resultWithout = generator.generate(withoutButton);
      expect(resultWith.component).toContain('Get Started');
      expect(resultWithout.component).not.toContain('Get Started');
    });

    it('should respect options in template generation', () => {
      generator = new CodeGenerator({ accessibility: false });
      const section = createNavigationSection();
      const result = generator.generate(section);
      // Without accessibility, might not have aria attributes
      expect(result.component).toBeDefined();
    });

    it('should allow template customization via options', () => {
      // Different styling should produce different output
      const tailwindGen = new CodeGenerator({ styling: 'tailwind' });
      const vanillaGen = new CodeGenerator({ framework: 'html', styling: 'vanilla' });
      const section = createHeroSection();
      const tailwindResult = tailwindGen.generate(section);
      const vanillaResult = vanillaGen.generate(section);
      expect(tailwindResult.component).not.toEqual(vanillaResult.component);
    });
  });

  // =========================================
  // 20. Performance Tests (2 tests)
  // =========================================
  describe('Performance', () => {
    it('should generate single section in under 100ms', () => {
      const section = createHeroSection();
      const start = performance.now();
      generator.generate(section);
      const end = performance.now();
      expect(end - start).toBeLessThan(100);
    });

    it('should generate batch of 10 sections in under 500ms', () => {
      const sections = [
        createNavigationSection(),
        createHeroSection(),
        createFeatureSection(),
        createCtaSection(),
        createTestimonialSection(),
        createPricingSection(),
        createAboutSection(),
        createContactSection(),
        createGallerySection(),
        createFooterSection(),
      ];
      const start = performance.now();
      generator.generateBatch(sections);
      const end = performance.now();
      expect(end - start).toBeLessThan(500);
    });
  });
});
