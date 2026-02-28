// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tailwind CSS 最適化テスト
 * TDD Red: Tailwindクラス最適化のテストを先に作成
 *
 * REFTRIX-CODEGEN-01: Tailwind CSSクラス最適化
 * - インラインスタイル（style={{}}）の完全変換
 * - TailwindCSS v4.1ベストプラクティス準拠
 * - 残余スタイルの最小化
 *
 * @module tests/unit/services/layout/tailwind-optimization.test
 */

import { describe, it, expect } from 'vitest';
import { convertHtmlToJsx } from '../../../../src/services/layout/html-to-jsx-converter';
import { mapStyleToTailwind } from '../../../../src/services/layout/style-to-tailwind-mapper';

// =====================================================
// インラインスタイル → Tailwindクラス変換テスト
// =====================================================

describe('Tailwind CSS最適化', () => {
  describe('convertHtmlToJsx with useTailwind option', () => {
    it('padding: 20pxをp-5に変換', () => {
      const html = '<div style="padding: 20px;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('p-5');
      expect(result).not.toContain('style=');
    });

    it('background-color: #fffをbg-whiteに変換', () => {
      const html = '<div style="background-color: #fff;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('bg-white');
      expect(result).not.toContain('style=');
    });

    it('background-color: whiteをbg-whiteに変換', () => {
      const html = '<div style="background-color: white;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('bg-white');
      expect(result).not.toContain('style=');
    });

    it('複数のスタイルプロパティを変換', () => {
      const html = '<div style="padding: 20px; background-color: white; display: flex;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('p-5');
      expect(result).toContain('bg-white');
      expect(result).toContain('flex');
      expect(result).not.toContain('style=');
    });

    it('既存のclass属性とマージ', () => {
      const html = '<div class="existing-class" style="padding: 20px;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('existing-class');
      expect(result).toContain('p-5');
      expect(result).toContain('className=');
    });

    it('class → classNameに変換', () => {
      const html = '<div class="my-class">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('className="my-class"');
      expect(result).not.toContain('class=');
    });

    it('変換できないスタイルは残余スタイルとして保持', () => {
      const html = '<div style="--custom-property: value; padding: 20px;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('p-5');
      // カスタムプロパティは残余スタイルとして保持される可能性がある
    });
  });

  describe('mapStyleToTailwind 変換精度', () => {
    describe('spacing（padding/margin）', () => {
      it('padding: 0 → p-0', () => {
        const result = mapStyleToTailwind({ padding: '0' });
        expect(result.tailwindClasses).toContain('p-0');
      });

      it('padding: 4px → p-1', () => {
        const result = mapStyleToTailwind({ padding: '4px' });
        expect(result.tailwindClasses).toContain('p-1');
      });

      it('padding: 8px → p-2', () => {
        const result = mapStyleToTailwind({ padding: '8px' });
        expect(result.tailwindClasses).toContain('p-2');
      });

      it('padding: 16px → p-4', () => {
        const result = mapStyleToTailwind({ padding: '16px' });
        expect(result.tailwindClasses).toContain('p-4');
      });

      it('padding: 20px → p-5', () => {
        const result = mapStyleToTailwind({ padding: '20px' });
        expect(result.tailwindClasses).toContain('p-5');
      });

      it('padding: 24px → p-6', () => {
        const result = mapStyleToTailwind({ padding: '24px' });
        expect(result.tailwindClasses).toContain('p-6');
      });

      it('padding: 32px → p-8', () => {
        const result = mapStyleToTailwind({ padding: '32px' });
        expect(result.tailwindClasses).toContain('p-8');
      });

      it('margin: auto → m-auto', () => {
        const result = mapStyleToTailwind({ margin: 'auto' });
        expect(result.tailwindClasses).toContain('m-auto');
      });

      it('margin-left: auto, margin-right: auto → mx-auto', () => {
        const result = mapStyleToTailwind({
          marginLeft: 'auto',
          marginRight: 'auto',
        });
        expect(result.tailwindClasses).toContain('mx-auto');
      });
    });

    describe('colors', () => {
      it('background-color: white → bg-white', () => {
        const result = mapStyleToTailwind({ backgroundColor: 'white' });
        expect(result.tailwindClasses).toContain('bg-white');
      });

      it('background-color: #ffffff → bg-white', () => {
        const result = mapStyleToTailwind({ backgroundColor: '#ffffff' });
        expect(result.tailwindClasses).toContain('bg-white');
      });

      it('background-color: #fff → bg-white', () => {
        const result = mapStyleToTailwind({ backgroundColor: '#fff' });
        expect(result.tailwindClasses).toContain('bg-white');
      });

      it('background-color: black → bg-black', () => {
        const result = mapStyleToTailwind({ backgroundColor: 'black' });
        expect(result.tailwindClasses).toContain('bg-black');
      });

      it('background-color: #000000 → bg-black', () => {
        const result = mapStyleToTailwind({ backgroundColor: '#000000' });
        expect(result.tailwindClasses).toContain('bg-black');
      });

      it('background-color: transparent → bg-transparent', () => {
        const result = mapStyleToTailwind({ backgroundColor: 'transparent' });
        expect(result.tailwindClasses).toContain('bg-transparent');
      });

      it('color: white → text-white', () => {
        const result = mapStyleToTailwind({ color: 'white' });
        expect(result.tailwindClasses).toContain('text-white');
      });

      it('color: #000 → text-black', () => {
        const result = mapStyleToTailwind({ color: '#000' });
        expect(result.tailwindClasses).toContain('text-black');
      });
    });

    describe('display', () => {
      it('display: flex → flex', () => {
        const result = mapStyleToTailwind({ display: 'flex' });
        expect(result.tailwindClasses).toContain('flex');
      });

      it('display: grid → grid', () => {
        const result = mapStyleToTailwind({ display: 'grid' });
        expect(result.tailwindClasses).toContain('grid');
      });

      it('display: none → hidden', () => {
        const result = mapStyleToTailwind({ display: 'none' });
        expect(result.tailwindClasses).toContain('hidden');
      });

      it('display: block → block', () => {
        const result = mapStyleToTailwind({ display: 'block' });
        expect(result.tailwindClasses).toContain('block');
      });

      it('display: inline-flex → inline-flex', () => {
        const result = mapStyleToTailwind({ display: 'inline-flex' });
        expect(result.tailwindClasses).toContain('inline-flex');
      });
    });

    describe('flexbox', () => {
      it('flex-direction: column → flex-col', () => {
        const result = mapStyleToTailwind({ flexDirection: 'column' });
        expect(result.tailwindClasses).toContain('flex-col');
      });

      it('flex-direction: row → flex-row', () => {
        const result = mapStyleToTailwind({ flexDirection: 'row' });
        expect(result.tailwindClasses).toContain('flex-row');
      });

      it('justify-content: center → justify-center', () => {
        const result = mapStyleToTailwind({ justifyContent: 'center' });
        expect(result.tailwindClasses).toContain('justify-center');
      });

      it('justify-content: space-between → justify-between', () => {
        const result = mapStyleToTailwind({ justifyContent: 'space-between' });
        expect(result.tailwindClasses).toContain('justify-between');
      });

      it('align-items: center → items-center', () => {
        const result = mapStyleToTailwind({ alignItems: 'center' });
        expect(result.tailwindClasses).toContain('items-center');
      });

      it('gap: 16px → gap-4', () => {
        const result = mapStyleToTailwind({ gap: '16px' });
        expect(result.tailwindClasses).toContain('gap-4');
      });

      it('flex-wrap: wrap → flex-wrap', () => {
        const result = mapStyleToTailwind({ flexWrap: 'wrap' });
        expect(result.tailwindClasses).toContain('flex-wrap');
      });
    });

    describe('sizing', () => {
      it('width: 100% → w-full', () => {
        const result = mapStyleToTailwind({ width: '100%' });
        expect(result.tailwindClasses).toContain('w-full');
      });

      it('width: 50% → w-1/2', () => {
        const result = mapStyleToTailwind({ width: '50%' });
        expect(result.tailwindClasses).toContain('w-1/2');
      });

      it('width: auto → w-auto', () => {
        const result = mapStyleToTailwind({ width: 'auto' });
        expect(result.tailwindClasses).toContain('w-auto');
      });

      it('height: 100% → h-full', () => {
        const result = mapStyleToTailwind({ height: '100%' });
        expect(result.tailwindClasses).toContain('h-full');
      });

      it('height: 100vh → h-screen', () => {
        const result = mapStyleToTailwind({ height: '100vh' });
        expect(result.tailwindClasses).toContain('h-screen');
      });

      it('min-height: 100vh → min-h-screen', () => {
        const result = mapStyleToTailwind({ minHeight: '100vh' });
        expect(result.tailwindClasses).toContain('min-h-screen');
      });

      it('max-width: 1280px → max-w-7xl (近似値)', () => {
        const result = mapStyleToTailwind({ maxWidth: '1280px' });
        expect(result.tailwindClasses).toContain('max-w-7xl');
      });
    });

    describe('typography', () => {
      it('font-size: 16px → text-base', () => {
        const result = mapStyleToTailwind({ fontSize: '16px' });
        expect(result.tailwindClasses).toContain('text-base');
      });

      it('font-size: 14px → text-sm', () => {
        const result = mapStyleToTailwind({ fontSize: '14px' });
        expect(result.tailwindClasses).toContain('text-sm');
      });

      it('font-size: 18px → text-lg', () => {
        const result = mapStyleToTailwind({ fontSize: '18px' });
        expect(result.tailwindClasses).toContain('text-lg');
      });

      it('font-weight: bold → font-bold', () => {
        const result = mapStyleToTailwind({ fontWeight: 'bold' });
        expect(result.tailwindClasses).toContain('font-bold');
      });

      it('font-weight: 700 → font-bold', () => {
        const result = mapStyleToTailwind({ fontWeight: '700' });
        expect(result.tailwindClasses).toContain('font-bold');
      });

      it('font-weight: 600 → font-semibold', () => {
        const result = mapStyleToTailwind({ fontWeight: '600' });
        expect(result.tailwindClasses).toContain('font-semibold');
      });

      it('text-align: center → text-center', () => {
        const result = mapStyleToTailwind({ textAlign: 'center' });
        expect(result.tailwindClasses).toContain('text-center');
      });

      it('line-height: 1.5 → leading-normal', () => {
        const result = mapStyleToTailwind({ lineHeight: '1.5' });
        expect(result.tailwindClasses).toContain('leading-normal');
      });
    });

    describe('border', () => {
      it('border-radius: 8px → rounded-lg', () => {
        const result = mapStyleToTailwind({ borderRadius: '8px' });
        expect(result.tailwindClasses).toContain('rounded-lg');
      });

      it('border-radius: 4px → rounded', () => {
        const result = mapStyleToTailwind({ borderRadius: '4px' });
        expect(result.tailwindClasses).toContain('rounded');
      });

      it('border-radius: 9999px → rounded-full', () => {
        const result = mapStyleToTailwind({ borderRadius: '9999px' });
        expect(result.tailwindClasses).toContain('rounded-full');
      });

      it('border-radius: 50% → rounded-full', () => {
        const result = mapStyleToTailwind({ borderRadius: '50%' });
        expect(result.tailwindClasses).toContain('rounded-full');
      });
    });

    describe('position', () => {
      it('position: relative → relative', () => {
        const result = mapStyleToTailwind({ position: 'relative' });
        expect(result.tailwindClasses).toContain('relative');
      });

      it('position: absolute → absolute', () => {
        const result = mapStyleToTailwind({ position: 'absolute' });
        expect(result.tailwindClasses).toContain('absolute');
      });

      it('position: fixed → fixed', () => {
        const result = mapStyleToTailwind({ position: 'fixed' });
        expect(result.tailwindClasses).toContain('fixed');
      });

      it('position: sticky → sticky', () => {
        const result = mapStyleToTailwind({ position: 'sticky' });
        expect(result.tailwindClasses).toContain('sticky');
      });
    });

    describe('その他', () => {
      it('opacity: 0.5 → opacity-50', () => {
        const result = mapStyleToTailwind({ opacity: '0.5' });
        expect(result.tailwindClasses).toContain('opacity-50');
      });

      it('overflow: hidden → overflow-hidden', () => {
        const result = mapStyleToTailwind({ overflow: 'hidden' });
        expect(result.tailwindClasses).toContain('overflow-hidden');
      });

      it('z-index: 10 → z-10', () => {
        const result = mapStyleToTailwind({ zIndex: '10' });
        expect(result.tailwindClasses).toContain('z-10');
      });

      it('cursor: pointer → cursor-pointer', () => {
        const result = mapStyleToTailwind({ cursor: 'pointer' });
        expect(result.tailwindClasses).toContain('cursor-pointer');
      });
    });
  });

  describe('複合変換テスト', () => {
    it('期待される変換: style={{padding: "20px", backgroundColor: "#fff"}} → className="p-5 bg-white"', () => {
      const html = '<div style="padding: 20px; background-color: #fff;"><div>Hero Section</div></div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('p-5');
      expect(result).toContain('bg-white');
      expect(result).not.toContain('style={{');
    });

    it('完全な変換後はstyle属性が残らない', () => {
      const html = '<div style="display: flex; justify-content: center; align-items: center; padding: 16px; background-color: white;">Content</div>';
      const result = convertHtmlToJsx(html, { useTailwind: true });
      expect(result).toContain('flex');
      expect(result).toContain('justify-center');
      expect(result).toContain('items-center');
      expect(result).toContain('p-4');
      expect(result).toContain('bg-white');
      // 完全に変換できた場合はstyle属性が残らない
      expect(result).not.toContain('style={{}}');
    });
  });
});
