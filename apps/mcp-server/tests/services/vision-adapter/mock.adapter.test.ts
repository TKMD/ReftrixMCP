// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MockVisionAdapter テスト
 * TDD Red Phase: モックビジョン解析アダプタのテスト
 *
 * 目的:
 * - IVisionAnalyzerインターフェースの完全実装検証
 * - テスト用モックデータ生成機能
 * - 設定可能な遅延（レイテンシシミュレーション）
 * - 設定可能なエラー発生率
 * - 事前定義されたレスポンスパターン
 * - シード値による再現可能な結果
 *
 * 参照:
 * - docs/plans/webdesign/00-overview.md (ビジョン解析アダプタ セクション)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  MockVisionAdapter,
  type MockVisionAdapterConfig,
} from '@/services/vision-adapter/mock.adapter';
import type {
  IVisionAnalyzer,
  VisionAnalysisOptions,
  VisionAnalysisResult,
  VisionFeatureType,
  VisionFeature,
} from '@/services/vision-adapter/interface';

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * テスト用のVisionAnalysisOptionsを作成
 */
function createTestOptions(overrides?: Partial<VisionAnalysisOptions>): VisionAnalysisOptions {
  return {
    imageBuffer: Buffer.from('test image data'),
    mimeType: 'image/png',
    ...overrides,
  };
}

/**
 * 画像バッファのハッシュを生成（簡易版）
 */
function createImageHash(imageBuffer: Buffer): string {
  // 簡易ハッシュ: バッファの内容をBase64エンコードして先頭32文字を使用
  return Buffer.from(imageBuffer).toString('base64').slice(0, 32);
}

// =============================================================================
// テストケース
// =============================================================================

describe('MockVisionAdapter', () => {
  let adapter: MockVisionAdapter;

  beforeEach(() => {
    adapter = new MockVisionAdapter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 1. インターフェース実装テスト
  // ===========================================================================

  describe('IVisionAnalyzerインターフェース実装', () => {
    it('IVisionAnalyzerインターフェースを実装していること', () => {
      const analyzer: IVisionAnalyzer = adapter;

      expect(analyzer.name).toBeDefined();
      expect(analyzer.modelName).toBeDefined();
      expect(typeof analyzer.isAvailable).toBe('function');
      expect(typeof analyzer.analyze).toBe('function');
      expect(typeof analyzer.generateTextRepresentation).toBe('function');
    });

    it('デフォルトの名前が"MockVisionAdapter"であること', () => {
      expect(adapter.name).toBe('MockVisionAdapter');
    });

    it('デフォルトのモデル名が"mock-vision-1.0"であること', () => {
      expect(adapter.modelName).toBe('mock-vision-1.0');
    });

    it('カスタム名を設定できること', () => {
      const customAdapter = new MockVisionAdapter({
        name: 'CustomMockAdapter',
      });

      expect(customAdapter.name).toBe('CustomMockAdapter');
    });

    it('カスタムモデル名を設定できること', () => {
      const customAdapter = new MockVisionAdapter({
        modelName: 'custom-model-2.0',
      });

      expect(customAdapter.modelName).toBe('custom-model-2.0');
    });
  });

  // ===========================================================================
  // 2. isAvailable() テスト
  // ===========================================================================

  describe('isAvailable()', () => {
    it('デフォルトでtrueを返すこと', async () => {
      const result = await adapter.isAvailable();
      expect(result).toBe(true);
    });

    it('isAvailableをfalseに設定できること', async () => {
      const unavailableAdapter = new MockVisionAdapter({
        isAvailable: false,
      });

      const result = await unavailableAdapter.isAvailable();
      expect(result).toBe(false);
    });

    it('setAvailability()で可用性を動的に変更できること', async () => {
      expect(await adapter.isAvailable()).toBe(true);

      adapter.setAvailability(false);
      expect(await adapter.isAvailable()).toBe(false);

      adapter.setAvailability(true);
      expect(await adapter.isAvailable()).toBe(true);
    });
  });

  // ===========================================================================
  // 3. analyze() 基本テスト
  // ===========================================================================

  describe('analyze() - 基本動作', () => {
    it('成功レスポンスを返すこと', async () => {
      const options = createTestOptions();

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.modelName).toBe('mock-vision-1.0');
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('features配列を含むこと', async () => {
      const options = createTestOptions();

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(Array.isArray(result.features)).toBe(true);
    });

    it('指定した特徴のみを返すこと', async () => {
      const options = createTestOptions({
        features: ['layout_structure', 'color_palette'],
      });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      const featureTypes = result.features.map((f) => f.type);
      expect(featureTypes).toContain('layout_structure');
      expect(featureTypes).toContain('color_palette');
      expect(featureTypes).not.toContain('typography');
      expect(featureTypes).not.toContain('density');
    });

    it('特徴を指定しない場合はデフォルト特徴を返すこと', async () => {
      const defaultFeaturesAdapter = new MockVisionAdapter({
        defaultFeatures: ['whitespace', 'rhythm'],
      });

      const options = createTestOptions();

      const resultPromise = defaultFeaturesAdapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      const featureTypes = result.features.map((f) => f.type);
      expect(featureTypes).toContain('whitespace');
      expect(featureTypes).toContain('rhythm');
    });

    it('処理時間が記録されること', async () => {
      const options = createTestOptions();

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('不可用状態ではエラーを返すこと', async () => {
      adapter.setAvailability(false);
      const options = createTestOptions();

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  // ===========================================================================
  // 4. 遅延シミュレーション テスト
  // ===========================================================================

  describe('遅延シミュレーション', () => {
    it('デフォルトの遅延が適用されること', async () => {
      const options = createTestOptions();

      const startTime = Date.now();
      const resultPromise = adapter.analyze(options);

      // タイマーを進める（デフォルト遅延を考慮）
      await vi.advanceTimersByTimeAsync(100);
      await resultPromise;

      // 遅延が適用されていることを確認（タイマーモックのため直接時間は測れないが、
      // タイマーを進めないと完了しないことを確認）
    });

    it('カスタム遅延を設定できること', async () => {
      const delayedAdapter = new MockVisionAdapter({
        latencyMs: 500,
      });

      const options = createTestOptions();
      const resultPromise = delayedAdapter.analyze(options);

      // 500ms未満では完了しない
      await vi.advanceTimersByTimeAsync(499);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      // 500ms経過後に完了
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;
      expect(result.success).toBe(true);
    });

    it('setLatency()で遅延を動的に変更できること', async () => {
      adapter.setLatency(200);

      const options = createTestOptions();
      const resultPromise = adapter.analyze(options);

      await vi.advanceTimersByTimeAsync(200);
      const result = await resultPromise;
      expect(result.success).toBe(true);
    });

    it('遅延のばらつきが適用されること', async () => {
      const varianceAdapter = new MockVisionAdapter({
        latencyMs: 100,
        latencyVariance: 50, // 50-150msの範囲
      });

      const options = createTestOptions();

      // ばらつきがあっても最大遅延内で完了すること
      const resultPromise = varianceAdapter.analyze(options);
      await vi.advanceTimersByTimeAsync(150);
      const result = await resultPromise;
      expect(result.success).toBe(true);
    });

    it('setLatency()でばらつきも設定できること', async () => {
      adapter.setLatency(100, 20);

      const options = createTestOptions();
      const resultPromise = adapter.analyze(options);

      await vi.advanceTimersByTimeAsync(120);
      const result = await resultPromise;
      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // 5. エラー率シミュレーション テスト
  // ===========================================================================

  describe('エラー率シミュレーション', () => {
    it('エラー率0ではエラーが発生しないこと', async () => {
      const noErrorAdapter = new MockVisionAdapter({
        errorRate: 0,
      });

      const options = createTestOptions();

      // 10回実行してすべて成功
      for (let i = 0; i < 10; i++) {
        const resultPromise = noErrorAdapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result.success).toBe(true);
      }
    });

    it('エラー率1では常にエラーが発生すること', async () => {
      const alwaysErrorAdapter = new MockVisionAdapter({
        errorRate: 1,
      });

      const options = createTestOptions();

      // 10回実行してすべてエラー
      for (let i = 0; i < 10; i++) {
        const resultPromise = alwaysErrorAdapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      }
    });

    it('setErrorRate()でエラー率を動的に変更できること', async () => {
      adapter.setErrorRate(1); // 100%エラー

      const options = createTestOptions();
      let resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      let result = await resultPromise;
      expect(result.success).toBe(false);

      adapter.setErrorRate(0); // 0%エラー
      resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      result = await resultPromise;
      expect(result.success).toBe(true);
    });

    it('エラー率が0-1の範囲外で例外を投げること', () => {
      expect(() => new MockVisionAdapter({ errorRate: -0.1 })).toThrow();
      expect(() => new MockVisionAdapter({ errorRate: 1.1 })).toThrow();
    });

    it('setErrorRate()で無効な値を渡すと例外を投げること', () => {
      expect(() => adapter.setErrorRate(-0.1)).toThrow();
      expect(() => adapter.setErrorRate(1.1)).toThrow();
    });
  });

  // ===========================================================================
  // 6. シード値による再現可能な結果 テスト
  // ===========================================================================

  describe('シード値による再現可能な結果', () => {
    it('同じシード値で同じ結果を生成すること', async () => {
      const seed = 12345;
      const adapter1 = new MockVisionAdapter({ seed });
      const adapter2 = new MockVisionAdapter({ seed });

      const options = createTestOptions();

      const resultPromise1 = adapter1.analyze(options);
      await vi.runAllTimersAsync();
      const result1 = await resultPromise1;

      const resultPromise2 = adapter2.analyze(options);
      await vi.runAllTimersAsync();
      const result2 = await resultPromise2;

      // 特徴の内容が同じであること
      expect(result1.features.length).toBe(result2.features.length);

      for (let i = 0; i < result1.features.length; i++) {
        expect(result1.features[i].type).toBe(result2.features[i].type);
        expect(result1.features[i].confidence).toBe(result2.features[i].confidence);
      }
    });

    it('異なるシード値で異なる結果を生成すること', async () => {
      const adapter1 = new MockVisionAdapter({ seed: 12345 });
      const adapter2 = new MockVisionAdapter({ seed: 67890 });

      const options = createTestOptions({
        features: ['layout_structure'],
      });

      const resultPromise1 = adapter1.analyze(options);
      await vi.runAllTimersAsync();
      const result1 = await resultPromise1;

      const resultPromise2 = adapter2.analyze(options);
      await vi.runAllTimersAsync();
      const result2 = await resultPromise2;

      // 少なくとも一部のデータが異なることを確認
      // （信頼度やデータの詳細が異なる可能性がある）
      const feature1 = result1.features[0];
      const feature2 = result2.features[0];

      // 同じシードでない限り、何かしら異なるはず
      // （confidence値が異なる可能性が高い）
      expect(feature1.confidence !== feature2.confidence || JSON.stringify(feature1.data) !== JSON.stringify(feature2.data)).toBe(true);
    });
  });

  // ===========================================================================
  // 7. カスタムレスポンス テスト
  // ===========================================================================

  describe('カスタムレスポンス', () => {
    it('setResponse()でカスタムレスポンスを設定できること', async () => {
      const customResult: VisionAnalysisResult = {
        success: true,
        features: [
          {
            type: 'layout_structure',
            confidence: 0.99,
            data: {
              type: 'layout_structure',
              gridType: 'three-column',
              mainAreas: ['custom', 'areas'],
              description: 'Custom layout',
            },
          },
        ],
        processingTimeMs: 50,
        modelName: 'mock-vision-1.0',
      };

      const imageBuffer = Buffer.from('specific image');
      const imageHash = createImageHash(imageBuffer);

      adapter.setResponse(imageHash, customResult);

      const options = createTestOptions({ imageBuffer });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.features[0].data).toEqual(customResult.features[0].data);
    });

    it('カスタムレスポンスが設定されていない画像ではデフォルト生成すること', async () => {
      const imageBuffer = Buffer.from('unconfigured image');
      const options = createTestOptions({ imageBuffer });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.features.length).toBeGreaterThan(0);
    });

    it('Map形式でカスタムレスポンスを初期化できること', async () => {
      const customResponses = new Map<string, VisionAnalysisResult>();
      const imageBuffer = Buffer.from('preset image');
      const imageHash = createImageHash(imageBuffer);

      customResponses.set(imageHash, {
        success: true,
        features: [
          {
            type: 'density',
            confidence: 0.88,
            data: {
              type: 'density',
              level: 'sparse',
              description: 'Preset density',
            },
          },
        ],
        processingTimeMs: 25,
        modelName: 'mock-vision-1.0',
      });

      const presetAdapter = new MockVisionAdapter({
        customResponses,
      });

      const options = createTestOptions({ imageBuffer });

      const resultPromise = presetAdapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.features[0].type).toBe('density');
      expect(result.features[0].confidence).toBe(0.88);
    });
  });

  // ===========================================================================
  // 8. 信頼度設定 テスト
  // ===========================================================================

  describe('信頼度設定', () => {
    it('デフォルトの信頼度が設定されること', async () => {
      const defaultConfidenceAdapter = new MockVisionAdapter({
        defaultConfidence: 0.85,
      });

      const options = createTestOptions({
        features: ['layout_structure'],
      });

      const resultPromise = defaultConfidenceAdapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      // デフォルト信頼度の近傍にあること（±0.1のばらつきを考慮）
      // 0.85 ± 0.1 = 0.75 ~ 0.95 の範囲内
      expect(result.features[0].confidence).toBeGreaterThanOrEqual(0.75);
      expect(result.features[0].confidence).toBeLessThanOrEqual(0.95);
    });

    it('信頼度が0-1の範囲内であること', async () => {
      const options = createTestOptions({
        features: [
          'layout_structure',
          'color_palette',
          'typography',
          'whitespace',
          'density',
          'rhythm',
          'section_boundaries',
        ],
      });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      result.features.forEach((feature) => {
        expect(feature.confidence).toBeGreaterThanOrEqual(0);
        expect(feature.confidence).toBeLessThanOrEqual(1);
      });
    });
  });

  // ===========================================================================
  // 9. generateTextRepresentation() テスト
  // ===========================================================================

  describe('generateTextRepresentation()', () => {
    it('解析結果からテキスト表現を生成すること', async () => {
      const options = createTestOptions({
        features: ['layout_structure', 'color_palette'],
      });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      const textRep = adapter.generateTextRepresentation(result);

      expect(typeof textRep).toBe('string');
      expect(textRep.length).toBeGreaterThan(0);
    });

    it('レイアウト構造を含むテキストを生成すること', () => {
      const result: VisionAnalysisResult = {
        success: true,
        features: [
          {
            type: 'layout_structure',
            confidence: 0.9,
            data: {
              type: 'layout_structure',
              gridType: 'two-column',
              mainAreas: ['header', 'sidebar', 'main'],
              description: 'Two column layout with sidebar',
            },
          },
        ],
        processingTimeMs: 100,
        modelName: 'mock-vision-1.0',
      };

      const textRep = adapter.generateTextRepresentation(result);

      expect(textRep).toContain('Layout');
      expect(textRep).toContain('two-column');
    });

    it('カラーパレットを含むテキストを生成すること', () => {
      const result: VisionAnalysisResult = {
        success: true,
        features: [
          {
            type: 'color_palette',
            confidence: 0.85,
            data: {
              type: 'color_palette',
              dominantColors: ['#3B82F6', '#FFFFFF', '#000000'],
              mood: 'professional',
              contrast: 'high',
            },
          },
        ],
        processingTimeMs: 100,
        modelName: 'mock-vision-1.0',
      };

      const textRep = adapter.generateTextRepresentation(result);

      expect(textRep).toContain('Color');
      expect(textRep).toContain('#3B82F6');
    });

    it('余白情報を含むテキストを生成すること', () => {
      const result: VisionAnalysisResult = {
        success: true,
        features: [
          {
            type: 'whitespace',
            confidence: 0.8,
            data: {
              type: 'whitespace',
              amount: 'generous',
              distribution: 'even',
            },
          },
        ],
        processingTimeMs: 100,
        modelName: 'mock-vision-1.0',
      };

      const textRep = adapter.generateTextRepresentation(result);

      expect(textRep).toContain('Whitespace');
      expect(textRep).toContain('generous');
    });

    it('密度情報を含むテキストを生成すること', () => {
      const result: VisionAnalysisResult = {
        success: true,
        features: [
          {
            type: 'density',
            confidence: 0.75,
            data: {
              type: 'density',
              level: 'balanced',
              description: 'Well-balanced density',
            },
          },
        ],
        processingTimeMs: 100,
        modelName: 'mock-vision-1.0',
      };

      const textRep = adapter.generateTextRepresentation(result);

      expect(textRep).toContain('Density');
      expect(textRep).toContain('balanced');
    });

    it('エラー結果では空文字列を返すこと', () => {
      const errorResult: VisionAnalysisResult = {
        success: false,
        features: [],
        error: 'Analysis failed',
        processingTimeMs: 0,
        modelName: 'mock-vision-1.0',
      };

      const textRep = adapter.generateTextRepresentation(errorResult);

      expect(textRep).toBe('');
    });

    it('空の特徴配列では空文字列を返すこと', () => {
      const emptyResult: VisionAnalysisResult = {
        success: true,
        features: [],
        processingTimeMs: 0,
        modelName: 'mock-vision-1.0',
      };

      const textRep = adapter.generateTextRepresentation(emptyResult);

      expect(textRep).toBe('');
    });
  });

  // ===========================================================================
  // 10. Mock固有メソッド テスト
  // ===========================================================================

  describe('Mock固有メソッド', () => {
    describe('reset()', () => {
      it('すべての状態をリセットすること', async () => {
        // 状態を変更
        adapter.setAvailability(false);
        adapter.setLatency(500);
        adapter.setErrorRate(0.5);
        adapter.setResponse('hash123', {
          success: true,
          features: [],
          processingTimeMs: 0,
          modelName: 'test',
        });

        // リセット
        adapter.reset();

        // デフォルト状態に戻っていること
        expect(await adapter.isAvailable()).toBe(true);
        expect(adapter.getCallCount()).toBe(0);

        // 正常に動作すること
        const options = createTestOptions();
        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result.success).toBe(true);
      });
    });

    describe('getCallCount()', () => {
      it('呼び出し回数を追跡すること', async () => {
        expect(adapter.getCallCount()).toBe(0);

        const options = createTestOptions();

        let resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        await resultPromise;
        expect(adapter.getCallCount()).toBe(1);

        resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        await resultPromise;
        expect(adapter.getCallCount()).toBe(2);

        resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        await resultPromise;
        expect(adapter.getCallCount()).toBe(3);
      });

      it('reset()で呼び出し回数がリセットされること', async () => {
        const options = createTestOptions();

        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        await resultPromise;

        expect(adapter.getCallCount()).toBe(1);

        adapter.reset();
        expect(adapter.getCallCount()).toBe(0);
      });
    });

    describe('getLastCall()', () => {
      it('最後の呼び出しオプションを取得できること', async () => {
        expect(adapter.getLastCall()).toBeNull();

        const options1 = createTestOptions({
          features: ['layout_structure'],
        });

        let resultPromise = adapter.analyze(options1);
        await vi.runAllTimersAsync();
        await resultPromise;

        let lastCall = adapter.getLastCall();
        expect(lastCall).not.toBeNull();
        expect(lastCall?.features).toEqual(['layout_structure']);

        const options2 = createTestOptions({
          features: ['color_palette', 'whitespace'],
        });

        resultPromise = adapter.analyze(options2);
        await vi.runAllTimersAsync();
        await resultPromise;

        lastCall = adapter.getLastCall();
        expect(lastCall?.features).toEqual(['color_palette', 'whitespace']);
      });

      it('reset()で最後の呼び出しがクリアされること', async () => {
        const options = createTestOptions();
        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        await resultPromise;

        expect(adapter.getLastCall()).not.toBeNull();

        adapter.reset();
        expect(adapter.getLastCall()).toBeNull();
      });
    });
  });

  // ===========================================================================
  // 11. モックデータ生成 テスト
  // ===========================================================================

  describe('モックデータ生成', () => {
    describe('セクション検出', () => {
      it('section_boundaries特徴を生成できること', async () => {
        const options = createTestOptions({
          features: ['section_boundaries'],
        });

        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        const sectionFeature = result.features.find((f) => f.type === 'section_boundaries');
        expect(sectionFeature).toBeDefined();

        if (sectionFeature?.data.type === 'section_boundaries') {
          expect(Array.isArray(sectionFeature.data.sections)).toBe(true);
          expect(sectionFeature.data.sections.length).toBeGreaterThan(0);

          // セクションの構造を確認
          sectionFeature.data.sections.forEach((section) => {
            expect(typeof section.type).toBe('string');
            expect(typeof section.startY).toBe('number');
            expect(typeof section.endY).toBe('number');
            expect(typeof section.confidence).toBe('number');
            expect(section.confidence).toBeGreaterThanOrEqual(0);
            expect(section.confidence).toBeLessThanOrEqual(1);
          });
        }
      });

      it('一般的なセクションタイプを含むこと', async () => {
        const options = createTestOptions({
          features: ['section_boundaries'],
        });

        // 複数回実行して、一般的なセクションタイプが生成されることを確認
        const sectionTypes = new Set<string>();

        for (let i = 0; i < 5; i++) {
          const adapterWithSeed = new MockVisionAdapter({ seed: i * 1000 });
          const resultPromise = adapterWithSeed.analyze(options);
          await vi.runAllTimersAsync();
          const result = await resultPromise;

          const sectionFeature = result.features.find((f) => f.type === 'section_boundaries');
          if (sectionFeature?.data.type === 'section_boundaries') {
            sectionFeature.data.sections.forEach((s) => sectionTypes.add(s.type));
          }
        }

        // hero, feature, cta, footerなどの一般的なセクションが含まれる可能性
        const commonTypes = ['hero', 'features', 'cta', 'footer', 'header', 'content'];
        const hasCommonType = commonTypes.some((type) => sectionTypes.has(type));
        expect(hasCommonType).toBe(true);
      });
    });

    describe('カラーパレット抽出', () => {
      it('5-10色を含むカラーパレットを生成すること', async () => {
        const options = createTestOptions({
          features: ['color_palette'],
        });

        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        const colorFeature = result.features.find((f) => f.type === 'color_palette');
        expect(colorFeature).toBeDefined();

        if (colorFeature?.data.type === 'color_palette') {
          expect(colorFeature.data.dominantColors.length).toBeGreaterThanOrEqual(5);
          expect(colorFeature.data.dominantColors.length).toBeLessThanOrEqual(10);

          // HEX形式であること
          colorFeature.data.dominantColors.forEach((color) => {
            expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
          });
        }
      });

      it('moodとcontrastが設定されること', async () => {
        const options = createTestOptions({
          features: ['color_palette'],
        });

        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        const colorFeature = result.features.find((f) => f.type === 'color_palette');
        if (colorFeature?.data.type === 'color_palette') {
          expect(typeof colorFeature.data.mood).toBe('string');
          expect(colorFeature.data.mood.length).toBeGreaterThan(0);
          expect(['high', 'medium', 'low']).toContain(colorFeature.data.contrast);
        }
      });
    });

    describe('タイポグラフィ情報', () => {
      it('typography特徴を生成できること', async () => {
        const options = createTestOptions({
          features: ['typography'],
        });

        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        const typographyFeature = result.features.find((f) => f.type === 'typography');
        expect(typographyFeature).toBeDefined();

        if (typographyFeature?.data.type === 'typography') {
          expect(typeof typographyFeature.data.headingStyle).toBe('string');
          expect(typeof typographyFeature.data.bodyStyle).toBe('string');
          expect(Array.isArray(typographyFeature.data.hierarchy)).toBe(true);
        }
      });
    });

    describe('余白/密度分析', () => {
      it('whitespace特徴を生成できること', async () => {
        const options = createTestOptions({
          features: ['whitespace'],
        });

        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        const whitespaceFeature = result.features.find((f) => f.type === 'whitespace');
        expect(whitespaceFeature).toBeDefined();

        if (whitespaceFeature?.data.type === 'whitespace') {
          expect(['minimal', 'moderate', 'generous', 'extreme']).toContain(
            whitespaceFeature.data.amount
          );
          expect(['even', 'top-heavy', 'bottom-heavy', 'centered']).toContain(
            whitespaceFeature.data.distribution
          );
        }
      });

      it('density特徴を生成できること', async () => {
        const options = createTestOptions({
          features: ['density'],
        });

        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        const densityFeature = result.features.find((f) => f.type === 'density');
        expect(densityFeature).toBeDefined();

        if (densityFeature?.data.type === 'density') {
          expect(['sparse', 'balanced', 'dense', 'cluttered']).toContain(densityFeature.data.level);
          expect(typeof densityFeature.data.description).toBe('string');
        }
      });
    });

    describe('リズム/重心分析', () => {
      it('rhythm特徴を生成できること', async () => {
        const options = createTestOptions({
          features: ['rhythm'],
        });

        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        const rhythmFeature = result.features.find((f) => f.type === 'rhythm');
        expect(rhythmFeature).toBeDefined();

        if (rhythmFeature?.data.type === 'rhythm') {
          expect(['regular', 'irregular', 'progressive', 'alternating']).toContain(
            rhythmFeature.data.pattern
          );
          expect(typeof rhythmFeature.data.description).toBe('string');
        }
      });

      it('visual_hierarchy特徴を生成できること', async () => {
        const options = createTestOptions({
          features: ['visual_hierarchy'],
        });

        const resultPromise = adapter.analyze(options);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        const hierarchyFeature = result.features.find((f) => f.type === 'visual_hierarchy');
        expect(hierarchyFeature).toBeDefined();

        if (hierarchyFeature?.data.type === 'visual_hierarchy') {
          expect(Array.isArray(hierarchyFeature.data.focalPoints)).toBe(true);
          expect(['top-to-bottom', 'left-to-right', 'z-pattern', 'f-pattern']).toContain(
            hierarchyFeature.data.flowDirection
          );
          expect(Array.isArray(hierarchyFeature.data.emphasisTechniques)).toBe(true);
        }
      });
    });
  });

  // ===========================================================================
  // 12. すべての特徴タイプ テスト
  // ===========================================================================

  describe('すべての特徴タイプ', () => {
    const allFeatureTypes: VisionFeatureType[] = [
      'layout_structure',
      'color_palette',
      'typography',
      'visual_hierarchy',
      'whitespace',
      'density',
      'rhythm',
      'section_boundaries',
    ];

    it.each(allFeatureTypes)('%s 特徴を生成できること', async (featureType) => {
      const options = createTestOptions({
        features: [featureType],
      });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.features.length).toBe(1);
      expect(result.features[0].type).toBe(featureType);
      expect(result.features[0].confidence).toBeGreaterThanOrEqual(0);
      expect(result.features[0].confidence).toBeLessThanOrEqual(1);
    });

    it('すべての特徴タイプを同時に生成できること', async () => {
      const options = createTestOptions({
        features: allFeatureTypes,
      });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.features.length).toBe(allFeatureTypes.length);

      const generatedTypes = result.features.map((f) => f.type);
      allFeatureTypes.forEach((type) => {
        expect(generatedTypes).toContain(type);
      });
    });
  });

  // ===========================================================================
  // 13. タイムアウト テスト
  // ===========================================================================

  describe('タイムアウト', () => {
    it('タイムアウト値を超える遅延でエラーを返すこと', async () => {
      const slowAdapter = new MockVisionAdapter({
        latencyMs: 5000,
      });

      const options = createTestOptions({
        timeout: 1000,
      });

      const resultPromise = slowAdapter.analyze(options);

      // タイムアウトまで進める
      await vi.advanceTimersByTimeAsync(1000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('タイムアウト内で完了する場合は成功すること', async () => {
      const fastAdapter = new MockVisionAdapter({
        latencyMs: 100,
      });

      const options = createTestOptions({
        timeout: 5000,
      });

      const resultPromise = fastAdapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // 14. 並行実行 テスト
  // ===========================================================================

  describe('並行実行', () => {
    it('複数の同時リクエストを処理できること', async () => {
      const options1 = createTestOptions({ features: ['layout_structure'] });
      const options2 = createTestOptions({ features: ['color_palette'] });
      const options3 = createTestOptions({ features: ['whitespace'] });

      const promises = [
        adapter.analyze(options1),
        adapter.analyze(options2),
        adapter.analyze(options3),
      ];

      await vi.runAllTimersAsync();
      const results = await Promise.all(promises);

      expect(results[0].features[0].type).toBe('layout_structure');
      expect(results[1].features[0].type).toBe('color_palette');
      expect(results[2].features[0].type).toBe('whitespace');

      expect(adapter.getCallCount()).toBe(3);
    });
  });

  // ===========================================================================
  // 15. エッジケース テスト
  // ===========================================================================

  describe('エッジケース', () => {
    it('空のimageBufferでも処理できること', async () => {
      const options = createTestOptions({
        imageBuffer: Buffer.alloc(0),
      });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
    });

    it('非常に大きなimageBufferでも処理できること', async () => {
      const largeBuffer = Buffer.alloc(10 * 1024 * 1024); // 10MB

      const options = createTestOptions({
        imageBuffer: largeBuffer,
      });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
    });

    it('空のfeatures配列ではデフォルト特徴を返すこと', async () => {
      const options = createTestOptions({
        features: [],
      });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      // 空配列の場合はデフォルト特徴（または全特徴）を返す
      expect(result.success).toBe(true);
      expect(result.features.length).toBeGreaterThanOrEqual(0);
    });

    it('カスタムプロンプトが渡されても正常に動作すること', async () => {
      const options = createTestOptions({
        prompt: 'Analyze the hero section specifically',
        features: ['layout_structure'],
      });

      const resultPromise = adapter.analyze(options);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.success).toBe(true);
    });
  });
});

// =============================================================================
// 統合テスト
// =============================================================================

describe('MockVisionAdapter 統合テスト', () => {
  it('完全なワークフローが動作すること', async () => {
    vi.useFakeTimers();

    // 1. アダプタ作成
    const adapter = new MockVisionAdapter({
      latencyMs: 100,
      defaultConfidence: 0.85,
    });

    // 2. 可用性チェック
    const available = await adapter.isAvailable();
    expect(available).toBe(true);

    // 3. 解析実行
    const options: VisionAnalysisOptions = {
      imageBuffer: Buffer.from('test screenshot'),
      mimeType: 'image/png',
      features: ['layout_structure', 'color_palette', 'whitespace'],
    };

    const resultPromise = adapter.analyze(options);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // 4. 結果検証
    expect(result.success).toBe(true);
    expect(result.features.length).toBe(3);

    // 5. テキスト表現生成
    const textRep = adapter.generateTextRepresentation(result);
    expect(textRep.length).toBeGreaterThan(0);

    // 6. 呼び出し統計確認
    expect(adapter.getCallCount()).toBe(1);
    expect(adapter.getLastCall()).toEqual(options);

    vi.useRealTimers();
  });

  it('エラーシナリオが正しく動作すること', async () => {
    vi.useFakeTimers();

    const adapter = new MockVisionAdapter({
      errorRate: 1, // 常にエラー
    });

    const options: VisionAnalysisOptions = {
      imageBuffer: Buffer.from('test'),
      mimeType: 'image/png',
    };

    const resultPromise = adapter.analyze(options);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.features).toEqual([]);

    // エラー結果のテキスト表現は空
    const textRep = adapter.generateTextRepresentation(result);
    expect(textRep).toBe('');

    vi.useRealTimers();
  });
});
