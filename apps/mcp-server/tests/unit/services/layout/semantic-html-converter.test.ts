// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Semantic HTML Converter テスト
 * TDD Red: セマンティックHTML変換のテストを先に作成
 *
 * REFTRIX-CODEGEN-02: セマンティックHTML構造最適化
 * - sectionTypeに基づく適切なHTML要素選択
 * - aria-label属性の自動生成
 * - 過剰な<div>要素の削減
 *
 * @module tests/unit/services/layout/semantic-html-converter.test
 */

import { describe, it, expect } from 'vitest';
import {
  mapSectionTypeToElement,
  generateAriaLabel,
  convertToSemanticHtml,
  type SemanticConversionOptions,
} from '../../../../src/services/layout/semantic-html-converter';

// =====================================================
// sectionType → HTML要素マッピングテスト
// =====================================================

describe('mapSectionTypeToElement', () => {
  describe('セクションタイプからHTML要素へのマッピング', () => {
    it('hero → section', () => {
      expect(mapSectionTypeToElement('hero')).toBe('section');
    });

    it('header → header', () => {
      expect(mapSectionTypeToElement('header')).toBe('header');
    });

    it('footer → footer', () => {
      expect(mapSectionTypeToElement('footer')).toBe('footer');
    });

    it('navigation → nav', () => {
      expect(mapSectionTypeToElement('navigation')).toBe('nav');
    });

    it('nav → nav', () => {
      expect(mapSectionTypeToElement('nav')).toBe('nav');
    });

    it('content → main', () => {
      expect(mapSectionTypeToElement('content')).toBe('main');
    });

    it('main → main', () => {
      expect(mapSectionTypeToElement('main')).toBe('main');
    });

    it('article → article', () => {
      expect(mapSectionTypeToElement('article')).toBe('article');
    });

    it('sidebar → aside', () => {
      expect(mapSectionTypeToElement('sidebar')).toBe('aside');
    });

    it('aside → aside', () => {
      expect(mapSectionTypeToElement('aside')).toBe('aside');
    });

    it('feature → section', () => {
      expect(mapSectionTypeToElement('feature')).toBe('section');
    });

    it('cta → section', () => {
      expect(mapSectionTypeToElement('cta')).toBe('section');
    });

    it('testimonial → section', () => {
      expect(mapSectionTypeToElement('testimonial')).toBe('section');
    });

    it('pricing → section', () => {
      expect(mapSectionTypeToElement('pricing')).toBe('section');
    });

    it('faq → section', () => {
      expect(mapSectionTypeToElement('faq')).toBe('section');
    });

    it('contact → section', () => {
      expect(mapSectionTypeToElement('contact')).toBe('section');
    });

    it('unknown → section (デフォルト)', () => {
      expect(mapSectionTypeToElement('unknown')).toBe('section');
    });

    it('空文字列 → section (デフォルト)', () => {
      expect(mapSectionTypeToElement('')).toBe('section');
    });

    it('大文字小文字を区別しない（HERO → section）', () => {
      expect(mapSectionTypeToElement('HERO')).toBe('section');
    });

    it('大文字小文字を区別しない（Header → header）', () => {
      expect(mapSectionTypeToElement('Header')).toBe('header');
    });
  });
});

// =====================================================
// aria-label生成テスト
// =====================================================

describe('generateAriaLabel', () => {
  describe('sectionNameからaria-labelを生成', () => {
    it('sectionNameがある場合はそれを使用', () => {
      expect(generateAriaLabel('hero', 'Modern Hero Section')).toBe('Modern Hero Section');
    });

    it('sectionNameが空の場合はsectionTypeから生成', () => {
      expect(generateAriaLabel('hero', '')).toBe('Hero section');
    });

    it('sectionNameがundefinedの場合はsectionTypeから生成', () => {
      expect(generateAriaLabel('hero', undefined)).toBe('Hero section');
    });

    it('sectionTypeをキャピタライズしてsection付きで返す', () => {
      expect(generateAriaLabel('testimonial', undefined)).toBe('Testimonial section');
    });

    it('headerタイプの場合はSite headerを返す', () => {
      expect(generateAriaLabel('header', undefined)).toBe('Site header');
    });

    it('footerタイプの場合はSite footerを返す', () => {
      expect(generateAriaLabel('footer', undefined)).toBe('Site footer');
    });

    it('navigationタイプの場合はMain navigationを返す', () => {
      expect(generateAriaLabel('navigation', undefined)).toBe('Main navigation');
    });

    it('navタイプの場合はMain navigationを返す', () => {
      expect(generateAriaLabel('nav', undefined)).toBe('Main navigation');
    });

    it('contentタイプの場合はMain contentを返す', () => {
      expect(generateAriaLabel('content', undefined)).toBe('Main content');
    });

    it('mainタイプの場合はMain contentを返す', () => {
      expect(generateAriaLabel('main', undefined)).toBe('Main content');
    });

    it('sidebarタイプの場合はSidebar navigationを返す', () => {
      expect(generateAriaLabel('sidebar', undefined)).toBe('Sidebar navigation');
    });
  });
});

// =====================================================
// セマンティックHTML変換テスト
// =====================================================

describe('convertToSemanticHtml', () => {
  describe('divタグをセマンティック要素に変換', () => {
    it('ルートdivをsectionタイプに応じた要素に変換', () => {
      const html = '<div class="hero"><h1>Welcome</h1></div>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'hero',
        sectionName: 'Hero Section',
      });
      expect(result).toContain('<section');
      expect(result).toContain('aria-label="Hero Section"');
      expect(result).not.toMatch(/^<div/);
    });

    it('header sectionTypeの場合はheader要素を使用', () => {
      const html = '<div class="site-header"><nav>Menu</nav></div>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'header',
      });
      expect(result).toContain('<header');
      expect(result).toContain('aria-label="Site header"');
    });

    it('footer sectionTypeの場合はfooter要素を使用', () => {
      const html = '<div class="site-footer"><p>Copyright</p></div>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'footer',
      });
      expect(result).toContain('<footer');
      expect(result).toContain('aria-label="Site footer"');
    });

    it('navigation sectionTypeの場合はnav要素を使用', () => {
      const html = '<div class="navigation"><a href="/">Home</a></div>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'navigation',
      });
      expect(result).toContain('<nav');
      expect(result).toContain('aria-label="Main navigation"');
    });
  });

  describe('既存のセマンティック要素を保持', () => {
    it('既にsection要素の場合はaria-labelのみ追加', () => {
      const html = '<section class="hero"><h1>Welcome</h1></section>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'hero',
        sectionName: 'Welcome Section',
      });
      expect(result).toContain('<section');
      expect(result).toContain('aria-label="Welcome Section"');
    });

    it('既にheader要素の場合はaria-labelのみ追加', () => {
      const html = '<header class="site-header"><nav>Menu</nav></header>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'header',
      });
      expect(result).toContain('<header');
      expect(result).toContain('aria-label="Site header"');
    });

    it('既存のaria-labelを上書きしない', () => {
      const html = '<section aria-label="Custom Label"><h1>Title</h1></section>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'hero',
        sectionName: 'Hero Section',
        preserveExistingAriaLabel: true,
      });
      expect(result).toContain('aria-label="Custom Label"');
      expect(result).not.toContain('aria-label="Hero Section"');
    });
  });

  describe('ネストされたdiv要素の処理', () => {
    it('ルート要素のみ変換し、内部のdivは保持', () => {
      const html = '<div class="hero"><div class="container"><h1>Title</h1></div></div>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'hero',
      });
      expect(result).toMatch(/^<section/);
      expect(result).toContain('<div class="container">');
    });

    it('class属性を保持', () => {
      const html = '<div class="hero bg-blue-500"><h1>Welcome</h1></div>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'hero',
      });
      expect(result).toContain('class="hero bg-blue-500"');
    });
  });

  describe('空のHTMLの処理', () => {
    it('空文字列は空文字列を返す', () => {
      expect(convertToSemanticHtml('', { sectionType: 'hero' })).toBe('');
    });

    it('空白のみの場合も空文字列を返す', () => {
      expect(convertToSemanticHtml('   ', { sectionType: 'hero' })).toBe('');
    });
  });

  describe('オプション設定', () => {
    it('addAriaLabel: false の場合aria-labelを追加しない', () => {
      const html = '<div class="hero"><h1>Welcome</h1></div>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'hero',
        addAriaLabel: false,
      });
      expect(result).not.toContain('aria-label');
    });

    it('convertRootOnly: true の場合ルート要素のみ変換', () => {
      const html = '<div class="hero"><div class="inner"><h1>Title</h1></div></div>';
      const result = convertToSemanticHtml(html, {
        sectionType: 'hero',
        convertRootOnly: true,
      });
      expect(result).toMatch(/^<section/);
      expect(result).toContain('<div class="inner">');
    });
  });
});
