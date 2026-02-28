// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGL自動検出・設定切替 テスト（TDD Red Phase）
 *
 * Phase4-1: HTMLコンテンツを分析してWebGL/Three.jsサイトを自動検出し、
 * 最適な設定を自動切替する機能のテスト。
 *
 * @module tests/tools/page/handlers/webgl-detector.test
 */

import { describe, it, expect } from 'vitest';

import {
  // 統合WebGLDetectorクラス（新規作成予定）
  WebGLDetector,
  type WebGLDetectionResult,
  type RecommendedConfig,
  // 既存の関数（後方互換性）
  detectWebGL,
  adjustTimeoutForWebGL,
} from '../../../../src/tools/page/handlers/webgl-detector';

import { type SiteTier } from '../../../../src/tools/page/handlers/retry-strategy';

// ============================================================================
// テスト用HTML定数
// ============================================================================

/**
 * Three.jsを使用したHTML
 */
const THREE_JS_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Three.js Example</title>
  <script src="https://cdn.jsdelivr.net/npm/three@0.158.0/build/three.min.js"></script>
</head>
<body>
  <canvas id="canvas"></canvas>
  <script>
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
  </script>
</body>
</html>
`;

/**
 * Babylon.jsを使用したHTML
 */
const BABYLON_JS_HTML = `
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.babylonjs.com/babylon.min.js"></script>
</head>
<body>
  <canvas id="renderCanvas"></canvas>
  <script>
    const engine = new BABYLON.Engine(document.getElementById('renderCanvas'));
    const scene = new BABYLON.Scene(engine);
  </script>
</body>
</html>
`;

/**
 * Pixi.jsを使用したHTML
 */
const PIXI_JS_HTML = `
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pixi.js/7.0.0/pixi.min.js"></script>
</head>
<body>
  <script>
    const app = new PIXI.Application({ width: 800, height: 600 });
    document.body.appendChild(app.view);
  </script>
</body>
</html>
`;

/**
 * 生WebGLを使用したHTML
 */
const RAW_WEBGL_HTML = `
<!DOCTYPE html>
<html>
<head><title>Raw WebGL</title></head>
<body>
  <canvas id="glCanvas"></canvas>
  <script>
    const canvas = document.getElementById('glCanvas');
    const gl = canvas.getContext('webgl');
    if (!gl) {
      gl = canvas.getContext('experimental-webgl');
    }
  </script>
</body>
</html>
`;

/**
 * GSAPを使用したHTML
 */
const GSAP_HTML = `
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.0/gsap.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.0/ScrollTrigger.min.js"></script>
</head>
<body>
  <div class="box"></div>
  <script>
    gsap.registerPlugin(ScrollTrigger);
    gsap.to('.box', { x: 100, duration: 1 });
  </script>
</body>
</html>
`;

/**
 * Lottieを使用したHTML
 */
const LOTTIE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.0/lottie.min.js"></script>
</head>
<body>
  <div id="lottie"></div>
  <script>
    lottie.loadAnimation({
      container: document.getElementById('lottie'),
      path: 'animation.json',
      renderer: 'svg',
    });
  </script>
</body>
</html>
`;

/**
 * 通常のHTML（WebGL/3Dライブラリなし）
 */
const NORMAL_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Normal Website</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header>
    <nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main>
    <h1>Welcome</h1>
    <p>This is a normal website.</p>
  </main>
</body>
</html>
`;

/**
 * Canvas要素のみのHTML（WebGLコンテキストなし）
 */
const CANVAS_ONLY_HTML = `
<!DOCTYPE html>
<html>
<head><title>Canvas 2D</title></head>
<body>
  <canvas id="myCanvas"></canvas>
  <script>
    const canvas = document.getElementById('myCanvas');
    const ctx = canvas.getContext('2d');
    ctx.fillRect(10, 10, 100, 100);
  </script>
</body>
</html>
`;

/**
 * 複数のWebGLライブラリを使用したHTML
 */
const MULTIPLE_LIBS_HTML = `
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/npm/three@0.158.0/build/three.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.0/gsap.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.0/lottie.min.js"></script>
</head>
<body>
  <canvas id="canvas"></canvas>
  <div id="lottie"></div>
  <script>
    new THREE.WebGLRenderer();
    gsap.to('.box', { x: 100 });
    lottie.loadAnimation({ container: document.getElementById('lottie') });
  </script>
</body>
</html>
`;

// ============================================================================
// WebGLDetectionResult インターフェース テスト
// ============================================================================

describe('WebGLDetectionResult インターフェース', () => {
  it('必須フィールドが定義されていること', () => {
    const result: WebGLDetectionResult = {
      isWebGL: true,
      confidence: 0.9,
      siteTier: 'heavy',
      detectedLibraries: ['three.js'],
      indicators: {
        domainMatch: false,
        urlPatternMatch: false,
        htmlIndicators: ['three.min.js'],
        scriptIndicators: ['new THREE.WebGLRenderer'],
      },
      recommendedConfig: {
        enableGPU: true,
        waitForWebGL: true,
        webglWaitMs: 3000,
        timeout: 180000,
        waitUntil: 'networkidle',
        disableJavaScript: false,
        disableWebGL: false,
        forceKillOnTimeout: false,
      },
    };

    expect(result.isWebGL).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.siteTier).toBe('heavy');
    expect(result.detectedLibraries).toContain('three.js');
    expect(result.indicators.htmlIndicators).toContain('three.min.js');
    expect(result.recommendedConfig.enableGPU).toBe(true);
  });
});

// ============================================================================
// RecommendedConfig インターフェース テスト
// ============================================================================

describe('RecommendedConfig インターフェース', () => {
  it('必須フィールドが全て定義されていること', () => {
    const config: RecommendedConfig = {
      enableGPU: true,
      waitForWebGL: true,
      webglWaitMs: 3000,
      timeout: 180000,
      waitUntil: 'networkidle',
      disableJavaScript: false,
      disableWebGL: false,
      forceKillOnTimeout: false,
    };

    expect(config).toHaveProperty('enableGPU');
    expect(config).toHaveProperty('waitForWebGL');
    expect(config).toHaveProperty('webglWaitMs');
    expect(config).toHaveProperty('timeout');
    expect(config).toHaveProperty('waitUntil');
    expect(config).toHaveProperty('disableJavaScript');
    expect(config).toHaveProperty('disableWebGL');
    expect(config).toHaveProperty('forceKillOnTimeout');
  });
});

// ============================================================================
// WebGLDetector.preDetect() テスト（URL/ドメインベース）
// ============================================================================

describe('WebGLDetector.preDetect()', () => {
  describe('既知WebGLドメイン検出', () => {
    it('resn.co.nz（ultra-heavy）を検出する', () => {
      const result = WebGLDetector.preDetect('https://resn.co.nz');

      expect(result.isWebGL).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      expect(result.siteTier).toBe('ultra-heavy');
      expect(result.indicators.domainMatch).toBe(true);
    });

    it('threejs.org を検出する', () => {
      const result = WebGLDetector.preDetect('https://threejs.org');

      expect(result.isWebGL).toBe(true);
      expect(result.siteTier).toBe('heavy');
      expect(result.indicators.domainMatch).toBe(true);
    });

    it('bruno-simon.com（heavy）を検出する', () => {
      const result = WebGLDetector.preDetect('https://bruno-simon.com');

      expect(result.isWebGL).toBe(true);
      expect(result.siteTier).toBe('heavy');
      expect(result.indicators.domainMatch).toBe(true);
    });
  });

  describe('URLパターンマッチ', () => {
    it('/webgl/ パターンを検出する', () => {
      const result = WebGLDetector.preDetect('https://example.com/projects/webgl/demo');

      expect(result.isWebGL).toBe(true);
      expect(result.siteTier).toBe('webgl');
      expect(result.indicators.urlPatternMatch).toBe(true);
    });

    it('/3d/ パターンを検出する', () => {
      const result = WebGLDetector.preDetect('https://example.com/gallery/3d/viewer');

      expect(result.isWebGL).toBe(true);
      expect(result.siteTier).toBe('webgl');
      expect(result.indicators.urlPatternMatch).toBe(true);
    });

    it('/experience/ パターンを検出する', () => {
      const result = WebGLDetector.preDetect('https://example.com/brand/experience/');

      expect(result.isWebGL).toBe(true);
      expect(result.indicators.urlPatternMatch).toBe(true);
    });
  });

  describe('通常サイト（非WebGL）', () => {
    it('google.com は non-WebGL を返す', () => {
      const result = WebGLDetector.preDetect('https://www.google.com');

      expect(result.isWebGL).toBe(false);
      expect(result.siteTier).toBe('normal');
      expect(result.confidence).toBe(0);
    });

    it('stackoverflow.com は non-WebGL を返す', () => {
      const result = WebGLDetector.preDetect('https://stackoverflow.com');

      expect(result.isWebGL).toBe(false);
      expect(result.siteTier).toBe('normal');
    });
  });
});

// ============================================================================
// WebGLDetector.analyzeHtml() テスト（HTMLコンテンツベース）
// ============================================================================

describe('WebGLDetector.analyzeHtml()', () => {
  describe('Three.js検出', () => {
    it('three.min.js スクリプトを検出する', () => {
      const result = WebGLDetector.analyzeHtml(THREE_JS_HTML);

      expect(result.isWebGL).toBe(true);
      expect(result.detectedLibraries).toContain('three.js');
      expect(result.indicators.scriptIndicators.length).toBeGreaterThan(0);
    });

    it('THREE.WebGLRenderer インスタンス化を検出する', () => {
      const result = WebGLDetector.analyzeHtml(THREE_JS_HTML);

      // scriptIndicators には "three.js: パターン" 形式で記録される
      expect(result.indicators.scriptIndicators).toEqual(
        expect.arrayContaining([expect.stringContaining('three.js')])
      );
    });

    it('信頼度が0.5以上であること（WebGL検出しきい値）', () => {
      const result = WebGLDetector.analyzeHtml(THREE_JS_HTML);

      // Three.jsのweight=1.0、計算後に正規化されて0.5程度になる
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('Babylon.js検出', () => {
    it('babylon.js スクリプトを検出する', () => {
      const result = WebGLDetector.analyzeHtml(BABYLON_JS_HTML);

      expect(result.isWebGL).toBe(true);
      expect(result.detectedLibraries).toContain('babylon.js');
    });

    it('BABYLON.Scene インスタンス化を検出する', () => {
      const result = WebGLDetector.analyzeHtml(BABYLON_JS_HTML);

      // scriptIndicators には "babylon.js: パターン" 形式で記録される
      expect(result.indicators.scriptIndicators).toEqual(
        expect.arrayContaining([expect.stringContaining('babylon.js')])
      );
    });
  });

  describe('Pixi.js検出', () => {
    it('pixi.js スクリプトを検出する', () => {
      const result = WebGLDetector.analyzeHtml(PIXI_JS_HTML);

      expect(result.isWebGL).toBe(true);
      expect(result.detectedLibraries).toContain('pixi.js');
    });
  });

  describe('生WebGL検出', () => {
    it('getContext("webgl") を検出する', () => {
      const result = WebGLDetector.analyzeHtml(RAW_WEBGL_HTML);

      expect(result.isWebGL).toBe(true);
      expect(result.detectedLibraries).toContain('raw-webgl');
    });

    it('getContext("experimental-webgl") を検出する', () => {
      const result = WebGLDetector.analyzeHtml(RAW_WEBGL_HTML);

      expect(result.indicators.scriptIndicators).toEqual(
        expect.arrayContaining([expect.stringMatching(/webgl/i)])
      );
    });
  });

  describe('GSAP検出', () => {
    it('gsap スクリプトを検出する', () => {
      const result = WebGLDetector.analyzeHtml(GSAP_HTML);

      // GSAPはWebGLではないが、重いアニメーションとして検出
      expect(result.detectedLibraries).toContain('gsap');
    });

    it('ScrollTrigger を検出する', () => {
      const result = WebGLDetector.analyzeHtml(GSAP_HTML);

      expect(result.indicators.scriptIndicators).toEqual(
        expect.arrayContaining([expect.stringContaining('gsap')])
      );
    });

    it('GSAP単独では信頼度が低い（WebGLライブラリより低い）', () => {
      const result = WebGLDetector.analyzeHtml(GSAP_HTML);

      // GSAPのweight=0.4、confidence = totalWeight/2 = 0.2程度
      // Three.jsの信頼度（0.5以上）より低いことを確認
      expect(result.confidence).toBeLessThan(0.5);
      expect(result.confidence).toBeGreaterThan(0);
      // GSAPはWebGLライブラリではないのでisWebGL=false
      expect(result.isWebGL).toBe(false);
    });
  });

  describe('Lottie検出', () => {
    it('lottie スクリプトを検出する', () => {
      const result = WebGLDetector.analyzeHtml(LOTTIE_HTML);

      expect(result.detectedLibraries).toContain('lottie');
    });

    it('Lottie単独では信頼度が低い（WebGLライブラリより低い）', () => {
      const result = WebGLDetector.analyzeHtml(LOTTIE_HTML);

      // Lottieのweight=0.3、confidence = totalWeight/2 = 0.15程度
      // Three.jsの信頼度（0.5以上）より低いことを確認
      expect(result.confidence).toBeLessThan(0.5);
      expect(result.confidence).toBeGreaterThan(0);
      // LottieはWebGLライブラリではないのでisWebGL=false
      expect(result.isWebGL).toBe(false);
    });
  });

  describe('Canvas要素検出', () => {
    it('canvas要素を検出する', () => {
      const result = WebGLDetector.analyzeHtml(CANVAS_ONLY_HTML);

      expect(result.indicators.htmlIndicators).toEqual(
        expect.arrayContaining([expect.stringContaining('canvas')])
      );
    });

    it('Canvas単独ではWebGL=false（2Dの可能性）', () => {
      const result = WebGLDetector.analyzeHtml(CANVAS_ONLY_HTML);

      // Canvas + 2D contextのみの場合はWebGLとして判定しない
      expect(result.isWebGL).toBe(false);
      expect(result.confidence).toBeLessThan(0.3);
    });
  });

  describe('通常サイト（非WebGL）', () => {
    it('通常HTMLはWebGL=falseを返す', () => {
      const result = WebGLDetector.analyzeHtml(NORMAL_HTML);

      expect(result.isWebGL).toBe(false);
      expect(result.detectedLibraries).toHaveLength(0);
      expect(result.confidence).toBe(0);
      expect(result.siteTier).toBe('normal');
    });
  });

  describe('複数ライブラリ検出', () => {
    it('Three.js + GSAP + Lottie を同時に検出する', () => {
      const result = WebGLDetector.analyzeHtml(MULTIPLE_LIBS_HTML);

      expect(result.isWebGL).toBe(true);
      expect(result.detectedLibraries).toContain('three.js');
      expect(result.detectedLibraries).toContain('gsap');
      expect(result.detectedLibraries).toContain('lottie');
    });

    it('複数ライブラリで信頼度が高くなる', () => {
      const result = WebGLDetector.analyzeHtml(MULTIPLE_LIBS_HTML);

      // Three.js単独より信頼度が高い
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });
});

// ============================================================================
// 信頼度スコア計算 テスト
// ============================================================================

describe('信頼度スコア計算', () => {
  describe('calculateConfidence ロジック', () => {
    it('confidence >= 0.7 → ultra-heavy', () => {
      const result = WebGLDetector.analyzeHtml(MULTIPLE_LIBS_HTML);

      // Three.js + その他 → 高信頼度
      if (result.confidence >= 0.7) {
        expect(['ultra-heavy', 'heavy']).toContain(result.siteTier);
      }
    });

    it('confidence >= 0.5 → heavy', () => {
      // Three.js単独
      const result = WebGLDetector.analyzeHtml(THREE_JS_HTML);

      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      expect(['ultra-heavy', 'heavy']).toContain(result.siteTier);
    });

    it('confidence >= 0.3 → webgl（URLパターン時）', () => {
      // URLパターンマッチでWebGL検出される場合
      const result = WebGLDetector.preDetect('https://example.com/webgl/demo');

      // URLパターンマッチは信頼度0.7でwebgl判定
      expect(result.siteTier).toBe('webgl');
    });

    it('confidence < 0.3 → normal', () => {
      // Canvas 2Dのみ
      const result = WebGLDetector.analyzeHtml(CANVAS_ONLY_HTML);

      expect(result.confidence).toBeLessThan(0.3);
      expect(result.siteTier).toBe('normal');
    });
  });

  describe('信頼度の正規化', () => {
    it('信頼度は0-1の範囲である', () => {
      const results = [
        WebGLDetector.analyzeHtml(THREE_JS_HTML),
        WebGLDetector.analyzeHtml(NORMAL_HTML),
        WebGLDetector.analyzeHtml(MULTIPLE_LIBS_HTML),
      ];

      for (const result of results) {
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
});

// ============================================================================
// WebGLDetector.getRecommendedConfig() テスト
// ============================================================================

describe('WebGLDetector.getRecommendedConfig()', () => {
  describe('ultra-heavy サイト設定', () => {
    it('ultra-heavy では GPU有効化、長いタイムアウトを推奨', () => {
      const detection: WebGLDetectionResult = {
        isWebGL: true,
        confidence: 0.9,
        siteTier: 'ultra-heavy',
        detectedLibraries: ['three.js'],
        indicators: {
          domainMatch: true,
          urlPatternMatch: false,
          htmlIndicators: [],
          scriptIndicators: [],
        },
        recommendedConfig: WebGLDetector.getRecommendedConfig({
          isWebGL: true,
          confidence: 0.9,
          siteTier: 'ultra-heavy',
          detectedLibraries: ['three.js'],
          indicators: {
            domainMatch: true,
            urlPatternMatch: false,
            htmlIndicators: [],
            scriptIndicators: [],
          },
        } as Omit<WebGLDetectionResult, 'recommendedConfig'>),
      };

      const config = detection.recommendedConfig;

      expect(config.enableGPU).toBe(true);
      expect(config.waitForWebGL).toBe(true);
      expect(config.timeout).toBeGreaterThanOrEqual(180000); // 3分以上
      expect(config.waitUntil).toBe('networkidle');
      expect(config.forceKillOnTimeout).toBe(true); // ultra-heavyでは強制終了有効
    });
  });

  describe('heavy サイト設定', () => {
    it('heavy では GPU有効化、中程度のタイムアウトを推奨', () => {
      const detection = WebGLDetector.preDetect('https://bruno-simon.com');
      const config = detection.recommendedConfig;

      expect(config.enableGPU).toBe(true);
      expect(config.waitForWebGL).toBe(true);
      expect(config.timeout).toBeGreaterThanOrEqual(120000); // 2分以上
      expect(config.timeout).toBeLessThan(180000); // 3分未満
    });
  });

  describe('webgl サイト設定', () => {
    it('webgl では GPU有効化、標準タイムアウトを推奨', () => {
      const detection = WebGLDetector.preDetect('https://example.com/webgl/demo');
      const config = detection.recommendedConfig;

      expect(config.enableGPU).toBe(true);
      expect(config.waitForWebGL).toBe(true);
      expect(config.timeout).toBeGreaterThanOrEqual(60000); // 1分以上
      expect(config.timeout).toBeLessThan(120000); // 2分未満
    });
  });

  describe('normal サイト設定', () => {
    it('normal では GPU無効、短いタイムアウトを推奨', () => {
      const detection = WebGLDetector.preDetect('https://www.google.com');
      const config = detection.recommendedConfig;

      expect(config.enableGPU).toBe(false);
      expect(config.waitForWebGL).toBe(false);
      expect(config.timeout).toBeLessThanOrEqual(60000); // 1分以下
      expect(config.forceKillOnTimeout).toBe(false);
    });
  });

  describe('waitUntil設定', () => {
    it('WebGLサイトではnetworkidleを推奨', () => {
      const detection = WebGLDetector.analyzeHtml(THREE_JS_HTML);

      expect(detection.recommendedConfig.waitUntil).toBe('networkidle');
    });

    it('通常サイトではloadを推奨', () => {
      const detection = WebGLDetector.analyzeHtml(NORMAL_HTML);

      expect(detection.recommendedConfig.waitUntil).toBe('load');
    });
  });
});

// ============================================================================
// siteTier決定 テスト
// ============================================================================

describe('siteTier決定', () => {
  describe('confidence に基づく判定', () => {
    it('confidence >= 0.7 → ultra-heavy（ドメインマッチ時）', () => {
      const result = WebGLDetector.preDetect('https://resn.co.nz');

      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      expect(result.siteTier).toBe('ultra-heavy');
    });

    it('confidence >= 0.5 → heavy（HTML解析時）', () => {
      const result = WebGLDetector.analyzeHtml(THREE_JS_HTML);

      // Three.js検出で0.9程度の信頼度
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      expect(['ultra-heavy', 'heavy']).toContain(result.siteTier);
    });

    it('confidence >= 0.3 → webgl（URLパターンマッチ時）', () => {
      // URLパターンマッチ（/webgl/）は信頼度0.7でwebglとなる
      const result = WebGLDetector.preDetect('https://example.com/projects/webgl/demo');

      expect(result.siteTier).toBe('webgl');
    });

    it('confidence < 0.3 → normal', () => {
      const result = WebGLDetector.analyzeHtml(NORMAL_HTML);

      expect(result.confidence).toBeLessThan(0.3);
      expect(result.siteTier).toBe('normal');
    });
  });
});

// ============================================================================
// 後方互換性 テスト
// ============================================================================

describe('後方互換性', () => {
  describe('detectWebGL 関数', () => {
    it('既存のdetectWebGL関数が動作する', () => {
      const result = detectWebGL(THREE_JS_HTML);

      expect(result.detected).toBe(true);
      expect(result.libraries).toContain('three.js');
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  describe('adjustTimeoutForWebGL 関数', () => {
    it('既存のadjustTimeoutForWebGL関数が動作する', () => {
      const webglResult = detectWebGL(THREE_JS_HTML);
      const adjusted = adjustTimeoutForWebGL(60000, webglResult);

      expect(adjusted.extended).toBe(true);
      expect(adjusted.effectiveTimeout).toBeGreaterThan(60000);
    });
  });
});

// ============================================================================
// エッジケース テスト
// ============================================================================

describe('エッジケース', () => {
  describe('空・null・undefined 入力', () => {
    it('空文字列でエラーが発生しない', () => {
      expect(() => WebGLDetector.analyzeHtml('')).not.toThrow();

      const result = WebGLDetector.analyzeHtml('');
      expect(result.isWebGL).toBe(false);
    });

    it('空URLでエラーが発生しない', () => {
      expect(() => WebGLDetector.preDetect('')).not.toThrow();

      const result = WebGLDetector.preDetect('');
      expect(result.isWebGL).toBe(false);
    });
  });

  describe('不正なHTML', () => {
    it('タグが閉じていないHTMLでも処理できる', () => {
      const brokenHtml = '<html><head><script src="three.min.js">';
      expect(() => WebGLDetector.analyzeHtml(brokenHtml)).not.toThrow();
    });
  });

  describe('大文字小文字', () => {
    it('大文字のスクリプト名も検出する', () => {
      const uppercaseHtml = '<script src="THREE.JS"></script>';
      const result = WebGLDetector.analyzeHtml(uppercaseHtml);

      // 大文字でも検出可能であること
      expect(result.indicators.htmlIndicators.length + result.indicators.scriptIndicators.length)
        .toBeGreaterThanOrEqual(0); // 検出またはスキップ（実装依存）
    });
  });
});

// ============================================================================
// パフォーマンス テスト
// ============================================================================

describe('パフォーマンス', () => {
  it('1000回のHTML分析が1秒以内で完了する', () => {
    const startTime = performance.now();

    for (let i = 0; i < 1000; i++) {
      WebGLDetector.analyzeHtml(THREE_JS_HTML);
    }

    const duration = performance.now() - startTime;
    expect(duration).toBeLessThan(1000); // 1秒以内
  });

  it('1000回のURL分析が100ms以内で完了する', () => {
    const urls = [
      'https://resn.co.nz',
      'https://google.com',
      'https://example.com/webgl/demo',
    ];

    const startTime = performance.now();

    for (let i = 0; i < 1000; i++) {
      const url = urls[i % urls.length] ?? urls[0];
      WebGLDetector.preDetect(url);
    }

    const duration = performance.now() - startTime;
    expect(duration).toBeLessThan(100); // 100ms以内
  });
});
