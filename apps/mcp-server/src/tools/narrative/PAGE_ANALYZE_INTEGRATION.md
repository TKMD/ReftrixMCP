> **Note**: This integration is fully implemented as of v0.1.0. This document is retained as architectural reference.

# page.analyze 統合案 / page.analyze Integration Proposal

## 概要 / Overview

既存の`page.analyze`ツールに`narrativeOptions`を追加し、世界観・レイアウト構成分析を統合します。

Adds `narrativeOptions` to the existing `page.analyze` tool to integrate world-view and layout structure analysis.

## 現状のpage.analyzeオプション構造 / Current page.analyze Option Structure

```typescript
interface PageAnalyzeInput {
  url: string;
  features?: {
    layout?: boolean;   // レイアウト解析（デフォルトtrue） / Layout analysis (default true)
    motion?: boolean;   // モーション検出（デフォルトtrue） / Motion detection (default true)
    quality?: boolean;  // 品質評価（デフォルトtrue） / Quality evaluation (default true)
  };
  layoutOptions?: LayoutOptions;
  motionOptions?: MotionOptions;
  qualityOptions?: QualityOptions;
  // ... その他オプション / ... other options
}
```

## 追加するnarrative統合オプション / Narrative Integration Options to Add

```typescript
// apps/mcp-server/src/tools/page/schemas.ts に追加
// Add to apps/mcp-server/src/tools/page/schemas.ts

/**
 * narrative分析オプションスキーマ / Narrative analysis options schema
 * page.analyzeのnarrative統合用 / For page.analyze narrative integration
 */
export const narrativeOptionsSchema = z.object({
  /** narrative分析有効化（デフォルトtrue） / Enable narrative analysis (default true) */
  enabled: z.boolean().optional().default(true),

  /** DB保存（デフォルトtrue） / Save to DB (default true) */
  saveToDb: z.boolean().optional().default(true),

  /** Vision LLM分析使用（デフォルトtrue） / Use Vision LLM analysis (default true) */
  includeVision: z.boolean().optional().default(true),
}).optional();
export type NarrativeOptions = z.infer<typeof narrativeOptionsSchema>;
```

## page.analyze入力スキーマの拡張 / Extending page.analyze Input Schema

```typescript
// pageAnalyzeInputSchema に追加 / Add to pageAnalyzeInputSchema
export const pageAnalyzeInputSchema = z.object({
  url: z.string().url(),
  features: analysisFeaturesSchema,
  layoutOptions: layoutOptionsSchema,
  motionOptions: motionOptionsSchema,
  qualityOptions: qualityOptionsSchema,

  // 新規追加 / Newly added
  narrativeOptions: narrativeOptionsSchema,

  // ... 既存オプション / ... existing options
});
```

## page.analyze出力スキーマの拡張 / Extending page.analyze Output Schema

```typescript
// pageAnalyzeOutputSchema の data に追加 / Add to pageAnalyzeOutputSchema data
export const pageAnalyzeDataSchema = z.object({
  // 既存フィールド / Existing fields
  id: z.string().uuid(),
  url: z.string().url(),
  layout: layoutResultSchema.optional(),
  motion: motionResultSchema.optional(),
  quality: qualityResultSchema.optional(),

  // 新規追加 / Newly added
  narrative: z.object({
    id: z.string().uuid().optional(),  // DB保存時のID / ID when saved to DB
    worldView: z.object({
      moodCategory: moodCategorySchema,
      moodDescription: z.string(),
      overallTone: z.string(),
    }),
    layoutStructure: z.object({
      gridType: gridTypeSchema,
      columns: z.union([z.number(), z.literal('fluid')]),
    }),
    confidence: z.number(),
    analysisTimeMs: z.number().optional(),
    visionUsed: z.boolean().optional(),
  }).optional(),

  // ... 既存フィールド / ... existing fields
});
```

## 実装箇所 / Implementation Locations

### 1. schemas.ts の変更 / schemas.ts Changes

`apps/mcp-server/src/tools/page/schemas.ts`

- `narrativeOptionsSchema` の追加 / Add `narrativeOptionsSchema`
- `pageAnalyzeInputSchema` への `narrativeOptions` フィールド追加 / Add `narrativeOptions` field to `pageAnalyzeInputSchema`
- `pageAnalyzeDataSchema` への `narrative` フィールド追加 / Add `narrative` field to `pageAnalyzeDataSchema`

### 2. analyze.tool.ts の変更 / analyze.tool.ts Changes

`apps/mcp-server/src/tools/page/analyze.tool.ts`

- `narrativeOptions.enabled === true` の場合にNarrativeAnalysisServiceを呼び出し / Call NarrativeAnalysisService when `narrativeOptions.enabled === true`
- 既存のlayout/motion/quality分析と並列実行 / Run in parallel with existing layout/motion/quality analysis
- 分析結果をレスポンスに含める / Include analysis results in response

### 3. handlers/ の変更 / handlers/ Changes

新規ファイル / New file: `apps/mcp-server/src/tools/page/handlers/narrative-handler.ts`

```typescript
/**
 * narrative-handler.ts
 * page.analyzeからのnarrative分析ハンドラー / Narrative analysis handler for page.analyze
 */

import type { NarrativeOptions } from '../schemas';
import type { NarrativeAnalysisService } from '../../../services/narrative';

export interface NarrativeHandlerInput {
  html: string;
  screenshot?: string;
  options: NarrativeOptions;
  existingAnalysis?: {
    cssVariables?: Record<string, string>;
    motionPatterns?: unknown[];
  };
}

export interface NarrativeHandlerOutput {
  id?: string;
  worldView: {
    moodCategory: string;
    moodDescription: string;
    overallTone: string;
  };
  layoutStructure: {
    gridType: string;
    columns: number | 'fluid';
  };
  confidence: number;
  analysisTimeMs?: number;
  visionUsed?: boolean;
}

export async function handleNarrativeAnalysis(
  input: NarrativeHandlerInput,
  service: NarrativeAnalysisService
): Promise<NarrativeHandlerOutput> {
  // 実装 / Implementation
}
```

## 使用例 / Usage Examples

### narrative分析を有効化したpage.analyze呼び出し / page.analyze Call with Narrative Analysis Enabled

```typescript
// MCP Client からの呼び出し / Call from MCP Client
await mcp__reftrix__page_analyze({
  url: 'https://example.com',
  features: {
    layout: true,
    motion: true,
    quality: true,
  },
  narrativeOptions: {
    enabled: true,      // デフォルトtrue（無効化する場合はfalseを指定） / Default true (specify false to disable)
    saveToDb: true,
    includeVision: true,
  },
});
```

### レスポンス例 / Response Example

```json
{
  "success": true,
  "data": {
    "id": "uuid-webpage",
    "url": "https://example.com",
    "layout": { ... },
    "motion": { ... },
    "quality": { ... },
    "narrative": {
      "id": "uuid-narrative",
      "worldView": {
        "moodCategory": "tech",
        "moodDescription": "Modern tech-focused design with dark theme",
        "overallTone": "professional"
      },
      "layoutStructure": {
        "gridType": "css-grid",
        "columns": 12
      },
      "confidence": 0.85,
      "analysisTimeMs": 3500,
      "visionUsed": true
    },
    "analyzedAt": "2026-02-05T00:00:00Z"
  }
}
```

## 実装優先順位 / Implementation Priority

1. **Phase 1**: schemas.ts の変更（入力/出力スキーマ拡張） / schemas.ts changes (input/output schema extension)
2. **Phase 2**: narrative-handler.ts の実装 / narrative-handler.ts implementation
3. **Phase 3**: analyze.tool.ts への統合 / Integration into analyze.tool.ts
4. **Phase 4**: テスト追加 / Add tests

## 既存分析結果の再利用 / Reusing Existing Analysis Results

page.analyzeでは既にlayout/motion分析を実行しているため、その結果をnarrative分析に再利用可能:

Since page.analyze already performs layout/motion analysis, those results can be reused for narrative analysis:

- `cssVariables`: layout.inspectで抽出済み / Already extracted by layout.inspect
- `motionPatterns`: motion.detectで検出済み / Already detected by motion.detect
- `screenshot`: layout.ingestで取得済み / Already captured by layout.ingest
- `sections`: layout.inspectで検出済み / Already detected by layout.inspect

これにより、narrative分析の精度向上と処理時間短縮が期待できる。

This is expected to improve narrative analysis accuracy and reduce processing time.

## トークン効率化 / Token Efficiency

- `narrativeOptions.enabled: false` を明示的に指定した場合、narrative分析は実行されない / When `narrativeOptions.enabled: false` is explicitly specified, narrative analysis is not executed
- narrative分析を有効化しても、DB保存によりレスポンスは最小限に抑える / Even with narrative analysis enabled, response is kept minimal via DB storage
- サマリー形式（moodCategory, moodDescription, gridType, columns, confidence）のみ返却 / Only summary format (moodCategory, moodDescription, gridType, columns, confidence) is returned
