// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BackgroundDesignDetectorService Unit Tests
 *
 * CSS背景デザインパターンの検出・分類サービスのユニットテスト
 *
 * テスト対象:
 * - 単色背景の検出 (solid_color)
 * - グラデーション検出 (linear, radial, conic)
 * - ガラスモーフィズム検出 (glassmorphism)
 * - アニメーショングラデーション (animated_gradient)
 * - 画像/SVG背景検出 (image_background, svg_background)
 * - パターン背景検出 (pattern_background)
 * - 複合レイヤー検出 (multi_layer)
 * - メッシュグラデーション検出 (mesh_gradient)
 * - ノイズテクスチャ検出 (noise_texture)
 * - 動画背景検出 (video_background)
 * - エッジケース (空CSS, 不正CSS, 巨大入力)
 * - パフォーマンス (1MB CSS処理 < 5秒)
 *
 * @module tests/services/background/background-design-detector.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createBackgroundDesignDetectorService,
  type BackgroundDesignDetectorService,
  type BackgroundDesignDetection,
  type BackgroundDesignDetectorResult,
  type BackgroundDesignType,
} from '../../../src/services/background/background-design-detector.service.js';

describe('BackgroundDesignDetectorService', () => {
  let service: BackgroundDesignDetectorService;

  beforeEach(() => {
    service = createBackgroundDesignDetectorService();
  });

  // =========================================================================
  // Factory function
  // =========================================================================

  describe('createBackgroundDesignDetectorService', () => {
    it('サービスインスタンスが作成されること', () => {
      expect(service).toBeDefined();
      expect(typeof service.detect).toBe('function');
    });
  });

  // =========================================================================
  // Solid Color Detection
  // =========================================================================

  describe('solid_color detection', () => {
    it('background-color のみの場合 solid_color として検出されること', () => {
      const css = `.hero { background-color: #ff5733; }`;
      const result = service.detect({ cssContent: css });

      expect(result.totalDetected).toBeGreaterThanOrEqual(1);
      const bg = result.backgrounds.find((b) => b.designType === 'solid_color');
      expect(bg).toBeDefined();
      expect(bg!.selector).toBe('.hero');
      expect(bg!.colorInfo.dominantColors).toContain('#ff5733');
      expect(bg!.colorInfo.colorCount).toBe(1);
      expect(bg!.colorInfo.hasAlpha).toBe(false);
    });

    it('rgb() 形式の単色背景を検出すること', () => {
      const css = `.section { background: rgb(100, 200, 50); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'solid_color');
      expect(bg).toBeDefined();
    });

    it('rgba() 形式でアルファ付き単色背景を検出すること', () => {
      const css = `.overlay { background-color: rgba(0, 0, 0, 0.5); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'solid_color');
      expect(bg).toBeDefined();
      expect(bg!.colorInfo.hasAlpha).toBe(true);
    });

    it('named color の単色背景を検出すること', () => {
      const css = `body { background-color: white; }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'solid_color');
      expect(bg).toBeDefined();
    });

    it('hsl() 形式の単色背景を検出すること', () => {
      const css = `.card { background: hsl(210, 50%, 40%); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'solid_color');
      expect(bg).toBeDefined();
    });
  });

  // =========================================================================
  // Linear Gradient Detection
  // =========================================================================

  describe('linear_gradient detection', () => {
    it('基本的な linear-gradient を検出すること', () => {
      const css = `.hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'linear_gradient');
      expect(bg).toBeDefined();
      expect(bg!.gradientInfo).toBeDefined();
      expect(bg!.gradientInfo!.type).toBe('linear');
      expect(bg!.gradientInfo!.angle).toBe(135);
      expect(bg!.gradientInfo!.stops.length).toBeGreaterThanOrEqual(2);
      expect(bg!.gradientInfo!.repeating).toBe(false);
    });

    it('方向キーワード (to right) を角度に変換すること', () => {
      const css = `.bar { background: linear-gradient(to right, red, blue); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'linear_gradient');
      expect(bg).toBeDefined();
      expect(bg!.gradientInfo!.angle).toBe(90);
    });

    it('repeating-linear-gradient を検出すること', () => {
      const css = `.pattern { background: repeating-linear-gradient(45deg, #606dbc 0px, #606dbc 10px, #465298 10px, #465298 20px); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'linear_gradient');
      expect(bg).toBeDefined();
      expect(bg!.gradientInfo!.repeating).toBe(true);
    });

    it('3色以上のグラデーションストップを抽出すること', () => {
      const css = `.rainbow { background: linear-gradient(90deg, red 0%, orange 25%, yellow 50%, green 75%, blue 100%); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'linear_gradient');
      expect(bg).toBeDefined();
      expect(bg!.gradientInfo!.stops.length).toBeGreaterThanOrEqual(5);
      expect(bg!.colorInfo.colorCount).toBeGreaterThanOrEqual(5);
    });
  });

  // =========================================================================
  // Radial Gradient Detection
  // =========================================================================

  describe('radial_gradient detection', () => {
    it('radial-gradient を検出すること', () => {
      const css = `.circle { background: radial-gradient(circle, #ff0000, #0000ff); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'radial_gradient');
      expect(bg).toBeDefined();
      expect(bg!.gradientInfo).toBeDefined();
      expect(bg!.gradientInfo!.type).toBe('radial');
    });

    it('repeating-radial-gradient を検出すること', () => {
      const css = `.rings { background: repeating-radial-gradient(circle, red 0px, red 5px, blue 5px, blue 10px); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'radial_gradient');
      expect(bg).toBeDefined();
      expect(bg!.gradientInfo!.repeating).toBe(true);
    });
  });

  // =========================================================================
  // Conic Gradient Detection
  // =========================================================================

  describe('conic_gradient detection', () => {
    it('conic-gradient を検出すること', () => {
      const css = `.pie { background: conic-gradient(red, orange, yellow, green, blue); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'conic_gradient');
      expect(bg).toBeDefined();
      expect(bg!.gradientInfo).toBeDefined();
      expect(bg!.gradientInfo!.type).toBe('conic');
    });
  });

  // =========================================================================
  // Mesh Gradient Detection
  // =========================================================================

  describe('mesh_gradient detection', () => {
    it('複数の重複する radial-gradient を mesh_gradient として検出すること', () => {
      const css = `.mesh {
        background:
          radial-gradient(at 40% 20%, hsla(28,100%,74%,1) 0px, transparent 50%),
          radial-gradient(at 80% 0%, hsla(189,100%,56%,1) 0px, transparent 50%),
          radial-gradient(at 0% 50%, hsla(355,100%,93%,1) 0px, transparent 50%);
      }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'mesh_gradient');
      expect(bg).toBeDefined();
      expect(bg!.visualProperties.layers).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // Glassmorphism Detection
  // =========================================================================

  describe('glassmorphism detection', () => {
    it('backdrop-filter: blur + 半透明背景で glassmorphism を検出すること', () => {
      const css = `.glass {
        background: rgba(255, 255, 255, 0.15);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'glassmorphism');
      expect(bg).toBeDefined();
      expect(bg!.visualProperties.blurRadius).toBe(10);
      expect(bg!.colorInfo.hasAlpha).toBe(true);
    });

    it('blur なしの半透明背景は glassmorphism として検出されないこと', () => {
      const css = `.transparent { background: rgba(255, 255, 255, 0.5); }`;
      const result = service.detect({ cssContent: css });

      const glassBg = result.backgrounds.find((b) => b.designType === 'glassmorphism');
      expect(glassBg).toBeUndefined();
    });
  });

  // =========================================================================
  // Animated Gradient Detection
  // =========================================================================

  describe('animated_gradient detection', () => {
    it('グラデーション + CSS animation を animated_gradient として検出すること', () => {
      const css = `
        .animated-bg {
          background: linear-gradient(270deg, #ee7752, #e73c7e, #23a6d5, #23d5ab);
          background-size: 800% 800%;
          animation: gradientShift 15s ease infinite;
        }
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      `;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'animated_gradient');
      expect(bg).toBeDefined();
      expect(bg!.animationInfo).toBeDefined();
      expect(bg!.animationInfo!.isAnimated).toBe(true);
      expect(bg!.animationInfo!.animationName).toBe('gradientShift');
      expect(bg!.animationInfo!.duration).toBe('15s');
    });

    it('transition on background を animated_gradient として検出すること', () => {
      const css = `
        .hover-gradient {
          background: linear-gradient(to right, #ff6b6b, #4ecdc4);
          transition: background 0.5s ease;
        }
      `;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'animated_gradient');
      expect(bg).toBeDefined();
      expect(bg!.animationInfo).toBeDefined();
      expect(bg!.animationInfo!.isAnimated).toBe(true);
    });
  });

  // =========================================================================
  // Image Background Detection
  // =========================================================================

  describe('image_background detection', () => {
    it('url() で画像ファイルを参照する背景を検出すること', () => {
      const css = `.hero { background-image: url("hero-bg.jpg"); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'image_background');
      expect(bg).toBeDefined();
      expect(bg!.cssValue).toContain('url(');
    });

    it('webp 画像参照を検出すること', () => {
      const css = `.banner { background: url("/images/banner.webp") center/cover no-repeat; }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'image_background');
      expect(bg).toBeDefined();
    });

    it('png 画像参照を検出すること', () => {
      const css = `.icon-bg { background-image: url("pattern.png"); }`;
      const result = service.detect({ cssContent: css });

      // png with no repeat info could be image_background or pattern
      const bg = result.backgrounds.find(
        (b) => b.designType === 'image_background' || b.designType === 'pattern_background'
      );
      expect(bg).toBeDefined();
    });
  });

  // =========================================================================
  // Pattern Background Detection
  // =========================================================================

  describe('pattern_background detection', () => {
    it('小さい画像 + repeat で pattern_background として検出すること', () => {
      const css = `.pattern {
        background-image: url("tile.png");
        background-repeat: repeat;
        background-size: 20px 20px;
      }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'pattern_background');
      expect(bg).toBeDefined();
    });
  });

  // =========================================================================
  // SVG Background Detection
  // =========================================================================

  describe('svg_background detection', () => {
    it('SVG ファイル参照を svg_background として検出すること', () => {
      const css = `.decorated { background-image: url("pattern.svg"); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'svg_background');
      expect(bg).toBeDefined();
    });

    it('インライン SVG data URI を検出すること', () => {
      const css = `.noise { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='100' height='100' fill='red'/%3E%3C/svg%3E"); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'svg_background');
      expect(bg).toBeDefined();
    });
  });

  // =========================================================================
  // Noise Texture Detection
  // =========================================================================

  describe('noise_texture detection', () => {
    it('SVG feTurbulence ノイズフィルタを noise_texture として検出すること', () => {
      const css = `.textured { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E"); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'noise_texture');
      expect(bg).toBeDefined();
    });
  });

  // =========================================================================
  // Video Background Detection
  // =========================================================================

  describe('video_background detection', () => {
    it('HTML <video> 要素 + position: absolute で video_background を検出すること', () => {
      const html = `
        <div class="video-container">
          <video autoplay muted loop class="bg-video">
            <source src="bg.mp4" type="video/mp4">
          </video>
        </div>
      `;
      const css = `.bg-video {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }`;
      const result = service.detect({ cssContent: css, htmlContent: html });

      const bg = result.backgrounds.find((b) => b.designType === 'video_background');
      expect(bg).toBeDefined();
    });
  });

  // =========================================================================
  // Multi-Layer Detection
  // =========================================================================

  describe('multi_layer detection', () => {
    it('複数背景レイヤー(画像 + グラデーション)を multi_layer として検出すること', () => {
      const css = `.layered {
        background:
          linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5)),
          url("photo.jpg") center/cover;
      }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'multi_layer');
      expect(bg).toBeDefined();
      expect(bg!.visualProperties.layers).toBeGreaterThanOrEqual(2);
      expect(bg!.visualProperties.hasOverlay).toBe(true);
    });
  });

  // =========================================================================
  // Visual Properties
  // =========================================================================

  describe('visual properties extraction', () => {
    it('backdrop-filter: blur の値を抽出すること', () => {
      const css = `.blur { backdrop-filter: blur(20px); background: rgba(255,255,255,0.1); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.visualProperties.blurRadius > 0);
      expect(bg).toBeDefined();
      expect(bg!.visualProperties.blurRadius).toBe(20);
    });

    it('opacity の値を抽出すること', () => {
      const css = `.faded { background-color: #333; opacity: 0.8; }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds[0];
      expect(bg).toBeDefined();
      expect(bg!.visualProperties.opacity).toBe(0.8);
    });

    it('mix-blend-mode を抽出すること', () => {
      const css = `.blend { background: red; mix-blend-mode: multiply; }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds[0];
      expect(bg).toBeDefined();
      expect(bg!.visualProperties.blendMode).toBe('multiply');
    });
  });

  // =========================================================================
  // Performance Assessment
  // =========================================================================

  describe('performance assessment', () => {
    it('will-change 使用時に gpuAccelerated が true になること', () => {
      const css = `.accelerated { background: linear-gradient(red, blue); will-change: transform; }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds[0];
      expect(bg).toBeDefined();
      expect(bg!.performance.gpuAccelerated).toBe(true);
    });

    it('多数のグラデーションストップで estimatedImpact が high になること', () => {
      const stops = Array.from({ length: 20 }, (_, i) => `hsl(${i * 18}, 100%, 50%) ${(i / 19 * 100).toFixed(0)}%`).join(', ');
      const css = `.complex { background: linear-gradient(90deg, ${stops}); backdrop-filter: blur(20px); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.performance.estimatedImpact === 'high');
      expect(bg).toBeDefined();
    });

    it('単純なソリッドカラーの estimatedImpact が low であること', () => {
      const css = `.simple { background-color: #fff; }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds[0];
      expect(bg).toBeDefined();
      expect(bg!.performance.estimatedImpact).toBe('low');
    });
  });

  // =========================================================================
  // Naming Generation
  // =========================================================================

  describe('descriptive naming', () => {
    it('linear gradient に角度と色を含む名前が生成されること', () => {
      const css = `.hero { background: linear-gradient(135deg, #1a1a2e, #16213e); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'linear_gradient');
      expect(bg).toBeDefined();
      expect(bg!.name.length).toBeGreaterThan(0);
      expect(bg!.name).toContain('linear');
    });
  });

  // =========================================================================
  // CSS Implementation Reconstruction
  // =========================================================================

  describe('cssImplementation reconstruction', () => {
    it('検出結果からCSS実装コードが再構成されること', () => {
      const css = `.section { background: linear-gradient(to bottom, #000, #fff); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds[0];
      expect(bg).toBeDefined();
      expect(bg!.cssImplementation.length).toBeGreaterThan(0);
      expect(bg!.cssImplementation).toContain('background');
    });
  });

  // =========================================================================
  // Confidence Score
  // =========================================================================

  describe('confidence scoring', () => {
    it('明確な linear-gradient の confidence が 0.8 以上であること', () => {
      const css = `.clear { background: linear-gradient(90deg, red, blue); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.designType === 'linear_gradient');
      expect(bg).toBeDefined();
      expect(bg!.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('confidence が 0-1 の範囲内であること', () => {
      const css = `
        .a { background-color: red; }
        .b { background: linear-gradient(red, blue); }
        .c { background: radial-gradient(circle, red, blue); }
      `;
      const result = service.detect({ cssContent: css });

      for (const bg of result.backgrounds) {
        expect(bg.confidence).toBeGreaterThanOrEqual(0);
        expect(bg.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  // =========================================================================
  // Position Index
  // =========================================================================

  describe('positionIndex ordering', () => {
    it('CSSの出現順に positionIndex が付与されること', () => {
      const css = `
        .first { background-color: red; }
        .second { background: linear-gradient(red, blue); }
        .third { background: radial-gradient(circle, red, blue); }
      `;
      const result = service.detect({ cssContent: css });

      expect(result.backgrounds.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < result.backgrounds.length; i++) {
        expect(result.backgrounds[i]!.positionIndex).toBeGreaterThan(result.backgrounds[i - 1]!.positionIndex);
      }
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('空文字列の CSS で空の結果が返ること', () => {
      const result = service.detect({ cssContent: '' });

      expect(result.totalDetected).toBe(0);
      expect(result.backgrounds).toHaveLength(0);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('背景プロパティのない CSS で空の結果が返ること', () => {
      const css = `.no-bg { color: red; font-size: 16px; margin: 0; }`;
      const result = service.detect({ cssContent: css });

      expect(result.totalDetected).toBe(0);
    });

    it('不正な CSS でエラーなく空の結果が返ること', () => {
      const css = `this is not css {{{ invalid: something; }}}}}`;
      const result = service.detect({ cssContent: css });

      // Should not throw, just return empty or partial results
      expect(result).toBeDefined();
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('CSS コメントを正しくスキップすること', () => {
      const css = `
        /* This is a comment with background: red; */
        .real { background-color: blue; }
      `;
      const result = service.detect({ cssContent: css });

      expect(result.totalDetected).toBe(1);
      const bg = result.backgrounds[0];
      expect(bg!.designType).toBe('solid_color');
    });

    it('@media クエリ内の背景を検出すること', () => {
      const css = `
        @media (min-width: 768px) {
          .responsive { background: linear-gradient(red, blue); }
        }
      `;
      const result = service.detect({ cssContent: css });

      // Should detect the gradient inside media query
      const bg = result.backgrounds.find((b) => b.designType === 'linear_gradient');
      expect(bg).toBeDefined();
    });

    it('5MB 超の CSS 入力で validation エラーが返ること', () => {
      const largeCss = '.x { background: red; }\n'.repeat(300000); // > 5MB
      expect(largeCss.length).toBeGreaterThan(5 * 1024 * 1024);

      expect(() => service.detect({ cssContent: largeCss })).toThrow();
    });
  });

  // =========================================================================
  // Color Space Detection
  // =========================================================================

  describe('color space detection', () => {
    it('oklch() 色空間を検出すること', () => {
      const css = `.modern { background: linear-gradient(oklch(70% 0.15 210), oklch(50% 0.25 280)); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds.find((b) => b.colorInfo.colorSpace === 'oklch');
      expect(bg).toBeDefined();
    });

    it('標準 hex/rgb は srgb として検出されること', () => {
      const css = `.standard { background: linear-gradient(#ff0000, #0000ff); }`;
      const result = service.detect({ cssContent: css });

      const bg = result.backgrounds[0];
      expect(bg).toBeDefined();
      expect(bg!.colorInfo.colorSpace).toBe('srgb');
    });
  });

  // =========================================================================
  // External CSS Content
  // =========================================================================

  describe('external CSS content', () => {
    it('externalCssContent からも検出すること', () => {
      const css = `.local { background-color: red; }`;
      const external = `.external-hero { background: linear-gradient(45deg, #ff6b35, #f7c59f); }`;

      const result = service.detect({ cssContent: css, externalCssContent: external });

      expect(result.totalDetected).toBeGreaterThanOrEqual(2);
      const gradient = result.backgrounds.find((b) => b.designType === 'linear_gradient');
      expect(gradient).toBeDefined();
    });
  });

  // =========================================================================
  // HTML Context
  // =========================================================================

  describe('HTML context', () => {
    it('HTML の <style> タグ内の CSS からも検出すること', () => {
      const html = `
        <html>
          <head>
            <style>
              .from-html { background: radial-gradient(circle, pink, purple); }
            </style>
          </head>
          <body><div class="from-html"></div></body>
        </html>
      `;
      const result = service.detect({ cssContent: '', htmlContent: html });

      const bg = result.backgrounds.find((b) => b.designType === 'radial_gradient');
      expect(bg).toBeDefined();
    });

    it('HTML の inline style 属性から background-color を検出すること', () => {
      const html = `
        <html>
          <body>
            <div style="background-color: #2e3143; padding: 15px;">Content</div>
          </body>
        </html>
      `;
      const result = service.detect({ cssContent: '', htmlContent: html });

      const bg = result.backgrounds.find((b) => b.designType === 'solid_color');
      expect(bg).toBeDefined();
      expect(bg?.cssValue).toContain('#2e3143');
    });

    it('HTML の inline style 属性から linear-gradient を検出すること', () => {
      const html = `
        <html>
          <body>
            <section style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">Hero</section>
          </body>
        </html>
      `;
      const result = service.detect({ cssContent: '', htmlContent: html });

      const bg = result.backgrounds.find((b) => b.designType === 'linear_gradient');
      expect(bg).toBeDefined();
    });

    it('重複する inline style は1つにまとめられること', () => {
      const html = `
        <html>
          <body>
            <div style="background-color: #2e3143;">Item 1</div>
            <div style="background-color: #2e3143;">Item 2</div>
            <div style="background-color: #2e3143;">Item 3</div>
            <div style="background-color: #c1f74f;">CTA Button</div>
          </body>
        </html>
      `;
      const result = service.detect({ cssContent: '', htmlContent: html });

      // #2e3143 should be deduplicated to 1, #c1f74f adds 1 = at most 2
      const solidColors = result.backgrounds.filter((b) => b.designType === 'solid_color');
      expect(solidColors.length).toBeLessThanOrEqual(2);
    });

    it('背景関連のない inline style は無視されること', () => {
      const html = `
        <html>
          <body>
            <div style="font-size: 14px; color: red; padding: 10px;">Text</div>
          </body>
        </html>
      `;
      const result = service.detect({ cssContent: '', htmlContent: html });
      expect(result.backgrounds.length).toBe(0);
    });
  });

  // =========================================================================
  // Result Structure
  // =========================================================================

  describe('result structure', () => {
    it('processingTimeMs が記録されること', () => {
      const css = `.test { background-color: red; }`;
      const result = service.detect({ cssContent: css });

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.processingTimeMs).toBe('number');
    });

    it('totalDetected が backgrounds の数と一致すること', () => {
      const css = `
        .a { background-color: red; }
        .b { background: linear-gradient(red, blue); }
      `;
      const result = service.detect({ cssContent: css });

      expect(result.totalDetected).toBe(result.backgrounds.length);
    });
  });

  // =========================================================================
  // Performance Test
  // =========================================================================

  describe('performance', () => {
    it('1MB の CSS を 5 秒以内に処理すること', () => {
      // Generate ~1MB CSS with many background rules
      const rules: string[] = [];
      for (let i = 0; i < 10000; i++) {
        rules.push(`.bg-${i} { background: linear-gradient(${i}deg, #${(i * 17 % 0xFFFFFF).toString(16).padStart(6, '0')}, #${(i * 31 % 0xFFFFFF).toString(16).padStart(6, '0')}); }`);
      }
      const largeCss = rules.join('\n');

      // Should be close to 1MB
      expect(largeCss.length).toBeGreaterThan(500_000);
      expect(largeCss.length).toBeLessThan(5 * 1024 * 1024); // under 5MB limit

      const start = performance.now();
      const result = service.detect({ cssContent: largeCss });
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5000); // < 5 seconds
      expect(result.totalDetected).toBeGreaterThan(0);
    });
  });
});
