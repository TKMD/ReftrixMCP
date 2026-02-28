// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.analyze_frames MCPツール ハンドラー
 * フレーム画像解析用のMCPツール
 *
 * 機能:
 * - フレーム差分検出 (frame_diff)
 * - レイアウトシフト検出 (layout_shift)
 * - 色変化検出 (color_change)
 * - モーションベクトル推定 (motion_vector)
 * - 要素出現/消失検出 (element_visibility)
 *
 * @module tools/motion/analyze-frames.handler
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ZodError } from 'zod';
import { logger, isDevelopment } from '../../utils/logger';
import {
  analyzeFramesInputSchema,
  analyzeFramesMcpTool,
  type AnalyzeFramesInput,
  type AnalyzeFramesOutput,
  type AnalyzeFramesData,
  type AnalysisResults,
  type TimelineEntry,
  type AnalysisType,
  ANALYZE_FRAMES_ERROR_CODES,
  MIN_ANALYSIS_FRAMES,
} from './analyze-frames.schema';

// ============================================================================
// Service Interface
// ============================================================================

/**
 * フレーム解析サービスの入力型
 */
export interface FrameAnalysisServiceInput {
  frame_dir: string;
  frame_pattern: string;
  analysis_types: AnalysisType[];
  frame_paths: string[];
  options: {
    diff_threshold: number;
    max_frames: number;
    parallel: boolean;
    output_diff_images: boolean;
  };
}

/**
 * フレーム解析サービスの出力型
 */
export interface FrameAnalysisServiceOutput {
  frame_count: number;
  analysis_results: AnalysisResults;
  timeline: TimelineEntry[];
  processing_time_ms: number;
}

/**
 * フレーム解析サービスインターフェース
 * DIパターンでテスト時にモックを注入可能
 */
export interface IFrameAnalysisService {
  analyzeFrames(input: FrameAnalysisServiceInput): Promise<FrameAnalysisServiceOutput>;
  compareFrames?(
    frame1Path: string,
    frame2Path: string,
    options?: { threshold?: number }
  ): Promise<{
    from_index: number;
    to_index: number;
    change_ratio: number;
    changed_pixels: number;
    total_pixels: number;
    change_regions: Array<{ x: number; y: number; width: number; height: number }>;
    has_change: boolean;
  }>;
  detectLayoutShift?(
    frame1Path: string,
    frame2Path: string,
    options?: { threshold?: number }
  ): Promise<{
    frame_index: number;
    shift_start_ms: number;
    impact_score: number;
    affected_regions: Array<{ x: number; y: number; width: number; height: number }>;
    estimated_cause: 'image_load' | 'font_swap' | 'dynamic_content' | 'unknown';
    shift_direction: 'horizontal' | 'vertical' | 'both';
    shift_distance: number;
  }>;
  detectColorChange?(
    framePaths: string[],
    options?: { threshold?: number }
  ): Promise<{
    events: Array<{
      start_frame: number;
      end_frame: number;
      change_type: 'fade_in' | 'fade_out' | 'color_transition' | 'brightness_change';
      affected_region: { x: number; y: number; width: number; height: number };
      from_color: string;
      to_color: string;
      estimated_duration_ms: number;
    }>;
  }>;
}

// ============================================================================
// Service Factory (DI Pattern)
// ============================================================================

/**
 * サービスファクトリ型
 */
type FrameAnalysisServiceFactory = () => IFrameAnalysisService;

/**
 * デフォルトサービスファクトリ
 * 実際の画像処理を行うサービスを返す（将来実装）
 */
let serviceFactory: FrameAnalysisServiceFactory | null = null;

/**
 * サービスファクトリを設定
 * テスト時にモックサービスを注入するために使用
 */
export function setFrameAnalysisServiceFactory(factory: FrameAnalysisServiceFactory): void {
  serviceFactory = factory;
}

/**
 * サービスファクトリをリセット
 * テスト後にクリーンアップするために使用
 */
export function resetFrameAnalysisServiceFactory(): void {
  serviceFactory = null;
}

/**
 * サービスインスタンスを取得
 */
function getFrameAnalysisService(): IFrameAnalysisService | null {
  if (serviceFactory) {
    return serviceFactory();
  }
  // デフォルトサービスは未実装（将来的にPixelmatch+Sharpで実装）
  return null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * ディレクトリ内のフレームファイルを取得
 */
async function getFrameFiles(
  frameDir: string,
  pattern: string,
  maxFrames: number
): Promise<string[]> {
  const files = await fs.readdir(frameDir);

  // パターンをGlob形式から正規表現に変換
  // 例: "frame-*.png" -> /^frame-.*\.png$/
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 特殊文字をエスケープ
    .replace(/\*/g, '.*') // * を .* に変換
    .replace(/\?/g, '.'); // ? を . に変換

  const regex = new RegExp(`^${regexPattern}$`);

  const matchingFiles = files
    .filter((file) => regex.test(file))
    .sort() // ファイル名でソート
    .slice(0, maxFrames)
    .map((file) => path.join(frameDir, file));

  return matchingFiles;
}

/**
 * エラーレスポンスを作成
 */
function createErrorResponse(
  code: string,
  message: string,
  details?: unknown
): AnalyzeFramesOutput {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
  };
}

/**
 * 成功レスポンスを作成
 */
function createSuccessResponse(data: AnalyzeFramesData): AnalyzeFramesOutput {
  return {
    success: true,
    data,
  };
}

// ============================================================================
// Handler
// ============================================================================

/**
 * motion.analyze_frames ハンドラー
 *
 * フレーム画像を解析し、モーション/アニメーションパターンを検出します。
 *
 * @param input - 解析入力パラメータ
 * @returns 解析結果
 */
export async function motionAnalyzeFramesHandler(
  input: unknown
): Promise<AnalyzeFramesOutput> {
  const startTime = performance.now();

  if (isDevelopment()) {
    logger.debug('[motion.analyze_frames] Handler invoked', { input });
  }

  // ===================================
  // 1. 入力バリデーション
  // ===================================
  let parsedInput: AnalyzeFramesInput;
  try {
    parsedInput = analyzeFramesInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ');
      if (isDevelopment()) {
        logger.error('[motion.analyze_frames] Validation error', { error: errorMessage });
      }
      return createErrorResponse(
        ANALYZE_FRAMES_ERROR_CODES.VALIDATION_ERROR,
        `入力バリデーションエラー: ${errorMessage}`,
        error.issues
      );
    }
    throw error;
  }

  const {
    frame_dir,
    frame_pattern,
    analysis_types,
    options,
  } = parsedInput;

  const effectiveOptions = {
    diff_threshold: options?.diff_threshold ?? 0.1,
    max_frames: options?.max_frames ?? 300,
    parallel: options?.parallel ?? true,
    output_diff_images: options?.output_diff_images ?? false,
  };

  // ===================================
  // 2. ディレクトリ存在確認
  // ===================================
  try {
    const stats = await fs.stat(frame_dir);
    if (!stats.isDirectory()) {
      return createErrorResponse(
        ANALYZE_FRAMES_ERROR_CODES.DIRECTORY_NOT_FOUND,
        `指定されたパスはディレクトリではありません: ${frame_dir}`
      );
    }
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'ENOENT') {
      return createErrorResponse(
        ANALYZE_FRAMES_ERROR_CODES.DIRECTORY_NOT_FOUND,
        `フレームディレクトリが見つかりません: ${frame_dir}`
      );
    }
    throw error;
  }

  // ===================================
  // 3. フレームファイル取得
  // ===================================
  let framePaths: string[];
  try {
    framePaths = await getFrameFiles(
      frame_dir,
      frame_pattern,
      effectiveOptions.max_frames
    );
  } catch (error) {
    return createErrorResponse(
      ANALYZE_FRAMES_ERROR_CODES.INTERNAL_ERROR,
      `フレームファイルの取得に失敗しました: ${(error as Error).message}`
    );
  }

  if (framePaths.length === 0) {
    return createErrorResponse(
      ANALYZE_FRAMES_ERROR_CODES.NO_FRAMES_FOUND,
      `パターン "${frame_pattern}" に一致するフレームが見つかりません`
    );
  }

  if (framePaths.length < MIN_ANALYSIS_FRAMES) {
    return createErrorResponse(
      ANALYZE_FRAMES_ERROR_CODES.INSUFFICIENT_FRAMES,
      `フレーム数が不足しています。最低${MIN_ANALYSIS_FRAMES}フレーム必要です。(現在: ${framePaths.length})`
    );
  }

  if (isDevelopment()) {
    logger.debug('[motion.analyze_frames] Found frames', {
      count: framePaths.length,
      pattern: frame_pattern,
    });
  }

  // ===================================
  // 4. サービス取得と解析実行
  // ===================================
  const service = getFrameAnalysisService();
  if (!service) {
    // サービスが未設定の場合はエラー
    return createErrorResponse(
      ANALYZE_FRAMES_ERROR_CODES.INTERNAL_ERROR,
      'フレーム解析サービスが利用できません。サービスファクトリを設定してください。'
    );
  }

  try {
    const result = await service.analyzeFrames({
      frame_dir,
      frame_pattern,
      analysis_types,
      frame_paths: framePaths,
      options: effectiveOptions,
    });

    const processingTime = performance.now() - startTime;

    if (isDevelopment()) {
      logger.debug('[motion.analyze_frames] Analysis completed', {
        frame_count: result.frame_count,
        processing_time_ms: processingTime,
      });
    }

    return createSuccessResponse({
      frame_count: result.frame_count,
      analysis_results: result.analysis_results,
      timeline: result.timeline,
      processing_time_ms: result.processing_time_ms,
    });
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[motion.analyze_frames] Analysis error', { error });
    }
    return createErrorResponse(
      ANALYZE_FRAMES_ERROR_CODES.ANALYSIS_ERROR,
      `解析エラー: ${(error as Error).message}`
    );
  }
}

// ============================================================================
// Tool Definition Export
// ============================================================================

/**
 * motion.analyze_frames ツール定義
 * MCPサーバーに登録するためのツール定義オブジェクト
 */
export const motionAnalyzeFramesToolDefinition = {
  name: analyzeFramesMcpTool.name,
  description: analyzeFramesMcpTool.description,
  inputSchema: analyzeFramesMcpTool.inputSchema,
  handler: motionAnalyzeFramesHandler,
};

// ============================================================================
// Type Exports
// ============================================================================

export type { AnalyzeFramesInput, AnalyzeFramesOutput };
