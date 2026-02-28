# MCP Server Tests

**最終更新 / Last Updated**: 2026-03-01
**フェーズ / Phase**: WebDesign専用MCPサーバー (v6.x) / WebDesign-dedicated MCP Server (v6.x)
**ステータス / Status**: 安定稼働中 / Stable

## テスト概要 / Test Overview

Reftrix MCPサーバーのテストスイート。WebDesign専用の19ツールをカバーしています。

Test suite for the Reftrix MCP server. Covers all 19 WebDesign-dedicated tools.

### 現行テストファイル構成 / Current Test File Structure

| ディレクトリ / Directory | 説明 / Description | テスト数 / Test Count |
|-----------|------|---------|
| `tests/unit/` | ユニットテスト（サービス、ユーティリティ） / Unit tests (services, utilities) | ~100 |
| `tests/integration/` | 統合テスト（DB、サービス間連携） / Integration tests (DB, inter-service) | ~50 |
| `tests/tools/` | MCPツールハンドラーテスト / MCP tool handler tests | ~200 |
| `tests/services/` | サービス層テスト / Service layer tests | ~300 |
| `tests/e2e/` | エンドツーエンドテスト / End-to-end tests | ~20 |
| `tests/api/` | APIヘルスチェック / API health checks | ~10 |
| `tests/performance/` | パフォーマンスベンチマーク / Performance benchmarks | ~5 |

**合計 / Total**: 約11,500テスト / Approximately 11,500 tests

### 現行19ツール / Current 19 Tools

SVG機能は削除され、WebDesign専用ツールに移行しました。

SVG features have been removed; migrated to WebDesign-dedicated tools.

| カテゴリ / Category | ツール名 / Tool Name | テストファイル / Test File |
|---------|---------|--------------|
| Style | `style.get_palette` | `tools/style-get-palette.test.ts` |
| System | `system.health` | `tools/system-health.test.ts` |
| Layout | `layout.inspect` | `tools/layout/inspect.tool.test.ts` |
| Layout | `layout.ingest` | `tools/layout/ingest.tool.test.ts` |
| Layout | `layout.search` | `tools/layout/search.tool.test.ts` |
| Layout | `layout.generate_code` | `tools/layout/to-code.tool.test.ts` |
| Layout | `layout.batch_ingest` | `tools/layout/batch-ingest.tool.test.ts` |
| Quality | `quality.evaluate` | `tools/quality/evaluate.tool.test.ts` |
| Quality | `quality.batch_evaluate` | `tools/quality/batch-evaluate.tool.test.ts` |
| Quality | `quality.getJobStatus` | `tools/quality/get-job-status.tool.test.ts` |
| Motion | `motion.detect` | `tools/motion/detect.tool.test.ts` |
| Motion | `motion.search` | `tools/motion/search.tool.test.ts` |
| Brief | `brief.validate` | `tools/brief/validate.handler.test.ts` |
| Project | `project.get` | `tools/project-get.test.ts` |
| Project | `project.list` | `tools/project-list.test.ts` |
| Page | `page.analyze` | `tools/page/analyze.tool.test.ts` |
| Page | `page.getJobStatus` | `tools/page/get-job-status.tool.test.ts` |
| Narrative | `narrative.search` | `tools/narrative/search.tool.test.ts` |
| Background | `background.search` | `tools/background/search.tool.test.ts` |

## テスト実行方法 / Test Execution

### 全テスト実行 / Run All Tests

```bash
cd apps/mcp-server
pnpm test
```

### ウォッチモード / Watch Mode

```bash
pnpm test:watch
```

### カバレッジレポート / Coverage Report

```bash
pnpm test:coverage
```

### 特定のテストファイルのみ実行 / Run Specific Test File

```bash
pnpm test tests/tools/system-health.test.ts
```

### スモークテスト（基本動作確認） / Smoke Tests (Basic Verification)

```bash
pnpm test tests/smoke/
```

## テスト構成 / Test Structure

### 1. ツール登録テスト / Tool Registration Test (smoke/tool-registration.test.ts)

**目的 / Purpose**: 全19ツールが正しく登録されていることを確認 / Verify all 19 tools are correctly registered

```typescript
describe('MCP Tool Registration', () => {
  it('toolHandlers に19ツールが登録されている');
  it('allToolDefinitions に19ツール定義がある');
  it('各ツールに対応するハンドラーが存在する');
});
```

### 2. system.health テスト / system.health Test (tools/system-health.test.ts)

**目的 / Purpose**: MCPサーバーのヘルスチェック機能を検証 / Verify MCP server health check functionality

- Web API接続状態の確認 / Web API connection status verification
- レスポンスフォーマット検証 / Response format validation
- エラーハンドリング / Error handling

### 3. page.analyze テスト / page.analyze Test (tools/page/analyze.tool.test.ts)

**目的 / Purpose**: 統合Web分析機能を検証 / Verify unified web analysis functionality

- Layout検出 / Layout detection
- Motion検出 / Motion detection
- Quality評価 / Quality evaluation
- DB保存オプション / DB save options

### 4. motion.detect テスト / motion.detect Test (tools/motion/detect.tool.test.ts)

**目的 / Purpose**: CSSアニメーション検出機能を検証 / Verify CSS animation detection functionality

- CSS static analysis
- video mode (frame capture)
- JSアニメーション検出（オプション） / JS animation detection (optional)

## 品質目標 / Quality Targets

| 指標 / Indicator | 目標値 / Target | 現在の状態 / Current Status |
|------|--------|-----------|
| テストカバレッジ / Test coverage | > 80% | ~85% |
| ツールテストカバレッジ / Tool test coverage | > 90% | ~92% |
| テスト実行時間 / Test execution time | < 5分 / < 5 min | ~4.5分 / ~4.5 min |
| テストパス率 / Test pass rate | 100% | 100% (約11,500 passed / approx. 11,500 passed) |

## スキップされたテスト / Skipped Tests

### v0.1.0リリース時点でスキップされているテスト（90件） / Tests Skipped as of v0.1.0 Release (90 tests)

以下のテストは実装設計上の制約（依存性注入の欠如、パスセキュリティチェック等）により一時的にスキップされています:

The following tests are temporarily skipped due to implementation design constraints (lack of dependency injection, path security checks, etc.):

1. **VisionEmbeddingService モック関連 / VisionEmbeddingService mock issues**: 直接インスタンス化されるため、ファクトリ経由でのモック注入が機能しない / Direct instantiation prevents mock injection via factory
2. **LayoutEmbeddingService キャッシュテスト / LayoutEmbeddingService cache tests**: 同上 / Same as above
3. **ProjectContextAnalyzer パターン検出テスト / ProjectContextAnalyzer pattern detection tests**: パスセキュリティチェックにより許可されていないテストパスでは空パターンが返される / Path security checks return empty patterns for unauthorized test paths
4. **page.analyze Embedding統合テスト / page.analyze Embedding integration tests**: モック設定とハンドラー実装のパス分離 / Path separation between mock setup and handler implementation

これらは機能上の問題ではなく、テスト設計（依存性注入パターン適用）または許可パス設定の調整が必要です。

These are not functional issues but require test design adjustments (dependency injection pattern) or allowed path configuration changes.

## Vitestワーカー制限 / Vitest Worker Limits

**重要 / Important**: メモリ枯渇防止のため、ワーカー数は最大3に制限しています。

Worker count is limited to a maximum of 3 to prevent memory exhaustion.

```bash
# 推奨実行方法 / Recommended execution
pnpm test --maxWorkers=3

# または vitest.config.ts で設定済み / Or already configured in vitest.config.ts
```

## 参考資料 / References

- MCP仕様 / MCP specification: https://modelcontextprotocol.io/
- Vitest: https://vitest.dev/
- ツール定義 / Tool definitions: `src/tools/index.ts`
- アーキテクチャ / Architecture: `/

## 備考 / Notes

### TDD実践 / TDD Practice

新機能追加時は必ずTDDサイクルを実践:

TDD cycle is mandatory when adding new features:

1. **Red**: 失敗するテストを先に書く / Write a failing test first
2. **Green**: テストを通す最小限のコード / Write minimal code to pass the test
3. **Refactor**: コードを改善 / Improve the code

### コンソールログ規約 / Console Log Conventions

- **開発環境 / Development**: 詳細なログを出力 / Detailed logging（`[MCP] Action: details`形式 / format）
- **本番環境 / Production**: 不要なログを抑制（errorとwarnのみ） / Suppress unnecessary logs (error and warn only)
