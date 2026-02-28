// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FrameAnalyzerService
 * 動画フレームからモーション検出するサービス
 *
 * 機能:
 * - 動画ファイルからフレームを抽出（ffmpegベース）
 * - フレーム間の差分検出（ピクセル変化率）
 * - モーションタイムライン生成
 * - CSS animation/transitionの推定パラメータ算出
 *
 * Phase1: 動画キャプチャ - Playwright録画 + フレーム解析
 *
 * 依存:
 * - sharp: 画像処理・比較
 * - child_process: ffmpeg呼び出し
 *
 * @module services/page/frame-analyzer.service
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { logger, isDevelopment } from '../../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * フレーム抽出オプション
 */
export interface ExtractOptions {
  /** フレームレート（fps） デフォルト: 10 */
  fps?: number;
  /** 開始時間（秒） デフォルト: 0 */
  startTime?: number;
  /** 終了時間（秒） デフォルト: 動画全長 */
  endTime?: number;
  /** 出力フォーマット デフォルト: png */
  format?: 'png' | 'jpeg';
  /** 出力サイズ デフォルト: 動画と同じ */
  outputSize?: { width: number; height: number };
}

/**
 * 抽出されたフレーム情報
 */
export interface ExtractedFrame {
  /** フレームインデックス（0開始） */
  index: number;
  /** タイムスタンプ（ミリ秒） */
  timestampMs: number;
  /** フレーム画像パス */
  imagePath: string;
  /** 画像サイズ（バイト） */
  sizeBytes: number;
}

/**
 * フレーム抽出結果
 */
export interface ExtractResult {
  /** 抽出されたフレーム配列 */
  frames: ExtractedFrame[];
  /** 総フレーム数 */
  totalFrames: number;
  /** フレームレート */
  fps: number;
  /** 動画長さ（ミリ秒） */
  durationMs: number;
  /** フレーム出力ディレクトリ */
  outputDir: string;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * フレーム間差分情報
 */
export interface FrameDiff {
  /** 比較元フレームインデックス */
  fromIndex: number;
  /** 比較先フレームインデックス */
  toIndex: number;
  /** タイムスタンプ差分（ミリ秒） */
  timestampDiffMs: number;
  /** 変化率（0-1） */
  changeRatio: number;
  /** 変化ピクセル数 */
  changedPixels: number;
  /** 総ピクセル数 */
  totalPixels: number;
  /** 変化が検出されたか（閾値以上） */
  hasMotion: boolean;
}

/**
 * モーションセグメント（アニメーション期間）
 */
export interface MotionSegment {
  /** 開始タイムスタンプ（ミリ秒） */
  startMs: number;
  /** 終了タイムスタンプ（ミリ秒） */
  endMs: number;
  /** 継続時間（ミリ秒） */
  durationMs: number;
  /** 平均変化率 */
  avgChangeRatio: number;
  /** 最大変化率 */
  maxChangeRatio: number;
  /** モーションタイプ推定 */
  estimatedType: 'fade' | 'slide' | 'scale' | 'rotate' | 'complex' | 'unknown';
  /** 推定イージング */
  estimatedEasing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'unknown';
}

/**
 * モーション解析結果
 */
export interface AnalyzeResult {
  /** フレーム間差分配列 */
  diffs: FrameDiff[];
  /** 検出されたモーションセグメント */
  motionSegments: MotionSegment[];
  /** 総フレーム数 */
  totalFrames: number;
  /** 動画長さ（ミリ秒） */
  durationMs: number;
  /** モーション検出された割合（0-1） */
  motionCoverage: number;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * フレーム解析オプション
 */
export interface AnalyzeOptions {
  /** 変化検出閾値（0-1） デフォルト: 0.01 (1%) */
  changeThreshold?: number;
  /** 最小モーション継続時間（ミリ秒） デフォルト: 100 */
  minMotionDurationMs?: number;
  /** モーションセグメント間のギャップ許容（ミリ秒） デフォルト: 50 */
  gapToleranceMs?: number;
}

/**
 * デフォルトの抽出オプション
 */
export const DEFAULT_EXTRACT_OPTIONS: Required<ExtractOptions> = {
  fps: 10,
  startTime: 0,
  endTime: Infinity,
  format: 'png',
  outputSize: { width: 0, height: 0 },
};

/**
 * デフォルトの解析オプション
 */
export const DEFAULT_ANALYZE_OPTIONS: Required<AnalyzeOptions> = {
  changeThreshold: 0.01,
  minMotionDurationMs: 100,
  gapToleranceMs: 50,
};

// =====================================================
// エラークラス
// =====================================================

/**
 * フレーム解析エラー
 */
export class FrameAnalyzerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameAnalyzerError';
  }
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * 一時ディレクトリを作成
 */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frame-analyzer-'));
}

/**
 * ffmpegが利用可能か確認
 */
async function checkFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

/**
 * ffprobeで動画情報を取得
 */
async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new FrameAnalyzerError(`ffprobe not available: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new FrameAnalyzerError(`ffprobe failed: ${stderr}`));
      } else {
        const duration = parseFloat(stdout.trim());
        if (isNaN(duration)) {
          reject(new FrameAnalyzerError('Failed to parse video duration'));
        } else {
          resolve(duration * 1000); // 秒→ミリ秒
        }
      }
    });
  });
}

/**
 * ffmpegでフレームを抽出
 */
async function extractWithFfmpeg(
  videoPath: string,
  outputDir: string,
  opts: Required<ExtractOptions>
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i',
      videoPath,
      '-vf',
      `fps=${opts.fps}`,
    ];

    // 開始時間
    if (opts.startTime > 0) {
      args.unshift('-ss', opts.startTime.toString());
    }

    // 終了時間
    if (opts.endTime !== Infinity) {
      args.push('-t', (opts.endTime - opts.startTime).toString());
    }

    // 出力サイズ
    if (opts.outputSize.width > 0 && opts.outputSize.height > 0) {
      args.push('-s', `${opts.outputSize.width}x${opts.outputSize.height}`);
    }

    // 出力ファイル
    const ext = opts.format === 'jpeg' ? 'jpg' : 'png';
    const outputPattern = path.join(outputDir, `frame_%05d.${ext}`);
    args.push(outputPattern);

    if (isDevelopment()) {
      logger.debug('[FrameAnalyzerService] Running ffmpeg', { args });
    }

    const proc = spawn('ffmpeg', args);
    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new FrameAnalyzerError(`ffmpeg not available: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new FrameAnalyzerError(`ffmpeg failed: ${stderr}`));
      } else {
        // 抽出されたフレームファイルを取得
        const files = fs
          .readdirSync(outputDir)
          .filter((f) => f.startsWith('frame_') && f.endsWith(`.${ext}`))
          .sort()
          .map((f) => path.join(outputDir, f));
        resolve(files);
      }
    });
  });
}

/**
 * 2つの画像のピクセル差分を計算
 */
async function compareImages(
  imagePath1: string,
  imagePath2: string
): Promise<{ changedPixels: number; totalPixels: number; changeRatio: number }> {
  // 画像を読み込み
  const [img1, img2] = await Promise.all([
    sharp(imagePath1).raw().toBuffer({ resolveWithObject: true }),
    sharp(imagePath2).raw().toBuffer({ resolveWithObject: true }),
  ]);

  const { data: data1, info: info1 } = img1;
  const { data: data2, info: info2 } = img2;

  // サイズが異なる場合はエラー
  if (info1.width !== info2.width || info1.height !== info2.height) {
    throw new FrameAnalyzerError('Image dimensions do not match');
  }

  const totalPixels = info1.width * info1.height;
  const channels = info1.channels;
  let changedPixels = 0;

  // ピクセル単位で比較（閾値: 各チャンネル30の差）
  const threshold = 30;
  for (let i = 0; i < data1.length; i += channels) {
    let diff = 0;
    for (let c = 0; c < channels; c++) {
      const val1 = data1[i + c] ?? 0;
      const val2 = data2[i + c] ?? 0;
      diff += Math.abs(val1 - val2);
    }
    if (diff / channels > threshold) {
      changedPixels++;
    }
  }

  const changeRatio = changedPixels / totalPixels;

  return { changedPixels, totalPixels, changeRatio };
}

/**
 * 変化率からイージングを推定
 */
function estimateEasing(
  changeRatios: number[]
): 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'unknown' {
  if (changeRatios.length < 3) {
    return 'unknown';
  }

  const len = changeRatios.length;
  const firstThird = changeRatios.slice(0, Math.floor(len / 3));
  const lastThird = changeRatios.slice(-Math.floor(len / 3));

  const avgFirst = firstThird.reduce((a, b) => a + b, 0) / firstThird.length;
  const avgLast = lastThird.reduce((a, b) => a + b, 0) / lastThird.length;
  const avgAll = changeRatios.reduce((a, b) => a + b, 0) / changeRatios.length;

  // 変化の傾向を分析
  const startSlow = avgFirst < avgAll * 0.7;
  const endSlow = avgLast < avgAll * 0.7;

  if (startSlow && endSlow) {
    return 'ease-in-out';
  } else if (startSlow) {
    return 'ease-in';
  } else if (endSlow) {
    return 'ease-out';
  } else {
    return 'linear';
  }
}

/**
 * モーションタイプを推定（シンプルな実装）
 */
function estimateMotionType(
  _avgChangeRatio: number,
  _maxChangeRatio: number
): 'fade' | 'slide' | 'scale' | 'rotate' | 'complex' | 'unknown' {
  // 現時点では単純化：将来的にはピクセル分布解析で判別
  // 今はcomplexまたはunknownを返す
  return 'complex';
}

// =====================================================
// FrameAnalyzerService クラス
// =====================================================

/**
 * 動画フレームからモーション検出するサービス
 */
export class FrameAnalyzerService {
  private tempDirs: string[] = [];

  /**
   * 動画ファイルからフレームを抽出
   *
   * @param videoPath - 動画ファイルのパス
   * @param options - 抽出オプション
   * @returns フレーム抽出結果
   * @throws FrameAnalyzerError
   */
  async extractFrames(
    videoPath: string,
    options: ExtractOptions = {}
  ): Promise<ExtractResult> {
    const startTime = Date.now();
    const opts: Required<ExtractOptions> = {
      fps: options.fps ?? DEFAULT_EXTRACT_OPTIONS.fps,
      startTime: options.startTime ?? DEFAULT_EXTRACT_OPTIONS.startTime,
      endTime: options.endTime ?? DEFAULT_EXTRACT_OPTIONS.endTime,
      format: options.format ?? DEFAULT_EXTRACT_OPTIONS.format,
      outputSize: options.outputSize ?? DEFAULT_EXTRACT_OPTIONS.outputSize,
    };

    if (isDevelopment()) {
      logger.debug('[FrameAnalyzerService] extractFrames called', {
        videoPath,
        fps: opts.fps,
        format: opts.format,
      });
    }

    // バリデーション
    if (opts.fps <= 0) {
      throw new FrameAnalyzerError('fps must be positive');
    }
    if (opts.startTime < 0) {
      throw new FrameAnalyzerError('startTime must be non-negative');
    }
    if (!fs.existsSync(videoPath)) {
      throw new FrameAnalyzerError(`Video file not found: ${videoPath}`);
    }

    // ファイル形式チェック（簡易）
    const ext = path.extname(videoPath).toLowerCase();
    if (!['.webm', '.mp4', '.avi', '.mov', '.mkv'].includes(ext)) {
      throw new FrameAnalyzerError(`Unsupported video format: ${ext}`);
    }

    // ffmpegが利用可能か確認
    const ffmpegAvailable = await checkFfmpegAvailable();
    if (!ffmpegAvailable) {
      throw new FrameAnalyzerError(
        'ffmpeg is not installed. Please install ffmpeg to use frame extraction.'
      );
    }

    // 一時ディレクトリを作成
    const outputDir = createTempDir();
    this.tempDirs.push(outputDir);

    try {
      // 動画の長さを取得
      const durationMs = await getVideoDuration(videoPath);

      // 終了時間を調整
      const effectiveEndTime = Math.min(opts.endTime, durationMs / 1000);

      // ffmpegでフレームを抽出
      const framePaths = await extractWithFfmpeg(videoPath, outputDir, {
        ...opts,
        endTime: effectiveEndTime,
      });

      // フレーム情報を構築
      const frames: ExtractedFrame[] = [];
      const interval = 1000 / opts.fps; // ミリ秒

      for (let i = 0; i < framePaths.length; i++) {
        const imagePath = framePaths[i];
        if (imagePath === undefined) continue;
        const stats = fs.statSync(imagePath);
        frames.push({
          index: i,
          timestampMs: opts.startTime * 1000 + i * interval,
          imagePath,
          sizeBytes: stats.size,
        });
      }

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.debug('[FrameAnalyzerService] extractFrames completed', {
          videoPath,
          totalFrames: frames.length,
          processingTimeMs,
        });
      }

      return {
        frames,
        totalFrames: frames.length,
        fps: opts.fps,
        durationMs,
        outputDir,
        processingTimeMs,
      };
    } catch (error) {
      // エラー時はクリーンアップ
      this.cleanupDir(outputDir);
      throw error;
    }
  }

  /**
   * フレーム間のモーションを解析
   *
   * @param extractResult - フレーム抽出結果
   * @param options - 解析オプション
   * @returns モーション解析結果
   */
  async analyzeMotion(
    extractResult: ExtractResult,
    options: AnalyzeOptions = {}
  ): Promise<AnalyzeResult> {
    const startTime = Date.now();
    const opts: Required<AnalyzeOptions> = {
      changeThreshold: options.changeThreshold ?? DEFAULT_ANALYZE_OPTIONS.changeThreshold,
      minMotionDurationMs: options.minMotionDurationMs ?? DEFAULT_ANALYZE_OPTIONS.minMotionDurationMs,
      gapToleranceMs: options.gapToleranceMs ?? DEFAULT_ANALYZE_OPTIONS.gapToleranceMs,
    };

    if (isDevelopment()) {
      logger.debug('[FrameAnalyzerService] analyzeMotion called', {
        totalFrames: extractResult.totalFrames,
        changeThreshold: opts.changeThreshold,
      });
    }

    const { frames } = extractResult;
    const diffs: FrameDiff[] = [];

    // フレーム間差分を計算
    for (let i = 0; i < frames.length - 1; i++) {
      const frame1 = frames[i];
      const frame2 = frames[i + 1];
      if (!frame1 || !frame2) continue;

      const comparison = await compareImages(frame1.imagePath, frame2.imagePath);

      diffs.push({
        fromIndex: i,
        toIndex: i + 1,
        timestampDiffMs: frame2.timestampMs - frame1.timestampMs,
        changeRatio: comparison.changeRatio,
        changedPixels: comparison.changedPixels,
        totalPixels: comparison.totalPixels,
        hasMotion: comparison.changeRatio >= opts.changeThreshold,
      });
    }

    // モーションセグメントを検出
    const motionSegments: MotionSegment[] = [];
    let currentSegmentStart = -1;
    let segmentDiffs: FrameDiff[] = [];

    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      if (!diff) continue;

      if (diff.hasMotion) {
        if (currentSegmentStart === -1) {
          currentSegmentStart = i;
          segmentDiffs = [diff];
        } else {
          // ギャップチェック
          const prevDiff = diffs[i - 1];
          if (!prevDiff) continue;
          const gap = diff.timestampDiffMs + prevDiff.timestampDiffMs;
          if (gap <= opts.gapToleranceMs * 2 || prevDiff.hasMotion) {
            segmentDiffs.push(diff);
          } else {
            // セグメント終了
            this.closeSegment(
              motionSegments,
              frames,
              segmentDiffs,
              currentSegmentStart,
              i - 1,
              opts.minMotionDurationMs
            );
            currentSegmentStart = i;
            segmentDiffs = [diff];
          }
        }
      } else if (currentSegmentStart !== -1) {
        // モーション終了をチェック
        // 次のフレームもモーションなしなら確定
        const lookAhead = diffs.slice(i, i + 3);
        const hasMoreMotion = lookAhead.some((d) => d.hasMotion);
        if (!hasMoreMotion) {
          this.closeSegment(
            motionSegments,
            frames,
            segmentDiffs,
            currentSegmentStart,
            i - 1,
            opts.minMotionDurationMs
          );
          currentSegmentStart = -1;
          segmentDiffs = [];
        }
      }
    }

    // 最後のセグメントを閉じる
    if (currentSegmentStart !== -1 && segmentDiffs.length > 0) {
      this.closeSegment(
        motionSegments,
        frames,
        segmentDiffs,
        currentSegmentStart,
        diffs.length - 1,
        opts.minMotionDurationMs
      );
    }

    // モーションカバレッジを計算
    let totalMotionTime = 0;
    for (const segment of motionSegments) {
      totalMotionTime += segment.durationMs;
    }
    const motionCoverage = extractResult.durationMs > 0
      ? totalMotionTime / extractResult.durationMs
      : 0;

    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.debug('[FrameAnalyzerService] analyzeMotion completed', {
        totalDiffs: diffs.length,
        motionSegments: motionSegments.length,
        motionCoverage,
        processingTimeMs,
      });
    }

    return {
      diffs,
      motionSegments,
      totalFrames: extractResult.totalFrames,
      durationMs: extractResult.durationMs,
      motionCoverage,
      processingTimeMs,
    };
  }

  /**
   * モーションセグメントを閉じて追加
   */
  private closeSegment(
    motionSegments: MotionSegment[],
    frames: ExtractedFrame[],
    segmentDiffs: FrameDiff[],
    startIdx: number,
    endIdx: number,
    minMotionDurationMs: number
  ): void {
    if (segmentDiffs.length === 0) return;

    const startFrame = frames[startIdx];
    const endFrame = frames[Math.min(endIdx + 1, frames.length - 1)];
    if (!startFrame || !endFrame) return;

    const startMs = startFrame.timestampMs;
    const endMs = endFrame.timestampMs;
    const durationMs = endMs - startMs;

    // 最小継続時間チェック
    if (durationMs < minMotionDurationMs) {
      return;
    }

    const changeRatios = segmentDiffs.map((d) => d.changeRatio);
    const avgChangeRatio =
      changeRatios.reduce((a, b) => a + b, 0) / changeRatios.length;
    const maxChangeRatio = Math.max(...changeRatios);

    motionSegments.push({
      startMs,
      endMs,
      durationMs,
      avgChangeRatio,
      maxChangeRatio,
      estimatedType: estimateMotionType(avgChangeRatio, maxChangeRatio),
      estimatedEasing: estimateEasing(changeRatios),
    });
  }

  /**
   * 抽出結果をクリーンアップ
   *
   * @param extractResult - クリーンアップするフレーム抽出結果
   */
  async cleanup(extractResult: ExtractResult): Promise<void> {
    this.cleanupDir(extractResult.outputDir);
  }

  /**
   * ディレクトリをクリーンアップ
   */
  private cleanupDir(dir: string): void {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        const index = this.tempDirs.indexOf(dir);
        if (index > -1) {
          this.tempDirs.splice(index, 1);
        }
        if (isDevelopment()) {
          logger.debug('[FrameAnalyzerService] cleanup: deleted dir', { dir });
        }
      }
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[FrameAnalyzerService] cleanup error', { dir, error });
      }
    }
  }

  /**
   * すべての一時ファイルをクリーンアップ
   */
  async closeAll(): Promise<void> {
    for (const dir of [...this.tempDirs]) {
      this.cleanupDir(dir);
    }
    this.tempDirs = [];
  }
}

// =====================================================
// スタンドアロン関数
// =====================================================

/**
 * シングルトンインスタンス
 */
let sharedService: FrameAnalyzerService | null = null;

/**
 * 共有サービスインスタンスを取得
 */
function getSharedService(): FrameAnalyzerService {
  if (!sharedService) {
    sharedService = new FrameAnalyzerService();
  }
  return sharedService;
}

/**
 * 動画ファイルからフレームを抽出（スタンドアロン関数）
 *
 * @param videoPath - 動画ファイルのパス
 * @param options - 抽出オプション
 * @returns フレーム抽出結果
 *
 * @example
 * ```typescript
 * const result = await extractFrames('/path/to/video.webm', {
 *   fps: 10,
 *   format: 'png',
 * });
 * console.log(result.frames.length); // 抽出されたフレーム数
 * ```
 */
export async function extractFrames(
  videoPath: string,
  options: ExtractOptions = {}
): Promise<ExtractResult> {
  const service = getSharedService();
  return service.extractFrames(videoPath, options);
}

/**
 * フレーム間のモーションを解析（スタンドアロン関数）
 *
 * @param extractResult - フレーム抽出結果
 * @param options - 解析オプション
 * @returns モーション解析結果
 *
 * @example
 * ```typescript
 * const extractResult = await extractFrames('/path/to/video.webm', { fps: 10 });
 * const analyzeResult = await analyzeMotion(extractResult, {
 *   changeThreshold: 0.01,
 * });
 * console.log(analyzeResult.motionSegments); // 検出されたモーション
 * ```
 */
export async function analyzeMotion(
  extractResult: ExtractResult,
  options: AnalyzeOptions = {}
): Promise<AnalyzeResult> {
  const service = getSharedService();
  return service.analyzeMotion(extractResult, options);
}

/**
 * 共有サービスを閉じる
 */
export async function closeSharedAnalyzer(): Promise<void> {
  if (sharedService) {
    await sharedService.closeAll();
    sharedService = null;
  }
}
