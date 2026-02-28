// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP_DEFAULT_SUMMARY_MODE 環境変数テスト
 *
 * P1-PERF-3: LLM向けsummaryデフォルト値の最適化
 *
 * 目的:
 * - LLM最適化: 環境変数未設定時はsummary=true（コンテキスト効率化）
 * - MCP_DEFAULT_SUMMARY_MODE=false で明示的に無効化可能
 * - 明示的なsummary指定は環境変数より優先
 *
 * 対象ツール (WebDesign専用):
 * - project.get
 * - project.list
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 動的インポート用の型
type ProjectSchemaModule = typeof import('../../src/tools/schemas/project-schemas');

describe('MCP_DEFAULT_SUMMARY_MODE環境変数', () => {
  const originalEnv = process.env.MCP_DEFAULT_SUMMARY_MODE;

  beforeEach(() => {
    // モジュールキャッシュをクリア
    vi.resetModules();
  });

  afterEach(() => {
    // 環境変数を復元
    if (originalEnv !== undefined) {
      process.env.MCP_DEFAULT_SUMMARY_MODE = originalEnv;
    } else {
      delete process.env.MCP_DEFAULT_SUMMARY_MODE;
    }
    vi.resetModules();
  });

  // P1-PERF-3: 環境変数未設定時はLLM最適化デフォルト（summary=true）
  describe('環境変数未設定時（LLM最適化デフォルト）', () => {
    beforeEach(() => {
      delete process.env.MCP_DEFAULT_SUMMARY_MODE;
    });

    it('projectListInputSchemaのsummaryデフォルトはtrue', async () => {
      const { projectListInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectListInputSchema.parse({});
      expect(result.summary).toBe(true);
    });

    it('projectGetInputSchemaのsummaryデフォルトはtrue', async () => {
      const { projectGetInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectGetInputSchema.parse({ id: '01234567-89ab-cdef-0123-456789abcdef' });
      expect(result.summary).toBe(true);
    });
  });

  describe('MCP_DEFAULT_SUMMARY_MODE=true の場合', () => {
    beforeEach(() => {
      process.env.MCP_DEFAULT_SUMMARY_MODE = 'true';
    });

    it('projectListInputSchemaのsummaryデフォルトはtrue', async () => {
      const { projectListInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectListInputSchema.parse({});
      expect(result.summary).toBe(true);
    });

    it('projectGetInputSchemaのsummaryデフォルトはtrue', async () => {
      const { projectGetInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectGetInputSchema.parse({ id: '01234567-89ab-cdef-0123-456789abcdef' });
      expect(result.summary).toBe(true);
    });

    it('明示的にsummary=falseを指定すると環境変数より優先される', async () => {
      const { projectListInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectListInputSchema.parse({ summary: false });
      expect(result.summary).toBe(false);
    });

    it('明示的にsummary=trueを指定しても動作する', async () => {
      const { projectListInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectListInputSchema.parse({ summary: true });
      expect(result.summary).toBe(true);
    });
  });

  describe('MCP_DEFAULT_SUMMARY_MODE=false の場合', () => {
    beforeEach(() => {
      process.env.MCP_DEFAULT_SUMMARY_MODE = 'false';
    });

    it('projectListInputSchemaのsummaryデフォルトはfalse', async () => {
      const { projectListInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectListInputSchema.parse({});
      expect(result.summary).toBe(false);
    });

    it('projectGetInputSchemaのsummaryデフォルトはfalse', async () => {
      const { projectGetInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectGetInputSchema.parse({ id: '01234567-89ab-cdef-0123-456789abcdef' });
      expect(result.summary).toBe(false);
    });
  });

  // P1-PERF-3: LLM最適化 - 'false'以外の値はすべてtrue（LLMコンテキスト効率化）
  describe('無効な環境変数値（LLM最適化デフォルト）', () => {
    it('MCP_DEFAULT_SUMMARY_MODE="yes" はtrueとして扱う', async () => {
      process.env.MCP_DEFAULT_SUMMARY_MODE = 'yes';
      const { projectListInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectListInputSchema.parse({});
      expect(result.summary).toBe(true);
    });

    it('MCP_DEFAULT_SUMMARY_MODE="1" はtrueとして扱う', async () => {
      process.env.MCP_DEFAULT_SUMMARY_MODE = '1';
      const { projectListInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectListInputSchema.parse({});
      expect(result.summary).toBe(true);
    });

    it('MCP_DEFAULT_SUMMARY_MODE="" はtrueとして扱う', async () => {
      process.env.MCP_DEFAULT_SUMMARY_MODE = '';
      const { projectListInputSchema } = await import('../../src/tools/schemas/project-schemas') as ProjectSchemaModule;
      const result = projectListInputSchema.parse({});
      expect(result.summary).toBe(true);
    });
  });
});

describe('Projectツールのsummaryデフォルト値テスト', () => {
  const originalEnv = process.env.MCP_DEFAULT_SUMMARY_MODE;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MCP_DEFAULT_SUMMARY_MODE = originalEnv;
    } else {
      delete process.env.MCP_DEFAULT_SUMMARY_MODE;
    }
    vi.resetModules();
  });

  describe('project.get (projectGetInputSchema)', () => {
    it('MCP_DEFAULT_SUMMARY_MODE=true でsummaryデフォルトはtrue', async () => {
      process.env.MCP_DEFAULT_SUMMARY_MODE = 'true';
      const { projectGetInputSchema } = await import('../../src/tools/schemas/project-schemas');
      const result = projectGetInputSchema.parse({ id: '01234567-89ab-cdef-0123-456789abcdef' });
      expect(result.summary).toBe(true);
    });

    // P1-PERF-3: LLM最適化デフォルト
    it('環境変数未設定でsummaryデフォルトはtrue（LLM最適化）', async () => {
      delete process.env.MCP_DEFAULT_SUMMARY_MODE;
      const { projectGetInputSchema } = await import('../../src/tools/schemas/project-schemas');
      const result = projectGetInputSchema.parse({ id: '01234567-89ab-cdef-0123-456789abcdef' });
      expect(result.summary).toBe(true);
    });
  });

  describe('project.list (projectListInputSchema)', () => {
    it('MCP_DEFAULT_SUMMARY_MODE=true でsummaryデフォルトはtrue', async () => {
      process.env.MCP_DEFAULT_SUMMARY_MODE = 'true';
      const { projectListInputSchema } = await import('../../src/tools/schemas/project-schemas');
      const result = projectListInputSchema.parse({});
      expect(result.summary).toBe(true);
    });

    // P1-PERF-3: LLM最適化デフォルト
    it('環境変数未設定でsummaryデフォルトはtrue（LLM最適化）', async () => {
      delete process.env.MCP_DEFAULT_SUMMARY_MODE;
      const { projectListInputSchema } = await import('../../src/tools/schemas/project-schemas');
      const result = projectListInputSchema.parse({});
      expect(result.summary).toBe(true);
    });
  });
});

describe('getSummaryDefault ヘルパー関数', () => {
  const originalEnv = process.env.MCP_DEFAULT_SUMMARY_MODE;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MCP_DEFAULT_SUMMARY_MODE = originalEnv;
    } else {
      delete process.env.MCP_DEFAULT_SUMMARY_MODE;
    }
    vi.resetModules();
  });

  it('MCP_DEFAULT_SUMMARY_MODE=true で true を返す', async () => {
    process.env.MCP_DEFAULT_SUMMARY_MODE = 'true';
    const { getSummaryDefault } = await import('../../src/tools/schemas');
    expect(getSummaryDefault()).toBe(true);
  });

  it('MCP_DEFAULT_SUMMARY_MODE=false で false を返す', async () => {
    process.env.MCP_DEFAULT_SUMMARY_MODE = 'false';
    const { getSummaryDefault } = await import('../../src/tools/schemas');
    expect(getSummaryDefault()).toBe(false);
  });

  // P1-PERF-3: LLM向け最適化 - 環境変数未設定時はtrueをデフォルトに
  it('環境変数未設定で true を返す（LLM最適化デフォルト）', async () => {
    delete process.env.MCP_DEFAULT_SUMMARY_MODE;
    const { getSummaryDefault } = await import('../../src/tools/schemas');
    expect(getSummaryDefault()).toBe(true);
  });

  // P1-PERF-3: 無効な値もLLM最適化デフォルトでtrueに
  it('無効な値で true を返す（LLM最適化デフォルト）', async () => {
    process.env.MCP_DEFAULT_SUMMARY_MODE = 'invalid';
    const { getSummaryDefault } = await import('../../src/tools/schemas');
    expect(getSummaryDefault()).toBe(true);
  });
});

// ==========================================================================
// P1-PERF-3: ツール定義と実装の整合性検証
// ==========================================================================
describe('ツール定義のsummaryデフォルト値整合性', () => {
  const originalEnv = process.env.MCP_DEFAULT_SUMMARY_MODE;

  beforeEach(() => {
    vi.resetModules();
    // LLM最適化デフォルト: 環境変数未設定時
    delete process.env.MCP_DEFAULT_SUMMARY_MODE;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MCP_DEFAULT_SUMMARY_MODE = originalEnv;
    } else {
      delete process.env.MCP_DEFAULT_SUMMARY_MODE;
    }
    vi.resetModules();
  });

  it('project.getツール定義のdescriptionがLLM最適化デフォルト(true)を反映している', async () => {
    const { projectGetToolDefinition } = await import('../../src/tools/project-get');
    const summaryProp = projectGetToolDefinition.inputSchema.properties.summary;

    expect(summaryProp.description).toContain('default: true');
  });

  it('project.listツール定義のdescriptionがLLM最適化デフォルト(true)を反映している', async () => {
    const { projectListToolDefinition } = await import('../../src/tools/project-list');
    const summaryProp = projectListToolDefinition.inputSchema.properties.summary;

    expect(summaryProp.description).toContain('default: true');
  });
});
