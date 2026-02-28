// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGL/Three.js サイト事前推定機能 テスト（TDD Red Phase）
 *
 * page.analyze実行前にURLからWebGL/Three.jsサイトかどうかを事前推定し、
 * タイムアウト設定を最適化するための機能。
 *
 * 目的:
 * - 既知のWebGL重いサイト（resn.co.nz, activetheory.net等）を事前検出
 * - URLパターン（/webgl/, /3d/, /canvas/等）からWebGL使用を推定
 * - 推定結果に基づきタイムアウト乗数を算出（1.0-3.0倍）
 *
 * @module tests/tools/page/handlers/webgl-pre-detector.test
 */

import { describe, it, expect } from 'vitest';

import {
  preDetectWebGL,
  detectSiteTier,
  type PreDetectionResult,
  // 内部で使用される定数もエクスポートされることを期待
  KNOWN_WEBGL_DOMAINS,
  WEBGL_URL_PATTERNS,
  KNOWN_ULTRA_HEAVY_DOMAINS,
  KNOWN_HEAVY_DOMAINS,
} from '../../../../src/tools/page/handlers/webgl-pre-detector';

// ============================================================================
// テスト用の定数
// ============================================================================

/**
 * 既知のWebGL/Three.js重量サイトドメイン
 * これらのドメインは確実にWebGLを使用していると判断される
 */
const EXPECTED_KNOWN_DOMAINS = [
  'resn.co.nz',
  'activetheory.net',
  'threejs.org',
  'awwwards.com',
  'fwa.com',
  'cssdesignawards.com',
  'bruno-simon.com',
  'lusion.co',
  'iamlegend.co.nz',
  'watsco.com',
];

/**
 * WebGL/3D関連のURLパターン
 */
const EXPECTED_URL_PATTERNS = [
  '/webgl/',
  '/3d/',
  '/canvas/',
  '/three/',
  '/experience/',
  '/interactive/',
  '/immersive/',
];

/**
 * 通常のサイト（WebGLを使用していないと推定される）
 * Note: github.comはWebGLドメインリストに含まれているため除外
 */
const NORMAL_SITES = [
  'https://www.google.com',
  'https://www.wikipedia.org',
  'https://docs.google.com/document/d/1234',
  'https://www.amazon.co.jp',
  'https://stackoverflow.com',
];

// ============================================================================
// PreDetectionResult インターフェース テスト
// ============================================================================

describe('PreDetectionResult インターフェース', () => {
  it('必須フィールドが定義されていること', () => {
    // 型チェック: PreDetectionResultが正しい構造を持つことを確認
    const mockResult: PreDetectionResult = {
      isLikelyWebGL: true,
      confidence: 0.9,
      timeoutMultiplier: 2.5,
    };

    expect(mockResult.isLikelyWebGL).toBe(true);
    expect(mockResult.confidence).toBe(0.9);
    expect(mockResult.timeoutMultiplier).toBe(2.5);
  });

  it('オプショナルフィールド（matchedDomain）が定義可能であること', () => {
    const mockResult: PreDetectionResult = {
      isLikelyWebGL: true,
      confidence: 1.0,
      timeoutMultiplier: 3.0,
      matchedDomain: 'resn.co.nz',
    };

    expect(mockResult.matchedDomain).toBe('resn.co.nz');
  });

  it('オプショナルフィールド（matchedPattern）が定義可能であること', () => {
    const mockResult: PreDetectionResult = {
      isLikelyWebGL: true,
      confidence: 0.7,
      timeoutMultiplier: 2.0,
      matchedPattern: '/webgl/',
    };

    expect(mockResult.matchedPattern).toBe('/webgl/');
  });
});

// ============================================================================
// 既知WebGLドメイン検出 テスト
// ============================================================================

describe('既知WebGLドメイン検出', () => {
  describe('resn.co.nz（有名WebGLスタジオ）', () => {
    it('resn.co.nzドメインを検出する', () => {
      const result = preDetectWebGL('https://resn.co.nz');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe('resn.co.nz');
    });

    it('サブドメイン付きでも検出する', () => {
      const result = preDetectWebGL('https://www.resn.co.nz');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe('resn.co.nz');
    });

    it('パス付きでも検出する', () => {
      const result = preDetectWebGL('https://resn.co.nz/work/projects');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe('resn.co.nz');
    });

    it('信頼度が1.0（最高）であること', () => {
      const result = preDetectWebGL('https://resn.co.nz');

      expect(result.confidence).toBe(1.0);
    });

    it('タイムアウト乗数が3.0（最大）であること', () => {
      const result = preDetectWebGL('https://resn.co.nz');

      expect(result.timeoutMultiplier).toBe(3.0);
    });
  });

  describe('activetheory.net（有名WebGLスタジオ）', () => {
    it('activetheory.netドメインを検出する', () => {
      const result = preDetectWebGL('https://activetheory.net');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe('activetheory.net');
      expect(result.confidence).toBe(1.0);
      expect(result.timeoutMultiplier).toBe(3.0);
    });
  });

  describe('threejs.org（Three.js公式サイト）', () => {
    it('threejs.orgドメインを検出する', () => {
      const result = preDetectWebGL('https://threejs.org');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe('threejs.org');
      expect(result.confidence).toBe(1.0);
      expect(result.timeoutMultiplier).toBe(3.0);
    });

    it('サンプルページも検出する', () => {
      const result = preDetectWebGL('https://threejs.org/examples/#webgl_animation_skinning_blending');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe('threejs.org');
    });
  });

  describe('アワードサイト（awwwards.com, fwa.com, cssdesignawards.com）', () => {
    it.each([
      ['https://awwwards.com/websites/three-js/', 'awwwards.com'],
      ['https://www.awwwards.com/websites/webgl/', 'awwwards.com'],
      ['https://thefwa.com/cases/example', 'thefwa.com'],
      ['https://www.cssdesignawards.com/sites/example', 'cssdesignawards.com'],
    ])('%s を検出する', (url, expectedDomain) => {
      const result = preDetectWebGL(url);

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe(expectedDomain);
    });
  });

  describe('その他の既知WebGLサイト', () => {
    it.each([
      ['https://bruno-simon.com', 'bruno-simon.com'],
      ['https://lusion.co', 'lusion.co'],
      ['https://iamlegend.co.nz', 'iamlegend.co.nz'],
    ])('%s を検出する', (url, expectedDomain) => {
      const result = preDetectWebGL(url);

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe(expectedDomain);
      expect(result.confidence).toBe(1.0);
      expect(result.timeoutMultiplier).toBe(3.0);
    });
  });

  describe('KNOWN_WEBGL_DOMAINS 定数', () => {
    it('エクスポートされていること', () => {
      expect(KNOWN_WEBGL_DOMAINS).toBeDefined();
      expect(Array.isArray(KNOWN_WEBGL_DOMAINS)).toBe(true);
    });

    it('最低10個のドメインが登録されていること', () => {
      expect(KNOWN_WEBGL_DOMAINS.length).toBeGreaterThanOrEqual(10);
    });

    it('主要なドメインが含まれていること', () => {
      const expectedDomains = ['resn.co.nz', 'activetheory.net', 'threejs.org'];

      expectedDomains.forEach((domain) => {
        expect(KNOWN_WEBGL_DOMAINS).toContain(domain);
      });
    });
  });
});

// ============================================================================
// URLパターンマッチ テスト
// ============================================================================

describe('URLパターンマッチ', () => {
  describe('/webgl/ パターン', () => {
    it('/webgl/ を含むURLを検出する', () => {
      const result = preDetectWebGL('https://example.com/projects/webgl/demo');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedPattern).toBe('/webgl/');
    });

    it('タイムアウト乗数が2.0であること（パターンマッチ）', () => {
      const result = preDetectWebGL('https://example.com/webgl/');

      expect(result.timeoutMultiplier).toBe(2.0);
    });

    it('信頼度が0.7-0.8の範囲であること', () => {
      const result = preDetectWebGL('https://example.com/webgl/demo');

      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      expect(result.confidence).toBeLessThanOrEqual(0.8);
    });
  });

  describe('/3d/ パターン', () => {
    it('/3d/ を含むURLを検出する', () => {
      const result = preDetectWebGL('https://example.com/gallery/3d/viewer');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedPattern).toBe('/3d/');
    });
  });

  describe('/canvas/ パターン', () => {
    it('/canvas/ を含むURLを検出する', () => {
      const result = preDetectWebGL('https://example.com/art/canvas/interactive');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedPattern).toBe('/canvas/');
    });
  });

  describe('/three/ パターン', () => {
    it('/three/ を含むURLを検出する', () => {
      const result = preDetectWebGL('https://example.com/demos/three/scene');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedPattern).toBe('/three/');
    });
  });

  describe('/experience/ パターン', () => {
    it('/experience/ を含むURLを検出する', () => {
      const result = preDetectWebGL('https://example.com/brand/experience/');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedPattern).toBe('/experience/');
    });
  });

  describe('/interactive/ パターン', () => {
    it('/interactive/ を含むURLを検出する', () => {
      const result = preDetectWebGL('https://example.com/story/interactive/chapter1');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedPattern).toBe('/interactive/');
    });
  });

  describe('/immersive/ パターン', () => {
    it('/immersive/ を含むURLを検出する', () => {
      const result = preDetectWebGL('https://example.com/tour/immersive/');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedPattern).toBe('/immersive/');
    });
  });

  describe('大文字小文字の区別', () => {
    it('大文字のパターンも検出する（case-insensitive）', () => {
      const result = preDetectWebGL('https://example.com/WEBGL/demo');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedPattern).toBe('/webgl/');
    });

    it('混合ケースも検出する', () => {
      const result = preDetectWebGL('https://example.com/WebGL/Demo');

      expect(result.isLikelyWebGL).toBe(true);
    });
  });

  describe('WEBGL_URL_PATTERNS 定数', () => {
    it('エクスポートされていること', () => {
      expect(WEBGL_URL_PATTERNS).toBeDefined();
      expect(Array.isArray(WEBGL_URL_PATTERNS)).toBe(true);
    });

    it('最低5個のパターンが登録されていること', () => {
      expect(WEBGL_URL_PATTERNS.length).toBeGreaterThanOrEqual(5);
    });

    it('主要なパターンが含まれていること', () => {
      const expectedPatterns = ['/webgl/', '/3d/', '/canvas/'];

      expectedPatterns.forEach((pattern) => {
        expect(WEBGL_URL_PATTERNS).toContain(pattern);
      });
    });
  });
});

// ============================================================================
// 通常サイト（非WebGL）検出 テスト
// ============================================================================

describe('通常サイト（非WebGL）検出', () => {
  describe('一般的なWebサイト', () => {
    it.each(NORMAL_SITES)('%s はWebGLサイトとして検出されない', (url) => {
      const result = preDetectWebGL(url);

      expect(result.isLikelyWebGL).toBe(false);
      expect(result.matchedDomain).toBeUndefined();
      expect(result.matchedPattern).toBeUndefined();
    });
  });

  describe('通常サイトのタイムアウト乗数', () => {
    it.each(NORMAL_SITES)('%s のタイムアウト乗数は1.0', (url) => {
      const result = preDetectWebGL(url);

      expect(result.timeoutMultiplier).toBe(1.0);
    });
  });

  describe('通常サイトの信頼度', () => {
    it.each(NORMAL_SITES)('%s の信頼度は0', (url) => {
      const result = preDetectWebGL(url);

      expect(result.confidence).toBe(0);
    });
  });

  describe('紛らわしいURL（誤検出を避ける）', () => {
    it('webglという文字列を含むが、パターンに一致しないURL', () => {
      // /webgl/ ではなく webgl という文字列のみ
      const result = preDetectWebGL('https://example.com/learn-webgl-basics');

      expect(result.isLikelyWebGL).toBe(false);
    });

    it('3dという文字列を含むが、パターンに一致しないURL', () => {
      // /3d/ ではなく 3d という文字列のみ
      const result = preDetectWebGL('https://example.com/product-3d-preview.html');

      expect(result.isLikelyWebGL).toBe(false);
    });

    it('クエリパラメータにパターン文字列を含むURL', () => {
      const result = preDetectWebGL('https://example.com/page?mode=webgl');

      // クエリパラメータは検出対象外
      expect(result.isLikelyWebGL).toBe(false);
    });
  });
});

// ============================================================================
// タイムアウト乗数計算 テスト
// ============================================================================

describe('タイムアウト乗数計算', () => {
  describe('乗数の範囲', () => {
    it('既知ドメインの乗数は3.0', () => {
      const result = preDetectWebGL('https://resn.co.nz');

      expect(result.timeoutMultiplier).toBe(3.0);
    });

    it('URLパターンマッチの乗数は2.0', () => {
      const result = preDetectWebGL('https://example.com/webgl/demo');

      expect(result.timeoutMultiplier).toBe(2.0);
    });

    it('通常サイトの乗数は1.0', () => {
      const result = preDetectWebGL('https://google.com');

      expect(result.timeoutMultiplier).toBe(1.0);
    });
  });

  describe('乗数の適用優先順位', () => {
    it('既知ドメイン + パターンマッチ: ドメインが優先される', () => {
      // threejs.org はドメインでマッチ、かつ /webgl/ パターンもマッチする可能性
      const result = preDetectWebGL('https://threejs.org/examples/webgl_animation');

      // ドメインマッチが優先されるため乗数は3.0
      expect(result.timeoutMultiplier).toBe(3.0);
      expect(result.matchedDomain).toBe('threejs.org');
    });
  });

  describe('乗数の境界値', () => {
    it('乗数は1.0未満にならない', () => {
      const result = preDetectWebGL('https://simple-static-site.com');

      expect(result.timeoutMultiplier).toBeGreaterThanOrEqual(1.0);
    });

    it('乗数は3.0を超えない', () => {
      const result = preDetectWebGL('https://resn.co.nz/webgl/3d/canvas/experience');

      expect(result.timeoutMultiplier).toBeLessThanOrEqual(3.0);
    });
  });
});

// ============================================================================
// 信頼度スコア計算 テスト
// ============================================================================

describe('信頼度スコア計算', () => {
  describe('スコアの範囲', () => {
    it('既知ドメインの信頼度は1.0', () => {
      const result = preDetectWebGL('https://activetheory.net');

      expect(result.confidence).toBe(1.0);
    });

    it('URLパターンマッチの信頼度は0.7-0.8', () => {
      const result = preDetectWebGL('https://example.com/interactive/demo');

      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      expect(result.confidence).toBeLessThanOrEqual(0.8);
    });

    it('通常サイトの信頼度は0', () => {
      const result = preDetectWebGL('https://wikipedia.org');

      expect(result.confidence).toBe(0);
    });
  });

  describe('スコアの境界値', () => {
    it('信頼度は0未満にならない', () => {
      const result = preDetectWebGL('https://example.com');

      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });

    it('信頼度は1.0を超えない', () => {
      const result = preDetectWebGL('https://resn.co.nz');

      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });
  });
});

// ============================================================================
// エッジケース テスト
// ============================================================================

describe('エッジケース', () => {
  describe('不正なURL', () => {
    it('空文字列の場合はisLikelyWebGL=false', () => {
      const result = preDetectWebGL('');

      expect(result.isLikelyWebGL).toBe(false);
      expect(result.timeoutMultiplier).toBe(1.0);
    });

    it('プロトコルなしのURLでも処理できる', () => {
      const result = preDetectWebGL('resn.co.nz/work');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe('resn.co.nz');
    });

    it('不正なURL形式でもエラーをスローしない', () => {
      expect(() => preDetectWebGL('not-a-valid-url')).not.toThrow();
    });
  });

  describe('特殊なURL', () => {
    it('ポート番号付きURL', () => {
      const result = preDetectWebGL('https://localhost:3000/webgl/demo');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedPattern).toBe('/webgl/');
    });

    it('IPアドレスURL', () => {
      const result = preDetectWebGL('http://192.168.1.1/3d/viewer');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedPattern).toBe('/3d/');
    });

    it('フラグメント付きURL', () => {
      const result = preDetectWebGL('https://threejs.org/examples/#webgl_animation');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe('threejs.org');
    });

    it('クエリパラメータ付きURL', () => {
      const result = preDetectWebGL('https://resn.co.nz/work?category=all');

      expect(result.isLikelyWebGL).toBe(true);
      expect(result.matchedDomain).toBe('resn.co.nz');
    });
  });

  describe('Unicode/国際化ドメイン', () => {
    it('日本語ドメインでも処理できる', () => {
      // Punycodeエンコードされたドメイン
      expect(() => preDetectWebGL('https://xn--n8j6ds53lwwkrqhv28a.jp')).not.toThrow();
    });
  });
});

// ============================================================================
// パフォーマンス テスト
// ============================================================================

describe('パフォーマンス', () => {
  it('1000回の呼び出しが100ms以内で完了すること', () => {
    const urls = [
      'https://resn.co.nz',
      'https://google.com',
      'https://example.com/webgl/demo',
      'https://threejs.org/examples',
      'https://github.com',
    ];

    const startTime = performance.now();

    for (let i = 0; i < 1000; i++) {
      const url = urls[i % urls.length];
      preDetectWebGL(url);
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    expect(duration).toBeLessThan(100); // 100ms以内
  });
});

// ============================================================================
// detectSiteTier テスト
// ============================================================================

describe('detectSiteTier', () => {
  describe('ultra-heavy サイト', () => {
    it.each([
      'https://resn.co.nz',
      'https://www.resn.co.nz',
      'https://activetheory.net',
      'https://activetheory.com',
      'https://lusion.co',
      'https://iamlegend.co.nz',
    ])('%s は ultra-heavy を返す', (url) => {
      const tier = detectSiteTier(url);
      expect(tier).toBe('ultra-heavy');
    });
  });

  describe('heavy サイト', () => {
    it.each([
      'https://bruno-simon.com',
      'https://dogstudio.co',
      'https://fantasy.co',
      'https://cuberto.com',
      'https://unseen.co',
    ])('%s は heavy を返す', (url) => {
      const tier = detectSiteTier(url);
      expect(tier).toBe('heavy');
    });

    it('既知ドメイン（confidence=1.0）で ultra-heavy/heavy リストにないものは heavy を返す', () => {
      // threejs.org は KNOWN_WEBGL_DOMAINS にあるが、KNOWN_ULTRA_HEAVY_DOMAINS と KNOWN_HEAVY_DOMAINS にはない
      const tier = detectSiteTier('https://threejs.org');
      expect(tier).toBe('heavy');
    });
  });

  describe('webgl サイト', () => {
    it.each([
      'https://example.com/webgl/demo',
      'https://example.com/3d/viewer',
      'https://example.com/experience/',
      'https://example.com/interactive/demo',
    ])('%s は webgl を返す', (url) => {
      const tier = detectSiteTier(url);
      expect(tier).toBe('webgl');
    });
  });

  describe('normal サイト', () => {
    it.each([
      'https://google.com',
      'https://wikipedia.org',
      'https://example.com',
      'https://stackoverflow.com',
    ])('%s は normal を返す', (url) => {
      const tier = detectSiteTier(url);
      expect(tier).toBe('normal');
    });
  });

  describe('preDetection パラメータ', () => {
    it('preDetection パラメータを受け取る場合、内部計算をスキップする', () => {
      const mockPreDetection: PreDetectionResult = {
        isLikelyWebGL: false,
        confidence: 0,
        timeoutMultiplier: 1.0,
      };

      // resn.co.nz は通常 ultra-heavy だが、preDetection で非WebGL扱いにする
      const tier = detectSiteTier('https://resn.co.nz', mockPreDetection);
      expect(tier).toBe('normal');
    });
  });

  describe('KNOWN_ULTRA_HEAVY_DOMAINS 定数', () => {
    it('エクスポートされていること', () => {
      expect(KNOWN_ULTRA_HEAVY_DOMAINS).toBeDefined();
      expect(Array.isArray(KNOWN_ULTRA_HEAVY_DOMAINS)).toBe(true);
    });

    it('resn.co.nz が含まれていること', () => {
      expect(KNOWN_ULTRA_HEAVY_DOMAINS).toContain('resn.co.nz');
    });
  });

  describe('KNOWN_HEAVY_DOMAINS 定数', () => {
    it('エクスポートされていること', () => {
      expect(KNOWN_HEAVY_DOMAINS).toBeDefined();
      expect(Array.isArray(KNOWN_HEAVY_DOMAINS)).toBe(true);
    });

    it('bruno-simon.com が含まれていること', () => {
      expect(KNOWN_HEAVY_DOMAINS).toContain('bruno-simon.com');
    });
  });
});
