// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze MCPツール用Service層
 * Service関数をエクスポート
 *
 * @module services/page-analyze-service
 */

import { pageAnalyzeHandler } from '../tools/page/analyze.tool';
import type {
  PageAnalyzeInput,
  PageAnalyzeOutput,
} from '../tools/page/index';

/**
 * page.analyzeツールを直接実行するService関数
 * 外部モジュールから直接呼び出し可能
 *
 * @param input - page.analyze入力パラメータ
 * @returns page.analyzeの実行結果
 * @throws エラーが発生した場合、PageAnalyzeErrorOutputで返却される
 *
 * @example
 * ```typescript
 * const result = await executePageAnalyze({
 *   url: 'https://example.com',
 *   summary: true,
 *   timeout: 60000,
 * });
 *
 * if (result.ok) {
 *   console.log('Analysis result:', result.data);
 * } else {
 *   console.error('Analysis failed:', result.error);
 * }
 * ```
 */
export async function executePageAnalyze(
  input: PageAnalyzeInput
): Promise<PageAnalyzeOutput> {
  return await pageAnalyzeHandler(input);
}

// 型をre-export
export type {
  PageAnalyzeInput,
  PageAnalyzeOutput,
  PageAnalyzeData,
  PageAnalyzeError,
  LayoutResult,
  MotionResult,
  QualityResult,
  PageMetadata,
  AnalysisWarning,
} from '../tools/page/index';

// Enumsをre-export
export {
  sourceTypeSchema,
  usageScopeSchema,
  waitUntilSchema,
  gradeSchema,
  type SourceType,
  type UsageScope,
  type WaitUntil,
  type Grade,
} from '../tools/page/index';

// Schemasをre-export
export {
  pageAnalyzeInputSchema,
  pageAnalyzeOutputSchema,
  analysisFeaturesSchema,
  viewportSchema,
  layoutOptionsSchema,
  motionOptionsSchema,
  qualityOptionsSchema,
  type AnalysisFeatures,
  type Viewport,
  type LayoutOptions,
  type MotionOptions,
  type QualityOptions,
} from '../tools/page/index';

// Error codesをre-export
export {
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeErrorCode,
} from '../tools/page/index';
