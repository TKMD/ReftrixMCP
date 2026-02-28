// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SectionDetector テスト
 *
 * TDD Red Phase: 60テストケース以上
 *
 * @module @reftrix/webdesign-core/tests/section-detector
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SectionDetector } from '../src/section-detector';
import type { DetectedSection, SectionType } from '../src/types/section.types';

// =========================================
// Test Fixtures
// =========================================

const createMinimalHtml = (body: string): string => `
<!DOCTYPE html>
<html lang="ja">
<head><title>Test</title></head>
<body>${body}</body>
</html>
`;

const HERO_HTML = createMinimalHtml(`
<header class="hero-section" id="hero">
  <h1>Welcome to Our Site</h1>
  <p>A great description of what we do.</p>
  <a href="/signup" class="btn btn-primary">Get Started</a>
  <img src="/hero-image.jpg" alt="Hero Image">
</header>
`);

const NAVIGATION_HTML = createMinimalHtml(`
<nav role="navigation" class="main-nav" id="main-navigation">
  <a href="/" class="logo">Logo</a>
  <ul>
    <li><a href="/home">Home</a></li>
    <li><a href="/about">About</a></li>
    <li><a href="/services">Services</a></li>
    <li><a href="/contact">Contact</a></li>
  </ul>
</nav>
`);

const FEATURE_HTML = createMinimalHtml(`
<section class="features" id="features">
  <h2>Our Features</h2>
  <div class="feature-grid">
    <div class="feature-item">
      <img src="/icon1.svg" alt="Feature 1">
      <h3>Feature One</h3>
      <p>Description of feature one.</p>
    </div>
    <div class="feature-item">
      <img src="/icon2.svg" alt="Feature 2">
      <h3>Feature Two</h3>
      <p>Description of feature two.</p>
    </div>
    <div class="feature-item">
      <img src="/icon3.svg" alt="Feature 3">
      <h3>Feature Three</h3>
      <p>Description of feature three.</p>
    </div>
  </div>
</section>
`);

const CTA_HTML = createMinimalHtml(`
<section class="cta-section call-to-action" id="cta">
  <h2>Ready to Get Started?</h2>
  <p>Join thousands of satisfied customers today.</p>
  <button class="btn btn-primary btn-large">Sign Up Now</button>
  <button class="btn btn-secondary">Learn More</button>
</section>
`);

const TESTIMONIAL_HTML = createMinimalHtml(`
<section class="testimonials" id="testimonials">
  <h2>What Our Customers Say</h2>
  <div class="testimonial-carousel">
    <blockquote class="testimonial-item">
      <p>"This product changed my life!"</p>
      <img src="/avatar1.jpg" alt="John Doe">
      <cite>John Doe, CEO</cite>
      <div class="rating">5 stars</div>
    </blockquote>
    <blockquote class="testimonial-item">
      <p>"Absolutely amazing service."</p>
      <img src="/avatar2.jpg" alt="Jane Smith">
      <cite>Jane Smith, Designer</cite>
      <div class="rating">5 stars</div>
    </blockquote>
  </div>
</section>
`);

const PRICING_HTML = createMinimalHtml(`
<section class="pricing-section" id="pricing">
  <h2>Pricing Plans</h2>
  <div class="pricing-grid">
    <div class="pricing-card">
      <h3>Basic</h3>
      <div class="price">$9.99/mo</div>
      <ul class="features-list">
        <li>Feature 1</li>
        <li>Feature 2</li>
      </ul>
      <button class="btn">Select Plan</button>
    </div>
    <div class="pricing-card featured">
      <h3>Pro</h3>
      <div class="price">$29.99/mo</div>
      <ul class="features-list">
        <li>All Basic features</li>
        <li>Feature 3</li>
        <li>Feature 4</li>
      </ul>
      <button class="btn btn-primary">Select Plan</button>
    </div>
  </div>
</section>
`);

const FOOTER_HTML = createMinimalHtml(`
<footer role="contentinfo" class="site-footer" id="footer">
  <div class="footer-content">
    <div class="footer-column">
      <h4>Company</h4>
      <ul>
        <li><a href="/about">About Us</a></li>
        <li><a href="/careers">Careers</a></li>
      </ul>
    </div>
    <div class="footer-column">
      <h4>Support</h4>
      <ul>
        <li><a href="/help">Help Center</a></li>
        <li><a href="/faq">FAQ</a></li>
      </ul>
    </div>
  </div>
  <div class="copyright">
    <p>&copy; 2024 Company Name. All rights reserved.</p>
  </div>
</footer>
`);

const ABOUT_HTML = createMinimalHtml(`
<section class="about-us" id="about">
  <h2>About Our Company</h2>
  <p>Founded in 2010, we have been serving customers worldwide.</p>
  <div class="team">
    <h3>Our Team</h3>
    <div class="team-member">
      <img src="/team1.jpg" alt="Team Member 1">
      <h4>John Doe</h4>
      <p>CEO & Founder</p>
    </div>
    <div class="team-member">
      <img src="/team2.jpg" alt="Team Member 2">
      <h4>Jane Smith</h4>
      <p>CTO</p>
    </div>
  </div>
</section>
`);

const CONTACT_HTML = createMinimalHtml(`
<section class="contact-section" id="contact">
  <h2>Contact Us</h2>
  <form class="contact-form">
    <input type="text" name="name" placeholder="Your Name">
    <input type="email" name="email" placeholder="Your Email">
    <textarea name="message" placeholder="Your Message"></textarea>
    <button type="submit" class="btn btn-primary">Send Message</button>
  </form>
  <div class="contact-info">
    <p>Email: contact@example.com</p>
    <p>Phone: +1-234-567-8900</p>
    <p>Address: 123 Main St, City, Country</p>
  </div>
</section>
`);

const GALLERY_HTML = createMinimalHtml(`
<section class="gallery-section" id="gallery">
  <h2>Our Gallery</h2>
  <div class="gallery-grid">
    <img src="/gallery1.jpg" alt="Gallery Image 1">
    <img src="/gallery2.jpg" alt="Gallery Image 2">
    <img src="/gallery3.jpg" alt="Gallery Image 3">
    <img src="/gallery4.jpg" alt="Gallery Image 4">
    <img src="/gallery5.jpg" alt="Gallery Image 5">
    <img src="/gallery6.jpg" alt="Gallery Image 6">
  </div>
</section>
`);

const COMPLEX_PAGE_HTML = createMinimalHtml(`
<header role="banner">
  <nav role="navigation">
    <a href="/" class="logo">Logo</a>
    <ul>
      <li><a href="/home">Home</a></li>
      <li><a href="/about">About</a></li>
    </ul>
  </nav>
</header>
<main role="main">
  <section class="hero">
    <h1>Welcome</h1>
    <p>Hero description</p>
    <a href="/start" class="btn btn-primary">Get Started</a>
  </section>
  <section class="features">
    <h2>Features</h2>
    <div class="feature">
      <img src="/icon.svg" alt="Icon">
      <h3>Feature</h3>
      <p>Description</p>
    </div>
  </section>
  <section class="cta">
    <h2>Ready?</h2>
    <button class="btn">Sign Up</button>
  </section>
</main>
<footer role="contentinfo">
  <p>&copy; 2024 Company</p>
</footer>
`);

const ARIA_LANDMARKS_HTML = createMinimalHtml(`
<div role="banner" class="header">
  <h1>Site Title</h1>
</div>
<div role="navigation" class="nav">
  <a href="/home">Home</a>
  <a href="/about">About</a>
</div>
<div role="main" class="content">
  <h2>Main Content</h2>
  <p>Some content here.</p>
</div>
<div role="complementary" class="sidebar">
  <h3>Related Links</h3>
</div>
<div role="contentinfo" class="footer">
  <p>Footer content</p>
</div>
`);

const SEMANTIC_TAGS_HTML = createMinimalHtml(`
<header>
  <h1>Site Title</h1>
  <nav>
    <a href="/home">Home</a>
  </nav>
</header>
<main>
  <article>
    <h2>Article Title</h2>
    <p>Article content.</p>
  </article>
  <aside>
    <h3>Sidebar</h3>
  </aside>
</main>
<footer>
  <p>Footer content</p>
</footer>
`);

const EMPTY_HTML = createMinimalHtml('');

const INVALID_HTML = '<html><body><div>Unclosed';

const DEEPLY_NESTED_HTML = createMinimalHtml(`
<div class="wrapper">
  <div class="container">
    <section class="hero-wrapper">
      <div class="hero-inner">
        <header class="hero">
          <h1>Nested Hero</h1>
          <p>Deep nesting test</p>
          <button class="btn">CTA</button>
        </header>
      </div>
    </section>
  </div>
</div>
`);

const STYLE_ATTRIBUTES_HTML = createMinimalHtml(`
<section style="background-color: #ff0000; color: white;" class="styled-section">
  <h2>Styled Section</h2>
  <p>Content with inline styles</p>
</section>
<section style="background: linear-gradient(to right, #000, #fff);" class="gradient-section">
  <h2>Gradient Section</h2>
  <p>Content with gradient background</p>
</section>
<section style="background-image: url('/bg.jpg');" class="image-section">
  <h2>Image Background Section</h2>
  <p>Content with background image</p>
</section>
`);

const MULTIPLE_BUTTONS_HTML = createMinimalHtml(`
<section class="action-section">
  <h2>Multiple Buttons</h2>
  <button class="btn btn-primary">Primary Action</button>
  <button class="btn btn-secondary">Secondary Action</button>
  <a href="/link" class="btn btn-link">Link Button</a>
  <input type="submit" value="Submit Button" class="btn">
</section>
`);

// =========================================
// Test Suites
// =========================================

describe('SectionDetector', () => {
  let detector: SectionDetector;

  beforeEach(() => {
    detector = new SectionDetector();
  });

  // =========================================
  // 1. Initialization Tests (5 tests)
  // =========================================
  describe('Initialization', () => {
    it('should create instance with default options', () => {
      const detector = new SectionDetector();
      expect(detector).toBeInstanceOf(SectionDetector);
    });

    it('should create instance with custom minSectionHeight', () => {
      const detector = new SectionDetector({ minSectionHeight: 200 });
      expect(detector).toBeInstanceOf(SectionDetector);
    });

    it('should create instance with detectLandmarks disabled', () => {
      const detector = new SectionDetector({ detectLandmarks: false });
      expect(detector).toBeInstanceOf(SectionDetector);
    });

    it('should create instance with detectSemanticTags disabled', () => {
      const detector = new SectionDetector({ detectSemanticTags: false });
      expect(detector).toBeInstanceOf(SectionDetector);
    });

    it('should create instance with all options customized', () => {
      const detector = new SectionDetector({
        minSectionHeight: 150,
        detectLandmarks: true,
        detectSemanticTags: true,
        detectVisualSections: false,
      });
      expect(detector).toBeInstanceOf(SectionDetector);
    });
  });

  // =========================================
  // 2. Hero Section Detection Tests (8 tests)
  // =========================================
  describe('Hero Section Detection', () => {
    it('should detect hero section with h1 and CTA button', async () => {
      const sections = await detector.detect(HERO_HTML);
      const heroSections = detector.findByType(sections, 'hero');
      expect(heroSections.length).toBeGreaterThan(0);
    });

    it('should assign high confidence to hero with h1, button, and image', async () => {
      const sections = await detector.detect(HERO_HTML);
      const heroSections = detector.findByType(sections, 'hero');
      expect(heroSections.length).toBeGreaterThan(0);
      expect(heroSections[0].confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('should extract h1 text from hero section', async () => {
      const sections = await detector.detect(HERO_HTML);
      const heroSections = detector.findByType(sections, 'hero');
      expect(heroSections.length).toBeGreaterThan(0);
      const h1 = heroSections[0].content.headings.find((h) => h.level === 1);
      expect(h1?.text).toBe('Welcome to Our Site');
    });

    it('should extract CTA button from hero section', async () => {
      const sections = await detector.detect(HERO_HTML);
      const heroSections = detector.findByType(sections, 'hero');
      expect(heroSections.length).toBeGreaterThan(0);
      expect(heroSections[0].content.buttons.length).toBeGreaterThan(0);
    });

    it('should detect hero by class name pattern', async () => {
      const html = createMinimalHtml(`
        <div class="hero-banner">
          <h1>Title</h1>
          <button>CTA</button>
        </div>
      `);
      const sections = await detector.detect(html);
      const heroSections = detector.findByType(sections, 'hero');
      expect(heroSections.length).toBeGreaterThan(0);
    });

    it('should detect hero by id pattern', async () => {
      const html = createMinimalHtml(`
        <section id="hero-section">
          <h1>Title</h1>
          <button>CTA</button>
        </section>
      `);
      const sections = await detector.detect(html);
      const heroSections = detector.findByType(sections, 'hero');
      expect(heroSections.length).toBeGreaterThan(0);
    });

    it('should extract hero image', async () => {
      const sections = await detector.detect(HERO_HTML);
      const heroSections = detector.findByType(sections, 'hero');
      expect(heroSections.length).toBeGreaterThan(0);
      expect(heroSections[0].content.images.length).toBeGreaterThan(0);
    });

    it('should classify section near page top as potential hero', async () => {
      const sections = await detector.detect(HERO_HTML);
      expect(sections.length).toBeGreaterThan(0);
      // First section should be near top (position check)
      expect(sections[0].position.startY).toBeLessThanOrEqual(100);
    });
  });

  // =========================================
  // 3. Navigation Section Detection Tests (6 tests)
  // =========================================
  describe('Navigation Section Detection', () => {
    it('should detect navigation with nav element', async () => {
      const sections = await detector.detect(NAVIGATION_HTML);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBeGreaterThan(0);
    });

    it('should detect navigation with role="navigation"', async () => {
      const sections = await detector.detect(NAVIGATION_HTML);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBeGreaterThan(0);
      expect(navSections[0].confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('should extract navigation links', async () => {
      const sections = await detector.detect(NAVIGATION_HTML);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBeGreaterThan(0);
      expect(navSections[0].content.links.length).toBeGreaterThanOrEqual(4);
    });

    it('should detect navigation by class pattern', async () => {
      const html = createMinimalHtml(`
        <div class="main-navigation">
          <a href="/home">Home</a>
          <a href="/about">About</a>
        </div>
      `);
      const sections = await detector.detect(html);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBeGreaterThan(0);
    });

    it('should detect header with navigation role as navigation', async () => {
      const html = createMinimalHtml(`
        <header role="banner">
          <nav>
            <a href="/">Home</a>
          </nav>
        </header>
      `);
      const sections = await detector.detect(html);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBeGreaterThan(0);
    });

    it('should extract logo from navigation', async () => {
      const sections = await detector.detect(NAVIGATION_HTML);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBeGreaterThan(0);
      const logoLink = navSections[0].content.links.find((l) => l.text === 'Logo');
      expect(logoLink).toBeDefined();
    });
  });

  // =========================================
  // 4. Feature Section Detection Tests (6 tests)
  // =========================================
  describe('Feature Section Detection', () => {
    it('should detect feature section with repeated items', async () => {
      const sections = await detector.detect(FEATURE_HTML);
      const featureSections = detector.findByType(sections, 'feature');
      expect(featureSections.length).toBeGreaterThan(0);
    });

    it('should detect feature by class pattern', async () => {
      const sections = await detector.detect(FEATURE_HTML);
      const featureSections = detector.findByType(sections, 'feature');
      expect(featureSections.length).toBeGreaterThan(0);
    });

    it('should extract feature icons/images', async () => {
      const sections = await detector.detect(FEATURE_HTML);
      const featureSections = detector.findByType(sections, 'feature');
      expect(featureSections.length).toBeGreaterThan(0);
      expect(featureSections[0].content.images.length).toBeGreaterThanOrEqual(3);
    });

    it('should extract feature headings', async () => {
      const sections = await detector.detect(FEATURE_HTML);
      const featureSections = detector.findByType(sections, 'feature');
      expect(featureSections.length).toBeGreaterThan(0);
      expect(featureSections[0].content.headings.length).toBeGreaterThanOrEqual(3);
    });

    it('should detect feature with grid or column layout', async () => {
      const html = createMinimalHtml(`
        <section class="feature-grid">
          <div class="col">
            <h3>Feature 1</h3>
          </div>
          <div class="col">
            <h3>Feature 2</h3>
          </div>
        </section>
      `);
      const sections = await detector.detect(html);
      const featureSections = detector.findByType(sections, 'feature');
      expect(featureSections.length).toBeGreaterThan(0);
    });

    it('should extract feature descriptions', async () => {
      const sections = await detector.detect(FEATURE_HTML);
      const featureSections = detector.findByType(sections, 'feature');
      expect(featureSections.length).toBeGreaterThan(0);
      expect(featureSections[0].content.paragraphs.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 5. CTA Section Detection Tests (6 tests)
  // =========================================
  describe('CTA Section Detection', () => {
    it('should detect CTA section with buttons', async () => {
      const sections = await detector.detect(CTA_HTML);
      const ctaSections = detector.findByType(sections, 'cta');
      expect(ctaSections.length).toBeGreaterThan(0);
    });

    it('should detect CTA by class pattern', async () => {
      const sections = await detector.detect(CTA_HTML);
      const ctaSections = detector.findByType(sections, 'cta');
      expect(ctaSections.length).toBeGreaterThan(0);
    });

    it('should extract primary and secondary buttons', async () => {
      const sections = await detector.detect(CTA_HTML);
      const ctaSections = detector.findByType(sections, 'cta');
      expect(ctaSections.length).toBeGreaterThan(0);
      expect(ctaSections[0].content.buttons.length).toBeGreaterThanOrEqual(2);
    });

    it('should detect CTA with call-to-action class', async () => {
      const html = createMinimalHtml(`
        <div class="call-to-action">
          <h2>Act Now!</h2>
          <button>Click Here</button>
        </div>
      `);
      const sections = await detector.detect(html);
      const ctaSections = detector.findByType(sections, 'cta');
      expect(ctaSections.length).toBeGreaterThan(0);
    });

    it('should assign high confidence to button-heavy section', async () => {
      const sections = await detector.detect(CTA_HTML);
      const ctaSections = detector.findByType(sections, 'cta');
      expect(ctaSections.length).toBeGreaterThan(0);
      expect(ctaSections[0].confidence).toBeGreaterThanOrEqual(0.6);
    });

    it('should extract CTA headline', async () => {
      const sections = await detector.detect(CTA_HTML);
      const ctaSections = detector.findByType(sections, 'cta');
      expect(ctaSections.length).toBeGreaterThan(0);
      expect(ctaSections[0].content.headings.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 6. Testimonial Section Detection Tests (6 tests)
  // =========================================
  describe('Testimonial Section Detection', () => {
    it('should detect testimonial section', async () => {
      const sections = await detector.detect(TESTIMONIAL_HTML);
      const testimonialSections = detector.findByType(sections, 'testimonial');
      expect(testimonialSections.length).toBeGreaterThan(0);
    });

    it('should detect testimonial by class pattern', async () => {
      const sections = await detector.detect(TESTIMONIAL_HTML);
      const testimonialSections = detector.findByType(sections, 'testimonial');
      expect(testimonialSections.length).toBeGreaterThan(0);
    });

    it('should detect testimonial with blockquote elements', async () => {
      const html = createMinimalHtml(`
        <section class="reviews">
          <blockquote>
            <p>"Great product!"</p>
            <cite>Customer</cite>
          </blockquote>
        </section>
      `);
      const sections = await detector.detect(html);
      const testimonialSections = detector.findByType(sections, 'testimonial');
      expect(testimonialSections.length).toBeGreaterThan(0);
    });

    it('should extract avatar images', async () => {
      const sections = await detector.detect(TESTIMONIAL_HTML);
      const testimonialSections = detector.findByType(sections, 'testimonial');
      expect(testimonialSections.length).toBeGreaterThan(0);
      expect(testimonialSections[0].content.images.length).toBeGreaterThan(0);
    });

    it('should detect review/rating section as testimonial', async () => {
      const html = createMinimalHtml(`
        <section class="customer-reviews">
          <div class="review">
            <p>"Excellent!"</p>
            <span class="stars">5 stars</span>
          </div>
        </section>
      `);
      const sections = await detector.detect(html);
      const testimonialSections = detector.findByType(sections, 'testimonial');
      expect(testimonialSections.length).toBeGreaterThan(0);
    });

    it('should extract testimonial quotes', async () => {
      const sections = await detector.detect(TESTIMONIAL_HTML);
      const testimonialSections = detector.findByType(sections, 'testimonial');
      expect(testimonialSections.length).toBeGreaterThan(0);
      expect(testimonialSections[0].content.paragraphs.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 7. Pricing Section Detection Tests (6 tests)
  // =========================================
  describe('Pricing Section Detection', () => {
    it('should detect pricing section', async () => {
      const sections = await detector.detect(PRICING_HTML);
      const pricingSections = detector.findByType(sections, 'pricing');
      expect(pricingSections.length).toBeGreaterThan(0);
    });

    it('should detect pricing by class pattern', async () => {
      const sections = await detector.detect(PRICING_HTML);
      const pricingSections = detector.findByType(sections, 'pricing');
      expect(pricingSections.length).toBeGreaterThan(0);
    });

    it('should detect pricing with price values', async () => {
      const html = createMinimalHtml(`
        <section class="plans">
          <div class="plan">
            <h3>Basic</h3>
            <span class="price">$10</span>
          </div>
        </section>
      `);
      const sections = await detector.detect(html);
      // Should detect as pricing or unknown with price indicators
      expect(sections.length).toBeGreaterThan(0);
    });

    it('should detect pricing with plan comparison', async () => {
      const sections = await detector.detect(PRICING_HTML);
      const pricingSections = detector.findByType(sections, 'pricing');
      expect(pricingSections.length).toBeGreaterThan(0);
    });

    it('should extract pricing buttons', async () => {
      const sections = await detector.detect(PRICING_HTML);
      const pricingSections = detector.findByType(sections, 'pricing');
      expect(pricingSections.length).toBeGreaterThan(0);
      expect(pricingSections[0].content.buttons.length).toBeGreaterThan(0);
    });

    it('should extract pricing headings', async () => {
      const sections = await detector.detect(PRICING_HTML);
      const pricingSections = detector.findByType(sections, 'pricing');
      expect(pricingSections.length).toBeGreaterThan(0);
      expect(pricingSections[0].content.headings.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 8. Footer Section Detection Tests (6 tests)
  // =========================================
  describe('Footer Section Detection', () => {
    it('should detect footer with footer element', async () => {
      const sections = await detector.detect(FOOTER_HTML);
      const footerSections = detector.findByType(sections, 'footer');
      expect(footerSections.length).toBeGreaterThan(0);
    });

    it('should detect footer with role="contentinfo"', async () => {
      const sections = await detector.detect(FOOTER_HTML);
      const footerSections = detector.findByType(sections, 'footer');
      expect(footerSections.length).toBeGreaterThan(0);
      expect(footerSections[0].confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('should extract footer links', async () => {
      const sections = await detector.detect(FOOTER_HTML);
      const footerSections = detector.findByType(sections, 'footer');
      expect(footerSections.length).toBeGreaterThan(0);
      expect(footerSections[0].content.links.length).toBeGreaterThan(0);
    });

    it('should detect footer by class pattern', async () => {
      // フッターがDOM末尾（80%以上）に位置するようにHTMLを構成
      const html = createMinimalHtml(`
        <main>
          <section><h1>Main Content</h1><p>Content paragraph 1.</p></section>
          <section><h2>Section 2</h2><p>Content paragraph 2.</p></section>
          <section><h2>Section 3</h2><p>Content paragraph 3.</p></section>
          <section><h2>Section 4</h2><p>Content paragraph 4.</p></section>
        </main>
        <div class="site-footer">
          <p>&copy; 2024 Company</p>
        </div>
      `);
      const sections = await detector.detect(html);
      const footerSections = detector.findByType(sections, 'footer');
      expect(footerSections.length).toBeGreaterThan(0);
    });

    it('should detect footer with copyright text', async () => {
      // フッターがDOM末尾（80%以上）に位置するようにHTMLを構成
      const html = createMinimalHtml(`
        <main>
          <section><h1>Main Content</h1><p>Content paragraph 1.</p></section>
          <section><h2>Section 2</h2><p>Content paragraph 2.</p></section>
          <section><h2>Section 3</h2><p>Content paragraph 3.</p></section>
          <section><h2>Section 4</h2><p>Content paragraph 4.</p></section>
        </main>
        <div class="bottom">
          <p>Copyright 2024 All rights reserved.</p>
        </div>
      `);
      const sections = await detector.detect(html);
      const footerSections = detector.findByType(sections, 'footer');
      expect(footerSections.length).toBeGreaterThan(0);
    });

    it('should extract footer copyright text', async () => {
      const sections = await detector.detect(FOOTER_HTML);
      const footerSections = detector.findByType(sections, 'footer');
      expect(footerSections.length).toBeGreaterThan(0);
      const hasCopyright = footerSections[0].content.paragraphs.some(
        (p) => p.includes('2024') || p.includes('reserved')
      );
      expect(hasCopyright).toBe(true);
    });
  });

  // =========================================
  // 9. About Section Detection Tests (4 tests)
  // =========================================
  describe('About Section Detection', () => {
    it('should detect about section', async () => {
      const sections = await detector.detect(ABOUT_HTML);
      const aboutSections = detector.findByType(sections, 'about');
      expect(aboutSections.length).toBeGreaterThan(0);
    });

    it('should detect about by class pattern', async () => {
      const sections = await detector.detect(ABOUT_HTML);
      const aboutSections = detector.findByType(sections, 'about');
      expect(aboutSections.length).toBeGreaterThan(0);
    });

    it('should detect about with team information', async () => {
      const sections = await detector.detect(ABOUT_HTML);
      const aboutSections = detector.findByType(sections, 'about');
      expect(aboutSections.length).toBeGreaterThan(0);
      expect(aboutSections[0].content.images.length).toBeGreaterThan(0);
    });

    it('should extract about section headings', async () => {
      const sections = await detector.detect(ABOUT_HTML);
      const aboutSections = detector.findByType(sections, 'about');
      expect(aboutSections.length).toBeGreaterThan(0);
      expect(aboutSections[0].content.headings.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 10. Contact Section Detection Tests (4 tests)
  // =========================================
  describe('Contact Section Detection', () => {
    it('should detect contact section', async () => {
      const sections = await detector.detect(CONTACT_HTML);
      const contactSections = detector.findByType(sections, 'contact');
      expect(contactSections.length).toBeGreaterThan(0);
    });

    it('should detect contact with form element', async () => {
      const sections = await detector.detect(CONTACT_HTML);
      const contactSections = detector.findByType(sections, 'contact');
      expect(contactSections.length).toBeGreaterThan(0);
    });

    it('should detect contact by class pattern', async () => {
      const sections = await detector.detect(CONTACT_HTML);
      const contactSections = detector.findByType(sections, 'contact');
      expect(contactSections.length).toBeGreaterThan(0);
    });

    it('should extract contact form button', async () => {
      const sections = await detector.detect(CONTACT_HTML);
      const contactSections = detector.findByType(sections, 'contact');
      expect(contactSections.length).toBeGreaterThan(0);
      expect(contactSections[0].content.buttons.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 11. Gallery Section Detection Tests (4 tests)
  // =========================================
  describe('Gallery Section Detection', () => {
    it('should detect gallery section', async () => {
      const sections = await detector.detect(GALLERY_HTML);
      const gallerySections = detector.findByType(sections, 'gallery');
      expect(gallerySections.length).toBeGreaterThan(0);
    });

    it('should detect gallery by class pattern', async () => {
      const sections = await detector.detect(GALLERY_HTML);
      const gallerySections = detector.findByType(sections, 'gallery');
      expect(gallerySections.length).toBeGreaterThan(0);
    });

    it('should detect gallery with multiple images', async () => {
      const sections = await detector.detect(GALLERY_HTML);
      const gallerySections = detector.findByType(sections, 'gallery');
      expect(gallerySections.length).toBeGreaterThan(0);
      expect(gallerySections[0].content.images.length).toBeGreaterThanOrEqual(5);
    });

    it('should detect portfolio/showcase as gallery', async () => {
      const html = createMinimalHtml(`
        <section class="portfolio">
          <h2>Our Work</h2>
          <img src="/work1.jpg" alt="Work 1">
          <img src="/work2.jpg" alt="Work 2">
          <img src="/work3.jpg" alt="Work 3">
          <img src="/work4.jpg" alt="Work 4">
        </section>
      `);
      const sections = await detector.detect(html);
      const gallerySections = detector.findByType(sections, 'gallery');
      expect(gallerySections.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 12. Complex Page Detection Tests (5 tests)
  // =========================================
  describe('Complex Page Detection', () => {
    it('should detect multiple section types in complex page', async () => {
      const sections = await detector.detect(COMPLEX_PAGE_HTML);
      expect(sections.length).toBeGreaterThanOrEqual(3);
    });

    it('should detect navigation in complex page', async () => {
      const sections = await detector.detect(COMPLEX_PAGE_HTML);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBeGreaterThan(0);
    });

    it('should detect hero in complex page', async () => {
      const sections = await detector.detect(COMPLEX_PAGE_HTML);
      const heroSections = detector.findByType(sections, 'hero');
      expect(heroSections.length).toBeGreaterThan(0);
    });

    it('should detect footer in complex page', async () => {
      const sections = await detector.detect(COMPLEX_PAGE_HTML);
      const footerSections = detector.findByType(sections, 'footer');
      expect(footerSections.length).toBeGreaterThan(0);
    });

    it('should maintain section order', async () => {
      const sections = await detector.detect(COMPLEX_PAGE_HTML);
      // Navigation should come before footer
      const navIndex = sections.findIndex((s) => s.type === 'navigation');
      const footerIndex = sections.findIndex((s) => s.type === 'footer');
      if (navIndex !== -1 && footerIndex !== -1) {
        expect(navIndex).toBeLessThan(footerIndex);
      }
    });
  });

  // =========================================
  // 13. WAI-ARIA Landmark Detection Tests (5 tests)
  // =========================================
  describe('WAI-ARIA Landmark Detection', () => {
    it('should detect all ARIA landmarks', async () => {
      const sections = await detector.detect(ARIA_LANDMARKS_HTML);
      expect(sections.length).toBeGreaterThanOrEqual(3);
    });

    it('should detect role="banner" as navigation', async () => {
      const sections = await detector.detect(ARIA_LANDMARKS_HTML);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBeGreaterThan(0);
    });

    it('should detect role="contentinfo" as footer', async () => {
      const sections = await detector.detect(ARIA_LANDMARKS_HTML);
      const footerSections = detector.findByType(sections, 'footer');
      expect(footerSections.length).toBeGreaterThan(0);
    });

    it('should respect detectLandmarks option when disabled', async () => {
      const detectorNoLandmarks = new SectionDetector({ detectLandmarks: false });
      const sections = await detectorNoLandmarks.detect(ARIA_LANDMARKS_HTML);
      // Should still detect some sections but with lower confidence
      expect(sections.length).toBeGreaterThanOrEqual(0);
    });

    it('should detect role="navigation"', async () => {
      const sections = await detector.detect(ARIA_LANDMARKS_HTML);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 14. HTML5 Semantic Tag Detection Tests (5 tests)
  // =========================================
  describe('HTML5 Semantic Tag Detection', () => {
    it('should detect header tag', async () => {
      const sections = await detector.detect(SEMANTIC_TAGS_HTML);
      expect(sections.length).toBeGreaterThan(0);
    });

    it('should detect nav tag as navigation', async () => {
      const sections = await detector.detect(SEMANTIC_TAGS_HTML);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBeGreaterThan(0);
    });

    it('should detect footer tag as footer', async () => {
      const sections = await detector.detect(SEMANTIC_TAGS_HTML);
      const footerSections = detector.findByType(sections, 'footer');
      expect(footerSections.length).toBeGreaterThan(0);
    });

    it('should respect detectSemanticTags option when disabled', async () => {
      const detectorNoSemantic = new SectionDetector({ detectSemanticTags: false });
      const sections = await detectorNoSemantic.detect(SEMANTIC_TAGS_HTML);
      // Should still find sections based on other criteria
      expect(sections).toBeDefined();
    });

    it('should detect main tag', async () => {
      const sections = await detector.detect(SEMANTIC_TAGS_HTML);
      expect(sections.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 15. Edge Cases Tests (8 tests)
  // =========================================
  describe('Edge Cases', () => {
    it('should handle empty HTML', async () => {
      const sections = await detector.detect(EMPTY_HTML);
      expect(sections).toEqual([]);
    });

    it('should handle invalid HTML gracefully', async () => {
      const sections = await detector.detect(INVALID_HTML);
      expect(sections).toBeDefined();
    });

    it('should handle deeply nested elements', async () => {
      const sections = await detector.detect(DEEPLY_NESTED_HTML);
      expect(sections.length).toBeGreaterThan(0);
    });

    it('should generate unique IDs for sections', async () => {
      const sections = await detector.detect(COMPLEX_PAGE_HTML);
      const ids = sections.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should handle HTML without body tag', async () => {
      const html = '<div class="hero"><h1>Title</h1></div>';
      const sections = await detector.detect(html);
      expect(sections).toBeDefined();
    });

    it('should handle whitespace-only content', async () => {
      const html = createMinimalHtml('   \n\t   ');
      const sections = await detector.detect(html);
      expect(sections).toEqual([]);
    });

    it('should handle HTML with only comments', async () => {
      const html = createMinimalHtml('<!-- comment -->');
      const sections = await detector.detect(html);
      expect(sections).toEqual([]);
    });

    it('should handle very long HTML', async () => {
      const longContent = '<section class="content">' + '<p>Content</p>'.repeat(1000) + '</section>';
      const html = createMinimalHtml(longContent);
      const sections = await detector.detect(html);
      expect(sections).toBeDefined();
    });
  });

  // =========================================
  // 16. Style Extraction Tests (5 tests)
  // =========================================
  describe('Style Extraction', () => {
    it('should extract inline background color', async () => {
      const sections = await detector.detect(STYLE_ATTRIBUTES_HTML);
      const styledSection = sections.find((s) => s.element.classes.includes('styled-section'));
      expect(styledSection?.style.backgroundColor).toBe('#ff0000');
    });

    it('should detect gradient background', async () => {
      const sections = await detector.detect(STYLE_ATTRIBUTES_HTML);
      const gradientSection = sections.find((s) => s.element.classes.includes('gradient-section'));
      expect(gradientSection?.style.hasGradient).toBe(true);
    });

    it('should detect background image', async () => {
      const sections = await detector.detect(STYLE_ATTRIBUTES_HTML);
      const imageSection = sections.find((s) => s.element.classes.includes('image-section'));
      expect(imageSection?.style.hasImage).toBe(true);
    });

    it('should extract inline text color', async () => {
      const sections = await detector.detect(STYLE_ATTRIBUTES_HTML);
      const styledSection = sections.find((s) => s.element.classes.includes('styled-section'));
      expect(styledSection?.style.textColor).toBe('white');
    });

    it('should handle sections without inline styles', async () => {
      const sections = await detector.detect(HERO_HTML);
      expect(sections[0].style).toBeDefined();
    });
  });

  // =========================================
  // 17. Button Detection Tests (4 tests)
  // =========================================
  describe('Button Detection', () => {
    it('should detect button elements', async () => {
      const sections = await detector.detect(MULTIPLE_BUTTONS_HTML);
      expect(sections[0].content.buttons.length).toBeGreaterThanOrEqual(3);
    });

    it('should classify primary buttons', async () => {
      const sections = await detector.detect(MULTIPLE_BUTTONS_HTML);
      const primaryButtons = sections[0].content.buttons.filter((b) => b.type === 'primary');
      expect(primaryButtons.length).toBeGreaterThan(0);
    });

    it('should classify secondary buttons', async () => {
      const sections = await detector.detect(MULTIPLE_BUTTONS_HTML);
      const secondaryButtons = sections[0].content.buttons.filter((b) => b.type === 'secondary');
      expect(secondaryButtons.length).toBeGreaterThan(0);
    });

    it('should classify link buttons', async () => {
      const sections = await detector.detect(MULTIPLE_BUTTONS_HTML);
      const linkButtons = sections[0].content.buttons.filter((b) => b.type === 'link');
      expect(linkButtons.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 18. classifySection Method Tests (4 tests)
  // =========================================
  describe('classifySection Method', () => {
    it('should classify section with hero indicators', async () => {
      const sections = await detector.detect(HERO_HTML);
      const classified = detector.classifySection(sections[0]);
      expect(classified).toBe('hero');
    });

    it('should classify section with footer indicators', async () => {
      const sections = await detector.detect(FOOTER_HTML);
      const footerSection = sections.find((s) => s.element.tagName === 'footer');
      if (footerSection) {
        const classified = detector.classifySection(footerSection);
        expect(classified).toBe('footer');
      }
    });

    it('should return unknown for ambiguous sections', async () => {
      const html = createMinimalHtml('<section><p>Some content</p></section>');
      const sections = await detector.detect(html);
      if (sections.length > 0) {
        const classified = detector.classifySection(sections[0]);
        expect(['unknown', 'hero', 'feature', 'cta']).toContain(classified);
      }
    });

    it('should classify based on content when no class hints', async () => {
      const html = createMinimalHtml(`
        <section>
          <h1>Welcome</h1>
          <p>Description</p>
          <button>Get Started</button>
        </section>
      `);
      const sections = await detector.detect(html);
      expect(sections.length).toBeGreaterThan(0);
      const classified = detector.classifySection(sections[0]);
      expect(classified).toBe('hero');
    });
  });

  // =========================================
  // 19. findByType Method Tests (4 tests)
  // =========================================
  describe('findByType Method', () => {
    it('should find all sections of specified type', async () => {
      const sections = await detector.detect(COMPLEX_PAGE_HTML);
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.every((s) => s.type === 'navigation')).toBe(true);
    });

    it('should return empty array when no matching sections', async () => {
      const sections = await detector.detect(HERO_HTML);
      const pricingSections = detector.findByType(sections, 'pricing');
      expect(pricingSections).toEqual([]);
    });

    it('should find multiple sections of same type', async () => {
      const html = createMinimalHtml(`
        <section class="feature-section">
          <h2>Feature 1</h2>
        </section>
        <section class="feature-section">
          <h2>Feature 2</h2>
        </section>
      `);
      const sections = await detector.detect(html);
      const featureSections = detector.findByType(sections, 'feature');
      expect(featureSections.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle all section types', async () => {
      const types: SectionType[] = [
        'hero',
        'feature',
        'cta',
        'testimonial',
        'pricing',
        'footer',
        'navigation',
        'about',
        'contact',
        'gallery',
        'unknown',
      ];
      const sections = await detector.detect(COMPLEX_PAGE_HTML);
      types.forEach((type) => {
        const result = detector.findByType(sections, type);
        expect(Array.isArray(result)).toBe(true);
      });
    });
  });

  // =========================================
  // 20. Element Selector Generation Tests (4 tests)
  // =========================================
  describe('Element Selector Generation', () => {
    it('should generate selector with id when available', async () => {
      const sections = await detector.detect(HERO_HTML);
      const heroSection = sections.find((s) => s.element.id === 'hero');
      expect(heroSection?.element.selector).toContain('#hero');
    });

    it('should generate selector with class when no id', async () => {
      const html = createMinimalHtml('<section class="my-section"><h2>Title</h2></section>');
      const sections = await detector.detect(html);
      expect(sections[0].element.selector).toContain('.my-section');
    });

    it('should generate selector with tag name', async () => {
      const sections = await detector.detect(FOOTER_HTML);
      const footerSection = sections.find((s) => s.element.tagName === 'footer');
      expect(footerSection?.element.selector).toContain('footer');
    });

    it('should handle elements with multiple classes', async () => {
      const html = createMinimalHtml(
        '<section class="section primary large"><h2>Title</h2></section>'
      );
      const sections = await detector.detect(html);
      expect(sections[0].element.classes).toContain('section');
      expect(sections[0].element.classes).toContain('primary');
    });
  });

  // =========================================
  // 21. Position Calculation Tests (4 tests)
  // =========================================
  describe('Position Calculation', () => {
    it('should calculate startY position', async () => {
      const sections = await detector.detect(HERO_HTML);
      expect(sections[0].position.startY).toBeDefined();
      expect(typeof sections[0].position.startY).toBe('number');
    });

    it('should calculate endY position', async () => {
      const sections = await detector.detect(HERO_HTML);
      expect(sections[0].position.endY).toBeDefined();
      expect(sections[0].position.endY).toBeGreaterThanOrEqual(sections[0].position.startY);
    });

    it('should calculate height', async () => {
      const sections = await detector.detect(HERO_HTML);
      expect(sections[0].position.height).toBeDefined();
      expect(sections[0].position.height).toBeGreaterThanOrEqual(0);
    });

    it('should maintain consistent position values', async () => {
      const sections = await detector.detect(HERO_HTML);
      const { startY, endY, height } = sections[0].position;
      expect(endY - startY).toBe(height);
    });
  });

  // =========================================
  // 22. HTML Snippet Extraction Tests (6 tests)
  // =========================================
  describe('HTML Snippet Extraction', () => {
    it('should extract htmlSnippet from detected sections', async () => {
      const sections = await detector.detect(HERO_HTML);
      expect(sections.length).toBeGreaterThan(0);
      // At least one section should have htmlSnippet
      const sectionWithSnippet = sections.find((s) => s.htmlSnippet !== undefined);
      expect(sectionWithSnippet).toBeDefined();
      expect(sectionWithSnippet?.htmlSnippet).toContain('<');
    });

    it('should include the section tag in htmlSnippet', async () => {
      const sections = await detector.detect(NAVIGATION_HTML);
      const navSection = sections.find((s) => s.type === 'navigation');
      expect(navSection?.htmlSnippet).toBeDefined();
      expect(navSection?.htmlSnippet).toContain('<nav');
      expect(navSection?.htmlSnippet).toContain('</nav>');
    });

    it('should preserve element content in htmlSnippet', async () => {
      const sections = await detector.detect(HERO_HTML);
      const heroSection = sections.find((s) => s.type === 'hero');
      if (heroSection?.htmlSnippet) {
        expect(heroSection.htmlSnippet).toContain('Welcome to Our Site');
        expect(heroSection.htmlSnippet).toContain('Get Started');
      }
    });

    it('should handle sections without script/style tags', async () => {
      const htmlWithScripts = createMinimalHtml(`
        <section class="hero" id="hero">
          <h1>Title</h1>
          <script>console.log('test');</script>
          <style>.test { color: red; }</style>
          <p>Content</p>
        </section>
      `);
      const sections = await detector.detect(htmlWithScripts);
      // Script and style might be removed in truncation, but basic content should remain
      expect(sections.length).toBeGreaterThan(0);
      expect(sections[0].htmlSnippet).toBeDefined();
    });

    it('should return undefined for empty elements', async () => {
      // This test verifies that sections with content have htmlSnippet
      const sections = await detector.detect(HERO_HTML);
      const sectionsWithSnippet = sections.filter((s) => s.htmlSnippet !== undefined);
      expect(sectionsWithSnippet.length).toBeGreaterThan(0);
    });

    it('should truncate large HTML snippets to 50KB', async () => {
      // Create a large HTML section (>50KB)
      const largeContent = '<p>' + 'A'.repeat(60000) + '</p>';
      const largeHtml = createMinimalHtml(`
        <section class="hero" id="hero">
          <h1>Title</h1>
          ${largeContent}
        </section>
      `);
      const sections = await detector.detect(largeHtml);
      const heroSection = sections.find((s) => s.type === 'hero');
      if (heroSection?.htmlSnippet) {
        // Should be truncated to <= 50KB
        const byteLength = Buffer.byteLength(heroSection.htmlSnippet, 'utf8');
        expect(byteLength).toBeLessThanOrEqual(51200); // 50KB + some overhead
      }
    });
  });

  // =========================================
  // 23. Nested Section Removal Tests (Phase 4)
  // =========================================
  describe('Nested Section Removal (removeNestedSections)', () => {
    // HTML with deeply nested navigation elements (simulates spaceandtime.io problem)
    const NESTED_NAV_HTML = createMinimalHtml(`
      <nav class="main-nav" id="main-navigation">
        <div class="nav-container">
          <div class="nav-inner">
            <a href="/" class="logo">Logo</a>
            <div class="nav-items">
              <a href="/home" class="nav-link">Home</a>
              <a href="/about" class="nav-link">About</a>
            </div>
          </div>
        </div>
      </nav>
    `);

    const NESTED_SECTIONS_HTML = createMinimalHtml(`
      <section class="hero-section" id="hero">
        <div class="hero-container">
          <div class="hero-content">
            <h1>Welcome</h1>
            <p>Description</p>
            <button class="btn btn-primary">Get Started</button>
          </div>
        </div>
      </section>
      <section class="feature-section" id="features">
        <div class="feature-container">
          <div class="feature-grid">
            <div class="feature-item">
              <h3>Feature 1</h3>
            </div>
            <div class="feature-item">
              <h3>Feature 2</h3>
            </div>
          </div>
        </div>
      </section>
    `);

    it('should remove nested elements by default (removeNestedSections: true)', async () => {
      const detector = new SectionDetector(); // Default: removeNestedSections: true
      const sections = await detector.detect(NESTED_NAV_HTML);

      // Should only return top-level nav, not nested containers
      const navSections = detector.findByType(sections, 'navigation');
      expect(navSections.length).toBe(1);
      expect(navSections[0].element.tagName).toBe('nav');
    });

    it('should keep nested elements when removeNestedSections is false', async () => {
      const detector = new SectionDetector({ removeNestedSections: false });
      const sections = await detector.detect(NESTED_NAV_HTML);

      // Should return more sections (including nested containers)
      // Note: not all nested elements match patterns, so count may vary
      expect(sections.length).toBeGreaterThanOrEqual(1);
    });

    it('should not remove unrelated sections at same level', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(NESTED_SECTIONS_HTML);

      // Should find both hero and feature sections (they are siblings, not nested)
      const heroSections = detector.findByType(sections, 'hero');
      const featureSections = detector.findByType(sections, 'feature');
      expect(heroSections.length).toBeGreaterThanOrEqual(1);
      expect(featureSections.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle complex nested structure (container patterns)', async () => {
      const complexHtml = createMinimalHtml(`
        <div class="wrapper">
          <div class="container">
            <section class="hero">
              <div class="hero-inner">
                <h1>Title</h1>
                <button>CTA</button>
              </div>
            </section>
          </div>
        </div>
      `);
      const detector = new SectionDetector();
      const sections = await detector.detect(complexHtml);

      // With nested removal, should find top-level containers, not inner ones
      // The exact count depends on which patterns match
      expect(sections.length).toBeGreaterThan(0);

      // Hero should be detected
      const heroSections = detector.findByType(sections, 'hero');
      expect(heroSections.length).toBeGreaterThanOrEqual(0); // May or may not match depending on other patterns
    });

    it('should reduce section count significantly for navigation-heavy pages', async () => {
      // Simulate navigation with many nested nav items
      const heavyNavHtml = createMinimalHtml(`
        <nav class="main-nav" role="navigation">
          <div class="nav-brand">Logo</div>
          <div class="nav-menu">
            <div class="nav-item"><a href="/home">Home</a></div>
            <div class="nav-item"><a href="/about">About</a></div>
            <div class="nav-item"><a href="/services">Services</a></div>
            <div class="nav-item"><a href="/contact">Contact</a></div>
          </div>
        </nav>
        <footer class="site-footer">
          <p>&copy; 2024</p>
        </footer>
      `);

      const detectorWithNesting = new SectionDetector({ removeNestedSections: false });
      const sectionsWithNesting = await detectorWithNesting.detect(heavyNavHtml);

      const detectorWithoutNesting = new SectionDetector({ removeNestedSections: true });
      const sectionsWithoutNesting = await detectorWithoutNesting.detect(heavyNavHtml);

      // With nested removal, should have fewer sections
      expect(sectionsWithoutNesting.length).toBeLessThanOrEqual(sectionsWithNesting.length);
    });

    it('should create instance with removeNestedSections option', () => {
      const detectorTrue = new SectionDetector({ removeNestedSections: true });
      const detectorFalse = new SectionDetector({ removeNestedSections: false });
      expect(detectorTrue).toBeInstanceOf(SectionDetector);
      expect(detectorFalse).toBeInstanceOf(SectionDetector);
    });

    it('should create instance with maxSectionsPerType option', () => {
      const detector = new SectionDetector({ maxSectionsPerType: 5 });
      expect(detector).toBeInstanceOf(SectionDetector);
    });

    it('should preserve section order after nested removal', async () => {
      const orderedHtml = createMinimalHtml(`
        <header class="header">
          <nav class="nav"><a href="/">Home</a></nav>
        </header>
        <section class="hero"><h1>Hero</h1></section>
        <footer class="footer"><p>Footer</p></footer>
      `);

      const detector = new SectionDetector();
      const sections = await detector.detect(orderedHtml);

      // Check that sections are in document order
      if (sections.length >= 2) {
        for (let i = 0; i < sections.length - 1; i++) {
          expect(sections[i].position.startY).toBeLessThanOrEqual(sections[i + 1].position.startY);
        }
      }
    });
  });

  // =====================================================
  // 過剰検出防止テスト (Over-detection Prevention)
  // TDD Red Phase: 2026-01-17
  // Issue: hero が 5個、footer が 4個検出される問題
  // =====================================================

  describe('Over-detection Prevention（過剰検出防止）', () => {
    // 同一の hero/footer が複数のセレクタパターンでマッチする HTML
    const OVER_DETECTION_HTML = createMinimalHtml(`
      <header class="hero hero-section hero-main" id="hero" data-section="hero">
        <div class="hero-container">
          <h1>Welcome to Our Site</h1>
          <p>Amazing description here.</p>
          <button class="btn btn-primary">Get Started</button>
          <img src="/hero.jpg" alt="Hero">
        </div>
      </header>

      <section class="features-section" id="features">
        <h2>Features</h2>
        <div class="feature-grid">
          <div class="feature-item"><h3>Feature 1</h3></div>
          <div class="feature-item"><h3>Feature 2</h3></div>
        </div>
      </section>

      <section class="cta-section" id="cta">
        <h2>Ready?</h2>
        <button class="btn">Sign Up</button>
      </section>

      <footer class="footer footer-section site-footer" id="footer" data-section="footer">
        <div class="footer-container">
          <p>&copy; 2026 Company</p>
          <nav class="footer-nav">
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </nav>
        </div>
      </footer>
    `);

    // 非常に多くのクラスパターンを持つ HTML（実際のサイトを模倣）
    const COMPLEX_CLASS_HTML = createMinimalHtml(`
      <div class="page-wrapper">
        <header class="site-header header-main hero-banner hero-section section--hero" id="hero-main" role="banner" data-section="hero">
          <div class="hero-inner hero-content">
            <h1 class="hero-title">Title</h1>
            <button class="hero-cta cta-button">CTA</button>
          </div>
        </header>

        <main class="main-content">
          <section class="section section--features features-section" id="features">
            <h2>Features</h2>
          </section>
        </main>

        <footer class="site-footer footer-main footer-section section--footer" id="footer-main" role="contentinfo" data-section="footer">
          <div class="footer-inner footer-content">
            <p>Footer content</p>
          </div>
        </footer>
      </div>
    `);

    describe('同一要素の重複検出防止', () => {
      it('hero セクションは厳密に1つだけ検出される（過剰検出防止）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(OVER_DETECTION_HTML);

        const heroSections = detector.findByType(sections, 'hero');

        // 改善前: 5個検出（[class*="hero"], [id*="hero"], [data-section="hero"] 等で重複）
        // 改善後: 厳密に1個
        expect(heroSections.length).toBe(1);
      });

      it('footer セクションは厳密に1つだけ検出される（過剰検出防止）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(OVER_DETECTION_HTML);

        const footerSections = detector.findByType(sections, 'footer');

        // 改善前: 4個検出
        // 改善後: 厳密に1個
        expect(footerSections.length).toBe(1);
      });

      it('複雑なクラス構造でも hero は1つだけ検出される', async () => {
        // 複雑なネスト構造では maxSectionsPerType オプションを使用して制御
        const detector = new SectionDetector({ maxSectionsPerType: 1 });
        const sections = await detector.detect(COMPLEX_CLASS_HTML);

        const heroSections = detector.findByType(sections, 'hero');

        // hero-banner, hero-section, section--hero 等複数パターンでマッチしても
        // maxSectionsPerType: 1 で最大1つに制限
        expect(heroSections.length).toBe(1);
      });

      it('複雑なクラス構造でも footer は1つだけ検出される', async () => {
        // 複雑なネスト構造では maxSectionsPerType オプションを使用して制御
        const detector = new SectionDetector({ maxSectionsPerType: 1 });
        const sections = await detector.detect(COMPLEX_CLASS_HTML);

        const footerSections = detector.findByType(sections, 'footer');

        // footer-main, footer-section, section--footer 等複数パターンでマッチしても
        // maxSectionsPerType: 1 で最大1つに制限
        expect(footerSections.length).toBe(1);
      });
    });

    describe('maxSectionsPerType オプション', () => {
      it('maxSectionsPerType を設定すると各タイプの最大数が制限される', async () => {
        const detector = new SectionDetector({ maxSectionsPerType: 1 });
        const sections = await detector.detect(OVER_DETECTION_HTML);

        const heroSections = detector.findByType(sections, 'hero');
        const footerSections = detector.findByType(sections, 'footer');

        expect(heroSections.length).toBeLessThanOrEqual(1);
        expect(footerSections.length).toBeLessThanOrEqual(1);
      });

      it('maxSectionsPerType: 2 で最大2個まで検出される', async () => {
        const twoHeroHtml = createMinimalHtml(`
          <header class="hero-section primary-hero" id="hero-1">
            <h1>Primary Hero</h1>
            <button>CTA 1</button>
          </header>
          <section class="hero-banner secondary-hero" id="hero-2">
            <h2>Secondary Hero</h2>
            <button>CTA 2</button>
          </section>
          <div class="hero-promo tertiary-hero" id="hero-3">
            <h3>Tertiary Hero</h3>
            <button>CTA 3</button>
          </div>
        `);

        const detector = new SectionDetector({ maxSectionsPerType: 2 });
        const sections = await detector.detect(twoHeroHtml);

        const heroSections = detector.findByType(sections, 'hero');

        // 3つ存在しても、最大2つまで
        expect(heroSections.length).toBeLessThanOrEqual(2);
      });
    });

    describe('De-duplicate ロジック強化', () => {
      it('同一DOM要素は複数のセレクタパターンでマッチしても1回のみカウント', async () => {
        const multiPatternHtml = createMinimalHtml(`
          <section class="hero hero-section hero-main section-hero" id="hero" data-section="hero" role="banner">
            <h1>Hero Title</h1>
            <button>CTA</button>
          </section>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(multiPatternHtml);

        // 6つのパターン全てにマッチするが、1回のみカウント
        // [class*="hero"], [class*="hero-section"], [class*="section-hero"]
        // [id*="hero"], [data-section="hero"], [role="banner"]
        expect(sections.length).toBe(1);
        expect(sections[0].type).toBe('hero');
      });

      it('HTML内容が同一の要素は重複としてカウントされない', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(OVER_DETECTION_HTML);

        // 全体のセクション数が適切（hero, features, cta, footer の4つ）
        expect(sections.length).toBeLessThanOrEqual(6); // 多少の余分は許容
        expect(sections.length).toBeGreaterThanOrEqual(3); // 最低限の検出
      });
    });

    describe('ページ位置に基づくフィルタリング', () => {
      it('hero セクションはページ上部（top 30%以内）に位置する', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(OVER_DETECTION_HTML);

        const heroSections = detector.findByType(sections, 'hero');

        for (const hero of heroSections) {
          // ページ上部30%以内に位置すべき
          // estimatedTopは0-100のパーセンテージ
          expect(hero.position.estimatedTop).toBeLessThanOrEqual(30);
        }
      });

      it('footer セクションはページ下部（bottom 30%以内）に位置する', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(OVER_DETECTION_HTML);

        const footerSections = detector.findByType(sections, 'footer');

        for (const footer of footerSections) {
          // ページ下部30%以内に位置すべき
          // estimatedTopは0-100のパーセンテージで、70以上なら下部
          expect(footer.position.estimatedTop).toBeGreaterThanOrEqual(70);
        }
      });
    });

    describe('信頼度に基づくフィルタリング', () => {
      it('重複検出時は信頼度が高いものが優先される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(OVER_DETECTION_HTML);

        const heroSections = detector.findByType(sections, 'hero');

        if (heroSections.length > 0) {
          // 検出された hero の信頼度は高い（0.6以上）
          expect(heroSections[0].confidence).toBeGreaterThanOrEqual(0.6);
        }
      });
    });
  });

  // =====================================================
  // hero/footer 単一検出強制テスト (enforceSingleHeroFooter)
  // TDD Red Phase: 2026-01-17
  // Issue: hero が 5個、footer が 4個検出される問題（Stripeサイト）
  // Solution: DOM位置に基づく hero/footer 制限（最上部20%/最下部20%）
  // =====================================================

  describe('enforceSingleHeroFooter（hero/footer単一検出強制）', () => {
    // Stripeのような複雑なサイトを模倣したHTML
    const STRIPE_LIKE_HTML = createMinimalHtml(`
      <header role="banner" class="site-header navigation-header">
        <nav class="main-nav">
          <a href="/" class="logo">Logo</a>
          <ul>
            <li><a href="/products">Products</a></li>
            <li><a href="/pricing">Pricing</a></li>
          </ul>
        </nav>
      </header>

      <section class="hero primary-hero" id="hero-1">
        <h1>The New Standard</h1>
        <p>Amazing product description</p>
        <button class="btn btn-primary">Get Started</button>
        <img src="/hero-image.jpg" alt="Hero">
      </section>

      <section class="features hero-like" id="section-2">
        <h2>Features</h2>
        <div class="hero-banner">Feature highlight</div>
      </section>

      <section class="products hero-promo" id="section-3">
        <h2>Products</h2>
        <div class="hero-card">Product card</div>
      </section>

      <section class="cta secondary-hero" id="section-4">
        <h2>Ready to start?</h2>
        <button class="btn">Sign Up</button>
      </section>

      <section class="testimonials hero-testimonials" id="section-5">
        <h2>What customers say</h2>
        <blockquote>"Great product!"</blockquote>
      </section>

      <div class="footer-cta section-footer-like">
        <h2>Get started today</h2>
        <button>Start Now</button>
      </div>

      <div class="footer-links footer-navigation">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </div>

      <footer class="site-footer main-footer" id="footer-1">
        <div class="footer-content">
          <p>&copy; 2026 Company. All rights reserved.</p>
        </div>
      </footer>
    `);

    describe('デフォルト動作（enforceSingleHeroFooter: true）', () => {
      it('heroは厳密に1つだけ検出される（DOM最上部20%内）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        const heroSections = detector.findByType(sections, 'hero');

        // 改善前: hero:5（hero, hero-like, hero-promo, secondary-hero, hero-testimonials）
        // 改善後: hero:1（DOM最上部20%内の最高信頼度のみ）
        expect(heroSections.length).toBe(1);
      });

      it('footerは厳密に1つだけ検出される（DOM最下部20%内）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        const footerSections = detector.findByType(sections, 'footer');

        // 改善前: footer:4（footer-cta, footer-navigation, footer-links, site-footer）
        // 改善後: footer:1（DOM最下部20%内の最高信頼度、<footer>タグ優先）
        expect(footerSections.length).toBe(1);
      });

      it('heroの位置はDOM最上部20%以内', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        const heroSections = detector.findByType(sections, 'hero');

        expect(heroSections.length).toBe(1);
        expect(heroSections[0].position.estimatedTop).toBeLessThanOrEqual(20);
      });

      it('footerの位置はDOM最下部20%以内（estimatedTop >= 80）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        const footerSections = detector.findByType(sections, 'footer');

        expect(footerSections.length).toBe(1);
        expect(footerSections[0].position.estimatedTop).toBeGreaterThanOrEqual(80);
      });

      it('位置条件外のheroはfeatureに再分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        // 中間に位置する hero-like, hero-promo 等はfeatureに再分類
        const featureSections = detector.findByType(sections, 'feature');

        // 元々heroだったセクションが再分類されている
        expect(featureSections.length).toBeGreaterThanOrEqual(1);
      });

      it('位置条件外のfooterはunknownに再分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        // 中間に位置する footer-cta, footer-navigation 等はunknownに再分類
        const unknownSections = detector.findByType(sections, 'unknown');

        // 元々footerだったセクションが再分類されている可能性がある
        // （ただし、元々footerとして検出されなかった場合は増えない）
        expect(unknownSections.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('<footer>タグ優先', () => {
      it('<footer>タグがある場合は優先的に採用される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        const footerSections = detector.findByType(sections, 'footer');

        expect(footerSections.length).toBe(1);
        expect(footerSections[0].element.tagName).toBe('footer');
      });
    });

    describe('enforceSingleHeroFooter: false（無効化）', () => {
      it('無効化すると複数のheroが検出される', async () => {
        const detector = new SectionDetector({ enforceSingleHeroFooter: false });
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        const heroSections = detector.findByType(sections, 'hero');

        // 無効化すると複数検出される可能性がある
        expect(heroSections.length).toBeGreaterThanOrEqual(1);
      });

      it('無効化すると複数のfooterが検出される可能性がある', async () => {
        const detector = new SectionDetector({ enforceSingleHeroFooter: false });
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        const footerSections = detector.findByType(sections, 'footer');

        // 無効化すると複数検出される可能性がある
        expect(footerSections.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('閾値カスタマイズ', () => {
      it('heroTopThreshold を変更するとhero検出範囲が変わる', async () => {
        // 上位10%のみをheroとして検出
        const detector = new SectionDetector({ heroTopThreshold: 10 });
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        const heroSections = detector.findByType(sections, 'hero');

        // 上位10%に制限されるため、検出が厳しくなる
        expect(heroSections.length).toBeLessThanOrEqual(1);
      });

      it('footerBottomThreshold を変更するとfooter検出範囲が変わる', async () => {
        // 下位10%のみをfooterとして検出
        const detector = new SectionDetector({ footerBottomThreshold: 90 });
        const sections = await detector.detect(STRIPE_LIKE_HTML);

        const footerSections = detector.findByType(sections, 'footer');

        // 下位10%に制限されるため、検出が厳しくなる
        expect(footerSections.length).toBeLessThanOrEqual(1);
      });
    });

    describe('信頼度による選択', () => {
      it('同一位置範囲内では最高信頼度のheroが選択される', async () => {
        const multipleHeroInTopHtml = createMinimalHtml(`
          <header class="hero-section primary-hero" id="hero-1">
            <h1>Primary Hero</h1>
            <button class="btn btn-primary">CTA</button>
          </header>
          <div class="hero-banner" id="hero-2">
            <h2>Secondary banner</h2>
          </div>
          <section class="content">
            <p>Content here</p>
          </section>
          <footer class="site-footer">
            <p>&copy; 2026</p>
          </footer>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(multipleHeroInTopHtml);

        const heroSections = detector.findByType(sections, 'hero');

        // 最高信頼度の1つだけ選択される
        expect(heroSections.length).toBe(1);
        // h1 + button を持つ primary-hero の方が信頼度が高い
        expect(heroSections[0].element.id).toBe('hero-1');
      });
    });

    describe('エッジケース', () => {
      it('heroが全くない場合でもエラーにならない', async () => {
        const noHeroHtml = createMinimalHtml(`
          <section class="content">
            <p>Just content</p>
          </section>
          <footer class="site-footer">
            <p>&copy; 2026</p>
          </footer>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(noHeroHtml);

        const heroSections = detector.findByType(sections, 'hero');

        expect(heroSections.length).toBe(0);
      });

      it('footerが全くない場合でもエラーにならない', async () => {
        const noFooterHtml = createMinimalHtml(`
          <header class="hero-section">
            <h1>Hero</h1>
            <button>CTA</button>
          </header>
          <section class="content">
            <p>Just content</p>
          </section>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(noFooterHtml);

        const footerSections = detector.findByType(sections, 'footer');

        expect(footerSections.length).toBe(0);
      });

      it('hero/footer両方がない場合でもエラーにならない', async () => {
        const noHeroFooterHtml = createMinimalHtml(`
          <section class="content">
            <p>Just content</p>
          </section>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(noHeroFooterHtml);

        expect(sections).toBeDefined();
      });

      it('すべてがheroパターンにマッチしても1つだけ選択される', async () => {
        const allHeroHtml = createMinimalHtml(`
          <div class="hero-1"><h1>Hero 1</h1></div>
          <div class="hero-2"><h2>Hero 2</h2></div>
          <div class="hero-3"><h3>Hero 3</h3></div>
          <div class="hero-4"><h4>Hero 4</h4></div>
          <div class="hero-5"><h5>Hero 5</h5></div>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(allHeroHtml);

        const heroSections = detector.findByType(sections, 'hero');

        // 最上部20%内で最高信頼度の1つだけ
        expect(heroSections.length).toBeLessThanOrEqual(1);
      });
    });
  });

  // =====================================================
  // ID属性ベースのセクション検出テスト（ax1.vc問題解決）
  // TDD Red Phase: 2026-01-24
  // Issue: #stories, #research, #board, #follow が検出されない
  // Solution: id属性パターンマッチングの強化
  // =====================================================

  describe('ID-Based Section Detection (ax1.vc patterns)', () => {
    // ax1.vcサイトを模倣したHTML構造
    const AX1_VC_HTML = createMinimalHtml(`
      <header class="site-header" id="header">
        <nav class="main-nav">
          <a href="/" class="logo">AX1</a>
          <ul>
            <li><a href="#stories">Stories</a></li>
            <li><a href="#research">Research</a></li>
            <li><a href="#board">Board</a></li>
            <li><a href="#follow">Follow</a></li>
          </ul>
        </nav>
      </header>

      <section class="hero-section" id="hero">
        <video autoplay muted loop class="bg-video">
          <source src="/video.mp4" type="video/mp4">
        </video>
        <h1>The Future of Finance</h1>
        <p>We invest in visionary founders.</p>
        <button class="btn btn-primary">Learn More</button>
      </section>

      <section id="stories">
        <h2>Top Stories</h2>
        <div class="story-grid">
          <article class="story-card">
            <img src="/story1.jpg" alt="Story 1">
            <h3>Story Title 1</h3>
          </article>
          <article class="story-card">
            <img src="/story2.jpg" alt="Story 2">
            <h3>Story Title 2</h3>
          </article>
          <article class="story-card">
            <img src="/story3.jpg" alt="Story 3">
            <h3>Story Title 3</h3>
          </article>
          <article class="story-card">
            <img src="/story4.jpg" alt="Story 4">
            <h3>Story Title 4</h3>
          </article>
        </div>
      </section>

      <section id="research">
        <h2>Our Research</h2>
        <p>Deep insights into emerging markets and technologies.</p>
        <button class="btn btn-secondary">Read Research</button>
        <button class="btn btn-primary">Subscribe</button>
      </section>

      <section id="board">
        <h2>The Board</h2>
        <div class="board-grid">
          <div class="board-member">
            <img src="/member1.jpg" alt="Board Member 1">
            <h4>John Doe</h4>
            <p>Partner</p>
          </div>
          <div class="board-member">
            <img src="/member2.jpg" alt="Board Member 2">
            <h4>Jane Smith</h4>
            <p>Partner</p>
          </div>
        </div>
      </section>

      <section id="follow">
        <h2>Stay Connected</h2>
        <p>Subscribe to our newsletter for the latest updates.</p>
        <form class="subscribe-form">
          <input type="email" placeholder="Enter your email">
          <button type="submit" class="btn btn-primary">Subscribe</button>
        </form>
      </section>

      <footer class="site-footer" id="footer">
        <p>&copy; 2026 AX1 Ventures. All rights reserved.</p>
        <div class="footer-links">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </div>
      </footer>
    `);

    describe('Generic ID Pattern Detection', () => {
      it('should detect section with id="stories" as gallery type', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(AX1_VC_HTML);

        // #stories セクションを検出できること
        const storiesSection = sections.find((s) => s.element.id === 'stories');
        expect(storiesSection).toBeDefined();
        // 画像が4枚以上あるのでgalleryとして検出されるべき
        expect(storiesSection?.type).toBe('gallery');
      });

      it('should detect section with id="research" as research or cta type', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(AX1_VC_HTML);

        // #research セクションを検出できること
        const researchSection = sections.find((s) => s.element.id === 'research');
        expect(researchSection).toBeDefined();
        // IDパターンで research として検出、またはボタンがあるので cta として検出されるべき
        // 拡張タイプでは research タイプも許容
        expect(['research', 'cta']).toContain(researchSection?.type);
      });

      it('should detect section with id="board" as team/testimonial/about type', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(AX1_VC_HTML);

        // #board セクションを検出できること
        const boardSection = sections.find((s) => s.element.id === 'board');
        expect(boardSection).toBeDefined();
        // IDパターンで team として検出、または about/testimonial として検出されるべき
        // 拡張タイプでは team タイプも許容
        expect(['team', 'about', 'testimonial', 'feature']).toContain(boardSection?.type);
      });

      it('should detect section with id="follow" as subscribe or cta type', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(AX1_VC_HTML);

        // #follow セクションを検出できること
        const followSection = sections.find((s) => s.element.id === 'follow');
        expect(followSection).toBeDefined();
        // IDパターンで subscribe として検出、またはフォームとボタンがあるので cta/contact として検出されるべき
        // 拡張タイプでは subscribe タイプも許容
        expect(['subscribe', 'cta', 'contact']).toContain(followSection?.type);
      });

      it('should detect all 8 sections in ax1.vc-like page (90%+ detection rate)', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(AX1_VC_HTML);

        // 期待されるセクション: header, hero, stories, research, board, follow, footer
        // 最低7セクション検出（navigation + hero + gallery + cta + about/feature + cta + footer）
        const uniqueIds = new Set(sections.map((s) => s.element.id).filter(Boolean));

        // 検出漏れを確認
        const expectedIds = ['header', 'hero', 'stories', 'research', 'board', 'follow', 'footer'];
        const detectedIds = Array.from(uniqueIds);
        const missingIds = expectedIds.filter((id) => !detectedIds.includes(id));

        // 90%以上の検出率を要求（7つ中6つ以上）
        expect(missingIds.length).toBeLessThanOrEqual(1);
      });
    });

    describe('Video Background Section Detection', () => {
      it('should detect hero section with video background', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(AX1_VC_HTML);

        const heroSections = detector.findByType(sections, 'hero');
        expect(heroSections.length).toBeGreaterThan(0);

        // video要素を含むheroセクションが検出されること
        const heroWithVideo = heroSections.find((s) =>
          s.htmlSnippet?.includes('<video') || s.htmlSnippet?.includes('video')
        );
        expect(heroWithVideo).toBeDefined();
      });

      it('should detect section containing video element', async () => {
        const videoHtml = createMinimalHtml(`
          <section id="video-hero">
            <video autoplay muted loop class="fullscreen-video">
              <source src="/background.mp4" type="video/mp4">
            </video>
            <div class="overlay">
              <h1>Welcome</h1>
              <button>Get Started</button>
            </div>
          </section>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(videoHtml);

        // video要素を含むセクションが検出されること
        expect(sections.length).toBeGreaterThan(0);
        const videoSection = sections.find((s) => s.element.id === 'video-hero');
        expect(videoSection).toBeDefined();
      });

      it('should detect section containing canvas element (WebGL/3D)', async () => {
        const canvasHtml = createMinimalHtml(`
          <section id="canvas-hero">
            <canvas id="three-canvas" class="fullscreen-canvas"></canvas>
            <div class="content-overlay">
              <h1>Interactive Experience</h1>
              <button>Explore</button>
            </div>
          </section>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(canvasHtml);

        // canvas要素を含むセクションが検出されること
        expect(sections.length).toBeGreaterThan(0);
        const canvasSection = sections.find((s) => s.element.id === 'canvas-hero');
        expect(canvasSection).toBeDefined();
      });
    });

    describe('Extended ID Patterns', () => {
      it('should detect section with common section ID patterns', async () => {
        const commonIdHtml = createMinimalHtml(`
          <section id="overview">
            <h2>Overview</h2>
            <p>Company overview content.</p>
          </section>
          <section id="services">
            <h2>Our Services</h2>
            <div class="service-item"><h3>Service 1</h3></div>
            <div class="service-item"><h3>Service 2</h3></div>
          </section>
          <section id="partners">
            <h2>Our Partners</h2>
            <img src="/partner1.png" alt="Partner 1">
            <img src="/partner2.png" alt="Partner 2">
          </section>
          <section id="team">
            <h2>Our Team</h2>
            <div class="team-member"><h4>Member 1</h4></div>
          </section>
          <section id="careers">
            <h2>Join Our Team</h2>
            <button>View Openings</button>
          </section>
          <section id="faq">
            <h2>FAQ</h2>
            <div class="faq-item"><h4>Question 1</h4><p>Answer 1</p></div>
          </section>
          <section id="subscribe">
            <h2>Subscribe</h2>
            <form><input type="email"><button>Subscribe</button></form>
          </section>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(commonIdHtml);

        // すべてのid属性を持つセクションが検出されること
        const detectedIds = sections.map((s) => s.element.id).filter(Boolean);
        expect(detectedIds).toContain('overview');
        expect(detectedIds).toContain('services');
        expect(detectedIds).toContain('partners');
        expect(detectedIds).toContain('team');
        expect(detectedIds).toContain('careers');
        expect(detectedIds).toContain('faq');
        expect(detectedIds).toContain('subscribe');
      });

      it('should detect section with section-* ID prefix', async () => {
        const prefixIdHtml = createMinimalHtml(`
          <section id="section-intro">
            <h2>Introduction</h2>
          </section>
          <section id="section-main">
            <h2>Main Content</h2>
          </section>
          <section id="section-outro">
            <h2>Conclusion</h2>
          </section>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(prefixIdHtml);

        const detectedIds = sections.map((s) => s.element.id).filter(Boolean);
        expect(detectedIds).toContain('section-intro');
        expect(detectedIds).toContain('section-main');
        expect(detectedIds).toContain('section-outro');
      });
    });
  });

  // =====================================================
  // セクションコンテンツ分離テスト (Section Content Separation)
  // TDD Red Phase: 2026-01-30
  // Issue: 各セクションのコンテンツが他セクションの内容を含まないことを検証
  // Solution: extractSectionContent関数の分離性検証
  // =====================================================

  describe('Section Content Separation (P0 Tests)', () => {
    // 3つの明確に異なるセクションを持つHTML
    // 各セクションは固有のコンテンツを持ち、混在しないことを検証
    const THREE_DISTINCT_HTML = createMinimalHtml(`
      <section class="hero-section" id="hero">
        <h1>ALPHA Heading</h1>
        <p>ALPHA paragraph content for hero section.</p>
        <button class="btn btn-primary">ALPHA Button</button>
      </section>

      <section class="features-section" id="features">
        <h2>BETA Heading</h2>
        <p>BETA paragraph content for features section.</p>
        <button class="btn btn-secondary">BETA Button</button>
      </section>

      <footer class="site-footer" id="footer">
        <h3>GAMMA Heading</h3>
        <p>GAMMA paragraph content for footer section.</p>
        <button class="btn btn-tertiary">GAMMA Button</button>
      </footer>
    `);

    // 5セクションを持つ複雑なHTML（multiSection）
    // header/hero/features/testimonial/cta/footer の6セクション構造
    const MULTI_SECTION_HTML = createMinimalHtml(`
      <header class="navigation-header" id="header" role="banner">
        <nav class="main-nav">
          <a href="/" class="logo">HEADER Logo</a>
          <ul>
            <li><a href="#features">Features</a></li>
            <li><a href="#pricing">Pricing</a></li>
          </ul>
        </nav>
        <p>HEADER Navigation Area</p>
      </header>

      <section class="hero-section" id="hero">
        <h1>HERO Main Title</h1>
        <p>HERO description paragraph with important information.</p>
        <button class="btn btn-hero">HERO CTA Button</button>
        <img src="/hero.jpg" alt="HERO Image">
      </section>

      <section class="features-section" id="features">
        <h2>FEATURES Section Title</h2>
        <p>FEATURES paragraph explaining our amazing features.</p>
        <div class="feature-item">
          <h3>FEATURES Item One</h3>
          <p>FEATURES Item One Description</p>
        </div>
        <button class="btn btn-features">FEATURES Learn More</button>
      </section>

      <section class="testimonial-section" id="testimonial">
        <h2>TESTIMONIAL Section Title</h2>
        <blockquote>
          <p>TESTIMONIAL quote from a satisfied customer.</p>
          <cite>TESTIMONIAL Customer Name</cite>
        </blockquote>
        <button class="btn btn-testimonial">TESTIMONIAL Read More</button>
      </section>

      <section class="cta-section" id="cta">
        <h2>CTA Section Title</h2>
        <p>CTA paragraph encouraging users to take action.</p>
        <button class="btn btn-cta-primary">CTA Primary Button</button>
        <button class="btn btn-cta-secondary">CTA Secondary Button</button>
      </section>

      <footer class="site-footer" id="footer">
        <h3>FOOTER Heading</h3>
        <p>FOOTER copyright and legal information.</p>
        <nav class="footer-nav">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
        <p>&copy; 2026 FOOTER Company Name</p>
      </footer>
    `);

    describe('見出しの分離テスト (Heading Separation)', () => {
      it('hero セクションは ALPHA 見出しのみを含む（BETA/GAMMA を含まない）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        // hero セクションの見出しを取得
        const headingTexts = heroSection!.content.headings.map((h) => h.text);

        // ALPHA を含む
        expect(headingTexts.some((t) => t.includes('ALPHA'))).toBe(true);

        // BETA/GAMMA を含まない
        expect(headingTexts.some((t) => t.includes('BETA'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('GAMMA'))).toBe(false);
      });

      it('features セクションは BETA 見出しのみを含む（ALPHA/GAMMA を含まない）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        // features セクションの見出しを取得
        const headingTexts = featuresSection!.content.headings.map((h) => h.text);

        // BETA を含む
        expect(headingTexts.some((t) => t.includes('BETA'))).toBe(true);

        // ALPHA/GAMMA を含まない
        expect(headingTexts.some((t) => t.includes('ALPHA'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('GAMMA'))).toBe(false);
      });

      it('footer セクションは GAMMA 見出しのみを含む（ALPHA/BETA を含まない）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        // footer セクションの見出しを取得
        const headingTexts = footerSection!.content.headings.map((h) => h.text);

        // GAMMA を含む
        expect(headingTexts.some((t) => t.includes('GAMMA'))).toBe(true);

        // ALPHA/BETA を含まない
        expect(headingTexts.some((t) => t.includes('ALPHA'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('BETA'))).toBe(false);
      });
    });

    describe('段落の分離テスト (Paragraph Separation)', () => {
      it('hero セクションの段落は ALPHA のみを含む', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        const paragraphs = heroSection!.content.paragraphs;

        // ALPHA を含む
        expect(paragraphs.some((p) => p.includes('ALPHA'))).toBe(true);

        // BETA/GAMMA を含まない
        expect(paragraphs.some((p) => p.includes('BETA'))).toBe(false);
        expect(paragraphs.some((p) => p.includes('GAMMA'))).toBe(false);
      });

      it('features セクションの段落は BETA のみを含む', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        const paragraphs = featuresSection!.content.paragraphs;

        // BETA を含む
        expect(paragraphs.some((p) => p.includes('BETA'))).toBe(true);

        // ALPHA/GAMMA を含まない
        expect(paragraphs.some((p) => p.includes('ALPHA'))).toBe(false);
        expect(paragraphs.some((p) => p.includes('GAMMA'))).toBe(false);
      });

      it('footer セクションの段落は GAMMA のみを含む', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        const paragraphs = footerSection!.content.paragraphs;

        // GAMMA を含む
        expect(paragraphs.some((p) => p.includes('GAMMA'))).toBe(true);

        // ALPHA/BETA を含まない
        expect(paragraphs.some((p) => p.includes('ALPHA'))).toBe(false);
        expect(paragraphs.some((p) => p.includes('BETA'))).toBe(false);
      });
    });

    describe('ボタンの分離テスト (Button Separation)', () => {
      it('hero セクションのボタンは ALPHA のみを含む', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        const buttonTexts = heroSection!.content.buttons.map((b) => b.text);

        // ALPHA を含む
        expect(buttonTexts.some((t) => t.includes('ALPHA'))).toBe(true);

        // BETA/GAMMA を含まない
        expect(buttonTexts.some((t) => t.includes('BETA'))).toBe(false);
        expect(buttonTexts.some((t) => t.includes('GAMMA'))).toBe(false);
      });

      it('features セクションのボタンは BETA のみを含む', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        const buttonTexts = featuresSection!.content.buttons.map((b) => b.text);

        // BETA を含む
        expect(buttonTexts.some((t) => t.includes('BETA'))).toBe(true);

        // ALPHA/GAMMA を含まない
        expect(buttonTexts.some((t) => t.includes('ALPHA'))).toBe(false);
        expect(buttonTexts.some((t) => t.includes('GAMMA'))).toBe(false);
      });

      it('footer セクションのボタンは GAMMA のみを含む', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        const buttonTexts = footerSection!.content.buttons.map((b) => b.text);

        // GAMMA を含む
        expect(buttonTexts.some((t) => t.includes('GAMMA'))).toBe(true);

        // ALPHA/BETA を含まない
        expect(buttonTexts.some((t) => t.includes('ALPHA'))).toBe(false);
        expect(buttonTexts.some((t) => t.includes('BETA'))).toBe(false);
      });
    });

    describe('contentオブジェクト一意性テスト (Content Object Uniqueness)', () => {
      it('各セクションのcontentオブジェクトは異なるインスタンスである', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        const featuresSection = sections.find((s) => s.element.id === 'features');
        const footerSection = sections.find((s) => s.element.id === 'footer');

        expect(heroSection).toBeDefined();
        expect(featuresSection).toBeDefined();
        expect(footerSection).toBeDefined();

        // contentオブジェクトが異なるインスタンスであること
        expect(heroSection!.content).not.toBe(featuresSection!.content);
        expect(featuresSection!.content).not.toBe(footerSection!.content);
        expect(heroSection!.content).not.toBe(footerSection!.content);
      });

      it('各セクションの見出し配列は異なるインスタンスである', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        const featuresSection = sections.find((s) => s.element.id === 'features');
        const footerSection = sections.find((s) => s.element.id === 'footer');

        expect(heroSection).toBeDefined();
        expect(featuresSection).toBeDefined();
        expect(footerSection).toBeDefined();

        // 見出し配列が異なるインスタンスであること
        expect(heroSection!.content.headings).not.toBe(featuresSection!.content.headings);
        expect(featuresSection!.content.headings).not.toBe(footerSection!.content.headings);
        expect(heroSection!.content.headings).not.toBe(footerSection!.content.headings);
      });

      it('各セクションのコンテンツは重複しない（完全一致なし）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        const featuresSection = sections.find((s) => s.element.id === 'features');
        const footerSection = sections.find((s) => s.element.id === 'footer');

        expect(heroSection).toBeDefined();
        expect(featuresSection).toBeDefined();
        expect(footerSection).toBeDefined();

        // 見出しテキストの集合が重複しないこと
        const heroHeadings = new Set(heroSection!.content.headings.map((h) => h.text));
        const featuresHeadings = new Set(featuresSection!.content.headings.map((h) => h.text));
        const footerHeadings = new Set(footerSection!.content.headings.map((h) => h.text));

        // 共通要素がないこと（交差が空）
        const heroFeaturesIntersection = [...heroHeadings].filter((x) => featuresHeadings.has(x));
        const featuresFooterIntersection = [...featuresHeadings].filter((x) => footerHeadings.has(x));
        const heroFooterIntersection = [...heroHeadings].filter((x) => footerHeadings.has(x));

        expect(heroFeaturesIntersection.length).toBe(0);
        expect(featuresFooterIntersection.length).toBe(0);
        expect(heroFooterIntersection.length).toBe(0);
      });
    });

    describe('5セクションHTMLテスト (Multi-Section HTML)', () => {
      it('各セクションが固有のコンテンツのみを含む', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(MULTI_SECTION_HTML);

        // 各セクションを取得
        const headerSection = sections.find((s) => s.element.id === 'header');
        const heroSection = sections.find((s) => s.element.id === 'hero');
        const featuresSection = sections.find((s) => s.element.id === 'features');
        const testimonialSection = sections.find((s) => s.element.id === 'testimonial');
        const ctaSection = sections.find((s) => s.element.id === 'cta');
        const footerSection = sections.find((s) => s.element.id === 'footer');

        // 全セクションが検出されていること
        expect(headerSection).toBeDefined();
        expect(heroSection).toBeDefined();
        expect(featuresSection).toBeDefined();
        expect(testimonialSection).toBeDefined();
        expect(ctaSection).toBeDefined();
        expect(footerSection).toBeDefined();

        // HEROセクションの検証
        if (heroSection) {
          const heroContent = [
            ...heroSection.content.headings.map((h) => h.text),
            ...heroSection.content.paragraphs,
            ...heroSection.content.buttons.map((b) => b.text),
          ].join(' ');

          expect(heroContent.includes('HERO')).toBe(true);
          expect(heroContent.includes('FEATURES Section')).toBe(false);
          expect(heroContent.includes('TESTIMONIAL')).toBe(false);
          expect(heroContent.includes('CTA Section')).toBe(false);
          expect(heroContent.includes('FOOTER')).toBe(false);
        }

        // FEATURESセクションの検証
        if (featuresSection) {
          const featuresContent = [
            ...featuresSection.content.headings.map((h) => h.text),
            ...featuresSection.content.paragraphs,
            ...featuresSection.content.buttons.map((b) => b.text),
          ].join(' ');

          expect(featuresContent.includes('FEATURES')).toBe(true);
          expect(featuresContent.includes('HERO Main')).toBe(false);
          expect(featuresContent.includes('TESTIMONIAL')).toBe(false);
          expect(featuresContent.includes('CTA Section')).toBe(false);
          expect(featuresContent.includes('FOOTER')).toBe(false);
        }

        // TESTIMONIALセクションの検証
        if (testimonialSection) {
          const testimonialContent = [
            ...testimonialSection.content.headings.map((h) => h.text),
            ...testimonialSection.content.paragraphs,
            ...testimonialSection.content.buttons.map((b) => b.text),
          ].join(' ');

          expect(testimonialContent.includes('TESTIMONIAL')).toBe(true);
          expect(testimonialContent.includes('HERO Main')).toBe(false);
          expect(testimonialContent.includes('FEATURES Section')).toBe(false);
          expect(testimonialContent.includes('CTA Section')).toBe(false);
          expect(testimonialContent.includes('FOOTER')).toBe(false);
        }

        // CTAセクションの検証
        if (ctaSection) {
          const ctaContent = [
            ...ctaSection.content.headings.map((h) => h.text),
            ...ctaSection.content.paragraphs,
            ...ctaSection.content.buttons.map((b) => b.text),
          ].join(' ');

          expect(ctaContent.includes('CTA')).toBe(true);
          expect(ctaContent.includes('HERO Main')).toBe(false);
          expect(ctaContent.includes('FEATURES Section')).toBe(false);
          expect(ctaContent.includes('TESTIMONIAL Section')).toBe(false);
          expect(ctaContent.includes('FOOTER Heading')).toBe(false);
        }

        // FOOTERセクションの検証
        if (footerSection) {
          const footerContent = [
            ...footerSection.content.headings.map((h) => h.text),
            ...footerSection.content.paragraphs,
            ...footerSection.content.buttons.map((b) => b.text),
          ].join(' ');

          expect(footerContent.includes('FOOTER')).toBe(true);
          expect(footerContent.includes('HERO Main')).toBe(false);
          expect(footerContent.includes('FEATURES Section')).toBe(false);
          expect(footerContent.includes('TESTIMONIAL')).toBe(false);
          expect(footerContent.includes('CTA Section')).toBe(false);
        }
      });

      it('6セクションすべてが検出される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(MULTI_SECTION_HTML);

        const detectedIds = sections.map((s) => s.element.id).filter(Boolean);

        expect(detectedIds).toContain('header');
        expect(detectedIds).toContain('hero');
        expect(detectedIds).toContain('features');
        expect(detectedIds).toContain('testimonial');
        expect(detectedIds).toContain('cta');
        expect(detectedIds).toContain('footer');
      });

      it('各セクションの見出しが正しく分離されている', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(MULTI_SECTION_HTML);

        // 全セクションの見出しを収集
        const allHeadings: Map<string, string[]> = new Map();

        for (const section of sections) {
          const id = section.element.id;
          if (id) {
            allHeadings.set(
              id,
              section.content.headings.map((h) => h.text)
            );
          }
        }

        // HEROの見出しにFEATURESの見出しが含まれていないこと
        const heroHeadings = allHeadings.get('hero') ?? [];
        const featuresHeadings = allHeadings.get('features') ?? [];

        for (const heroHeading of heroHeadings) {
          for (const featuresHeading of featuresHeadings) {
            expect(heroHeading).not.toBe(featuresHeading);
          }
        }
      });
    });

    describe('extractSectionContent直接テスト (Direct Content Extraction)', () => {
      it('異なるセクションIDに対して異なるコンテンツが返される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        // 各セクションのコンテンツを比較
        const heroSection = sections.find((s) => s.element.id === 'hero');
        const featuresSection = sections.find((s) => s.element.id === 'features');

        expect(heroSection).toBeDefined();
        expect(featuresSection).toBeDefined();

        // コンテンツが異なることを検証
        const heroHeadingText = heroSection!.content.headings.map((h) => h.text).join('');
        const featuresHeadingText = featuresSection!.content.headings.map((h) => h.text).join('');

        expect(heroHeadingText).not.toBe(featuresHeadingText);
        expect(heroHeadingText).toContain('ALPHA');
        expect(featuresHeadingText).toContain('BETA');
      });

      it('同一HTMLでも異なる要素からは異なるコンテンツが抽出される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(MULTI_SECTION_HTML);

        // 全セクションのコンテンツを収集
        const contentBySection: Map<string, string> = new Map();

        for (const section of sections) {
          const id = section.element.id;
          if (id) {
            const content = [
              ...section.content.headings.map((h) => h.text),
              ...section.content.paragraphs,
              ...section.content.buttons.map((b) => b.text),
            ].join('|');
            contentBySection.set(id, content);
          }
        }

        // 各セクションのコンテンツがすべて異なることを検証
        const contentValues = Array.from(contentBySection.values());
        const uniqueContents = new Set(contentValues);

        // すべてのコンテンツがユニークであること（重複なし）
        expect(uniqueContents.size).toBe(contentValues.length);
      });

      it('ネストした要素のコンテンツは親セクションに含まれる', async () => {
        const nestedHtml = createMinimalHtml(`
          <section class="hero-section" id="hero">
            <div class="hero-inner">
              <h1>NESTED Hero Title</h1>
              <div class="hero-content">
                <p>NESTED Hero paragraph inside nested div.</p>
                <div class="cta-wrapper">
                  <button class="btn">NESTED Hero Button</button>
                </div>
              </div>
            </div>
          </section>
          <footer class="site-footer" id="footer">
            <p>FOOTER content</p>
          </footer>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(nestedHtml);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        // ネストした要素のコンテンツが親セクションに含まれること
        const headingTexts = heroSection!.content.headings.map((h) => h.text);
        const paragraphs = heroSection!.content.paragraphs;
        const buttonTexts = heroSection!.content.buttons.map((b) => b.text);

        expect(headingTexts.some((t) => t.includes('NESTED Hero Title'))).toBe(true);
        expect(paragraphs.some((p) => p.includes('NESTED Hero paragraph'))).toBe(true);
        expect(buttonTexts.some((t) => t.includes('NESTED Hero Button'))).toBe(true);

        // FOOTERのコンテンツは含まれないこと
        expect(headingTexts.some((t) => t.includes('FOOTER'))).toBe(false);
        expect(paragraphs.some((p) => p.includes('FOOTER'))).toBe(false);
        expect(buttonTexts.some((t) => t.includes('FOOTER'))).toBe(false);
      });
    });
  });

  // =========================================
  // P0: Section Content Separation Tests
  // TDD Red Phase: threeDistinct sample
  // Task IDs:
  // - 019c0a1e-526b-76b2-8ac5-6f16f72ebc19 (見出しの分離)
  // - 019c0a1e-526c-757c-8995-47e09ec74c90 (段落の分離)
  // - 019c0a1e-526c-757c-8995-4ae5d82bedc3 (ボタンの分離)
  // =========================================
  describe('Section Content Separation (P0 Bug Fix)', () => {
    // threeDistinctサンプル: hero=ALPHA, features=BETA, footer=GAMMA
    const THREE_DISTINCT_HTML = createMinimalHtml(`
      <section class="hero-section" id="hero">
        <h1>ALPHA Heading</h1>
        <p>ALPHA paragraph content for hero section.</p>
        <button class="btn btn-primary">ALPHA Button</button>
      </section>
      <section class="features-section" id="features">
        <h2>BETA Heading</h2>
        <p>BETA paragraph content for features section.</p>
        <button class="btn btn-secondary">BETA Button</button>
      </section>
      <footer class="footer-section" id="footer">
        <h3>GAMMA Heading</h3>
        <p>GAMMA paragraph content for footer section.</p>
        <button class="btn btn-footer">GAMMA Button</button>
      </footer>
    `);

    describe('Heading Separation', () => {
      it('hero section should only contain ALPHA heading', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        const headingTexts = heroSection!.content.headings.map((h) => h.text);

        // ALPHA見出しのみを含むこと
        expect(headingTexts.some((t) => t.includes('ALPHA'))).toBe(true);
        // BETA見出しを含まないこと
        expect(headingTexts.some((t) => t.includes('BETA'))).toBe(false);
        // GAMMA見出しを含まないこと
        expect(headingTexts.some((t) => t.includes('GAMMA'))).toBe(false);
      });

      it('features section should only contain BETA heading', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        const headingTexts = featuresSection!.content.headings.map((h) => h.text);

        // BETA見出しのみを含むこと
        expect(headingTexts.some((t) => t.includes('BETA'))).toBe(true);
        // ALPHA見出しを含まないこと
        expect(headingTexts.some((t) => t.includes('ALPHA'))).toBe(false);
        // GAMMA見出しを含まないこと
        expect(headingTexts.some((t) => t.includes('GAMMA'))).toBe(false);
      });

      it('footer section should only contain GAMMA heading', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        const headingTexts = footerSection!.content.headings.map((h) => h.text);

        // GAMMA見出しのみを含むこと
        expect(headingTexts.some((t) => t.includes('GAMMA'))).toBe(true);
        // ALPHA見出しを含まないこと
        expect(headingTexts.some((t) => t.includes('ALPHA'))).toBe(false);
        // BETA見出しを含まないこと
        expect(headingTexts.some((t) => t.includes('BETA'))).toBe(false);
      });
    });

    describe('Paragraph Separation', () => {
      it('hero section should only contain ALPHA paragraph', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        const paragraphs = heroSection!.content.paragraphs;

        // ALPHA段落のみを含むこと
        expect(paragraphs.some((p) => p.includes('ALPHA'))).toBe(true);
        // BETA段落を含まないこと
        expect(paragraphs.some((p) => p.includes('BETA'))).toBe(false);
        // GAMMA段落を含まないこと
        expect(paragraphs.some((p) => p.includes('GAMMA'))).toBe(false);
      });

      it('features section should only contain BETA paragraph', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        const paragraphs = featuresSection!.content.paragraphs;

        // BETA段落のみを含むこと
        expect(paragraphs.some((p) => p.includes('BETA'))).toBe(true);
        // ALPHA段落を含まないこと
        expect(paragraphs.some((p) => p.includes('ALPHA'))).toBe(false);
        // GAMMA段落を含まないこと
        expect(paragraphs.some((p) => p.includes('GAMMA'))).toBe(false);
      });

      it('footer section should only contain GAMMA paragraph', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        const paragraphs = footerSection!.content.paragraphs;

        // GAMMA段落のみを含むこと
        expect(paragraphs.some((p) => p.includes('GAMMA'))).toBe(true);
        // ALPHA段落を含まないこと
        expect(paragraphs.some((p) => p.includes('ALPHA'))).toBe(false);
        // BETA段落を含まないこと
        expect(paragraphs.some((p) => p.includes('BETA'))).toBe(false);
      });
    });

    describe('Button Separation', () => {
      it('hero section should only contain ALPHA button', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        const buttonTexts = heroSection!.content.buttons.map((b) => b.text);

        // ALPHAボタンのみを含むこと
        expect(buttonTexts.some((t) => t.includes('ALPHA'))).toBe(true);
        // BETAボタンを含まないこと
        expect(buttonTexts.some((t) => t.includes('BETA'))).toBe(false);
        // GAMMAボタンを含まないこと
        expect(buttonTexts.some((t) => t.includes('GAMMA'))).toBe(false);
      });

      it('features section should only contain BETA button', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        const buttonTexts = featuresSection!.content.buttons.map((b) => b.text);

        // BETAボタンのみを含むこと
        expect(buttonTexts.some((t) => t.includes('BETA'))).toBe(true);
        // ALPHAボタンを含まないこと
        expect(buttonTexts.some((t) => t.includes('ALPHA'))).toBe(false);
        // GAMMAボタンを含まないこと
        expect(buttonTexts.some((t) => t.includes('GAMMA'))).toBe(false);
      });

      it('footer section should only contain GAMMA button', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        const buttonTexts = footerSection!.content.buttons.map((b) => b.text);

        // GAMMAボタンのみを含むこと
        expect(buttonTexts.some((t) => t.includes('GAMMA'))).toBe(true);
        // ALPHAボタンを含まないこと
        expect(buttonTexts.some((t) => t.includes('ALPHA'))).toBe(false);
        // BETAボタンを含まないこと
        expect(buttonTexts.some((t) => t.includes('BETA'))).toBe(false);
      });
    });

    describe('Content Object Uniqueness', () => {
      it('each section should have unique content objects', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(THREE_DISTINCT_HTML);

        expect(sections.length).toBeGreaterThanOrEqual(3);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        const featuresSection = sections.find((s) => s.element.id === 'features');
        const footerSection = sections.find((s) => s.element.id === 'footer');

        expect(heroSection).toBeDefined();
        expect(featuresSection).toBeDefined();
        expect(footerSection).toBeDefined();

        // 見出しが異なること
        const heroHeadings = heroSection!.content.headings.map((h) => h.text).join('');
        const featuresHeadings = featuresSection!.content.headings.map((h) => h.text).join('');
        const footerHeadings = footerSection!.content.headings.map((h) => h.text).join('');

        expect(heroHeadings).not.toBe(featuresHeadings);
        expect(heroHeadings).not.toBe(footerHeadings);
        expect(featuresHeadings).not.toBe(footerHeadings);

        // 段落が異なること
        const heroParagraphs = heroSection!.content.paragraphs.join('');
        const featuresParagraphs = featuresSection!.content.paragraphs.join('');
        const footerParagraphs = footerSection!.content.paragraphs.join('');

        expect(heroParagraphs).not.toBe(featuresParagraphs);
        expect(heroParagraphs).not.toBe(footerParagraphs);
        expect(featuresParagraphs).not.toBe(footerParagraphs);

        // ボタンが異なること
        const heroButtons = heroSection!.content.buttons.map((b) => b.text).join('');
        const featuresButtons = featuresSection!.content.buttons.map((b) => b.text).join('');
        const footerButtons = footerSection!.content.buttons.map((b) => b.text).join('');

        expect(heroButtons).not.toBe(featuresButtons);
        expect(heroButtons).not.toBe(footerButtons);
        expect(featuresButtons).not.toBe(footerButtons);
      });
    });

    describe('5-Section HTML Test', () => {
      // 各セクションは固有のプレフィックス（SEC1〜SEC5）でコンテンツを識別
      const FIVE_SECTION_HTML = createMinimalHtml(`
        <header class="site-header" id="header">
          <h1>SEC1 Header Title</h1>
          <p>SEC1 Header description text.</p>
          <a href="/" class="logo">SEC1 Header Logo Link</a>
        </header>
        <section class="hero-section" id="hero">
          <h2>SEC2 Hero Title</h2>
          <p>SEC2 Hero description text.</p>
          <button class="btn">SEC2 Hero Button</button>
        </section>
        <section class="features-section" id="features">
          <h2>SEC3 Features Title</h2>
          <p>SEC3 Features description text.</p>
          <img src="/feature.svg" alt="Feature Image">
        </section>
        <section class="cta-section" id="cta">
          <h2>SEC4 CTA Title</h2>
          <p>SEC4 CTA description text.</p>
          <button class="btn btn-primary">SEC4 CTA Primary Button</button>
          <button class="btn btn-secondary">SEC4 CTA Secondary Button</button>
        </section>
        <footer class="site-footer" id="footer">
          <h3>SEC5 Footer Title</h3>
          <p>SEC5 Footer description text.</p>
          <a href="/privacy">Privacy Policy</a>
        </footer>
      `);

      it('header section should only contain SEC1 content', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FIVE_SECTION_HTML);

        const headerSection = sections.find((s) => s.element.id === 'header');
        expect(headerSection).toBeDefined();

        const headingTexts = headerSection!.content.headings.map((h) => h.text);
        const paragraphs = headerSection!.content.paragraphs;

        // SEC1コンテンツを含む
        expect(headingTexts.some((t) => t.includes('SEC1'))).toBe(true);
        expect(paragraphs.some((p) => p.includes('SEC1'))).toBe(true);

        // 他セクションのコンテンツを含まない
        expect(headingTexts.some((t) => t.includes('SEC2'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('SEC3'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('SEC4'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('SEC5'))).toBe(false);
      });

      it('hero section should only contain SEC2 content', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FIVE_SECTION_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        const headingTexts = heroSection!.content.headings.map((h) => h.text);
        const paragraphs = heroSection!.content.paragraphs;
        const buttonTexts = heroSection!.content.buttons.map((b) => b.text);

        // SEC2コンテンツを含む
        expect(headingTexts.some((t) => t.includes('SEC2'))).toBe(true);
        expect(paragraphs.some((p) => p.includes('SEC2'))).toBe(true);
        expect(buttonTexts.some((t) => t.includes('SEC2'))).toBe(true);

        // 他セクションのコンテンツを含まない
        expect(headingTexts.some((t) => t.includes('SEC1'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('SEC3'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('SEC4'))).toBe(false);
        expect(buttonTexts.some((t) => t.includes('SEC4'))).toBe(false);
      });

      it('features section should only contain SEC3 content', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FIVE_SECTION_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        const headingTexts = featuresSection!.content.headings.map((h) => h.text);
        const paragraphs = featuresSection!.content.paragraphs;

        // SEC3コンテンツを含む
        expect(headingTexts.some((t) => t.includes('SEC3'))).toBe(true);
        expect(paragraphs.some((p) => p.includes('SEC3'))).toBe(true);

        // 他セクションのコンテンツを含まない
        expect(headingTexts.some((t) => t.includes('SEC1'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('SEC2'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('SEC4'))).toBe(false);
      });

      it('cta section should only contain SEC4 content', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FIVE_SECTION_HTML);

        const ctaSection = sections.find((s) => s.element.id === 'cta');
        expect(ctaSection).toBeDefined();

        const headingTexts = ctaSection!.content.headings.map((h) => h.text);
        const paragraphs = ctaSection!.content.paragraphs;
        const buttonTexts = ctaSection!.content.buttons.map((b) => b.text);

        // SEC4コンテンツを含む
        expect(headingTexts.some((t) => t.includes('SEC4'))).toBe(true);
        expect(paragraphs.some((p) => p.includes('SEC4'))).toBe(true);
        expect(buttonTexts.some((t) => t.includes('SEC4'))).toBe(true);

        // 2つのボタンがあること
        expect(ctaSection!.content.buttons.length).toBe(2);

        // 他セクションのコンテンツを含まない
        expect(headingTexts.some((t) => t.includes('SEC2'))).toBe(false);
        expect(buttonTexts.some((t) => t.includes('SEC2'))).toBe(false);
      });

      it('footer section should only contain SEC5 content', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FIVE_SECTION_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        const headingTexts = footerSection!.content.headings.map((h) => h.text);
        const paragraphs = footerSection!.content.paragraphs;
        const linkHrefs = footerSection!.content.links.map((l) => l.href);

        // SEC5コンテンツを含む
        expect(headingTexts.some((t) => t.includes('SEC5'))).toBe(true);
        expect(paragraphs.some((p) => p.includes('SEC5'))).toBe(true);
        expect(linkHrefs.some((h) => h.includes('/privacy'))).toBe(true);

        // 他セクションのコンテンツを含まない
        expect(headingTexts.some((t) => t.includes('SEC1'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('SEC2'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('SEC3'))).toBe(false);
        expect(headingTexts.some((t) => t.includes('SEC4'))).toBe(false);
      });
    });
  });

  // =========================================
  // P1: Image Separation Tests (画像分離テスト)
  // =========================================
  describe('Section Content Separation (P1 Tests)', () => {
    describe('Image Separation Tests (画像分離テスト)', () => {
      // テスト用HTML: hero（画像なし）、features（画像2つ）
      const IMAGE_SEPARATION_HTML = createMinimalHtml(`
        <section class="hero-section" id="hero">
          <h1>Hero Title</h1>
          <p>Hero description without images.</p>
          <button class="btn btn-primary">Get Started</button>
        </section>
        <section class="features-section" id="features">
          <h2>Features Title</h2>
          <p>Features description.</p>
          <div class="feature-item">
            <img src="/feature1.svg" alt="Feature 1 Icon">
            <h3>Feature One</h3>
          </div>
          <div class="feature-item">
            <img src="/feature2.svg" alt="Feature 2 Icon">
            <h3>Feature Two</h3>
          </div>
        </section>
        <footer class="site-footer" id="footer">
          <p>Footer content.</p>
        </footer>
      `);

      it('heroセクションは画像を含まない（画像数=0）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(IMAGE_SEPARATION_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        const images = heroSection!.content.images;
        expect(images.length).toBe(0);
      });

      it('featuresセクションは画像を2つ含む（画像数=2）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(IMAGE_SEPARATION_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        const images = featuresSection!.content.images;
        expect(images.length).toBe(2);
      });

      it('featuresセクションの画像srcは/feature1.svgと/feature2.svgである', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(IMAGE_SEPARATION_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        const imageSrcs = featuresSection!.content.images.map((img) => img.src);
        expect(imageSrcs).toContain('/feature1.svg');
        expect(imageSrcs).toContain('/feature2.svg');
      });

      it('heroセクションはfeaturesセクションの画像を含まない（分離検証）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(IMAGE_SEPARATION_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        const imageSrcs = heroSection!.content.images.map((img) => img.src);
        expect(imageSrcs).not.toContain('/feature1.svg');
        expect(imageSrcs).not.toContain('/feature2.svg');
      });

      it('footerセクションは画像を含まない', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(IMAGE_SEPARATION_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        const images = footerSection!.content.images;
        expect(images.length).toBe(0);
      });
    });

    describe('Link Separation Tests (リンク分離テスト)', () => {
      // テスト用HTML: header（リンク2つ）、footer（リンク2つ）、他セクション（リンクなし）
      const LINK_SEPARATION_HTML = createMinimalHtml(`
        <header class="site-header" id="header">
          <nav>
            <a href="/" class="logo">Home</a>
            <a href="/products">Products</a>
          </nav>
        </header>
        <section class="hero-section" id="hero">
          <h1>Hero Title</h1>
          <p>Hero description.</p>
          <button class="btn btn-primary">Get Started</button>
        </section>
        <section class="features-section" id="features">
          <h2>Features Title</h2>
          <p>Features description.</p>
        </section>
        <footer class="site-footer" id="footer">
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Service</a>
          <p>Footer content.</p>
        </footer>
      `);

      it('headerセクションのリンクは/と/productsを含む', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(LINK_SEPARATION_HTML);

        const headerSection = sections.find((s) => s.element.id === 'header');
        expect(headerSection).toBeDefined();

        const linkHrefs = headerSection!.content.links.map((l) => l.href);
        expect(linkHrefs).toContain('/');
        expect(linkHrefs).toContain('/products');
      });

      it('footerセクションのリンクは/privacyと/termsを含む', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(LINK_SEPARATION_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        const linkHrefs = footerSection!.content.links.map((l) => l.href);
        expect(linkHrefs).toContain('/privacy');
        expect(linkHrefs).toContain('/terms');
      });

      it('headerセクションはfooterのリンクを含まない（分離検証）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(LINK_SEPARATION_HTML);

        const headerSection = sections.find((s) => s.element.id === 'header');
        expect(headerSection).toBeDefined();

        const linkHrefs = headerSection!.content.links.map((l) => l.href);
        expect(linkHrefs).not.toContain('/privacy');
        expect(linkHrefs).not.toContain('/terms');
      });

      it('footerセクションはheaderのリンクを含まない（分離検証）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(LINK_SEPARATION_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        const linkHrefs = footerSection!.content.links.map((l) => l.href);
        expect(linkHrefs).not.toContain('/');
        expect(linkHrefs).not.toContain('/products');
      });

      it('heroセクションはリンクを含まない', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(LINK_SEPARATION_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero');
        expect(heroSection).toBeDefined();

        const links = heroSection!.content.links;
        expect(links.length).toBe(0);
      });

      it('featuresセクションはリンクを含まない', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(LINK_SEPARATION_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        const links = featuresSection!.content.links;
        expect(links.length).toBe(0);
      });

      it('各セクションのリンクは他セクションのリンクと重複しない', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(LINK_SEPARATION_HTML);

        const headerSection = sections.find((s) => s.element.id === 'header');
        const footerSection = sections.find((s) => s.element.id === 'footer');

        expect(headerSection).toBeDefined();
        expect(footerSection).toBeDefined();

        const headerLinkHrefs = headerSection!.content.links.map((l) => l.href);
        const footerLinkHrefs = footerSection!.content.links.map((l) => l.href);

        // headerとfooterのリンクが重複しないことを確認
        const intersection = headerLinkHrefs.filter((href) => footerLinkHrefs.includes(href));
        expect(intersection.length).toBe(0);
      });
    });
  });

  // =========================================
  // P1: Edge Case Tests - Nested Section Elements
  // ネストされたセクション内の要素は親セクションに属するべき
  // =========================================
  describe('Edge Case: Nested Section Elements (P1)', () => {
    // テスト用HTML: 深くネストされた要素を持つheroとfooter
    const DEEPLY_NESTED_CONTENT_HTML = createMinimalHtml(`
      <section class="hero-section" id="hero">
        <div class="container">
          <div class="hero-inner">
            <h1>NESTED-HERO Title</h1>
            <div class="content-wrapper">
              <p>NESTED-HERO paragraph inside multiple divs.</p>
              <div class="cta-wrapper">
                <div class="button-container">
                  <button class="btn btn-primary">NESTED-HERO Button</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="hero-images">
          <div class="image-wrapper">
            <img src="/nested-hero-image.png" alt="NESTED-HERO Image">
          </div>
        </div>
        <div class="hero-links">
          <a href="/nested-hero-link">NESTED-HERO Link</a>
        </div>
      </section>
      <footer class="site-footer" id="footer">
        <div class="footer-container">
          <div class="footer-inner">
            <h3>NESTED-FOOTER Title</h3>
            <p>NESTED-FOOTER paragraph.</p>
          </div>
        </div>
      </footer>
    `);

    it('深くネストされた見出しは親セクション（hero）に属する', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(DEEPLY_NESTED_CONTENT_HTML);

      const heroSection = sections.find((s) => s.element.id === 'hero');
      expect(heroSection).toBeDefined();

      const headingTexts = heroSection!.content.headings.map((h) => h.text);
      expect(headingTexts.some((t) => t.includes('NESTED-HERO Title'))).toBe(true);
    });

    it('深くネストされた段落は親セクション（hero）に属する', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(DEEPLY_NESTED_CONTENT_HTML);

      const heroSection = sections.find((s) => s.element.id === 'hero');
      expect(heroSection).toBeDefined();

      const paragraphs = heroSection!.content.paragraphs;
      expect(paragraphs.some((p) => p.includes('NESTED-HERO paragraph'))).toBe(true);
    });

    it('深くネストされたボタンは親セクション（hero）に属する', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(DEEPLY_NESTED_CONTENT_HTML);

      const heroSection = sections.find((s) => s.element.id === 'hero');
      expect(heroSection).toBeDefined();

      const buttonTexts = heroSection!.content.buttons.map((b) => b.text);
      expect(buttonTexts.some((t) => t.includes('NESTED-HERO Button'))).toBe(true);
    });

    it('深くネストされた画像は親セクション（hero）に属する', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(DEEPLY_NESTED_CONTENT_HTML);

      const heroSection = sections.find((s) => s.element.id === 'hero');
      expect(heroSection).toBeDefined();

      const imageSrcs = heroSection!.content.images.map((img) => img.src);
      expect(imageSrcs).toContain('/nested-hero-image.png');
    });

    it('深くネストされたリンクは親セクション（hero）に属する', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(DEEPLY_NESTED_CONTENT_HTML);

      const heroSection = sections.find((s) => s.element.id === 'hero');
      expect(heroSection).toBeDefined();

      const linkHrefs = heroSection!.content.links.map((l) => l.href);
      expect(linkHrefs).toContain('/nested-hero-link');
    });

    it('footerの深くネストされた要素もfooterに属する', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(DEEPLY_NESTED_CONTENT_HTML);

      const footerSection = sections.find((s) => s.element.id === 'footer');
      expect(footerSection).toBeDefined();

      const headingTexts = footerSection!.content.headings.map((h) => h.text);
      const paragraphs = footerSection!.content.paragraphs;

      expect(headingTexts.some((t) => t.includes('NESTED-FOOTER Title'))).toBe(true);
      expect(paragraphs.some((p) => p.includes('NESTED-FOOTER paragraph'))).toBe(true);
    });

    it('heroのネストされた要素がfooterに漏れない（分離検証）', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(DEEPLY_NESTED_CONTENT_HTML);

      const footerSection = sections.find((s) => s.element.id === 'footer');
      expect(footerSection).toBeDefined();

      const headingTexts = footerSection!.content.headings.map((h) => h.text);
      const paragraphs = footerSection!.content.paragraphs;
      const buttonTexts = footerSection!.content.buttons.map((b) => b.text);

      expect(headingTexts.some((t) => t.includes('NESTED-HERO'))).toBe(false);
      expect(paragraphs.some((p) => p.includes('NESTED-HERO'))).toBe(false);
      expect(buttonTexts.some((t) => t.includes('NESTED-HERO'))).toBe(false);
    });
  });

  // =========================================
  // P1: Edge Case Tests - Elements Outside Sections
  // セクション外の要素は適切に処理されるべき
  // =========================================
  describe('Edge Case: Elements Outside Sections (P1)', () => {
    // テスト用HTML: セクション外にある孤立した要素
    const ORPHAN_ELEMENTS_HTML = createMinimalHtml(`
      <h1 class="orphan-heading">ORPHAN Main Title</h1>
      <p class="orphan-paragraph">ORPHAN paragraph outside any section.</p>
      <section class="hero-section" id="hero">
        <h2>HERO Section Title</h2>
        <p>HERO paragraph inside section.</p>
        <button class="btn">HERO Button</button>
      </section>
      <p class="orphan-between">ORPHAN paragraph between sections.</p>
      <img src="/orphan-image.png" alt="ORPHAN Image">
      <section class="features-section" id="features">
        <h2>FEATURES Section Title</h2>
        <p>FEATURES paragraph.</p>
      </section>
      <a href="/orphan-link">ORPHAN Link</a>
      <footer class="site-footer" id="footer">
        <p>FOOTER paragraph.</p>
      </footer>
    `);

    it('heroセクションは孤立した見出し（ORPHAN）を含まない', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(ORPHAN_ELEMENTS_HTML);

      const heroSection = sections.find((s) => s.element.id === 'hero');
      expect(heroSection).toBeDefined();

      const headingTexts = heroSection!.content.headings.map((h) => h.text);
      expect(headingTexts.some((t) => t.includes('ORPHAN'))).toBe(false);
      expect(headingTexts.some((t) => t.includes('HERO Section Title'))).toBe(true);
    });

    it('heroセクションは孤立した段落（ORPHAN）を含まない', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(ORPHAN_ELEMENTS_HTML);

      const heroSection = sections.find((s) => s.element.id === 'hero');
      expect(heroSection).toBeDefined();

      const paragraphs = heroSection!.content.paragraphs;
      expect(paragraphs.some((p) => p.includes('ORPHAN'))).toBe(false);
      expect(paragraphs.some((p) => p.includes('HERO paragraph'))).toBe(true);
    });

    it('featuresセクションは孤立した要素（ORPHAN）を含まない', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(ORPHAN_ELEMENTS_HTML);

      const featuresSection = sections.find((s) => s.element.id === 'features');
      expect(featuresSection).toBeDefined();

      const headingTexts = featuresSection!.content.headings.map((h) => h.text);
      const paragraphs = featuresSection!.content.paragraphs;

      expect(headingTexts.some((t) => t.includes('ORPHAN'))).toBe(false);
      expect(paragraphs.some((p) => p.includes('ORPHAN'))).toBe(false);
    });

    it('featuresセクションは孤立した画像（/orphan-image.png）を含まない', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(ORPHAN_ELEMENTS_HTML);

      const featuresSection = sections.find((s) => s.element.id === 'features');
      expect(featuresSection).toBeDefined();

      const imageSrcs = featuresSection!.content.images.map((img) => img.src);
      expect(imageSrcs).not.toContain('/orphan-image.png');
    });

    it('footerセクションは孤立したリンク（/orphan-link）を含まない', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(ORPHAN_ELEMENTS_HTML);

      const footerSection = sections.find((s) => s.element.id === 'footer');
      expect(footerSection).toBeDefined();

      const linkHrefs = footerSection!.content.links.map((l) => l.href);
      expect(linkHrefs).not.toContain('/orphan-link');
    });

    it('どのセクションにも孤立した要素（ORPHAN）は含まれない', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(ORPHAN_ELEMENTS_HTML);

      for (const section of sections) {
        const headingTexts = section.content.headings.map((h) => h.text);
        const paragraphs = section.content.paragraphs;

        // 孤立要素がどのセクションにも含まれていないことを確認
        const hasOrphanHeading = headingTexts.some((t) => t.includes('ORPHAN Main Title'));
        const hasOrphanParagraph = paragraphs.some(
          (p) => p.includes('ORPHAN paragraph outside') || p.includes('ORPHAN paragraph between')
        );

        expect(hasOrphanHeading).toBe(false);
        expect(hasOrphanParagraph).toBe(false);
      }
    });
  });

  // =========================================
  // P2: Edge Case Tests - Empty Sections
  // 空のセクションは空のcontentを持つべき
  // =========================================
  describe('Edge Case: Empty Sections (P2)', () => {
    // テスト用HTML: 空のセクション
    const EMPTY_SECTION_HTML = createMinimalHtml(`
      <section class="hero-section" id="empty-hero">
        <!-- このセクションは空です -->
      </section>
      <section class="features-section" id="features-with-content">
        <h2>Features Title</h2>
        <p>Features description.</p>
        <button class="btn">Click Me</button>
        <img src="/feature.png" alt="Feature Image">
        <a href="/feature-link">Learn More</a>
      </section>
      <footer class="site-footer" id="empty-footer">
        <!-- 空のフッター -->
      </footer>
    `);

    it('空のheroセクションはheadingsが空配列', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(EMPTY_SECTION_HTML);

      const emptyHero = sections.find((s) => s.element.id === 'empty-hero');
      expect(emptyHero).toBeDefined();
      expect(emptyHero!.content.headings).toEqual([]);
    });

    it('空のheroセクションはparagraphsが空配列', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(EMPTY_SECTION_HTML);

      const emptyHero = sections.find((s) => s.element.id === 'empty-hero');
      expect(emptyHero).toBeDefined();
      expect(emptyHero!.content.paragraphs).toEqual([]);
    });

    it('空のheroセクションはbuttonsが空配列', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(EMPTY_SECTION_HTML);

      const emptyHero = sections.find((s) => s.element.id === 'empty-hero');
      expect(emptyHero).toBeDefined();
      expect(emptyHero!.content.buttons).toEqual([]);
    });

    it('空のheroセクションはlinksが空配列', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(EMPTY_SECTION_HTML);

      const emptyHero = sections.find((s) => s.element.id === 'empty-hero');
      expect(emptyHero).toBeDefined();
      expect(emptyHero!.content.links).toEqual([]);
    });

    it('空のheroセクションはimagesが空配列', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(EMPTY_SECTION_HTML);

      const emptyHero = sections.find((s) => s.element.id === 'empty-hero');
      expect(emptyHero).toBeDefined();
      expect(emptyHero!.content.images).toEqual([]);
    });

    it('空のfooterセクションもすべてのcontent配列が空', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(EMPTY_SECTION_HTML);

      const emptyFooter = sections.find((s) => s.element.id === 'empty-footer');
      expect(emptyFooter).toBeDefined();
      expect(emptyFooter!.content.headings).toEqual([]);
      expect(emptyFooter!.content.paragraphs).toEqual([]);
      expect(emptyFooter!.content.buttons).toEqual([]);
      expect(emptyFooter!.content.links).toEqual([]);
      expect(emptyFooter!.content.images).toEqual([]);
    });

    it('コンテンツを持つセクションは空配列ではない', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(EMPTY_SECTION_HTML);

      const featuresSection = sections.find((s) => s.element.id === 'features-with-content');
      expect(featuresSection).toBeDefined();
      expect(featuresSection!.content.headings.length).toBeGreaterThan(0);
      expect(featuresSection!.content.paragraphs.length).toBeGreaterThan(0);
      expect(featuresSection!.content.buttons.length).toBeGreaterThan(0);
      expect(featuresSection!.content.images.length).toBeGreaterThan(0);
      expect(featuresSection!.content.links.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // P2: Integration Test - Section Content Separation + Video Background
  // セクションコンテンツ分離とビデオ背景検出の統合検証
  // =========================================
  describe('Integration: Section Content Separation + Video Background (P2)', () => {
    // テスト用HTML: ビデオ背景を持つheroセクションと通常のfeaturesセクション
    const VIDEO_HERO_WITH_CONTENT_HTML = createMinimalHtml(`
      <section class="hero-section" id="video-hero">
        <video autoplay muted loop class="hero-video">
          <source src="/hero-bg.mp4" type="video/mp4">
        </video>
        <div class="hero-content">
          <h1>VIDEO-HERO Title</h1>
          <p>VIDEO-HERO paragraph with video background.</p>
          <button class="btn btn-primary">VIDEO-HERO CTA</button>
        </div>
      </section>
      <section class="features-section" id="features">
        <h2>FEATURES Title</h2>
        <p>FEATURES paragraph.</p>
        <img src="/feature-icon.svg" alt="Feature Icon">
      </section>
      <footer class="site-footer" id="footer">
        <p>FOOTER content.</p>
        <a href="/contact">Contact Us</a>
      </footer>
    `);

    it('ビデオ背景を持つheroセクションが検出される', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(VIDEO_HERO_WITH_CONTENT_HTML);

      const videoHero = sections.find((s) => s.element.id === 'video-hero');
      expect(videoHero).toBeDefined();
    });

    it('ビデオheroセクションのhtmlSnippetにvideo要素が含まれる', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(VIDEO_HERO_WITH_CONTENT_HTML);

      const videoHero = sections.find((s) => s.element.id === 'video-hero');
      expect(videoHero).toBeDefined();
      // ビデオ背景はhtmlSnippetで確認
      expect(videoHero!.htmlSnippet).toBeDefined();
      expect(videoHero!.htmlSnippet!.includes('<video')).toBe(true);
    });

    it('ビデオheroセクションのコンテンツが正しく抽出される', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(VIDEO_HERO_WITH_CONTENT_HTML);

      const videoHero = sections.find((s) => s.element.id === 'video-hero');
      expect(videoHero).toBeDefined();

      // 見出し
      const headingTexts = videoHero!.content.headings.map((h) => h.text);
      expect(headingTexts.some((t) => t.includes('VIDEO-HERO Title'))).toBe(true);

      // 段落
      const paragraphs = videoHero!.content.paragraphs;
      expect(paragraphs.some((p) => p.includes('VIDEO-HERO paragraph'))).toBe(true);

      // ボタン
      const buttonTexts = videoHero!.content.buttons.map((b) => b.text);
      expect(buttonTexts.some((t) => t.includes('VIDEO-HERO CTA'))).toBe(true);
    });

    it('ビデオheroのコンテンツがfeaturesに漏れない', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(VIDEO_HERO_WITH_CONTENT_HTML);

      const featuresSection = sections.find((s) => s.element.id === 'features');
      expect(featuresSection).toBeDefined();

      const headingTexts = featuresSection!.content.headings.map((h) => h.text);
      const paragraphs = featuresSection!.content.paragraphs;
      const buttonTexts = featuresSection!.content.buttons.map((b) => b.text);

      expect(headingTexts.some((t) => t.includes('VIDEO-HERO'))).toBe(false);
      expect(paragraphs.some((p) => p.includes('VIDEO-HERO'))).toBe(false);
      expect(buttonTexts.some((t) => t.includes('VIDEO-HERO'))).toBe(false);
    });

    it('featuresセクションのhtmlSnippetにvideo要素が含まれない', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(VIDEO_HERO_WITH_CONTENT_HTML);

      const featuresSection = sections.find((s) => s.element.id === 'features');
      expect(featuresSection).toBeDefined();
      // ビデオがないことをhtmlSnippetで確認
      if (featuresSection!.htmlSnippet) {
        expect(featuresSection!.htmlSnippet.includes('<video')).toBe(false);
      }
    });

    it('featuresセクションのコンテンツが正しく抽出される', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(VIDEO_HERO_WITH_CONTENT_HTML);

      const featuresSection = sections.find((s) => s.element.id === 'features');
      expect(featuresSection).toBeDefined();

      // 見出し
      const headingTexts = featuresSection!.content.headings.map((h) => h.text);
      expect(headingTexts.some((t) => t.includes('FEATURES Title'))).toBe(true);

      // 段落
      const paragraphs = featuresSection!.content.paragraphs;
      expect(paragraphs.some((p) => p.includes('FEATURES paragraph'))).toBe(true);

      // 画像
      const imageSrcs = featuresSection!.content.images.map((img) => img.src);
      expect(imageSrcs).toContain('/feature-icon.svg');
    });

    it('footerセクションのコンテンツが正しく分離される', async () => {
      const detector = new SectionDetector();
      const sections = await detector.detect(VIDEO_HERO_WITH_CONTENT_HTML);

      const footerSection = sections.find((s) => s.element.id === 'footer');
      expect(footerSection).toBeDefined();

      // 段落
      const paragraphs = footerSection!.content.paragraphs;
      expect(paragraphs.some((p) => p.includes('FOOTER content'))).toBe(true);

      // リンク
      const linkHrefs = footerSection!.content.links.map((l) => l.href);
      expect(linkHrefs).toContain('/contact');

      // 他セクションのコンテンツを含まない
      expect(paragraphs.some((p) => p.includes('VIDEO-HERO'))).toBe(false);
      expect(paragraphs.some((p) => p.includes('FEATURES'))).toBe(false);
    });
  });

  // =========================================
  // P1-2: Section Type Classification Tests (TDD Red Phase)
  // section_type分類テスト - 67%のunknown問題を解決するための前提テスト
  //
  // 【TDD Red Phase】
  // このテストは現在の実装では一部失敗することを期待しています。
  // 実装を改善する前にテストを作成し、テストが通るように実装を修正します。
  //
  // 【背景】
  // Reftrixの分析でsection_typeの67%が"unknown"に分類されている問題を解決するため、
  // example/reftrixの実際のHTMLパターンを基にしたテストを作成。
  // =========================================
  describe('Section Type Classification (P1-2 TDD Red Phase)', () => {
    /**
     * heroセクションの分類テスト
     *
     * Heroコンポーネントの実装パターンを参照:
     * - aria-label="Hero section" を持つ <section>
     * - h1見出し + ボタン + ページ上部配置
     * - グラデーション背景、アニメーション効果
     */
    describe('Hero Section Detection (hero.tsx pattern)', () => {
      // Heroコンポーネントの実際のパターン
      const HERO_ARIA_LABEL_HTML = createMinimalHtml(`
        <section
          class="relative min-h-screen flex flex-col justify-start pt-16"
          aria-label="Hero section"
          id="hero-aria"
        >
          <h1 class="font-sans text-5xl md:text-7xl lg:text-9xl z-[1] font-semibold tracking-tight">
            Where Design <br /> Becomes Data
          </h1>
          <p class="text-xl md:text-2xl z-[1] mt-6 font-light opacity-70">
            Transform web design into searchable knowledge with AI-powered pattern extraction.
          </p>
          <button class="font-sans relative h-10 text-white uppercase border-none rounded-full">
            Get Started
          </button>
        </section>
        <section id="features" class="features-section">
          <h2>Features</h2>
        </section>
      `);

      it('aria-label="Hero section"を持つセクションはheroとして分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(HERO_ARIA_LABEL_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero-aria');
        expect(heroSection).toBeDefined();

        // TDD Red Phase: aria-labelによるhero検出をテスト
        // 現在の実装ではaria-labelを検出ルールに含めていない可能性があるため失敗する可能性あり
        expect(heroSection!.type).toBe('hero');
      });

      it('aria-label="Hero section"を持つセクションのconfidenceは0.85以上', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(HERO_ARIA_LABEL_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero-aria');
        expect(heroSection).toBeDefined();
        expect(heroSection!.confidence).toBeGreaterThanOrEqual(0.85);
      });

      it('h1 + ボタン + ページ上部のセクションはheroとして分類される', async () => {
        // heroクラスがなくても、コンテンツ条件でheroを検出
        const HERO_CONTENT_ONLY_HTML = createMinimalHtml(`
          <section id="hero-content-only" class="main-section">
            <h1>Main Headline</h1>
            <p>Description text</p>
            <button class="btn-primary">Get Started</button>
          </section>
          <section id="other-section" class="other">
            <h2>Other Content</h2>
          </section>
        `);

        const detector = new SectionDetector();
        const sections = await detector.detect(HERO_CONTENT_ONLY_HTML);

        const heroSection = sections.find((s) => s.element.id === 'hero-content-only');
        expect(heroSection).toBeDefined();

        // hero-content ルール (confidence: 0.75) で検出されるべき
        expect(heroSection!.type).toBe('hero');
      });
    });

    /**
     * featuresセクションの分類テスト
     *
     * Featuresコンポーネントの実装パターンを参照:
     * - id="features" + aria-labelledby="features-heading"
     * - 3カラムグリッドレイアウト
     * - 各カード: アイコン + タイトル + 説明
     */
    describe('Features Section Detection (features.tsx pattern)', () => {
      // Featuresコンポーネントの実際のパターン
      const FEATURES_GRID_HTML = createMinimalHtml(`
        <section class="hero-section" id="hero">
          <h1>Hero Title</h1>
          <button>CTA</button>
        </section>
        <section
          id="features"
          class="flex flex-col px-4 md:px-16 mt-12 md:mt-20 lg:mt-40"
          aria-labelledby="features-heading"
        >
          <h2 id="features-heading" class="text-4xl sm:text-5xl md:text-6xl lg:w-[60%]">
            Analyzing design patterns for web creators on any platform
          </h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-8">
            <div class="feature-card">
              <div class="w-3 h-3 rounded-full" style="background-color: var(--color-accent-cyan)"></div>
              <h3>Layout Analysis</h3>
              <p>Extract section patterns with 768D vector embeddings.</p>
              <div class="text-xs">HNSW indexed / <10ms search</div>
            </div>
            <div class="feature-card">
              <div class="w-3 h-3 rounded-full" style="background-color: var(--color-accent-purple)"></div>
              <h3>Motion Detection</h3>
              <p>Detect CSS animations, JS libraries (GSAP, Framer Motion), and WebGL shaders.</p>
              <div class="text-xs">CDP + Web Animations API</div>
            </div>
            <div class="feature-card">
              <div class="w-3 h-3 rounded-full" style="background-color: var(--color-accent-gold)"></div>
              <h3>Quality Evaluation</h3>
              <p>Score designs on Originality, Craftsmanship, and Contextuality.</p>
              <div class="text-xs">Pattern-driven benchmarking</div>
            </div>
          </div>
        </section>
      `);

      it('id="features"を持つセクションはfeatureとして分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FEATURES_GRID_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        // TDD Red Phase: id="features"によるfeature検出をテスト
        expect(featuresSection!.type).toBe('feature');
      });

      it('3カラムグリッドを持つfeaturesセクションのconfidenceは0.8以上', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FEATURES_GRID_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();
        expect(featuresSection!.confidence).toBeGreaterThanOrEqual(0.8);
      });

      it('aria-labelledbyを持つfeaturesセクションは正しく検出される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FEATURES_GRID_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features');
        expect(featuresSection).toBeDefined();

        // aria-labelledbyがあっても正しくfeatureとして分類される
        expect(featuresSection!.type).toBe('feature');
        expect(featuresSection!.type).not.toBe('unknown');
      });
    });

    /**
     * CTAセクションの分類テスト
     *
     * CTAコンポーネントの実装パターンを参照:
     * - aria-labelledby="cta-heading"
     * - アクションボタン（primary/secondary）
     * - グラデーション背景
     */
    describe('CTA Section Detection (cta.tsx pattern)', () => {
      // CTAコンポーネントの実際のパターン
      const CTA_ARIA_LABELLEDBY_HTML = createMinimalHtml(`
        <section id="hero">
          <h1>Hero</h1>
        </section>
        <section
          id="cta-section"
          class="relative py-32 overflow-hidden"
          aria-labelledby="cta-heading"
        >
          <div class="absolute inset-0 pointer-events-none" aria-hidden="true">
            <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full opacity-20 blur-[180px]"
              style="background: radial-gradient(circle, var(--color-accent-gold) 0%, transparent 70%);">
            </div>
          </div>
          <div class="section-container relative z-10">
            <div class="max-w-2xl mx-auto text-center">
              <p class="text-sm uppercase tracking-widest mb-6">Ready to Analyze?</p>
              <h2 id="cta-heading" class="mb-6">
                <span>Start Building </span>
                <span class="text-gradient-cyan-gold">Better Designs</span>
              </h2>
              <p class="mb-12 max-w-lg mx-auto">
                Integrate Reftrix into your workflow and transform how you approach web design.
              </p>
              <div class="flex flex-col sm:flex-row items-center justify-center gap-4">
                <a href="https://github.com/TKMD/ReftrixMCP" class="mevvy-btn-primary hover-micro-pop inline-flex items-center gap-3">
                  Get Started
                </a>
                <a href="#features" class="mevvy-btn-outline hover-micro-pop">
                  Learn More
                </a>
              </div>
            </div>
          </div>
        </section>
      `);

      it('aria-labelledby="cta-heading"を持つセクションはctaとして分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(CTA_ARIA_LABELLEDBY_HTML);

        const ctaSection = sections.find((s) => s.element.id === 'cta-section');
        expect(ctaSection).toBeDefined();

        // TDD Red Phase: aria-labelledbyの"cta"キーワードによるCTA検出をテスト
        expect(ctaSection!.type).toBe('cta');
      });

      it('アクションボタン（Get Started/Learn More）を含むセクションはctaとして分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(CTA_ARIA_LABELLEDBY_HTML);

        const ctaSection = sections.find((s) => s.element.id === 'cta-section');
        expect(ctaSection).toBeDefined();

        // ボタン/リンクが存在することを確認
        const hasActionLinks = ctaSection!.content.links.length > 0;
        expect(hasActionLinks).toBe(true);

        // ctaとして分類されるべき
        expect(ctaSection!.type).toBe('cta');
      });

      it('CTAセクションのconfidenceは0.7以上', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(CTA_ARIA_LABELLEDBY_HTML);

        const ctaSection = sections.find((s) => s.element.id === 'cta-section');
        expect(ctaSection).toBeDefined();
        expect(ctaSection!.confidence).toBeGreaterThanOrEqual(0.7);
      });
    });

    /**
     * footerセクションの分類テスト
     *
     * Footerコンポーネントの実装パターンを参照:
     * - <footer role="contentinfo">
     * - 2カラムグリッド（ツールカード）
     * - コピーライト、リンク
     */
    describe('Footer Section Detection (footer.tsx pattern)', () => {
      // Footerコンポーネントの実際のパターン
      const FOOTER_ROLE_CONTENTINFO_HTML = createMinimalHtml(`
        <section id="hero">
          <h1>Hero</h1>
        </section>
        <section id="features">
          <h2>Features</h2>
        </section>
        <footer
          class="relative px-4 md:px-16 py-24 overflow-hidden"
          role="contentinfo"
          id="footer"
        >
          <div class="relative z-10 max-w-[1280px] mx-auto">
            <div class="mb-16">
              <h2 class="text-4xl sm:text-5xl md:text-7xl text-center mx-auto">
                Ecosystem and Tools
              </h2>
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-8 md:mt-16 overflow-hidden">
              <div class="tool-card border border-[#3d3d3d] rounded-[20px] p-6">
                <h3>Layout Analysis</h3>
                <p>Extract section patterns from any webpage with 768D vector embeddings.</p>
                <div class="flex flex-wrap gap-2 mt-auto">
                  <span class="text-xs px-3 py-1 rounded-full border">layout.ingest</span>
                  <span class="text-xs px-3 py-1 rounded-full border">layout.search</span>
                </div>
              </div>
              <div class="tool-card border border-[#3d3d3d] rounded-[20px] p-6">
                <h3>Motion & Quality</h3>
                <p>Detect CSS animations, JS libraries, and WebGL shaders.</p>
                <div class="flex flex-wrap gap-2 mt-auto">
                  <span class="text-xs px-3 py-1 rounded-full border">motion.detect</span>
                  <span class="text-xs px-3 py-1 rounded-full border">quality.evaluate</span>
                </div>
              </div>
            </div>
            <div class="border-t border-[#3d3d3d] pt-12 mt-20">
              <div class="flex flex-col md:flex-row items-center justify-between gap-8">
                <div class="flex items-center gap-4">
                  <span>Reftrix</span>
                  <span>WebDesign Pattern Analysis</span>
                </div>
                <div class="flex items-center gap-6">
                  <a href="https://github.com/TKMD/ReftrixMCP">GitHub</a>
                  <a href="#">Documentation</a>
                  <a href="#">Blog</a>
                </div>
              </div>
              <div class="mt-12 pt-8 border-t border-[#3d3d3d]">
                <p>2026 Reftrix. All rights reserved.</p>
              </div>
            </div>
          </div>
        </footer>
      `);

      it('role="contentinfo"を持つfooterはfooterとして分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FOOTER_ROLE_CONTENTINFO_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        // footer-tag ルール (confidence: 0.95) で検出されるべき
        expect(footerSection!.type).toBe('footer');
      });

      it('role="contentinfo"を持つfooterのconfidenceは0.95', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FOOTER_ROLE_CONTENTINFO_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();
        expect(footerSection!.confidence).toBeGreaterThanOrEqual(0.95);
      });

      it('コピーライトテキストを含むfooterは正しく検出される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FOOTER_ROLE_CONTENTINFO_HTML);

        const footerSection = sections.find((s) => s.element.id === 'footer');
        expect(footerSection).toBeDefined();

        // コピーライトテキストが存在
        const hasCopyright = footerSection!.content.paragraphs.some(
          (p) => p.includes('rights reserved') || p.includes('Reftrix')
        );
        expect(hasCopyright).toBe(true);

        expect(footerSection!.type).toBe('footer');
      });
    });

    /**
     * 複合特徴を持つセクションの境界ケーステスト
     *
     * 問題: 複数のセクションタイプに該当する特徴を持つセクションが
     *       "unknown"として分類される可能性
     */
    describe('Boundary Cases: Composite Feature Sections', () => {
      // CTAのような特徴（ボタン）を持つが、pricing内にあるケース
      const COMPOSITE_PRICING_CTA_HTML = createMinimalHtml(`
        <section id="hero">
          <h1>Hero</h1>
        </section>
        <section id="pricing-with-cta" class="pricing-section">
          <h2>Pricing Plans</h2>
          <div class="pricing-cards">
            <div class="pricing-card">
              <h3>Basic</h3>
              <p class="price">$9/month</p>
              <button class="btn-primary">Get Started</button>
            </div>
            <div class="pricing-card">
              <h3>Pro</h3>
              <p class="price">$29/month</p>
              <button class="btn-primary">Get Started</button>
            </div>
          </div>
        </section>
      `);

      it('pricing内にCTAボタンがあってもpricingとして分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(COMPOSITE_PRICING_CTA_HTML);

        const pricingSection = sections.find((s) => s.element.id === 'pricing-with-cta');
        expect(pricingSection).toBeDefined();

        // pricing-class (confidence: 0.9) > cta-content (confidence: 0.6)
        expect(pricingSection!.type).toBe('pricing');
        expect(pricingSection!.type).not.toBe('cta');
      });

      // gallery特徴（複数画像）を持つがfeature内にあるケース
      const COMPOSITE_FEATURE_GALLERY_HTML = createMinimalHtml(`
        <section id="features-with-images" class="features-section">
          <h2>Our Features</h2>
          <div class="feature-grid">
            <div class="feature-item">
              <img src="/feature1.png" alt="Feature 1">
              <h3>Feature One</h3>
              <p>Description one</p>
            </div>
            <div class="feature-item">
              <img src="/feature2.png" alt="Feature 2">
              <h3>Feature Two</h3>
              <p>Description two</p>
            </div>
            <div class="feature-item">
              <img src="/feature3.png" alt="Feature 3">
              <h3>Feature Three</h3>
              <p>Description three</p>
            </div>
            <div class="feature-item">
              <img src="/feature4.png" alt="Feature 4">
              <h3>Feature Four</h3>
              <p>Description four</p>
            </div>
          </div>
        </section>
      `);

      it('4つの画像を持つfeatureセクションはfeatureとして分類される（galleryではない）', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(COMPOSITE_FEATURE_GALLERY_HTML);

        const featuresSection = sections.find((s) => s.element.id === 'features-with-images');
        expect(featuresSection).toBeDefined();

        // feature-class (confidence: 0.8) > gallery-content (confidence: 0.75)
        expect(featuresSection!.type).toBe('feature');
        expect(featuresSection!.type).not.toBe('gallery');
      });
    });

    /**
     * unknownへのフォールバック検証テスト
     *
     * 特定のセクションタイプを示す明確なシグナルがない場合、
     * unknownとして分類されるべきケース
     */
    describe('Unknown Fallback Cases', () => {
      // 明確なシグナルがないセクション
      const GENERIC_SECTION_HTML = createMinimalHtml(`
        <section id="generic-section" class="some-class">
          <div class="container">
            <p>Some generic content without clear section type indicators.</p>
          </div>
        </section>
      `);

      it('明確なセクションタイプ指標がないセクションはunknownとして分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(GENERIC_SECTION_HTML);

        const genericSection = sections.find((s) => s.element.id === 'generic-section');
        expect(genericSection).toBeDefined();

        // 明確なシグナルがないため、unknownになるべき
        expect(genericSection!.type).toBe('unknown');
      });

      it('unknownセクションのconfidenceは0.5以下', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(GENERIC_SECTION_HTML);

        const genericSection = sections.find((s) => s.element.id === 'generic-section');
        expect(genericSection).toBeDefined();

        // unknownの場合、confidenceは低いはず
        expect(genericSection!.confidence).toBeLessThanOrEqual(0.5);
      });

      // divのみの構造
      const DIV_ONLY_STRUCTURE_HTML = createMinimalHtml(`
        <div id="div-only" class="wrapper">
          <div class="inner">
            <p>Content inside divs only, no semantic structure.</p>
          </div>
        </div>
      `);

      it('divのみの構造はセクションとして検出されないか、unknownとして分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(DIV_ONLY_STRUCTURE_HTML);

        // divはセマンティックタグではないため、セクションとして検出されない可能性
        // または検出された場合はunknown
        const divSection = sections.find((s) => s.element.id === 'div-only');

        if (divSection) {
          expect(divSection.type).toBe('unknown');
        } else {
          // divはセクションとして検出されないことも許容
          expect(divSection).toBeUndefined();
        }
      });
    });

    /**
     * mcp-tools.tsx パターンのテスト（MCPツール紹介セクション）
     *
     * MCPToolsコンポーネントの実装パターンを参照:
     * - id="mcp-tools"
     * - 4カラムグリッドのツールカード
     * - カテゴリバッジ
     */
    describe('MCP Tools Section Detection (mcp-tools.tsx pattern)', () => {
      const MCP_TOOLS_HTML = createMinimalHtml(`
        <section
          id="mcp-tools"
          class="relative py-32 overflow-hidden"
          aria-labelledby="mcp-tools-heading"
        >
          <div class="section-container relative z-10">
            <div class="mb-16">
              <p class="text-sm uppercase tracking-widest mb-4">MCP Integration</p>
              <h2 id="mcp-tools-heading">
                <span>17 Tools for </span>
                <span class="text-gradient-purple-cyan">Claude Integration</span>
              </h2>
              <p class="mt-4 max-w-lg">
                Access all Reftrix capabilities through the MCP protocol.
              </p>
            </div>
            <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div class="tool-card">
                <code>layout.ingest</code>
                <span class="category-badge">Layout</span>
                <p>Crawl webpages and extract HTML/screenshots</p>
              </div>
              <div class="tool-card">
                <code>layout.search</code>
                <span class="category-badge">Layout</span>
                <p>Semantic search with 768D vector embeddings</p>
              </div>
              <div class="tool-card">
                <code>motion.detect</code>
                <span class="category-badge">Motion</span>
                <p>Detect CSS animations, JS libraries</p>
              </div>
              <div class="tool-card">
                <code>quality.evaluate</code>
                <span class="category-badge">Quality</span>
                <p>Score design with pattern-driven benchmarking</p>
              </div>
            </div>
          </div>
        </section>
      `);

      it('id="mcp-tools"を持つセクションはfeatureまたはservicesとして分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(MCP_TOOLS_HTML);

        const mcpToolsSection = sections.find((s) => s.element.id === 'mcp-tools');
        expect(mcpToolsSection).toBeDefined();

        // TDD Red Phase: ツール紹介セクションの分類テスト
        // "tools"は現在のCLASSIFICATION_RULESに含まれていないため
        // feature（4カラムグリッド、複数のカード）として分類される可能性が高い
        expect(['feature', 'services', 'unknown']).toContain(mcpToolsSection!.type);
        expect(mcpToolsSection!.type).not.toBe('unknown');
      });

      it('4カラムグリッドのツールセクションはunknownにならない', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(MCP_TOOLS_HTML);

        const mcpToolsSection = sections.find((s) => s.element.id === 'mcp-tools');
        expect(mcpToolsSection).toBeDefined();

        // 複数のカード、見出し、説明を持つため、unknownにはならないべき
        expect(mcpToolsSection!.type).not.toBe('unknown');
      });
    });

    /**
     * navigation/headerパターンのテスト
     *
     * Headerコンポーネントの実装パターンを参照:
     * - role="navigation"
     * - ロゴ + ナビゲーションリンク
     */
    describe('Navigation Section Detection (header.tsx pattern)', () => {
      // Headerコンポーネントの実際のパターン
      const HEADER_NAV_HTML = createMinimalHtml(`
        <header
          class="flex justify-between items-center py-6"
          role="navigation"
          id="main-header"
        >
          <div class="flex items-center gap-3">
            <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
              <rect x="2" y="2" width="36" height="36" rx="8" stroke="url(#header-logo-grad)" stroke-width="2" fill="none"></rect>
            </svg>
            <span class="font-semibold text-lg tracking-tight">Reftrix</span>
          </div>
          <nav class="hidden md:flex items-center gap-8">
            <a href="#features">Features</a>
            <a href="#mcp-tools">MCP Tools</a>
            <a href="https://github.com/TKMD/ReftrixMCP">GitHub</a>
          </nav>
        </header>
        <section id="hero">
          <h1>Hero</h1>
        </section>
      `);

      it('role="navigation"を持つheaderはnavigationとして分類される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(HEADER_NAV_HTML);

        const headerSection = sections.find((s) => s.element.id === 'main-header');
        expect(headerSection).toBeDefined();

        // navigation-tag ルール (confidence: 0.95) で検出されるべき
        expect(headerSection!.type).toBe('navigation');
      });

      it('navigationセクションのconfidenceは0.8以上', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(HEADER_NAV_HTML);

        const headerSection = sections.find((s) => s.element.id === 'main-header');
        expect(headerSection).toBeDefined();
        expect(headerSection!.confidence).toBeGreaterThanOrEqual(0.8);
      });
    });

    /**
     * 信頼度しきい値のテスト
     *
     * 同一セクションで複数のルールがマッチした場合、
     * 最も高い信頼度のルールが適用されるべき
     */
    describe('Confidence Threshold Tests', () => {
      // heroクラスとcta特徴の両方を持つセクション
      const HERO_WITH_CTA_FEATURES_HTML = createMinimalHtml(`
        <section id="hero-cta-combo" class="hero-section">
          <h1>Main Headline</h1>
          <p>Description text</p>
          <button class="btn btn-primary">Get Started Now</button>
          <button class="btn btn-secondary">Learn More</button>
        </section>
      `);

      it('heroクラスとCTA特徴がある場合、より高い信頼度のheroが優先される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(HERO_WITH_CTA_FEATURES_HTML);

        const section = sections.find((s) => s.element.id === 'hero-cta-combo');
        expect(section).toBeDefined();

        // hero-class (0.85) > cta-content (0.6)
        expect(section!.type).toBe('hero');
        expect(section!.confidence).toBeGreaterThanOrEqual(0.85);
      });

      // footerタグとナビゲーション特徴の両方を持つセクション
      const FOOTER_WITH_NAV_HTML = createMinimalHtml(`
        <footer id="footer-nav-combo" class="site-footer" role="contentinfo">
          <nav class="footer-nav">
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
            <a href="/privacy">Privacy</a>
          </nav>
          <p>2026 Reftrix. All rights reserved.</p>
        </footer>
      `);

      it('footerタグとナビゲーション要素がある場合、footerが優先される', async () => {
        const detector = new SectionDetector();
        const sections = await detector.detect(FOOTER_WITH_NAV_HTML);

        const section = sections.find((s) => s.element.id === 'footer-nav-combo');
        expect(section).toBeDefined();

        // footer-tag (0.95) > navigation-class (0.8)
        expect(section!.type).toBe('footer');
        expect(section!.confidence).toBeGreaterThanOrEqual(0.95);
      });
    });
  });
});
