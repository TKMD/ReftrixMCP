// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Element Visibility Detector Tests (TDD - RED Phase)
 *
 * スクロール時の要素出現/消失を輪郭検出ベースで検出するテスト
 *
 * @module @reftrix/webdesign-core/tests/services/element-visibility-detector
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  ElementVisibilityDetector,
  createElementVisibilityDetector,
  type ElementVisibilityDetectorOptions,
  type ElementVisibilityEvent,
  type ElementVisibilityResult,
  type FrameData,
  type BoundingBox,
} from '../../src/services/element-visibility-detector';

// =============================================================================
// テストフィクスチャ
// =============================================================================

/**
 * モック用のフレームデータを生成
 * 指定サイズのRGBAバッファを作成
 */
function createMockFrameData(
  width: number,
  height: number,
  index: number,
  fillColor: { r: number; g: number; b: number; a: number } = { r: 255, g: 255, b: 255, a: 255 }
): FrameData {
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    buffer[offset] = fillColor.r;     // R
    buffer[offset + 1] = fillColor.g; // G
    buffer[offset + 2] = fillColor.b; // B
    buffer[offset + 3] = fillColor.a; // A
  }
  return {
    buffer,
    width,
    height,
    index,
    path: `/tmp/frame-${String(index).padStart(4, '0')}.png`,
  };
}

/**
 * フレームに矩形要素を描画
 */
function drawRectOnFrame(
  frame: FrameData,
  rect: BoundingBox,
  color: { r: number; g: number; b: number; a: number }
): FrameData {
  const buffer = Buffer.from(frame.buffer);
  for (let y = rect.y; y < rect.y + rect.height && y < frame.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width && x < frame.width; x++) {
      const offset = (y * frame.width + x) * 4;
      buffer[offset] = color.r;
      buffer[offset + 1] = color.g;
      buffer[offset + 2] = color.b;
      buffer[offset + 3] = color.a;
    }
  }
  return { ...frame, buffer };
}

// =============================================================================
// ElementVisibilityDetector Unit Tests
// =============================================================================

describe('ElementVisibilityDetector', () => {
  let detector: ElementVisibilityDetector;

  beforeEach(() => {
    detector = createElementVisibilityDetector();
  });

  // ===========================================================================
  // 初期化テスト
  // ===========================================================================

  describe('initialization', () => {
    test('should create instance with default options', () => {
      expect(detector).toBeDefined();
      expect(detector).toBeInstanceOf(ElementVisibilityDetector);
    });

    test('should create instance with custom options', () => {
      const customDetector = createElementVisibilityDetector({
        minElementSize: 50,
        edgeDetectionThreshold: 0.2,
        minContrastRatio: 0.15,
      });
      expect(customDetector).toBeInstanceOf(ElementVisibilityDetector);
    });

    test('should validate options - minElementSize must be positive', () => {
      expect(() => createElementVisibilityDetector({ minElementSize: 0 })).toThrow();
      expect(() => createElementVisibilityDetector({ minElementSize: -1 })).toThrow();
    });

    test('should validate options - edgeDetectionThreshold must be 0-1', () => {
      expect(() => createElementVisibilityDetector({ edgeDetectionThreshold: -0.1 })).toThrow();
      expect(() => createElementVisibilityDetector({ edgeDetectionThreshold: 1.5 })).toThrow();
    });

    test('should validate options - minContrastRatio must be 0-1', () => {
      expect(() => createElementVisibilityDetector({ minContrastRatio: -0.1 })).toThrow();
      expect(() => createElementVisibilityDetector({ minContrastRatio: 1.5 })).toThrow();
    });
  });

  // ===========================================================================
  // 要素出現検出テスト
  // ===========================================================================

  describe('element appearance detection', () => {
    test('should detect element appearing in frame sequence', async () => {
      // フレーム0: 空白
      const frame0 = createMockFrameData(100, 100, 0);

      // フレーム1: 矩形要素が出現
      const frame1 = drawRectOnFrame(
        createMockFrameData(100, 100, 1),
        { x: 20, y: 20, width: 30, height: 30 },
        { r: 0, g: 0, b: 255, a: 255 }
      );

      const result = await detector.detect([frame0, frame1]);

      expect(result.success).toBe(true);
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events.some(e => e.eventType === 'appear')).toBe(true);
      expect(result.appearanceCount).toBe(1);
    });

    test('should detect multiple elements appearing', async () => {
      const frame0 = createMockFrameData(200, 200, 0);

      // 2つの矩形要素が出現
      let frame1 = createMockFrameData(200, 200, 1);
      frame1 = drawRectOnFrame(frame1, { x: 10, y: 10, width: 40, height: 40 }, { r: 255, g: 0, b: 0, a: 255 });
      frame1 = drawRectOnFrame(frame1, { x: 100, y: 100, width: 50, height: 50 }, { r: 0, g: 255, b: 0, a: 255 });

      const result = await detector.detect([frame0, frame1]);

      expect(result.success).toBe(true);
      expect(result.appearanceCount).toBe(2);
    });

    test('should provide bounding box for appeared element', async () => {
      const frame0 = createMockFrameData(100, 100, 0);
      const frame1 = drawRectOnFrame(
        createMockFrameData(100, 100, 1),
        { x: 25, y: 35, width: 40, height: 20 },
        { r: 0, g: 0, b: 0, a: 255 }
      );

      const result = await detector.detect([frame0, frame1]);
      const appearEvent = result.events.find(e => e.eventType === 'appear');

      expect(appearEvent).toBeDefined();
      expect(appearEvent?.region).toBeDefined();
      expect(appearEvent?.region.x).toBeGreaterThanOrEqual(20);
      expect(appearEvent?.region.y).toBeGreaterThanOrEqual(30);
    });

    test('should calculate element size correctly', async () => {
      const frame0 = createMockFrameData(100, 100, 0);
      const frame1 = drawRectOnFrame(
        createMockFrameData(100, 100, 1),
        { x: 10, y: 10, width: 30, height: 40 },
        { r: 100, g: 100, b: 100, a: 255 }
      );

      const result = await detector.detect([frame0, frame1]);
      const appearEvent = result.events.find(e => e.eventType === 'appear');

      expect(appearEvent?.elementSize).toBeGreaterThanOrEqual(30 * 40 * 0.8); // 80%許容
      expect(appearEvent?.elementSize).toBeLessThanOrEqual(30 * 40 * 1.2);    // 120%許容
    });
  });

  // ===========================================================================
  // 要素消失検出テスト
  // ===========================================================================

  describe('element disappearance detection', () => {
    test('should detect element disappearing from frame sequence', async () => {
      // フレーム0: 矩形要素が存在
      const frame0 = drawRectOnFrame(
        createMockFrameData(100, 100, 0),
        { x: 20, y: 20, width: 30, height: 30 },
        { r: 0, g: 0, b: 255, a: 255 }
      );

      // フレーム1: 空白（要素消失）
      const frame1 = createMockFrameData(100, 100, 1);

      const result = await detector.detect([frame0, frame1]);

      expect(result.success).toBe(true);
      expect(result.events.some(e => e.eventType === 'disappear')).toBe(true);
      expect(result.disappearanceCount).toBe(1);
    });

    test('should detect multiple elements disappearing', async () => {
      // フレーム0: 2つの矩形
      let frame0 = createMockFrameData(200, 200, 0);
      frame0 = drawRectOnFrame(frame0, { x: 10, y: 10, width: 40, height: 40 }, { r: 255, g: 0, b: 0, a: 255 });
      frame0 = drawRectOnFrame(frame0, { x: 100, y: 100, width: 50, height: 50 }, { r: 0, g: 255, b: 0, a: 255 });

      // フレーム1: 空白
      const frame1 = createMockFrameData(200, 200, 1);

      const result = await detector.detect([frame0, frame1]);

      expect(result.success).toBe(true);
      expect(result.disappearanceCount).toBe(2);
    });

    test('should provide frame index for disappearance event', async () => {
      const frame0 = drawRectOnFrame(
        createMockFrameData(100, 100, 0),
        { x: 10, y: 10, width: 20, height: 20 },
        { r: 50, g: 50, b: 50, a: 255 }
      );
      const frame1 = createMockFrameData(100, 100, 1);

      const result = await detector.detect([frame0, frame1]);
      const disappearEvent = result.events.find(e => e.eventType === 'disappear');

      expect(disappearEvent?.frameIndex).toBe(1);
    });
  });

  // ===========================================================================
  // 輪郭検出アルゴリズムテスト
  // ===========================================================================

  describe('edge detection algorithm', () => {
    test('should detect edges with high contrast', async () => {
      // 黒背景に白い矩形
      const frame0 = createMockFrameData(100, 100, 0, { r: 0, g: 0, b: 0, a: 255 });
      const frame1 = drawRectOnFrame(
        createMockFrameData(100, 100, 1, { r: 0, g: 0, b: 0, a: 255 }),
        { x: 30, y: 30, width: 40, height: 40 },
        { r: 255, g: 255, b: 255, a: 255 }
      );

      const result = await detector.detect([frame0, frame1]);

      expect(result.success).toBe(true);
      expect(result.events.length).toBeGreaterThan(0);
    });

    test('should not detect elements below minElementSize threshold', async () => {
      const customDetector = createElementVisibilityDetector({ minElementSize: 500 });

      const frame0 = createMockFrameData(100, 100, 0);
      // 小さな要素（20x20 = 400px < 500px threshold）
      const frame1 = drawRectOnFrame(
        createMockFrameData(100, 100, 1),
        { x: 40, y: 40, width: 20, height: 20 },
        { r: 0, g: 0, b: 0, a: 255 }
      );

      const result = await customDetector.detect([frame0, frame1]);

      expect(result.events.length).toBe(0);
      expect(result.appearanceCount).toBe(0);
    });

    test('should not detect elements with low contrast below threshold', async () => {
      const customDetector = createElementVisibilityDetector({ minContrastRatio: 0.5 });

      // 低コントラスト: 白背景に薄いグレー
      const frame0 = createMockFrameData(100, 100, 0, { r: 255, g: 255, b: 255, a: 255 });
      const frame1 = drawRectOnFrame(
        createMockFrameData(100, 100, 1, { r: 255, g: 255, b: 255, a: 255 }),
        { x: 30, y: 30, width: 40, height: 40 },
        { r: 230, g: 230, b: 230, a: 255 } // 低コントラスト
      );

      const result = await customDetector.detect([frame0, frame1]);

      // 低コントラストの場合、検出されないか検出数が少ない
      expect(result.events.length).toBeLessThanOrEqual(1);
    });

    test('should use Sobel operator for edge detection', async () => {
      const frame0 = createMockFrameData(100, 100, 0);
      const frame1 = drawRectOnFrame(
        createMockFrameData(100, 100, 1),
        { x: 20, y: 20, width: 60, height: 60 },
        { r: 100, g: 100, b: 100, a: 255 }
      );

      // Sobel演算子を使用した検出結果を検証
      const result = await detector.detect([frame0, frame1]);

      expect(result.success).toBe(true);
      // Sobel演算子により矩形のエッジが検出される
      expect(result.events.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // 連続フレーム処理テスト
  // ===========================================================================

  describe('sequential frame processing', () => {
    test('should process multiple frame pairs', async () => {
      const frames: FrameData[] = [];

      // フレーム0: 空白
      frames.push(createMockFrameData(100, 100, 0));

      // フレーム1: 要素出現
      frames.push(drawRectOnFrame(
        createMockFrameData(100, 100, 1),
        { x: 10, y: 10, width: 30, height: 30 },
        { r: 255, g: 0, b: 0, a: 255 }
      ));

      // フレーム2: 要素が移動（同じ場所にある）
      frames.push(drawRectOnFrame(
        createMockFrameData(100, 100, 2),
        { x: 10, y: 10, width: 30, height: 30 },
        { r: 255, g: 0, b: 0, a: 255 }
      ));

      // フレーム3: 要素消失
      frames.push(createMockFrameData(100, 100, 3));

      const result = await detector.detect(frames);

      expect(result.success).toBe(true);
      expect(result.appearanceCount).toBe(1);
      expect(result.disappearanceCount).toBe(1);
    });

    test('should track element across frames', async () => {
      const frames: FrameData[] = [];

      // 5フレームのシーケンス
      for (let i = 0; i < 5; i++) {
        if (i >= 1 && i <= 3) {
          // フレーム1-3: 要素あり
          frames.push(drawRectOnFrame(
            createMockFrameData(100, 100, i),
            { x: 20, y: 20, width: 40, height: 40 },
            { r: 0, g: 100, b: 200, a: 255 }
          ));
        } else {
          // フレーム0, 4: 空白
          frames.push(createMockFrameData(100, 100, i));
        }
      }

      const result = await detector.detect(frames);

      expect(result.success).toBe(true);
      expect(result.appearanceCount).toBe(1);
      expect(result.disappearanceCount).toBe(1);

      // 出現はフレーム1で発生
      const appearEvent = result.events.find(e => e.eventType === 'appear');
      expect(appearEvent?.frameIndex).toBe(1);

      // 消失はフレーム4で発生
      const disappearEvent = result.events.find(e => e.eventType === 'disappear');
      expect(disappearEvent?.frameIndex).toBe(4);
    });
  });

  // ===========================================================================
  // エラーハンドリングテスト
  // ===========================================================================

  describe('error handling', () => {
    test('should handle empty frame array', async () => {
      const result = await detector.detect([]);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('ELEMENT_VISIBILITY_NO_FRAMES');
    });

    test('should handle single frame', async () => {
      const frame = createMockFrameData(100, 100, 0);
      const result = await detector.detect([frame]);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ELEMENT_VISIBILITY_INSUFFICIENT_FRAMES');
    });

    test('should handle dimension mismatch', async () => {
      const frame0 = createMockFrameData(100, 100, 0);
      const frame1 = createMockFrameData(200, 200, 1);

      const result = await detector.detect([frame0, frame1]);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ELEMENT_VISIBILITY_DIMENSION_MISMATCH');
    });

    test('should handle corrupted buffer', async () => {
      const frame0 = createMockFrameData(100, 100, 0);
      const corruptedFrame: FrameData = {
        buffer: Buffer.alloc(10), // サイズ不一致
        width: 100,
        height: 100,
        index: 1,
      };

      const result = await detector.detect([frame0, corruptedFrame]);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ELEMENT_VISIBILITY_BUFFER_MISMATCH');
    });
  });

  // ===========================================================================
  // パフォーマンステスト
  // ===========================================================================

  describe('performance', () => {
    test('should complete within time limit for 100x100 frames', async () => {
      const frame0 = createMockFrameData(100, 100, 0);
      const frame1 = drawRectOnFrame(
        createMockFrameData(100, 100, 1),
        { x: 20, y: 20, width: 40, height: 40 },
        { r: 128, g: 128, b: 128, a: 255 }
      );

      const startTime = performance.now();
      await detector.detect([frame0, frame1]);
      const elapsedTime = performance.now() - startTime;

      // 100x100フレームペアは100ms以内に完了すべき
      expect(elapsedTime).toBeLessThan(100);
    });

    test('should process 10 frames under 500ms', async () => {
      const frames: FrameData[] = [];
      for (let i = 0; i < 10; i++) {
        if (i % 2 === 0) {
          frames.push(createMockFrameData(200, 200, i));
        } else {
          frames.push(drawRectOnFrame(
            createMockFrameData(200, 200, i),
            { x: 50, y: 50, width: 100, height: 100 },
            { r: i * 25, g: 128, b: 255 - i * 25, a: 255 }
          ));
        }
      }

      const startTime = performance.now();
      const result = await detector.detect(frames);
      const elapsedTime = performance.now() - startTime;

      expect(result.success).toBe(true);
      expect(elapsedTime).toBeLessThan(500);
    });
  });

  // ===========================================================================
  // 結果フォーマットテスト
  // ===========================================================================

  describe('result format', () => {
    test('should return correct result structure', async () => {
      const frame0 = createMockFrameData(100, 100, 0);
      const frame1 = drawRectOnFrame(
        createMockFrameData(100, 100, 1),
        { x: 20, y: 20, width: 30, height: 30 },
        { r: 100, g: 150, b: 200, a: 255 }
      );

      const result = await detector.detect([frame0, frame1]);

      // 基本構造の検証
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('events');
      expect(result).toHaveProperty('appearanceCount');
      expect(result).toHaveProperty('disappearanceCount');
      expect(Array.isArray(result.events)).toBe(true);
    });

    test('should include all event properties', async () => {
      const frame0 = createMockFrameData(100, 100, 0);
      const frame1 = drawRectOnFrame(
        createMockFrameData(100, 100, 1),
        { x: 20, y: 20, width: 40, height: 40 },
        { r: 50, g: 100, b: 150, a: 255 }
      );

      const result = await detector.detect([frame0, frame1]);
      const event = result.events[0];

      expect(event).toHaveProperty('frameIndex');
      expect(event).toHaveProperty('eventType');
      expect(event).toHaveProperty('region');
      expect(event).toHaveProperty('elementSize');

      expect(event?.region).toHaveProperty('x');
      expect(event?.region).toHaveProperty('y');
      expect(event?.region).toHaveProperty('width');
      expect(event?.region).toHaveProperty('height');
    });
  });
});

// =============================================================================
// 統合テスト
// =============================================================================

describe('ElementVisibilityDetector Integration', () => {
  test('should integrate with FrameImageAnalysisService types', async () => {
    const detector = createElementVisibilityDetector();

    // FrameDataインターフェースとの互換性確認
    const frameData: FrameData = {
      buffer: Buffer.alloc(100 * 100 * 4),
      width: 100,
      height: 100,
      index: 0,
      path: '/tmp/test-frame.png',
    };

    // 互換性のあるFrameDataで呼び出し可能
    const result = await detector.detect([frameData, frameData]);

    // ElementVisibilityResultの形式を返す
    expect(result).toMatchObject({
      success: expect.any(Boolean),
      events: expect.any(Array),
      appearanceCount: expect.any(Number),
      disappearanceCount: expect.any(Number),
    });
  });
});
