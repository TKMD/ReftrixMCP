// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fade Detector Service
 *
 * 透明度変化検出によるフェードイン/フェードアウト検出サービス
 *
 * 機能:
 * - フレームごとのアルファ値解析
 * - フェードイン/フェードアウトイベント検出
 * - 持続時間・変化量の計算
 * - MotionPattern記録用データ生成
 *
 * @module @reftrix/mcp-server/services/motion/fade-detector
 */

// =============================================================================
// 定数
// =============================================================================

const DEFAULTS = {
  /** アルファ変化閾値（0-1、この値以上の変化をフェードとして検出） */
  ALPHA_THRESHOLD: 0.1,
  /** 最小フェード持続フレーム数 */
  MIN_FADE_DURATION_FRAMES: 3,
  /** デフォルトFPS */
  FPS: 30,
} as const;

// =============================================================================
// 型定義
// =============================================================================

/**
 * Fade Detector 設定
 */
export interface FadeDetectorConfig {
  /** アルファ変化閾値（0-1） */
  alphaThreshold?: number;
  /** 最小フェード持続フレーム数 */
  minFadeDurationFrames?: number;
  /** FPS（duration計算用） */
  fps?: number;
}

/**
 * フレームアルファ情報
 */
export interface FrameAlphaInfo {
  /** 平均アルファ値（0-255） */
  averageAlpha: number;
  /** アルファ比率（0-1、255を1として正規化） */
  alphaRatio: number;
  /** 最小アルファ値 */
  minAlpha: number;
  /** 最大アルファ値 */
  maxAlpha: number;
  /** アルファ標準偏差 */
  alphaStdDev: number;
}

/**
 * フェードイベント
 */
export interface FadeEvent {
  /** フェードタイプ */
  type: 'fade_in' | 'fade_out';
  /** 開始フレームインデックス */
  startFrame: number;
  /** 終了フレームインデックス */
  endFrame: number;
  /** 開始時アルファ比率（0-1） */
  startAlpha: number;
  /** 終了時アルファ比率（0-1） */
  endAlpha: number;
  /** 持続時間（ミリ秒） */
  durationMs: number;
  /** フレーム数 */
  frameCount: number;
  /** アルファ変化量（絶対値） */
  alphaChange: number;
}

/**
 * フェード検出結果
 */
export interface FadeDetectionResult {
  /** 成功フラグ */
  success: boolean;
  /** 検出されたフェードイベント */
  fadeEvents: FadeEvent[];
  /** フェードインイベント数 */
  fadeInCount: number;
  /** フェードアウトイベント数 */
  fadeOutCount: number;
  /** 総フェードイベント数 */
  totalFadeEvents: number;
  /** 解析したフレーム数 */
  analyzedFrames: number;
  /** 処理時間（ミリ秒） */
  processingTimeMs?: number;
}

/**
 * 検出オプション
 */
export interface DetectOptions {
  /** FPS（duration計算用） */
  fps?: number;
}

/**
 * フレームデータ
 */
interface FrameData {
  /** フレームバッファ（RGBA形式） */
  buffer: Buffer;
  /** 画像幅 */
  width: number;
  /** 画像高さ */
  height: number;
  /** フレームインデックス */
  index: number;
}

// =============================================================================
// 内部ヘルパー
// =============================================================================

/**
 * アルファ変化の方向を判定
 */
function determineFadeType(
  startAlpha: number,
  endAlpha: number
): 'fade_in' | 'fade_out' | null {
  if (endAlpha > startAlpha) {
    return 'fade_in';
  } else if (endAlpha < startAlpha) {
    return 'fade_out';
  }
  return null;
}

// =============================================================================
// FadeDetector クラス
// =============================================================================

/**
 * フェードイン/フェードアウト検出器
 *
 * フレームシーケンスの透明度変化を解析し、
 * フェードイベントを検出します。
 */
export class FadeDetector {
  private readonly config: Required<FadeDetectorConfig>;

  constructor(config: FadeDetectorConfig = {}) {
    this.config = {
      alphaThreshold: config.alphaThreshold ?? DEFAULTS.ALPHA_THRESHOLD,
      minFadeDurationFrames:
        config.minFadeDurationFrames ?? DEFAULTS.MIN_FADE_DURATION_FRAMES,
      fps: config.fps ?? DEFAULTS.FPS,
    };

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FadeDetector] Created with config:', this.config);
    }
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * 単一フレームのアルファ値を解析
   */
  analyzeFrameAlpha(buffer: Buffer, width: number, height: number): FrameAlphaInfo {
    const totalPixels = width * height;
    const expectedSize = totalPixels * 4;

    // 空フレームまたはサイズ不正の場合
    if (totalPixels === 0 || buffer.length < expectedSize) {
      return {
        averageAlpha: 0,
        alphaRatio: 0,
        minAlpha: 0,
        maxAlpha: 0,
        alphaStdDev: 0,
      };
    }

    let sumAlpha = 0;
    let minAlpha = 255;
    let maxAlpha = 0;
    const alphaValues: number[] = [];

    // アルファ値を収集
    for (let i = 3; i < expectedSize; i += 4) {
      const alpha = buffer[i] ?? 0;
      sumAlpha += alpha;
      alphaValues.push(alpha);

      if (alpha < minAlpha) minAlpha = alpha;
      if (alpha > maxAlpha) maxAlpha = alpha;
    }

    const averageAlpha = sumAlpha / totalPixels;
    const alphaRatio = averageAlpha / 255;

    // 標準偏差計算
    let sumSquaredDiff = 0;
    for (const alpha of alphaValues) {
      const diff = alpha - averageAlpha;
      sumSquaredDiff += diff * diff;
    }
    const alphaStdDev = Math.sqrt(sumSquaredDiff / totalPixels);

    return {
      averageAlpha,
      alphaRatio,
      minAlpha,
      maxAlpha,
      alphaStdDev,
    };
  }

  /**
   * フレームシーケンスからフェードイベントを検出
   */
  detect(frames: FrameData[], options?: DetectOptions): FadeDetectionResult {
    const startTime = performance.now();
    const fps = options?.fps ?? this.config.fps;

    // 空配列または単一フレームの場合
    if (frames.length <= 1) {
      return {
        success: true,
        fadeEvents: [],
        fadeInCount: 0,
        fadeOutCount: 0,
        totalFadeEvents: 0,
        analyzedFrames: frames.length,
        processingTimeMs: performance.now() - startTime,
      };
    }

    // 各フレームのアルファ情報を計算
    const alphaInfos = frames.map((frame) =>
      this.analyzeFrameAlpha(frame.buffer, frame.width, frame.height)
    );

    // フェードイベントを検出
    const fadeEvents = this.detectFadeEvents(frames, alphaInfos, fps);

    const fadeInCount = fadeEvents.filter((e) => e.type === 'fade_in').length;
    const fadeOutCount = fadeEvents.filter((e) => e.type === 'fade_out').length;

    return {
      success: true,
      fadeEvents,
      fadeInCount,
      fadeOutCount,
      totalFadeEvents: fadeEvents.length,
      analyzedFrames: frames.length,
      processingTimeMs: performance.now() - startTime,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * フェードイベントを検出（内部実装）
   */
  private detectFadeEvents(
    frames: FrameData[],
    alphaInfos: FrameAlphaInfo[],
    fps: number
  ): FadeEvent[] {
    const events: FadeEvent[] = [];
    const msPerFrame = 1000 / fps;

    let fadeStartIndex: number | null = null;
    let fadeStartAlpha: number | null = null;
    let currentFadeType: 'fade_in' | 'fade_out' | null = null;

    for (let i = 1; i < alphaInfos.length; i++) {
      const prevAlpha = alphaInfos[i - 1]?.alphaRatio ?? 0;
      const currentAlpha = alphaInfos[i]?.alphaRatio ?? 0;
      const alphaDiff = currentAlpha - prevAlpha;
      const absAlphaDiff = Math.abs(alphaDiff);

      // フェード開始検出
      if (fadeStartIndex === null) {
        // 閾値を超える変化があるか確認
        if (absAlphaDiff > this.config.alphaThreshold * 0.1) {
          fadeStartIndex = i - 1;
          fadeStartAlpha = prevAlpha;
          currentFadeType = determineFadeType(prevAlpha, currentAlpha);
        }
      } else {
        // フェード継続中
        const expectedType = determineFadeType(fadeStartAlpha!, currentAlpha);

        // フェード方向が変わった、または変化が止まった場合
        if (expectedType !== currentFadeType || absAlphaDiff < 0.001) {
          // フェードイベントを確定
          const fadeFrameCount = i - fadeStartIndex;
          const totalAlphaChange = Math.abs(
            (alphaInfos[i - 1]?.alphaRatio ?? 0) - fadeStartAlpha!
          );

          // 最小持続時間と閾値を満たすか確認
          if (
            fadeFrameCount >= this.config.minFadeDurationFrames &&
            totalAlphaChange >= this.config.alphaThreshold
          ) {
            const endAlpha = alphaInfos[i - 1]?.alphaRatio ?? 0;

            events.push({
              type: currentFadeType!,
              startFrame: frames[fadeStartIndex]?.index ?? fadeStartIndex,
              endFrame: frames[i - 1]?.index ?? i - 1,
              startAlpha: fadeStartAlpha!,
              endAlpha,
              durationMs: fadeFrameCount * msPerFrame,
              frameCount: fadeFrameCount,
              alphaChange: totalAlphaChange,
            });
          }

          // 新しいフェードの開始をチェック
          if (absAlphaDiff > this.config.alphaThreshold * 0.1) {
            fadeStartIndex = i - 1;
            fadeStartAlpha = alphaInfos[i - 1]?.alphaRatio ?? 0;
            currentFadeType = determineFadeType(fadeStartAlpha, currentAlpha);
          } else {
            fadeStartIndex = null;
            fadeStartAlpha = null;
            currentFadeType = null;
          }
        }
      }
    }

    // 最後まで続くフェードの処理
    if (fadeStartIndex !== null && fadeStartAlpha !== null && currentFadeType !== null) {
      const lastIndex = alphaInfos.length - 1;
      const fadeFrameCount = lastIndex - fadeStartIndex + 1;
      const endAlpha = alphaInfos[lastIndex]?.alphaRatio ?? 0;
      const totalAlphaChange = Math.abs(endAlpha - fadeStartAlpha);

      if (
        fadeFrameCount >= this.config.minFadeDurationFrames &&
        totalAlphaChange >= this.config.alphaThreshold
      ) {
        events.push({
          type: currentFadeType,
          startFrame: frames[fadeStartIndex]?.index ?? fadeStartIndex,
          endFrame: frames[lastIndex]?.index ?? lastIndex,
          startAlpha: fadeStartAlpha,
          endAlpha,
          durationMs: fadeFrameCount * msPerFrame,
          frameCount: fadeFrameCount,
          alphaChange: totalAlphaChange,
        });
      }
    }

    return events;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * FadeDetectorインスタンスを作成
 */
export function createFadeDetector(config?: FadeDetectorConfig): FadeDetector {
  return new FadeDetector(config);
}

export default FadeDetector;
