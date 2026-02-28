// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker DB Save - JSAnimationPattern Tests
 *
 * saveJsAnimationPatterns関数のユニットテスト:
 * - CDPAnimationData → DB record 正常変換
 * - WebAnimationData → DB record 正常変換
 * - 空配列の場合 → count: 0, idMapping: 空Map
 * - ライブラリ検出結果のマッピング（GSAP, Anime.js, Web Animations API等）
 * - 既存データの削除→再作成（クリーンスレート動作）
 * - 個別パターン保存失敗時のGraceful Degradation
 * - idMappingが正しく返される
 *
 * @module tests/services/worker-db-save-js-animation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveJsAnimationPatterns,
  type JsAnimationPatternPrismaClient,
} from '../../src/services/worker-db-save.service';
import type {
  JSAnimationFullResult,
  CDPAnimationData,
  WebAnimationData,
  LibraryDetectionData,
} from '../../src/tools/page/handlers/types';

// =============================================================================
// テストヘルパー
// =============================================================================

/** デフォルトのライブラリ検出結果（すべて未検出） */
function createDefaultLibraries(overrides?: Partial<LibraryDetectionData>): LibraryDetectionData {
  return {
    gsap: { detected: false },
    framerMotion: { detected: false },
    anime: { detected: false },
    three: { detected: false },
    lottie: { detected: false },
    ...overrides,
  };
}

/** CDPAnimationDataのサンプル生成 */
function createCdpAnimation(overrides?: Partial<CDPAnimationData>): CDPAnimationData {
  return {
    id: 'cdp-anim-001',
    name: 'fadeIn',
    pausedState: false,
    playState: 'running',
    playbackRate: 1,
    startTime: 0,
    currentTime: 150,
    type: 'CSSAnimation',
    source: {
      duration: 300,
      delay: 0,
      iterations: 1,
      direction: 'normal',
      easing: 'ease-out',
      keyframesRule: {
        name: 'fadeIn',
        keyframes: [
          { offset: '0', easing: 'ease-out', style: 'opacity: 0' },
          { offset: '1', easing: 'ease-out', style: 'opacity: 1' },
        ],
      },
    },
    ...overrides,
  };
}

/** WebAnimationDataのサンプル生成 */
function createWebAnimation(overrides?: Partial<WebAnimationData>): WebAnimationData {
  return {
    id: 'web-anim-001',
    playState: 'running',
    target: 'div.hero-section > h1',
    timing: {
      duration: 500,
      delay: 100,
      iterations: 1,
      direction: 'normal',
      easing: 'ease-in-out',
      fill: 'forwards',
    },
    keyframes: [
      { offset: 0, easing: 'linear', composite: 'replace', opacity: '0', transform: 'translateY(20px)' },
      { offset: 1, easing: 'linear', composite: 'replace', opacity: '1', transform: 'translateY(0)' },
    ],
    ...overrides,
  };
}

/** JSAnimationFullResultのサンプル生成 */
function createJsAnimations(
  cdpAnimations: CDPAnimationData[] = [],
  webAnimations: WebAnimationData[] = [],
  libraries?: Partial<LibraryDetectionData>
): JSAnimationFullResult {
  return {
    cdpAnimations,
    webAnimations,
    libraries: createDefaultLibraries(libraries),
    detectionTimeMs: 100,
    totalDetected: cdpAnimations.length + webAnimations.length,
  };
}

/** Mock Prismaクライアント生成 */
function createMockPrisma(
  overrides?: Partial<JsAnimationPatternPrismaClient['jSAnimationPattern']>
): JsAnimationPatternPrismaClient {
  const model = {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockImplementation(({ data }: { data: unknown[] }) =>
      Promise.resolve({ count: data.length })
    ),
    ...overrides,
  };
  return {
    jSAnimationPattern: model,
    $transaction: vi.fn().mockImplementation(
      (fn: (tx: Pick<JsAnimationPatternPrismaClient, 'jSAnimationPattern'>) => Promise<unknown>) =>
        fn({ jSAnimationPattern: model })
    ),
  };
}

const WEB_PAGE_ID = 'test-web-page-id-001';
const SOURCE_URL = 'https://example.com';

// =============================================================================
// テスト本体
// =============================================================================

describe('saveJsAnimationPatterns', () => {
  let mockPrisma: JsAnimationPatternPrismaClient;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
  });

  // ---------------------------------------------------------------------------
  // 空配列処理
  // ---------------------------------------------------------------------------
  describe('空配列の場合', () => {
    it('CDP/Web両方空の場合、count: 0, idMapping: 空Mapを返す', async () => {
      const jsAnimations = createJsAnimations();

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(result.ids).toEqual([]);
      expect(result.idMapping.size).toBe(0);
      // deleteMany/createManyが呼ばれないことを確認
      expect(mockPrisma.jSAnimationPattern.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.jSAnimationPattern.createMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // CDPAnimationData → DB record 正常変換
  // ---------------------------------------------------------------------------
  describe('CDPAnimationData変換', () => {
    it('CSSAnimationタイプが正しくDB recordに変換される', async () => {
      const cdpAnim = createCdpAnimation({
        type: 'CSSAnimation',
        name: 'slideUp',
        source: {
          duration: 600,
          delay: 50,
          iterations: 2,
          direction: 'alternate',
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
        },
      });
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.ids).toHaveLength(1);

      // createManyに渡されたデータを検証
      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data).toHaveLength(1);

      const record = data?.[0];
      expect(record?.webPageId).toBe(WEB_PAGE_ID);
      expect(record?.name).toBe('slideUp');
      expect(record?.animationType).toBe('keyframe'); // CSSAnimation → keyframe
      expect(record?.libraryType).toBe('web_animations_api'); // ライブラリ未検出時
      expect(record?.durationMs).toBe(600);
      expect(record?.delayMs).toBe(50);
      expect(record?.easing).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
      expect(record?.iterations).toBe(2);
      expect(record?.direction).toBe('alternate');
      expect(record?.sourceUrl).toBe(SOURCE_URL);
      expect(record?.cdpSourceType).toBe('CSSAnimation');
      expect(record?.cdpAnimationId).toBe(cdpAnim.id);
    });

    it('CSSTransitionタイプがtweenにマッピングされる', async () => {
      const cdpAnim = createCdpAnimation({ type: 'CSSTransition' });
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.success).toBe(true);
      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.animationType).toBe('tween');
    });

    it('WebAnimationタイプがkeyframeにマッピングされる', async () => {
      const cdpAnim = createCdpAnimation({ type: 'WebAnimation' });
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.success).toBe(true);
      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.animationType).toBe('keyframe');
      expect(data?.[0]?.libraryType).toBe('web_animations_api');
    });

    it('name未設定の場合フォールバック名が生成される', async () => {
      const cdpAnim = createCdpAnimation({ name: '', type: 'CSSAnimation' });
      const jsAnimations = createJsAnimations([cdpAnim]);

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.name).toBe('CDP CSSAnimation');
    });

    it('duration/delayが0以下の場合nullとして保存される', async () => {
      const cdpAnim = createCdpAnimation({
        source: {
          duration: 0,
          delay: -1,
          iterations: 0,
          direction: '',
          easing: '',
        },
      });
      const jsAnimations = createJsAnimations([cdpAnim]);

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.durationMs).toBeNull();
      expect(data?.[0]?.delayMs).toBeNull();
      expect(data?.[0]?.iterations).toBeNull();
      expect(data?.[0]?.direction).toBeNull();
      expect(data?.[0]?.easing).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // WebAnimationData → DB record 正常変換
  // ---------------------------------------------------------------------------
  describe('WebAnimationData変換', () => {
    it('WebAnimationDataが正しくDB recordに変換される', async () => {
      const webAnim = createWebAnimation();
      const jsAnimations = createJsAnimations([], [webAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      const record = data?.[0];

      expect(record?.webPageId).toBe(WEB_PAGE_ID);
      expect(record?.libraryType).toBe('web_animations_api');
      expect(record?.animationType).toBe('keyframe');
      expect(record?.targetSelector).toBe('div.hero-section > h1');
      expect(record?.targetCount).toBe(1);
      expect(record?.durationMs).toBe(500);
      expect(record?.delayMs).toBe(100);
      expect(record?.easing).toBe('ease-in-out');
      expect(record?.fillMode).toBe('forwards');
      expect(record?.cdpAnimationId).toBeNull();
      expect(record?.sourceUrl).toBe(SOURCE_URL);
    });

    it('キーフレームからプロパティが正しく抽出される', async () => {
      const webAnim = createWebAnimation({
        keyframes: [
          { offset: 0, easing: 'linear', composite: 'replace', opacity: '0', transform: 'scale(0.5)' },
          { offset: 1, easing: 'linear', composite: 'replace', opacity: '1', transform: 'scale(1)' },
        ],
      });
      const jsAnimations = createJsAnimations([], [webAnim]);

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      const properties = data?.[0]?.properties as Array<{ property: string; from: string; to: string }>;

      // offset, easing, compositeは除外される
      expect(properties).toHaveLength(2);
      const opacityProp = properties.find((p) => p.property === 'opacity');
      expect(opacityProp?.from).toBe('0');
      expect(opacityProp?.to).toBe('1');
      const transformProp = properties.find((p) => p.property === 'transform');
      expect(transformProp?.from).toBe('scale(0.5)');
      expect(transformProp?.to).toBe('scale(1)');
    });

    it('長いtargetが500文字に切り詰められる', async () => {
      const longTarget = 'a'.repeat(600);
      const webAnim = createWebAnimation({ target: longTarget });
      const jsAnimations = createJsAnimations([], [webAnim]);

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect((data?.[0]?.targetSelector as string).length).toBe(500);
    });
  });

  // ---------------------------------------------------------------------------
  // ライブラリ検出結果のマッピング
  // ---------------------------------------------------------------------------
  describe('ライブラリ検出結果のマッピング', () => {
    it('GSAP検出時、libraryTypeがgsapになる', async () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations(
        [cdpAnim], [],
        { gsap: { detected: true, version: '3.12.0', tweens: 5 } }
      );

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.libraryType).toBe('gsap');
    });

    it('Framer Motion検出時、libraryTypeがframer_motionになる', async () => {
      const webAnim = createWebAnimation();
      const jsAnimations = createJsAnimations(
        [], [webAnim],
        { framerMotion: { detected: true, elements: 3 } }
      );

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.libraryType).toBe('framer_motion');
    });

    it('Anime.js検出時、libraryTypeがanime_jsになる', async () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations(
        [cdpAnim], [],
        { anime: { detected: true, instances: 2 } }
      );

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.libraryType).toBe('anime_js');
    });

    it('Three.js検出時、libraryTypeがthree_jsになる', async () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations(
        [cdpAnim], [],
        { three: { detected: true, scenes: 1 } }
      );

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.libraryType).toBe('three_js');
    });

    it('Lottie検出時、libraryTypeがlottieになる', async () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations(
        [cdpAnim], [],
        { lottie: { detected: true, animations: 1 } }
      );

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.libraryType).toBe('lottie');
    });

    it('ライブラリ未検出時、CDPタイプからlibraryTypeが推定される', async () => {
      const cdpAnim = createCdpAnimation({ type: 'CSSAnimation' });
      const jsAnimations = createJsAnimations([cdpAnim]);

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      // ライブラリ未検出 → CDPタイプからweb_animations_apiにフォールバック
      expect(data?.[0]?.libraryType).toBe('web_animations_api');
    });

    it('ライブラリ優先順位: GSAPが最優先', async () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations(
        [cdpAnim], [],
        {
          gsap: { detected: true },
          anime: { detected: true },
          three: { detected: true },
        }
      );

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.libraryType).toBe('gsap');
    });
  });

  // ---------------------------------------------------------------------------
  // クリーンスレート動作（deleteMany → createMany）
  // ---------------------------------------------------------------------------
  describe('クリーンスレート動作', () => {
    it('既存データを削除してから新規作成する', async () => {
      mockPrisma = createMockPrisma({
        deleteMany: vi.fn().mockResolvedValue({ count: 3 }), // 既存3件削除
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });

      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations([cdpAnim]);

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      // deleteManyが先に呼ばれる
      expect(mockPrisma.jSAnimationPattern.deleteMany).toHaveBeenCalledWith({
        where: { webPageId: WEB_PAGE_ID },
      });
      // createManyが後に呼ばれる
      expect(mockPrisma.jSAnimationPattern.createMany).toHaveBeenCalledTimes(1);

      // 呼び出し順序を確認（deleteMany → createMany）
      const deleteManyOrder = vi.mocked(mockPrisma.jSAnimationPattern.deleteMany).mock.invocationCallOrder[0];
      const createManyOrder = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.invocationCallOrder[0];
      expect(deleteManyOrder).toBeLessThan(createManyOrder!);
    });
  });

  // ---------------------------------------------------------------------------
  // idMappingの検証
  // ---------------------------------------------------------------------------
  describe('idMapping', () => {
    it('CDPアニメーションのoriginalId → UUIDv7マッピングが正しい', async () => {
      const cdpAnim = createCdpAnimation({ id: 'original-cdp-id' });
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.idMapping.size).toBe(1);
      expect(result.idMapping.has('original-cdp-id')).toBe(true);
      // UUIDv7形式のIDが生成されている
      const dbId = result.idMapping.get('original-cdp-id');
      expect(dbId).toBeDefined();
      expect(dbId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('WebアニメーションのoriginalId → UUIDv7マッピングが正しい', async () => {
      const webAnim = createWebAnimation({ id: 'original-web-id' });
      const jsAnimations = createJsAnimations([], [webAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.idMapping.size).toBe(1);
      expect(result.idMapping.has('original-web-id')).toBe(true);
    });

    it('CDP + Web混合時に全てのidMappingが含まれる', async () => {
      const cdpAnim1 = createCdpAnimation({ id: 'cdp-1' });
      const cdpAnim2 = createCdpAnimation({ id: 'cdp-2', type: 'CSSTransition' });
      const webAnim1 = createWebAnimation({ id: 'web-1' });
      const jsAnimations = createJsAnimations([cdpAnim1, cdpAnim2], [webAnim1]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.idMapping.size).toBe(3);
      expect(result.idMapping.has('cdp-1')).toBe(true);
      expect(result.idMapping.has('cdp-2')).toBe(true);
      expect(result.idMapping.has('web-1')).toBe(true);
      expect(result.ids).toHaveLength(3);
    });

    it('idMappingのvalueがidsに一致する', async () => {
      const cdpAnim = createCdpAnimation({ id: 'cdp-id' });
      const webAnim = createWebAnimation({ id: 'web-id' });
      const jsAnimations = createJsAnimations([cdpAnim], [webAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const mappedIds = Array.from(result.idMapping.values());
      expect(mappedIds.sort()).toEqual(result.ids.sort());
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful Degradation（Prismaエラー時）
  // ---------------------------------------------------------------------------
  describe('Graceful Degradation', () => {
    it('createManyがエラーを投げた場合、success: falseとerrorメッセージを返す', async () => {
      mockPrisma = createMockPrisma({
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockRejectedValue(new Error('Unique constraint violation')),
      });

      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.success).toBe(false);
      expect(result.count).toBe(0);
      expect(result.ids).toEqual([]);
      expect(result.idMapping.size).toBe(0);
      expect(result.error).toBe('Unique constraint violation');
    });

    it('deleteManyがエラーを投げた場合、success: falseを返す', async () => {
      mockPrisma = createMockPrisma({
        deleteMany: vi.fn().mockRejectedValue(new Error('Connection refused')),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      });

      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('非Errorオブジェクトがスローされた場合、デフォルトメッセージを返す', async () => {
      mockPrisma = createMockPrisma({
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockRejectedValue('string error'),
      });

      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to save JS animation patterns');
    });
  });

  // ---------------------------------------------------------------------------
  // 共通フィールドの検証
  // ---------------------------------------------------------------------------
  describe('共通フィールド', () => {
    it('UUIDv7形式のIDが全レコードに割り当てられる', async () => {
      const cdpAnim = createCdpAnimation();
      const webAnim = createWebAnimation();
      const jsAnimations = createJsAnimations([cdpAnim], [webAnim]);

      const result = await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      // 全IDがUUIDv7形式
      for (const id of result.ids) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    });

    it('共通フィールド（usageScope, tags, metadata）が正しく設定される', async () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations([cdpAnim]);

      await saveJsAnimationPatterns(
        mockPrisma, WEB_PAGE_ID, jsAnimations, SOURCE_URL
      );

      const call = vi.mocked(mockPrisma.jSAnimationPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      const record = data?.[0];

      expect(record?.usageScope).toBe('inspiration_only');
      expect(record?.tags).toEqual([]);
      expect(record?.metadata).toEqual({});
      expect(record?.triggerType).toBe('load');
      expect(record?.triggerConfig).toEqual({});
    });
  });
});
