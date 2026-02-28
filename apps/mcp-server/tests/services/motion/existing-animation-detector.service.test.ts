// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ExistingAnimationDetectorService テスト
 *
 * 既存のCSS @keyframesアニメーションを検出し、
 * 重複チェックを行うサービスのテスト
 *
 * @module services/motion/existing-animation-detector.service.test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ExistingAnimationDetectorService,
  type ExistingAnimation,
  type DuplicateCheckResult,
  type AnimationMatch,
} from '../../../src/services/motion/existing-animation-detector.service';
import * as fs from 'fs/promises';

// fsモジュールをモック
vi.mock('fs/promises');

describe('ExistingAnimationDetectorService', () => {
  let service: ExistingAnimationDetectorService;

  beforeEach(() => {
    service = new ExistingAnimationDetectorService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseCSSForKeyframes', () => {
    it('@keyframes fadeInをglobals.cssから検出する', async () => {
      const cssContent = `
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(24px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `;

      vi.mocked(fs.readFile).mockResolvedValue(cssContent);

      const animations = await service.scanCSSFile('/path/to/globals.css');

      expect(animations).toHaveLength(1);
      expect(animations[0].name).toBe('fadeIn');
      expect(animations[0].filePath).toBe('/path/to/globals.css');
      expect(animations[0].properties).toContain('opacity');
      expect(animations[0].properties).toContain('transform');
    });

    it('@keyframes shimmerを検出する', async () => {
      const cssContent = `
        @keyframes shimmer {
          0% {
            background-position: -200% center;
          }
          100% {
            background-position: 200% center;
          }
        }
      `;

      vi.mocked(fs.readFile).mockResolvedValue(cssContent);

      const animations = await service.scanCSSFile('/path/to/globals.css');

      expect(animations).toHaveLength(1);
      expect(animations[0].name).toBe('shimmer');
      expect(animations[0].keyframes).toHaveLength(2);
      expect(animations[0].keyframes[0].offset).toBe(0);
      expect(animations[0].keyframes[1].offset).toBe(1);
    });

    it('複数の@keyframesを検出する', async () => {
      const cssContent = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes slideUp {
          from { transform: translateY(40px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }

        @keyframes glowPulse {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.05); }
        }
      `;

      vi.mocked(fs.readFile).mockResolvedValue(cssContent);

      const animations = await service.scanCSSFile('/path/to/globals.css');

      expect(animations).toHaveLength(3);
      const names = animations.map(a => a.name);
      expect(names).toContain('fadeIn');
      expect(names).toContain('slideUp');
      expect(names).toContain('glowPulse');
    });

    it('ベンダープレフィックス付き@keyframesを除外する', async () => {
      const cssContent = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @-webkit-keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;

      vi.mocked(fs.readFile).mockResolvedValue(cssContent);

      const animations = await service.scanCSSFile('/path/to/globals.css');

      // ベンダープレフィックスなしのみカウント
      expect(animations).toHaveLength(1);
      expect(animations[0].name).toBe('fadeIn');
    });
  });

  describe('calculateSimilarity', () => {
    it('完全一致のアニメーションで類似度1.0を返す', () => {
      const existing: ExistingAnimation = {
        name: 'fadeIn',
        filePath: '/globals.css',
        rawCSS: '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }',
        properties: ['opacity'],
        keyframes: [
          { offset: 0, properties: { opacity: '0' } },
          { offset: 1, properties: { opacity: '1' } },
        ],
      };

      const newPattern = {
        name: 'fadeIn',
        properties: [{ name: 'opacity', from: '0', to: '1' }],
        type: 'animation' as const,
        duration: 300,
        easing: 'ease',
      };

      const similarity = service.calculateSimilarity(existing, newPattern);

      expect(similarity).toBe(1.0);
    });

    it('プロパティが同じで値が異なる場合、高い類似度を返す', () => {
      const existing: ExistingAnimation = {
        name: 'fadeIn',
        filePath: '/globals.css',
        rawCSS: '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }',
        properties: ['opacity'],
        keyframes: [
          { offset: 0, properties: { opacity: '0' } },
          { offset: 1, properties: { opacity: '1' } },
        ],
      };

      const newPattern = {
        name: 'fadeOut',
        properties: [{ name: 'opacity', from: '1', to: '0' }],
        type: 'animation' as const,
        duration: 300,
        easing: 'ease',
      };

      const similarity = service.calculateSimilarity(existing, newPattern);

      // プロパティが同じなので高い類似度
      expect(similarity).toBeGreaterThanOrEqual(0.7);
    });

    it('完全に異なるアニメーションで低い類似度を返す', () => {
      const existing: ExistingAnimation = {
        name: 'fadeIn',
        filePath: '/globals.css',
        rawCSS: '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }',
        properties: ['opacity'],
        keyframes: [
          { offset: 0, properties: { opacity: '0' } },
          { offset: 1, properties: { opacity: '1' } },
        ],
      };

      const newPattern = {
        name: 'rotate360',
        properties: [{ name: 'transform', from: 'rotate(0deg)', to: 'rotate(360deg)' }],
        type: 'animation' as const,
        duration: 1000,
        easing: 'linear',
      };

      const similarity = service.calculateSimilarity(existing, newPattern);

      expect(similarity).toBeLessThan(0.3);
    });
  });

  describe('checkDuplicates', () => {
    it('既存shimmerアニメーションと類似した場合に警告を返す', async () => {
      const cssContent = `
        @keyframes shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
      `;

      vi.mocked(fs.readFile).mockResolvedValue(cssContent);

      const newPattern = {
        name: 'myShimmer',
        properties: [{ name: 'background-position', from: '-100% center', to: '100% center' }],
        type: 'animation' as const,
        duration: 2000,
        easing: 'linear',
      };

      const result = await service.checkDuplicates(newPattern, {
        projectCSSPath: '/path/to/globals.css',
        similarityThreshold: 0.8,
      });

      expect(result.hasDuplicates).toBe(true);
      expect(result.existingMatches).toHaveLength(1);
      expect(result.existingMatches[0].animationName).toBe('shimmer');
      expect(result.existingMatches[0].similarity).toBeGreaterThanOrEqual(0.8);
      expect(result.warnings).toHaveLength(1);
    });

    it('90%以上の一致で生成をスキップする提案を返す', async () => {
      const cssContent = `
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(24px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `;

      vi.mocked(fs.readFile).mockResolvedValue(cssContent);

      const newPattern = {
        name: 'fadeInAnimation',
        properties: [
          { name: 'opacity', from: '0', to: '1' },
          { name: 'transform', from: 'translateY(24px)', to: 'translateY(0)' },
        ],
        type: 'animation' as const,
        duration: 500,
        easing: 'ease-out',
      };

      const result = await service.checkDuplicates(newPattern, {
        projectCSSPath: '/path/to/globals.css',
        similarityThreshold: 0.8,
      });

      expect(result.hasDuplicates).toBe(true);
      expect(result.existingMatches[0].similarity).toBeGreaterThanOrEqual(0.9);
      expect(result.existingMatches[0].suggestion).toContain('fadeIn');
      expect(result.existingMatches[0].suggestion).toContain('globals.css');
    });

    it('複数のCSSファイルをスキャンする', async () => {
      const globalsCss = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;

      const animationsCss = `
        @keyframes bounceIn {
          0% { transform: scale(0.5); }
          80% { transform: scale(1.1); }
          100% { transform: scale(1); }
        }
      `;

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(globalsCss)
        .mockResolvedValueOnce(animationsCss);

      const newPattern = {
        name: 'myFade',
        properties: [{ name: 'opacity', from: '0', to: '1' }],
        type: 'animation' as const,
        duration: 300,
        easing: 'ease',
      };

      const result = await service.checkDuplicates(newPattern, {
        projectCSSPaths: ['/path/to/globals.css', '/path/to/animations.css'],
        similarityThreshold: 0.8,
      });

      expect(result.hasDuplicates).toBe(true);
      expect(result.existingMatches[0].animationName).toBe('fadeIn');
    });

    it('大文字小文字を無視してアニメーション名を比較する', async () => {
      const cssContent = `
        @keyframes FadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;

      vi.mocked(fs.readFile).mockResolvedValue(cssContent);

      const newPattern = {
        name: 'fadein',
        properties: [{ name: 'opacity', from: '0', to: '1' }],
        type: 'animation' as const,
        duration: 300,
        easing: 'ease',
      };

      const result = await service.checkDuplicates(newPattern, {
        projectCSSPath: '/path/to/globals.css',
        similarityThreshold: 0.8,
      });

      expect(result.hasDuplicates).toBe(true);
      expect(result.existingMatches[0].animationName).toBe('FadeIn');
    });

    it('重複がない場合はhasDuplicatesがfalse', async () => {
      const cssContent = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;

      vi.mocked(fs.readFile).mockResolvedValue(cssContent);

      const newPattern = {
        name: 'rotate3d',
        properties: [{ name: 'transform', from: 'rotateX(0)', to: 'rotateX(360deg)' }],
        type: 'animation' as const,
        duration: 1000,
        easing: 'linear',
      };

      const result = await service.checkDuplicates(newPattern, {
        projectCSSPath: '/path/to/globals.css',
        similarityThreshold: 0.8,
      });

      expect(result.hasDuplicates).toBe(false);
      expect(result.existingMatches).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('scanDirectory', () => {
    it('ディレクトリ内の全CSSファイルをスキャンする', async () => {
      vi.mocked(fs.readdir as unknown as () => Promise<string[]>).mockResolvedValue([
        'globals.css',
        'animations.css',
        'styles.css',
        'notcss.txt',
      ]);

      vi.mocked(fs.stat as unknown as () => Promise<{ isFile: () => boolean }>).mockResolvedValue({
        isFile: () => true,
      });

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce('@keyframes a { from { } to { } }')
        .mockResolvedValueOnce('@keyframes b { from { } to { } }')
        .mockResolvedValueOnce('@keyframes c { from { } to { } }');

      const animations = await service.scanDirectory('/project/styles');

      // .cssファイルのみスキャン
      expect(vi.mocked(fs.readFile)).toHaveBeenCalledTimes(3);
      expect(animations.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('buildAnimationRegistry', () => {
    it('アニメーションレジストリを構築する', async () => {
      const cssContent = `
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { transform: translateY(20px); } to { transform: translateY(0); } }
      `;

      vi.mocked(fs.readFile).mockResolvedValue(cssContent);

      const registry = await service.buildAnimationRegistry(['/path/to/globals.css']);

      expect(registry.size).toBe(2);
      expect(registry.has('fadeIn')).toBe(true);
      expect(registry.has('slideUp')).toBe(true);
      expect(registry.get('fadeIn')?.filePath).toBe('/path/to/globals.css');
    });
  });

  describe('error handling', () => {
    it('ファイルが存在しない場合は空配列を返す', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT: no such file'));

      const animations = await service.scanCSSFile('/nonexistent/file.css');

      expect(animations).toHaveLength(0);
    });

    it('無効なCSSでもエラーをスローしない', async () => {
      const invalidCss = `
        @keyframes { from { } }  /* 名前なし */
        @keyframes validOne { from { opacity: 0; } to { opacity: 1; } }
      `;

      vi.mocked(fs.readFile).mockResolvedValue(invalidCss);

      const animations = await service.scanCSSFile('/path/to/invalid.css');

      // 有効なものだけ返す
      expect(animations.length).toBeGreaterThanOrEqual(1);
      expect(animations.find(a => a.name === 'validOne')).toBeDefined();
    });
  });
});
