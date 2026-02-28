# MCPツールハンドラー テスト / MCP Tool Handler Tests

## 概要 / Overview

MCPツールハンドラーの包括的なテストスイート。現行19ツールのツールハンドラーテストを収録しています。

Comprehensive test suite for MCP tool handlers. Contains handler tests for the current 19 tools.

## テストファイル構成 / Test File Structure

### ツール別テストファイル / Test Files by Tool

| カテゴリ / Category | テストファイル / Test File | 説明 / Description |
|---------|--------------|------|
| Layout | `layout/inspect.tool.test.ts` | layout.inspect ハンドラーテスト / layout.inspect handler test |
| Layout | `layout/ingest.tool.test.ts` | layout.ingest ハンドラーテスト / layout.ingest handler test |
| Layout | `layout/search.tool.test.ts` | layout.search ハンドラーテスト / layout.search handler test |
| Layout | `layout/to-code.tool.test.ts` | layout.generate_code ハンドラーテスト / layout.generate_code handler test |
| Layout | `layout/batch-ingest.tool.test.ts` | layout.batch_ingest ハンドラーテスト / layout.batch_ingest handler test |
| Motion | `motion/detect.tool.test.ts` | motion.detect ハンドラーテスト（CSS/JS/video mode） / motion.detect handler test (CSS/JS/video mode) |
| Motion | `motion/search.tool.test.ts` | motion.search ハンドラーテスト / motion.search handler test |
| Quality | `quality/evaluate.tool.test.ts` | quality.evaluate ハンドラーテスト / quality.evaluate handler test |
| Quality | `quality/batch-evaluate.tool.test.ts` | quality.batch_evaluate ハンドラーテスト / quality.batch_evaluate handler test |
| Quality | `quality/get-job-status.tool.test.ts` | quality.getJobStatus ハンドラーテスト / quality.getJobStatus handler test |
| Page | `page/analyze.tool.test.ts` | page.analyze ハンドラーテスト / page.analyze handler test |
| Page | `page/get-job-status.tool.test.ts` | page.getJobStatus ハンドラーテスト / page.getJobStatus handler test |
| Brief | `brief/validate.handler.test.ts` | brief.validate ハンドラーテスト / brief.validate handler test |
| Style | `style-get-palette.test.ts` | style.get_palette ハンドラーテスト / style.get_palette handler test |
| System | `system-health.test.ts` | system.health ハンドラーテスト / system.health handler test |
| Project | `project-get.test.ts` | project.get ハンドラーテスト / project.get handler test |
| Project | `project-list.test.ts` | project.list ハンドラーテスト / project.list handler test |
| Narrative | `narrative-search.test.ts` | narrative.search ハンドラーテスト / narrative.search handler test |
| Background | `background-search.test.ts` | background.search ハンドラーテスト / background.search handler test |

### スキーマテスト / Schema Tests

- `schemas.test.ts`: 各ツールのZodスキーマバリデーションテスト / Zod schema validation tests for each tool

## テスト品質指標 / Test Quality Indicators

| 指標 / Indicator | 目標値 / Target |
|------|--------|
| ツールテストカバレッジ / Tool test coverage | > 90% |
| 正常系テスト / Happy path tests | 各ツール最低3ケース / At least 3 cases per tool |
| 異常系テスト / Error path tests | バリデーション・エラーハンドリング / Validation & error handling |

## SEC指摘事項への対応 / SEC Audit Compliance

すべてのテストでセキュリティ要件に対応:

All tests comply with security requirements:

- UUID検証 / UUID validation（`z.string().uuid()`）
- 入力バリデーション / Input validation（文字列長、配列長、enum値 / string length, array length, enum values）
- URL形式検証 / URL format validation（`z.string().url()`）
- エラーハンドリング / Error handling（無効な入力時のエラーレスポンス / error response on invalid input）

## 備考 / Notes

- すべてのテストは日本語コメント付き / All tests include Japanese comments
- TDDサイクル（Red → Green → Refactor）を実践 / TDD cycle (Red → Green → Refactor) is practiced
- 開発環境ログ出力テストを各ツールに含める / Development environment log output tests included for each tool
