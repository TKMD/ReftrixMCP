// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS Analysis Cache Service テスト
 *
 * layout.inspect/motion.detect の CSS解析結果をキャッシュするサービス。
 * URLハッシュまたはコンテンツハッシュをキーとしてPersistentCacheに保存。
 *
 * 目的:
 * - 同一URL/HTMLの再解析を防止（コスト削減）
 * - キャッシュヒット率の監視
 * - system.health への統合報告
 *
 * @module tests/services/css-analysis-cache.test
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  CSSAnalysisCacheService,
  createCSSAnalysisCacheService,
  type CSSAnalysisResult,
  type MotionAnalysisResult,
  type CSSAnalysisCacheStats,
  type ICSSAnalysisCacheService,
} from '../../src/services/css-analysis-cache.service';

// ============================================================
// テストスイート
// ============================================================

// ============================================================
// テストユーティリティ
// ============================================================

/**
 * テスト用の一時ディレクトリを作成
 */
async function createTempCacheDir(): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `reftrix-css-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * テスト用ディレクトリをクリーンアップ
 */
async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('CSS Analysis Cache Service', () => {
  let tempCacheDir: string;

  beforeEach(async () => {
    tempCacheDir = await createTempCacheDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempCacheDir);
  });

  describe('キャッシュキー生成', () => {
    let service: ICSSAnalysisCacheService;

    beforeEach(() => {
      service = createCSSAnalysisCacheService({
        cacheDir: tempCacheDir,
        maxSize: 100,
        defaultTtlMs: 3600000,
        enableLogging: false,
      });
    });

    afterEach(async () => {
      await service.close();
    });

    it('URLからSHA-256ハッシュキーを生成できること', async () => {
      const key = service.generateCacheKey({ url: 'https://example.com/page' });

      // SHA-256は64文字の16進数文字列
      expect(key).toMatch(/^url:[a-f0-9]{64}$/);
    });

    it('HTMLコンテンツからSHA-256ハッシュキーを生成できること', async () => {
      const key = service.generateCacheKey({ html: '<html><body>Test</body></html>' });

      expect(key).toMatch(/^html:[a-f0-9]{64}$/);
    });

    it('同一URLは同一キーを生成すること', async () => {
      const key1 = service.generateCacheKey({ url: 'https://example.com/page' });
      const key2 = service.generateCacheKey({ url: 'https://example.com/page' });

      expect(key1).toBe(key2);
    });

    it('異なるURLは異なるキーを生成すること', async () => {
      const key1 = service.generateCacheKey({ url: 'https://example.com/page1' });
      const key2 = service.generateCacheKey({ url: 'https://example.com/page2' });

      expect(key1).not.toBe(key2);
    });

    it('同一HTMLは同一キーを生成すること', async () => {
      const html = '<html><body>Test Content</body></html>';
      const key1 = service.generateCacheKey({ html });
      const key2 = service.generateCacheKey({ html });

      expect(key1).toBe(key2);
    });

    it('異なるHTMLは異なるキーを生成すること', async () => {
      const key1 = service.generateCacheKey({ html: '<html><body>Test 1</body></html>' });
      const key2 = service.generateCacheKey({ html: '<html><body>Test 2</body></html>' });

      expect(key1).not.toBe(key2);
    });

    it('文字列入力はHTMLとして扱うこと', async () => {
      const html = '<html><body>Direct string</body></html>';
      const key1 = service.generateCacheKey(html);
      const key2 = service.generateCacheKey({ html });

      expect(key1).toBe(key2);
    });

    it('空のURLでエラーをスローすること', async () => {
      expect(() => service.generateCacheKey({ url: '' })).toThrow('URL must be a non-empty string');
    });

    it('空のHTMLでエラーをスローすること', async () => {
      expect(() => service.generateCacheKey({ html: '' })).toThrow('HTML must be a non-empty string');
    });

    it('URLとHTMLの両方が指定された場合はURLを優先すること', async () => {
      const urlKey = service.generateCacheKey({ url: 'https://example.com' });
      const mixedKey = service.generateCacheKey({
        url: 'https://example.com',
        html: '<html></html>'
      });

      expect(mixedKey).toBe(urlKey);
    });
  });

  describe('layout.inspect キャッシュ', () => {
    let service: ICSSAnalysisCacheService;

    beforeEach(() => {
      service = createCSSAnalysisCacheService({
        cacheDir: tempCacheDir,
        maxSize: 100,
        defaultTtlMs: 3600000,
        enableLogging: false,
      });
    });

    afterEach(async () => {
      await service.close();
    });

    it('解析結果を保存して取得できること', async () => {
      const key = 'url:abc123';
      const result: CSSAnalysisResult = {
        colors: { palette: ['#fff', '#000'], dominant: '#fff' },
        typography: { fonts: ['Arial', 'sans-serif'], baseSize: '16px' },
        grid: { type: 'flex', columns: 3 },
        sections: [{ type: 'hero', confidence: 0.9 }],
        analyzedAt: Date.now(),
        cacheKey: key,
      };

      await service.setLayoutInspectResult(key, result);
      const cached = await service.getLayoutInspectResult(key);

      expect(cached).toEqual(result);
    });

    it('存在しないキーでnullを返すこと', async () => {
      const result = await service.getLayoutInspectResult('nonexistent-key');
      expect(result).toBeNull();
    });

    it('カスタムTTLを指定できること', async () => {
      vi.useFakeTimers();

      const key = 'url:ttl-test';
      const result: CSSAnalysisResult = {
        colors: { palette: [] },
        typography: { fonts: [] },
        grid: { type: 'none' },
        sections: [],
        analyzedAt: Date.now(),
        cacheKey: key,
      };

      await service.setLayoutInspectResult(key, result, 5000); // 5秒TTL

      // 3秒後は取得可能
      vi.advanceTimersByTime(3000);
      expect(await service.getLayoutInspectResult(key)).toEqual(result);

      // 6秒後は期限切れ
      vi.advanceTimersByTime(3000);
      expect(await service.getLayoutInspectResult(key)).toBeNull();

      vi.useRealTimers();
    });

    it('同じキーで上書きできること', async () => {
      const key = 'url:update-test';
      const result1: CSSAnalysisResult = {
        colors: { palette: ['#fff'] },
        typography: { fonts: [] },
        grid: { type: 'none' },
        sections: [],
        analyzedAt: Date.now(),
        cacheKey: key,
      };
      const result2: CSSAnalysisResult = {
        colors: { palette: ['#000', '#fff'] },
        typography: { fonts: ['Arial'] },
        grid: { type: 'grid', columns: 2 },
        sections: [{ type: 'hero', confidence: 0.95 }],
        analyzedAt: Date.now() + 1000,
        cacheKey: key,
      };

      await service.setLayoutInspectResult(key, result1);
      await service.setLayoutInspectResult(key, result2);

      const cached = await service.getLayoutInspectResult(key);
      expect(cached).toEqual(result2);
    });
  });

  describe('motion.detect キャッシュ', () => {
    let service: ICSSAnalysisCacheService;

    beforeEach(() => {
      service = createCSSAnalysisCacheService({
        cacheDir: tempCacheDir,
        maxSize: 100,
        defaultTtlMs: 3600000,
        enableLogging: false,
      });
    });

    afterEach(async () => {
      await service.close();
    });

    it('解析結果を保存して取得できること', async () => {
      const key = 'url:motion-test';
      const result: MotionAnalysisResult = {
        patterns: [
          { type: 'animation', name: 'fadeIn', duration: 300, easing: 'ease-in-out' },
          { type: 'transition', name: 'hover-scale', duration: 200 },
        ],
        summary: {
          totalPatterns: 2,
          hasAnimations: true,
          hasTransitions: true,
        },
        analyzedAt: Date.now(),
        cacheKey: key,
      };

      await service.setMotionDetectResult(key, result);
      const cached = await service.getMotionDetectResult(key);

      expect(cached).toEqual(result);
    });

    it('存在しないキーでnullを返すこと', async () => {
      const result = await service.getMotionDetectResult('nonexistent-key');
      expect(result).toBeNull();
    });

    it('layout.inspectとmotion.detectのキャッシュは独立していること', async () => {
      const key = 'shared-key';

      const layoutResult: CSSAnalysisResult = {
        colors: { palette: ['#fff'] },
        typography: { fonts: [] },
        grid: { type: 'none' },
        sections: [],
        analyzedAt: Date.now(),
        cacheKey: key,
      };

      const motionResult: MotionAnalysisResult = {
        patterns: [{ type: 'animation', name: 'test' }],
        summary: { totalPatterns: 1, hasAnimations: true, hasTransitions: false },
        analyzedAt: Date.now(),
        cacheKey: key,
      };

      await service.setLayoutInspectResult(key, layoutResult);
      await service.setMotionDetectResult(key, motionResult);

      // 両方が独立して取得できること
      expect(await service.getLayoutInspectResult(key)).toEqual(layoutResult);
      expect(await service.getMotionDetectResult(key)).toEqual(motionResult);
    });
  });

  describe('キャッシュ無効化', () => {
    let service: ICSSAnalysisCacheService;

    beforeEach(() => {
      service = createCSSAnalysisCacheService({
        cacheDir: tempCacheDir,
        maxSize: 100,
        defaultTtlMs: 3600000,
        enableLogging: false,
      });
    });

    afterEach(async () => {
      await service.close();
    });

    it('invalidate()で指定キーのキャッシュを削除できること', async () => {
      const key = 'url:invalidate-test';
      const layoutResult: CSSAnalysisResult = {
        colors: { palette: [] },
        typography: { fonts: [] },
        grid: { type: 'none' },
        sections: [],
        analyzedAt: Date.now(),
        cacheKey: key,
      };
      const motionResult: MotionAnalysisResult = {
        patterns: [],
        summary: { totalPatterns: 0, hasAnimations: false, hasTransitions: false },
        analyzedAt: Date.now(),
        cacheKey: key,
      };

      await service.setLayoutInspectResult(key, layoutResult);
      await service.setMotionDetectResult(key, motionResult);

      // キーを無効化
      const deleted = await service.invalidate(key);
      expect(deleted).toBe(true);

      // 両方のキャッシュが削除されていること
      expect(await service.getLayoutInspectResult(key)).toBeNull();
      expect(await service.getMotionDetectResult(key)).toBeNull();
    });

    it('存在しないキーの無効化でfalseを返すこと', async () => {
      const deleted = await service.invalidate('nonexistent-key');
      expect(deleted).toBe(false);
    });

    it('clear()で全キャッシュを削除できること', async () => {
      const keys = ['key1', 'key2', 'key3'];

      for (const key of keys) {
        await service.setLayoutInspectResult(key, {
          colors: { palette: [] },
          typography: { fonts: [] },
          grid: { type: 'none' },
          sections: [],
          analyzedAt: Date.now(),
          cacheKey: key,
        });
      }

      await service.clear();

      for (const key of keys) {
        expect(await service.getLayoutInspectResult(key)).toBeNull();
      }
    });
  });

  describe('統計情報', () => {
    let service: ICSSAnalysisCacheService;

    beforeEach(() => {
      service = createCSSAnalysisCacheService({
        cacheDir: tempCacheDir,
        maxSize: 100,
        defaultTtlMs: 3600000,
        enableLogging: false,
      });
    });

    afterEach(async () => {
      await service.close();
    });

    it('getStats()でキャッシュ統計を取得できること', async () => {
      const stats = await service.getStats();

      expect(stats).toHaveProperty('layoutInspect');
      expect(stats).toHaveProperty('motionDetect');
      expect(stats).toHaveProperty('totalHits');
      expect(stats).toHaveProperty('totalMisses');
      expect(stats).toHaveProperty('totalHitRate');
      expect(stats).toHaveProperty('totalSize');
      expect(stats).toHaveProperty('maxSize');
      expect(stats).toHaveProperty('diskUsageBytes');
    });

    it('ヒット率が正しく計算されること', async () => {
      const key = 'url:stats-test';
      const result: CSSAnalysisResult = {
        colors: { palette: [] },
        typography: { fonts: [] },
        grid: { type: 'none' },
        sections: [],
        analyzedAt: Date.now(),
        cacheKey: key,
      };

      await service.setLayoutInspectResult(key, result);

      // 2 hits, 1 miss
      await service.getLayoutInspectResult(key); // hit
      await service.getLayoutInspectResult(key); // hit
      await service.getLayoutInspectResult('nonexistent'); // miss

      const stats = await service.getStats();
      expect(stats.layoutInspect.hits).toBe(2);
      expect(stats.layoutInspect.misses).toBe(1);
      expect(stats.layoutInspect.hitRate).toBeCloseTo(2 / 3, 2);
    });

    it('layout.inspectとmotion.detectの統計が独立していること', async () => {
      const layoutKey = 'url:layout';
      const motionKey = 'url:motion';

      await service.setLayoutInspectResult(layoutKey, {
        colors: { palette: [] },
        typography: { fonts: [] },
        grid: { type: 'none' },
        sections: [],
        analyzedAt: Date.now(),
        cacheKey: layoutKey,
      });

      await service.setMotionDetectResult(motionKey, {
        patterns: [],
        summary: { totalPatterns: 0, hasAnimations: false, hasTransitions: false },
        analyzedAt: Date.now(),
        cacheKey: motionKey,
      });

      await service.getLayoutInspectResult(layoutKey); // layout hit
      await service.getMotionDetectResult(motionKey); // motion hit
      await service.getLayoutInspectResult('missing'); // layout miss

      const stats = await service.getStats();

      expect(stats.layoutInspect.hits).toBe(1);
      expect(stats.layoutInspect.misses).toBe(1);
      expect(stats.motionDetect.hits).toBe(1);
      expect(stats.motionDetect.misses).toBe(0);

      // 合計
      expect(stats.totalHits).toBe(2);
      expect(stats.totalMisses).toBe(1);
    });

    it('totalSizeが正しくカウントされること', async () => {
      expect((await service.getStats()).totalSize).toBe(0);

      await service.setLayoutInspectResult('key1', {
        colors: { palette: [] },
        typography: { fonts: [] },
        grid: { type: 'none' },
        sections: [],
        analyzedAt: Date.now(),
        cacheKey: 'key1',
      });
      expect((await service.getStats()).totalSize).toBe(1);

      await service.setMotionDetectResult('key2', {
        patterns: [],
        summary: { totalPatterns: 0, hasAnimations: false, hasTransitions: false },
        analyzedAt: Date.now(),
        cacheKey: 'key2',
      });
      expect((await service.getStats()).totalSize).toBe(2);
    });
  });

  describe('system.health 統合', () => {
    it('CSS解析キャッシュ統計がsystem.healthフォーマットで取得できること', async () => {
      const service = createCSSAnalysisCacheService({
        cacheDir: tempCacheDir,
        maxSize: 100,
        defaultTtlMs: 3600000,
        enableLogging: false,
      });

      // テストデータ設定
      await service.setLayoutInspectResult('key1', {
        colors: { palette: [] },
        typography: { fonts: [] },
        grid: { type: 'none' },
        sections: [],
        analyzedAt: Date.now(),
        cacheKey: 'key1',
      });
      await service.getLayoutInspectResult('key1'); // hit

      const stats = await service.getStats();

      // system.health で報告する形式を確認
      const healthReport = {
        css_analysis_cache: {
          layout_inspect: {
            hits: stats.layoutInspect.hits,
            misses: stats.layoutInspect.misses,
            hit_rate: stats.layoutInspect.hitRate,
            size: stats.layoutInspect.size,
          },
          motion_detect: {
            hits: stats.motionDetect.hits,
            misses: stats.motionDetect.misses,
            hit_rate: stats.motionDetect.hitRate,
            size: stats.motionDetect.size,
          },
          total_size: stats.totalSize,
          max_size: stats.maxSize,
          disk_usage_bytes: stats.diskUsageBytes,
        },
      };

      expect(healthReport.css_analysis_cache.layout_inspect.hits).toBe(1);
      expect(healthReport.css_analysis_cache.total_size).toBe(1);

      await service.close();
    });
  });

  describe('エッジケース', () => {
    let service: ICSSAnalysisCacheService;

    beforeEach(() => {
      service = createCSSAnalysisCacheService({
        cacheDir: tempCacheDir,
        maxSize: 100,
        defaultTtlMs: 3600000,
        enableLogging: false,
      });
    });

    afterEach(async () => {
      await service.close();
    });

    it('非常に大きなHTML（1MB）でもキャッシュキーを生成できること', async () => {
      const largeHtml = '<html><body>' + 'a'.repeat(1024 * 1024) + '</body></html>';

      // エラーなくキーを生成できること
      const key = service.generateCacheKey({ html: largeHtml });
      expect(key).toMatch(/^html:[a-f0-9]{64}$/);
    });

    it('特殊文字を含むURLでもキャッシュキーを生成できること', async () => {
      const specialUrl = 'https://example.com/page?q=テスト&lang=日本語#section';

      const key = service.generateCacheKey({ url: specialUrl });
      expect(key).toMatch(/^url:[a-f0-9]{64}$/);
    });

    it('Unicode文字を含むHTMLでもキャッシュできること', async () => {
      const key = 'url:unicode-test';
      const result: CSSAnalysisResult = {
        colors: { palette: [] },
        typography: { fonts: ['メイリオ', 'ヒラギノ角ゴ'] },
        grid: { type: 'none' },
        sections: [{ type: 'ヒーロー', confidence: 0.8 }],
        analyzedAt: Date.now(),
        cacheKey: key,
      };

      await service.setLayoutInspectResult(key, result);
      const cached = await service.getLayoutInspectResult(key);

      expect(cached).toEqual(result);
      expect(cached?.typography.fonts).toContain('メイリオ');
    });
  });
});

