// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HTML to JSX Converter Tests
 *
 * TDD Red Phase: テストを先に書き、実装を後から追加する
 *
 * テスト対象:
 * - 独自クラス名（dwg-*, etc.）の除去
 * - インラインスタイルからTailwindCSSへの変換
 * - セマンティックHTML構造の保持
 * - Props抽出（可変コンテンツ）
 *
 * @module tests/services/layout/html-to-jsx-converter.test
 */

import { describe, it, expect } from 'vitest';
import { convertHtmlToJsx } from '../../../src/services/layout/html-to-jsx-converter';

describe('convertHtmlToJsx', () => {
  describe('基本変換', () => {
    it('class → className に変換される', () => {
      const html = '<div class="container">Hello</div>';
      const result = convertHtmlToJsx(html);
      expect(result).toContain('className="container"');
      expect(result).not.toContain('class=');
    });

    it('自己閉じタグが正しく処理される', () => {
      const html = '<img src="test.jpg" alt="Test">';
      const result = convertHtmlToJsx(html);
      expect(result).toBe('<img src="test.jpg" alt="Test" />');
    });

    it('for → htmlFor に変換される', () => {
      const html = '<label for="email">Email</label>';
      const result = convertHtmlToJsx(html);
      expect(result).toContain('htmlFor="email"');
    });
  });

  describe('インラインスタイル変換（useTailwind: true）', () => {
    it('display: flex → flex クラスに変換される', () => {
      const html = '<div style="display: flex;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('className="');
      expect(result).toContain('flex');
      expect(result).not.toContain('style=');
    });

    it('justify-content: center → justify-center に変換される', () => {
      const html = '<div style="display: flex; justify-content: center;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('flex');
      expect(result).toContain('justify-center');
    });

    it('align-items: center → items-center に変換される', () => {
      const html = '<div style="display: flex; align-items: center;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('items-center');
    });

    it('padding: 16px → p-4 に変換される', () => {
      const html = '<div style="padding: 16px;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('p-4');
    });

    it('margin: 8px → m-2 に変換される', () => {
      const html = '<div style="margin: 8px;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('m-2');
    });

    it('color: white → text-white に変換される', () => {
      const html = '<p style="color: white;">Text</p>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('text-white');
    });

    it('background-color: black → bg-black に変換される', () => {
      const html = '<div style="background-color: black;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('bg-black');
    });

    it('font-size: 24px → text-2xl に変換される', () => {
      const html = '<h1 style="font-size: 24px;">Title</h1>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('text-2xl');
    });

    it('font-weight: bold → font-bold に変換される', () => {
      const html = '<p style="font-weight: bold;">Bold text</p>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('font-bold');
    });

    it('border-radius: 8px → rounded-lg に変換される', () => {
      const html = '<div style="border-radius: 8px;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('rounded-lg');
    });

    it('複合スタイルが正しく変換される', () => {
      const html = '<div style="display: flex; justify-content: center; align-items: center; padding: 16px; background-color: black;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('flex');
      expect(result).toContain('justify-center');
      expect(result).toContain('items-center');
      expect(result).toContain('p-4');
      expect(result).toContain('bg-black');
    });

    it('変換できないスタイルは style 属性として残る', () => {
      const html = '<div style="--custom-var: 10px; display: flex;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('flex');
      // CSS変数は変換できないのでstyleとして残る
    });
  });

  describe('独自クラス名の除去（新機能）', () => {
    it('dwg-* クラスが除去される', () => {
      const html = '<div class="dwg-hero dwg-container flex items-center">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
      });
      expect(result).not.toContain('dwg-hero');
      expect(result).not.toContain('dwg-container');
      expect(result).toContain('flex');
      expect(result).toContain('items-center');
    });

    it('webflow-* クラスが除去される', () => {
      const html = '<div class="webflow-section webflow-w-container">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
      });
      expect(result).not.toContain('webflow-section');
      expect(result).not.toContain('webflow-w-container');
    });

    it('w-* (Webflow) クラスが除去される', () => {
      const html = '<div class="w-container w-nav-menu flex">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
      });
      expect(result).not.toContain('w-container');
      expect(result).not.toContain('w-nav-menu');
      expect(result).toContain('flex');
    });

    it('framer-* クラスが除去される', () => {
      const html = '<div class="framer-1abc framer-2def p-4">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
      });
      expect(result).not.toContain('framer-1abc');
      expect(result).not.toContain('framer-2def');
      expect(result).toContain('p-4');
    });

    it('wix-* クラスが除去される', () => {
      const html = '<div class="wix-element wix-comp-1 bg-white">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
      });
      expect(result).not.toContain('wix-element');
      expect(result).not.toContain('wix-comp-1');
      expect(result).toContain('bg-white');
    });

    it('squarespace-* クラスが除去される', () => {
      const html = '<div class="squarespace-block squarespace-header text-center">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
      });
      expect(result).not.toContain('squarespace-block');
      expect(result).not.toContain('squarespace-header');
      expect(result).toContain('text-center');
    });

    it('shopify-* クラスが除去される', () => {
      const html = '<div class="shopify-section shopify-block-1 mx-auto">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
      });
      expect(result).not.toContain('shopify-section');
      expect(result).not.toContain('shopify-block-1');
      expect(result).toContain('mx-auto');
    });

    it('wordpress (wp-) クラスが除去される', () => {
      const html = '<div class="wp-block-group wp-element-button mt-4">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
      });
      expect(result).not.toContain('wp-block-group');
      expect(result).not.toContain('wp-element-button');
      expect(result).toContain('mt-4');
    });

    it('elementor-* クラスが除去される', () => {
      const html = '<div class="elementor-element elementor-widget rounded-lg">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
      });
      expect(result).not.toContain('elementor-element');
      expect(result).not.toContain('elementor-widget');
      expect(result).toContain('rounded-lg');
    });

    it('カスタムプレフィックスリストで除去できる', () => {
      const html = '<div class="my-app-hero my-app-btn custom-class">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
        proprietaryClassPrefixes: ['my-app-'],
      });
      expect(result).not.toContain('my-app-hero');
      expect(result).not.toContain('my-app-btn');
      expect(result).toContain('custom-class');
    });

    it('すべての独自クラスが除去されても className は削除されない（空文字列対策）', () => {
      const html = '<div class="dwg-hero dwg-container">Content</div>';
      const result = convertHtmlToJsx(html, {
        useTailwind: true,
        removeProprietaryClasses: true,
      });
      // className が空の場合は属性自体を削除
      expect(result).not.toContain('className=""');
      expect(result).toBe('<div>Content</div>');
    });
  });

  describe('セマンティックHTML保持', () => {
    it('section タグが保持される', () => {
      const html = '<section class="hero"><h1>Title</h1></section>';
      const result = convertHtmlToJsx(html);
      expect(result).toContain('<section');
      expect(result).toContain('</section>');
    });

    it('article タグが保持される', () => {
      const html = '<article><p>Content</p></article>';
      const result = convertHtmlToJsx(html);
      expect(result).toContain('<article');
      expect(result).toContain('</article>');
    });

    it('header タグが保持される', () => {
      const html = '<header><nav>Nav</nav></header>';
      const result = convertHtmlToJsx(html);
      expect(result).toContain('<header');
      expect(result).toContain('</header>');
    });

    it('aria-label 属性が保持される', () => {
      const html = '<button aria-label="Close">X</button>';
      const result = convertHtmlToJsx(html);
      expect(result).toContain('aria-label="Close"');
    });

    it('role 属性が保持される', () => {
      const html = '<div role="navigation">Nav</div>';
      const result = convertHtmlToJsx(html);
      expect(result).toContain('role="navigation"');
    });
  });

  describe('セキュリティ', () => {
    it('onclick 属性が除去される', () => {
      const html = '<button onclick="alert(1)">Click</button>';
      const result = convertHtmlToJsx(html);
      expect(result).not.toContain('onclick');
      expect(result).not.toContain('alert');
    });

    it('script タグが除去される', () => {
      const html = '<div><script>alert(1)</script><p>Hello</p></div>';
      const result = convertHtmlToJsx(html);
      expect(result).not.toContain('<script');
      expect(result).not.toContain('alert');
      expect(result).toContain('<p>Hello</p>');
    });

    it('onerror 属性が除去される', () => {
      const html = '<img src="x" onerror="alert(1)">';
      const result = convertHtmlToJsx(html);
      expect(result).not.toContain('onerror');
    });
  });

  describe('pretty オプション', () => {
    it('pretty: true で整形出力される', () => {
      const html = '<div><p>Hello</p><p>World</p></div>';
      const result = convertHtmlToJsx(html, { pretty: true });
      expect(result).toContain('\n');
    });

    it('pretty: false（デフォルト）で1行出力される', () => {
      const html = '<div><p>Hello</p></div>';
      const result = convertHtmlToJsx(html);
      expect(result).toBe('<div><p>Hello</p></div>');
    });
  });

  describe('wrapInFragment オプション', () => {
    it('複数ルート要素をフラグメントでラップする', () => {
      const html = '<p>First</p><p>Second</p>';
      const result = convertHtmlToJsx(html, { wrapInFragment: true });
      expect(result).toContain('<>');
      expect(result).toContain('</>');
    });
  });

  describe('TailwindCSS v4.1 対応', () => {
    it('gap: 16px → gap-4 に変換される', () => {
      const html = '<div style="display: flex; gap: 16px;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('gap-4');
    });

    it('grid-template-columns が grid-cols-* に変換される', () => {
      const html = '<div style="display: grid; grid-template-columns: repeat(3, 1fr);">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('grid');
      expect(result).toContain('grid-cols-3');
    });

    it('flex-direction: column → flex-col に変換される', () => {
      const html = '<div style="display: flex; flex-direction: column;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('flex');
      expect(result).toContain('flex-col');
    });

    it('max-width: 1280px → max-w-7xl に変換される', () => {
      const html = '<div style="max-width: 1280px;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('max-w-7xl');
    });

    it('position: relative → relative に変換される', () => {
      const html = '<div style="position: relative;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('relative');
    });

    it('position: absolute → absolute に変換される', () => {
      const html = '<div style="position: absolute;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('absolute');
    });

    it('overflow: hidden → overflow-hidden に変換される', () => {
      const html = '<div style="overflow: hidden;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('overflow-hidden');
    });

    it('z-index: 10 → z-10 に変換される', () => {
      const html = '<div style="z-index: 10;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('z-10');
    });

    it('text-align: center → text-center に変換される', () => {
      const html = '<p style="text-align: center;">Text</p>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('text-center');
    });

    it('line-height: 1.5 → leading-normal に変換される', () => {
      const html = '<p style="line-height: 1.5;">Text</p>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('leading-normal');
    });
  });
});
