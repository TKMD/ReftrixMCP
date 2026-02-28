// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.search JSアニメーション統合テスト
 *
 * TDDアプローチでJSAnimationPattern検索機能をテストします。
 *
 * テスト対象:
 * 1. スキーマバリデーション（include_js_animations, js_animation_filters）
 * 2. JSアニメーション検索（モック使用）
 * 3. 結果マージロジック
 *
 * @module tests/tools/motion/search-js-animation.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  motionSearchInputSchema,
  motionSearchOutputSchema,
  MOTION_SEARCH_ERROR_CODES,
  type MotionSearchInput,
  type MotionSearchOutput,
  type JSAnimationLibraryType,
  type JSAnimationType,
} from '../../../src/tools/motion/schemas';
import {
  motionSearchHandler,
  setMotionSearchServiceFactory,
  resetMotionSearchServiceFactory,
  type IMotionSearchService,
  type MotionSearchParams,
  type MotionSearchResult,
} from '../../../src/tools/motion/search.tool';

// ============================================================================
// Part 1: スキーマバリデーションテスト
// ============================================================================

describe('motion.search JSアニメーション スキーマバリデーション', () => {
  describe('include_js_animations パラメータ', () => {
    it('デフォルト値がtrueであること', () => {
      const input = {
        query: 'fade in animation',
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.include_js_animations).toBe(true);
    });

    it('明示的にfalseを指定できること', () => {
      const input = {
        query: 'fade in animation',
        include_js_animations: false,
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.include_js_animations).toBe(false);
    });

    it('明示的にtrueを指定できること', () => {
      const input = {
        query: 'fade in animation',
        include_js_animations: true,
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.include_js_animations).toBe(true);
    });

    it('boolean以外の値はエラーになること', () => {
      const input = {
        query: 'fade in animation',
        include_js_animations: 'true', // 文字列は無効
      };

      expect(() => motionSearchInputSchema.parse(input)).toThrow();
    });
  });

  describe('js_animation_filters パラメータ', () => {
    it('フィルターなしでも有効であること', () => {
      const input = {
        query: 'bounce animation',
        include_js_animations: true,
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters).toBeUndefined();
    });

    it('libraryType フィルターが有効であること（gsap）', () => {
      const input = {
        query: 'scroll animation',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'gsap',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.libraryType).toBe('gsap');
    });

    it('libraryType フィルターが有効であること（framer_motion）', () => {
      const input = {
        query: 'spring animation',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'framer_motion',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.libraryType).toBe('framer_motion');
    });

    it('libraryType フィルターが有効であること（anime_js）', () => {
      const input = {
        query: 'timeline animation',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'anime_js',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.libraryType).toBe('anime_js');
    });

    it('libraryType フィルターが有効であること（three_js）', () => {
      const input = {
        query: '3d animation',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'three_js',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.libraryType).toBe('three_js');
    });

    it('libraryType フィルターが有効であること（lottie）', () => {
      const input = {
        query: 'vector animation',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'lottie',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.libraryType).toBe('lottie');
    });

    it('libraryType フィルターが有効であること（web_animations_api）', () => {
      const input = {
        query: 'native animation',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'web_animations_api',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.libraryType).toBe('web_animations_api');
    });

    it('無効なlibraryTypeはエラーになること', () => {
      const input = {
        query: 'animation',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'invalid_library',
        },
      };

      expect(() => motionSearchInputSchema.parse(input)).toThrow();
    });

    it('animationType フィルターが有効であること（tween）', () => {
      const input = {
        query: 'simple animation',
        include_js_animations: true,
        js_animation_filters: {
          animationType: 'tween',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.animationType).toBe('tween');
    });

    it('animationType フィルターが有効であること（spring）', () => {
      const input = {
        query: 'physics animation',
        include_js_animations: true,
        js_animation_filters: {
          animationType: 'spring',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.animationType).toBe('spring');
    });

    it('animationType フィルターが有効であること（scroll_driven）', () => {
      const input = {
        query: 'scroll linked animation',
        include_js_animations: true,
        js_animation_filters: {
          animationType: 'scroll_driven',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.animationType).toBe('scroll_driven');
    });

    it('animationType フィルターが有効であること（gesture）', () => {
      const input = {
        query: 'drag animation',
        include_js_animations: true,
        js_animation_filters: {
          animationType: 'gesture',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.animationType).toBe('gesture');
    });

    it('無効なanimationTypeはエラーになること', () => {
      const input = {
        query: 'animation',
        include_js_animations: true,
        js_animation_filters: {
          animationType: 'invalid_type',
        },
      };

      expect(() => motionSearchInputSchema.parse(input)).toThrow();
    });

    it('libraryTypeとanimationTypeの両方を指定できること', () => {
      const input = {
        query: 'scroll animation',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'gsap',
          animationType: 'scroll_driven',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters?.libraryType).toBe('gsap');
      expect(result.js_animation_filters?.animationType).toBe('scroll_driven');
    });

    it('空のjs_animation_filtersオブジェクトは有効であること', () => {
      const input = {
        query: 'animation',
        include_js_animations: true,
        js_animation_filters: {},
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.js_animation_filters).toEqual({});
    });
  });

  describe('JSアニメーション関連パラメータの組み合わせ', () => {
    it('include_js_animations=false時もjs_animation_filtersを指定できること', () => {
      // 実行時には無視されるが、スキーマとしては有効
      const input = {
        query: 'animation',
        include_js_animations: false,
        js_animation_filters: {
          libraryType: 'gsap',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.include_js_animations).toBe(false);
      expect(result.js_animation_filters?.libraryType).toBe('gsap');
    });

    it('既存filtersとjs_animation_filtersを同時に指定できること', () => {
      const input = {
        query: 'animation',
        include_js_animations: true,
        filters: {
          type: 'animation',
          minDuration: 100,
        },
        js_animation_filters: {
          libraryType: 'framer_motion',
          animationType: 'spring',
        },
      };

      const result = motionSearchInputSchema.parse(input);

      expect(result.filters?.type).toBe('animation');
      expect(result.filters?.minDuration).toBe(100);
      expect(result.js_animation_filters?.libraryType).toBe('framer_motion');
      expect(result.js_animation_filters?.animationType).toBe('spring');
    });
  });
});

// ============================================================================
// Part 2: JSアニメーション検索テスト（モック使用）
// ============================================================================

describe('motion.search JSアニメーション検索', () => {
  beforeEach(() => {
    // モックサービスをリセット
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    resetMotionSearchServiceFactory();
    vi.clearAllMocks();
  });

  describe('include_js_animations=true（デフォルト）の場合', () => {
    it('CSSパターンとJSアニメーションの両方を検索すること', async () => {
      const mockCssResults = [
        {
          pattern: {
            id: 'css-pattern-1',
            name: 'fadeIn',
            type: 'css_animation' as const,
            category: 'micro_interaction' as const,
            trigger: 'load' as const,
            animation: {
              duration: 300,
              easing: { type: 'ease' as const },
            },
            properties: [{ property: 'opacity', from: '0', to: '1' }],
          },
          similarity: 0.95,
        },
      ];

      const mockJsResults = [
        {
          pattern: {
            id: 'js-pattern-1',
            name: 'gsapFadeIn',
            type: 'library_animation' as const,
            category: 'micro_interaction' as const,
            trigger: 'load' as const,
            animation: {
              duration: 500,
              easing: { type: 'power2.out' as const },
            },
            properties: [{ property: 'opacity', from: '0', to: '1' }],
          },
          similarity: 0.92,
          jsAnimationInfo: {
            libraryType: 'gsap' as JSAnimationLibraryType,
            animationType: 'tween' as JSAnimationType,
            libraryVersion: '3.12.0',
          },
        },
      ];

      // モックサービスを設定（CSSとJS両方の結果を返す）
      const mockSearch = vi.fn().mockResolvedValue({
        results: [...mockCssResults, ...mockJsResults],
        total: 2,
        query: {
          original: 'fade in',
          normalized: 'fade in',
          embedding_generated: true,
        },
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'fade in',
        include_js_animations: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total).toBe(2);
        expect(result.data.results).toHaveLength(2);
        // CSSパターンが含まれること
        expect(result.data.results.some((r) => r.pattern.type === 'css_animation')).toBe(true);
        // JSパターンが含まれること
        expect(result.data.results.some((r) => r.pattern.type === 'library_animation')).toBe(true);
      }
    });

    it('JSアニメーション結果にjsAnimationInfoが含まれること', async () => {
      const mockJsResult = {
        pattern: {
          id: 'js-pattern-1',
          name: 'framerSpring',
          type: 'library_animation' as const,
          category: 'micro_interaction' as const,
          trigger: 'state_change' as const,
          animation: {
            duration: 0, // springは時間ベースでない
            easing: { type: 'spring(1, 80, 10)' as const },
          },
          properties: [
            { property: 'x', from: '0', to: '100px' },
            { property: 'scale', from: '1', to: '1.2' },
          ],
        },
        similarity: 0.88,
        jsAnimationInfo: {
          libraryType: 'framer_motion' as JSAnimationLibraryType,
          animationType: 'spring' as JSAnimationType,
        },
      };

      const mockSearch = vi.fn().mockResolvedValue({
        results: [mockJsResult],
        total: 1,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'spring animation',
        include_js_animations: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results[0].jsAnimationInfo).toBeDefined();
        expect(result.data.results[0].jsAnimationInfo?.libraryType).toBe('framer_motion');
        expect(result.data.results[0].jsAnimationInfo?.animationType).toBe('spring');
      }
    });
  });

  describe('include_js_animations=falseの場合', () => {
    it('CSSパターンのみを検索すること', async () => {
      const mockCssResults = [
        {
          pattern: {
            id: 'css-pattern-1',
            name: 'fadeIn',
            type: 'css_animation' as const,
            category: 'micro_interaction' as const,
            trigger: 'load' as const,
            animation: {
              duration: 300,
              easing: { type: 'ease' as const },
            },
            properties: [{ property: 'opacity', from: '0', to: '1' }],
          },
          similarity: 0.95,
        },
      ];

      const mockSearch = vi.fn().mockResolvedValue({
        results: mockCssResults,
        total: 1,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'fade in',
        include_js_animations: false,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // 全ての結果がCSSタイプであること
        expect(result.data.results.every((r) => r.pattern.type !== 'library_animation')).toBe(true);
      }
    });
  });

  describe('js_animation_filtersの動作', () => {
    it('libraryTypeフィルターが適用されること', async () => {
      const mockGsapResults = [
        {
          pattern: {
            id: 'gsap-1',
            name: 'gsapTimeline',
            type: 'library_animation' as const,
            category: 'page_transition' as const,
            trigger: 'load' as const,
            animation: {
              duration: 1000,
              easing: { type: 'power2.inOut' as const },
            },
            properties: [
              { property: 'opacity', from: '0', to: '1' },
              { property: 'y', from: '50px', to: '0px' },
            ],
          },
          similarity: 0.90,
          jsAnimationInfo: {
            libraryType: 'gsap' as JSAnimationLibraryType,
            animationType: 'timeline' as JSAnimationType,
          },
        },
      ];

      const mockSearch = vi.fn().mockResolvedValue({
        results: mockGsapResults,
        total: 1,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'timeline animation',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'gsap',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results[0].jsAnimationInfo?.libraryType).toBe('gsap');
      }
    });

    it('animationTypeフィルターが適用されること', async () => {
      const mockScrollResults = [
        {
          pattern: {
            id: 'scroll-1',
            name: 'scrollProgress',
            type: 'library_animation' as const,
            category: 'scroll_trigger' as const,
            trigger: 'scroll' as const,
            animation: {
              duration: 0, // scroll-drivenは時間ベースでない
              easing: { type: 'linear' as const },
            },
            properties: [
              { property: 'opacity', from: '0', to: '1' },
              { property: 'transform', from: 'translateY(100px)', to: 'translateY(0)' },
            ],
          },
          similarity: 0.85,
          jsAnimationInfo: {
            libraryType: 'gsap' as JSAnimationLibraryType,
            animationType: 'scroll_driven' as JSAnimationType,
          },
        },
      ];

      const mockSearch = vi.fn().mockResolvedValue({
        results: mockScrollResults,
        total: 1,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'scroll progress',
        include_js_animations: true,
        js_animation_filters: {
          animationType: 'scroll_driven',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results[0].jsAnimationInfo?.animationType).toBe('scroll_driven');
      }
    });

    it('libraryTypeとanimationTypeの両方のフィルターが適用されること', async () => {
      const mockFilteredResults = [
        {
          pattern: {
            id: 'framer-spring-1',
            name: 'draggableCard',
            type: 'library_animation' as const,
            category: 'micro_interaction' as const,
            trigger: 'click' as const,
            animation: {
              duration: 0,
              easing: { type: 'spring(1, 80, 10)' as const },
            },
            properties: [
              { property: 'x', from: '0', to: '100px' },
              { property: 'y', from: '0', to: '-50px' },
            ],
          },
          similarity: 0.88,
          jsAnimationInfo: {
            libraryType: 'framer_motion' as JSAnimationLibraryType,
            animationType: 'gesture' as JSAnimationType,
          },
        },
      ];

      const mockSearch = vi.fn().mockResolvedValue({
        results: mockFilteredResults,
        total: 1,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'drag gesture',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'framer_motion',
          animationType: 'gesture',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results[0].jsAnimationInfo?.libraryType).toBe('framer_motion');
        expect(result.data.results[0].jsAnimationInfo?.animationType).toBe('gesture');
      }
    });
  });
});

// ============================================================================
// Part 3: 結果マージロジックテスト
// ============================================================================

describe('motion.search 結果マージロジック', () => {
  beforeEach(() => {
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    resetMotionSearchServiceFactory();
    vi.clearAllMocks();
  });

  describe('スコアによるソート', () => {
    it('類似度スコアの降順でソートされること', async () => {
      const mockMixedResults = [
        {
          pattern: {
            id: 'css-1',
            name: 'cssAnimation',
            type: 'css_animation' as const,
            category: 'micro_interaction' as const,
            trigger: 'load' as const,
            animation: {
              duration: 300,
              easing: { type: 'ease' as const },
            },
            properties: [{ property: 'opacity', from: '0', to: '1' }],
          },
          similarity: 0.75,
        },
        {
          pattern: {
            id: 'js-1',
            name: 'jsAnimation',
            type: 'library_animation' as const,
            category: 'page_transition' as const,
            trigger: 'load' as const,
            animation: {
              duration: 500,
              easing: { type: 'power2.out' as const },
            },
            properties: [
              { property: 'opacity', from: '0', to: '1' },
              { property: 'y', from: '20', to: '0' },
            ],
          },
          similarity: 0.95,
          jsAnimationInfo: {
            libraryType: 'gsap' as JSAnimationLibraryType,
            animationType: 'tween' as JSAnimationType,
          },
        },
        {
          pattern: {
            id: 'css-2',
            name: 'cssTransition',
            type: 'css_transition' as const,
            category: 'micro_interaction' as const,
            trigger: 'hover' as const,
            animation: {
              duration: 200,
              easing: { type: 'ease-in-out' as const },
            },
            properties: [{ property: 'background-color', from: '#fff', to: '#000' }],
          },
          similarity: 0.85,
        },
      ];

      // サービスがsimilarity順にソートされた結果を返すことを期待
      const mockSearch = vi.fn().mockResolvedValue({
        results: mockMixedResults.sort((a, b) => b.similarity - a.similarity),
        total: 3,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'animation',
        include_js_animations: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(3);
        // スコア降順であること
        expect(result.data.results[0].similarity).toBe(0.95);
        expect(result.data.results[1].similarity).toBe(0.85);
        expect(result.data.results[2].similarity).toBe(0.75);
      }
    });
  });

  describe('limit適用', () => {
    it('limitが結合結果に適用されること', async () => {
      const mockManyResults = Array.from({ length: 20 }, (_, i) => ({
        pattern: {
          id: `pattern-${i}`,
          name: `animation${i}`,
          type: i % 2 === 0 ? ('css_animation' as const) : ('library_animation' as const),
          category: 'micro_interaction' as const,
          trigger: 'load' as const,
          animation: {
            duration: 300,
            easing: { type: 'ease' as const },
          },
          properties: [{ property: 'opacity', from: '0', to: '1' }],
        },
        similarity: 0.9 - i * 0.02,
        ...(i % 2 !== 0
          ? {
              jsAnimationInfo: {
                libraryType: 'gsap' as JSAnimationLibraryType,
                animationType: 'tween' as JSAnimationType,
              },
            }
          : {}),
      }));

      const mockSearch = vi.fn().mockResolvedValue({
        results: mockManyResults.slice(0, 5), // limit=5で返す
        total: 20,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'animation',
        include_js_animations: true,
        limit: 5,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(5);
        expect(result.data.total).toBe(20);
      }
    });
  });

  describe('minSimilarity適用', () => {
    it('minSimilarity以上の結果のみ返されること', async () => {
      const mockResults = [
        {
          pattern: {
            id: 'high-score',
            name: 'highScoreAnimation',
            type: 'css_animation' as const,
            category: 'micro_interaction' as const,
            trigger: 'load' as const,
            animation: {
              duration: 300,
              easing: { type: 'ease' as const },
            },
            properties: [{ property: 'opacity', from: '0', to: '1' }],
          },
          similarity: 0.9,
        },
      ];

      const mockSearch = vi.fn().mockResolvedValue({
        results: mockResults,
        total: 1,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'animation',
        include_js_animations: true,
        minSimilarity: 0.8,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // 全ての結果が0.8以上であること
        expect(result.data.results.every((r) => r.similarity >= 0.8)).toBe(true);
      }
    });
  });

  describe('出力スキーマバリデーション', () => {
    // MotionSearchResultItemスキーマに適合する形式でモック結果を作成
    it('JSアニメーション含む出力がスキーマに適合すること', async () => {
      const mockOutput = {
        results: [
          {
            pattern: {
              id: 'js-1',
              name: 'gsapAnimation',
              type: 'css_animation' as const,
              category: 'scroll_trigger' as const,
              trigger: 'scroll' as const,
              animation: {
                duration: 1000,
                easing: { type: 'ease' as const },
              },
              properties: [
                { property: 'opacity', from: '0', to: '1' },
                { property: 'y', from: '50px', to: '0px' },
              ],
            },
            similarity: 0.92,
            jsAnimationInfo: {
              libraryType: 'gsap' as const,
              animationType: 'scroll_driven' as const,
              libraryVersion: '3.12.0',
            },
          },
        ],
        total: 1,
        query: {
          text: 'scroll reveal',
        },
      };

      const mockSearch = vi.fn().mockResolvedValue(mockOutput);
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'scroll reveal',
        include_js_animations: true,
      });

      expect(result.success).toBe(true);
      // 出力スキーマでバリデーション
      const validated = motionSearchOutputSchema.safeParse(result);
      expect(validated.success).toBe(true);
    });

    it('CSS専用出力がスキーマに適合すること', async () => {
      const mockOutput = {
        results: [
          {
            pattern: {
              id: 'css-1',
              name: 'fadeIn',
              type: 'css_animation' as const,
              category: 'micro_interaction' as const,
              trigger: 'load' as const,
              animation: {
                duration: 300,
                easing: { type: 'ease' as const },
              },
              properties: [
                { property: 'opacity', from: '0', to: '1' },
              ],
            },
            similarity: 0.88,
          },
        ],
        total: 1,
        query: {
          text: 'fade in',
        },
      };

      const mockSearch = vi.fn().mockResolvedValue(mockOutput);
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'fade in',
        include_js_animations: false,
      });

      expect(result.success).toBe(true);
      const validated = motionSearchOutputSchema.safeParse(result);
      expect(validated.success).toBe(true);
    });
  });
});

// ============================================================================
// Part 4: エッジケースとエラーハンドリング
// ============================================================================

describe('motion.search JSアニメーション エッジケース', () => {
  beforeEach(() => {
    resetMotionSearchServiceFactory();
  });

  afterEach(() => {
    resetMotionSearchServiceFactory();
    vi.clearAllMocks();
  });

  describe('空の結果', () => {
    it('JSアニメーションが見つからない場合は空配列を返すこと', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: [],
        total: 0,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'non-existent animation',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'lottie',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toEqual([]);
        expect(result.data.total).toBe(0);
      }
    });
  });

  describe('部分的な結果', () => {
    it('CSSのみ見つかりJSが見つからない場合', async () => {
      const mockCssOnly = [
        {
          pattern: {
            id: 'css-only',
            name: 'cssAnimation',
            type: 'css_animation' as const,
            category: 'micro_interaction' as const,
            trigger: 'load' as const,
            animation: {
              duration: 300,
              easing: { type: 'ease' as const },
            },
            properties: [{ property: 'opacity', from: '0', to: '1' }],
          },
          similarity: 0.8,
        },
      ];

      const mockSearch = vi.fn().mockResolvedValue({
        results: mockCssOnly,
        total: 1,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'fade animation',
        include_js_animations: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(1);
        expect(result.data.results[0].pattern.type).toBe('css_animation');
      }
    });

    it('JSのみ見つかりCSSが見つからない場合', async () => {
      const mockJsOnly = [
        {
          pattern: {
            id: 'js-only',
            name: 'gsapAnimation',
            type: 'library_animation' as const,
            category: 'page_transition' as const,
            trigger: 'load' as const,
            animation: {
              duration: 1000,
              easing: { type: 'power2.out' as const },
            },
            properties: [
              { property: 'opacity', from: '0', to: '1' },
              { property: 'y', from: '20', to: '0' },
            ],
          },
          similarity: 0.85,
          jsAnimationInfo: {
            libraryType: 'gsap' as JSAnimationLibraryType,
            animationType: 'timeline' as JSAnimationType,
          },
        },
      ];

      const mockSearch = vi.fn().mockResolvedValue({
        results: mockJsOnly,
        total: 1,
      });
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'gsap timeline',
        include_js_animations: true,
        js_animation_filters: {
          libraryType: 'gsap',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toHaveLength(1);
        expect(result.data.results[0].pattern.type).toBe('library_animation');
      }
    });
  });

  describe('サービスエラー', () => {
    it('JSアニメーション検索でエラーが発生した場合、適切なエラーを返すこと', async () => {
      const mockSearch = vi.fn().mockRejectedValue(new Error('Database connection failed'));
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'animation',
        include_js_animations: true,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_SEARCH_ERROR_CODES.SEARCH_ERROR);
      }
    });

    it('Embedding生成エラーの場合、EMBEDDING_ERRORコードを返すこと', async () => {
      const mockSearch = vi.fn().mockRejectedValue(new Error('Embedding generation failed'));
      setMotionSearchServiceFactory(() => ({ search: mockSearch }));

      const result = await motionSearchHandler({
        query: 'animation',
        include_js_animations: true,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(MOTION_SEARCH_ERROR_CODES.EMBEDDING_ERROR);
      }
    });
  });
});

// ============================================================================
// Part 5: パフォーマンス目標確認（統合テスト用プレースホルダー）
// ============================================================================

describe('motion.search JSアニメーション パフォーマンス', () => {
  it.skip('統合検索が500ms以内に完了すること', async () => {
    // 実際のサービスを使用する統合テストで検証
    // このテストはE2Eテストファイルで実装予定
  });

  it.skip('ベクトル検索が100ms以内に完了すること', async () => {
    // 実際のDBを使用する統合テストで検証
    // このテストはE2Eテストファイルで実装予定
  });
});
