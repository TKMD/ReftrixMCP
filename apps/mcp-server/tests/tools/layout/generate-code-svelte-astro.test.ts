// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.generate_code Svelte/Astro拡張テスト
 * T2-COD: Multi-framework code generation (React/Vue/Svelte/Astro)
 *
 * TDD Red: テストを先に作成
 *
 * テスト対象:
 * - Zodスキーマ: frameworkSchemaに'svelte'/'astro'が追加されていること
 * - Svelte (.svelte) コンポーネント生成
 * - Astro (.astro) コンポーネント生成
 * - ファイル名・拡張子の正しさ
 * - 依存関係の正しさ
 * - Tailwind CSS / Vanilla CSS 対応
 * - セキュリティ: コードインジェクション防止
 * - JSON Schema (ツール定義) の整合性
 *
 * @module tests/tools/layout/generate-code-svelte-astro.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  layoutToCodeHandler,
  layoutGenerateCodeToolDefinition,
  setLayoutToCodeServiceFactory,
  resetLayoutToCodeServiceFactory,
  type ILayoutToCodeService,
  type SectionPattern,
  type GeneratedCode,
} from "../../../src/tools/layout/to-code.tool";

import {
  frameworkSchema,
  layoutToCodeInputSchema,
  layoutToCodeDataSchema,
} from "../../../src/tools/layout/schemas";

import {
  LayoutToCodeService,
  resetLayoutToCodePrismaClientFactory,
  resetLayoutToCodeService,
} from "../../../src/services/layout-to-code.service";

import type { CodeGeneratorOptions } from "../../../src/tools/layout/to-code.tool";

// =====================================================
// テストデータ
// =====================================================

const validUUID = "11111111-1111-1111-1111-111111111111";

const mockSectionPattern: SectionPattern = {
  id: validUUID,
  webPageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  sectionType: "hero",
  sectionName: "Modern Hero Section",
  positionIndex: 0,
  layoutInfo: {
    type: "hero",
    grid: { columns: 2, gap: "32px" },
    alignment: "left",
    heading: "Welcome to Our Platform",
    description: "Build amazing things with our tools",
  },
  visualFeatures: {
    colors: { dominant: "#3B82F6", background: "#FFFFFF" },
  },
  htmlSnippet: '<section class="hero"><h1>Welcome</h1><p>Description here</p></section>',
  textRepresentation: "Hero section with heading and description",
  webPage: {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    url: "https://example.com/page1",
    title: "Example Page 1",
    sourceType: "award_gallery",
    usageScope: "inspiration_only",
  },
};

// =====================================================
// Zodスキーマテスト: frameworkSchemaの拡張
// =====================================================

describe("frameworkSchema - Svelte/Astro拡張", () => {
  it("'svelte'を受け付ける", () => {
    const result = frameworkSchema.safeParse("svelte");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("svelte");
    }
  });

  it("'astro'を受け付ける", () => {
    const result = frameworkSchema.safeParse("astro");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("astro");
    }
  });

  it("既存の'react'/'vue'/'html'は引き続き受け付ける", () => {
    expect(frameworkSchema.safeParse("react").success).toBe(true);
    expect(frameworkSchema.safeParse("vue").success).toBe(true);
    expect(frameworkSchema.safeParse("html").success).toBe(true);
  });

  it("無効なフレームワーク名を拒否する", () => {
    expect(frameworkSchema.safeParse("angular").success).toBe(false);
    expect(frameworkSchema.safeParse("solid").success).toBe(false);
    expect(frameworkSchema.safeParse("").success).toBe(false);
  });
});

// =====================================================
// layoutToCodeInputSchemaテスト: Svelte/Astro入力バリデーション
// =====================================================

describe("layoutToCodeInputSchema - Svelte/Astro入力バリデーション", () => {
  it("options.framework='svelte'を受け付ける", () => {
    const input = { patternId: validUUID, options: { framework: "svelte" } };
    const result = layoutToCodeInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options?.framework).toBe("svelte");
    }
  });

  it("options.framework='astro'を受け付ける", () => {
    const input = { patternId: validUUID, options: { framework: "astro" } };
    const result = layoutToCodeInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options?.framework).toBe("astro");
    }
  });
});

// =====================================================
// layoutToCodeDataSchemaテスト: 出力スキーマ
// =====================================================

describe("layoutToCodeDataSchema - Svelte/Astro出力バリデーション", () => {
  it("framework='svelte'を含む出力データを受け付ける", () => {
    const data = {
      code: "<script>let name = 'World';</script>\n<h1>Hello {name}!</h1>",
      framework: "svelte",
      componentName: "HeroSection",
      filename: "HeroSection.svelte",
      dependencies: ["svelte"],
      usageScope: "inspiration_only",
    };
    const result = layoutToCodeDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("framework='astro'を含む出力データを受け付ける", () => {
    const data = {
      code: "---\n// Astro component\n---\n<section><h1>Hello</h1></section>",
      framework: "astro",
      componentName: "HeroSection",
      filename: "HeroSection.astro",
      dependencies: ["astro"],
      usageScope: "inspiration_only",
    };
    const result = layoutToCodeDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

// =====================================================
// LayoutToCodeService: Svelteコード生成テスト
// =====================================================

describe("LayoutToCodeService - Svelteコード生成", () => {
  let service: LayoutToCodeService;

  beforeEach(() => {
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
    service = new LayoutToCodeService();
  });

  afterEach(() => {
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
  });

  it("Svelteコンポーネントを生成する（TypeScript + Tailwind）", async () => {
    const options: CodeGeneratorOptions = {
      framework: "svelte",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(mockSectionPattern, options);

    expect(result.componentName).toBe("HeroSection");
    expect(result.filename).toBe("HeroSection.svelte");
    expect(result.dependencies).toContain("svelte");
    // Svelteコンポーネントの構造チェック
    expect(result.code).toContain("<script");
    expect(result.code).toContain("</script>");
    // lang="ts" for TypeScript
    expect(result.code).toContain('lang="ts"');
  });

  it("Svelteコンポーネントを生成する（JavaScript + Tailwind）", async () => {
    const options: CodeGeneratorOptions = {
      framework: "svelte",
      typescript: false,
      tailwind: true,
    };

    const result = await service.generateCode(mockSectionPattern, options);

    expect(result.filename).toBe("HeroSection.svelte");
    // lang="ts"がないことを確認
    expect(result.code).not.toContain('lang="ts"');
    expect(result.code).toContain("<script>");
  });

  it("Svelteコンポーネントを生成する（Vanilla CSS）", async () => {
    const options: CodeGeneratorOptions = {
      framework: "svelte",
      typescript: true,
      tailwind: false,
    };

    const result = await service.generateCode(mockSectionPattern, options);

    expect(result.filename).toBe("HeroSection.svelte");
    // <style>セクションがあること
    expect(result.code).toContain("<style>");
  });

  it("SvelteコンポーネントにhtmlSnippetが適用される", async () => {
    const patternWithHtml: SectionPattern = {
      ...mockSectionPattern,
      htmlSnippet: '<section class="hero"><h1>Custom Heading</h1></section>',
    };
    const options: CodeGeneratorOptions = {
      framework: "svelte",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(patternWithHtml, options);

    // 変換されたHTMLコンテンツを含む
    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThan(0);
  });

  it("カスタムコンポーネント名でSvelteコンポーネントを生成する", async () => {
    const options: CodeGeneratorOptions = {
      framework: "svelte",
      typescript: true,
      tailwind: true,
      componentName: "CustomHero",
    };

    const result = await service.generateCode(mockSectionPattern, options);

    expect(result.componentName).toBe("CustomHero");
    expect(result.filename).toBe("CustomHero.svelte");
  });

  it("htmlSnippetなしの場合はlayoutInfoからSvelteコンポーネントを生成する", async () => {
    const patternNoHtml: SectionPattern = {
      ...mockSectionPattern,
      htmlSnippet: undefined,
    };
    const options: CodeGeneratorOptions = {
      framework: "svelte",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(patternNoHtml, options);

    expect(result.code).toContain("Welcome to Our Platform");
    expect(result.code).toContain("<script");
  });
});

// =====================================================
// LayoutToCodeService: Astroコード生成テスト
// =====================================================

describe("LayoutToCodeService - Astroコード生成", () => {
  let service: LayoutToCodeService;

  beforeEach(() => {
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
    service = new LayoutToCodeService();
  });

  afterEach(() => {
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
  });

  it("Astroコンポーネントを生成する（TypeScript + Tailwind）", async () => {
    const options: CodeGeneratorOptions = {
      framework: "astro",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(mockSectionPattern, options);

    expect(result.componentName).toBe("HeroSection");
    expect(result.filename).toBe("HeroSection.astro");
    expect(result.dependencies).toContain("astro");
    // Astroコンポーネントの構造チェック: フロントマター（---）
    expect(result.code).toContain("---");
  });

  it("Astroコンポーネントを生成する（JavaScript + Tailwind）", async () => {
    const options: CodeGeneratorOptions = {
      framework: "astro",
      typescript: false,
      tailwind: true,
    };

    const result = await service.generateCode(mockSectionPattern, options);

    expect(result.filename).toBe("HeroSection.astro");
    // フロントマターがある
    expect(result.code).toContain("---");
  });

  it("Astroコンポーネントを生成する（Vanilla CSS）", async () => {
    const options: CodeGeneratorOptions = {
      framework: "astro",
      typescript: true,
      tailwind: false,
    };

    const result = await service.generateCode(mockSectionPattern, options);

    expect(result.filename).toBe("HeroSection.astro");
    // <style>セクションがあること
    expect(result.code).toContain("<style>");
  });

  it("AstroコンポーネントにhtmlSnippetが適用される", async () => {
    const patternWithHtml: SectionPattern = {
      ...mockSectionPattern,
      htmlSnippet: '<section class="hero"><h1>Custom Heading</h1></section>',
    };
    const options: CodeGeneratorOptions = {
      framework: "astro",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(patternWithHtml, options);

    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThan(0);
  });

  it("カスタムコンポーネント名でAstroコンポーネントを生成する", async () => {
    const options: CodeGeneratorOptions = {
      framework: "astro",
      typescript: true,
      tailwind: true,
      componentName: "CustomHero",
    };

    const result = await service.generateCode(mockSectionPattern, options);

    expect(result.componentName).toBe("CustomHero");
    expect(result.filename).toBe("CustomHero.astro");
  });

  it("htmlSnippetなしの場合はlayoutInfoからAstroコンポーネントを生成する", async () => {
    const patternNoHtml: SectionPattern = {
      ...mockSectionPattern,
      htmlSnippet: undefined,
    };
    const options: CodeGeneratorOptions = {
      framework: "astro",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(patternNoHtml, options);

    expect(result.code).toContain("Welcome to Our Platform");
    expect(result.code).toContain("---");
  });

  it("Astroコンポーネントにprops型定義が含まれる（TypeScript時）", async () => {
    const options: CodeGeneratorOptions = {
      framework: "astro",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(mockSectionPattern, options);

    // AstroではProps interfaceがフロントマター内にある
    expect(result.code).toContain("Props");
  });
});

// =====================================================
// セキュリティテスト: コードインジェクション防止
// =====================================================

describe("Svelte/Astroコード生成 - セキュリティ（コードインジェクション防止）", () => {
  let service: LayoutToCodeService;

  beforeEach(() => {
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
    service = new LayoutToCodeService();
  });

  afterEach(() => {
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
  });

  it("Svelteコード生成で<script>タグインジェクションを防止する", async () => {
    const maliciousPattern: SectionPattern = {
      ...mockSectionPattern,
      layoutInfo: {
        ...mockSectionPattern.layoutInfo,
        heading: '<script>alert("xss")</script>Heading',
        description: 'Normal description<img onerror="alert(1)" src=x>',
      },
      htmlSnippet: undefined, // layoutInfoからの生成を使用
    };
    const options: CodeGeneratorOptions = {
      framework: "svelte",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(maliciousPattern, options);

    // 生成されたSvelteコードに悪意あるscriptが含まれないこと
    // テンプレート部分にraw <script>alert が含まれない
    // (Svelteの<script>タグ自体は正当なものなので除外)
    expect(result.code).not.toContain('alert("xss")');
    expect(result.code).not.toContain('onerror="alert(1)"');
  });

  it("Astroコード生成で<script>タグインジェクションを防止する", async () => {
    const maliciousPattern: SectionPattern = {
      ...mockSectionPattern,
      layoutInfo: {
        ...mockSectionPattern.layoutInfo,
        heading: '<script>alert("xss")</script>Heading',
        description: 'Normal description<img onerror="alert(1)" src=x>',
      },
      htmlSnippet: undefined,
    };
    const options: CodeGeneratorOptions = {
      framework: "astro",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(maliciousPattern, options);

    // Astroフロントマター内に悪意あるスクリプトが含まれないこと
    expect(result.code).not.toContain('alert("xss")');
    expect(result.code).not.toContain('onerror="alert(1)"');
  });

  it("HTMLスニペットからの変換でXSSを防止する（Svelte）", async () => {
    const xssPattern: SectionPattern = {
      ...mockSectionPattern,
      htmlSnippet:
        '<section><h1>Title</h1><p onclick="alert(1)">Text</p><img src="x" onerror="alert(2)"></section>',
    };
    const options: CodeGeneratorOptions = {
      framework: "svelte",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(xssPattern, options);

    // onclick/onerrorイベントハンドラが含まれないこと
    expect(result.code).not.toContain("onclick=");
    expect(result.code).not.toContain("onerror=");
  });

  it("HTMLスニペットからの変換でXSSを防止する（Astro）", async () => {
    const xssPattern: SectionPattern = {
      ...mockSectionPattern,
      htmlSnippet:
        '<section><h1>Title</h1><p onclick="alert(1)">Text</p><img src="x" onerror="alert(2)"></section>',
    };
    const options: CodeGeneratorOptions = {
      framework: "astro",
      typescript: true,
      tailwind: true,
    };

    const result = await service.generateCode(xssPattern, options);

    // onclick/onerrorイベントハンドラが含まれないこと
    expect(result.code).not.toContain("onclick=");
    expect(result.code).not.toContain("onerror=");
  });
});

// =====================================================
// ツールハンドラーテスト: Svelte/Astroフレームワーク
// =====================================================

describe("layoutToCodeHandler - Svelte/Astroフレームワーク", () => {
  let mockService: ILayoutToCodeService;

  beforeEach(() => {
    mockService = {
      getSectionPatternById: vi.fn().mockResolvedValue(mockSectionPattern),
      generateCode: vi
        .fn()
        .mockImplementation(
          (_pattern: SectionPattern, options: CodeGeneratorOptions): Promise<GeneratedCode> => {
            const framework = options.framework;
            if (framework === "svelte") {
              return Promise.resolve({
                code: '<script lang="ts">\n  export let className = "";\n</script>\n<section class={className}>\n  <h1>Hello</h1>\n</section>',
                componentName: "HeroSection",
                filename: "HeroSection.svelte",
                dependencies: ["svelte"],
              });
            }
            if (framework === "astro") {
              return Promise.resolve({
                code: "---\ninterface Props {\n  className?: string;\n}\nconst { className } = Astro.props;\n---\n<section class={className}>\n  <h1>Hello</h1>\n</section>",
                componentName: "HeroSection",
                filename: "HeroSection.astro",
                dependencies: ["astro"],
              });
            }
            return Promise.resolve({
              code: "default",
              componentName: "HeroSection",
              filename: "HeroSection.tsx",
              dependencies: ["react"],
            });
          }
        ),
    };

    setLayoutToCodeServiceFactory(() => mockService);
  });

  afterEach(() => {
    resetLayoutToCodeServiceFactory();
  });

  it("framework='svelte'でSvelteコードを生成する", async () => {
    const input = {
      patternId: validUUID,
      options: { framework: "svelte" },
    };

    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.framework).toBe("svelte");
      expect(result.data.filename).toContain(".svelte");
    }
  });

  it("framework='astro'でAstroコードを生成する", async () => {
    const input = {
      patternId: validUUID,
      options: { framework: "astro" },
    };

    const result = await layoutToCodeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.framework).toBe("astro");
      expect(result.data.filename).toContain(".astro");
    }
  });
});

// =====================================================
// JSON Schema (ツール定義) テスト
// =====================================================

describe("layoutGenerateCodeToolDefinition - Svelte/Astro JSON Schema整合性", () => {
  it("frameworkのenum配列にsvelteが含まれる", () => {
    const frameworkProp = (
      layoutGenerateCodeToolDefinition.inputSchema.properties.options as {
        properties: { framework: { enum: string[] } };
      }
    ).properties.framework;
    expect(frameworkProp.enum).toContain("svelte");
  });

  it("frameworkのenum配列にastroが含まれる", () => {
    const frameworkProp = (
      layoutGenerateCodeToolDefinition.inputSchema.properties.options as {
        properties: { framework: { enum: string[] } };
      }
    ).properties.framework;
    expect(frameworkProp.enum).toContain("astro");
  });

  it("frameworkのenum配列に既存のreact/vue/htmlが含まれる", () => {
    const frameworkProp = (
      layoutGenerateCodeToolDefinition.inputSchema.properties.options as {
        properties: { framework: { enum: string[] } };
      }
    ).properties.framework;
    expect(frameworkProp.enum).toContain("react");
    expect(frameworkProp.enum).toContain("vue");
    expect(frameworkProp.enum).toContain("html");
  });

  it("descriptionにSvelte/Astroの記述が含まれる", () => {
    expect(layoutGenerateCodeToolDefinition.description).toContain("Svelte");
    expect(layoutGenerateCodeToolDefinition.description).toContain("Astro");
  });
});
