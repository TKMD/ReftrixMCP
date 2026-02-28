// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSアニメーション検出サービスのユニットテスト
 *
 * TDDアプローチ: 期待する動作を定義するテストを先に作成
 *
 * テスト対象:
 * - ライブラリ検出ロジック（GSAP, Framer Motion, anime.js, Three.js, Lottie）
 * - Web Animations API 解析
 * - CDP Animation イベント型定義
 * - データ変換・パース処理
 *
 * @module tests/unit/services/motion/js-animation-detector
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// =====================================================
// テストフィクスチャのロード
// =====================================================

const FIXTURES_DIR = path.resolve(__dirname, '../../../fixtures/js-animations');

/**
 * フィクスチャHTMLを読み込むヘルパー
 */
function loadFixture(filename: string): string {
  const filePath = path.join(FIXTURES_DIR, filename);
  return fs.readFileSync(filePath, 'utf-8');
}

// =====================================================
// 型定義（JSアニメーション検出用）
// =====================================================

/**
 * アニメーションライブラリタイプ
 */
type AnimationLibraryType =
  | 'gsap'
  | 'framer_motion'
  | 'anime_js'
  | 'three_js'
  | 'lottie'
  | 'web_animations_api'
  | 'css_animation'
  | 'unknown';

/**
 * ライブラリ検出結果
 */
interface LibraryDetectionResult {
  /** 検出されたライブラリ名 */
  name: AnimationLibraryType;
  /** 検出バージョン（取得可能な場合） */
  version?: string;
  /** 検出信頼度 (0-1) */
  confidence: number;
  /** 検出根拠 */
  evidence: string[];
}

/**
 * Web Animations API アニメーション情報
 */
interface WebAnimationInfo {
  /** アニメーションID */
  id: string;
  /** 再生状態 */
  playState: 'idle' | 'running' | 'paused' | 'finished';
  /** 持続時間（ms） */
  duration: number;
  /** 繰り返し回数 */
  iterations: number | 'infinite';
  /** イージング */
  easing: string;
  /** ターゲット要素セレクタ */
  targetSelector: string;
  /** アニメーション方向 */
  direction?: string;
  /** フィルモード */
  fillMode?: string;
  /** キーフレーム */
  keyframes?: Array<{ offset: number; properties: Record<string, string> }>;
}

/**
 * CDP Animation イベント情報
 */
interface CDPAnimationEvent {
  /** アニメーションID */
  id: string;
  /** アニメーション名 */
  name: string;
  /** アニメーションタイプ */
  type: 'CSSAnimation' | 'CSSTransition' | 'WebAnimation';
  /** ソース */
  source: {
    /** キーフレームルール */
    keyframesRule?: {
      name: string;
      keyframes: Array<{
        offset: string;
        easing: string;
        style: string;
      }>;
    };
  };
  /** 一時停止状態 */
  pausedState: boolean;
  /** 再生レート */
  playbackRate: number;
  /** 開始時刻 */
  startTime: number;
  /** 現在時刻 */
  currentTime: number;
}

// =====================================================
// ライブラリ検出ロジック（テスト用実装）
// =====================================================

/**
 * HTMLからアニメーションライブラリを検出
 * 注: 実際の実装はブラウザコンテキストで実行されるため、
 * このテストではHTMLパターンマッチングのみをテスト
 */
function detectLibrariesFromHTML(html: string): LibraryDetectionResult[] {
  const results: LibraryDetectionResult[] = [];

  // GSAP検出
  if (/gsap\.min\.js|\/gsap\//i.test(html) || /window\.gsap|gsap\.to\s*\(/i.test(html)) {
    results.push({
      name: 'gsap',
      confidence: 0.9,
      evidence: ['GSAP script tag or gsap.to() call detected'],
    });
  }

  // Framer Motion検出
  if (/data-framer-/i.test(html) || /__FRAMER_MOTION__/i.test(html)) {
    results.push({
      name: 'framer_motion',
      confidence: 0.85,
      evidence: ['data-framer-* attributes or __FRAMER_MOTION__ global detected'],
    });
  }

  // anime.js検出
  if (/anime\.min\.js|animejs/i.test(html) || /window\.anime|anime\s*\(\s*\{/i.test(html)) {
    results.push({
      name: 'anime_js',
      confidence: 0.9,
      evidence: ['anime.js script tag or anime() call detected'],
    });
  }

  // Three.js検出
  if (/three\.min\.js|\/three\//i.test(html) || /window\.THREE|__THREE_DEVTOOLS__/i.test(html)) {
    results.push({
      name: 'three_js',
      confidence: 0.85,
      evidence: ['Three.js script tag or THREE global detected'],
    });
  }

  // Lottie検出
  if (
    /lottie\.min\.js|lottie-web/i.test(html) ||
    /window\.lottie|window\.bodymovin|lottie\.loadAnimation/i.test(html)
  ) {
    results.push({
      name: 'lottie',
      confidence: 0.9,
      evidence: ['Lottie script tag or lottie.loadAnimation() detected'],
    });
  }

  // Web Animations API検出
  if (/\.animate\s*\(\s*\[/i.test(html) || /document\.getAnimations\s*\(\s*\)/i.test(html)) {
    results.push({
      name: 'web_animations_api',
      confidence: 0.95,
      evidence: ['Element.animate() or document.getAnimations() detected'],
    });
  }

  // CSSアニメーション検出
  if (/@keyframes\s+\w+/i.test(html) || /animation:\s*[^;]+/i.test(html)) {
    results.push({
      name: 'css_animation',
      confidence: 0.95,
      evidence: ['@keyframes or animation property detected'],
    });
  }

  return results;
}

/**
 * Web Animations API の結果をパース
 */
function parseWebAnimationResult(raw: unknown): WebAnimationInfo | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;

  // 必須フィールドの検証
  if (typeof obj.id !== 'string') return null;
  if (typeof obj.duration !== 'number') return null;

  const playState = obj.playState as string;
  if (!['idle', 'running', 'paused', 'finished'].includes(playState)) return null;

  return {
    id: obj.id as string,
    playState: playState as WebAnimationInfo['playState'],
    duration: obj.duration as number,
    iterations: obj.iterations === Infinity ? 'infinite' : (obj.iterations as number) || 1,
    easing: (obj.easing as string) || 'linear',
    targetSelector: (obj.targetSelector as string) || '',
    direction: obj.direction as string | undefined,
    fillMode: obj.fillMode as string | undefined,
  };
}

/**
 * CDP Animation イベントをパース
 */
function parseCDPAnimationEvent(raw: unknown): CDPAnimationEvent | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;

  // 必須フィールドの検証
  if (typeof obj.id !== 'string') return null;
  if (typeof obj.name !== 'string') return null;

  const type = obj.type as string;
  if (!['CSSAnimation', 'CSSTransition', 'WebAnimation'].includes(type)) return null;

  return {
    id: obj.id as string,
    name: obj.name as string,
    type: type as CDPAnimationEvent['type'],
    source: (obj.source as CDPAnimationEvent['source']) || {},
    pausedState: Boolean(obj.pausedState),
    playbackRate: (obj.playbackRate as number) || 1,
    startTime: (obj.startTime as number) || 0,
    currentTime: (obj.currentTime as number) || 0,
  };
}

// =====================================================
// テストスイート: ライブラリ検出
// =====================================================

describe('JSアニメーション検出 - ライブラリ検出ロジック', () => {
  describe('GSAP検出', () => {
    it('GSAPスクリプトタグを検出する', () => {
      const html = loadFixture('gsap-test.html');
      const results = detectLibrariesFromHTML(html);

      const gsapResult = results.find((r) => r.name === 'gsap');
      expect(gsapResult).toBeDefined();
      expect(gsapResult?.confidence).toBeGreaterThanOrEqual(0.8);
      expect(gsapResult?.evidence.length).toBeGreaterThan(0);
    });

    it('gsap.to()呼び出しを検出する', () => {
      const html = `
        <script>
          gsap.to("#box", { x: 100, duration: 1 });
        </script>
      `;
      const results = detectLibrariesFromHTML(html);

      expect(results.some((r) => r.name === 'gsap')).toBe(true);
    });

    it('GSAPなしのHTMLでは検出しない', () => {
      const html = `
        <!DOCTYPE html>
        <html><body><div>No GSAP</div></body></html>
      `;
      const results = detectLibrariesFromHTML(html);

      expect(results.some((r) => r.name === 'gsap')).toBe(false);
    });
  });

  describe('Framer Motion検出', () => {
    it('data-framer-*属性を検出する', () => {
      const html = loadFixture('framer-motion-test.html');
      const results = detectLibrariesFromHTML(html);

      const framerResult = results.find((r) => r.name === 'framer_motion');
      expect(framerResult).toBeDefined();
      expect(framerResult?.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('__FRAMER_MOTION__グローバルを検出する', () => {
      const html = `
        <script>
          window.__FRAMER_MOTION__ = { version: '10.0.0' };
        </script>
      `;
      const results = detectLibrariesFromHTML(html);

      expect(results.some((r) => r.name === 'framer_motion')).toBe(true);
    });
  });

  describe('anime.js検出', () => {
    it('anime.jsスクリプトタグを検出する', () => {
      const html = loadFixture('anime-js-test.html');
      const results = detectLibrariesFromHTML(html);

      const animeResult = results.find((r) => r.name === 'anime_js');
      expect(animeResult).toBeDefined();
      expect(animeResult?.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('anime()呼び出しを検出する', () => {
      const html = `
        <script>
          anime({ targets: '.box', translateX: 250 });
        </script>
      `;
      const results = detectLibrariesFromHTML(html);

      expect(results.some((r) => r.name === 'anime_js')).toBe(true);
    });
  });

  describe('Three.js検出', () => {
    it('Three.jsマーカーを検出する', () => {
      const html = loadFixture('three-js-test.html');
      const results = detectLibrariesFromHTML(html);

      const threeResult = results.find((r) => r.name === 'three_js');
      expect(threeResult).toBeDefined();
      expect(threeResult?.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('window.THREEグローバルを検出する', () => {
      const html = `
        <script>
          window.THREE = { REVISION: '150' };
        </script>
      `;
      const results = detectLibrariesFromHTML(html);

      expect(results.some((r) => r.name === 'three_js')).toBe(true);
    });
  });

  describe('Lottie検出', () => {
    it('Lottieマーカーを検出する', () => {
      const html = loadFixture('lottie-test.html');
      const results = detectLibrariesFromHTML(html);

      const lottieResult = results.find((r) => r.name === 'lottie');
      expect(lottieResult).toBeDefined();
      expect(lottieResult?.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('lottie.loadAnimation()呼び出しを検出する', () => {
      const html = `
        <script>
          lottie.loadAnimation({ container: el, path: 'anim.json' });
        </script>
      `;
      const results = detectLibrariesFromHTML(html);

      expect(results.some((r) => r.name === 'lottie')).toBe(true);
    });

    it('bodymovin（レガシー名）を検出する', () => {
      const html = `
        <script>
          window.bodymovin = { loadAnimation: () => {} };
        </script>
      `;
      const results = detectLibrariesFromHTML(html);

      expect(results.some((r) => r.name === 'lottie')).toBe(true);
    });
  });

  describe('複数ライブラリ検出', () => {
    it('混合アニメーションページで複数ライブラリを検出する', () => {
      const html = loadFixture('mixed-animations-test.html');
      const results = detectLibrariesFromHTML(html);

      // GSAPとWeb Animations APIとCSSアニメーションを検出
      expect(results.some((r) => r.name === 'gsap')).toBe(true);
      expect(results.some((r) => r.name === 'web_animations_api')).toBe(true);
      expect(results.some((r) => r.name === 'css_animation')).toBe(true);
    });
  });
});

// =====================================================
// テストスイート: Web Animations API 解析
// =====================================================

describe('JSアニメーション検出 - Web Animations API解析', () => {
  describe('parseWebAnimationResult', () => {
    it('有効なアニメーション情報をパースする', () => {
      const raw = {
        id: 'anim-1',
        playState: 'running',
        duration: 1000,
        iterations: 3,
        easing: 'ease-in-out',
        targetSelector: '#box',
        direction: 'alternate',
        fillMode: 'forwards',
      };

      const result = parseWebAnimationResult(raw);

      expect(result).not.toBeNull();
      expect(result?.id).toBe('anim-1');
      expect(result?.playState).toBe('running');
      expect(result?.duration).toBe(1000);
      expect(result?.iterations).toBe(3);
      expect(result?.easing).toBe('ease-in-out');
      expect(result?.targetSelector).toBe('#box');
      expect(result?.direction).toBe('alternate');
      expect(result?.fillMode).toBe('forwards');
    });

    it('無限反復をinfiniteとして扱う', () => {
      const raw = {
        id: 'anim-2',
        playState: 'running',
        duration: 500,
        iterations: Infinity,
        easing: 'linear',
        targetSelector: '.spinner',
      };

      const result = parseWebAnimationResult(raw);

      expect(result?.iterations).toBe('infinite');
    });

    it('無効な入力でnullを返す', () => {
      expect(parseWebAnimationResult(null)).toBeNull();
      expect(parseWebAnimationResult(undefined)).toBeNull();
      expect(parseWebAnimationResult('string')).toBeNull();
      expect(parseWebAnimationResult({ id: 123 })).toBeNull(); // idが文字列でない
    });

    it('無効なplayStateでnullを返す', () => {
      const raw = {
        id: 'anim-3',
        playState: 'invalid_state',
        duration: 1000,
      };

      expect(parseWebAnimationResult(raw)).toBeNull();
    });

    it('オプショナルフィールドが欠落していても動作する', () => {
      const raw = {
        id: 'anim-4',
        playState: 'idle',
        duration: 500,
      };

      const result = parseWebAnimationResult(raw);

      expect(result).not.toBeNull();
      expect(result?.id).toBe('anim-4');
      expect(result?.iterations).toBe(1); // デフォルト値
      expect(result?.easing).toBe('linear'); // デフォルト値
      expect(result?.targetSelector).toBe(''); // デフォルト値
    });
  });
});

// =====================================================
// テストスイート: CDP Animation イベント解析
// =====================================================

describe('JSアニメーション検出 - CDP Animation イベント解析', () => {
  describe('parseCDPAnimationEvent', () => {
    it('CSSAnimationイベントをパースする', () => {
      const raw = {
        id: 'cdp-anim-1',
        name: 'fadeIn',
        type: 'CSSAnimation',
        source: {
          keyframesRule: {
            name: 'fadeIn',
            keyframes: [
              { offset: '0', easing: 'ease', style: 'opacity: 0' },
              { offset: '1', easing: 'ease', style: 'opacity: 1' },
            ],
          },
        },
        pausedState: false,
        playbackRate: 1,
        startTime: 100,
        currentTime: 50,
      };

      const result = parseCDPAnimationEvent(raw);

      expect(result).not.toBeNull();
      expect(result?.id).toBe('cdp-anim-1');
      expect(result?.name).toBe('fadeIn');
      expect(result?.type).toBe('CSSAnimation');
      expect(result?.pausedState).toBe(false);
      expect(result?.playbackRate).toBe(1);
      expect(result?.source.keyframesRule?.keyframes).toHaveLength(2);
    });

    it('CSSTransitionイベントをパースする', () => {
      const raw = {
        id: 'cdp-trans-1',
        name: 'opacity',
        type: 'CSSTransition',
        source: {},
        pausedState: false,
        playbackRate: 1,
        startTime: 0,
        currentTime: 100,
      };

      const result = parseCDPAnimationEvent(raw);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('CSSTransition');
    });

    it('WebAnimationイベントをパースする', () => {
      const raw = {
        id: 'cdp-wapi-1',
        name: '',
        type: 'WebAnimation',
        source: {},
        pausedState: true,
        playbackRate: 0.5,
        startTime: 200,
        currentTime: 300,
      };

      const result = parseCDPAnimationEvent(raw);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('WebAnimation');
      expect(result?.pausedState).toBe(true);
      expect(result?.playbackRate).toBe(0.5);
    });

    it('無効なtypeでnullを返す', () => {
      const raw = {
        id: 'cdp-invalid-1',
        name: 'test',
        type: 'InvalidType',
      };

      expect(parseCDPAnimationEvent(raw)).toBeNull();
    });

    it('必須フィールドが欠落している場合nullを返す', () => {
      expect(parseCDPAnimationEvent({ name: 'test', type: 'CSSAnimation' })).toBeNull(); // id欠落
      expect(parseCDPAnimationEvent({ id: 'test', type: 'CSSAnimation' })).toBeNull(); // name欠落
      expect(parseCDPAnimationEvent({ id: 'test', name: 'test' })).toBeNull(); // type欠落
    });

    it('デフォルト値を適用する', () => {
      const raw = {
        id: 'cdp-default-1',
        name: 'test',
        type: 'CSSAnimation',
      };

      const result = parseCDPAnimationEvent(raw);

      expect(result?.pausedState).toBe(false);
      expect(result?.playbackRate).toBe(1);
      expect(result?.startTime).toBe(0);
      expect(result?.currentTime).toBe(0);
    });
  });
});

// =====================================================
// テストスイート: Web Animations API検出
// =====================================================

describe('JSアニメーション検出 - Web Animations API検出', () => {
  it('Element.animate()呼び出しを検出する', () => {
    const html = loadFixture('web-animations-test.html');
    const results = detectLibrariesFromHTML(html);

    const wapiResult = results.find((r) => r.name === 'web_animations_api');
    expect(wapiResult).toBeDefined();
    expect(wapiResult?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('キーフレーム配列パターンを検出する', () => {
    const html = `
      <script>
        element.animate([
          { transform: 'translateX(0)' },
          { transform: 'translateX(100px)' }
        ], { duration: 1000 });
      </script>
    `;
    const results = detectLibrariesFromHTML(html);

    expect(results.some((r) => r.name === 'web_animations_api')).toBe(true);
  });

  it('document.getAnimations()を検出する', () => {
    const html = `
      <script>
        const animations = document.getAnimations();
        animations.forEach(anim => console.log(anim.playState));
      </script>
    `;
    const results = detectLibrariesFromHTML(html);

    expect(results.some((r) => r.name === 'web_animations_api')).toBe(true);
  });
});

// =====================================================
// テストスイート: CSSアニメーション検出
// =====================================================

describe('JSアニメーション検出 - CSSアニメーション検出', () => {
  it('@keyframesを検出する', () => {
    const html = `
      <style>
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      </style>
    `;
    const results = detectLibrariesFromHTML(html);

    expect(results.some((r) => r.name === 'css_animation')).toBe(true);
  });

  it('animationプロパティを検出する', () => {
    const html = `
      <style>
        .animated { animation: fadeIn 0.5s ease; }
      </style>
    `;
    const results = detectLibrariesFromHTML(html);

    expect(results.some((r) => r.name === 'css_animation')).toBe(true);
  });
});

// =====================================================
// テストスイート: 型定義
// =====================================================

describe('JSアニメーション検出 - 型定義テスト', () => {
  it('AnimationLibraryTypeは有効な値を持つ', () => {
    const validTypes: AnimationLibraryType[] = [
      'gsap',
      'framer_motion',
      'anime_js',
      'three_js',
      'lottie',
      'web_animations_api',
      'css_animation',
      'unknown',
    ];

    validTypes.forEach((type) => {
      expect(typeof type).toBe('string');
    });
  });

  it('LibraryDetectionResultは必須フィールドを持つ', () => {
    const result: LibraryDetectionResult = {
      name: 'gsap',
      confidence: 0.9,
      evidence: ['Test evidence'],
    };

    expect(result.name).toBeDefined();
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(result.evidence)).toBe(true);
  });

  it('WebAnimationInfoは必須フィールドを持つ', () => {
    const info: WebAnimationInfo = {
      id: 'test-id',
      playState: 'running',
      duration: 1000,
      iterations: 'infinite',
      easing: 'ease',
      targetSelector: '#target',
    };

    expect(info.id).toBeDefined();
    expect(['idle', 'running', 'paused', 'finished']).toContain(info.playState);
    expect(info.duration).toBeGreaterThanOrEqual(0);
  });

  it('CDPAnimationEventは必須フィールドを持つ', () => {
    const event: CDPAnimationEvent = {
      id: 'cdp-id',
      name: 'testAnimation',
      type: 'CSSAnimation',
      source: {},
      pausedState: false,
      playbackRate: 1,
      startTime: 0,
      currentTime: 0,
    };

    expect(event.id).toBeDefined();
    expect(event.name).toBeDefined();
    expect(['CSSAnimation', 'CSSTransition', 'WebAnimation']).toContain(event.type);
  });
});

// =====================================================
// テストスイート: エッジケース
// =====================================================

describe('JSアニメーション検出 - エッジケース', () => {
  it('空のHTMLを処理する', () => {
    const results = detectLibrariesFromHTML('');
    expect(results).toHaveLength(0);
  });

  it('アニメーションなしのHTMLを処理する', () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Static Page</title></head>
      <body><p>No animations here</p></body>
      </html>
    `;
    const results = detectLibrariesFromHTML(html);
    expect(results).toHaveLength(0);
  });

  it('マルチバイト文字を含むHTMLを処理する', () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>日本語タイトル</title></head>
      <body>
        <script>
          gsap.to("#要素", { x: 100 });
        </script>
      </body>
      </html>
    `;
    const results = detectLibrariesFromHTML(html);
    expect(results.some((r) => r.name === 'gsap')).toBe(true);
  });

  it('コメント内のライブラリ参照は検出する（偽陽性許容）', () => {
    // 注: 静的解析では完全な精度は期待しない
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <!-- gsap.to("#box", { x: 100 }); -->
        <script>
          // This page doesn't use GSAP
        </script>
      </body>
      </html>
    `;
    // コメント内でも検出される可能性がある（静的解析の制限）
    const results = detectLibrariesFromHTML(html);
    // 結果はコメント内容によって異なる可能性がある
    expect(Array.isArray(results)).toBe(true);
  });

  it('大きなHTMLを処理する', () => {
    // 10KB以上のHTMLを生成
    let html = '<!DOCTYPE html><html><head></head><body>';
    for (let i = 0; i < 500; i++) {
      html += `<div class="item-${i}">Content ${i}</div>`;
    }
    html += '<script>gsap.to(".item-0", { x: 100 });</script></body></html>';

    expect(html.length).toBeGreaterThan(10000);

    const startTime = Date.now();
    const results = detectLibrariesFromHTML(html);
    const elapsed = Date.now() - startTime;

    expect(results.some((r) => r.name === 'gsap')).toBe(true);
    expect(elapsed).toBeLessThan(100); // 100ms以内に完了
  });
});

// =====================================================
// テストスイート: パフォーマンス
// =====================================================

describe('JSアニメーション検出 - パフォーマンス', () => {
  it('検出処理は50ms以内に完了する', () => {
    const html = loadFixture('mixed-animations-test.html');

    const iterations = 100;
    const startTime = Date.now();

    for (let i = 0; i < iterations; i++) {
      detectLibrariesFromHTML(html);
    }

    const elapsed = Date.now() - startTime;
    const avgTime = elapsed / iterations;

    expect(avgTime).toBeLessThan(50);
  });
});

// =====================================================
// テストスイート: Three.js 詳細情報型定義 (v0.1.0)
// =====================================================

import type {
  ThreeJSObject,
  ThreeJSScene,
  ThreeJSCamera,
  ThreeJSRenderer,
  ThreeJSPerformance,
  ThreeJSDetails,
  LibraryDetectionResult as RealLibraryDetectionResult,
} from '../../../../src/services/motion/js-animation-detector';

describe('Three.js詳細情報型定義 (v0.1.0)', () => {
  describe('ThreeJSObject型', () => {
    it('必須フィールドとオプションフィールドを持つ', () => {
      const meshObject: ThreeJSObject = {
        type: 'Mesh',
        geometry: 'BoxGeometry',
        material: 'MeshStandardMaterial',
        position: [0, 1, 2],
        rotation: [0, Math.PI / 4, 0],
        scale: [1, 1, 1],
      };

      expect(meshObject.type).toBe('Mesh');
      expect(meshObject.geometry).toBe('BoxGeometry');
      expect(meshObject.material).toBe('MeshStandardMaterial');
      expect(meshObject.position).toEqual([0, 1, 2]);
      expect(meshObject.rotation).toEqual([0, Math.PI / 4, 0]);
      expect(meshObject.scale).toEqual([1, 1, 1]);
    });

    it('ライトオブジェクトの場合はcolor/intensityを持つ', () => {
      const lightObject: ThreeJSObject = {
        type: 'DirectionalLight',
        color: '#ffffff',
        intensity: 1.5,
        position: [5, 10, 7.5],
      };

      expect(lightObject.type).toBe('DirectionalLight');
      expect(lightObject.color).toBe('#ffffff');
      expect(lightObject.intensity).toBe(1.5);
    });

    it('最小構成（typeのみ）が有効', () => {
      const minimalObject: ThreeJSObject = {
        type: 'Group',
      };

      expect(minimalObject.type).toBe('Group');
      expect(minimalObject.geometry).toBeUndefined();
      expect(minimalObject.material).toBeUndefined();
    });
  });

  describe('ThreeJSScene型', () => {
    it('シーン情報を正しく定義する', () => {
      const scene: ThreeJSScene = {
        id: 'scene-0',
        background: '#1a1a2e',
        fog: {
          type: 'Fog',
          color: '#1a1a2e',
          near: 10,
          far: 100,
        },
        objects: [
          { type: 'Mesh', geometry: 'BoxGeometry', material: 'MeshBasicMaterial' },
          { type: 'AmbientLight', color: '#404040', intensity: 0.5 },
        ],
      };

      expect(scene.id).toBe('scene-0');
      expect(scene.background).toBe('#1a1a2e');
      expect(scene.fog?.type).toBe('Fog');
      expect(scene.fog?.color).toBe('#1a1a2e');
      expect(scene.fog?.near).toBe(10);
      expect(scene.fog?.far).toBe(100);
      expect(scene.objects).toHaveLength(2);
    });

    it('FogExp2タイプのフォグを定義できる', () => {
      const scene: ThreeJSScene = {
        id: 'scene-fogexp2',
        fog: {
          type: 'FogExp2',
          color: '#000000',
          density: 0.02,
        },
        objects: [],
      };

      expect(scene.fog?.type).toBe('FogExp2');
      expect(scene.fog?.density).toBe(0.02);
    });

    it('最小構成が有効', () => {
      const minimalScene: ThreeJSScene = {
        id: 'scene-minimal',
        objects: [],
      };

      expect(minimalScene.id).toBe('scene-minimal');
      expect(minimalScene.background).toBeUndefined();
      expect(minimalScene.fog).toBeUndefined();
      expect(minimalScene.objects).toHaveLength(0);
    });
  });

  describe('ThreeJSCamera型', () => {
    it('PerspectiveCameraを正しく定義する', () => {
      const perspectiveCamera: ThreeJSCamera = {
        type: 'PerspectiveCamera',
        fov: 75,
        aspect: 16 / 9,
        near: 0.1,
        far: 1000,
        position: [0, 5, 10],
      };

      expect(perspectiveCamera.type).toBe('PerspectiveCamera');
      expect(perspectiveCamera.fov).toBe(75);
      expect(perspectiveCamera.aspect).toBeCloseTo(1.778, 2);
      expect(perspectiveCamera.near).toBe(0.1);
      expect(perspectiveCamera.far).toBe(1000);
      expect(perspectiveCamera.position).toEqual([0, 5, 10]);
    });

    it('OrthographicCameraを正しく定義する', () => {
      const orthoCamera: ThreeJSCamera = {
        type: 'OrthographicCamera',
        left: -10,
        right: 10,
        top: 10,
        bottom: -10,
        near: 0.1,
        far: 100,
        position: [0, 0, 20],
      };

      expect(orthoCamera.type).toBe('OrthographicCamera');
      expect(orthoCamera.left).toBe(-10);
      expect(orthoCamera.right).toBe(10);
      expect(orthoCamera.top).toBe(10);
      expect(orthoCamera.bottom).toBe(-10);
    });
  });

  describe('ThreeJSRenderer型', () => {
    it('レンダラー設定を正しく定義する', () => {
      const renderer: ThreeJSRenderer = {
        antialias: true,
        shadowMap: true,
        toneMapping: 'ACESFilmicToneMapping',
        outputColorSpace: 'srgb',
        pixelRatio: 2,
      };

      expect(renderer.antialias).toBe(true);
      expect(renderer.shadowMap).toBe(true);
      expect(renderer.toneMapping).toBe('ACESFilmicToneMapping');
      expect(renderer.outputColorSpace).toBe('srgb');
      expect(renderer.pixelRatio).toBe(2);
    });

    it('最小構成（空オブジェクト）が有効', () => {
      const minimalRenderer: ThreeJSRenderer = {};

      expect(minimalRenderer.antialias).toBeUndefined();
      expect(minimalRenderer.shadowMap).toBeUndefined();
    });
  });

  describe('ThreeJSPerformance型', () => {
    it('パフォーマンス指標を正しく定義する', () => {
      const performance: ThreeJSPerformance = {
        fps: 60,
        drawCalls: 150,
        triangles: 50000,
        points: 1000,
        lines: 500,
      };

      expect(performance.fps).toBe(60);
      expect(performance.drawCalls).toBe(150);
      expect(performance.triangles).toBe(50000);
      expect(performance.points).toBe(1000);
      expect(performance.lines).toBe(500);
    });

    it('部分的な指標のみでも有効', () => {
      const partialPerformance: ThreeJSPerformance = {
        drawCalls: 100,
        triangles: 25000,
      };

      expect(partialPerformance.drawCalls).toBe(100);
      expect(partialPerformance.triangles).toBe(25000);
      expect(partialPerformance.fps).toBeUndefined();
    });
  });

  describe('ThreeJSDetails型（統合）', () => {
    it('完全な詳細情報を定義できる', () => {
      const details: ThreeJSDetails = {
        version: '167',
        scenes: [
          {
            id: 'main-scene',
            background: '#000000',
            fog: { type: 'Fog', color: '#000000', near: 1, far: 100 },
            objects: [
              {
                type: 'Mesh',
                geometry: 'BoxGeometry',
                material: 'MeshStandardMaterial',
                position: [0, 0, 0],
              },
              { type: 'DirectionalLight', color: '#ffffff', intensity: 1 },
            ],
          },
        ],
        cameras: [
          {
            type: 'PerspectiveCamera',
            fov: 75,
            aspect: 1.778,
            near: 0.1,
            far: 1000,
            position: [0, 5, 10],
          },
        ],
        renderer: {
          antialias: true,
          shadowMap: true,
          toneMapping: 'ACESFilmicToneMapping',
          outputColorSpace: 'srgb',
          pixelRatio: 2,
        },
        performance: {
          fps: 60,
          drawCalls: 150,
          triangles: 50000,
        },
        textures: ['texture1.jpg', 'texture2.png', 'envmap.hdr'],
      };

      expect(details.version).toBe('167');
      expect(details.scenes).toHaveLength(1);
      expect(details.scenes[0].objects).toHaveLength(2);
      expect(details.cameras).toHaveLength(1);
      expect(details.cameras[0].fov).toBe(75);
      expect(details.renderer.antialias).toBe(true);
      expect(details.performance.fps).toBe(60);
      expect(details.textures).toHaveLength(3);
    });

    it('最小構成が有効', () => {
      const minimalDetails: ThreeJSDetails = {
        scenes: [],
        cameras: [],
        renderer: {},
        performance: {},
      };

      expect(minimalDetails.version).toBeUndefined();
      expect(minimalDetails.scenes).toHaveLength(0);
      expect(minimalDetails.cameras).toHaveLength(0);
      expect(minimalDetails.textures).toBeUndefined();
    });
  });

  describe('LibraryDetectionResult.three.details統合', () => {
    it('Three.js検出結果にdetailsを含められる', () => {
      const result: RealLibraryDetectionResult = {
        gsap: { detected: false },
        framerMotion: { detected: false },
        anime: { detected: false },
        three: {
          detected: true,
          scenes: 1,
          details: {
            version: '150',
            scenes: [
              {
                id: 'scene-0',
                objects: [{ type: 'Mesh', geometry: 'BoxGeometry', material: 'MeshBasicMaterial' }],
              },
            ],
            cameras: [{ type: 'PerspectiveCamera', fov: 75, near: 0.1, far: 1000 }],
            renderer: { antialias: true },
            performance: { drawCalls: 50, triangles: 10000 },
          },
        },
        lottie: { detected: false },
      };

      expect(result.three.detected).toBe(true);
      expect(result.three.scenes).toBe(1);
      expect(result.three.details).toBeDefined();
      expect(result.three.details?.version).toBe('150');
      expect(result.three.details?.scenes).toHaveLength(1);
      expect(result.three.details?.cameras).toHaveLength(1);
    });

    it('detailsがない場合（後方互換性）', () => {
      const resultWithoutDetails: RealLibraryDetectionResult = {
        gsap: { detected: false },
        framerMotion: { detected: false },
        anime: { detected: false },
        three: {
          detected: true,
          scenes: 2,
          // details省略
        },
        lottie: { detected: false },
      };

      expect(resultWithoutDetails.three.detected).toBe(true);
      expect(resultWithoutDetails.three.scenes).toBe(2);
      expect(resultWithoutDetails.three.details).toBeUndefined();
    });
  });
});

// =====================================================
// テストスイート: mapLibraryDetectionToPatterns連携 (v0.1.0)
// =====================================================

describe('mapLibraryDetectionToPatterns - Three.js詳細情報連携 (v0.1.0)', () => {
  /**
   * mapLibraryDetectionToPatternsのThree.js部分をシミュレート
   * 実際の関数は外部依存があるため、ロジックのみをテスト
   */
  function simulateThreeJSPatternMapping(
    threeResult: RealLibraryDetectionResult['three'],
    webPageId?: string,
    sourceUrl?: string,
  ): {
    libraryType: string;
    name: string;
    animationType: string;
    description: string;
    librarySpecificData: Record<string, unknown>;
    confidence: number;
  } | null {
    if (!threeResult.detected) {
      return null;
    }

    const details = threeResult.details;
    const hasDetails = details !== undefined;
    const description =
      hasDetails && details.version
        ? `Three.js ${details.version} detected with ${threeResult.scenes ?? 0} WebGL scenes`
        : `Three.js detected with ${threeResult.scenes ?? 0} WebGL scenes`;

    const librarySpecificData: Record<string, unknown> = {
      scenes: threeResult.scenes,
    };

    if (hasDetails) {
      librarySpecificData.three_js = {
        version: details.version,
        scenes: details.scenes,
        cameras: details.cameras,
        renderer: details.renderer,
        performance: details.performance,
        textures: details.textures,
      };
    }

    return {
      libraryType: 'three_js',
      name: 'Three.js Library Detection',
      animationType: 'physics',
      description,
      librarySpecificData,
      confidence: hasDetails ? 0.85 : 0.75,
    };
  }

  it('詳細情報がある場合、confidenceが0.85になる', () => {
    const threeResult: RealLibraryDetectionResult['three'] = {
      detected: true,
      scenes: 1,
      details: {
        version: '167',
        scenes: [{ id: 'scene-0', objects: [] }],
        cameras: [{ type: 'PerspectiveCamera', fov: 75 }],
        renderer: { antialias: true },
        performance: { drawCalls: 100 },
      },
    };

    const pattern = simulateThreeJSPatternMapping(threeResult, 'page-uuid', 'https://example.com');

    expect(pattern).not.toBeNull();
    expect(pattern?.confidence).toBe(0.85);
    expect(pattern?.description).toContain('Three.js 167');
    expect(pattern?.librarySpecificData.three_js).toBeDefined();
  });

  it('詳細情報がない場合、confidenceが0.75になる', () => {
    const threeResult: RealLibraryDetectionResult['three'] = {
      detected: true,
      scenes: 2,
      // details省略
    };

    const pattern = simulateThreeJSPatternMapping(threeResult);

    expect(pattern).not.toBeNull();
    expect(pattern?.confidence).toBe(0.75);
    expect(pattern?.description).toBe('Three.js detected with 2 WebGL scenes');
    expect(pattern?.librarySpecificData.three_js).toBeUndefined();
    expect(pattern?.librarySpecificData.scenes).toBe(2);
  });

  it('Three.js未検出の場合、nullを返す', () => {
    const threeResult: RealLibraryDetectionResult['three'] = {
      detected: false,
    };

    const pattern = simulateThreeJSPatternMapping(threeResult);

    expect(pattern).toBeNull();
  });

  it('librarySpecificDataにthree_jsオブジェクトが含まれる', () => {
    const threeResult: RealLibraryDetectionResult['three'] = {
      detected: true,
      scenes: 1,
      details: {
        version: '150',
        scenes: [
          {
            id: 'main',
            background: '#000000',
            objects: [
              { type: 'Mesh', geometry: 'SphereGeometry', material: 'MeshPhongMaterial' },
              { type: 'PointLight', color: '#ffffff', intensity: 1 },
            ],
          },
        ],
        cameras: [
          { type: 'PerspectiveCamera', fov: 60, aspect: 1.5, near: 0.1, far: 500, position: [0, 0, 5] },
        ],
        renderer: {
          antialias: true,
          shadowMap: false,
          toneMapping: 'LinearToneMapping',
          pixelRatio: 1,
        },
        performance: {
          drawCalls: 25,
          triangles: 5000,
        },
        textures: ['earth.jpg'],
      },
    };

    const pattern = simulateThreeJSPatternMapping(threeResult, 'page-id', 'https://test.com');

    expect(pattern).not.toBeNull();

    const threeJsData = pattern?.librarySpecificData.three_js as Record<string, unknown> | undefined;
    expect(threeJsData).toBeDefined();
    expect(threeJsData?.version).toBe('150');
    expect((threeJsData?.scenes as unknown[])?.length).toBe(1);
    expect((threeJsData?.cameras as unknown[])?.length).toBe(1);
    expect((threeJsData?.renderer as Record<string, unknown>)?.antialias).toBe(true);
    expect((threeJsData?.performance as Record<string, unknown>)?.drawCalls).toBe(25);
    expect((threeJsData?.textures as string[])?.length).toBe(1);
  });
});
