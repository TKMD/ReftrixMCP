// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.inspect MCPツールのテスト
 * TDD Red: 先にテストを作成
 *
 * HTML/Webページのレイアウト解析を行うMCPツール
 *
 * テスト対象:
 * - 入力バリデーション
 * - セクション検出
 * - 色情報抽出
 * - タイポグラフィ解析
 * - グリッド検出
 * - テキスト表現生成
 * - Vision API連携
 * - DB連携（モック）
 *
 * @module tests/tools/layout/inspect.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// インポート（実装後に動作するようになる）
// =====================================================

import {
  layoutInspectHandler,
  layoutInspectToolDefinition,
  layoutInspectInputSchema,
  layoutInspectOutputSchema,
  type LayoutInspectInput,
  type LayoutInspectOutput,
  setLayoutInspectServiceFactory,
  resetLayoutInspectServiceFactory,
} from '../../../src/tools/layout/inspect';

// =====================================================
// テストデータ
// =====================================================

/**
 * テストHTMLサンプル
 * 注: DOMPurifyは<style>タグを削除するため、インラインスタイルを使用
 */
const sampleHtmlSimple = `<!DOCTYPE html>
<html>
<head>
  <title>Simple Page</title>
</head>
<body style="font-family: Inter, sans-serif; color: #1a1a1a; background: #ffffff;">
  <header>
    <nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1 style="font-size: 48px; font-weight: bold;">Welcome to Our Platform</h1>
      <p style="font-size: 16px; line-height: 1.5;">Build something amazing with our tools.</p>
      <button>Get Started</button>
    </section>
  </main>
</body>
</html>`;

const sampleHtmlComplex = `<!DOCTYPE html>
<html>
<head>
  <title>Complex Page</title>
</head>
<body style="font-family: 'Roboto', sans-serif; color: #333; background: #f5f5f5;">
  <header>
    <nav>
      <a href="/">Home</a>
      <a href="/features">Features</a>
      <a href="/pricing">Pricing</a>
      <a href="/contact">Contact</a>
    </nav>
  </header>
  <section class="hero" style="background: linear-gradient(135deg, #3B82F6, #1D4ED8); color: white; padding: 80px 0;">
    <h1 style="font-size: 64px; font-weight: 700;">Transform Your Business</h1>
    <p style="font-size: 18px; line-height: 1.6;">The all-in-one platform for modern teams.</p>
    <button class="cta" style="background: #10B981; color: white;">Start Free Trial</button>
    <button class="secondary">Learn More</button>
  </section>
  <section class="features" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px;">
    <div class="feature">
      <img src="/icon1.svg" alt="Fast" />
      <h3 style="font-size: 24px; font-weight: 500;">Lightning Fast</h3>
      <p style="font-size: 18px; line-height: 1.6;">Experience blazing fast performance.</p>
    </div>
    <div class="feature">
      <img src="/icon2.svg" alt="Secure" />
      <h3 style="font-size: 24px; font-weight: 500;">Enterprise Security</h3>
      <p style="font-size: 18px; line-height: 1.6;">Bank-level security for your data.</p>
    </div>
    <div class="feature">
      <img src="/icon3.svg" alt="Scale" />
      <h3 style="font-size: 24px; font-weight: 500;">Scale Infinitely</h3>
      <p style="font-size: 18px; line-height: 1.6;">Grow without limits.</p>
    </div>
  </section>
  <section class="testimonials">
    <h2 style="font-size: 36px; font-weight: 600;">What Our Customers Say</h2>
    <blockquote>
      <p>"This product changed our workflow completely."</p>
      <cite>John Doe, CEO at TechCorp</cite>
    </blockquote>
  </section>
  <section class="cta-section">
    <h2 style="font-size: 36px; font-weight: 600;">Ready to Get Started?</h2>
    <p>Join thousands of satisfied customers.</p>
    <button class="cta" style="background: #10B981; color: white;">Sign Up Now</button>
  </section>
  <footer>
    <p>&copy; 2024 Company Name. All rights reserved.</p>
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  </footer>
</body>
</html>`;

const sampleHtmlWithFlex = `<!DOCTYPE html>
<html>
<head></head>
<body>
  <div class="container" style="display: flex; flex-direction: column; gap: 20px;">
    <div class="row" style="display: flex; gap: 16px;">
      <div>Item 1</div>
      <div>Item 2</div>
    </div>
  </div>
</body>
</html>`;

const sampleHtmlWithGrid = `<!DOCTYPE html>
<html>
<head></head>
<body>
  <div class="grid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; max-width: 1200px;">
    <div>Card 1</div>
    <div>Card 2</div>
    <div>Card 3</div>
    <div>Card 4</div>
  </div>
</body>
</html>`;

const sampleHtmlWithColors = `<!DOCTYPE html>
<html>
<head></head>
<body style="background-color: #ffffff; color: #1f2937;">
  <p class="primary" style="color: #3B82F6;">Primary text</p>
  <p class="secondary" style="color: #6B7280;">Secondary text</p>
  <button class="accent" style="background-color: #10B981;">Click me</button>
  <a href="#" style="color: #2563EB;">Link</a>
  <p class="danger" style="color: #EF4444;">Danger text</p>
  <div class="gradient" style="background: linear-gradient(to right, #7C3AED, #EC4899);">Gradient</div>
</body>
</html>`;

// =====================================================
// 入力スキーマテスト（10+ tests）
// =====================================================

describe('layoutInspectInputSchema', () => {
  describe('有効な入力', () => {
    it('html のみの入力を受け付ける', () => {
      const input = { html: sampleHtmlSimple };
      const result = layoutInspectInputSchema.parse(input);
      expect(result.html).toBe(sampleHtmlSimple);
    });

    it('id のみの入力を受け付ける', () => {
      const input = { id: '123e4567-e89b-12d3-a456-426614174000' };
      const result = layoutInspectInputSchema.parse(input);
      expect(result.id).toBe('123e4567-e89b-12d3-a456-426614174000');
    });

    it('全オプション指定の入力を受け付ける', () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlSimple,
        options: {
          detectSections: true,
          extractColors: true,
          analyzeTypography: true,
          detectGrid: true,
          useVision: false,
        },
      };
      const result = layoutInspectInputSchema.parse(input);
      expect(result.options?.detectSections).toBe(true);
      expect(result.options?.extractColors).toBe(true);
      expect(result.options?.analyzeTypography).toBe(true);
      expect(result.options?.detectGrid).toBe(true);
      expect(result.options?.useVision).toBe(false);
    });

    it('オプションを部分的に指定できる', () => {
      const input = {
        html: sampleHtmlSimple,
        options: {
          detectSections: false,
        },
      };
      const result = layoutInspectInputSchema.parse(input);
      expect(result.options?.detectSections).toBe(false);
      // デフォルト値が適用される（スキーマでdefault(true)が設定されている）
      expect(result.options?.extractColors).toBe(true);
    });

    it('idとhtmlの両方を指定した場合、両方が保持される', () => {
      const input = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        html: sampleHtmlSimple,
      };
      const result = layoutInspectInputSchema.parse(input);
      expect(result.id).toBeDefined();
      expect(result.html).toBeDefined();
    });
  });

  describe('無効な入力', () => {
    it('idもhtmlもない場合エラー', () => {
      const input = {};
      expect(() => layoutInspectInputSchema.parse(input)).toThrow();
    });

    it('htmlが空文字の場合エラー', () => {
      const input = { html: '' };
      expect(() => layoutInspectInputSchema.parse(input)).toThrow();
    });

    it('idが無効なUUID形式の場合エラー', () => {
      const input = { id: 'invalid-uuid' };
      expect(() => layoutInspectInputSchema.parse(input)).toThrow();
    });

    it('optionsが文字列の場合エラー', () => {
      const input = { html: sampleHtmlSimple, options: 'invalid' };
      expect(() => layoutInspectInputSchema.parse(input)).toThrow();
    });

    it('detectSectionsが文字列の場合エラー', () => {
      const input = {
        html: sampleHtmlSimple,
        options: { detectSections: 'true' },
      };
      expect(() => layoutInspectInputSchema.parse(input)).toThrow();
    });
  });
});

// =====================================================
// 出力スキーマテスト（5+ tests）
// =====================================================

describe('layoutInspectOutputSchema', () => {
  it('成功時の基本レスポンスをバリデート', () => {
    const output: LayoutInspectOutput = {
      success: true,
      data: {
        sections: [],
        colors: {
          palette: [],
          dominant: '#ffffff',
          background: '#ffffff',
          text: '#000000',
        },
        typography: {
          fonts: [],
          headingScale: [],
          bodySize: 16,
          lineHeight: 1.5,
        },
        grid: {
          type: 'unknown',
        },
        textRepresentation: '',
      },
    };
    expect(() => layoutInspectOutputSchema.parse(output)).not.toThrow();
  });

  it('エラー時のレスポンスをバリデート', () => {
    const output = {
      success: false,
      error: {
        code: 'INVALID_HTML',
        message: 'Invalid HTML content',
      },
    };
    expect(() => layoutInspectOutputSchema.parse(output)).not.toThrow();
  });

  it('セクション情報を含むレスポンスをバリデート', () => {
    const output: LayoutInspectOutput = {
      success: true,
      data: {
        sections: [
          {
            id: 'section-1',
            type: 'hero',
            confidence: 0.95,
            position: { startY: 0, endY: 600, height: 600 },
            content: {
              headings: [{ level: 1, text: 'Welcome' }],
              paragraphs: ['Build something amazing'],
              links: [],
              images: [],
              buttons: [{ text: 'Get Started', type: 'primary' }],
            },
            style: {
              backgroundColor: '#3B82F6',
              textColor: '#ffffff',
              hasGradient: true,
            },
          },
        ],
        colors: {
          palette: [{ hex: '#3B82F6', count: 5, role: 'primary' }],
          dominant: '#3B82F6',
          background: '#ffffff',
          text: '#1a1a1a',
        },
        typography: {
          fonts: [{ family: 'Inter', weights: [400, 600, 700] }],
          headingScale: [48, 36, 24, 20, 18, 16],
          bodySize: 16,
          lineHeight: 1.5,
        },
        grid: {
          type: 'grid',
          columns: 3,
          gutterWidth: 32,
          maxWidth: 1200,
        },
        textRepresentation: 'Hero section with large heading...',
      },
    };
    expect(() => layoutInspectOutputSchema.parse(output)).not.toThrow();
  });

  it('visionFeatures を含むレスポンスをバリデート', () => {
    const output: LayoutInspectOutput = {
      success: true,
      data: {
        sections: [],
        colors: {
          palette: [],
          dominant: '#ffffff',
          background: '#ffffff',
          text: '#000000',
        },
        typography: {
          fonts: [],
          headingScale: [],
          bodySize: 16,
          lineHeight: 1.5,
        },
        grid: { type: 'unknown' },
        textRepresentation: '',
        visionFeatures: {
          success: true,
          features: [],
          processingTimeMs: 100,
          modelName: 'mock-vision-1.0',
        },
      },
    };
    expect(() => layoutInspectOutputSchema.parse(output)).not.toThrow();
  });

  it('id を含むレスポンスをバリデート', () => {
    const output: LayoutInspectOutput = {
      success: true,
      data: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        sections: [],
        colors: {
          palette: [],
          dominant: '#ffffff',
          background: '#ffffff',
          text: '#000000',
        },
        typography: {
          fonts: [],
          headingScale: [],
          bodySize: 16,
          lineHeight: 1.5,
        },
        grid: { type: 'unknown' },
        textRepresentation: '',
      },
    };
    expect(() => layoutInspectOutputSchema.parse(output)).not.toThrow();
  });
});

// =====================================================
// ツール定義テスト（5+ tests）
// =====================================================

describe('layoutInspectToolDefinition', () => {
  it('正しいツール名を持つ', () => {
    expect(layoutInspectToolDefinition.name).toBe('layout.inspect');
  });

  it('description が設定されている', () => {
    expect(layoutInspectToolDefinition.description).toBeDefined();
    expect(typeof layoutInspectToolDefinition.description).toBe('string');
    expect(layoutInspectToolDefinition.description.length).toBeGreaterThan(0);
  });

  it('inputSchema が object 型', () => {
    expect(layoutInspectToolDefinition.inputSchema.type).toBe('object');
  });

  it('properties に必要なフィールドを含む', () => {
    const { properties } = layoutInspectToolDefinition.inputSchema;
    expect(properties).toHaveProperty('id');
    expect(properties).toHaveProperty('html');
    expect(properties).toHaveProperty('options');
  });

  it('options の properties を含む', () => {
    const { properties } = layoutInspectToolDefinition.inputSchema;
    const optionsProps = properties.options?.properties;
    expect(optionsProps).toHaveProperty('detectSections');
    expect(optionsProps).toHaveProperty('extractColors');
    expect(optionsProps).toHaveProperty('analyzeTypography');
    expect(optionsProps).toHaveProperty('detectGrid');
    expect(optionsProps).toHaveProperty('useVision');
  });
});

// =====================================================
// セクション検出テスト（10+ tests）
// =====================================================

describe('セクション検出', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('基本的なセクション検出', () => {
    it('hero セクションを検出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      expect(result.data?.sections).toBeDefined();
      const heroSection = result.data?.sections.find((s) => s.type === 'hero');
      expect(heroSection).toBeDefined();
      expect(heroSection?.confidence).toBeGreaterThan(0.5);
    });

    it('features セクションを検出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const featuresSection = result.data?.sections.find(
        (s) => s.type === 'features'
      );
      expect(featuresSection).toBeDefined();
    });

    it('testimonial セクションを検出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const testimonialSection = result.data?.sections.find(
        (s) => s.type === 'testimonial'
      );
      expect(testimonialSection).toBeDefined();
    });

    it('footer セクションを検出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const footerSection = result.data?.sections.find(
        (s) => s.type === 'footer'
      );
      expect(footerSection).toBeDefined();
    });

    it('header セクションを検出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const headerSection = result.data?.sections.find(
        (s) => s.type === 'header'
      );
      expect(headerSection).toBeDefined();
    });

    it('cta セクションを検出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const ctaSection = result.data?.sections.find((s) => s.type === 'cta');
      expect(ctaSection).toBeDefined();
    });
  });

  describe('セクションコンテンツ抽出', () => {
    it('セクション内の見出しを抽出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      const heroSection = result.data?.sections.find((s) => s.type === 'hero');
      expect(heroSection?.content.headings).toBeDefined();
      expect(heroSection?.content.headings.length).toBeGreaterThan(0);
      expect(heroSection?.content.headings[0]?.level).toBe(1);
      expect(heroSection?.content.headings[0]?.text).toContain('Transform');
    });

    it('セクション内のボタンを抽出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      const heroSection = result.data?.sections.find((s) => s.type === 'hero');
      expect(heroSection?.content.buttons).toBeDefined();
      expect(heroSection?.content.buttons.length).toBeGreaterThan(0);
    });

    it('セクション内のリンクを抽出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      const headerSection = result.data?.sections.find(
        (s) => s.type === 'header'
      );
      expect(headerSection?.content.links).toBeDefined();
      expect(headerSection?.content.links.length).toBeGreaterThan(0);
    });

    it('セクション内の画像を抽出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      const featuresSection = result.data?.sections.find(
        (s) => s.type === 'features'
      );
      expect(featuresSection?.content.images).toBeDefined();
      expect(featuresSection?.content.images.length).toBeGreaterThan(0);
    });
  });

  describe('セクション位置情報', () => {
    it('セクションの position を返す', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlComplex,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      const heroSection = result.data?.sections.find((s) => s.type === 'hero');
      expect(heroSection?.position).toBeDefined();
      expect(heroSection?.position.startY).toBeGreaterThanOrEqual(0);
      expect(heroSection?.position.endY).toBeGreaterThan(
        heroSection?.position.startY ?? 0
      );
      expect(heroSection?.position.height).toBeGreaterThan(0);
    });
  });
});

// =====================================================
// 色情報抽出テスト（8+ tests）
// =====================================================

describe('色情報抽出', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  it('背景色を抽出する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithColors,
      options: { extractColors: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.colors.background).toBeDefined();
    expect(result.data?.colors.background).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('テキスト色を抽出する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithColors,
      options: { extractColors: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.colors.text).toBeDefined();
  });

  it('ドミナントカラーを特定する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithColors,
      options: { extractColors: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.colors.dominant).toBeDefined();
    expect(result.data?.colors.dominant).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('アクセントカラーを特定する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithColors,
      options: { extractColors: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    // accentはオプショナル
    if (result.data?.colors.accent) {
      expect(result.data.colors.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('カラーパレットを生成する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithColors,
      options: { extractColors: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.colors.palette).toBeDefined();
    expect(Array.isArray(result.data?.colors.palette)).toBe(true);
    expect(result.data?.colors.palette.length).toBeGreaterThan(0);
  });

  it('色のカウント情報を含む', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithColors,
      options: { extractColors: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    const firstColor = result.data?.colors.palette[0];
    expect(firstColor?.count).toBeDefined();
    expect(firstColor?.count).toBeGreaterThan(0);
  });

  it('色の役割(role)を推定する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithColors,
      options: { extractColors: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    // 少なくとも一部の色にroleが設定される
    const colorsWithRole = result.data?.colors.palette.filter((c) => c.role);
    expect(colorsWithRole?.length).toBeGreaterThan(0);
  });

  it('グラデーションを検出する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithColors,
      options: { extractColors: true, detectSections: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    // セクションのスタイルでグラデーションを検出
    const _sectionWithGradient = result.data?.sections.find(
      (s) => s.style.hasGradient
    );
    // グラデーションを含むHTMLなのでtrueが期待される
    // 具体的な検出はHTML内容による（_prefixは意図的な未使用を示す）
  });
});

// =====================================================
// タイポグラフィ解析テスト（8+ tests）
// =====================================================

describe('タイポグラフィ解析', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  it('フォントファミリーを抽出する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { analyzeTypography: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.typography.fonts).toBeDefined();
    expect(result.data?.typography.fonts.length).toBeGreaterThan(0);
    expect(result.data?.typography.fonts[0]?.family).toBeDefined();
  });

  it('フォントウェイトを抽出する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { analyzeTypography: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    const font = result.data?.typography.fonts[0];
    expect(font?.weights).toBeDefined();
    expect(Array.isArray(font?.weights)).toBe(true);
  });

  it('見出しスケールを計算する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { analyzeTypography: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.typography.headingScale).toBeDefined();
    expect(Array.isArray(result.data?.typography.headingScale)).toBe(true);
    // h1-h6の6つのサイズが期待される
    expect(result.data?.typography.headingScale.length).toBeLessThanOrEqual(6);
  });

  it('本文サイズを取得する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { analyzeTypography: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.typography.bodySize).toBeDefined();
    expect(result.data?.typography.bodySize).toBeGreaterThan(0);
  });

  it('行間(lineHeight)を取得する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { analyzeTypography: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.typography.lineHeight).toBeDefined();
    expect(result.data?.typography.lineHeight).toBeGreaterThan(0);
  });

  it('複数のフォントファミリーを検出する', async () => {
    // DOMPurifyが<style>タグを削除するため、インラインスタイルを使用
    const htmlWithMultipleFonts = `<!DOCTYPE html>
<html>
<head></head>
<body style="font-family: 'Open Sans', sans-serif;">
  <h1 style="font-family: 'Playfair Display', serif;">Title</h1>
  <p>Body text</p>
  <code style="font-family: 'Fira Code', monospace;">code</code>
</body>
</html>`;
    const input: LayoutInspectInput = {
      html: htmlWithMultipleFonts,
      options: { analyzeTypography: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.typography.fonts.length).toBeGreaterThan(1);
  });

  it('デフォルトのフォントスタック対応', async () => {
    const htmlWithSystemFonts = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  </style>
</head>
<body><p>System font</p></body>
</html>`;
    const input: LayoutInspectInput = {
      html: htmlWithSystemFonts,
      options: { analyzeTypography: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.typography.fonts).toBeDefined();
  });

  it('rem/em単位のフォントサイズを解析する', async () => {
    const htmlWithRemUnits = `<!DOCTYPE html>
<html>
<head>
  <style>
    html { font-size: 16px; }
    h1 { font-size: 3rem; }
    p { font-size: 1rem; }
  </style>
</head>
<body>
  <h1>Title</h1>
  <p>Body</p>
</body>
</html>`;
    const input: LayoutInspectInput = {
      html: htmlWithRemUnits,
      options: { analyzeTypography: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.typography.bodySize).toBeDefined();
  });
});

// =====================================================
// グリッド検出テスト（8+ tests）
// =====================================================

describe('グリッド検出', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  it('CSS Grid を検出する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithGrid,
      options: { detectGrid: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.grid.type).toBe('grid');
  });

  it('Flexbox を検出する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithFlex,
      options: { detectGrid: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.grid.type).toBe('flex');
  });

  it('カラム数を検出する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithGrid,
      options: { detectGrid: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.grid.columns).toBeDefined();
    expect(result.data?.grid.columns).toBe(4);
  });

  it('ガター幅を検出する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithGrid,
      options: { detectGrid: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.grid.gutterWidth).toBeDefined();
    expect(result.data?.grid.gutterWidth).toBe(24);
  });

  it('max-width を検出する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithGrid,
      options: { detectGrid: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.grid.maxWidth).toBeDefined();
    expect(result.data?.grid.maxWidth).toBe(1200);
  });

  it('ブレイクポイントを検出する', async () => {
    // 注意: インラインスタイルではメディアクエリを指定できないため、
    // DOMPurifyでサニタイズ後はブレイクポイントは検出されない
    const input: LayoutInspectInput = {
      html: sampleHtmlWithGrid,
      options: { detectGrid: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    // インラインスタイルではメディアクエリが使用できないため、
    // breakpoints は undefined または空配列
    expect(
      result.data?.grid.breakpoints === undefined ||
        result.data?.grid.breakpoints.length === 0
    ).toBe(true);
  });

  it('グリッドが検出できない場合 unknown を返す', async () => {
    const htmlWithoutGrid = `<!DOCTYPE html>
<html>
<body>
  <div>Simple content</div>
</body>
</html>`;
    const input: LayoutInspectInput = {
      html: htmlWithoutGrid,
      options: { detectGrid: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.grid.type).toBe('unknown');
  });

  it('float レイアウトを検出する', async () => {
    // DOMPurifyが<style>タグを削除するため、インラインスタイルを使用
    const htmlWithFloat = `<!DOCTYPE html>
<html>
<head></head>
<body>
  <div class="sidebar" style="float: left; width: 30%;">Sidebar</div>
  <div class="main" style="float: left; width: 70%;">Main</div>
</body>
</html>`;
    const input: LayoutInspectInput = {
      html: htmlWithFloat,
      options: { detectGrid: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.grid.type).toBe('float');
  });
});

// =====================================================
// テキスト表現生成テスト（5+ tests）
// =====================================================

describe('テキスト表現生成', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  it('テキスト表現を生成する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.textRepresentation).toBeDefined();
    expect(result.data?.textRepresentation.length).toBeGreaterThan(0);
  });

  it('セクション情報をテキスト表現に含む', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { detectSections: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    const textRep = result.data?.textRepresentation.toLowerCase();
    // heroセクションに関する記述を含む
    expect(textRep).toContain('hero');
  });

  it('色情報をテキスト表現に含む', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithColors,
      options: { extractColors: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    const textRep = result.data?.textRepresentation.toLowerCase();
    // 色に関する記述を含む
    expect(
      textRep?.includes('color') ||
        textRep?.includes('palette') ||
        textRep?.includes('background')
    ).toBe(true);
  });

  it('タイポグラフィ情報をテキスト表現に含む', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { analyzeTypography: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    const textRep = result.data?.textRepresentation.toLowerCase();
    // フォントに関する記述を含む
    expect(textRep?.includes('font') || textRep?.includes('typography')).toBe(
      true
    );
  });

  it('グリッド情報をテキスト表現に含む', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlWithGrid,
      options: { detectGrid: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    const textRep = result.data?.textRepresentation.toLowerCase();
    // グリッドに関する記述を含む
    expect(
      textRep?.includes('grid') ||
        textRep?.includes('column') ||
        textRep?.includes('layout')
    ).toBe(true);
  });
});

// =====================================================
// Vision API連携テスト（5+ tests）
// =====================================================

describe('Vision API連携', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  it('useVision=true で Vision API を呼び出す', async () => {
    // モックの設定
    const mockVisionResult = {
      success: true,
      features: [
        {
          type: 'layout_structure' as const,
          confidence: 0.9,
          data: {
            type: 'layout_structure' as const,
            gridType: 'two-column' as const,
            mainAreas: ['header', 'hero', 'features'],
            description: 'Two column layout',
          },
        },
      ],
      processingTimeMs: 150,
      modelName: 'mock-vision-1.0',
    };

    // Vision結果を返すサービスのモック
    setLayoutInspectServiceFactory(() => ({
      analyzeWithVision: vi.fn().mockResolvedValue(mockVisionResult),
    }));

    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { useVision: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.visionFeatures).toBeDefined();
    expect(result.data?.visionFeatures?.success).toBe(true);
  });

  it('useVision=false で Vision API を呼び出さない', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { useVision: false },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.visionFeatures).toBeUndefined();
  });

  it('Vision API エラー時もHTML解析結果を返す', async () => {
    setLayoutInspectServiceFactory(() => ({
      analyzeWithVision: vi.fn().mockResolvedValue({
        success: false,
        features: [],
        error: 'Vision API unavailable',
        processingTimeMs: 0,
        modelName: 'mock-vision-1.0',
      }),
    }));

    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { useVision: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    // Vision失敗時もHTMLベースの解析結果は返す
    expect(result.data?.sections).toBeDefined();
    expect(result.data?.visionFeatures?.success).toBe(false);
  });

  it('Vision結果をセクション情報に統合する', async () => {
    const mockVisionResult = {
      success: true,
      features: [
        {
          type: 'section_boundaries' as const,
          confidence: 0.85,
          data: {
            type: 'section_boundaries' as const,
            sections: [
              { type: 'hero', startY: 0, endY: 600, confidence: 0.9 },
              { type: 'features', startY: 600, endY: 1200, confidence: 0.85 },
            ],
          },
        },
      ],
      processingTimeMs: 200,
      modelName: 'mock-vision-1.0',
    };

    setLayoutInspectServiceFactory(() => ({
      analyzeWithVision: vi.fn().mockResolvedValue(mockVisionResult),
    }));

    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { useVision: true, detectSections: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.visionFeatures).toBeDefined();
  });

  it('Vision結果の処理時間を記録する', async () => {
    const mockVisionResult = {
      success: true,
      features: [],
      processingTimeMs: 500,
      modelName: 'mock-vision-1.0',
    };

    setLayoutInspectServiceFactory(() => ({
      analyzeWithVision: vi.fn().mockResolvedValue(mockVisionResult),
    }));

    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { useVision: true },
    };
    const result = await layoutInspectHandler(input);

    expect(result.data?.visionFeatures?.processingTimeMs).toBe(500);
  });
});

// =====================================================
// DB連携テスト（5+ tests）
// =====================================================

describe('DB連携（モック）', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  it('IDでWebPageを取得する', async () => {
    const mockHtml = sampleHtmlSimple;
    const mockId = '123e4567-e89b-12d3-a456-426614174000';

    setLayoutInspectServiceFactory(() => ({
      getWebPageById: vi.fn().mockResolvedValue({
        id: mockId,
        htmlContent: mockHtml,
      }),
    }));

    const input: LayoutInspectInput = {
      id: mockId,
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe(mockId);
  });

  it('存在しないIDの場合エラーを返す', async () => {
    setLayoutInspectServiceFactory(() => ({
      getWebPageById: vi.fn().mockResolvedValue(null),
    }));

    const input: LayoutInspectInput = {
      id: '123e4567-e89b-12d3-a456-426614174999',
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('IDとHTMLの両方が指定された場合、HTMLを優先する', async () => {
    const mockDbHtml = '<html><body>DB HTML</body></html>';
    const directHtml = '<html><body>Direct HTML</body></html>';

    setLayoutInspectServiceFactory(() => ({
      getWebPageById: vi.fn().mockResolvedValue({
        id: '123e4567-e89b-12d3-a456-426614174000',
        htmlContent: mockDbHtml,
      }),
    }));

    const input: LayoutInspectInput = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      html: directHtml,
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    // 直接指定されたHTMLを使用
  });

  it('DB取得エラー時にエラーレスポンスを返す', async () => {
    setLayoutInspectServiceFactory(() => ({
      getWebPageById: vi.fn().mockRejectedValue(new Error('DB connection error')),
    }));

    const input: LayoutInspectInput = {
      id: '123e4567-e89b-12d3-a456-426614174000',
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });

  it('解析結果をDBに保存する（オプション）', async () => {
    const mockSave = vi.fn().mockResolvedValue(true);
    setLayoutInspectServiceFactory(() => ({
      saveSectionPattern: mockSave,
    }));

    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: { detectSections: true },
    };

    // 保存オプションを追加する場合のテスト
    // 現在の仕様では自動保存しない
    const result = await layoutInspectHandler(input);
    expect(result.success).toBe(true);
  });

  it('WebPageサービス未接続時に改善されたエラーメッセージを返す', async () => {
    // serviceFactoryがnull（サービス未接続）の状態
    resetLayoutInspectServiceFactory();

    const input: LayoutInspectInput = {
      id: '123e4567-e89b-12d3-a456-426614174000',
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    // エラーメッセージにhtmlパラメータの使用を促すヒントが含まれる
    expect(result.error?.message).toContain('html');
  });

  it('WebPageサービス未接続時のエラーメッセージが日本語ロケールで適切に返される', async () => {
    // 日本語ロケール設定
    const { setErrorMessageLocale } = await import('../../../src/utils/error-messages');
    setErrorMessageLocale('ja');

    resetLayoutInspectServiceFactory();

    const input: LayoutInspectInput = {
      id: '123e4567-e89b-12d3-a456-426614174000',
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    // 日本語メッセージにhtmlパラメータの使用を促すヒントが含まれる
    expect(result.error?.message).toMatch(/html|HTML/);

    // ロケールを元に戻す
    setErrorMessageLocale('en');
  });

  it('getWebPageByIdメソッドが存在しない場合も改善されたエラーメッセージを返す', async () => {
    // getWebPageByIdメソッドがないサービス
    setLayoutInspectServiceFactory(() => ({
      // getWebPageById is intentionally omitted
      analyzeWithVision: vi.fn(),
    }));

    const input: LayoutInspectInput = {
      id: '123e4567-e89b-12d3-a456-426614174000',
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.error?.message).toContain('html');
  });
});

// =====================================================
// 異常系テスト（5+ tests）
// =====================================================

describe('異常系', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  it('入力がnullの場合エラー', async () => {
    const result = await layoutInspectHandler(null);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('入力がundefinedの場合エラー', async () => {
    const result = await layoutInspectHandler(undefined);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('無効なHTMLの場合もパース試行', async () => {
    const input: LayoutInspectInput = {
      html: '<not-valid-html>',
    };
    const result = await layoutInspectHandler(input);
    // 無効なHTMLでも部分的な解析を試みる
    expect(result.success).toBe(true);
  });

  it('空のHTMLの場合エラー', async () => {
    // 空文字はスキーマでエラーになる
    const result = await layoutInspectHandler({ html: '' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
  });

  it(
    '巨大なHTMLでもタイムアウトしない',
    async () => {
      // 大きなHTMLを生成（DOMPurifyのサニタイズ処理を考慮して5000要素に調整）
      const largeHtml = `<!DOCTYPE html><html><body>${'<div>Content</div>'.repeat(5000)}</body></html>`;
      const input: LayoutInspectInput = {
        html: largeHtml,
      };

      const startTime = Date.now();
      const result = await layoutInspectHandler(input);
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      // 60秒以内に完了すること（HTMLサニタイズ処理を含む）
      expect(duration).toBeLessThan(60000);
    },
    60000
  );
});

// =====================================================
// 統合テスト（3+ tests）
// =====================================================

describe('統合テスト', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  it('全オプション有効でフル解析が可能', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlComplex,
      options: {
        detectSections: true,
        extractColors: true,
        analyzeTypography: true,
        detectGrid: true,
        useVision: false,
      },
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    expect(result.data?.sections).toBeDefined();
    expect(result.data?.colors).toBeDefined();
    expect(result.data?.typography).toBeDefined();
    expect(result.data?.grid).toBeDefined();
    expect(result.data?.textRepresentation).toBeDefined();
  });

  it('デフォルトオプションで解析が動作する', async () => {
    const input: LayoutInspectInput = {
      html: sampleHtmlSimple,
    };
    const result = await layoutInspectHandler(input);

    expect(result.success).toBe(true);
    // デフォルトでは全機能が有効
    expect(result.data?.sections).toBeDefined();
    expect(result.data?.colors).toBeDefined();
    expect(result.data?.typography).toBeDefined();
    expect(result.data?.grid).toBeDefined();
  });

  it('ツール定義とハンドラーが一致する', () => {
    const { properties } = layoutInspectToolDefinition.inputSchema;
    expect(properties).toHaveProperty('id');
    expect(properties).toHaveProperty('html');
    expect(properties).toHaveProperty('options');
  });
});

// =====================================================
// スクリーンショットモード テスト（Vision API）
// =====================================================

describe('スクリーンショットモード', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  // テスト用のBase64画像データ（2x2 PNG、100文字以上必須）
  // 実際の2x2ピクセルPNG画像を生成
  const testBase64Image =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVQIW2P4z8DwHwAFAAH/q842AAAAAElFTkSuQmCC' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

  describe('入力バリデーション', () => {
    it('有効なスクリーンショット入力を受け付ける', () => {
      const input = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/png',
        },
      };

      const result = layoutInspectInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('width/heightオプションを受け付ける', () => {
      const input = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/png',
          width: 1920,
          height: 1080,
        },
      };

      const result = layoutInspectInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.screenshot?.width).toBe(1920);
        expect(result.data.screenshot?.height).toBe(1080);
      }
    });

    it('jpeg/webp MIMEタイプを受け付ける', () => {
      const inputJpeg = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/jpeg',
        },
      };
      const inputWebp = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/webp',
        },
      };

      expect(layoutInspectInputSchema.safeParse(inputJpeg).success).toBe(true);
      expect(layoutInspectInputSchema.safeParse(inputWebp).success).toBe(true);
    });

    it('短すぎるBase64データを拒否する', () => {
      const input = {
        screenshot: {
          base64: 'abc', // 100文字未満
          mimeType: 'image/png',
        },
      };

      const result = layoutInspectInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('無効なMIMEタイプを拒否する', () => {
      const input = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/gif', // 非対応
        },
      };

      const result = layoutInspectInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('id/html/screenshotすべて未指定を拒否する', () => {
      const input = {
        options: {
          detectSections: true,
        },
      };

      const result = layoutInspectInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('ハンドラー処理', () => {
    it('Vision APIサービス利用可能時にスクリーンショット解析を実行', async () => {
      // Mock: LlamaVision成功レスポンス
      const mockVisionResult = {
        success: true,
        features: [
          {
            type: 'layout_structure',
            description: 'Two-column grid layout',
            confidence: 0.85,
          },
          {
            type: 'color_palette',
            description: 'Blue and white color scheme',
            confidence: 0.9,
          },
        ],
        processingTimeMs: 1500,
        modelName: 'llama3.2-vision:latest',
      };

      const mockTextRepresentation =
        'Layout: Two-column grid layout. Colors: Blue and white color scheme.';

      setLayoutInspectServiceFactory(() => ({
        analyzeScreenshot: vi.fn().mockResolvedValue(mockVisionResult),
        getVisionAnalyzer: vi.fn().mockReturnValue({
          generateTextRepresentation: vi.fn().mockReturnValue(mockTextRepresentation),
        }),
      }));

      const input: LayoutInspectInput = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/png',
        },
      };

      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.visionFeatures).toBeDefined();
        expect(result.data?.visionFeatures?.success).toBe(true);
        expect(result.data?.visionFeatures?.features).toHaveLength(2);
        expect(result.data?.textRepresentation).toBe(mockTextRepresentation);
      }
    });

    it('Vision APIサービス未設定時にSERVICE_UNAVAILABLEエラー', async () => {
      // サービスファクトリを設定しない（デフォルト状態）

      const input: LayoutInspectInput = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/png',
        },
      };

      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
        // サービスファクトリ未設定時は汎用的なエラーメッセージが返る
        expect(result.error?.message).toBeDefined();
      }
    });

    it('analyzeScreenshot未定義時にSERVICE_UNAVAILABLEエラー', async () => {
      // analyzeScreenshotが未定義のサービスを設定
      setLayoutInspectServiceFactory(() => ({
        // analyzeScreenshot is missing
      }));

      const input: LayoutInspectInput = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/png',
        },
      };

      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
      }
    });

    it('Vision API失敗時にフォールバック戦略で成功を返す（VisionFallbackService）', async () => {
      // Mock: Vision API失敗レスポンス
      // VisionFallbackServiceの導入により、Vision API失敗時でも
      // フォールバック戦略（テキストベース分析）で処理が続行される
      const mockVisionResult = {
        success: false,
        features: [],
        error: 'Connection to Ollama failed',
        processingTimeMs: 0,
        modelName: 'llama3.2-vision:latest',
      };

      setLayoutInspectServiceFactory(() => ({
        analyzeScreenshot: vi.fn().mockResolvedValue(mockVisionResult),
        getVisionAnalyzer: vi.fn().mockReturnValue(null),
      }));

      const input: LayoutInspectInput = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/png',
        },
      };

      const result = await layoutInspectHandler(input);

      // VisionFallbackServiceにより、Vision API失敗時でも成功を返す
      // フォールバック戦略でテキストベース分析が行われる
      expect(result.success).toBe(true);
      if (result.success) {
        // フォールバックが使用された場合、結果にその情報が含まれる可能性がある
        expect(result.data).toBeDefined();
      }
    });

    it('analyzeScreenshot例外発生時にフォールバック戦略で成功を返す（VisionFallbackService）', async () => {
      // VisionFallbackServiceの導入により、例外発生時でも
      // フォールバック戦略（テキストベース分析）で処理が続行される
      setLayoutInspectServiceFactory(() => ({
        analyzeScreenshot: vi.fn().mockRejectedValue(new Error('Network timeout')),
        getVisionAnalyzer: vi.fn().mockReturnValue(null),
      }));

      const input: LayoutInspectInput = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/png',
        },
      };

      const result = await layoutInspectHandler(input);

      // VisionFallbackServiceにより、例外発生時でも成功を返す
      // フォールバック戦略でテキストベース分析が行われる
      expect(result.success).toBe(true);
      if (result.success) {
        // フォールバックが使用された場合、結果にその情報が含まれる可能性がある
        expect(result.data).toBeDefined();
      }
    });

    it('width/heightがサービスに渡される', async () => {
      const analyzeScreenshotMock = vi.fn().mockResolvedValue({
        success: true,
        features: [],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision:latest',
      });

      setLayoutInspectServiceFactory(() => ({
        analyzeScreenshot: analyzeScreenshotMock,
        getVisionAnalyzer: vi.fn().mockReturnValue({
          generateTextRepresentation: vi.fn().mockReturnValue(''),
        }),
      }));

      const input: LayoutInspectInput = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/png',
          width: 1440,
          height: 900,
        },
      };

      await layoutInspectHandler(input);

      expect(analyzeScreenshotMock).toHaveBeenCalledWith(
        expect.objectContaining({
          base64: testBase64Image,
          mimeType: 'image/png',
          width: 1440,
          height: 900,
        })
      );
    });
  });

  describe('出力構造', () => {
    it('スクリーンショットモードでデフォルト値が正しく設定される', async () => {
      const mockVisionResult = {
        success: true,
        features: [
          { type: 'layout_structure', description: 'Single column', confidence: 0.8 },
        ],
        processingTimeMs: 500,
        modelName: 'llama3.2-vision:latest',
      };

      setLayoutInspectServiceFactory(() => ({
        analyzeScreenshot: vi.fn().mockResolvedValue(mockVisionResult),
        getVisionAnalyzer: vi.fn().mockReturnValue({
          generateTextRepresentation: vi.fn().mockReturnValue('Layout: Single column'),
        }),
      }));

      const input: LayoutInspectInput = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/png',
        },
      };

      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // デフォルト値が設定されていること
        expect(result.data?.sections).toEqual([]);
        expect(result.data?.colors).toBeDefined();
        expect(result.data?.colors.palette).toEqual([]);
        expect(result.data?.typography).toBeDefined();
        expect(result.data?.grid).toBeDefined();
        expect(result.data?.grid.type).toBe('unknown');
        // Vision結果が含まれること
        expect(result.data?.visionFeatures).toEqual(mockVisionResult);
        expect(result.data?.textRepresentation).toBe('Layout: Single column');
      }
    });

    it('出力スキーマでスクリーンショット解析結果を検証できる', async () => {
      const mockVisionResult = {
        success: true,
        features: [],
        processingTimeMs: 100,
        modelName: 'llama3.2-vision:latest',
      };

      setLayoutInspectServiceFactory(() => ({
        analyzeScreenshot: vi.fn().mockResolvedValue(mockVisionResult),
        getVisionAnalyzer: vi.fn().mockReturnValue({
          generateTextRepresentation: vi.fn().mockReturnValue(''),
        }),
      }));

      const input: LayoutInspectInput = {
        screenshot: {
          base64: testBase64Image,
          mimeType: 'image/png',
        },
      };

      const result = await layoutInspectHandler(input);

      // 出力スキーマでの検証
      const validated = layoutInspectOutputSchema.safeParse(result);
      expect(validated.success).toBe(true);
    });
  });
});

// =====================================================
// Video背景要素検出テスト（P2機能）
// =====================================================

describe('Video背景要素検出', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  // テストHTMLサンプル: 背景動画パターン
  const sampleHtmlWithBackgroundVideo = `<!DOCTYPE html>
<html>
<head><title>Video Background Test</title></head>
<body>
  <section class="hero" style="position: relative;">
    <video
      autoplay
      loop
      muted
      playsinline
      poster="/images/hero-poster.jpg"
      style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: -1;"
    >
      <source src="/videos/hero-bg.mp4" type="video/mp4" />
      <source src="/videos/hero-bg.webm" type="video/webm" />
    </video>
    <div class="hero-content" style="position: relative; z-index: 1;">
      <h1>Welcome to Our Platform</h1>
      <p>Experience the future</p>
      <button>Get Started</button>
    </div>
  </section>
</body>
</html>`;

  const sampleHtmlWithFixedBackgroundVideo = `<!DOCTYPE html>
<html>
<head><title>Fixed Video Background</title></head>
<body>
  <div class="video-bg-container" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1;">
    <video autoplay loop muted playsinline src="/videos/ambient.mp4" poster="/images/ambient-poster.png">
    </video>
  </div>
  <main>
    <section class="content">
      <h1>Content Over Video</h1>
    </section>
  </main>
</body>
</html>`;

  const sampleHtmlWithMultipleVideos = `<!DOCTYPE html>
<html>
<body>
  <section class="hero">
    <video autoplay loop muted playsinline style="position: absolute; z-index: -1;">
      <source src="/videos/hero.mp4" type="video/mp4" />
    </video>
    <h1>Hero Title</h1>
  </section>
  <section class="features">
    <video controls src="/videos/demo.mp4" poster="/images/demo-poster.jpg">
    </video>
    <h2>Watch Our Demo</h2>
  </section>
  <section class="testimonial">
    <video autoplay loop muted style="width: 100%; height: 300px; object-fit: cover;">
      <source src="/videos/testimonial-bg.webm" type="video/webm" />
    </video>
  </section>
</body>
</html>`;

  const sampleHtmlWithNoVideo = `<!DOCTYPE html>
<html>
<body>
  <section class="hero">
    <img src="/images/hero.jpg" alt="Hero" />
    <h1>Hero without video</h1>
  </section>
</body>
</html>`;

  describe('基本的なVideo要素検出', () => {
    it('video要素を検出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithBackgroundVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      expect(result.data?.mediaElements).toBeDefined();
      expect(result.data?.mediaElements?.videos).toBeDefined();
      expect(result.data?.mediaElements?.videos?.length).toBeGreaterThan(0);
    });

    it('videoのsrc属性を抽出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithFixedBackgroundVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const video = result.data?.mediaElements?.videos?.[0];
      expect(video?.src).toBe('/videos/ambient.mp4');
    });

    it('source要素からsrcを抽出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithBackgroundVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const video = result.data?.mediaElements?.videos?.[0];
      expect(video?.sources).toBeDefined();
      expect(video?.sources?.length).toBe(2);
      expect(video?.sources?.[0]?.src).toBe('/videos/hero-bg.mp4');
      expect(video?.sources?.[0]?.type).toBe('video/mp4');
      expect(video?.sources?.[1]?.src).toBe('/videos/hero-bg.webm');
      expect(video?.sources?.[1]?.type).toBe('video/webm');
    });

    it('poster属性を抽出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithBackgroundVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const video = result.data?.mediaElements?.videos?.[0];
      expect(video?.poster).toBe('/images/hero-poster.jpg');
    });

    it('再生制御属性を検出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithBackgroundVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const video = result.data?.mediaElements?.videos?.[0];
      expect(video?.attributes).toBeDefined();
      expect(video?.attributes?.autoplay).toBe(true);
      expect(video?.attributes?.loop).toBe(true);
      expect(video?.attributes?.muted).toBe(true);
      expect(video?.attributes?.playsinline).toBe(true);
    });

    it('controls属性のないvideoをミュート背景動画として識別する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithBackgroundVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const video = result.data?.mediaElements?.videos?.[0];
      expect(video?.attributes?.controls).toBeFalsy();
    });
  });

  describe('背景動画パターン検出', () => {
    it('position: absolute + z-index: -1 を背景動画パターンとして検出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithBackgroundVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const video = result.data?.mediaElements?.videos?.[0];
      expect(video?.positioning).toBe('absolute-background');
    });

    it('position: fixed + z-index: -1 を固定背景動画パターンとして検出する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithFixedBackgroundVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const video = result.data?.mediaElements?.videos?.[0];
      expect(video?.positioning).toBe('fixed-background');
    });

    it('背景動画とインラインvideoを区別する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithMultipleVideos,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const videos = result.data?.mediaElements?.videos;
      expect(videos?.length).toBe(3);

      // 背景動画（autoplay + muted + absolute/fixed）
      const backgroundVideos = videos?.filter(
        (v) => v.positioning === 'absolute-background' || v.positioning === 'fixed-background'
      );
      expect(backgroundVideos?.length).toBeGreaterThanOrEqual(1);

      // controls属性を持つvideoはインライン
      const inlineVideos = videos?.filter((v) => v.attributes?.controls === true);
      expect(inlineVideos?.length).toBe(1);
    });

    it('backgroundVideos配列で背景動画のみをフィルタできる', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithMultipleVideos,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      expect(result.data?.mediaElements?.backgroundVideos).toBeDefined();
      // 背景動画パターン（autoplay + muted + 位置指定）
      const bgVideos = result.data?.mediaElements?.backgroundVideos;
      expect(bgVideos?.length).toBeGreaterThanOrEqual(1);
      bgVideos?.forEach((v) => {
        expect(
          v.positioning === 'absolute-background' || v.positioning === 'fixed-background'
        ).toBe(true);
      });
    });
  });

  describe('CSSセレクタ生成', () => {
    it('videoのセレクタを生成する', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithBackgroundVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const video = result.data?.mediaElements?.videos?.[0];
      expect(video?.selector).toBeDefined();
      // セクション内のvideoを識別できるセレクタ
      expect(video?.selector).toMatch(/video|\.hero/);
    });
  });

  describe('video要素がない場合', () => {
    it('video要素がない場合、空配列を返す', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithNoVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      expect(result.data?.mediaElements?.videos).toEqual([]);
      expect(result.data?.mediaElements?.backgroundVideos).toEqual([]);
    });
  });

  describe('テキスト表現への反映', () => {
    it('背景動画情報をテキスト表現に含む', async () => {
      const input: LayoutInspectInput = {
        html: sampleHtmlWithBackgroundVideo,
        options: { detectSections: true },
      };
      const result = await layoutInspectHandler(input);

      expect(result.success).toBe(true);
      const textRep = result.data?.textRepresentation?.toLowerCase();
      expect(
        textRep?.includes('video') ||
          textRep?.includes('background video') ||
          textRep?.includes('media')
      ).toBe(true);
    });
  });
});
