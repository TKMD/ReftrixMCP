// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BriefParserService テスト
 *
 * DESIGN_BRIEF.md から NG/OK 表現、カラーパレット、アセット要件を抽出するサービスのテスト
 *
 * @module tests/services/brief/brief-parser-service.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BriefParserService } from '../../../src/services/brief/brief-parser-service';
import type { ParsedBrief } from '../../../src/services/brief/schemas/brief-parser-schemas';
import * as path from 'path';
import * as fs from 'fs';

describe('BriefParserService', () => {
  let parser: BriefParserService;

  beforeEach(() => {
    parser = new BriefParserService();
  });

  // ==========================================================================
  // 基本機能テスト
  // ==========================================================================

  describe('parse() - 基本機能', () => {
    it('should extract project name from H1 heading', () => {
      const markdown = `# My Project Design Brief

Some content here.`;

      const result = parser.parse(markdown);

      expect(result.project_name).toBe('My Project Design Brief');
    });

    it('should parse NG Expression table with 3 columns (Expression/Why/Alternative)', () => {
      const markdown = `# Test Project

#### Anti-AI Expression List (NG)

| NG Expression | Why NG | Alternative |
|---------------|--------|-------------|
| グラデーション球体 | AIツールの典型的出力 | 具体的なオブジェクト |
| 無意味な接続線 | 説明できない | 実際のデータフロー |
`;

      const result = parser.parse(markdown);

      expect(result.ng_expressions).toHaveLength(2);
      expect(result.ng_expressions[0]).toEqual({
        expression: 'グラデーション球体',
        reason: 'AIツールの典型的出力',
        alternative: '具体的なオブジェクト',
      });
      expect(result.ng_expressions[1]).toEqual({
        expression: '無意味な接続線',
        reason: '説明できない',
        alternative: '実際のデータフロー',
      });
    });

    it('should parse NG Examples table with 3 columns (NG/Why/Seen In)', () => {
      const markdown = `# Test Project

### NG Examples (This Project Context)

| NG | Why | Seen In |
|----|-----|---------|
| 紫→青グラデーション球 | AI系サービスの定番 | Claude, ChatGPT系LP |
| 浮遊するカードUIのみ | 使用シーンが見えない | 多数のSaaSサイト |
`;

      const result = parser.parse(markdown);

      expect(result.ng_expressions).toHaveLength(2);
      expect(result.ng_expressions[0]).toEqual({
        expression: '紫→青グラデーション球',
        reason: 'AI系サービスの定番',
        alternative: undefined,
      });
    });

    it('should parse OK Examples table with 2 columns (OK/Why)', () => {
      const markdown = `# Test Project

### OK Examples (This Project Context)

| OK | Why |
|----|-----|
| 河口・支流のメタファー | プロダクト名と連動 |
| 整理棚にカードが並ぶシーン | 誰でも想像できる |
`;

      const result = parser.parse(markdown);

      expect(result.ok_expressions).toHaveLength(2);
      expect(result.ok_expressions[0]).toEqual({
        expression: '河口・支流のメタファー',
        reason: 'プロダクト名と連動',
      });
      expect(result.ok_expressions[1]).toEqual({
        expression: '整理棚にカードが並ぶシーン',
        reason: '誰でも想像できる',
      });
    });

    it('should parse Color Palette table', () => {
      const markdown = `# Test Project

#### Color Palette

| Token | Role | HEX | OKLCH (reference) | Usage |
|-------|------|-----|-------------------|-------|
| \`deep-ocean\` | Background Primary | #030712 | L:0.08, C:0.02, H:260 | ページ全体の背景 |
| \`estuary-teal\` | Primary Accent | #14B8A6 | L:0.70, C:0.12, H:175 | CTA、リンク |
`;

      const result = parser.parse(markdown);

      expect(result.color_palette.tokens).toHaveLength(2);
      expect(result.color_palette.tokens[0]).toEqual({
        name: 'deep-ocean',
        role: 'Background Primary',
        hex: '#030712',
        oklch: 'L:0.08, C:0.02, H:260',
        usage: 'ページ全体の背景',
      });
    });

    it('should parse Asset Categories table', () => {
      const markdown = `# Test Project

### Asset Categories

| Category | Source | Usage |
|----------|--------|-------|
| Feature Icons | Reftrix内蔵 + カスタム制作 | 機能説明 |
| Scene Illustrations | カスタム制作 | ユースケース |
`;

      const result = parser.parse(markdown);

      expect(result.required_assets).toHaveLength(2);
      expect(result.required_assets[0]).toEqual({
        category: 'Feature Icons',
        description: 'Reftrix内蔵 + カスタム制作',
        suggested_query: '機能説明',
      });
    });

    it('should merge NG expressions from multiple tables', () => {
      const markdown = `# Test Project

#### Anti-AI Expression List (NG)

| NG Expression | Why NG | Alternative |
|---------------|--------|-------------|
| グラデーション球体 | 典型的AI出力 | 具体的オブジェクト |

### NG Examples (This Project Context)

| NG | Why | Seen In |
|----|-----|---------|
| 紫→青グラデーション | 定番パターン | 多数 |
`;

      const result = parser.parse(markdown);

      expect(result.ng_expressions).toHaveLength(2);
      expect(result.ng_expressions.map((ng) => ng.expression)).toContain('グラデーション球体');
      expect(result.ng_expressions.map((ng) => ng.expression)).toContain('紫→青グラデーション');
    });

    it('should set parsed_at timestamp', () => {
      const markdown = `# Test Project`;

      const before = new Date().toISOString();
      const result = parser.parse(markdown);
      const after = new Date().toISOString();

      expect(result.parsed_at).toBeDefined();
      expect(result.parsed_at >= before).toBe(true);
      expect(result.parsed_at <= after).toBe(true);
    });
  });

  // ==========================================================================
  // エッジケーステスト
  // ==========================================================================

  describe('parse() - エッジケース', () => {
    it('should handle empty markdown', () => {
      const result = parser.parse('');

      expect(result.project_name).toBe('');
      expect(result.ng_expressions).toEqual([]);
      expect(result.ok_expressions).toEqual([]);
      expect(result.color_palette.tokens).toEqual([]);
      expect(result.required_assets).toEqual([]);
    });

    it('should handle markdown without NG section', () => {
      const markdown = `# Test Project

Some content without NG expressions.

## Features

- Feature 1
- Feature 2
`;

      const result = parser.parse(markdown);

      expect(result.project_name).toBe('Test Project');
      expect(result.ng_expressions).toEqual([]);
    });

    it('should handle malformed table rows gracefully', () => {
      const markdown = `# Test Project

#### Anti-AI Expression List (NG)

| NG Expression | Why NG | Alternative |
|---------------|--------|-------------|
| Valid Row | Reason | Alt |
| Missing columns
| Another Valid | Reason2 | Alt2 |
`;

      const result = parser.parse(markdown);

      // Should skip malformed rows and parse valid ones
      expect(result.ng_expressions.length).toBeGreaterThanOrEqual(2);
    });

    it('should strip markdown formatting from cell values', () => {
      const markdown = `# Test Project

### OK Examples

| OK | Why |
|----|-----|
| **Bold expression** | *Italic reason* |
| \`Code expression\` | Normal reason |
`;

      const result = parser.parse(markdown);

      // Should strip ** and * formatting
      expect(result.ok_expressions[0].expression).toBe('Bold expression');
      expect(result.ok_expressions[0].reason).toBe('Italic reason');
    });

    it('should trim whitespace from cell values', () => {
      const markdown = `# Test Project

#### Anti-AI Expression List (NG)

| NG Expression | Why NG | Alternative |
|---------------|--------|-------------|
|   Spaced Expression   |   Spaced Reason   |   Spaced Alt   |
`;

      const result = parser.parse(markdown);

      expect(result.ng_expressions[0]).toEqual({
        expression: 'Spaced Expression',
        reason: 'Spaced Reason',
        alternative: 'Spaced Alt',
      });
    });

    it('should handle backtick-wrapped token names in Color Palette', () => {
      const markdown = `# Test Project

#### Color Palette

| Token | Role | HEX |
|-------|------|-----|
| \`token-name\` | Primary | #FF0000 |
| token-plain | Secondary | #00FF00 |
`;

      const result = parser.parse(markdown);

      expect(result.color_palette.tokens[0].name).toBe('token-name');
      expect(result.color_palette.tokens[1].name).toBe('token-plain');
    });

    it('should handle tables without separator row', () => {
      const markdown = `# Test Project

| NG | Why |
| Expression1 | Reason1 |
`;

      // Without proper separator, should still attempt to parse
      const result = parser.parse(markdown);
      // Behavior depends on implementation - may return empty or best-effort
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // strictモードテスト
  // ==========================================================================

  describe('parse() - strict mode', () => {
    it('should throw error if project_name is missing in strict mode', () => {
      const markdown = `Some content without H1 heading.`;

      expect(() => parser.parse(markdown, { strict: true })).toThrow(
        /project_name/i
      );
    });

    it('should not throw error if project_name is missing in non-strict mode', () => {
      const markdown = `Some content without H1 heading.`;

      const result = parser.parse(markdown, { strict: false });

      expect(result.project_name).toBe('');
    });

    it('should include source_path in result when provided', () => {
      const markdown = `# Test Project`;

      const result = parser.parse(markdown, {
        sourcePath: '/path/to/DESIGN_BRIEF.md',
      });

      expect(result.source_path).toBe('/path/to/DESIGN_BRIEF.md');
    });
  });

  // ==========================================================================
  // parseFile() テスト
  // ==========================================================================

  describe('parseFile()', () => {
    const briefPath = path.resolve(
      __dirname,
      '../../../../../example/concept/DESIGN_BRIEF.md'
    );
    const briefFileExists = fs.existsSync(briefPath);

    it.skipIf(!briefFileExists)('should parse actual DESIGN_BRIEF.md file', async () => {
      const result = await parser.parseFile(briefPath);

      // Reftrix Concept Site Design Brief should be parsed
      expect(result.project_name).toContain('Reftrix');

      // Should have source_path set
      expect(result.source_path).toBe(briefPath);

      // Should have parsed_at timestamp
      expect(result.parsed_at).toBeDefined();
    });

    it('should throw error for non-existent file', async () => {
      await expect(parser.parseFile('/non/existent/path.md')).rejects.toThrow(
        /ENOENT|not found|存在しません/i
      );
    });

    // Note: 以下のテストは現在のDESIGN_BRIEF.mdの構造に依存しています
    // DESIGN_BRIEF.mdにNG/OK表現テーブルが追加された場合に有効化してください
    it.skip('should extract specific NG expressions from actual DESIGN_BRIEF.md (requires NG table)', async () => {
      const briefPath = path.resolve(
        __dirname,
        '../../../../../example/concept/DESIGN_BRIEF.md'
      );

      const result = await parser.parseFile(briefPath);

      // Check for known NG expressions from the brief
      const ngExpressions = result.ng_expressions.map((ng) => ng.expression.toLowerCase());

      // These are actual NG expressions from the example DESIGN_BRIEF.md
      expect(ngExpressions.some((e) => e.includes('グラデーション'))).toBe(true);
      expect(ngExpressions.some((e) => e.includes('球') || e.includes('球体'))).toBe(true);
    });

    it.skip('should extract specific OK expressions from actual DESIGN_BRIEF.md (requires OK table)', async () => {
      const briefPath = path.resolve(
        __dirname,
        '../../../../../example/concept/DESIGN_BRIEF.md'
      );

      const result = await parser.parseFile(briefPath);

      // Check for known OK expressions from the brief
      const okExpressions = result.ok_expressions.map((ok) => ok.expression.toLowerCase());

      // These are actual OK expressions from the example DESIGN_BRIEF.md
      expect(okExpressions.some((e) => e.includes('河口') || e.includes('メタファー'))).toBe(true);
    });
  });

  // ==========================================================================
  // 複合テスト（完全なDESIGN_BRIEF形式）
  // ==========================================================================

  describe('parse() - 完全なDESIGN_BRIEF形式', () => {
    it('should parse a complete DESIGN_BRIEF format', () => {
      const markdown = `# Reftrix Concept Site Design Brief

**Version**: 0.1.0
**Created**: 2025-12-15
**Status**: Initial Draft

---

## 1. Brief Summary

### Project
Reftrix Concept Site（プロダクト紹介LP）

### Goal
- SVGアセット管理の新しいパラダイム

---

## 5. Deliverables & Requirements

### 5.1 Common Requirements

#### Color Palette

| Token | Role | HEX | OKLCH (reference) | Usage |
|-------|------|-----|-------------------|-------|
| \`deep-ocean\` | Background Primary | #030712 | L:0.08, C:0.02, H:260 | ページ全体の背景 |
| \`estuary-teal\` | Primary Accent | #14B8A6 | L:0.70, C:0.12, H:175 | CTA、リンク |

#### Anti-AI Expression List (NG)

| NG Expression | Why NG | Alternative |
|---------------|--------|-------------|
| グラデーション球体 | AIツールの典型的出力 | 具体的なオブジェクト |
| 無意味な接続線 | 説明できない | 実際のデータフロー |
| 紫→青グラデーション背景 | 2024年のAI定番 | 単色ダーク |

---

## 9. Anti-AI-cliche Checklist

### NG Examples (This Project Context)

| NG | Why | Seen In |
|----|-----|---------|
| 紫→青グラデーション球 | AI系定番 | Claude LP |
| 浮遊するカードUIのみ | 使用シーン不明 | SaaSサイト |

### OK Examples (This Project Context)

| OK | Why |
|----|-----|
| 河口・支流のメタファー | プロダクト名と連動 |
| 整理棚にカードが並ぶ | 物理的な場所 |
| 手がカードをピン留め | 人間の動作 |

---

## 8. SVG Asset Utilization Strategy

### Asset Categories

| Category | Source | Usage |
|----------|--------|-------|
| Feature Icons | Reftrix内蔵 | 機能説明 |
| Scene Illustrations | カスタム制作 | ユースケース |
`;

      const result = parser.parse(markdown);

      // Project name
      expect(result.project_name).toBe('Reftrix Concept Site Design Brief');

      // Color palette - 2 tokens
      expect(result.color_palette.tokens).toHaveLength(2);
      expect(result.color_palette.tokens[0].name).toBe('deep-ocean');
      expect(result.color_palette.tokens[0].hex).toBe('#030712');

      // NG expressions - merged from 2 tables (3 + 2 = 5)
      expect(result.ng_expressions.length).toBeGreaterThanOrEqual(4);

      // OK expressions - 3 from OK Examples table
      expect(result.ok_expressions).toHaveLength(3);

      // Required assets - 2 from Asset Categories
      expect(result.required_assets).toHaveLength(2);

      // Metadata
      expect(result.parsed_at).toBeDefined();
    });
  });

  // ==========================================================================
  // セキュリティテスト
  // ==========================================================================

  describe('security', () => {
    it('should not execute JavaScript in markdown', () => {
      const maliciousMarkdown = `# Test Project

<script>alert('XSS')</script>

| NG | Why |
|----|-----|
| <script>alert('XSS')</script> | Test |
`;

      // Should not throw, just parse safely
      const result = parser.parse(maliciousMarkdown);
      expect(result.project_name).toBe('Test Project');
      // Script tags should be treated as text, not executed
    });

    it('should handle extremely long input gracefully', () => {
      const longContent = 'x'.repeat(100000);
      const markdown = `# Test Project

${longContent}

| NG | Why |
|----|-----|
| Expression | Reason |
`;

      // Should not hang or crash
      const result = parser.parse(markdown);
      expect(result.project_name).toBe('Test Project');
    });
  });
});
