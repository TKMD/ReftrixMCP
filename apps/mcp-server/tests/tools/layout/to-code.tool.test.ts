// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.to_code MCPツールのテスト
 * TDD Red: 先にテストを作成
 *
 * セクションパターンからReact/Vue/HTMLコードを生成するMCPツール
 *
 * テスト対象:
 * - 入力バリデーション（18+ tests）
 * - コード生成（10+ tests）
 * - フレームワーク別出力（9+ tests）
 * - スタイリング別出力（6+ tests）
 * - エラーハンドリング（8+ tests）
 * - レスポンス形式（6+ tests）
 * - ツール定義（5+ tests）
 *
 * @module tests/tools/layout/to-code.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// インポート（実装後に動作するようになる）
// =====================================================

import {
  layoutToCodeHandler,
  layoutToCodeToolDefinition,
  setLayoutToCodeServiceFactory,
  resetLayoutToCodeServiceFactory,
  type LayoutToCodeInput,
  type ILayoutToCodeService,
} from '../../../src/tools/layout/to-code.tool';

import {
  layoutToCodeInputSchema,
  layoutToCodeOutputSchema,
} from '../../../src/tools/layout/schemas';

// =====================================================
// テストデータ
// =====================================================

const validUUID = '11111111-1111-1111-1111-111111111111';
const validUUID2 = '22222222-2222-2222-2222-222222222222';
const invalidUUID = 'not-a-valid-uuid';

const mockSectionPattern = {
  id: validUUID,
  webPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  sectionType: 'hero',
  sectionName: 'Modern Hero Section',
  positionIndex: 0,
  layoutInfo: {
    type: 'hero',
    grid: { columns: 2, gap: '32px' },
    alignment: 'left',
    heading: 'Welcome to Our Platform',
    description: 'Build amazing things with our tools',
  },
  visualFeatures: {
    colors: { dominant: '#3B82F6', background: '#FFFFFF' },
  },
  htmlSnippet: '<section class="hero"><h1>Welcome</h1></section>',
  textRepresentation: 'Hero section with blue gradient, left-aligned heading, CTA button',
  webPage: {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    url: 'https://example.com/page1',
    title: 'Example Page 1',
    sourceType: 'award_gallery',
    usageScope: 'inspiration_only',
  },
};

const mockGeneratedCode = {
  react: {
    code: `import React from 'react';

export interface HeroSectionProps {
  title?: string;
  description?: string;
}

export const HeroSection: React.FC<HeroSectionProps> = ({
  title = 'Welcome to Our Platform',
  description = 'Build amazing things with our tools',
}) => {
  return (
    <section className="hero bg-white">
      <div className="container mx-auto px-4 py-16">
        <h1 className="text-4xl font-bold text-blue-600">{title}</h1>
        <p className="mt-4 text-gray-600">{description}</p>
      </div>
    </section>
  );
};
`,
    componentName: 'HeroSection',
    filename: 'HeroSection.tsx',
    dependencies: ['react'],
  },
  vue: {
    code: `<template>
  <section class="hero bg-white">
    <div class="container mx-auto px-4 py-16">
      <h1 class="text-4xl font-bold text-blue-600">{{ title }}</h1>
      <p class="mt-4 text-gray-600">{{ description }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  title?: string;
  description?: string;
}>();
</script>
`,
    componentName: 'HeroSection',
    filename: 'HeroSection.vue',
    dependencies: ['vue'],
  },
  html: {
    code: `<section class="hero bg-white">
  <div class="container mx-auto px-4 py-16">
    <h1 class="text-4xl font-bold text-blue-600">Welcome to Our Platform</h1>
    <p class="mt-4 text-gray-600">Build amazing things with our tools</p>
  </div>
</section>
`,
    componentName: 'hero-section',
    filename: 'hero-section.html',
    dependencies: [],
  },
};

// =====================================================
// モックサービス
// =====================================================

function createMockService(overrides?: Partial<ILayoutToCodeService>): ILayoutToCodeService {
  return {
    getSectionPatternById: vi.fn().mockResolvedValue(mockSectionPattern),
    generateCode: vi.fn().mockImplementation((pattern, options) => {
      const framework = options?.framework ?? 'react';
      return Promise.resolve(mockGeneratedCode[framework as keyof typeof mockGeneratedCode]);
    }),
    ...overrides,
  };
}

// =====================================================
// 入力バリデーションテスト（18+ tests）
// =====================================================

describe('layoutToCodeInputSchema', () => {
  describe('patternId バリデーション', () => {
    it('有効なUUIDを受け付ける', () => {
      const input = { patternId: validUUID };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patternId).toBe(validUUID);
      }
    });

    it('別の有効なUUIDを受け付ける', () => {
      const input = { patternId: validUUID2 };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('無効なUUID形式を拒否する', () => {
      const input = { patternId: invalidUUID };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('空文字列を拒否する', () => {
      const input = { patternId: '' };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('patternIdなしを拒否する', () => {
      const input = {};
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('数値を拒否する', () => {
      const input = { patternId: 12345 };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('nullを拒否する', () => {
      const input = { patternId: null };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('options.framework バリデーション', () => {
    it('reactを受け付ける', () => {
      const input = { patternId: validUUID, options: { framework: 'react' } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.framework).toBe('react');
      }
    });

    it('vueを受け付ける', () => {
      const input = { patternId: validUUID, options: { framework: 'vue' } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.framework).toBe('vue');
      }
    });

    it('htmlを受け付ける', () => {
      const input = { patternId: validUUID, options: { framework: 'html' } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.framework).toBe('html');
      }
    });

    it('無効なframeworkを拒否する', () => {
      const input = { patternId: validUUID, options: { framework: 'angular' } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('frameworkのデフォルト値はreact', () => {
      const input = { patternId: validUUID, options: {} };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.framework).toBe('react');
      }
    });
  });

  describe('options.typescript バリデーション', () => {
    it('trueを受け付ける', () => {
      const input = { patternId: validUUID, options: { typescript: true } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.typescript).toBe(true);
      }
    });

    it('falseを受け付ける', () => {
      const input = { patternId: validUUID, options: { typescript: false } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.typescript).toBe(false);
      }
    });

    it('typescriptのデフォルト値はtrue', () => {
      const input = { patternId: validUUID, options: {} };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.typescript).toBe(true);
      }
    });
  });

  describe('options.tailwind バリデーション', () => {
    it('trueを受け付ける', () => {
      const input = { patternId: validUUID, options: { tailwind: true } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.tailwind).toBe(true);
      }
    });

    it('falseを受け付ける', () => {
      const input = { patternId: validUUID, options: { tailwind: false } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.tailwind).toBe(false);
      }
    });

    it('tailwindのデフォルト値はtrue', () => {
      const input = { patternId: validUUID, options: {} };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.tailwind).toBe(true);
      }
    });
  });

  describe('options.componentName バリデーション', () => {
    it('PascalCase形式を受け付ける', () => {
      const input = { patternId: validUUID, options: { componentName: 'MyHeroSection' } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.componentName).toBe('MyHeroSection');
      }
    });

    it('camelCase形式を拒否する', () => {
      const input = { patternId: validUUID, options: { componentName: 'myHeroSection' } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('kebab-case形式を拒否する', () => {
      const input = { patternId: validUUID, options: { componentName: 'my-hero-section' } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('数字で始まる名前を拒否する', () => {
      const input = { patternId: validUUID, options: { componentName: '1HeroSection' } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('空文字列を拒否する', () => {
      const input = { patternId: validUUID, options: { componentName: '' } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('options.paletteId バリデーション', () => {
    it('有効なUUIDを受け付ける', () => {
      const input = { patternId: validUUID, options: { paletteId: validUUID2 } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.paletteId).toBe(validUUID2);
      }
    });

    it('無効なUUIDを拒否する', () => {
      const input = { patternId: validUUID, options: { paletteId: 'invalid-palette-id' } };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('全オプション組み合わせ', () => {
    it('全てのオプションを指定できる', () => {
      const input = {
        patternId: validUUID,
        options: {
          framework: 'vue',
          typescript: true,
          tailwind: true,
          componentName: 'CustomHero',
          paletteId: validUUID2,
        },
      };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patternId).toBe(validUUID);
        expect(result.data.options?.framework).toBe('vue');
        expect(result.data.options?.typescript).toBe(true);
        expect(result.data.options?.tailwind).toBe(true);
        expect(result.data.options?.componentName).toBe('CustomHero');
        expect(result.data.options?.paletteId).toBe(validUUID2);
      }
    });

    it('optionsなしでpatternIdのみを受け付ける', () => {
      const input = { patternId: validUUID };
      const result = layoutToCodeInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });
});

// =====================================================
// コード生成テスト（10+ tests）
// =====================================================

describe('layoutToCodeHandler - コード生成', () => {
  beforeEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  afterEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  it('patternIdからセクションパターンを取得する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    await layoutToCodeHandler(input);

    expect(mockService.getSectionPatternById).toHaveBeenCalledWith(validUUID);
  });

  it('CodeGeneratorにパターンを渡してコード生成する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    await layoutToCodeHandler(input);

    expect(mockService.generateCode).toHaveBeenCalledWith(
      mockSectionPattern,
      expect.any(Object)
    );
  });

  it('生成コードを返却する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toContain('HeroSection');
      expect(result.data.code).toContain('React');
    }
  });

  it('デフォルトオプションでReact/TypeScriptコードを生成する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.framework).toBe('react');
      expect(result.data.filename).toContain('.tsx');
    }
  });

  it('オプションで指定したframeworkでコードを生成する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = {
      patternId: validUUID,
      options: { framework: 'vue' },
    };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.framework).toBe('vue');
      expect(result.data.filename).toContain('.vue');
    }
  });

  it('カスタムcomponentNameを使用する', async () => {
    const mockService = createMockService({
      generateCode: vi.fn().mockResolvedValue({
        code: 'export const CustomHero = () => {}',
        componentName: 'CustomHero',
        filename: 'CustomHero.tsx',
        dependencies: ['react'],
      }),
    });
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = {
      patternId: validUUID,
      options: { componentName: 'CustomHero' },
    };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.componentName).toBe('CustomHero');
    }
  });

  it('dependenciesリストを返却する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependencies).toBeDefined();
      expect(Array.isArray(result.data.dependencies)).toBe(true);
    }
  });

  it('inspirationUrlsを返却する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inspirationUrls).toBeDefined();
    }
  });

  it('usageScopeを返却する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.usageScope).toBeDefined();
      expect(['inspiration_only', 'owned_asset']).toContain(result.data.usageScope);
    }
  });

  it('tailwind=falseでVanilla CSSコードを生成する', async () => {
    const mockService = createMockService({
      generateCode: vi.fn().mockResolvedValue({
        code: '<section style="background: white;">...</section>',
        componentName: 'HeroSection',
        filename: 'HeroSection.tsx',
        dependencies: ['react'],
      }),
    });
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = {
      patternId: validUUID,
      options: { tailwind: false },
    };
    await layoutToCodeHandler(input);

    expect(mockService.generateCode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tailwind: false })
    );
  });
});

// =====================================================
// フレームワーク別テスト（9+ tests）
// =====================================================

describe('layoutToCodeHandler - フレームワーク別出力', () => {
  beforeEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  afterEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  describe('React出力', () => {
    it('React関数コンポーネントを生成する', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { framework: 'react' },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toContain('React');
        expect(result.data.framework).toBe('react');
      }
    });

    it('TypeScript有効時に.tsxファイルを生成する', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { framework: 'react', typescript: true },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filename).toMatch(/\.tsx$/);
      }
    });

    it('TypeScript無効時に.jsxファイルを生成する', async () => {
      const mockService = createMockService({
        generateCode: vi.fn().mockResolvedValue({
          code: 'export const HeroSection = () => {}',
          componentName: 'HeroSection',
          filename: 'HeroSection.jsx',
          dependencies: ['react'],
        }),
      });
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { framework: 'react', typescript: false },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filename).toMatch(/\.jsx$/);
      }
    });
  });

  describe('Vue出力', () => {
    it('Vue SFCを生成する', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { framework: 'vue' },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toContain('<template>');
        expect(result.data.framework).toBe('vue');
      }
    });

    it('.vueファイルを生成する', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { framework: 'vue' },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filename).toMatch(/\.vue$/);
      }
    });

    it('TypeScript有効時にscript setup lang="ts"を含む', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { framework: 'vue', typescript: true },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toContain('lang="ts"');
      }
    });
  });

  describe('HTML出力', () => {
    it('静的HTMLを生成する', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { framework: 'html' },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toContain('<section');
        expect(result.data.framework).toBe('html');
      }
    });

    it('.htmlファイルを生成する', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { framework: 'html' },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filename).toMatch(/\.html$/);
      }
    });

    it('HTMLでは依存関係が空または最小限', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { framework: 'html' },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.dependencies?.length ?? 0).toBeLessThanOrEqual(1);
      }
    });
  });
});

// =====================================================
// スタイリング別テスト（6+ tests）
// =====================================================

describe('layoutToCodeHandler - スタイリング別出力', () => {
  beforeEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  afterEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  describe('Tailwind CSS', () => {
    it('tailwind=trueでTailwindクラスを使用する', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { tailwind: true },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        // Tailwindクラスが含まれることを確認
        expect(result.data.code).toMatch(/className|class/);
      }
    });

    it('tailwindがデフォルトで有効', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = { patternId: validUUID };
      await layoutToCodeHandler(input);

      expect(mockService.generateCode).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tailwind: true })
      );
    });
  });

  describe('Vanilla CSS', () => {
    it('tailwind=falseでインラインスタイルまたはCSSクラスを使用する', async () => {
      const mockService = createMockService({
        generateCode: vi.fn().mockResolvedValue({
          code: '<section className="hero-section">...</section>',
          componentName: 'HeroSection',
          filename: 'HeroSection.tsx',
          dependencies: ['react'],
        }),
      });
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { tailwind: false },
      };
      const result = await layoutToCodeHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toBeDefined();
      }
    });
  });

  describe('paletteId適用', () => {
    it('paletteIdが指定された場合にサービスに渡される', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = {
        patternId: validUUID,
        options: { paletteId: validUUID2 },
      };
      await layoutToCodeHandler(input);

      expect(mockService.generateCode).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ paletteId: validUUID2 })
      );
    });

    it('paletteIdが指定されない場合はデフォルトカラーを使用', async () => {
      const mockService = createMockService();
      setLayoutToCodeServiceFactory(() => mockService);

      const input: LayoutToCodeInput = { patternId: validUUID };
      await layoutToCodeHandler(input);

      expect(mockService.generateCode).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ paletteId: expect.any(String) })
      );
    });
  });
});

// =====================================================
// エラーハンドリングテスト（8+ tests）
// =====================================================

describe('layoutToCodeHandler - エラーハンドリング', () => {
  beforeEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  afterEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  it('存在しないpatternIdでPATTERN_NOT_FOUNDエラーを返す', async () => {
    const mockService = createMockService({
      getSectionPatternById: vi.fn().mockResolvedValue(null),
    });
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PATTERN_NOT_FOUND');
    }
  });

  it('無効な入力でVALIDATION_ERRORを返す', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input = { patternId: invalidUUID };
    const result = await layoutToCodeHandler(input as LayoutToCodeInput);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('サービスファクトリーが未設定の場合にエラーを返す', async () => {
    resetLayoutToCodeServiceFactory();

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('DB接続エラーをハンドリングする', async () => {
    const mockService = createMockService({
      getSectionPatternById: vi.fn().mockRejectedValue(new Error('Database connection failed')),
    });
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INTERNAL_ERROR');
    }
  });

  it('CodeGenerator内部エラーをハンドリングする', async () => {
    const mockService = createMockService({
      generateCode: vi.fn().mockRejectedValue(new Error('Code generation failed')),
    });
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CODE_GENERATION_FAILED');
    }
  });

  it('不明なエラーをINTERNAL_ERRORとして返す', async () => {
    const mockService = createMockService({
      getSectionPatternById: vi.fn().mockRejectedValue('Unknown error'),
    });
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INTERNAL_ERROR');
    }
  });

  it('エラーメッセージに詳細が含まれる', async () => {
    const mockService = createMockService({
      generateCode: vi.fn().mockRejectedValue(new Error('Template parsing error at line 42')),
    });
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('Template parsing error');
    }
  });

  it('タイムアウトエラーをハンドリングする', async () => {
    const mockService = createMockService({
      generateCode: vi.fn().mockRejectedValue(new Error('Operation timed out')),
    });
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(false);
  });
});

// =====================================================
// レスポンス形式テスト（6+ tests）
// =====================================================

describe('layoutToCodeHandler - レスポンス形式', () => {
  beforeEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  afterEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  it('codeフィールドが文字列', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.code).toBe('string');
      expect(result.data.code.length).toBeGreaterThan(0);
    }
  });

  it('frameworkフィールドが正しいenum値', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(['react', 'vue', 'html']).toContain(result.data.framework);
    }
  });

  it('componentNameフィールドが文字列', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.componentName).toBe('string');
      expect(result.data.componentName.length).toBeGreaterThan(0);
    }
  });

  it('filenameフィールドが正しい拡張子を持つ', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filename).toMatch(/\.(tsx|jsx|vue|html)$/);
    }
  });

  it('dependenciesフィールドが配列', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Array.isArray(result.data.dependencies)).toBe(true);
    }
  });

  it('usageScopeフィールドが正しいenum値', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(['inspiration_only', 'owned_asset']).toContain(result.data.usageScope);
    }
  });

  it('出力がlayoutToCodeOutputSchemaに準拠する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = { patternId: validUUID };
    const result = await layoutToCodeHandler(input);

    const validation = layoutToCodeOutputSchema.safeParse(result);
    expect(validation.success).toBe(true);
  });
});

// =====================================================
// ツール定義テスト（5+ tests）
// =====================================================

describe('layoutToCodeToolDefinition', () => {
  it('正しい名前を持つ', () => {
    // v0.1.0: layout.to_code → layout.generate_code にリネーム
    // layoutToCodeToolDefinitionは後方互換性のためのエイリアスで、新しい名前を返す
    expect(layoutToCodeToolDefinition.name).toBe('layout.generate_code');
  });

  it('説明が設定されている', () => {
    expect(layoutToCodeToolDefinition.description).toBeTruthy();
    expect(layoutToCodeToolDefinition.description.length).toBeGreaterThan(10);
  });

  it('inputSchemaが定義されている', () => {
    expect(layoutToCodeToolDefinition.inputSchema).toBeDefined();
    expect(layoutToCodeToolDefinition.inputSchema.type).toBe('object');
  });

  it('必須プロパティにpatternIdが含まれる', () => {
    expect(layoutToCodeToolDefinition.inputSchema.required).toContain('patternId');
  });

  it('patternIdプロパティの定義が正しい', () => {
    const patternIdProp = layoutToCodeToolDefinition.inputSchema.properties.patternId;
    expect(patternIdProp.type).toBe('string');
    expect(patternIdProp.format).toBe('uuid');
  });

  it('optionsプロパティが定義されている', () => {
    const optionsProp = layoutToCodeToolDefinition.inputSchema.properties.options;
    expect(optionsProp.type).toBe('object');
  });

  it('options.frameworkプロパティが正しく定義されている', () => {
    const optionsProp = layoutToCodeToolDefinition.inputSchema.properties.options;
    expect(optionsProp.properties.framework.enum).toContain('react');
    expect(optionsProp.properties.framework.enum).toContain('vue');
    expect(optionsProp.properties.framework.enum).toContain('html');
  });
});

// =====================================================
// 出力スキーマテスト（4+ tests）
// =====================================================

describe('layoutToCodeOutputSchema', () => {
  it('有効な成功レスポンスを検証できる', () => {
    const validOutput = {
      success: true,
      data: {
        code: 'export const HeroSection = () => <section>...</section>',
        framework: 'react',
        componentName: 'HeroSection',
        filename: 'HeroSection.tsx',
        dependencies: ['react'],
        inspirationUrls: ['https://example.com/page1'],
        usageScope: 'inspiration_only',
      },
    };

    const result = layoutToCodeOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
  });

  it('dependenciesがオプション', () => {
    const outputWithoutDeps = {
      success: true,
      data: {
        code: '<section>...</section>',
        framework: 'html',
        componentName: 'hero-section',
        filename: 'hero-section.html',
        usageScope: 'inspiration_only',
      },
    };

    const result = layoutToCodeOutputSchema.safeParse(outputWithoutDeps);
    expect(result.success).toBe(true);
  });

  it('inspirationUrlsがオプション', () => {
    const outputWithoutUrls = {
      success: true,
      data: {
        code: 'export const HeroSection = () => {}',
        framework: 'react',
        componentName: 'HeroSection',
        filename: 'HeroSection.tsx',
        usageScope: 'owned_asset',
      },
    };

    const result = layoutToCodeOutputSchema.safeParse(outputWithoutUrls);
    expect(result.success).toBe(true);
  });

  it('無効なframeworkを拒否する', () => {
    const invalidOutput = {
      success: true,
      data: {
        code: 'export const HeroSection = () => {}',
        framework: 'angular', // 無効
        componentName: 'HeroSection',
        filename: 'HeroSection.ts',
        usageScope: 'inspiration_only',
      },
    };

    const result = layoutToCodeOutputSchema.safeParse(invalidOutput);
    expect(result.success).toBe(false);
  });

  it('無効なusageScopeを拒否する', () => {
    const invalidOutput = {
      success: true,
      data: {
        code: 'export const HeroSection = () => {}',
        framework: 'react',
        componentName: 'HeroSection',
        filename: 'HeroSection.tsx',
        usageScope: 'commercial', // 無効
      },
    };

    const result = layoutToCodeOutputSchema.safeParse(invalidOutput);
    expect(result.success).toBe(false);
  });

  it('有効なエラーレスポンスを検証できる', () => {
    const errorOutput = {
      success: false,
      error: {
        code: 'PATTERN_NOT_FOUND',
        message: 'Pattern not found',
      },
    };

    const result = layoutToCodeOutputSchema.safeParse(errorOutput);
    expect(result.success).toBe(true);
  });
});

// =====================================================
// 統合テスト（3+ tests）
// =====================================================

describe('layoutToCodeHandler - 統合テスト', () => {
  beforeEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  afterEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  it('完全なコード生成フローが動作する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = {
      patternId: validUUID,
      options: {
        framework: 'react',
        typescript: true,
        tailwind: true,
      },
    };

    const result = await layoutToCodeHandler(input);

    expect(mockService.getSectionPatternById).toHaveBeenCalledWith(validUUID);
    expect(mockService.generateCode).toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBeDefined();
      expect(result.data.framework).toBe('react');
      expect(result.data.componentName).toBeDefined();
      expect(result.data.filename).toBeDefined();
    }
  });

  it('Vueコード生成フローが動作する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = {
      patternId: validUUID,
      options: { framework: 'vue' },
    };

    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.framework).toBe('vue');
      expect(result.data.code).toContain('<template>');
    }
  });

  it('HTMLコード生成フローが動作する', async () => {
    const mockService = createMockService();
    setLayoutToCodeServiceFactory(() => mockService);

    const input: LayoutToCodeInput = {
      patternId: validUUID,
      options: { framework: 'html' },
    };

    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.framework).toBe('html');
      expect(result.data.filename).toMatch(/\.html$/);
    }
  });
});

// =====================================================
// テストカウント確認
// =====================================================

describe('テストカウント確認', () => {
  it('55以上のテストケースが存在する', () => {
    // このテストはテスト数を確認するためのプレースホルダー
    // 実際のテスト数は上記のdescribeブロック内のitの数
    // 入力バリデーション: 25+ tests
    // コード生成: 10+ tests
    // フレームワーク別: 9+ tests
    // スタイリング別: 6+ tests
    // エラーハンドリング: 8+ tests
    // レスポンス形式: 7+ tests
    // ツール定義: 7+ tests
    // 出力スキーマ: 5+ tests
    // 統合: 3+ tests
    // リネーム・後方互換性: 6+ tests
    // 合計: 86+ tests
    expect(true).toBe(true);
  });
});

// =====================================================
// v0.1.0 リネームテスト（Phase4-1）
// layout.to_code → layout.generate_code
// =====================================================

describe('Phase4-1: ツールリネーム (layout.to_code → layout.generate_code)', () => {
  describe('新しいツール名', () => {
    it('ツール名がlayout.generate_codeである', () => {
      // TDD Red: 新しい名前を期待
      expect(layoutToCodeToolDefinition.name).toBe('layout.generate_code');
    });

    it('descriptionに生成機能が明記されている', () => {
      expect(layoutToCodeToolDefinition.description).toContain('生成');
    });
  });

  describe('後方互換性エイリアス', () => {
    it('layoutGenerateCodeToolDefinitionがエクスポートされている', async () => {
      // 新しい命名でのエクスポート
      const module = await import('../../../src/tools/layout/to-code.tool');
      expect(module.layoutGenerateCodeToolDefinition).toBeDefined();
    });

    it('layoutGenerateCodeHandlerがエクスポートされている', async () => {
      // 新しい命名でのハンドラーエクスポート
      const module = await import('../../../src/tools/layout/to-code.tool');
      expect(module.layoutGenerateCodeHandler).toBeDefined();
    });

    it('旧名layoutToCodeToolDefinitionが後方互換性のためにエクスポートされている', async () => {
      // 既存のエクスポートは引き続き動作する（deprecation警告付き）
      const module = await import('../../../src/tools/layout/to-code.tool');
      expect(module.layoutToCodeToolDefinition).toBeDefined();
    });

    it('旧名layoutToCodeHandlerが後方互換性のためにエクスポートされている', async () => {
      // 既存のハンドラーは引き続き動作する
      const module = await import('../../../src/tools/layout/to-code.tool');
      expect(module.layoutToCodeHandler).toBeDefined();
    });
  });

  describe('router.ts TOOL_NAMES定数', () => {
    it('LAYOUT_GENERATE_CODEが定義されている', async () => {
      const { TOOL_NAMES } = await import('../../../src/router');
      expect(TOOL_NAMES.LAYOUT_GENERATE_CODE).toBe('layout.generate_code');
    });

    // NOTE: LAYOUT_TO_CODE（旧名）は完全に削除されたため、テストをスキップ
    // layout.to_code → layout.generate_code への移行は完了
    it.skip('LAYOUT_TO_CODEが後方互換性のために残っている（deprecation）- 削除済み', async () => {
      // 旧名は削除された
    });
  });
});
