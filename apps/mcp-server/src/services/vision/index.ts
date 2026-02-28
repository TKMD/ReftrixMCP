// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision Services - Index
 *
 * Phase 5: Vision AI分析サービスのエクスポート
 *
 * 含まれるサービス:
 * - VisionCache: LRUキャッシュ + TTL機能
 * - MoodAnalyzer: ムード分析サービス（Ollama llama3.2-vision）
 * - BrandToneAnalyzer: ブランドトーン分析サービス（Ollama llama3.2-vision）
 * - ProgressReporter: 進捗報告サービス（Vision CPU完走保証 Phase 4）
 */

// VisionCache
export {
  VisionCache,
  type VisionCacheConfig,
  type CacheStats,
} from './vision.cache.js';

// MoodAnalyzer
export {
  MoodAnalyzer,
  VALID_MOODS,
  type MoodType,
  type MoodAnalysisResult,
  type MoodAnalyzerConfig,
  type ColorContext as MoodColorContext,
} from './mood.analyzer.js';

// BrandToneAnalyzer
export {
  BrandToneAnalyzer,
  VALID_BRAND_TONES,
  PROFESSIONALISM_LEVELS,
  WARMTH_LEVELS,
  MODERNITY_LEVELS,
  ENERGY_LEVELS,
  TARGET_AUDIENCES,
  type BrandToneType,
  type ProfessionalismLevel,
  type WarmthLevel,
  type ModernityLevel,
  type EnergyLevel,
  type TargetAudienceType,
  type BrandToneAnalysisResult,
  type BrandToneAnalyzerConfig,
  type ColorContext as BrandToneColorContext,
} from './brandtone.analyzer.js';

// ThemeAnalyzer
export {
  ThemeAnalyzer,
  themeAnalyzer,
  type ThemeAnalysisResult,
  type ThemeAnalyzerConfig,
} from './theme.analyzer.js';

// Vision Prompts (Theme types)
export { VALID_THEMES, type ThemeType } from './vision.prompts.js';

// HardwareDetector (Vision CPU完走保証 Phase 1)
export {
  HardwareDetector,
  HardwareType,
  HARDWARE_CACHE_TTL_MS,
  type HardwareInfo,
  type HardwareDetectorConfig,
} from './hardware-detector.js';

// TimeoutCalculator (Vision CPU完走保証 Phase 1)
export {
  TimeoutCalculator,
  ImageSize,
  VisionTimeouts,
} from './timeout-calculator.js';

// OllamaVisionClient
export {
  OllamaVisionClient,
  type OllamaVisionClientConfig,
} from './ollama-vision-client.js';

// Vision Errors
export {
  VisionAnalysisError,
  CacheError,
  isVisionAnalysisError,
  isRetryableError,
  getErrorMessage,
  type VisionErrorCode,
} from './vision.errors.js';

// ImageOptimizer (Vision CPU完走保証 Phase 2)
export {
  ImageOptimizer,
  OptimizationStrategy,
  IMAGE_SIZE_THRESHOLDS,
  OPTIMIZATION_CONFIGS,
  type OptimizeOptions,
  type OptimizeResult,
  type ImageDimensions,
  type OptimizationConfig,
} from './image-optimizer.js';

// LlamaVisionAdapter (Vision CPU完走保証 Phase 2)
export {
  LlamaVisionAdapter,
  type VisionAnalysisOptions,
  type VisionAnalysisResult,
  type VisionAnalysisMetrics,
  type LlamaVisionAdapterConfig,
} from './llama-vision-adapter.js';

// VisionFallbackService (Vision CPU完走保証 Phase 3)
export {
  VisionFallbackService,
  type VisionFallbackOptions,
  type HTMLAnalysisResult,
  type FallbackResult,
  type VisionFallbackServiceConfig,
} from './vision-fallback.service.js';

// ProgressReporter (Vision CPU完走保証 Phase 4)
export {
  ProgressReporter,
  ProgressPhase,
  type ProgressEvent,
  type ProgressCallback,
  type ProgressReporterConfig,
} from './progress-reporter.js';

// MCPProgressAdapter (Vision CPU完走保証 Phase 4 - MCPツール進捗コールバック対応)
export {
  MCPProgressAdapter,
  createMCPProgressCallback,
  type MCPProgressNotification,
  type MCPProgressOptions,
  type SendNotificationFn,
} from './mcp-progress-adapter.js';
