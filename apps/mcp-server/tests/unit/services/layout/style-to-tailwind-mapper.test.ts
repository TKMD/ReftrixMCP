// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Style to TailwindCSS Mapper Unit Tests
 *
 * TDD Red Phase: テストを先に定義
 *
 * インラインスタイルをTailwindCSSユーティリティクラスに変換するマッパーのテスト
 *
 * @module tests/unit/services/layout/style-to-tailwind-mapper.test
 */

import { describe, it, expect } from 'vitest';
import {
  mapStyleToTailwind,
  type StyleToTailwindResult,
} from '../../../../src/services/layout/style-to-tailwind-mapper';

describe('style-to-tailwind-mapper', () => {
  describe('mapStyleToTailwind', () => {
    // ==========================================================
    // 1. display系（flex, grid, block, none）
    // ==========================================================
    describe('display系の変換', () => {
      it('display: flex → flex', () => {
        const result = mapStyleToTailwind({ display: 'flex' });
        expect(result.tailwindClasses).toContain('flex');
        expect(result.remainingStyles).not.toHaveProperty('display');
      });

      it('display: grid → grid', () => {
        const result = mapStyleToTailwind({ display: 'grid' });
        expect(result.tailwindClasses).toContain('grid');
        expect(result.remainingStyles).not.toHaveProperty('display');
      });

      it('display: block → block', () => {
        const result = mapStyleToTailwind({ display: 'block' });
        expect(result.tailwindClasses).toContain('block');
        expect(result.remainingStyles).not.toHaveProperty('display');
      });

      it('display: inline → inline', () => {
        const result = mapStyleToTailwind({ display: 'inline' });
        expect(result.tailwindClasses).toContain('inline');
        expect(result.remainingStyles).not.toHaveProperty('display');
      });

      it('display: inline-block → inline-block', () => {
        const result = mapStyleToTailwind({ display: 'inline-block' });
        expect(result.tailwindClasses).toContain('inline-block');
        expect(result.remainingStyles).not.toHaveProperty('display');
      });

      it('display: inline-flex → inline-flex', () => {
        const result = mapStyleToTailwind({ display: 'inline-flex' });
        expect(result.tailwindClasses).toContain('inline-flex');
        expect(result.remainingStyles).not.toHaveProperty('display');
      });

      it('display: none → hidden', () => {
        const result = mapStyleToTailwind({ display: 'none' });
        expect(result.tailwindClasses).toContain('hidden');
        expect(result.remainingStyles).not.toHaveProperty('display');
      });
    });

    // ==========================================================
    // 2. flexbox系（direction, justify, align, gap）
    // ==========================================================
    describe('flexbox系の変換', () => {
      describe('flex-direction', () => {
        it('flex-direction: row → flex-row', () => {
          const result = mapStyleToTailwind({ flexDirection: 'row' });
          expect(result.tailwindClasses).toContain('flex-row');
          expect(result.remainingStyles).not.toHaveProperty('flexDirection');
        });

        it('flex-direction: column → flex-col', () => {
          const result = mapStyleToTailwind({ flexDirection: 'column' });
          expect(result.tailwindClasses).toContain('flex-col');
          expect(result.remainingStyles).not.toHaveProperty('flexDirection');
        });

        it('flex-direction: row-reverse → flex-row-reverse', () => {
          const result = mapStyleToTailwind({ flexDirection: 'row-reverse' });
          expect(result.tailwindClasses).toContain('flex-row-reverse');
          expect(result.remainingStyles).not.toHaveProperty('flexDirection');
        });

        it('flex-direction: column-reverse → flex-col-reverse', () => {
          const result = mapStyleToTailwind({ flexDirection: 'column-reverse' });
          expect(result.tailwindClasses).toContain('flex-col-reverse');
          expect(result.remainingStyles).not.toHaveProperty('flexDirection');
        });
      });

      describe('justify-content', () => {
        it('justify-content: flex-start → justify-start', () => {
          const result = mapStyleToTailwind({ justifyContent: 'flex-start' });
          expect(result.tailwindClasses).toContain('justify-start');
          expect(result.remainingStyles).not.toHaveProperty('justifyContent');
        });

        it('justify-content: center → justify-center', () => {
          const result = mapStyleToTailwind({ justifyContent: 'center' });
          expect(result.tailwindClasses).toContain('justify-center');
          expect(result.remainingStyles).not.toHaveProperty('justifyContent');
        });

        it('justify-content: flex-end → justify-end', () => {
          const result = mapStyleToTailwind({ justifyContent: 'flex-end' });
          expect(result.tailwindClasses).toContain('justify-end');
          expect(result.remainingStyles).not.toHaveProperty('justifyContent');
        });

        it('justify-content: space-between → justify-between', () => {
          const result = mapStyleToTailwind({ justifyContent: 'space-between' });
          expect(result.tailwindClasses).toContain('justify-between');
          expect(result.remainingStyles).not.toHaveProperty('justifyContent');
        });

        it('justify-content: space-around → justify-around', () => {
          const result = mapStyleToTailwind({ justifyContent: 'space-around' });
          expect(result.tailwindClasses).toContain('justify-around');
          expect(result.remainingStyles).not.toHaveProperty('justifyContent');
        });

        it('justify-content: space-evenly → justify-evenly', () => {
          const result = mapStyleToTailwind({ justifyContent: 'space-evenly' });
          expect(result.tailwindClasses).toContain('justify-evenly');
          expect(result.remainingStyles).not.toHaveProperty('justifyContent');
        });
      });

      describe('align-items', () => {
        it('align-items: flex-start → items-start', () => {
          const result = mapStyleToTailwind({ alignItems: 'flex-start' });
          expect(result.tailwindClasses).toContain('items-start');
          expect(result.remainingStyles).not.toHaveProperty('alignItems');
        });

        it('align-items: center → items-center', () => {
          const result = mapStyleToTailwind({ alignItems: 'center' });
          expect(result.tailwindClasses).toContain('items-center');
          expect(result.remainingStyles).not.toHaveProperty('alignItems');
        });

        it('align-items: flex-end → items-end', () => {
          const result = mapStyleToTailwind({ alignItems: 'flex-end' });
          expect(result.tailwindClasses).toContain('items-end');
          expect(result.remainingStyles).not.toHaveProperty('alignItems');
        });

        it('align-items: stretch → items-stretch', () => {
          const result = mapStyleToTailwind({ alignItems: 'stretch' });
          expect(result.tailwindClasses).toContain('items-stretch');
          expect(result.remainingStyles).not.toHaveProperty('alignItems');
        });

        it('align-items: baseline → items-baseline', () => {
          const result = mapStyleToTailwind({ alignItems: 'baseline' });
          expect(result.tailwindClasses).toContain('items-baseline');
          expect(result.remainingStyles).not.toHaveProperty('alignItems');
        });
      });

      describe('flex-wrap', () => {
        it('flex-wrap: wrap → flex-wrap', () => {
          const result = mapStyleToTailwind({ flexWrap: 'wrap' });
          expect(result.tailwindClasses).toContain('flex-wrap');
          expect(result.remainingStyles).not.toHaveProperty('flexWrap');
        });

        it('flex-wrap: nowrap → flex-nowrap', () => {
          const result = mapStyleToTailwind({ flexWrap: 'nowrap' });
          expect(result.tailwindClasses).toContain('flex-nowrap');
          expect(result.remainingStyles).not.toHaveProperty('flexWrap');
        });

        it('flex-wrap: wrap-reverse → flex-wrap-reverse', () => {
          const result = mapStyleToTailwind({ flexWrap: 'wrap-reverse' });
          expect(result.tailwindClasses).toContain('flex-wrap-reverse');
          expect(result.remainingStyles).not.toHaveProperty('flexWrap');
        });
      });

      describe('gap', () => {
        it('gap: 0 → gap-0', () => {
          const result = mapStyleToTailwind({ gap: '0' });
          expect(result.tailwindClasses).toContain('gap-0');
          expect(result.remainingStyles).not.toHaveProperty('gap');
        });

        it('gap: 4px → gap-1', () => {
          const result = mapStyleToTailwind({ gap: '4px' });
          expect(result.tailwindClasses).toContain('gap-1');
          expect(result.remainingStyles).not.toHaveProperty('gap');
        });

        it('gap: 8px → gap-2', () => {
          const result = mapStyleToTailwind({ gap: '8px' });
          expect(result.tailwindClasses).toContain('gap-2');
          expect(result.remainingStyles).not.toHaveProperty('gap');
        });

        it('gap: 16px → gap-4', () => {
          const result = mapStyleToTailwind({ gap: '16px' });
          expect(result.tailwindClasses).toContain('gap-4');
          expect(result.remainingStyles).not.toHaveProperty('gap');
        });

        it('gap: 1rem → gap-4', () => {
          const result = mapStyleToTailwind({ gap: '1rem' });
          expect(result.tailwindClasses).toContain('gap-4');
          expect(result.remainingStyles).not.toHaveProperty('gap');
        });

        it('gap: 32px → gap-8', () => {
          const result = mapStyleToTailwind({ gap: '32px' });
          expect(result.tailwindClasses).toContain('gap-8');
          expect(result.remainingStyles).not.toHaveProperty('gap');
        });

        it('カスタムgap値はstyleとして残す', () => {
          const result = mapStyleToTailwind({ gap: '13px' });
          expect(result.tailwindClasses).not.toContain('gap-');
          expect(result.remainingStyles).toHaveProperty('gap', '13px');
        });
      });
    });

    // ==========================================================
    // 3. spacing系（padding, margin）
    // ==========================================================
    describe('spacing系の変換', () => {
      describe('padding', () => {
        it('padding: 0 → p-0', () => {
          const result = mapStyleToTailwind({ padding: '0' });
          expect(result.tailwindClasses).toContain('p-0');
          expect(result.remainingStyles).not.toHaveProperty('padding');
        });

        it('padding: 4px → p-1', () => {
          const result = mapStyleToTailwind({ padding: '4px' });
          expect(result.tailwindClasses).toContain('p-1');
          expect(result.remainingStyles).not.toHaveProperty('padding');
        });

        it('padding: 8px → p-2', () => {
          const result = mapStyleToTailwind({ padding: '8px' });
          expect(result.tailwindClasses).toContain('p-2');
          expect(result.remainingStyles).not.toHaveProperty('padding');
        });

        it('padding: 16px → p-4', () => {
          const result = mapStyleToTailwind({ padding: '16px' });
          expect(result.tailwindClasses).toContain('p-4');
          expect(result.remainingStyles).not.toHaveProperty('padding');
        });

        it('padding: 1rem → p-4', () => {
          const result = mapStyleToTailwind({ padding: '1rem' });
          expect(result.tailwindClasses).toContain('p-4');
          expect(result.remainingStyles).not.toHaveProperty('padding');
        });

        it('paddingTop: 8px → pt-2', () => {
          const result = mapStyleToTailwind({ paddingTop: '8px' });
          expect(result.tailwindClasses).toContain('pt-2');
          expect(result.remainingStyles).not.toHaveProperty('paddingTop');
        });

        it('paddingBottom: 16px → pb-4', () => {
          const result = mapStyleToTailwind({ paddingBottom: '16px' });
          expect(result.tailwindClasses).toContain('pb-4');
          expect(result.remainingStyles).not.toHaveProperty('paddingBottom');
        });

        it('paddingLeft: 12px → pl-3', () => {
          const result = mapStyleToTailwind({ paddingLeft: '12px' });
          expect(result.tailwindClasses).toContain('pl-3');
          expect(result.remainingStyles).not.toHaveProperty('paddingLeft');
        });

        it('paddingRight: 24px → pr-6', () => {
          const result = mapStyleToTailwind({ paddingRight: '24px' });
          expect(result.tailwindClasses).toContain('pr-6');
          expect(result.remainingStyles).not.toHaveProperty('paddingRight');
        });

        it('paddingX（paddingInline）: 16px → px-4', () => {
          const result = mapStyleToTailwind({ paddingInline: '16px' });
          expect(result.tailwindClasses).toContain('px-4');
          expect(result.remainingStyles).not.toHaveProperty('paddingInline');
        });

        it('paddingY（paddingBlock）: 8px → py-2', () => {
          const result = mapStyleToTailwind({ paddingBlock: '8px' });
          expect(result.tailwindClasses).toContain('py-2');
          expect(result.remainingStyles).not.toHaveProperty('paddingBlock');
        });
      });

      describe('margin', () => {
        it('margin: 0 → m-0', () => {
          const result = mapStyleToTailwind({ margin: '0' });
          expect(result.tailwindClasses).toContain('m-0');
          expect(result.remainingStyles).not.toHaveProperty('margin');
        });

        it('margin: auto → m-auto', () => {
          const result = mapStyleToTailwind({ margin: 'auto' });
          expect(result.tailwindClasses).toContain('m-auto');
          expect(result.remainingStyles).not.toHaveProperty('margin');
        });

        it('margin: 8px → m-2', () => {
          const result = mapStyleToTailwind({ margin: '8px' });
          expect(result.tailwindClasses).toContain('m-2');
          expect(result.remainingStyles).not.toHaveProperty('margin');
        });

        it('marginTop: 16px → mt-4', () => {
          const result = mapStyleToTailwind({ marginTop: '16px' });
          expect(result.tailwindClasses).toContain('mt-4');
          expect(result.remainingStyles).not.toHaveProperty('marginTop');
        });

        it('marginBottom: 24px → mb-6', () => {
          const result = mapStyleToTailwind({ marginBottom: '24px' });
          expect(result.tailwindClasses).toContain('mb-6');
          expect(result.remainingStyles).not.toHaveProperty('marginBottom');
        });

        it('marginLeft: auto → ml-auto', () => {
          const result = mapStyleToTailwind({ marginLeft: 'auto' });
          expect(result.tailwindClasses).toContain('ml-auto');
          expect(result.remainingStyles).not.toHaveProperty('marginLeft');
        });

        it('marginRight: auto → mr-auto', () => {
          const result = mapStyleToTailwind({ marginRight: 'auto' });
          expect(result.tailwindClasses).toContain('mr-auto');
          expect(result.remainingStyles).not.toHaveProperty('marginRight');
        });

        it('marginX（marginInline）: auto → mx-auto', () => {
          const result = mapStyleToTailwind({ marginInline: 'auto' });
          expect(result.tailwindClasses).toContain('mx-auto');
          expect(result.remainingStyles).not.toHaveProperty('marginInline');
        });

        it('marginY（marginBlock）: 16px → my-4', () => {
          const result = mapStyleToTailwind({ marginBlock: '16px' });
          expect(result.tailwindClasses).toContain('my-4');
          expect(result.remainingStyles).not.toHaveProperty('marginBlock');
        });
      });
    });

    // ==========================================================
    // 4. sizing系（width, height）
    // ==========================================================
    describe('sizing系の変換', () => {
      describe('width', () => {
        it('width: 0 → w-0', () => {
          const result = mapStyleToTailwind({ width: '0' });
          expect(result.tailwindClasses).toContain('w-0');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('width: 100% → w-full', () => {
          const result = mapStyleToTailwind({ width: '100%' });
          expect(result.tailwindClasses).toContain('w-full');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('width: 50% → w-1/2', () => {
          const result = mapStyleToTailwind({ width: '50%' });
          expect(result.tailwindClasses).toContain('w-1/2');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('width: auto → w-auto', () => {
          const result = mapStyleToTailwind({ width: 'auto' });
          expect(result.tailwindClasses).toContain('w-auto');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('width: fit-content → w-fit', () => {
          const result = mapStyleToTailwind({ width: 'fit-content' });
          expect(result.tailwindClasses).toContain('w-fit');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('width: max-content → w-max', () => {
          const result = mapStyleToTailwind({ width: 'max-content' });
          expect(result.tailwindClasses).toContain('w-max');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('width: min-content → w-min', () => {
          const result = mapStyleToTailwind({ width: 'min-content' });
          expect(result.tailwindClasses).toContain('w-min');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('width: 100vw → w-screen', () => {
          const result = mapStyleToTailwind({ width: '100vw' });
          expect(result.tailwindClasses).toContain('w-screen');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('width: 64px → w-16', () => {
          const result = mapStyleToTailwind({ width: '64px' });
          expect(result.tailwindClasses).toContain('w-16');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('カスタムwidth値はstyleとして残す', () => {
          const result = mapStyleToTailwind({ width: '237px' });
          expect(result.remainingStyles).toHaveProperty('width', '237px');
        });
      });

      describe('height', () => {
        it('height: 0 → h-0', () => {
          const result = mapStyleToTailwind({ height: '0' });
          expect(result.tailwindClasses).toContain('h-0');
          expect(result.remainingStyles).not.toHaveProperty('height');
        });

        it('height: 100% → h-full', () => {
          const result = mapStyleToTailwind({ height: '100%' });
          expect(result.tailwindClasses).toContain('h-full');
          expect(result.remainingStyles).not.toHaveProperty('height');
        });

        it('height: auto → h-auto', () => {
          const result = mapStyleToTailwind({ height: 'auto' });
          expect(result.tailwindClasses).toContain('h-auto');
          expect(result.remainingStyles).not.toHaveProperty('height');
        });

        it('height: 100vh → h-screen', () => {
          const result = mapStyleToTailwind({ height: '100vh' });
          expect(result.tailwindClasses).toContain('h-screen');
          expect(result.remainingStyles).not.toHaveProperty('height');
        });

        it('height: 100dvh → h-dvh', () => {
          const result = mapStyleToTailwind({ height: '100dvh' });
          expect(result.tailwindClasses).toContain('h-dvh');
          expect(result.remainingStyles).not.toHaveProperty('height');
        });

        it('height: fit-content → h-fit', () => {
          const result = mapStyleToTailwind({ height: 'fit-content' });
          expect(result.tailwindClasses).toContain('h-fit');
          expect(result.remainingStyles).not.toHaveProperty('height');
        });

        it('height: 128px → h-32', () => {
          const result = mapStyleToTailwind({ height: '128px' });
          expect(result.tailwindClasses).toContain('h-32');
          expect(result.remainingStyles).not.toHaveProperty('height');
        });
      });

      describe('min/max sizing', () => {
        it('minWidth: 100% → min-w-full', () => {
          const result = mapStyleToTailwind({ minWidth: '100%' });
          expect(result.tailwindClasses).toContain('min-w-full');
          expect(result.remainingStyles).not.toHaveProperty('minWidth');
        });

        it('maxWidth: 100% → max-w-full', () => {
          const result = mapStyleToTailwind({ maxWidth: '100%' });
          expect(result.tailwindClasses).toContain('max-w-full');
          expect(result.remainingStyles).not.toHaveProperty('maxWidth');
        });

        it('minHeight: 100vh → min-h-screen', () => {
          const result = mapStyleToTailwind({ minHeight: '100vh' });
          expect(result.tailwindClasses).toContain('min-h-screen');
          expect(result.remainingStyles).not.toHaveProperty('minHeight');
        });

        it('maxHeight: 100% → max-h-full', () => {
          const result = mapStyleToTailwind({ maxHeight: '100%' });
          expect(result.tailwindClasses).toContain('max-h-full');
          expect(result.remainingStyles).not.toHaveProperty('maxHeight');
        });
      });
    });

    // ==========================================================
    // 5. color系（background-color, color）
    // ==========================================================
    describe('color系の変換', () => {
      describe('background-color', () => {
        it('backgroundColor: transparent → bg-transparent', () => {
          const result = mapStyleToTailwind({ backgroundColor: 'transparent' });
          expect(result.tailwindClasses).toContain('bg-transparent');
          expect(result.remainingStyles).not.toHaveProperty('backgroundColor');
        });

        it('backgroundColor: white → bg-white', () => {
          const result = mapStyleToTailwind({ backgroundColor: 'white' });
          expect(result.tailwindClasses).toContain('bg-white');
          expect(result.remainingStyles).not.toHaveProperty('backgroundColor');
        });

        it('backgroundColor: black → bg-black', () => {
          const result = mapStyleToTailwind({ backgroundColor: 'black' });
          expect(result.tailwindClasses).toContain('bg-black');
          expect(result.remainingStyles).not.toHaveProperty('backgroundColor');
        });

        it('backgroundColor: inherit → bg-inherit', () => {
          const result = mapStyleToTailwind({ backgroundColor: 'inherit' });
          expect(result.tailwindClasses).toContain('bg-inherit');
          expect(result.remainingStyles).not.toHaveProperty('backgroundColor');
        });

        it('backgroundColor: currentColor → bg-current', () => {
          const result = mapStyleToTailwind({ backgroundColor: 'currentColor' });
          expect(result.tailwindClasses).toContain('bg-current');
          expect(result.remainingStyles).not.toHaveProperty('backgroundColor');
        });

        it('カスタムbackground-color値はstyleとして残す', () => {
          const result = mapStyleToTailwind({ backgroundColor: '#ff5733' });
          expect(result.remainingStyles).toHaveProperty('backgroundColor', '#ff5733');
        });

        it('rgb()形式のbackground-color値はstyleとして残す', () => {
          const result = mapStyleToTailwind({ backgroundColor: 'rgb(255, 87, 51)' });
          expect(result.remainingStyles).toHaveProperty('backgroundColor', 'rgb(255, 87, 51)');
        });
      });

      describe('color', () => {
        it('color: transparent → text-transparent', () => {
          const result = mapStyleToTailwind({ color: 'transparent' });
          expect(result.tailwindClasses).toContain('text-transparent');
          expect(result.remainingStyles).not.toHaveProperty('color');
        });

        it('color: white → text-white', () => {
          const result = mapStyleToTailwind({ color: 'white' });
          expect(result.tailwindClasses).toContain('text-white');
          expect(result.remainingStyles).not.toHaveProperty('color');
        });

        it('color: black → text-black', () => {
          const result = mapStyleToTailwind({ color: 'black' });
          expect(result.tailwindClasses).toContain('text-black');
          expect(result.remainingStyles).not.toHaveProperty('color');
        });

        it('color: inherit → text-inherit', () => {
          const result = mapStyleToTailwind({ color: 'inherit' });
          expect(result.tailwindClasses).toContain('text-inherit');
          expect(result.remainingStyles).not.toHaveProperty('color');
        });

        it('color: currentColor → text-current', () => {
          const result = mapStyleToTailwind({ color: 'currentColor' });
          expect(result.tailwindClasses).toContain('text-current');
          expect(result.remainingStyles).not.toHaveProperty('color');
        });
      });
    });

    // ==========================================================
    // 6. typography系（font-size, font-weight）
    // ==========================================================
    describe('typography系の変換', () => {
      describe('font-size', () => {
        it('fontSize: 12px → text-xs', () => {
          const result = mapStyleToTailwind({ fontSize: '12px' });
          expect(result.tailwindClasses).toContain('text-xs');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 0.75rem → text-xs', () => {
          const result = mapStyleToTailwind({ fontSize: '0.75rem' });
          expect(result.tailwindClasses).toContain('text-xs');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 14px → text-sm', () => {
          const result = mapStyleToTailwind({ fontSize: '14px' });
          expect(result.tailwindClasses).toContain('text-sm');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 16px → text-base', () => {
          const result = mapStyleToTailwind({ fontSize: '16px' });
          expect(result.tailwindClasses).toContain('text-base');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 1rem → text-base', () => {
          const result = mapStyleToTailwind({ fontSize: '1rem' });
          expect(result.tailwindClasses).toContain('text-base');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 18px → text-lg', () => {
          const result = mapStyleToTailwind({ fontSize: '18px' });
          expect(result.tailwindClasses).toContain('text-lg');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 20px → text-xl', () => {
          const result = mapStyleToTailwind({ fontSize: '20px' });
          expect(result.tailwindClasses).toContain('text-xl');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 24px → text-2xl', () => {
          const result = mapStyleToTailwind({ fontSize: '24px' });
          expect(result.tailwindClasses).toContain('text-2xl');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 30px → text-3xl', () => {
          const result = mapStyleToTailwind({ fontSize: '30px' });
          expect(result.tailwindClasses).toContain('text-3xl');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 36px → text-4xl', () => {
          const result = mapStyleToTailwind({ fontSize: '36px' });
          expect(result.tailwindClasses).toContain('text-4xl');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 48px → text-5xl', () => {
          const result = mapStyleToTailwind({ fontSize: '48px' });
          expect(result.tailwindClasses).toContain('text-5xl');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 60px → text-6xl', () => {
          const result = mapStyleToTailwind({ fontSize: '60px' });
          expect(result.tailwindClasses).toContain('text-6xl');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('カスタムfontSize値はstyleとして残す', () => {
          const result = mapStyleToTailwind({ fontSize: '17px' });
          expect(result.remainingStyles).toHaveProperty('fontSize', '17px');
        });
      });

      describe('font-weight', () => {
        it('fontWeight: 100 → font-thin', () => {
          const result = mapStyleToTailwind({ fontWeight: '100' });
          expect(result.tailwindClasses).toContain('font-thin');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });

        it('fontWeight: 200 → font-extralight', () => {
          const result = mapStyleToTailwind({ fontWeight: '200' });
          expect(result.tailwindClasses).toContain('font-extralight');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });

        it('fontWeight: 300 → font-light', () => {
          const result = mapStyleToTailwind({ fontWeight: '300' });
          expect(result.tailwindClasses).toContain('font-light');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });

        it('fontWeight: 400 → font-normal', () => {
          const result = mapStyleToTailwind({ fontWeight: '400' });
          expect(result.tailwindClasses).toContain('font-normal');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });

        it('fontWeight: normal → font-normal', () => {
          const result = mapStyleToTailwind({ fontWeight: 'normal' });
          expect(result.tailwindClasses).toContain('font-normal');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });

        it('fontWeight: 500 → font-medium', () => {
          const result = mapStyleToTailwind({ fontWeight: '500' });
          expect(result.tailwindClasses).toContain('font-medium');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });

        it('fontWeight: 600 → font-semibold', () => {
          const result = mapStyleToTailwind({ fontWeight: '600' });
          expect(result.tailwindClasses).toContain('font-semibold');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });

        it('fontWeight: 700 → font-bold', () => {
          const result = mapStyleToTailwind({ fontWeight: '700' });
          expect(result.tailwindClasses).toContain('font-bold');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });

        it('fontWeight: bold → font-bold', () => {
          const result = mapStyleToTailwind({ fontWeight: 'bold' });
          expect(result.tailwindClasses).toContain('font-bold');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });

        it('fontWeight: 800 → font-extrabold', () => {
          const result = mapStyleToTailwind({ fontWeight: '800' });
          expect(result.tailwindClasses).toContain('font-extrabold');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });

        it('fontWeight: 900 → font-black', () => {
          const result = mapStyleToTailwind({ fontWeight: '900' });
          expect(result.tailwindClasses).toContain('font-black');
          expect(result.remainingStyles).not.toHaveProperty('fontWeight');
        });
      });

      describe('text-align', () => {
        it('textAlign: left → text-left', () => {
          const result = mapStyleToTailwind({ textAlign: 'left' });
          expect(result.tailwindClasses).toContain('text-left');
          expect(result.remainingStyles).not.toHaveProperty('textAlign');
        });

        it('textAlign: center → text-center', () => {
          const result = mapStyleToTailwind({ textAlign: 'center' });
          expect(result.tailwindClasses).toContain('text-center');
          expect(result.remainingStyles).not.toHaveProperty('textAlign');
        });

        it('textAlign: right → text-right', () => {
          const result = mapStyleToTailwind({ textAlign: 'right' });
          expect(result.tailwindClasses).toContain('text-right');
          expect(result.remainingStyles).not.toHaveProperty('textAlign');
        });

        it('textAlign: justify → text-justify', () => {
          const result = mapStyleToTailwind({ textAlign: 'justify' });
          expect(result.tailwindClasses).toContain('text-justify');
          expect(result.remainingStyles).not.toHaveProperty('textAlign');
        });
      });
    });

    // ==========================================================
    // 7. border系（border-radius）
    // ==========================================================
    describe('border系の変換', () => {
      describe('border-radius', () => {
        it('borderRadius: 0 → rounded-none', () => {
          const result = mapStyleToTailwind({ borderRadius: '0' });
          expect(result.tailwindClasses).toContain('rounded-none');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });

        it('borderRadius: 2px → rounded-sm', () => {
          const result = mapStyleToTailwind({ borderRadius: '2px' });
          expect(result.tailwindClasses).toContain('rounded-sm');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });

        it('borderRadius: 4px → rounded', () => {
          const result = mapStyleToTailwind({ borderRadius: '4px' });
          expect(result.tailwindClasses).toContain('rounded');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });

        it('borderRadius: 0.25rem → rounded', () => {
          const result = mapStyleToTailwind({ borderRadius: '0.25rem' });
          expect(result.tailwindClasses).toContain('rounded');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });

        it('borderRadius: 6px → rounded-md', () => {
          const result = mapStyleToTailwind({ borderRadius: '6px' });
          expect(result.tailwindClasses).toContain('rounded-md');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });

        it('borderRadius: 8px → rounded-lg', () => {
          const result = mapStyleToTailwind({ borderRadius: '8px' });
          expect(result.tailwindClasses).toContain('rounded-lg');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });

        it('borderRadius: 12px → rounded-xl', () => {
          const result = mapStyleToTailwind({ borderRadius: '12px' });
          expect(result.tailwindClasses).toContain('rounded-xl');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });

        it('borderRadius: 16px → rounded-2xl', () => {
          const result = mapStyleToTailwind({ borderRadius: '16px' });
          expect(result.tailwindClasses).toContain('rounded-2xl');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });

        it('borderRadius: 24px → rounded-3xl', () => {
          const result = mapStyleToTailwind({ borderRadius: '24px' });
          expect(result.tailwindClasses).toContain('rounded-3xl');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });

        it('borderRadius: 9999px → rounded-full', () => {
          const result = mapStyleToTailwind({ borderRadius: '9999px' });
          expect(result.tailwindClasses).toContain('rounded-full');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });

        it('borderRadius: 50% → rounded-full', () => {
          const result = mapStyleToTailwind({ borderRadius: '50%' });
          expect(result.tailwindClasses).toContain('rounded-full');
          expect(result.remainingStyles).not.toHaveProperty('borderRadius');
        });
      });
    });

    // ==========================================================
    // 8. position系
    // ==========================================================
    describe('position系の変換', () => {
      it('position: static → static', () => {
        const result = mapStyleToTailwind({ position: 'static' });
        expect(result.tailwindClasses).toContain('static');
        expect(result.remainingStyles).not.toHaveProperty('position');
      });

      it('position: relative → relative', () => {
        const result = mapStyleToTailwind({ position: 'relative' });
        expect(result.tailwindClasses).toContain('relative');
        expect(result.remainingStyles).not.toHaveProperty('position');
      });

      it('position: absolute → absolute', () => {
        const result = mapStyleToTailwind({ position: 'absolute' });
        expect(result.tailwindClasses).toContain('absolute');
        expect(result.remainingStyles).not.toHaveProperty('position');
      });

      it('position: fixed → fixed', () => {
        const result = mapStyleToTailwind({ position: 'fixed' });
        expect(result.tailwindClasses).toContain('fixed');
        expect(result.remainingStyles).not.toHaveProperty('position');
      });

      it('position: sticky → sticky', () => {
        const result = mapStyleToTailwind({ position: 'sticky' });
        expect(result.tailwindClasses).toContain('sticky');
        expect(result.remainingStyles).not.toHaveProperty('position');
      });
    });

    // ==========================================================
    // 9. opacity系
    // ==========================================================
    describe('opacity系の変換', () => {
      it('opacity: 0 → opacity-0', () => {
        const result = mapStyleToTailwind({ opacity: '0' });
        expect(result.tailwindClasses).toContain('opacity-0');
        expect(result.remainingStyles).not.toHaveProperty('opacity');
      });

      it('opacity: 0.05 → opacity-5', () => {
        const result = mapStyleToTailwind({ opacity: '0.05' });
        expect(result.tailwindClasses).toContain('opacity-5');
        expect(result.remainingStyles).not.toHaveProperty('opacity');
      });

      it('opacity: 0.1 → opacity-10', () => {
        const result = mapStyleToTailwind({ opacity: '0.1' });
        expect(result.tailwindClasses).toContain('opacity-10');
        expect(result.remainingStyles).not.toHaveProperty('opacity');
      });

      it('opacity: 0.25 → opacity-25', () => {
        const result = mapStyleToTailwind({ opacity: '0.25' });
        expect(result.tailwindClasses).toContain('opacity-25');
        expect(result.remainingStyles).not.toHaveProperty('opacity');
      });

      it('opacity: 0.5 → opacity-50', () => {
        const result = mapStyleToTailwind({ opacity: '0.5' });
        expect(result.tailwindClasses).toContain('opacity-50');
        expect(result.remainingStyles).not.toHaveProperty('opacity');
      });

      it('opacity: 0.75 → opacity-75', () => {
        const result = mapStyleToTailwind({ opacity: '0.75' });
        expect(result.tailwindClasses).toContain('opacity-75');
        expect(result.remainingStyles).not.toHaveProperty('opacity');
      });

      it('opacity: 1 → opacity-100', () => {
        const result = mapStyleToTailwind({ opacity: '1' });
        expect(result.tailwindClasses).toContain('opacity-100');
        expect(result.remainingStyles).not.toHaveProperty('opacity');
      });

      it('カスタムopacity値はstyleとして残す', () => {
        const result = mapStyleToTailwind({ opacity: '0.33' });
        expect(result.remainingStyles).toHaveProperty('opacity', '0.33');
      });
    });

    // ==========================================================
    // 10. 複合スタイルの変換
    // ==========================================================
    describe('複合スタイルの変換', () => {
      it('複数のスタイルを一度に変換できる', () => {
        const result = mapStyleToTailwind({
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '16px',
          padding: '24px',
          backgroundColor: 'white',
        });

        expect(result.tailwindClasses).toContain('flex');
        expect(result.tailwindClasses).toContain('flex-col');
        expect(result.tailwindClasses).toContain('justify-center');
        expect(result.tailwindClasses).toContain('items-center');
        expect(result.tailwindClasses).toContain('gap-4');
        expect(result.tailwindClasses).toContain('p-6');
        expect(result.tailwindClasses).toContain('bg-white');
        expect(Object.keys(result.remainingStyles)).toHaveLength(0);
      });

      it('変換可能なスタイルと不可能なスタイルを混在させて処理できる', () => {
        const result = mapStyleToTailwind({
          display: 'flex',
          width: '237px', // カスタム値
          backgroundColor: '#custom-color', // カスタム色
          padding: '16px',
        });

        expect(result.tailwindClasses).toContain('flex');
        expect(result.tailwindClasses).toContain('p-4');
        expect(result.remainingStyles).toHaveProperty('width', '237px');
        expect(result.remainingStyles).toHaveProperty('backgroundColor', '#custom-color');
      });

      it('カードコンポーネントのスタイルを変換できる', () => {
        const result = mapStyleToTailwind({
          display: 'flex',
          flexDirection: 'column',
          padding: '24px',
          borderRadius: '8px',
          backgroundColor: 'white',
          width: '100%',
          maxWidth: '100%',
        });

        expect(result.tailwindClasses).toContain('flex');
        expect(result.tailwindClasses).toContain('flex-col');
        expect(result.tailwindClasses).toContain('p-6');
        expect(result.tailwindClasses).toContain('rounded-lg');
        expect(result.tailwindClasses).toContain('bg-white');
        expect(result.tailwindClasses).toContain('w-full');
        expect(result.tailwindClasses).toContain('max-w-full');
      });
    });

    // ==========================================================
    // 11. 変換不可スタイルの保持
    // ==========================================================
    describe('変換不可スタイルの保持', () => {
      it('未対応のCSSプロパティはstyleとして残す', () => {
        const result = mapStyleToTailwind({
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
          transition: 'all 0.3s ease',
          transform: 'translateX(10px)',
        });

        expect(result.tailwindClasses).toHaveLength(0);
        expect(result.remainingStyles).toHaveProperty(
          'boxShadow',
          '0 4px 6px rgba(0, 0, 0, 0.1)'
        );
        expect(result.remainingStyles).toHaveProperty('transition', 'all 0.3s ease');
        expect(result.remainingStyles).toHaveProperty('transform', 'translateX(10px)');
      });

      it('CSS変数を含むスタイルはstyleとして残す', () => {
        const result = mapStyleToTailwind({
          backgroundColor: 'var(--primary-color)',
          padding: 'var(--spacing)',
        });

        expect(result.remainingStyles).toHaveProperty(
          'backgroundColor',
          'var(--primary-color)'
        );
        expect(result.remainingStyles).toHaveProperty('padding', 'var(--spacing)');
      });

      it('calc()を含むスタイルはstyleとして残す', () => {
        const result = mapStyleToTailwind({
          width: 'calc(100% - 20px)',
          height: 'calc(100vh - 60px)',
        });

        expect(result.remainingStyles).toHaveProperty('width', 'calc(100% - 20px)');
        expect(result.remainingStyles).toHaveProperty('height', 'calc(100vh - 60px)');
      });

      it('空のスタイルオブジェクトを処理できる', () => {
        const result = mapStyleToTailwind({});

        expect(result.tailwindClasses).toHaveLength(0);
        expect(Object.keys(result.remainingStyles)).toHaveLength(0);
      });
    });

    // ==========================================================
    // 12. overflow系
    // ==========================================================
    describe('overflow系の変換', () => {
      it('overflow: auto → overflow-auto', () => {
        const result = mapStyleToTailwind({ overflow: 'auto' });
        expect(result.tailwindClasses).toContain('overflow-auto');
        expect(result.remainingStyles).not.toHaveProperty('overflow');
      });

      it('overflow: hidden → overflow-hidden', () => {
        const result = mapStyleToTailwind({ overflow: 'hidden' });
        expect(result.tailwindClasses).toContain('overflow-hidden');
        expect(result.remainingStyles).not.toHaveProperty('overflow');
      });

      it('overflow: visible → overflow-visible', () => {
        const result = mapStyleToTailwind({ overflow: 'visible' });
        expect(result.tailwindClasses).toContain('overflow-visible');
        expect(result.remainingStyles).not.toHaveProperty('overflow');
      });

      it('overflow: scroll → overflow-scroll', () => {
        const result = mapStyleToTailwind({ overflow: 'scroll' });
        expect(result.tailwindClasses).toContain('overflow-scroll');
        expect(result.remainingStyles).not.toHaveProperty('overflow');
      });

      it('overflowX: auto → overflow-x-auto', () => {
        const result = mapStyleToTailwind({ overflowX: 'auto' });
        expect(result.tailwindClasses).toContain('overflow-x-auto');
        expect(result.remainingStyles).not.toHaveProperty('overflowX');
      });

      it('overflowY: hidden → overflow-y-hidden', () => {
        const result = mapStyleToTailwind({ overflowY: 'hidden' });
        expect(result.tailwindClasses).toContain('overflow-y-hidden');
        expect(result.remainingStyles).not.toHaveProperty('overflowY');
      });
    });

    // ==========================================================
    // 13. z-index系
    // ==========================================================
    describe('z-index系の変換', () => {
      it('zIndex: 0 → z-0', () => {
        const result = mapStyleToTailwind({ zIndex: '0' });
        expect(result.tailwindClasses).toContain('z-0');
        expect(result.remainingStyles).not.toHaveProperty('zIndex');
      });

      it('zIndex: 10 → z-10', () => {
        const result = mapStyleToTailwind({ zIndex: '10' });
        expect(result.tailwindClasses).toContain('z-10');
        expect(result.remainingStyles).not.toHaveProperty('zIndex');
      });

      it('zIndex: 20 → z-20', () => {
        const result = mapStyleToTailwind({ zIndex: '20' });
        expect(result.tailwindClasses).toContain('z-20');
        expect(result.remainingStyles).not.toHaveProperty('zIndex');
      });

      it('zIndex: 50 → z-50', () => {
        const result = mapStyleToTailwind({ zIndex: '50' });
        expect(result.tailwindClasses).toContain('z-50');
        expect(result.remainingStyles).not.toHaveProperty('zIndex');
      });

      it('zIndex: auto → z-auto', () => {
        const result = mapStyleToTailwind({ zIndex: 'auto' });
        expect(result.tailwindClasses).toContain('z-auto');
        expect(result.remainingStyles).not.toHaveProperty('zIndex');
      });

      it('カスタムzIndex値はstyleとして残す', () => {
        const result = mapStyleToTailwind({ zIndex: '999' });
        expect(result.remainingStyles).toHaveProperty('zIndex', '999');
      });
    });

    // ==========================================================
    // 14. cursor系
    // ==========================================================
    describe('cursor系の変換', () => {
      it('cursor: pointer → cursor-pointer', () => {
        const result = mapStyleToTailwind({ cursor: 'pointer' });
        expect(result.tailwindClasses).toContain('cursor-pointer');
        expect(result.remainingStyles).not.toHaveProperty('cursor');
      });

      it('cursor: default → cursor-default', () => {
        const result = mapStyleToTailwind({ cursor: 'default' });
        expect(result.tailwindClasses).toContain('cursor-default');
        expect(result.remainingStyles).not.toHaveProperty('cursor');
      });

      it('cursor: not-allowed → cursor-not-allowed', () => {
        const result = mapStyleToTailwind({ cursor: 'not-allowed' });
        expect(result.tailwindClasses).toContain('cursor-not-allowed');
        expect(result.remainingStyles).not.toHaveProperty('cursor');
      });

      it('cursor: wait → cursor-wait', () => {
        const result = mapStyleToTailwind({ cursor: 'wait' });
        expect(result.tailwindClasses).toContain('cursor-wait');
        expect(result.remainingStyles).not.toHaveProperty('cursor');
      });

      it('cursor: text → cursor-text', () => {
        const result = mapStyleToTailwind({ cursor: 'text' });
        expect(result.tailwindClasses).toContain('cursor-text');
        expect(result.remainingStyles).not.toHaveProperty('cursor');
      });

      it('cursor: move → cursor-move', () => {
        const result = mapStyleToTailwind({ cursor: 'move' });
        expect(result.tailwindClasses).toContain('cursor-move');
        expect(result.remainingStyles).not.toHaveProperty('cursor');
      });

      it('cursor: none → cursor-none', () => {
        const result = mapStyleToTailwind({ cursor: 'none' });
        expect(result.tailwindClasses).toContain('cursor-none');
        expect(result.remainingStyles).not.toHaveProperty('cursor');
      });
    });

    // ==========================================================
    // 15. pointer-events系
    // ==========================================================
    describe('pointer-events系の変換', () => {
      it('pointerEvents: none → pointer-events-none', () => {
        const result = mapStyleToTailwind({ pointerEvents: 'none' });
        expect(result.tailwindClasses).toContain('pointer-events-none');
        expect(result.remainingStyles).not.toHaveProperty('pointerEvents');
      });

      it('pointerEvents: auto → pointer-events-auto', () => {
        const result = mapStyleToTailwind({ pointerEvents: 'auto' });
        expect(result.tailwindClasses).toContain('pointer-events-auto');
        expect(result.remainingStyles).not.toHaveProperty('pointerEvents');
      });
    });

    // ==========================================================
    // 16. user-select系
    // ==========================================================
    describe('user-select系の変換', () => {
      it('userSelect: none → select-none', () => {
        const result = mapStyleToTailwind({ userSelect: 'none' });
        expect(result.tailwindClasses).toContain('select-none');
        expect(result.remainingStyles).not.toHaveProperty('userSelect');
      });

      it('userSelect: text → select-text', () => {
        const result = mapStyleToTailwind({ userSelect: 'text' });
        expect(result.tailwindClasses).toContain('select-text');
        expect(result.remainingStyles).not.toHaveProperty('userSelect');
      });

      it('userSelect: all → select-all', () => {
        const result = mapStyleToTailwind({ userSelect: 'all' });
        expect(result.tailwindClasses).toContain('select-all');
        expect(result.remainingStyles).not.toHaveProperty('userSelect');
      });

      it('userSelect: auto → select-auto', () => {
        const result = mapStyleToTailwind({ userSelect: 'auto' });
        expect(result.tailwindClasses).toContain('select-auto');
        expect(result.remainingStyles).not.toHaveProperty('userSelect');
      });
    });

    // ==========================================================
    // 17. レスポンシブブレークポイント自動生成
    // ==========================================================
    describe('レスポンシブブレークポイント自動生成', () => {
      describe('幅関連プロパティ（width）', () => {
        it('width: 1200px → max-w-7xl w-full（responsive: true）', () => {
          const result = mapStyleToTailwind({ width: '1200px' }, { responsive: true });
          expect(result.tailwindClasses).toContain('max-w-7xl');
          expect(result.tailwindClasses).toContain('w-full');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('width: 1024px → max-w-5xl w-full（responsive: true）', () => {
          const result = mapStyleToTailwind({ width: '1024px' }, { responsive: true });
          expect(result.tailwindClasses).toContain('max-w-5xl');
          expect(result.tailwindClasses).toContain('w-full');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('width: 768px → max-w-3xl w-full（responsive: true）', () => {
          const result = mapStyleToTailwind({ width: '768px' }, { responsive: true });
          expect(result.tailwindClasses).toContain('max-w-3xl');
          expect(result.tailwindClasses).toContain('w-full');
          expect(result.remainingStyles).not.toHaveProperty('width');
        });

        it('responsive: false の場合は固定幅をそのまま残す', () => {
          const result = mapStyleToTailwind({ width: '1200px' }, { responsive: false });
          expect(result.tailwindClasses).not.toContain('max-w-7xl');
          expect(result.tailwindClasses).not.toContain('w-full');
          expect(result.remainingStyles).toHaveProperty('width', '1200px');
        });

        it('デフォルトはresponsive: false（後方互換性）', () => {
          // mapStyleToTailwindのデフォルトはfalse（後方互換性のため）
          // layout.generate_codeツールから呼び出す際はresponsive: trueが渡される
          const result = mapStyleToTailwind({ width: '1200px' });
          expect(result.tailwindClasses).not.toContain('max-w-7xl');
          expect(result.remainingStyles).toHaveProperty('width', '1200px');
        });
      });

      describe('パディング（padding）', () => {
        it('padding: 40px → p-4 md:p-8 lg:p-10（responsive: true）', () => {
          const result = mapStyleToTailwind({ padding: '40px' }, { responsive: true });
          expect(result.tailwindClasses).toContain('p-4');
          expect(result.tailwindClasses).toContain('md:p-8');
          expect(result.tailwindClasses).toContain('lg:p-10');
          expect(result.remainingStyles).not.toHaveProperty('padding');
        });

        it('padding: 64px → p-6 md:p-12 lg:p-16（responsive: true）', () => {
          const result = mapStyleToTailwind({ padding: '64px' }, { responsive: true });
          expect(result.tailwindClasses).toContain('p-6');
          expect(result.tailwindClasses).toContain('md:p-12');
          expect(result.tailwindClasses).toContain('lg:p-16');
          expect(result.remainingStyles).not.toHaveProperty('padding');
        });

        it('padding: 16px は小さいのでそのまま p-4', () => {
          const result = mapStyleToTailwind({ padding: '16px' }, { responsive: true });
          expect(result.tailwindClasses).toContain('p-4');
          expect(result.tailwindClasses).not.toContain('md:p-');
          expect(result.tailwindClasses).not.toContain('lg:p-');
        });

        it('responsive: false の場合は単一クラスのみ', () => {
          const result = mapStyleToTailwind({ padding: '40px' }, { responsive: false });
          expect(result.tailwindClasses).toContain('p-10');
          expect(result.tailwindClasses).not.toContain('md:p-');
          expect(result.tailwindClasses).not.toContain('lg:p-');
        });
      });

      describe('フォントサイズ（fontSize）', () => {
        it('fontSize: 48px → text-3xl md:text-4xl lg:text-5xl（responsive: true）', () => {
          const result = mapStyleToTailwind({ fontSize: '48px' }, { responsive: true });
          expect(result.tailwindClasses).toContain('text-3xl');
          expect(result.tailwindClasses).toContain('md:text-4xl');
          expect(result.tailwindClasses).toContain('lg:text-5xl');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 60px → text-4xl md:text-5xl lg:text-6xl（responsive: true）', () => {
          const result = mapStyleToTailwind({ fontSize: '60px' }, { responsive: true });
          expect(result.tailwindClasses).toContain('text-4xl');
          expect(result.tailwindClasses).toContain('md:text-5xl');
          expect(result.tailwindClasses).toContain('lg:text-6xl');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 36px → text-2xl md:text-3xl lg:text-4xl（responsive: true）', () => {
          const result = mapStyleToTailwind({ fontSize: '36px' }, { responsive: true });
          expect(result.tailwindClasses).toContain('text-2xl');
          expect(result.tailwindClasses).toContain('md:text-3xl');
          expect(result.tailwindClasses).toContain('lg:text-4xl');
          expect(result.remainingStyles).not.toHaveProperty('fontSize');
        });

        it('fontSize: 16px は小さいのでそのまま text-base', () => {
          const result = mapStyleToTailwind({ fontSize: '16px' }, { responsive: true });
          expect(result.tailwindClasses).toContain('text-base');
          expect(result.tailwindClasses).not.toContain('md:text-');
          expect(result.tailwindClasses).not.toContain('lg:text-');
        });

        it('responsive: false の場合は単一クラスのみ', () => {
          const result = mapStyleToTailwind({ fontSize: '48px' }, { responsive: false });
          expect(result.tailwindClasses).toContain('text-5xl');
          expect(result.tailwindClasses).not.toContain('md:text-');
          expect(result.tailwindClasses).not.toContain('lg:text-');
        });
      });

      describe('フレックス方向（flexDirection）', () => {
        it('flexDirection: row → flex-col md:flex-row（responsive: true）', () => {
          const result = mapStyleToTailwind({ flexDirection: 'row' }, { responsive: true });
          expect(result.tailwindClasses).toContain('flex-col');
          expect(result.tailwindClasses).toContain('md:flex-row');
          expect(result.remainingStyles).not.toHaveProperty('flexDirection');
        });

        it('flexDirection: column はそのまま flex-col', () => {
          const result = mapStyleToTailwind({ flexDirection: 'column' }, { responsive: true });
          expect(result.tailwindClasses).toContain('flex-col');
          expect(result.tailwindClasses).not.toContain('md:flex-row');
        });

        it('responsive: false の場合は単一クラスのみ', () => {
          const result = mapStyleToTailwind({ flexDirection: 'row' }, { responsive: false });
          expect(result.tailwindClasses).toContain('flex-row');
          expect(result.tailwindClasses).not.toContain('flex-col');
          expect(result.tailwindClasses).not.toContain('md:flex-row');
        });
      });

      describe('複合スタイルのレスポンシブ変換', () => {
        it('ヒーローセクションの典型的なスタイルを変換', () => {
          const result = mapStyleToTailwind({
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '64px',
            fontSize: '48px',
            width: '1200px',
          }, { responsive: true });

          // flexDirection: row → flex-col md:flex-row
          expect(result.tailwindClasses).toContain('flex-col');
          expect(result.tailwindClasses).toContain('md:flex-row');

          // padding: 64px → p-6 md:p-12 lg:p-16
          expect(result.tailwindClasses).toContain('p-6');
          expect(result.tailwindClasses).toContain('md:p-12');
          expect(result.tailwindClasses).toContain('lg:p-16');

          // fontSize: 48px → text-3xl md:text-4xl lg:text-5xl
          expect(result.tailwindClasses).toContain('text-3xl');
          expect(result.tailwindClasses).toContain('md:text-4xl');
          expect(result.tailwindClasses).toContain('lg:text-5xl');

          // width: 1200px → max-w-7xl w-full
          expect(result.tailwindClasses).toContain('max-w-7xl');
          expect(result.tailwindClasses).toContain('w-full');

          // 標準のクラスも含む
          expect(result.tailwindClasses).toContain('flex');
          expect(result.tailwindClasses).toContain('justify-center');
          expect(result.tailwindClasses).toContain('items-center');
        });
      });
    });
  });
});
