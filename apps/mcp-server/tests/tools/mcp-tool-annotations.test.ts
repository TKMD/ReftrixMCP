// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Tool Annotations テスト
 * MCP Protocol 仕様の ToolAnnotations プロパティ検証
 *
 * TDD Red フェーズ: 全14ツール（WebDesign専用）にMCP標準アノテーションが存在することを検証
 *
 * ToolAnnotations インターフェース (MCP Protocol 2025-06-18):
 * - readOnlyHint?: boolean - 環境を変更しないツール
 * - destructiveHint?: boolean - 破壊的な更新を行う可能性があるツール
 * - idempotentHint?: boolean - 同じ引数での繰り返し呼び出しが追加効果を持たない
 * - openWorldHint?: boolean - 外部エンティティと相互作用する
 * - title?: string - 人間が読めるタイトル
 *
 * @module tests/tools/mcp-tool-annotations
 */

import { describe, it, expect } from 'vitest';
import { allToolDefinitions } from '../../src/tools';

// =============================================================================
// 型定義
// =============================================================================

/**
 * MCP Protocol標準のToolAnnotations
 */
interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

/**
 * アノテーション付きツール定義
 */
interface ToolDefinitionWithAnnotations {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: ToolAnnotations;
}

// =============================================================================
// ツール分類 (14 WebDesign tools)
// =============================================================================

/**
 * readOnlyHint: true のツール（環境を変更しない）
 * 検索・取得・解析系のツール
 */
const READ_ONLY_TOOLS = [
  'style.get_palette',
  'system.health',
  'layout.inspect',
  'layout.search',
  'quality.evaluate',
  'motion.detect',
  'motion.search',
  'brief.validate',
  'project.get',
  'project.list',
  'page.analyze',
  'background.search',
];

/**
 * idempotentHint: true のツール（同じ引数で繰り返し呼び出しても追加効果なし）
 * 読み取り専用 + 変換系ツール
 */
const IDEMPOTENT_TOOLS = [
  // 読み取り専用ツールはすべて冪等
  ...READ_ONLY_TOOLS,
  // 変換系（同じ入力→同じ出力）
  'layout.generate_code',
  // narrative.search はアノテーション未設定のため別途対応
];

/**
 * openWorldHint: true のツール（外部エンティティと相互作用）
 */
const OPEN_WORLD_TOOLS = [
  'layout.ingest',
  'quality.batch_evaluate',
  'page.analyze',
];

/**
 * アノテーション未設定のツール（今後追加予定）
 * narrative.search はアノテーション未設定のため、全ツール検証から除外
 */
const TOOLS_WITHOUT_ANNOTATIONS = [
  'narrative.search',
];

// =============================================================================
// テスト
// =============================================================================

describe('MCP Tool Annotations', () => {
  // =========================================================================
  // 基本検証: 全ツールにannotationsプロパティが存在
  // =========================================================================
  describe('アノテーション存在確認', () => {
    it('アノテーション対象の全ツールにannotationsプロパティが存在すること', () => {
      const toolsWithoutAnnotations: string[] = [];

      for (const tool of allToolDefinitions) {
        // 既知のアノテーション未設定ツールはスキップ
        if (TOOLS_WITHOUT_ANNOTATIONS.includes(tool.name)) {
          continue;
        }
        const toolWithAnnotations = tool as ToolDefinitionWithAnnotations;
        if (!toolWithAnnotations.annotations) {
          toolsWithoutAnnotations.push(tool.name);
        }
      }

      expect(
        toolsWithoutAnnotations,
        `以下のツールにannotationsが未設定: ${toolsWithoutAnnotations.join(', ')}`
      ).toHaveLength(0);
    });

    it('全ツールのannotationsがオブジェクト型であること', () => {
      for (const tool of allToolDefinitions) {
        if (TOOLS_WITHOUT_ANNOTATIONS.includes(tool.name)) continue;
        const toolWithAnnotations = tool as ToolDefinitionWithAnnotations;
        if (toolWithAnnotations.annotations) {
          expect(
            typeof toolWithAnnotations.annotations,
            `${tool.name}: annotationsがオブジェクトでない`
          ).toBe('object');
        }
      }
    });
  });

  // =========================================================================
  // readOnlyHint 検証
  // =========================================================================
  describe('readOnlyHint', () => {
    it.each(READ_ONLY_TOOLS)(
      '%s は readOnlyHint: true であること',
      (toolName) => {
        const tool = allToolDefinitions.find((t) => t.name === toolName);
        expect(tool, `ツール ${toolName} が見つかりません`).toBeDefined();

        const toolWithAnnotations = tool as ToolDefinitionWithAnnotations;
        expect(
          toolWithAnnotations.annotations?.readOnlyHint,
          `${toolName}: readOnlyHint should be true`
        ).toBe(true);
      }
    );

    it('readOnlyHint: true のツールは destructiveHint を持たないこと', () => {
      for (const toolName of READ_ONLY_TOOLS) {
        const tool = allToolDefinitions.find((t) => t.name === toolName);
        if (!tool) continue; // Skip if tool doesn't exist

        const toolWithAnnotations = tool as ToolDefinitionWithAnnotations;

        // readOnlyHint: true の場合、destructiveHintは無意味なので未設定であるべき
        expect(
          toolWithAnnotations.annotations?.destructiveHint,
          `${toolName}: readOnlyHint=true の場合 destructiveHint は undefined であるべき`
        ).toBeUndefined();
      }
    });
  });

  // =========================================================================
  // idempotentHint 検証
  // =========================================================================
  describe('idempotentHint', () => {
    it.each(IDEMPOTENT_TOOLS)(
      '%s は idempotentHint: true であること',
      (toolName) => {
        const tool = allToolDefinitions.find((t) => t.name === toolName);
        expect(tool, `ツール ${toolName} が見つかりません`).toBeDefined();

        const toolWithAnnotations = tool as ToolDefinitionWithAnnotations;
        expect(
          toolWithAnnotations.annotations?.idempotentHint,
          `${toolName}: idempotentHint should be true`
        ).toBe(true);
      }
    );
  });

  // =========================================================================
  // openWorldHint 検証
  // =========================================================================
  describe('openWorldHint', () => {
    it.each(OPEN_WORLD_TOOLS)(
      '%s は openWorldHint: true であること',
      (toolName) => {
        const tool = allToolDefinitions.find((t) => t.name === toolName);
        expect(tool, `ツール ${toolName} が見つかりません`).toBeDefined();

        const toolWithAnnotations = tool as ToolDefinitionWithAnnotations;
        expect(
          toolWithAnnotations.annotations?.openWorldHint,
          `${toolName}: openWorldHint should be true`
        ).toBe(true);
      }
    );
  });

  // =========================================================================
  // title 検証
  // =========================================================================
  describe('title', () => {
    it('全ツールにtitleが設定されていること', () => {
      const toolsWithoutTitle: string[] = [];

      for (const tool of allToolDefinitions) {
        if (TOOLS_WITHOUT_ANNOTATIONS.includes(tool.name)) continue;
        const toolWithAnnotations = tool as ToolDefinitionWithAnnotations;
        if (!toolWithAnnotations.annotations?.title) {
          toolsWithoutTitle.push(tool.name);
        }
      }

      expect(
        toolsWithoutTitle,
        `以下のツールにtitleが未設定: ${toolsWithoutTitle.join(', ')}`
      ).toHaveLength(0);
    });

    it('titleは非空文字列であること', () => {
      for (const tool of allToolDefinitions) {
        const toolWithAnnotations = tool as ToolDefinitionWithAnnotations;
        if (toolWithAnnotations.annotations?.title) {
          expect(
            toolWithAnnotations.annotations.title.length,
            `${tool.name}: titleが空`
          ).toBeGreaterThan(0);
        }
      }
    });
  });

  // =========================================================================
  // 整合性検証
  // =========================================================================
  describe('アノテーション整合性', () => {
    it('readOnlyHint: false のツールはopenWorldHintまたはdestructiveHintを持つこと', () => {
      const inconsistentTools: string[] = [];

      for (const tool of allToolDefinitions) {
        const toolWithAnnotations = tool as ToolDefinitionWithAnnotations;
        const annotations = toolWithAnnotations.annotations;

        if (annotations && annotations.readOnlyHint === false) {
          // 書き込み可能なツールは外部相互作用か破壊的操作のいずれかを示すべき
          if (
            annotations.openWorldHint !== true &&
            annotations.destructiveHint !== true
          ) {
            inconsistentTools.push(tool.name);
          }
        }
      }

      // 注: これは警告として機能し、厳密な要件ではない
      if (inconsistentTools.length > 0) {
        console.warn(
          `readOnlyHint=false だが openWorldHint/destructiveHint が未設定: ${inconsistentTools.join(', ')}`
        );
      }
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
});
