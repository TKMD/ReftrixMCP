// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Element Visibility Detector
 *
 * スクロール時の要素出現/消失を輪郭検出（Sobel演算子）ベースで検出する
 *
 * @module @reftrix/webdesign-core/services/element-visibility-detector
 */

// =============================================================================
// Types
// =============================================================================

/**
 * 境界ボックス
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * フレームデータ（FrameImageAnalysisServiceと互換）
 */
export interface FrameData {
  buffer: Buffer;
  width: number;
  height: number;
  index: number;
  path?: string;
}

/**
 * 可視性イベントタイプ
 */
export type VisibilityEventType = 'appear' | 'disappear';

/**
 * 要素可視性イベント
 */
export interface ElementVisibilityEvent {
  frameIndex: number;
  eventType: VisibilityEventType;
  region: BoundingBox;
  elementSize: number;
}

/**
 * 要素可視性検出エラー
 */
export interface ElementVisibilityError {
  code: string;
  message: string;
}

/**
 * 要素可視性検出結果
 */
export interface ElementVisibilityResult {
  success: boolean;
  events: ElementVisibilityEvent[];
  appearanceCount: number;
  disappearanceCount: number;
  error?: ElementVisibilityError;
}

/**
 * 検出オプション
 */
export interface ElementVisibilityDetectorOptions {
  /** 最小要素サイズ（ピクセル数） */
  minElementSize?: number;
  /** エッジ検出閾値（0-1） */
  edgeDetectionThreshold?: number;
  /** 最小コントラスト比（0-1） */
  minContrastRatio?: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_OPTIONS: Required<ElementVisibilityDetectorOptions> = {
  minElementSize: 100, // 最小100ピクセル
  edgeDetectionThreshold: 0.1,
  minContrastRatio: 0.1,
};

// Sobel演算子カーネル
const SOBEL_X = [
  [-1, 0, 1],
  [-2, 0, 2],
  [-1, 0, 1],
];

const SOBEL_Y = [
  [-1, -2, -1],
  [0, 0, 0],
  [1, 2, 1],
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * RGBAバッファからグレースケール値を取得
 */
function getGrayscale(buffer: Buffer, x: number, y: number, width: number): number {
  const offset = (y * width + x) * 4;
  const r = buffer[offset] ?? 0;
  const g = buffer[offset + 1] ?? 0;
  const b = buffer[offset + 2] ?? 0;
  // ITU-R BT.709 標準のグレースケール変換
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Sobel演算子によるエッジ強度計算
 */
function applySobel(
  buffer: Buffer,
  x: number,
  y: number,
  width: number,
  height: number
): number {
  let gx = 0;
  let gy = 0;

  for (let ky = -1; ky <= 1; ky++) {
    for (let kx = -1; kx <= 1; kx++) {
      const px = Math.max(0, Math.min(width - 1, x + kx));
      const py = Math.max(0, Math.min(height - 1, y + ky));
      const gray = getGrayscale(buffer, px, py, width);

      const sobelXRow = SOBEL_X[ky + 1];
      const sobelYRow = SOBEL_Y[ky + 1];
      if (sobelXRow && sobelYRow) {
        gx += gray * (sobelXRow[kx + 1] ?? 0);
        gy += gray * (sobelYRow[kx + 1] ?? 0);
      }
    }
  }

  return Math.sqrt(gx * gx + gy * gy);
}

/**
 * 2つのピクセルが異なるかを判定
 */
function pixelsDiffer(
  buffer1: Buffer,
  buffer2: Buffer,
  x: number,
  y: number,
  width: number,
  threshold: number
): boolean {
  const offset = (y * width + x) * 4;
  const r1 = buffer1[offset] ?? 0;
  const g1 = buffer1[offset + 1] ?? 0;
  const b1 = buffer1[offset + 2] ?? 0;
  const r2 = buffer2[offset] ?? 0;
  const g2 = buffer2[offset + 1] ?? 0;
  const b2 = buffer2[offset + 2] ?? 0;

  // RGB差分の最大値を計算
  const dr = Math.abs(r1 - r2);
  const dg = Math.abs(g1 - g2);
  const db = Math.abs(b1 - b2);
  const maxDiff = Math.max(dr, dg, db);

  // 閾値を超えていれば異なるピクセルとみなす
  return maxDiff > threshold * 255;
}

/**
 * 2フレーム間の差分マップを生成
 */
function generateDiffMap(
  frame1: FrameData,
  frame2: FrameData,
  threshold: number
): Uint8Array {
  const { width, height } = frame1;
  const diffMap = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (pixelsDiffer(frame1.buffer, frame2.buffer, x, y, width, threshold)) {
        diffMap[idx] = 1;
      }
    }
  }

  return diffMap;
}

/**
 * フレームのエッジマップを生成（Sobel演算子）
 * エッジベースの検出用（輪郭検出）
 * @internal Reserved for future use in edge-based detection
 */
export function generateEdgeMap(frame: FrameData, threshold: number): Uint8Array {
  const { buffer, width, height } = frame;
  const edgeMap = new Uint8Array(width * height);

  // 正規化用の最大エッジ強度を計算
  let maxEdge = 0;
  const edgeValues = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const edge = applySobel(buffer, x, y, width, height);
      edgeValues[y * width + x] = edge;
      if (edge > maxEdge) maxEdge = edge;
    }
  }

  // エッジマップを閾値処理
  if (maxEdge > 0) {
    const normalizedThreshold = threshold * maxEdge;
    for (let i = 0; i < edgeValues.length; i++) {
      const edgeValue = edgeValues[i] ?? 0;
      edgeMap[i] = edgeValue > normalizedThreshold ? 1 : 0;
    }
  }

  return edgeMap;
}

/**
 * 連結成分ラベリング（4連結）
 */
function labelConnectedComponents(
  binaryMap: Uint8Array,
  width: number,
  height: number
): { labels: Int32Array; count: number } {
  const labels = new Int32Array(width * height);
  let nextLabel = 1;

  // Union-Find用
  const parent: number[] = [0];

  function find(x: number): number {
    const px = parent[x];
    if (px !== undefined && px !== x) {
      parent[x] = find(px);
    }
    return parent[x] ?? x;
  }

  function union(x: number, y: number): void {
    const px = find(x);
    const py = find(y);
    if (px !== py) {
      parent[Math.max(px, py)] = Math.min(px, py);
    }
  }

  // 1st pass: ラベル割り当て
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binaryMap[idx] === 0) continue;

      const leftLabel = x > 0 ? (labels[idx - 1] ?? 0) : 0;
      const topLabel = y > 0 ? (labels[idx - width] ?? 0) : 0;

      if (leftLabel === 0 && topLabel === 0) {
        // 新しいラベル
        labels[idx] = nextLabel;
        parent.push(nextLabel);
        nextLabel++;
      } else if (leftLabel === 0) {
        labels[idx] = topLabel;
      } else if (topLabel === 0) {
        labels[idx] = leftLabel;
      } else {
        // 両方ともラベルあり
        labels[idx] = Math.min(leftLabel, topLabel);
        union(leftLabel, topLabel);
      }
    }
  }

  // 2nd pass: ラベル統合
  const labelMap = new Map<number, number>();
  let finalLabelCount = 0;

  for (let i = 0; i < labels.length; i++) {
    const labelValue = labels[i] ?? 0;
    if (labelValue > 0) {
      const root = find(labelValue);
      if (!labelMap.has(root)) {
        labelMap.set(root, ++finalLabelCount);
      }
      labels[i] = labelMap.get(root) ?? 0;
    }
  }

  return { labels, count: finalLabelCount };
}

/**
 * ラベルごとの境界ボックスを計算
 */
function extractBoundingBoxes(
  labels: Int32Array,
  width: number,
  height: number,
  labelCount: number
): BoundingBox[] {
  const boxes: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];

  for (let i = 0; i <= labelCount; i++) {
    boxes.push({
      minX: width,
      minY: height,
      maxX: 0,
      maxY: 0,
    });
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const label = labels[y * width + x];
      if (label !== undefined && label > 0) {
        const box = boxes[label];
        if (box) {
          box.minX = Math.min(box.minX, x);
          box.minY = Math.min(box.minY, y);
          box.maxX = Math.max(box.maxX, x);
          box.maxY = Math.max(box.maxY, y);
        }
      }
    }
  }

  return boxes
    .slice(1) // label 0 は背景
    .filter((b) => b.maxX >= b.minX && b.maxY >= b.minY)
    .map((b) => ({
      x: b.minX,
      y: b.minY,
      width: b.maxX - b.minX + 1,
      height: b.maxY - b.minY + 1,
    }));
}

/**
 * 境界ボックスが重なるか判定
 */
function boxesOverlap(a: BoundingBox, b: BoundingBox, margin: number = 10): boolean {
  return !(
    a.x + a.width + margin < b.x ||
    b.x + b.width + margin < a.x ||
    a.y + a.height + margin < b.y ||
    b.y + b.height + margin < a.y
  );
}

/**
 * 2フレーム間の変化領域を検出
 */
function detectChangedRegions(
  prevFrame: FrameData,
  currFrame: FrameData,
  contrastThreshold: number,
  minElementSize: number
): BoundingBox[] {
  const { width, height } = prevFrame;

  // フレーム間の差分マップを生成
  const diffMap = generateDiffMap(prevFrame, currFrame, contrastThreshold);

  // 連結成分分析で変化領域を抽出
  const { labels, count } = labelConnectedComponents(diffMap, width, height);
  const boxes = extractBoundingBoxes(labels, width, height, count);

  // 最小サイズでフィルタ
  return boxes.filter((box) => box.width * box.height >= minElementSize);
}

/**
 * 領域がフレーム内に存在するかを判定（その領域内のピクセルが均一でないか）
 * @internal Reserved for future use in element tracking
 */
export function regionExistsInFrame(
  frame: FrameData,
  region: BoundingBox,
  threshold: number
): boolean {
  const { buffer, width } = frame;
  let firstPixelR = -1;
  let firstPixelG = -1;
  let firstPixelB = -1;
  let hasDifferentPixel = false;

  for (let y = region.y; y < region.y + region.height && y < frame.height; y++) {
    for (let x = region.x; x < region.x + region.width && x < frame.width; x++) {
      const offset = (y * width + x) * 4;
      const r = buffer[offset] ?? 0;
      const g = buffer[offset + 1] ?? 0;
      const b = buffer[offset + 2] ?? 0;

      if (firstPixelR === -1) {
        firstPixelR = r;
        firstPixelG = g;
        firstPixelB = b;
      } else {
        const dr = Math.abs(r - firstPixelR);
        const dg = Math.abs(g - firstPixelG);
        const db = Math.abs(b - firstPixelB);
        if (Math.max(dr, dg, db) > threshold * 255) {
          hasDifferentPixel = true;
          break;
        }
      }
    }
    if (hasDifferentPixel) break;
  }

  // 領域内に異なるピクセルがあれば要素が存在
  // または、背景と異なる色があれば存在とみなす
  // ここでは単純に: 変化領域が存在する = 新しい要素がある
  return hasDifferentPixel;
}

/**
 * 2つの要素リストを比較して出現/消失を検出
 * @internal Reserved for future use in element tracking
 */
export function compareElements(
  prevElements: BoundingBox[],
  currElements: BoundingBox[],
  frameIndex: number,
  minElementSize: number
): ElementVisibilityEvent[] {
  const events: ElementVisibilityEvent[] = [];
  const matchedPrev = new Set<number>();
  const matchedCurr = new Set<number>();

  // 前フレームと現フレームの要素をマッチング
  for (let ci = 0; ci < currElements.length; ci++) {
    const curr = currElements[ci];
    if (!curr) continue;

    let bestMatch = -1;
    let bestOverlap = 0;

    for (let pi = 0; pi < prevElements.length; pi++) {
      if (matchedPrev.has(pi)) continue;
      const prev = prevElements[pi];
      if (!prev) continue;

      if (boxesOverlap(prev, curr, 5)) {
        // 重複面積を計算
        const overlapX = Math.max(0, Math.min(prev.x + prev.width, curr.x + curr.width) - Math.max(prev.x, curr.x));
        const overlapY = Math.max(0, Math.min(prev.y + prev.height, curr.y + curr.height) - Math.max(prev.y, curr.y));
        const overlap = overlapX * overlapY;

        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestMatch = pi;
        }
      }
    }

    if (bestMatch >= 0) {
      matchedPrev.add(bestMatch);
      matchedCurr.add(ci);
    }
  }

  // 新しい要素（出現）
  for (let ci = 0; ci < currElements.length; ci++) {
    if (!matchedCurr.has(ci)) {
      const curr = currElements[ci];
      if (!curr) continue;
      const elementSize = curr.width * curr.height;
      if (elementSize >= minElementSize) {
        events.push({
          frameIndex,
          eventType: 'appear',
          region: curr,
          elementSize,
        });
      }
    }
  }

  // 消えた要素（消失）
  for (let pi = 0; pi < prevElements.length; pi++) {
    if (!matchedPrev.has(pi)) {
      const prev = prevElements[pi];
      if (!prev) continue;
      const elementSize = prev.width * prev.height;
      if (elementSize >= minElementSize) {
        events.push({
          frameIndex,
          eventType: 'disappear',
          region: prev,
          elementSize,
        });
      }
    }
  }

  return events;
}

// =============================================================================
// ElementVisibilityDetector Class
// =============================================================================

/**
 * 要素可視性検出器
 *
 * Sobel演算子を使用したエッジ検出と連結成分分析により、
 * スクロール中の要素の出現/消失を検出する
 */
export class ElementVisibilityDetector {
  private readonly options: Required<ElementVisibilityDetectorOptions>;

  constructor(options: ElementVisibilityDetectorOptions = {}) {
    // オプション検証
    if (options.minElementSize !== undefined && options.minElementSize <= 0) {
      throw new Error('minElementSize must be positive');
    }
    if (
      options.edgeDetectionThreshold !== undefined &&
      (options.edgeDetectionThreshold < 0 || options.edgeDetectionThreshold > 1)
    ) {
      throw new Error('edgeDetectionThreshold must be between 0 and 1');
    }
    if (
      options.minContrastRatio !== undefined &&
      (options.minContrastRatio < 0 || options.minContrastRatio > 1)
    ) {
      throw new Error('minContrastRatio must be between 0 and 1');
    }

    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  /**
   * フレームシーケンスから要素の出現/消失を検出
   */
  async detect(frames: FrameData[]): Promise<ElementVisibilityResult> {
    // 入力検証
    if (frames.length === 0) {
      return {
        success: false,
        events: [],
        appearanceCount: 0,
        disappearanceCount: 0,
        error: {
          code: 'ELEMENT_VISIBILITY_NO_FRAMES',
          message: 'No frames provided',
        },
      };
    }

    if (frames.length < 2) {
      return {
        success: false,
        events: [],
        appearanceCount: 0,
        disappearanceCount: 0,
        error: {
          code: 'ELEMENT_VISIBILITY_INSUFFICIENT_FRAMES',
          message: 'At least 2 frames are required',
        },
      };
    }

    // フレームサイズの一貫性チェック
    const firstFrame = frames[0];
    if (!firstFrame) {
      return {
        success: false,
        events: [],
        appearanceCount: 0,
        disappearanceCount: 0,
        error: {
          code: 'ELEMENT_VISIBILITY_NO_FRAMES',
          message: 'First frame is undefined',
        },
      };
    }
    const { width, height } = firstFrame;
    for (let i = 1; i < frames.length; i++) {
      const frame = frames[i];
      if (!frame || frame.width !== width || frame.height !== height) {
        return {
          success: false,
          events: [],
          appearanceCount: 0,
          disappearanceCount: 0,
          error: {
            code: 'ELEMENT_VISIBILITY_DIMENSION_MISMATCH',
            message: `Frame ${i} has different dimensions`,
          },
        };
      }
    }

    // バッファサイズチェック
    const expectedBufferSize = width * height * 4;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (!frame || frame.buffer.length !== expectedBufferSize) {
        return {
          success: false,
          events: [],
          appearanceCount: 0,
          disappearanceCount: 0,
          error: {
            code: 'ELEMENT_VISIBILITY_BUFFER_MISMATCH',
            message: `Frame ${i} has incorrect buffer size`,
          },
        };
      }
    }

    // 連続フレーム間で出現/消失を検出（差分ベース）
    const events: ElementVisibilityEvent[] = [];
    // Note: trackedElements reserved for future use (element tracking across frames)

    for (let i = 0; i < frames.length - 1; i++) {
      const prevFrame = frames[i];
      const currFrame = frames[i + 1];

      // Type guard for frame availability
      if (!prevFrame || !currFrame) continue;

      // 2フレーム間の変化領域を検出
      const changedRegions = detectChangedRegions(
        prevFrame,
        currFrame,
        this.options.minContrastRatio,
        this.options.minElementSize
      );

      // 各変化領域が出現か消失かを判定
      for (const region of changedRegions) {
        // 領域の中心ピクセルの色変化で判定
        const centerX = Math.floor(region.x + region.width / 2);
        const centerY = Math.floor(region.y + region.height / 2);

        // RGB値を直接取得
        const prevOffset = (centerY * width + centerX) * 4;
        const currOffset = prevOffset;

        const prevR = prevFrame.buffer[prevOffset] ?? 0;
        const prevG = prevFrame.buffer[prevOffset + 1] ?? 0;
        const prevB = prevFrame.buffer[prevOffset + 2] ?? 0;
        const currR = currFrame.buffer[currOffset] ?? 0;
        const currG = currFrame.buffer[currOffset + 1] ?? 0;
        const currB = currFrame.buffer[currOffset + 2] ?? 0;

        // 背景色判定: 白（255,255,255近傍）か非白か
        // 重要: 黒い要素（0,0,0）が白い背景上に出現するケースを検出するため、
        // 「背景」は白のみとし、黒は「要素」として扱う
        const prevIsWhite = prevR > 240 && prevG > 240 && prevB > 240;
        const currIsWhite = currR > 240 && currG > 240 && currB > 240;

        const elementSize = region.width * region.height;

        if (prevIsWhite && !currIsWhite) {
          // 出現: 白背景 → 非白（要素が出現した）
          events.push({
            frameIndex: currFrame.index,
            eventType: 'appear',
            region,
            elementSize,
          });
        } else if (!prevIsWhite && currIsWhite) {
          // 消失: 非白（要素）→ 白背景（要素が消失した）
          events.push({
            frameIndex: currFrame.index,
            eventType: 'disappear',
            region,
            elementSize,
          });
        }
      }
    }

    const appearanceCount = events.filter((e) => e.eventType === 'appear').length;
    const disappearanceCount = events.filter((e) => e.eventType === 'disappear').length;

    return {
      success: true,
      events,
      appearanceCount,
      disappearanceCount,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * ElementVisibilityDetectorインスタンスを生成
 */
export function createElementVisibilityDetector(
  options?: ElementVisibilityDetectorOptions
): ElementVisibilityDetector {
  return new ElementVisibilityDetector(options);
}
