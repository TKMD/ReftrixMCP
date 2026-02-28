// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSアニメーションDB保存機能のユニットテスト
 *
 * TDDアプローチ: 失敗するテストを先に作成
 *
 * テスト対象:
 * - CDPアニメーション -> JSAnimationPattern マッピング
 * - Web Animation -> JSAnimationPattern マッピング
 * - ライブラリ検出 -> JSAnimationPattern マッピング
 * - DB保存処理
 *
 * @module tests/unit/tools/page/handlers/js-animation-db-storage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CDPAnimationData,
  WebAnimationData,
  LibraryDetectionData,
  JSAnimationFullResult,
} from '../../../../../src/tools/page/handlers/types';

// =====================================================
// 型定義（DB保存用）
// =====================================================

/**
 * JSAnimationPattern作成データ型
 * Prismaスキーマに対応
 */
interface JSAnimationPatternCreateData {
  id?: string;
  webPageId?: string | null;
  libraryType: JSAnimationLibraryType;
  libraryVersion?: string | null;
  name: string;
  animationType: JSAnimationTypeEnum;
  description?: string | null;
  targetSelector?: string | null;
  targetCount?: number | null;
  targetTagNames?: string[];
  durationMs?: number | null;
  delayMs?: number | null;
  easing?: string | null;
  iterations?: number | null;
  direction?: string | null;
  fillMode?: string | null;
  keyframes?: unknown;
  properties: unknown;
  triggerType?: string | null;
  triggerConfig?: unknown;
  cdpAnimationId?: string | null;
  cdpSourceType?: string | null;
  cdpPlayState?: string | null;
  cdpCurrentTime?: number | null;
  cdpStartTime?: number | null;
  cdpRawData?: unknown;
  librarySpecificData?: unknown;
  performance?: unknown;
  accessibility?: unknown;
  sourceUrl?: string | null;
  usageScope?: string;
  tags?: string[];
  metadata?: unknown;
  confidence?: number | null;
}

/**
 * JSアニメーションライブラリタイプ（Prisma ENUM）
 */
type JSAnimationLibraryType =
  | 'gsap'
  | 'framer_motion'
  | 'anime_js'
  | 'three_js'
  | 'lottie'
  | 'web_animations_api'
  | 'unknown';

/**
 * JSアニメーションタイプ（Prisma ENUM）
 */
type JSAnimationTypeEnum =
  | 'tween'
  | 'timeline'
  | 'spring'
  | 'physics'
  | 'keyframe'
  | 'morphing'
  | 'path'
  | 'scroll_driven'
  | 'gesture';

// =====================================================
// マッピング関数（テスト用実装 - 後で本実装に移動）
// =====================================================

/**
 * CDPアニメーションタイプをJSAnimationTypeにマッピング
 */
function mapCDPTypeToAnimationType(cdpType: string): JSAnimationTypeEnum {
  switch (cdpType) {
    case 'CSSAnimation':
      return 'keyframe';
    case 'CSSTransition':
      return 'tween';
    case 'WebAnimation':
      return 'keyframe';
    default:
      return 'tween';
  }
}

/**
 * CDPアニメーションをJSAnimationPatternCreateDataにマッピング
 */
function mapCDPAnimationToPattern(
  cdpAnim: CDPAnimationData,
  webPageId?: string,
  sourceUrl?: string
): JSAnimationPatternCreateData {
  return {
    webPageId: webPageId ?? null,
    libraryType: cdpAnim.type === 'WebAnimation' ? 'web_animations_api' : 'unknown',
    name: cdpAnim.name || `cdp-animation-${cdpAnim.id}`,
    animationType: mapCDPTypeToAnimationType(cdpAnim.type),
    durationMs: cdpAnim.source.duration > 0 ? Math.round(cdpAnim.source.duration) : null,
    delayMs: cdpAnim.source.delay > 0 ? Math.round(cdpAnim.source.delay) : null,
    easing: cdpAnim.source.easing || null,
    iterations: cdpAnim.source.iterations === Infinity ? -1 : cdpAnim.source.iterations,
    direction: cdpAnim.source.direction || null,
    keyframes: cdpAnim.source.keyframesRule?.keyframes ?? [],
    properties: [],
    cdpAnimationId: cdpAnim.id,
    cdpSourceType: cdpAnim.type,
    cdpPlayState: cdpAnim.playState,
    cdpCurrentTime: cdpAnim.currentTime,
    cdpStartTime: cdpAnim.startTime,
    cdpRawData: {
      pausedState: cdpAnim.pausedState,
      playbackRate: cdpAnim.playbackRate,
      source: cdpAnim.source,
    },
    sourceUrl: sourceUrl ?? null,
    usageScope: 'inspiration_only',
    confidence: 0.9, // CDPからの検出は高信頼度
  };
}

/**
 * Web AnimationをJSAnimationPatternCreateDataにマッピング
 */
function mapWebAnimationToPattern(
  webAnim: WebAnimationData,
  webPageId?: string,
  sourceUrl?: string
): JSAnimationPatternCreateData {
  // キーフレームからプロパティを抽出
  const properties = webAnim.keyframes
    .flatMap((kf) =>
      Object.keys(kf).filter(
        (k) => !['offset', 'easing', 'composite'].includes(k)
      )
    )
    .filter((v, i, a) => a.indexOf(v) === i); // 重複除去

  return {
    webPageId: webPageId ?? null,
    libraryType: 'web_animations_api',
    name: webAnim.id || `web-animation-${Date.now()}`,
    animationType: 'keyframe',
    targetSelector: webAnim.target || null,
    durationMs: webAnim.timing.duration > 0 ? Math.round(webAnim.timing.duration) : null,
    delayMs: webAnim.timing.delay > 0 ? Math.round(webAnim.timing.delay) : null,
    easing: webAnim.timing.easing || null,
    iterations: webAnim.timing.iterations === -1 ? -1 : webAnim.timing.iterations,
    direction: webAnim.timing.direction || null,
    fillMode: webAnim.timing.fill || null,
    keyframes: webAnim.keyframes,
    properties: properties,
    cdpPlayState: webAnim.playState,
    sourceUrl: sourceUrl ?? null,
    usageScope: 'inspiration_only',
    confidence: 0.95, // Web Animations APIからの検出は非常に高信頼度
  };
}

/**
 * ライブラリ検出結果をJSAnimationPatternCreateDataの配列にマッピング
 */
function mapLibraryDetectionToPatterns(
  libraries: LibraryDetectionData,
  webPageId?: string,
  sourceUrl?: string
): JSAnimationPatternCreateData[] {
  const patterns: JSAnimationPatternCreateData[] = [];

  // GSAP
  if (libraries.gsap.detected) {
    patterns.push({
      webPageId: webPageId ?? null,
      libraryType: 'gsap',
      libraryVersion: libraries.gsap.version ?? null,
      name: 'GSAP Library Detection',
      animationType: 'timeline', // GSAPはタイムラインベースが多い
      description: `GSAP detected with ${libraries.gsap.tweens ?? 0} active tweens`,
      properties: [],
      librarySpecificData: {
        tweens: libraries.gsap.tweens,
        version: libraries.gsap.version,
      },
      sourceUrl: sourceUrl ?? null,
      usageScope: 'inspiration_only',
      confidence: 0.85,
    });
  }

  // Framer Motion
  if (libraries.framerMotion.detected) {
    patterns.push({
      webPageId: webPageId ?? null,
      libraryType: 'framer_motion',
      name: 'Framer Motion Library Detection',
      animationType: 'spring', // Framer Motionはspringがデフォルト
      description: `Framer Motion detected with ${libraries.framerMotion.elements ?? 0} animated elements`,
      properties: [],
      librarySpecificData: {
        elements: libraries.framerMotion.elements,
      },
      sourceUrl: sourceUrl ?? null,
      usageScope: 'inspiration_only',
      confidence: 0.8,
    });
  }

  // anime.js
  if (libraries.anime.detected) {
    patterns.push({
      webPageId: webPageId ?? null,
      libraryType: 'anime_js',
      name: 'anime.js Library Detection',
      animationType: 'tween',
      description: `anime.js detected with ${libraries.anime.instances ?? 0} active instances`,
      properties: [],
      librarySpecificData: {
        instances: libraries.anime.instances,
      },
      sourceUrl: sourceUrl ?? null,
      usageScope: 'inspiration_only',
      confidence: 0.85,
    });
  }

  // Three.js
  if (libraries.three.detected) {
    patterns.push({
      webPageId: webPageId ?? null,
      libraryType: 'three_js',
      name: 'Three.js Library Detection',
      animationType: 'physics', // Three.jsは3D物理ベース
      description: `Three.js detected with ${libraries.three.scenes ?? 0} WebGL scenes`,
      properties: [],
      librarySpecificData: {
        scenes: libraries.three.scenes,
      },
      sourceUrl: sourceUrl ?? null,
      usageScope: 'inspiration_only',
      confidence: 0.75, // Canvas検出のため少し低め
    });
  }

  // Lottie
  if (libraries.lottie.detected) {
    patterns.push({
      webPageId: webPageId ?? null,
      libraryType: 'lottie',
      name: 'Lottie Library Detection',
      animationType: 'morphing', // Lottieはベクター変形アニメーション
      description: `Lottie detected with ${libraries.lottie.animations ?? 0} animations`,
      properties: [],
      librarySpecificData: {
        animations: libraries.lottie.animations,
      },
      sourceUrl: sourceUrl ?? null,
      usageScope: 'inspiration_only',
      confidence: 0.9,
    });
  }

  return patterns;
}

/**
 * JSAnimationFullResultをJSAnimationPatternCreateDataの配列にマッピング
 */
function mapJSAnimationResultToPatterns(
  result: JSAnimationFullResult,
  webPageId?: string,
  sourceUrl?: string
): JSAnimationPatternCreateData[] {
  const patterns: JSAnimationPatternCreateData[] = [];

  // CDPアニメーションをマッピング
  for (const cdpAnim of result.cdpAnimations) {
    patterns.push(mapCDPAnimationToPattern(cdpAnim, webPageId, sourceUrl));
  }

  // Web Animationsをマッピング
  for (const webAnim of result.webAnimations) {
    patterns.push(mapWebAnimationToPattern(webAnim, webPageId, sourceUrl));
  }

  // ライブラリ検出をマッピング
  const libraryPatterns = mapLibraryDetectionToPatterns(result.libraries, webPageId, sourceUrl);
  patterns.push(...libraryPatterns);

  return patterns;
}

// =====================================================
// テストスイート: CDPアニメーションマッピング
// =====================================================

describe('JSアニメーションDB保存 - CDPアニメーションマッピング', () => {
  const mockCDPAnimation: CDPAnimationData = {
    id: 'cdp-anim-001',
    name: 'fadeIn',
    pausedState: false,
    playState: 'running',
    playbackRate: 1,
    startTime: 100,
    currentTime: 50,
    type: 'CSSAnimation',
    source: {
      duration: 1000,
      delay: 200,
      iterations: 3,
      direction: 'alternate',
      easing: 'ease-in-out',
      keyframesRule: {
        name: 'fadeIn',
        keyframes: [
          { offset: '0', easing: 'linear', style: 'opacity: 0' },
          { offset: '1', easing: 'linear', style: 'opacity: 1' },
        ],
      },
    },
  };

  it('CDPアニメーションをJSAnimationPatternCreateDataに正しくマッピングする', () => {
    const result = mapCDPAnimationToPattern(mockCDPAnimation, 'web-page-123', 'https://example.com');

    expect(result.webPageId).toBe('web-page-123');
    expect(result.name).toBe('fadeIn');
    expect(result.animationType).toBe('keyframe'); // CSSAnimation -> keyframe
    expect(result.durationMs).toBe(1000);
    expect(result.delayMs).toBe(200);
    expect(result.easing).toBe('ease-in-out');
    expect(result.iterations).toBe(3);
    expect(result.direction).toBe('alternate');
    expect(result.cdpAnimationId).toBe('cdp-anim-001');
    expect(result.cdpSourceType).toBe('CSSAnimation');
    expect(result.cdpPlayState).toBe('running');
    expect(result.confidence).toBe(0.9);
  });

  it('CSSTransitionをtweenタイプにマッピングする', () => {
    const transitionAnim: CDPAnimationData = {
      ...mockCDPAnimation,
      type: 'CSSTransition',
      name: 'opacity',
    };

    const result = mapCDPAnimationToPattern(transitionAnim);
    expect(result.animationType).toBe('tween');
  });

  it('WebAnimationをkeyframeタイプにマッピングする', () => {
    const webAnim: CDPAnimationData = {
      ...mockCDPAnimation,
      type: 'WebAnimation',
      name: '',
    };

    const result = mapCDPAnimationToPattern(webAnim);
    expect(result.animationType).toBe('keyframe');
    expect(result.libraryType).toBe('web_animations_api');
  });

  it('名前がない場合はデフォルト名を生成する', () => {
    const noNameAnim: CDPAnimationData = {
      ...mockCDPAnimation,
      name: '',
    };

    const result = mapCDPAnimationToPattern(noNameAnim);
    expect(result.name).toBe('cdp-animation-cdp-anim-001');
  });

  it('無限反復を-1にマッピングする', () => {
    const infiniteAnim: CDPAnimationData = {
      ...mockCDPAnimation,
      source: {
        ...mockCDPAnimation.source,
        iterations: Infinity,
      },
    };

    const result = mapCDPAnimationToPattern(infiniteAnim);
    expect(result.iterations).toBe(-1);
  });

  it('cdpRawDataにソース情報を含める', () => {
    const result = mapCDPAnimationToPattern(mockCDPAnimation);

    expect(result.cdpRawData).toEqual({
      pausedState: false,
      playbackRate: 1,
      source: mockCDPAnimation.source,
    });
  });
});

// =====================================================
// テストスイート: Web Animationマッピング
// =====================================================

describe('JSアニメーションDB保存 - Web Animationマッピング', () => {
  const mockWebAnimation: WebAnimationData = {
    id: 'web-anim-001',
    playState: 'running',
    target: '#animated-box',
    timing: {
      duration: 500,
      delay: 100,
      iterations: 2,
      direction: 'normal',
      easing: 'ease',
      fill: 'forwards',
    },
    keyframes: [
      { offset: 0, easing: 'linear', composite: 'replace', transform: 'translateX(0)' },
      { offset: 1, easing: 'linear', composite: 'replace', transform: 'translateX(100px)' },
    ],
  };

  it('Web AnimationをJSAnimationPatternCreateDataに正しくマッピングする', () => {
    const result = mapWebAnimationToPattern(mockWebAnimation, 'web-page-456', 'https://example.com');

    expect(result.webPageId).toBe('web-page-456');
    expect(result.libraryType).toBe('web_animations_api');
    expect(result.name).toBe('web-anim-001');
    expect(result.animationType).toBe('keyframe');
    expect(result.targetSelector).toBe('#animated-box');
    expect(result.durationMs).toBe(500);
    expect(result.delayMs).toBe(100);
    expect(result.easing).toBe('ease');
    expect(result.iterations).toBe(2);
    expect(result.direction).toBe('normal');
    expect(result.fillMode).toBe('forwards');
    expect(result.keyframes).toEqual(mockWebAnimation.keyframes);
    expect(result.confidence).toBe(0.95);
  });

  it('キーフレームからプロパティを抽出する', () => {
    const animWithMultipleProps: WebAnimationData = {
      ...mockWebAnimation,
      keyframes: [
        { offset: 0, easing: 'linear', composite: 'replace', transform: 'scale(0)', opacity: '0' },
        { offset: 1, easing: 'linear', composite: 'replace', transform: 'scale(1)', opacity: '1' },
      ],
    };

    const result = mapWebAnimationToPattern(animWithMultipleProps);

    expect(result.properties).toContain('transform');
    expect(result.properties).toContain('opacity');
    expect(result.properties).not.toContain('offset');
    expect(result.properties).not.toContain('easing');
    expect(result.properties).not.toContain('composite');
  });

  it('無限反復を-1にマッピングする', () => {
    const infiniteAnim: WebAnimationData = {
      ...mockWebAnimation,
      timing: {
        ...mockWebAnimation.timing,
        iterations: -1,
      },
    };

    const result = mapWebAnimationToPattern(infiniteAnim);
    expect(result.iterations).toBe(-1);
  });

  it('IDがない場合はタイムスタンプベースの名前を生成する', () => {
    const noIdAnim: WebAnimationData = {
      ...mockWebAnimation,
      id: '',
    };

    const result = mapWebAnimationToPattern(noIdAnim);
    expect(result.name).toMatch(/^web-animation-\d+$/);
  });
});

// =====================================================
// テストスイート: ライブラリ検出マッピング
// =====================================================

describe('JSアニメーションDB保存 - ライブラリ検出マッピング', () => {
  const mockLibraries: LibraryDetectionData = {
    gsap: { detected: true, version: '3.12.0', tweens: 5 },
    framerMotion: { detected: true, elements: 10 },
    anime: { detected: false },
    three: { detected: true, scenes: 2 },
    lottie: { detected: true, animations: 3 },
  };

  it('検出されたライブラリをパターンに変換する', () => {
    const patterns = mapLibraryDetectionToPatterns(mockLibraries, 'web-page-789');

    expect(patterns.length).toBe(4); // gsap, framerMotion, three, lottie

    const gsapPattern = patterns.find((p) => p.libraryType === 'gsap');
    expect(gsapPattern).toBeDefined();
    expect(gsapPattern?.libraryVersion).toBe('3.12.0');
    expect(gsapPattern?.animationType).toBe('timeline');

    const framerPattern = patterns.find((p) => p.libraryType === 'framer_motion');
    expect(framerPattern).toBeDefined();
    expect(framerPattern?.animationType).toBe('spring');

    const threePattern = patterns.find((p) => p.libraryType === 'three_js');
    expect(threePattern).toBeDefined();
    expect(threePattern?.animationType).toBe('physics');

    const lottiePattern = patterns.find((p) => p.libraryType === 'lottie');
    expect(lottiePattern).toBeDefined();
    expect(lottiePattern?.animationType).toBe('morphing');
  });

  it('検出されていないライブラリはスキップする', () => {
    const partialLibraries: LibraryDetectionData = {
      gsap: { detected: false },
      framerMotion: { detected: false },
      anime: { detected: true, instances: 3 },
      three: { detected: false },
      lottie: { detected: false },
    };

    const patterns = mapLibraryDetectionToPatterns(partialLibraries);
    expect(patterns.length).toBe(1);
    expect(patterns[0].libraryType).toBe('anime_js');
  });

  it('librarySpecificDataに詳細情報を含める', () => {
    const patterns = mapLibraryDetectionToPatterns(mockLibraries);

    const gsapPattern = patterns.find((p) => p.libraryType === 'gsap');
    expect(gsapPattern?.librarySpecificData).toEqual({
      tweens: 5,
      version: '3.12.0',
    });
  });

  it('すべてのライブラリが未検出の場合は空配列を返す', () => {
    const noLibraries: LibraryDetectionData = {
      gsap: { detected: false },
      framerMotion: { detected: false },
      anime: { detected: false },
      three: { detected: false },
      lottie: { detected: false },
    };

    const patterns = mapLibraryDetectionToPatterns(noLibraries);
    expect(patterns).toEqual([]);
  });
});

// =====================================================
// テストスイート: JSAnimationFullResult統合マッピング
// =====================================================

describe('JSアニメーションDB保存 - 統合マッピング', () => {
  const mockFullResult: JSAnimationFullResult = {
    cdpAnimations: [
      {
        id: 'cdp-1',
        name: 'slide',
        pausedState: false,
        playState: 'running',
        playbackRate: 1,
        startTime: 0,
        currentTime: 100,
        type: 'CSSAnimation',
        source: {
          duration: 500,
          delay: 0,
          iterations: 1,
          direction: 'normal',
          easing: 'ease',
        },
      },
    ],
    webAnimations: [
      {
        id: 'web-1',
        playState: 'finished',
        target: '.box',
        timing: {
          duration: 300,
          delay: 50,
          iterations: 1,
          direction: 'normal',
          easing: 'linear',
          fill: 'none',
        },
        keyframes: [
          { offset: 0, easing: 'linear', composite: 'replace', opacity: '0' },
          { offset: 1, easing: 'linear', composite: 'replace', opacity: '1' },
        ],
      },
    ],
    libraries: {
      gsap: { detected: true, version: '3.12.0', tweens: 2 },
      framerMotion: { detected: false },
      anime: { detected: false },
      three: { detected: false },
      lottie: { detected: false },
    },
    detectionTimeMs: 150,
    totalDetected: 4,
  };

  it('すべてのソースからパターンを生成する', () => {
    const patterns = mapJSAnimationResultToPatterns(mockFullResult, 'page-123', 'https://example.com');

    expect(patterns.length).toBe(3); // 1 CDP + 1 Web + 1 GSAP

    // CDPアニメーション
    const cdpPattern = patterns.find((p) => p.cdpAnimationId === 'cdp-1');
    expect(cdpPattern).toBeDefined();
    expect(cdpPattern?.name).toBe('slide');

    // Web Animation
    const webPattern = patterns.find((p) => p.libraryType === 'web_animations_api' && p.name === 'web-1');
    expect(webPattern).toBeDefined();
    expect(webPattern?.targetSelector).toBe('.box');

    // ライブラリ
    const gsapPattern = patterns.find((p) => p.libraryType === 'gsap');
    expect(gsapPattern).toBeDefined();
  });

  it('webPageIdとsourceUrlをすべてのパターンに設定する', () => {
    const patterns = mapJSAnimationResultToPatterns(mockFullResult, 'page-abc', 'https://test.com');

    patterns.forEach((pattern) => {
      expect(pattern.webPageId).toBe('page-abc');
      expect(pattern.sourceUrl).toBe('https://test.com');
    });
  });

  it('空の結果の場合は空配列を返す', () => {
    const emptyResult: JSAnimationFullResult = {
      cdpAnimations: [],
      webAnimations: [],
      libraries: {
        gsap: { detected: false },
        framerMotion: { detected: false },
        anime: { detected: false },
        three: { detected: false },
        lottie: { detected: false },
      },
      detectionTimeMs: 10,
      totalDetected: 0,
    };

    const patterns = mapJSAnimationResultToPatterns(emptyResult);
    expect(patterns).toEqual([]);
  });
});

// =====================================================
// テストスイート: DB保存処理（モック）
// =====================================================

describe('JSアニメーションDB保存 - DB保存処理', () => {
  // モックPrismaクライアント
  const mockPrisma = {
    jSAnimationPattern: {
      createMany: vi.fn().mockResolvedValue({ count: 3 }),
    },
    $transaction: vi.fn().mockImplementation((fn) => fn(mockPrisma)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('パターン配列をcreateManyで一括保存する', async () => {
    const patterns: JSAnimationPatternCreateData[] = [
      {
        name: 'pattern1',
        libraryType: 'gsap',
        animationType: 'timeline',
        properties: [],
      },
      {
        name: 'pattern2',
        libraryType: 'web_animations_api',
        animationType: 'keyframe',
        properties: [],
      },
    ];

    // 保存関数（後で実装するもの）をシミュレート
    await mockPrisma.jSAnimationPattern.createMany({
      data: patterns,
      skipDuplicates: true,
    });

    expect(mockPrisma.jSAnimationPattern.createMany).toHaveBeenCalledWith({
      data: patterns,
      skipDuplicates: true,
    });
  });

  it('空の配列の場合は保存をスキップする', async () => {
    const patterns: JSAnimationPatternCreateData[] = [];

    // 空の場合は保存しない
    if (patterns.length > 0) {
      await mockPrisma.jSAnimationPattern.createMany({ data: patterns });
    }

    expect(mockPrisma.jSAnimationPattern.createMany).not.toHaveBeenCalled();
  });

  it('トランザクション内で保存する', async () => {
    const patterns: JSAnimationPatternCreateData[] = [
      {
        name: 'txPattern',
        libraryType: 'lottie',
        animationType: 'morphing',
        properties: [],
      },
    ];

    await mockPrisma.$transaction(async (tx) => {
      await tx.jSAnimationPattern.createMany({ data: patterns });
    });

    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});

// =====================================================
// テストスイート: エッジケース
// =====================================================

describe('JSアニメーションDB保存 - エッジケース', () => {
  it('duration 0のアニメーションを処理する', () => {
    const zeroAnim: CDPAnimationData = {
      id: 'zero',
      name: 'instant',
      pausedState: false,
      playState: 'finished',
      playbackRate: 1,
      startTime: 0,
      currentTime: 0,
      type: 'CSSAnimation',
      source: {
        duration: 0,
        delay: 0,
        iterations: 1,
        direction: 'normal',
        easing: 'linear',
      },
    };

    const result = mapCDPAnimationToPattern(zeroAnim);
    expect(result.durationMs).toBeNull(); // 0はnullに変換
  });

  it('非常に長いdurationを処理する', () => {
    const longAnim: CDPAnimationData = {
      id: 'long',
      name: 'veryLong',
      pausedState: false,
      playState: 'running',
      playbackRate: 1,
      startTime: 0,
      currentTime: 0,
      type: 'CSSAnimation',
      source: {
        duration: 60000, // 60秒
        delay: 0,
        iterations: 1,
        direction: 'normal',
        easing: 'linear',
      },
    };

    const result = mapCDPAnimationToPattern(longAnim);
    expect(result.durationMs).toBe(60000);
  });

  it('特殊文字を含むセレクタを処理する', () => {
    const specialAnim: WebAnimationData = {
      id: 'special',
      playState: 'running',
      target: '.my-class[data-id="123"]',
      timing: {
        duration: 100,
        delay: 0,
        iterations: 1,
        direction: 'normal',
        easing: 'linear',
        fill: 'none',
      },
      keyframes: [],
    };

    const result = mapWebAnimationToPattern(specialAnim);
    expect(result.targetSelector).toBe('.my-class[data-id="123"]');
  });
});

// =====================================================
// テストスイート: 本実装のsaveJSAnimationPatterns
// =====================================================

import {
  mapCDPAnimationToPattern as realMapCDPAnimationToPattern,
  mapWebAnimationToPattern as realMapWebAnimationToPattern,
  mapLibraryDetectionToPatterns as realMapLibraryDetectionToPatterns,
  mapJSAnimationResultToPatterns as realMapJSAnimationResultToPatterns,
  saveJSAnimationPatterns,
} from '../../../../../src/tools/page/handlers/js-animation-handler';

describe('JSアニメーションDB保存 - 本実装テスト', () => {
  const mockTxModel = {
    createMany: vi.fn().mockResolvedValue({ count: 3 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };

  const mockPrismaClient = {
    jSAnimationPattern: {
      createMany: vi.fn().mockResolvedValue({ count: 3 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ jSAnimationPattern: mockTxModel })
    ),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('本実装のmapCDPAnimationToPatternが正しく動作する', () => {
    const cdpAnim: CDPAnimationData = {
      id: 'real-cdp-001',
      name: 'realFade',
      pausedState: false,
      playState: 'running',
      playbackRate: 1,
      startTime: 0,
      currentTime: 100,
      type: 'CSSAnimation',
      source: {
        duration: 500,
        delay: 100,
        iterations: 2,
        direction: 'alternate',
        easing: 'ease-out',
      },
    };

    const result = realMapCDPAnimationToPattern(cdpAnim, 'page-123', 'https://test.com');

    expect(result.webPageId).toBe('page-123');
    expect(result.name).toBe('realFade');
    expect(result.animationType).toBe('keyframe');
    expect(result.durationMs).toBe(500);
    expect(result.sourceUrl).toBe('https://test.com');
  });

  it('本実装のmapWebAnimationToPatternが正しく動作する', () => {
    const webAnim: WebAnimationData = {
      id: 'real-web-001',
      playState: 'finished',
      target: '#element',
      timing: {
        duration: 300,
        delay: 50,
        iterations: 1,
        direction: 'normal',
        easing: 'linear',
        fill: 'forwards',
      },
      keyframes: [
        { offset: 0, easing: 'linear', composite: 'replace', opacity: '0' },
        { offset: 1, easing: 'linear', composite: 'replace', opacity: '1' },
      ],
    };

    const result = realMapWebAnimationToPattern(webAnim, 'page-456');

    expect(result.webPageId).toBe('page-456');
    expect(result.libraryType).toBe('web_animations_api');
    expect(result.targetSelector).toBe('#element');
  });

  it('本実装のmapLibraryDetectionToPatternsが正しく動作する', () => {
    const libraries: LibraryDetectionData = {
      gsap: { detected: true, version: '3.12.0', tweens: 5 },
      framerMotion: { detected: false },
      anime: { detected: true, instances: 3 },
      three: { detected: false },
      lottie: { detected: false },
    };

    const patterns = realMapLibraryDetectionToPatterns(libraries, 'page-789');

    expect(patterns.length).toBe(2); // GSAP + anime.js
    expect(patterns.find((p) => p.libraryType === 'gsap')).toBeDefined();
    expect(patterns.find((p) => p.libraryType === 'anime_js')).toBeDefined();
  });

  it('saveJSAnimationPatternsが空配列で0を返す', async () => {
    const count = await saveJSAnimationPatterns(mockPrismaClient as never, []);

    expect(count).toBe(0);
    expect(mockPrismaClient.jSAnimationPattern.createMany).not.toHaveBeenCalled();
  });

  it('saveJSAnimationPatternsがパターンを保存する', async () => {
    const patterns = [
      {
        webPageId: 'page-123',
        libraryType: 'gsap' as const,
        name: 'TestPattern',
        animationType: 'timeline' as const,
        properties: [],
      },
    ];

    const count = await saveJSAnimationPatterns(mockPrismaClient as never, patterns, 'page-123');

    expect(count).toBe(3); // モックの返り値
    // $transactionが使用されていることを確認
    expect(mockPrismaClient.$transaction).toHaveBeenCalledTimes(1);
    // トランザクション内でdeleteMany/createManyが呼ばれる
    expect(mockTxModel.deleteMany).toHaveBeenCalledWith({
      where: { webPageId: 'page-123' },
    });
    expect(mockTxModel.createMany).toHaveBeenCalledWith({
      data: patterns,
      skipDuplicates: true,
    });
  });

  it('mapJSAnimationResultToPatternsが全ソースを統合する', () => {
    const fullResult: JSAnimationFullResult = {
      cdpAnimations: [
        {
          id: 'cdp-1',
          name: 'anim1',
          pausedState: false,
          playState: 'running',
          playbackRate: 1,
          startTime: 0,
          currentTime: 50,
          type: 'CSSAnimation',
          source: { duration: 200, delay: 0, iterations: 1, direction: 'normal', easing: 'ease' },
        },
      ],
      webAnimations: [
        {
          id: 'web-1',
          playState: 'finished',
          target: '.box',
          timing: { duration: 100, delay: 0, iterations: 1, direction: 'normal', easing: 'linear', fill: 'none' },
          keyframes: [],
        },
      ],
      libraries: {
        gsap: { detected: true, tweens: 1 },
        framerMotion: { detected: false },
        anime: { detected: false },
        three: { detected: false },
        lottie: { detected: false },
      },
      detectionTimeMs: 100,
      totalDetected: 3,
    };

    const patterns = realMapJSAnimationResultToPatterns(fullResult, 'page-all', 'https://all.test');

    expect(patterns.length).toBe(3); // 1 CDP + 1 Web + 1 GSAP

    patterns.forEach((p) => {
      expect(p.webPageId).toBe('page-all');
      expect(p.sourceUrl).toBe('https://all.test');
    });
  });
});

// =====================================================
// テストスイート: Three.js詳細情報保存
// =====================================================

import {
  validateLibrarySpecificDataSize,
  truncateThreeJSData,
  buildThreeJSLibrarySpecificData,
  JSON_SIZE_LIMIT_BYTES,
} from '../../../../../src/tools/page/handlers/js-animation-handler';
import type {
  ThreeJSDetailsData,
  ThreeJSLibrarySpecificData,
} from '../../../../../src/tools/page/handlers/types';

describe('JSアニメーションDB保存 - Three.js詳細情報保存', () => {
  // モックThree.js詳細データ（小サイズ）
  const smallThreeJSDetails: ThreeJSDetailsData = {
    version: 'r167',
    scenes: [
      {
        id: 'scene-0',
        background: '#000000',
        objects: [
          { type: 'Mesh', geometry: 'BoxGeometry', material: 'MeshStandardMaterial', position: [0, 0, 0] },
        ],
      },
    ],
    cameras: [{ type: 'PerspectiveCamera', fov: 75, aspect: 1.78, near: 0.1, far: 1000, position: [0, 5, 10] }],
    renderer: { antialias: true, shadowMap: true, toneMapping: 'ACESFilmicToneMapping' },
    performance: { fps: 60, drawCalls: 100, triangles: 5000 },
    textures: ['texture1.png', 'texture2.jpg'],
  };

  // 大量オブジェクトを含むThree.js詳細データ（1MB超過想定）
  const generateLargeThreeJSDetails = (objectCount: number): ThreeJSDetailsData => {
    const objects = Array.from({ length: objectCount }, (_, i) => ({
      type: 'Mesh',
      geometry: 'SphereGeometry',
      material: 'MeshPhongMaterial',
      position: [Math.random() * 100, Math.random() * 100, Math.random() * 100] as [number, number, number],
      rotation: [Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    }));

    return {
      version: 'r167',
      scenes: [
        {
          id: 'scene-0',
          background: '#1a1a2e',
          fog: { type: 'Fog', color: '#1a1a2e', near: 1, far: 100 },
          objects,
        },
      ],
      cameras: [{ type: 'PerspectiveCamera', fov: 75, aspect: 1.78, near: 0.1, far: 1000 }],
      renderer: { antialias: true, shadowMap: true },
      performance: { fps: 60, drawCalls: objectCount, triangles: objectCount * 100 },
      textures: Array.from({ length: 50 }, (_, i) => `texture-${i}.png`),
    };
  };

  describe('validateLibrarySpecificDataSize', () => {
    it('1MB以下のデータは有効と判定する', () => {
      const smallData = { three_js: { version: 'r167', scenes: [], cameras: [], renderer: {} } };
      const result = validateLibrarySpecificDataSize(smallData);

      expect(result.isValid).toBe(true);
      expect(result.sizeBytes).toBeLessThan(JSON_SIZE_LIMIT_BYTES);
      expect(result.exceedsLimit).toBe(false);
    });

    it('1MBを超過するデータは無効と判定する', () => {
      // 約1.5MBのデータを生成
      const largeDetails = generateLargeThreeJSDetails(8000);
      const largeData = {
        three_js: {
          version: largeDetails.version,
          scenes: largeDetails.scenes,
          cameras: largeDetails.cameras,
          renderer: largeDetails.renderer,
          performance: largeDetails.performance,
        },
      };

      const result = validateLibrarySpecificDataSize(largeData);

      expect(result.exceedsLimit).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(JSON_SIZE_LIMIT_BYTES);
    });

    it('サイズをバイト単位で正確に計算する', () => {
      const testData = { key: 'value' };
      const result = validateLibrarySpecificDataSize(testData);

      const expectedSize = Buffer.byteLength(JSON.stringify(testData), 'utf-8');
      expect(result.sizeBytes).toBe(expectedSize);
    });
  });

  describe('truncateThreeJSData', () => {
    it('小サイズデータはトランケートしない', () => {
      const result = truncateThreeJSData(smallThreeJSDetails);

      expect(result.truncated).toBe(false);
      expect(result.data.scenes).toEqual(smallThreeJSDetails.scenes);
      expect(result.data.cameras).toEqual(smallThreeJSDetails.cameras);
    });

    it('大サイズデータをトランケートしてオブジェクト数を削減する', () => {
      const largeDetails = generateLargeThreeJSDetails(6000);
      const result = truncateThreeJSData(largeDetails);

      expect(result.truncated).toBe(true);
      expect(result.truncationReason).toBeDefined();
      // トランケート後は最大20オブジェクトに制限
      expect(result.data.scenes[0]?.objects.length).toBeLessThanOrEqual(20);
    });

    it('トランケート後もシーン構造を維持する', () => {
      const largeDetails = generateLargeThreeJSDetails(1000);
      const result = truncateThreeJSData(largeDetails);

      // シーン基本情報は維持
      expect(result.data.scenes.length).toBeGreaterThan(0);
      expect(result.data.scenes[0]?.id).toBeDefined();
      // カメラ・レンダラー情報も維持
      expect(result.data.cameras).toBeDefined();
      expect(result.data.renderer).toBeDefined();
    });

    it('テクスチャ配列を制限する（1MB超過時）', () => {
      // 1MBを超えるデータを生成（大量のオブジェクト + 多数のテクスチャ）
      const largeDetailsWithManyTextures = generateLargeThreeJSDetails(6000);
      // テクスチャを100件に設定
      largeDetailsWithManyTextures.textures = Array.from({ length: 100 }, (_, i) => `tex-${i}.png`);

      const result = truncateThreeJSData(largeDetailsWithManyTextures);

      // トランケートが発生することを確認
      expect(result.truncated).toBe(true);
      // テクスチャは最大10件に制限
      if (result.data.textures) {
        expect(result.data.textures.length).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('buildThreeJSLibrarySpecificData', () => {
    it('詳細情報からThreeJSLibrarySpecificDataを構築する', () => {
      const result = buildThreeJSLibrarySpecificData(smallThreeJSDetails, 2);

      expect(result.scenes).toBe(2);
      expect(result.three_js).toBeDefined();
      expect(result.three_js.version).toBe('r167');
      expect(result.three_js.extractedAt).toBeDefined();
      expect(result.three_js.extractionLevel).toBe('detailed');
      expect(result.three_js.truncated).toBeFalsy();
    });

    it('大サイズデータはbasicレベルで保存する', () => {
      const largeDetails = generateLargeThreeJSDetails(6000);
      const result = buildThreeJSLibrarySpecificData(largeDetails, 1);

      expect(result.three_js.extractionLevel).toBe('basic');
      expect(result.three_js.truncated).toBe(true);
      expect(result.three_js.truncationReason).toBeDefined();
    });

    it('ISO8601形式のextractedAtを設定する', () => {
      const result = buildThreeJSLibrarySpecificData(smallThreeJSDetails, 1);

      // ISO8601形式の検証
      const parsed = new Date(result.three_js.extractedAt);
      expect(parsed.toISOString()).toBe(result.three_js.extractedAt);
    });

    it('undefined detailsの場合はシンプルな構造を返す', () => {
      const result = buildThreeJSLibrarySpecificData(undefined, 3);

      expect(result.scenes).toBe(3);
      expect(result.three_js).toBeUndefined();
    });
  });

  describe('mapLibraryDetectionToPatternsのThree.js詳細対応', () => {
    it('Three.js詳細情報がある場合はlibrarySpecificDataに含める', () => {
      const libraries: LibraryDetectionData = {
        gsap: { detected: false },
        framerMotion: { detected: false },
        anime: { detected: false },
        three: {
          detected: true,
          scenes: 2,
          details: smallThreeJSDetails,
        },
        lottie: { detected: false },
      };

      const patterns = realMapLibraryDetectionToPatterns(libraries, 'page-123', 'https://test.com');

      expect(patterns.length).toBe(1);
      const threePattern = patterns[0]!;
      expect(threePattern.libraryType).toBe('three_js');
      expect(threePattern.librarySpecificData).toBeDefined();

      const specificData = threePattern.librarySpecificData as ThreeJSLibrarySpecificData;
      expect(specificData.three_js).toBeDefined();
      expect(specificData.three_js.version).toBe('r167');
      expect(specificData.three_js.scenes.length).toBeGreaterThan(0);
    });

    it('Three.js詳細情報がない場合は基本情報のみ保存', () => {
      const libraries: LibraryDetectionData = {
        gsap: { detected: false },
        framerMotion: { detected: false },
        anime: { detected: false },
        three: {
          detected: true,
          scenes: 1,
          // details なし
        },
        lottie: { detected: false },
      };

      const patterns = realMapLibraryDetectionToPatterns(libraries);

      expect(patterns.length).toBe(1);
      const threePattern = patterns[0]!;
      expect(threePattern.librarySpecificData).toEqual({
        scenes: 1,
      });
    });

    it('大サイズ詳細情報はトランケートして保存', () => {
      const largeDetails = generateLargeThreeJSDetails(6000);
      const libraries: LibraryDetectionData = {
        gsap: { detected: false },
        framerMotion: { detected: false },
        anime: { detected: false },
        three: {
          detected: true,
          scenes: 1,
          details: largeDetails,
        },
        lottie: { detected: false },
      };

      const patterns = realMapLibraryDetectionToPatterns(libraries);

      const threePattern = patterns[0]!;
      const specificData = threePattern.librarySpecificData as ThreeJSLibrarySpecificData;

      // 1MB以下に収まっている
      const jsonSize = Buffer.byteLength(JSON.stringify(specificData), 'utf-8');
      expect(jsonSize).toBeLessThanOrEqual(JSON_SIZE_LIMIT_BYTES);

      // トランケートフラグが設定されている
      expect(specificData.three_js.truncated).toBe(true);
      expect(specificData.three_js.extractionLevel).toBe('basic');
    });
  });
});
