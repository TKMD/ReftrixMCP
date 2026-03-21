// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LlamaVisionAdapter - 型定義・設定
 *
 * LlamaVisionAdapterの設定インターフェース、Ollama API型、デフォルト設定を提供します。
 *
 * @module vision-adapter/llama-vision.types
 */

import type { VisionFeatureType } from "./interface";

// =============================================================================
// 設定インターフェース
// =============================================================================

/**
 * LlamaVisionAdapter設定
 */
export interface LlamaVisionAdapterConfig {
  /** Ollama接続先URL (default: http://localhost:11434) */
  baseUrl?: string;
  /** 使用するモデル名 (default: llama3.2-vision) */
  modelName?: string;

  /** リクエストタイムアウト (default: 60000ms) */
  requestTimeout?: number;
  /** 接続タイムアウト (default: 10000ms) */
  connectionTimeout?: number;

  /** 最大リトライ回数 (default: 3) */
  maxRetries?: number;
  /** リトライ間隔 (default: 1000ms) */
  retryDelay?: number;

  /** デフォルトで解析する特徴タイプ */
  defaultFeatures?: VisionFeatureType[];
  /** 最大画像サイズ (bytes, default: 20MB) */
  maxImageSize?: number;

  /** システムプロンプト */
  systemPrompt?: string;
  /** 解析プロンプト */
  analysisPrompt?: string;
}

// =============================================================================
// Ollama API型定義
// =============================================================================

/**
 * Ollama /api/generate リクエスト
 */
export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  images?: string[];
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

/**
 * Ollama /api/generate レスポンス
 */
export interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

/**
 * Ollama /api/tags レスポンス
 */
export interface OllamaTagsResponse {
  models: Array<{
    name: string;
    size: number;
    modified_at: string;
  }>;
}

// =============================================================================
// 定数
// =============================================================================

export const DEFAULT_CONFIG: Required<LlamaVisionAdapterConfig> = {
  baseUrl: "http://localhost:11434",
  modelName: "llama3.2-vision",
  requestTimeout: 60000,
  connectionTimeout: 10000,
  maxRetries: 3,
  retryDelay: 1000,
  defaultFeatures: ["layout_structure", "color_palette"],
  maxImageSize: 20 * 1024 * 1024, // 20MB
  systemPrompt: "",
  analysisPrompt: "",
};
