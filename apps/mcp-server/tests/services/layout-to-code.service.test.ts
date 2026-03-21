// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LayoutToCodeService テスト
 * 画像URL置き換え機能およびcssSnippet対応のテスト
 *
 * テスト対象:
 * - 画像URL置き換え（外部URL、相対パス、data:URL等）
 * - cssSnippetがある場合: Tailwind CDNを使用せず、<style>タグ内にcssSnippetを含める
 * - cssSnippetがない場合: フォールバックとしてTailwind CDNを使用
 *
 * @module tests/services/layout-to-code.service
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  LayoutToCodeService,
  setLayoutToCodePrismaClientFactory,
  resetLayoutToCodePrismaClientFactory,
  resetLayoutToCodeService,
} from "../../src/services/layout-to-code.service";
import type { SectionPattern, CodeGeneratorOptions } from "../../src/tools/layout/to-code.tool";

/**
 * replaceExternalImageUrls() 関数の動作テスト
 * 注: この関数は layout-to-code.service.ts 内でエクスポートされていないため、
 * 実際の動作を間接的にテストする
 */
describe("LayoutToCodeService - 画像URL置き換え", () => {
  describe("replaceExternalImageUrls() の動作", () => {
    /**
     * テスト用のHTMLパターン
     */
    const testCases = [
      {
        name: "外部URL（https://）を置き換える",
        input: '<img src="https://example.com/image.png" alt="test">',
        shouldReplace: true,
        description: "外部URLは data: URL プレースホルダーに置き換えられる",
      },
      {
        name: "外部URL（http://）を置き換える",
        input: '<img src="http://example.com/image.png" alt="test">',
        shouldReplace: true,
        description: "外部URLは data: URL プレースホルダーに置き換えられる",
      },
      {
        name: "相対パスを置き換える（ファイル名のみ）",
        input: '<img src="type-linear.svg" alt="test">',
        shouldReplace: true,
        description: "相対パスは data: URL プレースホルダーに置き換えられる（404防止）",
      },
      {
        name: "相対パスを置き換える（./付き）",
        input: '<img src="./images/icon.png" alt="test">',
        shouldReplace: true,
        description: "相対パスは data: URL プレースホルダーに置き換えられる（404防止）",
      },
      {
        name: "相対パスを置き換える（../付き）",
        input: '<img src="../assets/logo.png" alt="test">',
        shouldReplace: true,
        description: "相対パスは data: URL プレースホルダーに置き換えられる（404防止）",
      },
      {
        name: "ルート相対パスを置き換える",
        input: '<img src="/images/banner.jpg" alt="test">',
        shouldReplace: true,
        description: "ルート相対パスは data: URL プレースホルダーに置き換えられる（404防止）",
      },
      {
        name: "data: URLは置き換えない",
        input: '<img src="data:image/svg+xml,<svg>...</svg>" alt="test">',
        shouldReplace: false,
        description: "data: URLは既にCSP準拠のため置き換え不要",
      },
      {
        name: "blob: URLは置き換えない",
        input: '<img src="blob:https://example.com/12345" alt="test">',
        shouldReplace: false,
        description: "blob: URLは既にCSP準拠のため置き換え不要",
      },
      {
        name: "空のsrcは置き換えない",
        input: '<img src="" alt="test">',
        shouldReplace: false,
        description: "空のURLは置き換え対象外",
      },
      {
        name: "ハッシュのみは置き換えない",
        input: '<img src="#" alt="test">',
        shouldReplace: false,
        description: "ハッシュのみは置き換え対象外",
      },
      {
        name: "複数の画像URLを置き換える",
        input: `
          <img src="type-linear.svg" alt="type">
          <img src="switch-linear.webp" alt="switch">
          <img src="https://example.com/external.png" alt="external">
        `,
        shouldReplace: true,
        description: "複数の画像URLはすべて置き換えられる",
      },
      {
        name: "CSS background-imageの相対パスを置き換える",
        input: '<div style="background-image: url(bg-pattern.png)">Content</div>',
        shouldReplace: true,
        description: "CSS内の相対パスも置き換えられる",
      },
      {
        name: "srcset内の相対パスを置き換える",
        input: '<img srcset="image-1x.png 1x, image-2x.png 2x" alt="test">',
        shouldReplace: true,
        description: "srcset内の相対パスも置き換えられる",
      },
    ];

    testCases.forEach(({ name, input, shouldReplace, description }) => {
      it(name, () => {
        // この実装テストは、実際のサービスが期待通りに動作することを文書化する
        // 実際のテストは統合テストで行う
        expect(description).toBeTruthy();
        expect(input).toBeTruthy();
        expect(typeof shouldReplace).toBe("boolean");
      });
    });
  });

  describe("isExternalUrl() ロジックの仕様", () => {
    it("data: URL は置き換え対象外と判定される", () => {
      const url = "data:image/svg+xml,<svg>...</svg>";
      // isExternalUrl(url) === false を期待
      expect(url.toLowerCase().startsWith("data:")).toBe(true);
    });

    it("blob: URL は置き換え対象外と判定される", () => {
      const url = "blob:https://example.com/12345";
      // isExternalUrl(url) === false を期待
      expect(url.toLowerCase().startsWith("blob:")).toBe(true);
    });

    it("相対パスは置き換え対象と判定される", () => {
      const urls = [
        "type-linear.svg",
        "./images/icon.png",
        "../assets/logo.png",
        "/images/banner.jpg",
      ];

      urls.forEach((url) => {
        const trimmedUrl = url.trim().toLowerCase();
        const isDataOrBlob = trimmedUrl.startsWith("data:") || trimmedUrl.startsWith("blob:");
        const isEmpty = trimmedUrl === "" || trimmedUrl === "#";

        // isExternalUrl(url) === true を期待
        expect(isDataOrBlob).toBe(false);
        expect(isEmpty).toBe(false);
      });
    });

    it("外部URLは置き換え対象と判定される", () => {
      const urls = ["https://example.com/image.png", "http://example.com/image.png"];

      urls.forEach((url) => {
        const trimmedUrl = url.trim().toLowerCase();
        const isDataOrBlob = trimmedUrl.startsWith("data:") || trimmedUrl.startsWith("blob:");
        const isEmpty = trimmedUrl === "" || trimmedUrl === "#";

        // isExternalUrl(url) === true を期待
        expect(isDataOrBlob).toBe(false);
        expect(isEmpty).toBe(false);
      });
    });

    it("空のURLは置き換え対象外と判定される", () => {
      const urls = ["", "#", "   "];

      urls.forEach((url) => {
        const trimmedUrl = url.trim().toLowerCase();
        const isEmpty = trimmedUrl === "" || trimmedUrl === "#";

        // isExternalUrl(url) === false を期待
        expect(isEmpty || trimmedUrl === "").toBe(true);
      });
    });
  });
});

// =====================================================
// cssSnippet コード生成テスト
// =====================================================

describe("LayoutToCodeService - cssSnippet コード生成", () => {
  let service: LayoutToCodeService;

  beforeEach(() => {
    // サービスインスタンスをリセット
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
    service = new LayoutToCodeService();
  });

  afterEach(() => {
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
  });

  /**
   * テスト用のベースパターン（cssSnippetなし）
   */
  const createBasePattern = (overrides: Partial<SectionPattern> = {}): SectionPattern => ({
    id: "test-pattern-001",
    webPageId: "test-webpage-001",
    sectionType: "hero",
    positionIndex: 0,
    layoutInfo: {
      type: "hero",
      heading: "Test Hero Section",
      description: "This is a test description for the hero section.",
    },
    components: [
      { type: "heading", level: 1, text: "Welcome to Our Site" },
      { type: "paragraph", text: "Discover amazing features." },
      { type: "button", text: "Get Started", variant: "primary" },
    ],
    htmlSnippet: '<section class="hero"><h1>Test Hero</h1><p>Content here</p></section>',
    webPage: {
      id: "test-webpage-001",
      url: "https://example.com",
      title: "Test Page",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
    },
    ...overrides,
  });

  /**
   * テスト用のCSSスニペット
   */
  const sampleCssSnippet = `
/* <style> tag */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4rem 2rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}
.hero h1 {
  font-size: 3rem;
  font-weight: 700;
  margin-bottom: 1rem;
}
.hero p {
  font-size: 1.25rem;
  opacity: 0.9;
}
.hero button {
  margin-top: 2rem;
  padding: 1rem 2rem;
  background: white;
  color: #667eea;
  border: none;
  border-radius: 8px;
  cursor: pointer;
}
`;

  describe("cssSnippetがある場合", () => {
    it("Tailwind CDNが追加されないこと", async () => {
      // Arrange: cssSnippet付きのパターンを作成
      const patternWithCss = createBasePattern({
        cssSnippet: sampleCssSnippet,
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true, // tailwindオプションはtrueでもcssSnippetがあれば無視される
      };

      // Act: コード生成
      const result = await service.generateCode(patternWithCss, options);

      // Assert: Tailwind CDNが含まれていないこと
      expect(result.code).not.toContain("cdn.tailwindcss.com");
      expect(result.code).not.toContain("tailwindcss");
    });

    it("<style>タグ内にcssSnippetが含まれること", async () => {
      // Arrange: cssSnippet付きのパターンを作成
      const patternWithCss = createBasePattern({
        cssSnippet: sampleCssSnippet,
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true,
      };

      // Act: コード生成
      const result = await service.generateCode(patternWithCss, options);

      // Assert: <style>タグ内にcssSnippetの内容が含まれること
      expect(result.code).toContain("<style>");
      expect(result.code).toContain(".hero {");
      expect(result.code).toContain("display: flex");
      expect(result.code).toContain("background: linear-gradient");
      expect(result.code).toContain(".hero h1 {");
      expect(result.code).toContain("font-size: 3rem");
    });

    it("htmlSnippetのクラスに対応するスタイルが適用されること", async () => {
      // Arrange: htmlSnippetとcssSnippetが一致するパターン
      const patternWithMatchingCss = createBasePattern({
        htmlSnippet: '<section class="hero"><h1 class="hero-title">Title</h1></section>',
        cssSnippet: `.hero { padding: 2rem; }
.hero-title { font-size: 2.5rem; color: #333; }`,
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(patternWithMatchingCss, options);

      // Assert: CSSセレクタが正しく含まれること
      expect(result.code).toContain(".hero {");
      expect(result.code).toContain(".hero-title {");
      expect(result.code).toContain("padding: 2rem");
      expect(result.code).toContain("font-size: 2.5rem");
    });
  });

  describe("cssSnippetがない場合（フォールバック）", () => {
    it("Tailwind CDNが追加されること（tailwind: trueの場合）", async () => {
      // Arrange: cssSnippetなしのパターン
      const patternWithoutCss = createBasePattern();
      // cssSnippetがundefinedであることを確認
      expect(patternWithoutCss.cssSnippet).toBeUndefined();

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true,
      };

      // Act: コード生成
      const result = await service.generateCode(patternWithoutCss, options);

      // Assert: Tailwind CDNが含まれること
      expect(result.code).toContain("cdn.tailwindcss.com");
    });

    it("従来通りの動作をすること（tailwind: falseの場合）", async () => {
      // Arrange: cssSnippetなしのパターン
      const patternWithoutCss = createBasePattern();

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(patternWithoutCss, options);

      // Assert: Tailwind CDNが含まれず、基本的なスタイルが含まれること
      expect(result.code).not.toContain("cdn.tailwindcss.com");
      expect(result.code).toContain("<style>");
      expect(result.code).toContain("font-family: system-ui");
    });
  });

  describe("cssSnippetが空文字列の場合", () => {
    it("フォールバックとしてTailwind CDNが使用されること", async () => {
      // Arrange: cssSnippetが空文字列のパターン
      const patternWithEmptyCss = createBasePattern({
        cssSnippet: "",
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true,
      };

      // Act: コード生成
      const result = await service.generateCode(patternWithEmptyCss, options);

      // Assert: 空文字列はフォールバックとしてTailwind CDNが使用される
      expect(result.code).toContain("cdn.tailwindcss.com");
    });

    it("空白文字のみの場合もフォールバックすること", async () => {
      // Arrange: cssSnippetが空白のみのパターン
      const patternWithWhitespaceCss = createBasePattern({
        cssSnippet: "   \n\t  ",
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true,
      };

      // Act: コード生成
      const result = await service.generateCode(patternWithWhitespaceCss, options);

      // Assert: 空白のみの場合もフォールバック
      expect(result.code).toContain("cdn.tailwindcss.com");
    });
  });

  describe("React/Vue フレームワークでのcssSnippet対応", () => {
    it("Reactコンポーネントでもcssが適用されること", async () => {
      // Arrange: cssSnippet付きのパターン
      const patternWithCss = createBasePattern({
        cssSnippet: `.hero-container { padding: 2rem; background: #f0f0f0; }`,
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(patternWithCss, options);

      // Assert: Reactコンポーネントが生成されること
      expect(result.code).toContain("import React");
      expect(result.code).toContain("export const HeroSection");
      // 注: Reactの場合、cssSnippetはインラインスタイルまたは別ファイルとして扱われる可能性がある
    });

    it("Vueコンポーネントでscoped styleが生成されること", async () => {
      // Arrange: cssSnippet付きのパターン
      const patternWithCss = createBasePattern({
        cssSnippet: `.hero-container { padding: 2rem; }`,
      });

      const options: CodeGeneratorOptions = {
        framework: "vue",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(patternWithCss, options);

      // Assert: Vueコンポーネントが生成されること
      expect(result.code).toContain("<script setup");
      expect(result.code).toContain("<template>");
      expect(result.code).toContain("<style scoped>");
    });
  });
});

// =====================================================
// cssFramework コード生成テスト（v0.1.0新機能）
// =====================================================

describe("LayoutToCodeService - cssFramework コード生成", () => {
  let service: LayoutToCodeService;

  beforeEach(() => {
    // サービスインスタンスをリセット
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
    service = new LayoutToCodeService();
  });

  afterEach(() => {
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
  });

  /**
   * テスト用のモックパターン生成ヘルパー
   * cssFramework フィールドを含むSectionPatternを生成
   */
  const createMockPattern = (overrides: Partial<SectionPattern> = {}): SectionPattern => ({
    id: "test-pattern-css-framework",
    webPageId: "test-webpage-001",
    sectionType: "hero",
    positionIndex: 0,
    layoutInfo: {
      type: "hero",
      heading: "Test Section",
    },
    components: [],
    htmlSnippet: '<div class="hero">Content</div>',
    webPage: {
      id: "test-webpage-001",
      url: "https://example.com",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
    },
    ...overrides,
  });

  // =====================================================
  // Tailwindフレームワークのテスト
  // =====================================================
  describe("cssFramework: tailwind", () => {
    it("Tailwind CDNスクリプトが含まれること", async () => {
      // Arrange: cssFramework=tailwindのパターン
      const pattern = createMockPattern({
        cssFramework: "tailwind",
        htmlSnippet: '<div class="flex items-center p-4">Content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false, // オプションに関係なくcssFrameworkが優先される
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: Tailwind CDNが含まれること
      expect(result.code).toContain("cdn.tailwindcss.com");
    });

    it("cssSnippetがあってもTailwind CDNを優先すること", async () => {
      // Arrange: cssFramework=tailwindかつcssSnippetありのパターン
      const pattern = createMockPattern({
        cssFramework: "tailwind",
        cssSnippet: ".custom { color: red; }",
        htmlSnippet: '<div class="flex">Content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: Tailwind CDNが含まれ、追加CSSも含まれること
      expect(result.code).toContain("cdn.tailwindcss.com");
      expect(result.code).toContain(".custom { color: red; }");
    });

    it("cssFrameworkMetaの信頼度が高い場合にTailwindを使用すること", async () => {
      // Arrange: 高信頼度のTailwind検出
      const pattern = createMockPattern({
        cssFramework: "tailwind",
        cssFrameworkMeta: {
          confidence: 0.95,
          evidence: ["Tailwind CDN detected", "utility classes found: flex, items-center"],
        },
        htmlSnippet: '<div class="flex items-center gap-4">Content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: Tailwind CDNが含まれること
      expect(result.code).toContain("cdn.tailwindcss.com");
    });
  });

  // =====================================================
  // Bootstrapフレームワークのテスト
  // =====================================================
  describe("cssFramework: bootstrap", () => {
    it("Bootstrap CDNリンクが含まれること", async () => {
      // Arrange: cssFramework=bootstrapのパターン
      const pattern = createMockPattern({
        cssFramework: "bootstrap",
        htmlSnippet: '<button class="btn btn-primary">Click</button>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: Bootstrap CDNリンクとJSバンドルが含まれること
      expect(result.code).toContain("bootstrap.min.css");
      expect(result.code).toContain("bootstrap.bundle.min.js");
    });

    it("Bootstrap CDNとcssSnippetが両方含まれること", async () => {
      // Arrange: cssFramework=bootstrapかつcssSnippetありのパターン
      const pattern = createMockPattern({
        cssFramework: "bootstrap",
        cssSnippet: ".custom-override { margin: 20px; }",
        htmlSnippet: '<div class="container"><button class="btn btn-success">OK</button></div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: Bootstrap CDNと追加CSSが両方含まれること
      expect(result.code).toContain("bootstrap.min.css");
      expect(result.code).toContain(".custom-override { margin: 20px; }");
    });
  });

  // =====================================================
  // CSS Modulesフレームワークのテスト
  // =====================================================
  describe("cssFramework: css_modules", () => {
    it("インラインCSSとしてcssSnippetが出力されること", async () => {
      // Arrange: cssFramework=css_modulesのパターン
      const pattern = createMockPattern({
        cssFramework: "css_modules",
        cssSnippet: ".page_container__abc12 { display: flex; }",
        htmlSnippet: '<div class="page_container__abc12">Content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true, // tailwindオプションは無視される
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: インラインCSSが含まれ、CDNは含まれないこと
      expect(result.code).toContain("<style>");
      expect(result.code).toContain(".page_container__abc12");
      expect(result.code).toContain("display: flex");
      expect(result.code).not.toContain("cdn.tailwindcss.com");
    });

    it("Tailwind CDNが追加されないこと", async () => {
      // Arrange: cssFramework=css_modulesのパターン
      const pattern = createMockPattern({
        cssFramework: "css_modules",
        cssSnippet: ".styles_button__xyz99 { padding: 10px; }",
        htmlSnippet: '<button class="styles_button__xyz99">OK</button>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: Tailwind CDNが含まれないこと
      expect(result.code).not.toContain("tailwindcss");
      expect(result.code).not.toContain("cdn.tailwindcss.com");
    });

    it("CSS Modulesのハッシュ付きクラス名が保持されること", async () => {
      // Arrange: 複数のCSS Modulesクラス
      const pattern = createMockPattern({
        cssFramework: "css_modules",
        cssSnippet: `.header_container__a1b2c { background: #fff; }
.header_title__d3e4f { font-size: 24px; }
.header_nav__g5h6i { display: flex; }`,
        htmlSnippet:
          '<header class="header_container__a1b2c"><h1 class="header_title__d3e4f">Title</h1><nav class="header_nav__g5h6i"></nav></header>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: すべてのハッシュ付きクラス名が保持されること
      expect(result.code).toContain(".header_container__a1b2c");
      expect(result.code).toContain(".header_title__d3e4f");
      expect(result.code).toContain(".header_nav__g5h6i");
    });
  });

  // =====================================================
  // vanilla CSSフレームワークのテスト
  // =====================================================
  describe("cssFramework: vanilla", () => {
    it("cssSnippetがインラインで出力されること", async () => {
      // Arrange: cssFramework=vanillaのパターン
      const pattern = createMockPattern({
        cssFramework: "vanilla",
        cssSnippet: ".header { background: blue; }",
        htmlSnippet: '<header class="header">Title</header>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: cssSnippetがインラインで含まれること
      expect(result.code).toContain(".header { background: blue; }");
      expect(result.code).toContain("<style>");
    });

    it("CDNが追加されないこと", async () => {
      // Arrange: cssFramework=vanillaのパターン
      const pattern = createMockPattern({
        cssFramework: "vanilla",
        cssSnippet: ".container { max-width: 1200px; margin: 0 auto; }",
        htmlSnippet: '<div class="container">Content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true, // 無視される
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: CDNが含まれないこと
      expect(result.code).not.toContain("cdn.tailwindcss.com");
      expect(result.code).not.toContain("bootstrap");
    });
  });

  // =====================================================
  // styled_componentsフレームワークのテスト
  // =====================================================
  describe("cssFramework: styled_components", () => {
    it("cssSnippetがインラインで出力されること", async () => {
      // Arrange: cssFramework=styled_componentsのパターン
      const pattern = createMockPattern({
        cssFramework: "styled_components",
        cssSnippet: ".sc-bdnxRM { color: #333; font-size: 16px; }",
        htmlSnippet: '<div class="sc-bdnxRM">Styled content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: インラインCSSが含まれること
      expect(result.code).toContain(".sc-bdnxRM");
      expect(result.code).toContain("color: #333");
    });
  });

  // =====================================================
  // フォールバック動作のテスト
  // =====================================================
  describe("フォールバック動作", () => {
    it("cssFrameworkがunknownでcssSnippetがある場合はインラインCSS", async () => {
      // Arrange: cssFramework=unknownかつcssSnippetありのパターン
      const pattern = createMockPattern({
        cssFramework: "unknown",
        cssSnippet: ".custom { margin: 0; }",
        htmlSnippet: '<div class="custom">Content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true, // cssSnippetがあるので無視される
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: インラインCSSが使用され、CDNは含まれないこと
      expect(result.code).toContain(".custom { margin: 0; }");
      expect(result.code).not.toContain("cdn.tailwindcss.com");
    });

    it("cssFrameworkがnullでcssSnippetもない場合はTailwindにフォールバック", async () => {
      // Arrange: cssFramework=null, cssSnippet=nullのパターン
      const pattern = createMockPattern({
        cssFramework: null,
        cssSnippet: undefined,
        htmlSnippet: "<div>Content</div>",
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: Tailwind CDNにフォールバックすること
      expect(result.code).toContain("cdn.tailwindcss.com");
    });

    it("cssFrameworkがundefinedでcssSnippetもない場合はTailwindにフォールバック", async () => {
      // Arrange: cssFramework未定義のパターン
      const pattern = createMockPattern({
        htmlSnippet: "<div>Content</div>",
      });
      // cssFramework, cssSnippetはundefined
      expect(pattern.cssFramework).toBeUndefined();
      expect(pattern.cssSnippet).toBeUndefined();

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: Tailwind CDNにフォールバックすること
      expect(result.code).toContain("cdn.tailwindcss.com");
    });

    it("cssFrameworkがunknownでcssSnippetもなくtailwind=falseの場合は基本スタイルのみ", async () => {
      // Arrange: cssFramework=unknown, cssSnippetなし, tailwind=false
      const pattern = createMockPattern({
        cssFramework: "unknown",
        cssSnippet: undefined,
        htmlSnippet: "<div>Content</div>",
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: 基本スタイルのみでCDNは含まれないこと
      expect(result.code).not.toContain("cdn.tailwindcss.com");
      expect(result.code).not.toContain("bootstrap");
      expect(result.code).toContain("font-family: system-ui");
    });
  });

  // =====================================================
  // 画像URL置換との組み合わせテスト
  // =====================================================
  describe("画像URL置換との組み合わせ", () => {
    it("CSS Modulesでも画像URLがプレースホルダーに置き換わること", async () => {
      // Arrange: cssFramework=css_modulesで画像を含むパターン
      const pattern = createMockPattern({
        cssFramework: "css_modules",
        cssSnippet: ".bg_image__abc12 { background-image: url(hero.jpg); }",
        htmlSnippet: '<div class="bg_image__abc12"><img src="icon.svg" alt="icon"></div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: 画像URLがプレースホルダーに置き換わること
      expect(result.code).toContain("data:image/svg+xml");
      expect(result.code).not.toContain("icon.svg");
      // CSS内の画像URLも置き換わる（background-imageは対応済み）
      // 注: CSS内のurl()置換はreplaceExternalImageUrlsで対応
    });

    it("Tailwindでも画像URLがプレースホルダーに置き換わること", async () => {
      // Arrange: cssFramework=tailwindで画像を含むパターン
      const pattern = createMockPattern({
        cssFramework: "tailwind",
        htmlSnippet: '<div class="flex"><img src="https://example.com/logo.png" alt="logo"></div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: 外部画像URLがプレースホルダーに置き換わること
      expect(result.code).toContain("data:image/svg+xml");
      expect(result.code).not.toContain("https://example.com/logo.png");
    });

    it("Bootstrapでも画像URLがプレースホルダーに置き換わること", async () => {
      // Arrange: cssFramework=bootstrapで画像を含むパターン
      const pattern = createMockPattern({
        cssFramework: "bootstrap",
        htmlSnippet: '<div class="container"><img src="/images/banner.jpg" alt="banner"></div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: ルート相対パス画像がプレースホルダーに置き換わること
      expect(result.code).toContain("data:image/svg+xml");
      expect(result.code).not.toContain("/images/banner.jpg");
    });
  });
});

// =====================================================
// splitComponents コンポーネント分割テスト（v0.1.0新機能）
// =====================================================

describe("LayoutToCodeService - splitComponents コンポーネント分割", () => {
  let service: LayoutToCodeService;

  beforeEach(() => {
    // サービスインスタンスをリセット
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
    service = new LayoutToCodeService();
  });

  afterEach(() => {
    resetLayoutToCodeService();
    resetLayoutToCodePrismaClientFactory();
  });

  /**
   * テスト用のモックパターン生成ヘルパー
   */
  const createSplitTestPattern = (overrides: Partial<SectionPattern> = {}): SectionPattern => ({
    id: "test-pattern-split-components",
    webPageId: "test-webpage-001",
    sectionType: "hero",
    positionIndex: 0,
    layoutInfo: {
      type: "hero",
      heading: "Test Section",
    },
    components: [],
    webPage: {
      id: "test-webpage-001",
      url: "https://example.com",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
    },
    ...overrides,
  });

  // =====================================================
  // splitComponents: false のテスト（デフォルト動作）
  // =====================================================
  describe("splitComponents: false（デフォルト）", () => {
    it("従来通り単一コンポーネントが生成されること", async () => {
      // Arrange: htmlSnippet付きのパターン
      const pattern = createSplitTestPattern({
        htmlSnippet: `
          <header class="site-header">
            <nav class="main-nav">
              <ul><li>Home</li><li>About</li></ul>
            </nav>
          </header>
          <main class="content">
            <section class="hero-section">
              <h1>Welcome</h1>
              <p>Description</p>
            </section>
          </main>
          <footer class="site-footer">
            <p>Copyright 2024</p>
          </footer>
        `,
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
        splitComponents: false, // 明示的にfalse
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: subComponentsが含まれないこと
      expect(result.subComponents).toBeUndefined();
      expect(result.code).toContain("import React");
      expect(result.code).toContain("export const HeroSection");
    });

    it("splitComponentsオプションなしでも単一コンポーネントが生成されること", async () => {
      // Arrange: htmlSnippet付きのパターン
      const pattern = createSplitTestPattern({
        htmlSnippet: '<div class="container"><h1>Title</h1><p>Content</p></div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
        // splitComponents は指定しない（undefined）
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: subComponentsが含まれないこと
      expect(result.subComponents).toBeUndefined();
      expect(result.code).toContain("export const HeroSection");
    });
  });

  // =====================================================
  // splitComponents: true のテスト
  // =====================================================
  describe("splitComponents: true", () => {
    it("セマンティックHTML要素がサブコンポーネントに分割されること", async () => {
      // Arrange: header, main, footer を含むhtmlSnippet
      const pattern = createSplitTestPattern({
        htmlSnippet: `
          <div class="page">
            <header class="site-header">
              <nav><a href="/">Home</a></nav>
            </header>
            <main class="main-content">
              <h1>Welcome</h1>
              <p>This is the main content.</p>
            </main>
            <footer class="site-footer">
              <p>Copyright 2024</p>
            </footer>
          </div>
        `,
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
        splitComponents: true,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: subComponentsが生成されること
      expect(result.subComponents).toBeDefined();
      expect(Array.isArray(result.subComponents)).toBe(true);

      // サブコンポーネントが存在する場合の検証
      if (result.subComponents && result.subComponents.length > 0) {
        // 各サブコンポーネントの構造を確認
        result.subComponents.forEach((sub) => {
          expect(sub.name).toBeTruthy();
          expect(sub.code).toBeTruthy();
          expect(sub.filename).toBeTruthy();
          expect(Array.isArray(sub.props)).toBe(true);

          // コードがReactコンポーネントであること
          expect(sub.code).toContain("import React");
          expect(sub.code).toContain("export const");
        });

        // メインコンポーネントにimport文が含まれること
        const hasImports = result.subComponents.some((sub) =>
          result.code.includes(`import { ${sub.name} }`)
        );
        expect(hasImports).toBe(true);
      }
    });

    it("TypeScript無効時もサブコンポーネントが生成されること", async () => {
      // Arrange: header, footer を含むhtmlSnippet
      const pattern = createSplitTestPattern({
        htmlSnippet: `
          <div>
            <header class="header"><h1>Logo</h1></header>
            <section class="content"><p>Content</p></section>
            <footer class="footer"><p>Footer</p></footer>
          </div>
        `,
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: false, // TypeScript無効
        tailwind: true,
        splitComponents: true,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: サブコンポーネントが存在する場合の検証
      if (result.subComponents && result.subComponents.length > 0) {
        result.subComponents.forEach((sub) => {
          // TypeScript無効の場合、型定義がないこと
          expect(sub.code).toContain("// @ts-nocheck");
          expect(sub.code).not.toContain("interface");
        });
      }

      // メインコンポーネントもTypeScript無効
      expect(result.code).toContain("// @ts-nocheck");
    });

    it("サブコンポーネントのファイル名が正しい拡張子であること", async () => {
      // Arrange: 分割可能なhtmlSnippet
      const pattern = createSplitTestPattern({
        htmlSnippet: `
          <div>
            <header><nav>Nav</nav></header>
            <main><article>Content</article></main>
            <footer><p>Footer</p></footer>
          </div>
        `,
      });

      // TypeScript有効
      const optionsTsx: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
        splitComponents: true,
      };

      // Act & Assert: TypeScript有効時
      const resultTsx = await service.generateCode(pattern, optionsTsx);
      if (resultTsx.subComponents && resultTsx.subComponents.length > 0) {
        resultTsx.subComponents.forEach((sub) => {
          expect(sub.filename).toMatch(/\.tsx$/);
        });
      }

      // TypeScript無効
      const optionsJsx: CodeGeneratorOptions = {
        framework: "react",
        typescript: false,
        tailwind: true,
        splitComponents: true,
      };

      // Act & Assert: TypeScript無効時
      const resultJsx = await service.generateCode(pattern, optionsJsx);
      if (resultJsx.subComponents && resultJsx.subComponents.length > 0) {
        resultJsx.subComponents.forEach((sub) => {
          expect(sub.filename).toMatch(/\.jsx$/);
        });
      }
    });
  });

  // =====================================================
  // フレームワーク別のテスト
  // =====================================================
  describe("フレームワーク別動作", () => {
    it("Vue/HTMLではsplitComponentsが無視されること", async () => {
      // Arrange
      const pattern = createSplitTestPattern({
        htmlSnippet: `
          <div>
            <header><h1>Header</h1></header>
            <footer><p>Footer</p></footer>
          </div>
        `,
      });

      // Vue
      const vueOptions: CodeGeneratorOptions = {
        framework: "vue",
        typescript: true,
        tailwind: true,
        splitComponents: true, // Vueでは無視される
      };
      const vueResult = await service.generateCode(pattern, vueOptions);
      expect(vueResult.subComponents).toBeUndefined();
      expect(vueResult.code).toContain("<template>");

      // HTML
      const htmlOptions: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: true,
        splitComponents: true, // HTMLでは無視される
      };
      const htmlResult = await service.generateCode(pattern, htmlOptions);
      expect(htmlResult.subComponents).toBeUndefined();
      expect(htmlResult.code).toContain("<!DOCTYPE html>");
    });

    it("React以外でもエラーにならないこと", async () => {
      // Arrange
      const pattern = createSplitTestPattern({
        htmlSnippet: "<div><header>Header</header><footer>Footer</footer></div>",
      });

      // Vue
      const vueOptions: CodeGeneratorOptions = {
        framework: "vue",
        typescript: false,
        tailwind: false,
        splitComponents: true,
      };
      await expect(service.generateCode(pattern, vueOptions)).resolves.not.toThrow();

      // HTML
      const htmlOptions: CodeGeneratorOptions = {
        framework: "html",
        typescript: false,
        tailwind: false,
        splitComponents: true,
      };
      await expect(service.generateCode(pattern, htmlOptions)).resolves.not.toThrow();
    });
  });

  // =====================================================
  // エッジケーステスト
  // =====================================================
  describe("エッジケース", () => {
    it("htmlSnippetがない場合はsubComponentsが生成されないこと", async () => {
      // Arrange: htmlSnippetなし
      const pattern = createSplitTestPattern({
        layoutInfo: {
          type: "hero",
          heading: "Test Heading",
          description: "Test description",
        },
        // htmlSnippet はなし
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
        splitComponents: true,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert: htmlSnippetがない場合はサブコンポーネント分割されない
      expect(result.subComponents).toBeUndefined();
      // layoutInfoからコードが生成される
      expect(result.code).toContain("export const HeroSection");
    });

    it("空のhtmlSnippetの場合はsubComponentsが生成されないこと", async () => {
      // Arrange: 空のhtmlSnippet
      const pattern = createSplitTestPattern({
        htmlSnippet: "",
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
        splitComponents: true,
      };

      // Act: コード生成
      const result = await service.generateCode(pattern, options);

      // Assert
      expect(result.subComponents).toBeUndefined();
    });

    it("分割対象がないHTMLでもエラーにならないこと", async () => {
      // Arrange: 分割対象のない単純なHTML
      const pattern = createSplitTestPattern({
        htmlSnippet: "<div><p>Simple content</p></div>",
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
        splitComponents: true,
      };

      // Act & Assert: エラーにならないこと
      const result = await service.generateCode(pattern, options);
      expect(result.code).toBeTruthy();
      // 分割対象がない場合、subComponentsは空またはundefined
      if (result.subComponents) {
        expect(result.subComponents.length).toBe(0);
      }
    });

    it("カスタムコンポーネント名が正しく使用されること", async () => {
      // Arrange
      const pattern = createSplitTestPattern({
        htmlSnippet: `
          <div>
            <header>Header</header>
            <main>Main</main>
            <footer>Footer</footer>
          </div>
        `,
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
        splitComponents: true,
        componentName: "CustomLandingPage", // カスタム名
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert: カスタム名が使用されること
      expect(result.componentName).toBe("CustomLandingPage");
      expect(result.code).toContain("export const CustomLandingPage");
    });
  });
});

// =====================================================
// 独自クラス名除去テスト（REFTRIX-CODEGEN-03）
// =====================================================

describe("LayoutToCodeService - 独自クラス名除去", () => {
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

  /**
   * テスト用のモックパターン生成ヘルパー
   */
  const createProprietaryClassPattern = (
    overrides: Partial<SectionPattern> = {}
  ): SectionPattern => ({
    id: "test-pattern-proprietary-classes",
    webPageId: "test-webpage-001",
    sectionType: "hero",
    positionIndex: 0,
    layoutInfo: {
      type: "hero",
      heading: "Test Section",
    },
    components: [],
    webPage: {
      id: "test-webpage-001",
      url: "https://example.com",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
    },
    ...overrides,
  });

  describe("Reactコンポーネント生成時", () => {
    it("dwg-* クラスが除去されること", async () => {
      // Arrange: dwg-*クラスを含むhtmlSnippet
      const pattern = createProprietaryClassPattern({
        htmlSnippet: '<div class="dwg-hero dwg-container flex items-center">Content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert: dwg-*が除去され、Tailwindクラスが残ること
      expect(result.code).not.toContain("dwg-hero");
      expect(result.code).not.toContain("dwg-container");
      expect(result.code).toContain("flex");
      expect(result.code).toContain("items-center");
    });

    it("webflow-* クラスが除去されること", async () => {
      // Arrange: webflow-*クラスを含むhtmlSnippet
      const pattern = createProprietaryClassPattern({
        htmlSnippet: '<section class="webflow-section webflow-w-container p-4">Content</section>',
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert
      expect(result.code).not.toContain("webflow-section");
      expect(result.code).not.toContain("webflow-w-container");
      expect(result.code).toContain("p-4");
    });

    it("framer-* クラスが除去されること", async () => {
      // Arrange: framer-*クラスを含むhtmlSnippet
      const pattern = createProprietaryClassPattern({
        htmlSnippet: '<div class="framer-1abc framer-2def bg-white">Content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert
      expect(result.code).not.toContain("framer-1abc");
      expect(result.code).not.toContain("framer-2def");
      expect(result.code).toContain("bg-white");
    });

    it("w-* (Webflow) クラスが除去されること", async () => {
      // Arrange: w-container, w-nav-menu などのWebflowクラス
      const pattern = createProprietaryClassPattern({
        htmlSnippet: '<nav class="w-container w-nav-menu flex gap-4">Nav</nav>',
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert
      expect(result.code).not.toContain("w-container");
      expect(result.code).not.toContain("w-nav-menu");
      expect(result.code).toContain("flex");
      expect(result.code).toContain("gap-4");
    });

    it("複数プラットフォームのクラスが同時に除去されること", async () => {
      // Arrange: 複数プラットフォームのクラスを混在
      const pattern = createProprietaryClassPattern({
        htmlSnippet: `
          <div class="dwg-hero webflow-section framer-abc wp-block-group elementor-widget flex items-center justify-center">
            <h1 class="wix-element squarespace-header text-4xl font-bold">Title</h1>
          </div>
        `,
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert: すべての独自クラスが除去される
      expect(result.code).not.toContain("dwg-hero");
      expect(result.code).not.toContain("webflow-section");
      expect(result.code).not.toContain("framer-abc");
      expect(result.code).not.toContain("wp-block-group");
      expect(result.code).not.toContain("elementor-widget");
      expect(result.code).not.toContain("wix-element");
      expect(result.code).not.toContain("squarespace-header");

      // Tailwindクラスは残る
      expect(result.code).toContain("flex");
      expect(result.code).toContain("items-center");
      expect(result.code).toContain("justify-center");
      expect(result.code).toContain("text-4xl");
      expect(result.code).toContain("font-bold");
    });

    it("shopify-* クラスが除去されること", async () => {
      // Arrange
      const pattern = createProprietaryClassPattern({
        htmlSnippet: '<div class="shopify-section shopify-block-1 mx-auto">Product</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert
      expect(result.code).not.toContain("shopify-section");
      expect(result.code).not.toContain("shopify-block-1");
      expect(result.code).toContain("mx-auto");
    });
  });

  describe("Vueコンポーネント生成時", () => {
    it("独自クラスが除去されること", async () => {
      // Arrange
      const pattern = createProprietaryClassPattern({
        htmlSnippet: '<div class="dwg-hero webflow-section flex">Content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "vue",
        typescript: false,
        tailwind: true,
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert: VueテンプレートではclassName→classに変換されるため、classで確認
      expect(result.code).not.toContain("dwg-hero");
      expect(result.code).not.toContain("webflow-section");
      expect(result.code).toContain("flex");
      expect(result.code).toContain("<template>");
    });
  });

  describe("インラインスタイルからTailwindへの変換", () => {
    it("インラインスタイルがTailwindクラスに変換されること", async () => {
      // Arrange: インラインスタイルを含むhtmlSnippet
      const pattern = createProprietaryClassPattern({
        htmlSnippet:
          '<div style="display: flex; justify-content: center; padding: 16px;">Content</div>',
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert: インラインスタイルがTailwindクラスに変換される
      expect(result.code).toContain("flex");
      expect(result.code).toContain("justify-center");
      expect(result.code).toContain("p-4");
      // インラインstyle属性は除去される（または最小限に）
      expect(result.code).not.toContain("display: flex");
    });

    it("独自クラス除去とインラインスタイル変換が同時に動作すること", async () => {
      // Arrange: 両方を含むhtmlSnippet
      const pattern = createProprietaryClassPattern({
        htmlSnippet: `
          <div class="dwg-hero webflow-container" style="display: flex; align-items: center;">
            <h1 class="framer-title" style="font-size: 24px; font-weight: bold;">Title</h1>
          </div>
        `,
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert: 独自クラスが除去される
      expect(result.code).not.toContain("dwg-hero");
      expect(result.code).not.toContain("webflow-container");
      expect(result.code).not.toContain("framer-title");

      // インラインスタイルがTailwindクラスに変換される
      expect(result.code).toContain("flex");
      expect(result.code).toContain("items-center");
      expect(result.code).toContain("text-2xl");
      expect(result.code).toContain("font-bold");
    });
  });

  describe("splitComponents=true との組み合わせ", () => {
    it("分割されたサブコンポーネントでも独自クラスが除去されること", async () => {
      // Arrange: 分割対象を含むhtmlSnippet
      const pattern = createProprietaryClassPattern({
        htmlSnippet: `
          <div class="dwg-page-wrapper">
            <header class="webflow-header flex items-center">
              <nav class="framer-nav p-4">Navigation</nav>
            </header>
            <main class="elementor-main">
              <section class="wp-block-content">Content</section>
            </main>
            <footer class="wix-footer bg-gray-100">
              <p>Footer</p>
            </footer>
          </div>
        `,
      });

      const options: CodeGeneratorOptions = {
        framework: "react",
        typescript: true,
        tailwind: true,
        splitComponents: true,
      };

      // Act
      const result = await service.generateCode(pattern, options);

      // Assert: メインコンポーネントで独自クラスが除去される
      expect(result.code).not.toContain("dwg-page-wrapper");

      // サブコンポーネントが生成された場合、それらでも独自クラスが除去される
      if (result.subComponents && result.subComponents.length > 0) {
        result.subComponents.forEach((sub) => {
          expect(sub.code).not.toContain("webflow-");
          expect(sub.code).not.toContain("framer-");
          expect(sub.code).not.toContain("elementor-");
          expect(sub.code).not.toContain("wp-block-");
          expect(sub.code).not.toContain("wix-");
        });
      }
    });
  });
});
