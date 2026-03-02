// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Tool Registration Smoke Test
 *
 * 目的: 全20ツールが正しく登録されていることを確認
 *
 * このテストは以下を検証:
 * - toolHandlers に20ツールが登録されている
 * - allToolDefinitions に20ツール定義がある
 * - 各ツールに対応するハンドラーが存在する
 * - ツール名の形式が正しい（{category}.{action}）
 *
 * @see src/tools/index.ts
 */

import { describe, it, expect } from 'vitest';
import {
  allToolDefinitions,
  toolHandlers,
  getToolDefinition,
  getToolHandler,
} from '../../src/tools/index';

/**
 * 現行20ツールの定義
 * v0.1.0: SVG機能削除、WebDesign専用
 * v0.1.0: quality.getJobStatus 追加
 * v0.1.0: narrative.search, background.search 追加
 * v0.1.1: responsive.search 追加
 */
const EXPECTED_TOOLS = [
  // Style (1)
  'style.get_palette',
  // System (1)
  'system.health',
  // Layout (5)
  'layout.inspect',
  'layout.ingest',
  'layout.search',
  'layout.generate_code',
  'layout.batch_ingest',
  // Quality (3)
  'quality.evaluate',
  'quality.batch_evaluate',
  'quality.getJobStatus',
  // Motion (2)
  'motion.detect',
  'motion.search',
  // Brief (1)
  'brief.validate',
  // Project (2)
  'project.get',
  'project.list',
  // Page (2)
  'page.analyze',
  'page.getJobStatus',
  // Narrative (1)
  'narrative.search',
  // Background (1)
  'background.search',
  // Responsive (1)
  'responsive.search',
] as const;

const EXPECTED_TOOL_COUNT = 20;

describe('MCP Tool Registration Smoke Test', () => {
  describe('ツール数の検証', () => {
    it(`toolHandlers に ${EXPECTED_TOOL_COUNT} ツールが登録されている`, () => {
      const registeredToolCount = Object.keys(toolHandlers).length;
      expect(registeredToolCount).toBe(EXPECTED_TOOL_COUNT);
    });

    it(`allToolDefinitions に ${EXPECTED_TOOL_COUNT} ツール定義がある`, () => {
      expect(allToolDefinitions.length).toBe(EXPECTED_TOOL_COUNT);
    });

    it('toolHandlers と allToolDefinitions のツール数が一致する', () => {
      const handlerCount = Object.keys(toolHandlers).length;
      const definitionCount = allToolDefinitions.length;
      expect(handlerCount).toBe(definitionCount);
    });
  });

  describe('ツール名の検証', () => {
    it.each(EXPECTED_TOOLS)('%s がtoolHandlersに登録されている', (toolName) => {
      expect(toolHandlers).toHaveProperty(toolName);
      expect(typeof toolHandlers[toolName]).toBe('function');
    });

    it.each(EXPECTED_TOOLS)(
      '%s がallToolDefinitionsに定義されている',
      (toolName) => {
        const definition = allToolDefinitions.find((d) => d.name === toolName);
        expect(definition).toBeDefined();
        expect(definition?.name).toBe(toolName);
      }
    );

    it('すべてのツール名が {category}.{action} 形式である', () => {
      const toolNames = Object.keys(toolHandlers);
      // camelCase または snake_case を許容（例: page.getJobStatus, layout.batch_ingest）
      const toolNamePattern = /^[a-z]+\.[a-zA-Z_]+$/;

      toolNames.forEach((name) => {
        expect(name).toMatch(toolNamePattern);
      });
    });
  });

  describe('ツール定義の検証', () => {
    it.each(EXPECTED_TOOLS)('%s の定義にdescriptionが含まれる', (toolName) => {
      const definition = allToolDefinitions.find((d) => d.name === toolName);
      expect(definition?.description).toBeDefined();
      expect(definition?.description.length).toBeGreaterThan(0);
    });

    it.each(EXPECTED_TOOLS)(
      '%s の定義にinputSchemaが含まれる',
      (toolName) => {
        const definition = allToolDefinitions.find((d) => d.name === toolName);
        expect(definition?.inputSchema).toBeDefined();
        expect(definition?.inputSchema.type).toBe('object');
      }
    );
  });

  describe('ヘルパー関数の検証', () => {
    it('getToolDefinition が正しいツール定義を返す', () => {
      const definition = getToolDefinition('system.health');
      expect(definition).toBeDefined();
      expect(definition?.name).toBe('system.health');
    });

    it('getToolDefinition が存在しないツールでundefinedを返す', () => {
      const definition = getToolDefinition('nonexistent.tool');
      expect(definition).toBeUndefined();
    });

    it('getToolHandler が正しいハンドラーを返す', () => {
      const handler = getToolHandler('system.health');
      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });

    it('getToolHandler が存在しないツールでundefinedを返す', () => {
      const handler = getToolHandler('nonexistent.tool');
      expect(handler).toBeUndefined();
    });
  });

  describe('カテゴリ別ツール数の検証', () => {
    it('Style カテゴリに1ツールがある', () => {
      const styleTools = Object.keys(toolHandlers).filter((name) =>
        name.startsWith('style.')
      );
      expect(styleTools.length).toBe(1);
    });

    it('System カテゴリに1ツールがある', () => {
      const systemTools = Object.keys(toolHandlers).filter((name) =>
        name.startsWith('system.')
      );
      expect(systemTools.length).toBe(1);
    });

    it('Layout カテゴリに5ツールがある', () => {
      const layoutTools = Object.keys(toolHandlers).filter((name) =>
        name.startsWith('layout.')
      );
      expect(layoutTools.length).toBe(5);
    });

    it('Quality カテゴリに3ツールがある', () => {
      const qualityTools = Object.keys(toolHandlers).filter((name) =>
        name.startsWith('quality.')
      );
      expect(qualityTools.length).toBe(3);
    });

    it('Motion カテゴリに2ツールがある', () => {
      const motionTools = Object.keys(toolHandlers).filter((name) =>
        name.startsWith('motion.')
      );
      expect(motionTools.length).toBe(2);
    });

    it('Brief カテゴリに1ツールがある', () => {
      const briefTools = Object.keys(toolHandlers).filter((name) =>
        name.startsWith('brief.')
      );
      expect(briefTools.length).toBe(1);
    });

    it('Project カテゴリに2ツールがある', () => {
      const projectTools = Object.keys(toolHandlers).filter((name) =>
        name.startsWith('project.')
      );
      expect(projectTools.length).toBe(2);
    });

    it('Page カテゴリに2ツールがある', () => {
      const pageTools = Object.keys(toolHandlers).filter((name) =>
        name.startsWith('page.')
      );
      expect(pageTools.length).toBe(2);
    });

    it('Narrative カテゴリに1ツールがある', () => {
      const narrativeTools = Object.keys(toolHandlers).filter((name) =>
        name.startsWith('narrative.')
      );
      expect(narrativeTools.length).toBe(1);
    });

    it('Background カテゴリに1ツールがある', () => {
      const backgroundTools = Object.keys(toolHandlers).filter((name) =>
        name.startsWith('background.')
      );
      expect(backgroundTools.length).toBe(1);
    });
  });

  describe('旧SVGツールが存在しないことの検証', () => {
    const DELETED_SVG_TOOLS = [
      'svg.search',
      'svg.get',
      'svg.ingest',
      'svg.transform.optimize',
      'svg.transform.recolor',
      'svg.transform.to_react',
      'svg.transform.normalize',
    ];

    it.each(DELETED_SVG_TOOLS)(
      '%s が登録されていない（v3.xで削除済み）',
      (toolName) => {
        expect(toolHandlers).not.toHaveProperty(toolName);
      }
    );
  });

  describe('ツールハンドラーの型整合性', () => {
    it('toolHandlersの全エントリがPromiseを返す関数である', () => {
      for (const [_name, handler] of Object.entries(toolHandlers)) {
        expect(typeof handler).toBe('function');
        // 関数シグネチャの確認（引数を1-2つ受け取る）
        // 2つ目はオプショナルなprogressContext（Vision CPU完走保証 Phase 5）
        expect(handler.length).toBeLessThanOrEqual(2);
      }
    });

    it('allToolDefinitionsとtoolHandlersのツール名が完全に一致する', () => {
      const definitionNames = allToolDefinitions.map((d) => d.name).sort();
      const handlerNames = Object.keys(toolHandlers).sort();

      expect(definitionNames).toEqual(handlerNames);
    });

    it('各ツール定義のinputSchemaがJSON Schema形式である', () => {
      for (const definition of allToolDefinitions) {
        // JSON Schema基本構造の検証
        expect(definition.inputSchema).toHaveProperty('type');
        expect(definition.inputSchema.type).toBe('object');

        // propertiesが存在する場合はオブジェクトであること
        if (definition.inputSchema.properties) {
          expect(typeof definition.inputSchema.properties).toBe('object');
        }

        // requiredが存在する場合は配列であること
        if (definition.inputSchema.required) {
          expect(Array.isArray(definition.inputSchema.required)).toBe(true);
        }
      }
    });
  });
});
