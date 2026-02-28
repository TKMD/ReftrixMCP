// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.inspect MCPツール - セクション別コンテンツ分離テスト
 *
 * v0.1.0 で修正されたバグ:
 * - CSSAnalysisCacheに保存時にcontent情報が欠落していた
 * - キャッシュ復元時にcontent配列がすべて空でハードコードされていた
 *
 * 修正内容:
 * - CSSAnalysisResultインターフェースにcontent型を追加
 * - キャッシュ保存時にcontent情報を含めるように修正
 * - キャッシュ復元時にキャッシュされたcontent情報を使用するように修正
 *
 * このテストは修正後も回帰防止のために保持されます。
 *
 * @module tests/tools/layout/section-content-isolation.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { layoutInspectHandler, resetLayoutInspectServiceFactory } from '../../../src/tools/layout/inspect';
import { detectSections, extractSectionContent } from '../../../src/tools/layout/inspect/inspect.utils';
import { resetCSSAnalysisCacheService } from '../../../src/services/css-analysis-cache.service';

// =====================================================
// テストHTMLサンプル（共通化・重複削減）
// =====================================================

const HTML_SAMPLES = {
  multiSection: `<!DOCTYPE html>
<html><head><title>Multi-Section Page</title></head>
<body>
  <header><nav><a href="/">Home</a><a href="/products">Products</a></nav><h1>Site Title</h1></header>
  <section class="hero"><h1>Hero Heading</h1><p>Hero paragraph content.</p><button class="cta">Hero CTA Button</button></section>
  <section class="features"><h2>Features Heading</h2><p>Features paragraph content.</p><img src="/feature1.svg" alt="Feature 1" /><img src="/feature2.svg" alt="Feature 2" /><button>Features Button</button></section>
  <section class="testimonial"><h2>Testimonials Heading</h2><p>Testimonials paragraph content.</p><blockquote><p>"Great product!"</p></blockquote><button>Testimonials Button</button></section>
  <section class="cta"><h2>CTA Section Heading</h2><p>CTA section paragraph content.</p><button class="primary">CTA Section Button</button></section>
  <footer><h3>Footer Heading</h3><p>Footer paragraph content.</p><a href="/privacy">Privacy</a><a href="/terms">Terms</a><button>Footer Button</button></footer>
</body></html>`,

  twoSection: `<!DOCTYPE html>
<html><body>
  <section class="hero"><h1>Hero Title</h1><p>Hero description.</p><button class="cta">Hero Button</button></section>
  <section class="features"><h2>Features Title</h2><p>Features description.</p><button>Features Button</button></section>
</body></html>`,

  threeDistinct: `<!DOCTYPE html>
<html><body>
  <section class="hero"><h1>ALPHA Hero Title</h1><p>ALPHA hero paragraph.</p><button class="cta">ALPHA Button</button></section>
  <section class="features"><h2>BETA Features Title</h2><p>BETA features paragraph.</p><button>BETA Button</button></section>
  <footer><h3>GAMMA Footer Title</h3><p>GAMMA footer paragraph.</p><button>GAMMA Button</button></footer>
</body></html>`,
};

// =====================================================
// 共通ヘルパー・ファクトリー（重複削減）
// =====================================================

// セットアップ/クリーンアップ
// v0.1.0: キャッシュサービスもリセットして、古いキャッシュエントリを削除
const setupTest = async () => {
  resetLayoutInspectServiceFactory();
  await resetCSSAnalysisCacheService();
};
const cleanupTest = async () => {
  resetLayoutInspectServiceFactory();
  await resetCSSAnalysisCacheService();
};

// インスペクト実行ヘルパー（重複削減）
const inspectHtml = async (html: string) => {
  const result = await layoutInspectHandler({ html, options: { detectSections: true } });
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('Inspect failed');
  return result.data;
};

// セクション取得ヘルパー（重複削減）
type SectionType = 'hero' | 'features' | 'footer' | 'header' | 'testimonial' | 'cta';
const findSection = (sections: Array<{ type: string; content: { headings: Array<{ text: string }>; paragraphs: string[]; buttons: Array<{ text: string }>; links: Array<{ href: string }>; images: Array<{ src: string }> } }>, type: SectionType) =>
  sections.find((s) => s.type === type);

// コンテンツ検証ヘルパー（重複削減）
const getHeadingTexts = (section: ReturnType<typeof findSection>) => section?.content.headings.map((h) => h.text) ?? [];
const getParagraphs = (section: ReturnType<typeof findSection>) => section?.content.paragraphs ?? [];
const getButtonTexts = (section: ReturnType<typeof findSection>) => section?.content.buttons.map((b) => b.text) ?? [];
const getLinkHrefs = (section: ReturnType<typeof findSection>) => section?.content.links.map((l) => l.href) ?? [];

// 含有/非含有検証ヘルパー（重複削減）
const containsText = (texts: string[], search: string) => texts.some((t) => t.includes(search));
const notContainsText = (texts: string[], search: string) => !texts.some((t) => t.includes(search));

// =====================================================
// TDD Red Phase: セクション別コンテンツ分離テスト
// =====================================================

describe('TDD Red Phase: セクション別コンテンツ分離', () => {
  beforeEach(setupTest);
  afterEach(cleanupTest);

  describe('BUG: 全セクションで同一contentを返却する問題', () => {
    // パラメータ化テスト: 各コンテンツタイプ（headings/paragraphs/buttons）の分離検証
    it.each([
      { contentType: 'headings', getter: getHeadingTexts, label: '見出し' },
      { contentType: 'paragraphs', getter: getParagraphs, label: '段落' },
      { contentType: 'buttons', getter: getButtonTexts, label: 'ボタン' },
    ])('各セクションは異なる$labelを持つべき', async ({ getter }) => {
      const { sections } = await inspectHtml(HTML_SAMPLES.threeDistinct);
      expect(sections.length).toBeGreaterThanOrEqual(3);

      const heroSection = findSection(sections, 'hero');
      const featuresSection = findSection(sections, 'features');
      const footerSection = findSection(sections, 'footer');

      expect(heroSection).toBeDefined();
      expect(featuresSection).toBeDefined();
      expect(footerSection).toBeDefined();

      // heroセクションはALPHAのみ
      expect(containsText(getter(heroSection), 'ALPHA')).toBe(true);
      expect(notContainsText(getter(heroSection), 'BETA')).toBe(true);
      expect(notContainsText(getter(heroSection), 'GAMMA')).toBe(true);

      // featuresセクションはBETAのみ
      expect(containsText(getter(featuresSection), 'BETA')).toBe(true);
      expect(notContainsText(getter(featuresSection), 'ALPHA')).toBe(true);
      expect(notContainsText(getter(featuresSection), 'GAMMA')).toBe(true);

      // footerセクションはGAMMAのみ
      expect(containsText(getter(footerSection), 'GAMMA')).toBe(true);
      expect(notContainsText(getter(footerSection), 'ALPHA')).toBe(true);
      expect(notContainsText(getter(footerSection), 'BETA')).toBe(true);
    });

    it('セクション間でcontentオブジェクトが異なるべき', async () => {
      const { sections } = await inspectHtml(HTML_SAMPLES.twoSection);
      expect(sections.length).toBeGreaterThanOrEqual(2);

      const heroSection = findSection(sections, 'hero');
      const featuresSection = findSection(sections, 'features');

      expect(heroSection).toBeDefined();
      expect(featuresSection).toBeDefined();

      // 各コンテンツタイプで異なることを検証
      const comparisons = [
        { a: getHeadingTexts(heroSection), b: getHeadingTexts(featuresSection) },
        { a: getParagraphs(heroSection), b: getParagraphs(featuresSection) },
        { a: getButtonTexts(heroSection), b: getButtonTexts(featuresSection) },
      ];

      comparisons.forEach(({ a, b }) => {
        const same = a.length === b.length && a.every((text, i) => text === b[i]);
        expect(same).toBe(false);
      });
    });

    it('5セクションのHTMLで各セクションが固有のコンテンツを持つべき', async () => {
      const { sections } = await inspectHtml(HTML_SAMPLES.multiSection);
      expect(sections.length).toBeGreaterThanOrEqual(4);

      const heroSection = findSection(sections, 'hero');
      const featuresSection = findSection(sections, 'features');

      // heroセクションは「Hero」を含み「Features Heading」を含まない
      expect(containsText(getHeadingTexts(heroSection), 'Hero')).toBe(true);
      expect(notContainsText(getHeadingTexts(heroSection), 'Features Heading')).toBe(true);

      // featuresセクションは「Features」を含み「Hero Heading」を含まない
      expect(containsText(getHeadingTexts(featuresSection), 'Features')).toBe(true);
      expect(notContainsText(getHeadingTexts(featuresSection), 'Hero Heading')).toBe(true);
    });
  });

  describe('extractSectionContent関数の直接テスト', () => {
    it.each([
      { sectionType: 'hero' as const, expected: 'ALPHA', notExpected: ['BETA', 'GAMMA'] },
      { sectionType: 'features' as const, expected: 'BETA', notExpected: ['ALPHA', 'GAMMA'] },
      { sectionType: 'footer' as const, expected: 'GAMMA', notExpected: ['ALPHA', 'BETA'] },
    ])('extractSectionContentは$sectionTypeで$expectedのみ返すべき', ({ sectionType, expected, notExpected }) => {
      const content = extractSectionContent(HTML_SAMPLES.threeDistinct, sectionType);
      const headingTexts = content.headings.map((h) => h.text);

      expect(containsText(headingTexts, expected)).toBe(true);
      notExpected.forEach((ne) => expect(notContainsText(headingTexts, ne)).toBe(true));
    });

    it('同じHTMLに対して異なるセクションタイプで呼び出すと異なる結果を返すべき', () => {
      const heroContent = extractSectionContent(HTML_SAMPLES.twoSection, 'hero');
      const featuresContent = extractSectionContent(HTML_SAMPLES.twoSection, 'features');

      const comparisons = [
        { a: heroContent.headings.map((h) => h.text), b: featuresContent.headings.map((h) => h.text) },
        { a: heroContent.paragraphs, b: featuresContent.paragraphs },
        { a: heroContent.buttons.map((b) => b.text), b: featuresContent.buttons.map((b) => b.text) },
      ];

      comparisons.forEach(({ a, b }) => {
        const same = a.length === b.length && a.every((text, i) => text === b[i]);
        expect(same).toBe(false);
      });
    });
  });

  describe('detectSections関数の直接テスト', () => {
    // パラメータ化テスト: 各セクションのコンテンツ数と内容検証
    it.each([
      { sectionType: 'hero' as const, expected: 'ALPHA' },
      { sectionType: 'features' as const, expected: 'BETA' },
      { sectionType: 'footer' as const, expected: 'GAMMA' },
    ])('$sectionTypeセクションは$expectedのみを含むべき', ({ sectionType, expected }) => {
      const sections = detectSections(HTML_SAMPLES.threeDistinct);
      expect(sections.length).toBeGreaterThanOrEqual(3);

      const section = findSection(sections, sectionType);

      // 見出し
      expect(section?.content.headings.length).toBe(1);
      expect(section?.content.headings[0]?.text).toContain(expected);

      // ボタン
      expect(section?.content.buttons.length).toBe(1);
      expect(section?.content.buttons[0]?.text).toContain(expected);

      // 段落
      expect(section?.content.paragraphs.length).toBe(1);
      expect(section?.content.paragraphs[0]).toContain(expected);
    });
  });

  describe('画像の分離テスト', () => {
    it('featuresセクションの画像はfeaturesセクション内のものだけであるべき', async () => {
      const { sections } = await inspectHtml(HTML_SAMPLES.multiSection);

      const heroSection = findSection(sections, 'hero');
      const featuresSection = findSection(sections, 'features');

      expect(heroSection?.content.images.length).toBe(0);
      expect(featuresSection?.content.images.length).toBe(2);
      expect(featuresSection?.content.images[0]?.src).toBe('/feature1.svg');
      expect(featuresSection?.content.images[1]?.src).toBe('/feature2.svg');
    });
  });

  describe('リンクの分離テスト', () => {
    it('headerセクションのリンクはheader内のものだけであるべき', async () => {
      const { sections } = await inspectHtml(HTML_SAMPLES.multiSection);

      const headerSection = findSection(sections, 'header');
      const footerSection = findSection(sections, 'footer');

      // headerのリンク検証
      expect(headerSection?.content.links.length).toBe(2);
      expect(getLinkHrefs(headerSection).includes('/')).toBe(true);
      expect(getLinkHrefs(headerSection).includes('/products')).toBe(true);
      expect(getLinkHrefs(headerSection).includes('/privacy')).toBe(false);
      expect(getLinkHrefs(headerSection).includes('/terms')).toBe(false);

      // footerのリンク検証
      expect(footerSection?.content.links.length).toBe(2);
      expect(getLinkHrefs(footerSection).includes('/privacy')).toBe(true);
      expect(getLinkHrefs(footerSection).includes('/terms')).toBe(true);
      expect(getLinkHrefs(footerSection).includes('/')).toBe(false);
      expect(getLinkHrefs(footerSection).includes('/products')).toBe(false);
    });
  });
});

// =====================================================
// 追加のエッジケーステスト
// =====================================================

describe('TDD Red Phase: エッジケース', () => {
  beforeEach(setupTest);
  afterEach(cleanupTest);

  it('ネストされたセクション内の要素は親セクションに属するべき', async () => {
    const nestedHtml = `
<section class="hero">
  <div class="container"><h1>Nested Hero Title</h1><div class="cta-wrapper"><button class="cta">Nested Button</button></div></div>
</section>
<section class="features"><h2>Not Nested Title</h2></section>`;

    const { sections } = await inspectHtml(nestedHtml);
    const heroSection = findSection(sections, 'hero');

    expect(containsText(getHeadingTexts(heroSection), 'Nested Hero Title')).toBe(true);
    expect(containsText(getButtonTexts(heroSection), 'Nested Button')).toBe(true);
    expect(notContainsText(getHeadingTexts(heroSection), 'Not Nested Title')).toBe(true);
  });

  it('セクション外の要素は適切に処理されるべき', async () => {
    const mixedHtml = `<h1>Orphan Heading</h1><section class="hero"><h2>Hero Heading</h2></section><p>Orphan Paragraph</p>`;

    const { sections } = await inspectHtml(mixedHtml);
    const heroSection = findSection(sections, 'hero');

    expect(heroSection?.content.headings.length).toBe(1);
    expect(heroSection?.content.headings[0]?.text).toBe('Hero Heading');
    expect(notContainsText(getHeadingTexts(heroSection), 'Orphan Heading')).toBe(true);
    expect(notContainsText(getParagraphs(heroSection), 'Orphan Paragraph')).toBe(true);
  });

  it('空のセクションは空のcontentを持つべき', async () => {
    const emptySection = `<section class="hero"></section><section class="features"><h2>Features</h2></section>`;

    const { sections } = await inspectHtml(emptySection);
    const heroSection = findSection(sections, 'hero');

    expect(heroSection?.content.headings.length).toBe(0);
    expect(heroSection?.content.paragraphs.length).toBe(0);
    expect(heroSection?.content.buttons.length).toBe(0);
    expect(heroSection?.content.links.length).toBe(0);
    expect(heroSection?.content.images.length).toBe(0);
  });
});
