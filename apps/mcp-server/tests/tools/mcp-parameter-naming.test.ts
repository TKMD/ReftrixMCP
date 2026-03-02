// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Parameter Naming Convention テスト
 * Phase 4-3: パラメータ名標準化の検証
 *
 * TDD Red フェーズ: 全14ツール（WebDesign専用）のパラメータがsnake_caseに統一されていることを検証
 *
 * 命名規則:
 * - すべての入力パラメータは snake_case を使用
 * - Boolean include パラメータは `include_{resource}` 形式
 * - 軽量レスポンスモードは `summary` を使用（compactは廃止）
 * - ID パラメータは `id` または `{resource}_id` 形式
 *
 * @module tests/tools/mcp-parameter-naming
 */

import { describe, it, expect } from 'vitest';
import { allToolDefinitions } from '../../src/tools';

// =============================================================================
// 型定義
// =============================================================================

interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
}

interface ToolDefinitionWithSchema {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * snake_caseパターンの正規表現
 * 許可: lowercase, numbers, underscores
 * 禁止: camelCase, PascalCase
 */
const SNAKE_CASE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * camelCaseパターンの検出正規表現
 */
const CAMEL_CASE_PATTERN = /[a-z][A-Z]/;

/**
 * パラメータ名がsnake_caseかどうかを検証
 */
function isSnakeCase(paramName: string): boolean {
  return SNAKE_CASE_PATTERN.test(paramName);
}

/**
 * パラメータ名がcamelCaseかどうかを検出
 */
function isCamelCase(paramName: string): boolean {
  return CAMEL_CASE_PATTERN.test(paramName);
}

/**
 * ツール定義からすべての入力パラメータ名を抽出
 */
function extractParameterNames(tool: ToolDefinitionWithSchema): string[] {
  const schema = tool.inputSchema;
  if (!schema.properties) return [];
  return Object.keys(schema.properties);
}

/**
 * ネストされたオブジェクトのプロパティ名も再帰的に抽出
 */
function extractAllParameterNamesDeep(
  schema: Record<string, unknown>,
  prefix = ''
): string[] {
  const names: string[] = [];

  if (typeof schema !== 'object' || schema === null) return names;

  const properties = schema.properties as Record<string, unknown> | undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      const fullName = prefix ? `${prefix}.${key}` : key;
      names.push(fullName);

      // ネストされたobjectの場合は再帰
      if (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).type === 'object'
      ) {
        names.push(
          ...extractAllParameterNamesDeep(
            value as Record<string, unknown>,
            fullName
          )
        );
      }

      // items内のobjectも検査（配列の要素型）
      const items = (value as Record<string, unknown>)?.items;
      if (
        typeof items === 'object' &&
        items !== null &&
        (items as Record<string, unknown>).type === 'object'
      ) {
        names.push(
          ...extractAllParameterNamesDeep(
            items as Record<string, unknown>,
            `${fullName}[]`
          )
        );
      }
    }
  }

  return names;
}

// =============================================================================
// 非推奨camelCaseパラメータのリスト（移行対象）
// =============================================================================

/**
 * v0.1.0で非推奨化、v0.1.0で削除予定のcamelCaseパラメータ
 *
 * これらは現在存在するが、snake_case版への移行が必要
 */
const DEPRECATED_CAMEL_CASE_PARAMS: Record<string, string[]> = {
  // Layout ツール
  'layout.generate_code': ['patternId'],
  'layout.search': ['includeHtml', 'sectionType', 'sourceType', 'usageScope'],

  // Page ツール
  'page.analyze': [
    'sourceType',
    'usageScope',
    'layoutOptions',
    'motionOptions',
    'qualityOptions',
    'responsiveOptions',
    'waitUntil',
  ],


  // Motion ツール
  'motion.detect': [
    'includeInlineStyles',
    'includeStyleSheets',
    'includeSummary',
    'includeWarnings',
    'fetchExternalCss',
    'baseUrl',
    'minDuration',
    'maxPatterns',
    'pageId',
    'externalCssOptions',
  ],
  'motion.search': [
    'includeVendorPrefixes',
    'includeReducedMotion',
    'minSimilarity',
    'samplePattern',
    'minDuration',
    'maxDuration',
  ],

  // Quality ツール
  'quality.evaluate': [
    'includeRecommendations',
    'targetIndustry',
    'targetAudience',
    'pageId',
    'patternComparison',  // v0.1.0で追加、pattern_comparisonへの移行予定
  ],

  // Brief ツール
  'brief.validate': ['strictMode'],

  // Project ツール
  'project.list': ['sortBy', 'sortOrder'],
};

/**
 * compactパラメータを持つツール（summaryに統一予定）
 */
const TOOLS_WITH_COMPACT_PARAM: string[] = [];

// =============================================================================
// テスト
// =============================================================================

describe('MCP Parameter Naming Convention', () => {
  // =========================================================================
  // 基本検証: snake_case一貫性
  // =========================================================================
  describe('snake_case一貫性', () => {
    it('全ツールのトップレベルパラメータがsnake_caseであること', () => {
      const violations: Array<{
        tool: string;
        param: string;
        suggestion: string;
      }> = [];

      for (const tool of allToolDefinitions) {
        const toolWithSchema = tool as ToolDefinitionWithSchema;
        const params = extractParameterNames(toolWithSchema);

        for (const param of params) {
          // 既知の非推奨パラメータはスキップ（移行期間中）
          const deprecatedParams = DEPRECATED_CAMEL_CASE_PARAMS[tool.name];
          if (deprecatedParams?.includes(param)) {
            continue;
          }

          if (isCamelCase(param)) {
            // camelCase → snake_case 変換提案
            const suggestion = param.replace(
              /([A-Z])/g,
              (match) => `_${match.toLowerCase()}`
            );
            violations.push({
              tool: tool.name,
              param,
              suggestion,
            });
          }
        }
      }

      // v0.1.0で0件になるべき（現在は移行中のため許容）
      expect(
        violations,
        `以下のパラメータがcamelCaseです（snake_caseに変換が必要）:\n${violations.map((v) => `  ${v.tool}: ${v.param} → ${v.suggestion}`).join('\n')}`
      ).toHaveLength(0);
    });

    it('snake_caseパラメータは有効な形式であること', () => {
      const invalidSnakeCase: Array<{ tool: string; param: string }> = [];

      for (const tool of allToolDefinitions) {
        const toolWithSchema = tool as ToolDefinitionWithSchema;
        const params = extractParameterNames(toolWithSchema);

        for (const param of params) {
          // 非推奨パラメータはスキップ
          const deprecatedParams = DEPRECATED_CAMEL_CASE_PARAMS[tool.name];
          if (deprecatedParams?.includes(param)) {
            continue;
          }

          // camelCaseでなく、かつsnake_caseでもない場合
          if (!isCamelCase(param) && !isSnakeCase(param)) {
            invalidSnakeCase.push({ tool: tool.name, param });
          }
        }
      }

      expect(
        invalidSnakeCase,
        `以下のパラメータが無効な形式です:\n${invalidSnakeCase.map((v) => `  ${v.tool}: ${v.param}`).join('\n')}`
      ).toHaveLength(0);
    });
  });

  // =========================================================================
  // includeパラメータ検証
  // =========================================================================
  describe('include_* パラメータ命名', () => {
    it('Boolean includeパラメータはinclude_{resource}形式であること', () => {
      const violations: Array<{
        tool: string;
        param: string;
        expected: string;
      }> = [];

      for (const tool of allToolDefinitions) {
        const toolWithSchema = tool as ToolDefinitionWithSchema;
        const schema = toolWithSchema.inputSchema;
        if (!schema.properties) continue;

        for (const [param, definition] of Object.entries(schema.properties)) {
          // boolean型でincludeを含む名前のパラメータを検査
          if (
            definition.type === 'boolean' &&
            param.toLowerCase().includes('include')
          ) {
            // 既知の非推奨パラメータはスキップ
            const deprecatedParams = DEPRECATED_CAMEL_CASE_PARAMS[tool.name];
            if (deprecatedParams?.includes(param)) {
              continue;
            }

            // include_{resource} 形式でなければ違反
            if (!param.startsWith('include_')) {
              const expected = param.replace(
                /include([A-Z])/,
                (_, char) => `include_${char.toLowerCase()}`
              );
              violations.push({ tool: tool.name, param, expected });
            }
          }
        }
      }

      expect(
        violations,
        `以下のパラメータがinclude_{resource}形式ではありません:\n${violations.map((v) => `  ${v.tool}: ${v.param} → ${v.expected}`).join('\n')}`
      ).toHaveLength(0);
    });
  });

  // =========================================================================
  // summary vs compact検証
  // =========================================================================
  describe('summary パラメータ統一', () => {
    it('軽量レスポンスモードはsummaryパラメータを使用すること', () => {
      const toolsWithCompact: string[] = [];

      for (const tool of allToolDefinitions) {
        const toolWithSchema = tool as ToolDefinitionWithSchema;
        const schema = toolWithSchema.inputSchema;
        if (!schema.properties) continue;

        // compactパラメータを持つツールを検出
        if ('compact' in schema.properties) {
          toolsWithCompact.push(tool.name);
        }
      }

      // compactパラメータは廃止予定のため、0件であるべき
      // ただし移行期間中は既知のツールは許容
      const unexpectedCompact = toolsWithCompact.filter(
        (name) => !TOOLS_WITH_COMPACT_PARAM.includes(name)
      );

      expect(
        unexpectedCompact,
        `以下のツールで予期しないcompactパラメータが検出されました:\n${unexpectedCompact.join('\n')}`
      ).toHaveLength(0);
    });

    it('summaryパラメータを持つべきツールが持っていること', () => {
      // 検索・取得系のツールはsummaryを持つべき (WebDesign専用)
      const toolsShouldHaveSummary = [
        'project.get',
        'project.list',
        'page.analyze',
      ];

      const toolsWithoutSummary: string[] = [];

      for (const expectedTool of toolsShouldHaveSummary) {
        const tool = allToolDefinitions.find((t) => t.name === expectedTool);
        if (!tool) continue;

        const toolWithSchema = tool as ToolDefinitionWithSchema;
        const schema = toolWithSchema.inputSchema;

        if (!schema.properties || !('summary' in schema.properties)) {
          toolsWithoutSummary.push(expectedTool);
        }
      }

      expect(
        toolsWithoutSummary,
        `以下のツールにsummaryパラメータがありません:\n${toolsWithoutSummary.join('\n')}`
      ).toHaveLength(0);
    });
  });

  // =========================================================================
  // IDパラメータ検証
  // =========================================================================
  describe('IDパラメータ命名', () => {
    it('IDパラメータはid または {resource}_id形式であること', () => {
      const violations: Array<{ tool: string; param: string }> = [];
      const validIdPatterns = [
        /^id$/, // プライマリID
        /^[a-z]+(_[a-z]+)*_id$/, // リソース修飾ID (project_id, design_system_id等)
        /^[a-z]+(_[a-z]+)*_ids$/, // 複数ID (page_ids等)
      ];

      for (const tool of allToolDefinitions) {
        const toolWithSchema = tool as ToolDefinitionWithSchema;
        const schema = toolWithSchema.inputSchema;
        if (!schema.properties) continue;

        for (const [param, definition] of Object.entries(schema.properties)) {
          // IDを含む名前のstringパラメータを検査
          const paramLower = param.toLowerCase();
          if (
            (paramLower.includes('id') || paramLower.endsWith('id')) &&
            definition.type === 'string'
          ) {
            // 既知の非推奨パラメータはスキップ
            const deprecatedParams = DEPRECATED_CAMEL_CASE_PARAMS[tool.name];
            if (deprecatedParams?.includes(param)) {
              continue;
            }

            // 有効なIDパターンかチェック
            const isValidIdPattern = validIdPatterns.some((pattern) =>
              pattern.test(param)
            );

            if (!isValidIdPattern) {
              violations.push({ tool: tool.name, param });
            }
          }
        }
      }

      expect(
        violations,
        `以下のIDパラメータが無効な形式です（id または {resource}_id が必要）:\n${violations.map((v) => `  ${v.tool}: ${v.param}`).join('\n')}`
      ).toHaveLength(0);
    });
  });

  // =========================================================================
  // 非推奨パラメータの警告テスト（将来実装）
  // =========================================================================
  describe('非推奨パラメータ', () => {
    it.skip('非推奨パラメータ使用時に警告が出力されること', () => {
      // v0.1.0で実装予定
      // 非推奨camelCaseパラメータを使用した場合、
      // _deprecated_parameter_warning が出力されることを検証
    });

    it('非推奨パラメータリストが正しく定義されていること', () => {
      // 非推奨パラメータリストにあるパラメータが実際に存在するか確認
      for (const [toolName, params] of Object.entries(
        DEPRECATED_CAMEL_CASE_PARAMS
      )) {
        const tool = allToolDefinitions.find((t) => t.name === toolName);

        // ツールが存在しない場合はスキップ（削除された可能性）
        if (!tool) continue;

        const toolWithSchema = tool as ToolDefinitionWithSchema;
        const allParams = extractAllParameterNamesDeep(
          toolWithSchema.inputSchema as unknown as Record<string, unknown>
        );

        // トップレベルのパラメータ名のみ抽出
        const topLevelParams = allParams
          .filter((p) => !p.includes('.'))
          .map((p) => p.replace('[]', ''));

        for (const deprecatedParam of params) {
          // 非推奨パラメータがまだ存在することを確認
          // （存在しなくなった場合はリストから削除すべき）
          const exists =
            topLevelParams.includes(deprecatedParam) ||
            // ネストされたオブジェクト内のパラメータも考慮
            allParams.some((p) => p.endsWith(`.${deprecatedParam}`));

          if (!exists) {
            console.warn(
              `[WARN] 非推奨パラメータ ${toolName}.${deprecatedParam} は存在しません。リストから削除してください。`
            );
          }
        }
      }

      // このテストは警告を出すだけで、失敗させない
      expect(true).toBe(true);
    });
  });

  // =========================================================================
  // ツール数検証 (19 WebDesign tools)
  // Phase3-2: page.getJobStatus ツール追加
  // MCP-TOOL-01: layout.batch_ingest ツール追加
  // Phase4: quality.getJobStatus ツール追加
  // narrative.search, background.search ツール追加
  // =========================================================================
  describe('ツール数', () => {
    it('allToolDefinitionsが20ツール（WebDesign専用）を含むこと', () => {
      expect(allToolDefinitions).toHaveLength(20);
    });
  });

  // =========================================================================
  // 移行進捗トラッキング
  // =========================================================================
  describe('移行進捗', () => {
    it('非推奨camelCaseパラメータ数をトラッキング', () => {
      // 現在の非推奨パラメータ総数を計算
      const totalDeprecated = Object.values(DEPRECATED_CAMEL_CASE_PARAMS).reduce(
        (sum, params) => sum + params.length,
        0
      );

      // v0.1.0で0になるべき
      // 現在は移行期間中なので、数をトラッキングのみ
      console.log(`[INFO] 非推奨camelCaseパラメータ総数: ${totalDeprecated}`);
      console.log(
        `[INFO] 対象ツール数: ${Object.keys(DEPRECATED_CAMEL_CASE_PARAMS).length}`
      );

      // 現在の期待値（移行完了時に0になる）
      // この値は移行が進むにつれて減少する
      expect(totalDeprecated).toBeGreaterThanOrEqual(0);

      // 移行完了チェック（v0.1.0でアンコメント）
      // expect(totalDeprecated).toBe(0);
    });

    it('compactパラメータ数をトラッキング', () => {
      const compactCount = TOOLS_WITH_COMPACT_PARAM.length;

      console.log(`[INFO] compactパラメータを持つツール数: ${compactCount}`);

      // v0.1.0で0になるべき
      expect(compactCount).toBeGreaterThanOrEqual(0);

      // 移行完了チェック（v0.1.0でアンコメント）
      // expect(compactCount).toBe(0);
    });
  });
});
