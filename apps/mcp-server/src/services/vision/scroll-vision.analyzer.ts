// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ScrollVisionAnalyzer - スクロール位置スクリーンショットのVision分析
 *
 * キャプチャされた各スクロール位置のスクリーンショットをOllama Visionで分析し、
 * スクロールトリガーアニメーション、lazy-load要素、パララックス効果などを検出する。
 *
 * 機能:
 * - 各キャプチャのVision分析（順次処理）
 * - スクロールトリガー要素の検出
 * - 隣接キャプチャ間の視覚変化比較
 * - 全体のスクロールトリガーアニメーション集約
 * - Ollama未接続時のgraceful degradation
 *
 * @module services/vision/scroll-vision.analyzer
 */

import { z } from 'zod';
import { LlamaVisionAdapter } from './llama-vision-adapter.js';
import type { ScrollCapture } from './scroll-vision-capture.service.js';
import { createLogger } from '../../utils/logger.js';

// =============================================================================
// 定数
// =============================================================================

const LOG_PREFIX = 'ScrollVisionAnalyzer';

/**
 * デフォルトOllama URL
 */
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/**
 * 最小信頼度閾値（これ未満の検出結果はフィルタリング）
 */
const MIN_CONFIDENCE_THRESHOLD = 0.3;

// =============================================================================
// 型定義
// =============================================================================

/**
 * スクロールトリガー変化タイプ
 */
export type ScrollChangeType = 'appear' | 'animate' | 'transform' | 'lazy-load' | 'parallax';

/**
 * スクロールトリガー要素
 */
export interface ScrollTriggeredElement {
  /** 要素の説明 */
  element: string;
  /** 変化タイプ */
  changeType: ScrollChangeType;
  /** 信頼度（0.0-1.0） */
  confidence: number;
}

/**
 * 個別スクロール位置のVision分析結果
 */
export interface ScrollVisionAnalysis {
  /** スクロールY座標 */
  scrollY: number;
  /** セクションインデックス */
  sectionIndex: number;
  /** スクロールトリガー要素一覧 */
  scrollTriggeredElements: ScrollTriggeredElement[];
  /** 視覚的印象の説明 */
  visualImpression: string;
  /** 信頼度 */
  confidence: number;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * 集約されたスクロールトリガーアニメーション
 */
export interface AggregatedScrollAnimation {
  /** トリガーされるスクロールY座標 */
  triggerScrollY: number;
  /** 要素の説明 */
  element: string;
  /** アニメーションタイプ */
  animationType: string;
  /** 信頼度 */
  confidence: number;
}

/**
 * スクロールVision分析の全体結果
 */
export interface ScrollVisionResult {
  /** 各キャプチャの分析結果 */
  analyses: ScrollVisionAnalysis[];
  /** 集約されたスクロールトリガーアニメーション */
  scrollTriggeredAnimations: AggregatedScrollAnimation[];
  /** 全体の処理時間（ミリ秒） */
  totalProcessingTimeMs: number;
  /** キャプチャ数 */
  captureCount: number;
  /** 分析済みキャプチャ数 */
  analyzedCount: number;
  /** 使用したVisionモデル名 */
  visionModelUsed: string;
}

/**
 * アナライザー設定
 */
export interface ScrollVisionAnalyzerConfig {
  /** Ollama API URL */
  ollamaUrl?: string | undefined;
  /** @deprecated LlamaVisionAdapter経由で動的タイムアウトが適用されるため不要。後方互換のため保持。 */
  visionTimeoutMs?: number | undefined;
  /** Visionモデル名 */
  model?: string | undefined;
  /** @deprecated LlamaVisionAdapter内部でリトライが管理されるため不要。後方互換のため保持。 */
  enableRetry?: boolean | undefined;
  /** Granular progress callback: called after each capture is analyzed */
  onProgress?: ((completed: number, total: number) => void) | undefined;
}

// =============================================================================
// Zodスキーマ
// =============================================================================

const scrollTriggeredElementSchema = z.object({
  element: z.string(),
  changeType: z.enum(['appear', 'animate', 'transform', 'lazy-load', 'parallax']),
  confidence: z.number().min(0).max(1),
});

const visionResponseSchema = z.object({
  scrollTriggeredElements: z.array(scrollTriggeredElementSchema).default([]),
  visualImpression: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.5),
});

type VisionResponse = z.infer<typeof visionResponseSchema>;

// =============================================================================
// Logger
// =============================================================================

const logger = createLogger(LOG_PREFIX);

// =============================================================================
// プロンプト生成
// =============================================================================

/**
 * Vision分析プロンプトを生成
 *
 * @param scrollY - スクロールY座標
 * @param sectionType - セクションタイプ（オプション）
 * @returns プロンプト文字列
 */
function buildAnalysisPrompt(scrollY: number, sectionType?: string): string {
  const sectionInfo = sectionType ? ` (section: ${sectionType})` : '';

  return `Analyze this web page viewport screenshot captured at scroll position ${scrollY}px${sectionInfo}.

Identify elements that appear to be scroll-triggered animations or lazy-loaded content.
Look for: fade-in effects, slide-in elements, parallax backgrounds, lazy-loaded images, transform animations.

Return ONLY valid JSON:
{
  "scrollTriggeredElements": [
    {
      "element": "<description of element>",
      "changeType": "<appear|animate|transform|lazy-load|parallax>",
      "confidence": <0.0-1.0>
    }
  ],
  "visualImpression": "<brief description of what's visible at this scroll position>",
  "confidence": <0.0-1.0>
}`;
}

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * 文字列をサニタイズ（XSS対策）
 */
function sanitizeString(str: string): string {
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/[<>"'&]/g, '')
    .trim()
    .slice(0, 500);
}

/**
 * Vision結果をバリデーション・サニタイズ
 */
function validateVisionResponse(raw: unknown): VisionResponse | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const parseResult = visionResponseSchema.safeParse(raw);
  if (!parseResult.success) {
    logger.warn('Vision response validation failed', {
      errors: parseResult.error.issues.map((i) => i.message),
    });
    return null;
  }

  return parseResult.data;
}

/**
 * 分析結果からスクロールトリガーアニメーションを集約
 */
function aggregateAnimations(
  analyses: ScrollVisionAnalysis[]
): AggregatedScrollAnimation[] {
  const animations: AggregatedScrollAnimation[] = [];

  for (const analysis of analyses) {
    for (const element of analysis.scrollTriggeredElements) {
      if (element.confidence >= MIN_CONFIDENCE_THRESHOLD) {
        animations.push({
          triggerScrollY: analysis.scrollY,
          element: element.element,
          animationType: element.changeType,
          confidence: element.confidence,
        });
      }
    }
  }

  // 信頼度でソート（高い順）
  animations.sort((a, b) => b.confidence - a.confidence);

  return animations;
}

// =============================================================================
// メイン関数
// =============================================================================

/**
 * スクロール位置キャプチャをVision分析
 *
 * 各キャプチャを順次Ollama Visionに送信し、スクロールトリガー要素を検出する。
 * Ollama未接続時はgraceful degradationで空結果を返す。
 *
 * @param captures - ScrollCapture配列
 * @param config - アナライザー設定
 * @returns 全体のVision分析結果
 */
export async function analyzeScrollCaptures(
  captures: ScrollCapture[],
  config?: ScrollVisionAnalyzerConfig
): Promise<ScrollVisionResult> {
  const startTime = Date.now();
  const model = config?.model ?? 'llama3.2-vision';

  logger.info('Starting scroll vision analysis', {
    captureCount: captures.length,
    model,
  });

  // LlamaVisionAdapter経由でVisionクライアント初期化
  // Bug fix: OllamaVisionClient直接使用（固定120秒タイムアウト）から
  // LlamaVisionAdapter経由（動的タイムアウト: GPU 180秒, CPU 180-1200秒）に変更。
  // CPU環境でVision推論が2-5分/キャプチャかかるため、固定タイムアウトでは全キャプチャが失敗していた。
  const adapter = new LlamaVisionAdapter({
    ollamaUrl: config?.ollamaUrl ?? DEFAULT_OLLAMA_URL,
  });

  // Ollama接続チェック
  const isAvailable = await adapter.isAvailable();
  if (!isAvailable) {
    logger.warn('Ollama Vision is not available, returning empty result');
    return {
      analyses: [],
      scrollTriggeredAnimations: [],
      totalProcessingTimeMs: Date.now() - startTime,
      captureCount: captures.length,
      analyzedCount: 0,
      visionModelUsed: model,
    };
  }

  // 各キャプチャを順次分析
  const analyses: ScrollVisionAnalysis[] = [];

  for (let i = 0; i < captures.length; i++) {
    const capture = captures[i]!;
    const captureStartTime = Date.now();

    try {
      const analysis = await analyzeSingleCapture(adapter, capture);
      if (analysis !== null) {
        analyses.push(analysis);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to analyze capture', {
        scrollY: capture.scrollY,
        sectionIndex: capture.sectionIndex,
        error: errorMessage,
        processingTimeMs: Date.now() - captureStartTime,
      });
      // 個別キャプチャの失敗は全体を中断しない
    }

    // Granular progress: report after each capture (fire-and-forget)
    try { config?.onProgress?.(i + 1, captures.length); } catch { /* fire-and-forget */ }
  }

  // スクロールトリガーアニメーションを集約
  const scrollTriggeredAnimations = aggregateAnimations(analyses);

  const totalProcessingTimeMs = Date.now() - startTime;

  logger.info('Scroll vision analysis completed', {
    analyzedCount: analyses.length,
    captureCount: captures.length,
    animationCount: scrollTriggeredAnimations.length,
    totalProcessingTimeMs,
  });

  return {
    analyses,
    scrollTriggeredAnimations,
    totalProcessingTimeMs,
    captureCount: captures.length,
    analyzedCount: analyses.length,
    visionModelUsed: model,
  };
}

/**
 * 単一キャプチャのVision分析
 *
 * LlamaVisionAdapter経由でVision APIを呼び出す。
 * 動的タイムアウト（GPU: 180秒, CPU: 180-1200秒）によりCPU環境でも完走する。
 *
 * @param adapter - LlamaVisionAdapter
 * @param capture - ScrollCapture
 * @returns 分析結果、またはnull（バリデーション失敗時）
 */
async function analyzeSingleCapture(
  adapter: LlamaVisionAdapter,
  capture: ScrollCapture
): Promise<ScrollVisionAnalysis | null> {
  const captureStartTime = Date.now();

  // プロンプト生成
  const prompt = buildAnalysisPrompt(capture.scrollY);

  logger.debug('Analyzing capture', {
    scrollY: capture.scrollY,
    sectionIndex: capture.sectionIndex,
    imageSize: capture.screenshot.length,
  });

  // LlamaVisionAdapter経由でVision API呼び出し（動的タイムアウト + CPU画像最適化）
  const result = await adapter.analyzeJSON<unknown>(capture.screenshot, prompt);
  const rawResult = result.response;

  logger.debug('Vision API response received', {
    scrollY: capture.scrollY,
    hardwareType: result.metrics.hardwareType,
    optimizationApplied: result.metrics.optimizationApplied,
    totalProcessingTimeMs: result.metrics.totalProcessingTimeMs,
  });

  // バリデーション
  const validated = validateVisionResponse(rawResult);
  if (validated === null) {
    logger.warn('Vision response validation failed for capture', {
      scrollY: capture.scrollY,
    });
    return null;
  }

  const processingTimeMs = Date.now() - captureStartTime;

  // 結果をサニタイズ
  const sanitizedElements: ScrollTriggeredElement[] = validated.scrollTriggeredElements
    .filter((el) => el.confidence >= MIN_CONFIDENCE_THRESHOLD)
    .map((el) => ({
      element: sanitizeString(el.element),
      changeType: el.changeType,
      confidence: el.confidence,
    }));

  logger.debug('Capture analysis completed', {
    scrollY: capture.scrollY,
    elementCount: sanitizedElements.length,
    processingTimeMs,
    hardwareType: result.metrics.hardwareType,
  });

  return {
    scrollY: capture.scrollY,
    sectionIndex: capture.sectionIndex,
    scrollTriggeredElements: sanitizedElements,
    visualImpression: sanitizeString(validated.visualImpression),
    confidence: validated.confidence,
    processingTimeMs,
  };
}
