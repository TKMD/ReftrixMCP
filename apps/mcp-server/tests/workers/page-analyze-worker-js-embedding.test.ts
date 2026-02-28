// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Page Analyze Worker - JSAnimation TextRepresentation Tests
 *
 * generateJsAnimationTextRepresentation関数のユニットテスト:
 * - CDPアニメーション → テキスト変換（duration, easing, properties含む）
 * - WebAnimation → テキスト変換（target, duration, easing含む）
 * - ライブラリ検出情報の付加（GSAP等）
 * - 該当アニメーションが見つからない場合のフォールバック
 * - passage:プレフィックスが付与されていること
 * - 空のjs_animationsでのハンドリング
 *
 * @module tests/workers/page-analyze-worker-js-embedding
 */

import { describe, it, expect } from 'vitest';
import { generateJsAnimationTextRepresentation } from '../../src/workers/page-analyze-worker';
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
    id: 'cdp-001',
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
    },
    ...overrides,
  };
}

/** WebAnimationDataのサンプル生成 */
function createWebAnimation(overrides?: Partial<WebAnimationData>): WebAnimationData {
  return {
    id: 'web-001',
    playState: 'running',
    target: 'div.hero > h1',
    timing: {
      duration: 500,
      delay: 0,
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

// =============================================================================
// テスト本体
// =============================================================================

describe('generateJsAnimationTextRepresentation', () => {
  // ---------------------------------------------------------------------------
  // passage:プレフィックスの検証
  // ---------------------------------------------------------------------------
  describe('passage:プレフィックス', () => {
    it('すべての出力にpassage:プレフィックスが付与される', () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).toMatch(/^passage: /);
    });

    it('フォールバック時もpassage:プレフィックスが付与される', () => {
      const jsAnimations = createJsAnimations();

      const result = generateJsAnimationTextRepresentation('unknown-id', jsAnimations);

      expect(result).toMatch(/^passage: /);
    });
  });

  // ---------------------------------------------------------------------------
  // CDPアニメーション → テキスト変換
  // ---------------------------------------------------------------------------
  describe('CDPアニメーション変換', () => {
    it('CDPアニメーションの基本情報がテキストに含まれる', () => {
      const cdpAnim = createCdpAnimation({
        name: 'slideUp',
        type: 'CSSAnimation',
        playState: 'running',
        source: {
          duration: 600,
          delay: 0,
          iterations: 1,
          direction: 'normal',
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
        },
      });
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).toContain('slideUp');
      expect(result).toContain('CSSAnimation');
      expect(result).toContain('Duration: 600ms');
      expect(result).toContain('Easing: cubic-bezier(0.4, 0, 0.2, 1)');
      expect(result).toContain('Play state: running');
    });

    it('duration=0の場合、Duration行がスキップされる', () => {
      const cdpAnim = createCdpAnimation({
        source: {
          duration: 0,
          delay: 0,
          iterations: 1,
          direction: 'normal',
          easing: 'ease',
        },
      });
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).not.toContain('Duration:');
    });

    it('easing未設定の場合、Easing行がスキップされる', () => {
      const cdpAnim = createCdpAnimation({
        source: {
          duration: 300,
          delay: 0,
          iterations: 1,
          direction: 'normal',
          easing: '',
        },
      });
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).not.toContain('Easing:');
    });

    it('name未設定の場合、typeがフォールバック名として使用される', () => {
      const cdpAnim = createCdpAnimation({
        name: '',
        type: 'CSSTransition',
      });
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).toContain('CSSTransition');
    });

    it('durationが四捨五入される', () => {
      const cdpAnim = createCdpAnimation({
        source: {
          duration: 333.7,
          delay: 0,
          iterations: 1,
          direction: 'normal',
          easing: 'ease',
        },
      });
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).toContain('Duration: 334ms');
    });
  });

  // ---------------------------------------------------------------------------
  // WebAnimation → テキスト変換
  // ---------------------------------------------------------------------------
  describe('WebAnimation変換', () => {
    it('WebAnimationの基本情報がテキストに含まれる', () => {
      const webAnim = createWebAnimation({
        target: 'div.card',
        playState: 'finished',
        timing: {
          duration: 400,
          delay: 0,
          iterations: 3,
          direction: 'normal',
          easing: 'ease',
          fill: 'forwards',
        },
      });
      const jsAnimations = createJsAnimations([], [webAnim]);

      const result = generateJsAnimationTextRepresentation('web-001', jsAnimations);

      expect(result).toContain('WebAnimation on div.card');
      expect(result).toContain('Web Animations API');
      expect(result).toContain('Duration: 400ms');
      expect(result).toContain('Easing: ease');
      expect(result).toContain('Iterations: 3');
      expect(result).toContain('Play state: finished');
    });

    it('iterations=1の場合、Iterations行がスキップされる', () => {
      const webAnim = createWebAnimation({
        timing: {
          duration: 400,
          delay: 0,
          iterations: 1,
          direction: 'normal',
          easing: 'ease',
          fill: 'forwards',
        },
      });
      const jsAnimations = createJsAnimations([], [webAnim]);

      const result = generateJsAnimationTextRepresentation('web-001', jsAnimations);

      expect(result).not.toContain('Iterations:');
    });

    it('キーフレームのプロパティがProperties行に含まれる', () => {
      const webAnim = createWebAnimation({
        keyframes: [
          { offset: 0, easing: 'linear', composite: 'replace', opacity: '0', transform: 'scale(0)' },
          { offset: 1, easing: 'linear', composite: 'replace', opacity: '1', transform: 'scale(1)' },
        ],
      });
      const jsAnimations = createJsAnimations([], [webAnim]);

      const result = generateJsAnimationTextRepresentation('web-001', jsAnimations);

      expect(result).toContain('Properties:');
      expect(result).toContain('opacity');
      expect(result).toContain('transform');
      // offset, easing, compositeは含まれない
      expect(result).not.toMatch(/Properties:.*offset/);
      expect(result).not.toMatch(/Properties:.*composite/);
    });

    it('キーフレームが空の場合、Properties行がスキップされる', () => {
      const webAnim = createWebAnimation({ keyframes: [] });
      const jsAnimations = createJsAnimations([], [webAnim]);

      const result = generateJsAnimationTextRepresentation('web-001', jsAnimations);

      expect(result).not.toContain('Properties:');
    });

    it('長いtargetが100文字に切り詰められる', () => {
      const longTarget = 'div.section > ' + 'a'.repeat(200);
      const webAnim = createWebAnimation({ target: longTarget });
      const jsAnimations = createJsAnimations([], [webAnim]);

      const result = generateJsAnimationTextRepresentation('web-001', jsAnimations);

      // target is sliced to 100 chars in the text representation
      expect(result).toContain('WebAnimation on ' + longTarget.slice(0, 100));
    });
  });

  // ---------------------------------------------------------------------------
  // ライブラリ検出情報の付加
  // ---------------------------------------------------------------------------
  describe('ライブラリ検出情報', () => {
    it('GSAP検出時、Libraries行にGSAPが含まれる', () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations(
        [cdpAnim], [],
        { gsap: { detected: true } }
      );

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).toContain('Libraries: GSAP');
    });

    it('複数ライブラリ検出時、全てがカンマ区切りで含まれる', () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations(
        [cdpAnim], [],
        {
          gsap: { detected: true },
          framerMotion: { detected: true },
          lottie: { detected: true },
        }
      );

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).toContain('GSAP');
      expect(result).toContain('Framer Motion');
      expect(result).toContain('Lottie');
    });

    it('ライブラリ未検出時、Libraries行がスキップされる', () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).not.toContain('Libraries:');
    });

    it('Three.js検出時、Three.jsが含まれる', () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations(
        [cdpAnim], [],
        { three: { detected: true, scenes: 2 } }
      );

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).toContain('Three.js');
    });

    it('anime.js検出時、anime.jsが含まれる', () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations(
        [cdpAnim], [],
        { anime: { detected: true } }
      );

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).toContain('anime.js');
    });
  });

  // ---------------------------------------------------------------------------
  // フォールバック（該当IDなし）
  // ---------------------------------------------------------------------------
  describe('フォールバック', () => {
    it('CDPにもWebにも該当IDがない場合、フォールバックテキストが返される', () => {
      const cdpAnim = createCdpAnimation({ id: 'different-id' });
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = generateJsAnimationTextRepresentation('unknown-id', jsAnimations);

      expect(result).toContain('JavaScript animation: pattern unknown-id');
    });

    it('フォールバック時もライブラリ情報は付加される', () => {
      const jsAnimations = createJsAnimations(
        [], [],
        { gsap: { detected: true } }
      );

      const result = generateJsAnimationTextRepresentation('no-match', jsAnimations);

      expect(result).toContain('Libraries: GSAP');
      expect(result).toContain('pattern no-match');
    });
  });

  // ---------------------------------------------------------------------------
  // 空のjs_animationsでのハンドリング
  // ---------------------------------------------------------------------------
  describe('空のjs_animations', () => {
    it('CDP/Web両方空でもエラーなくフォールバックテキストが返される', () => {
      const jsAnimations = createJsAnimations();

      const result = generateJsAnimationTextRepresentation('some-id', jsAnimations);

      expect(result).toMatch(/^passage: /);
      expect(result).toContain('pattern some-id');
    });
  });

  // ---------------------------------------------------------------------------
  // テキスト末尾がピリオドで終わる
  // ---------------------------------------------------------------------------
  describe('出力形式', () => {
    it('テキスト末尾がピリオドで終わる', () => {
      const cdpAnim = createCdpAnimation();
      const jsAnimations = createJsAnimations([cdpAnim]);

      const result = generateJsAnimationTextRepresentation('cdp-001', jsAnimations);

      expect(result).toMatch(/\.$/);
    });
  });
});
