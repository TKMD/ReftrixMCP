# テスト要件 / Testing Requirements

## 評価メトリクス / Evaluation Metrics

| メトリクス / Metric | 定義 / Definition | 目標 / Target | 評価方法 / Evaluation Method |
|----------|------|------|---------|
| `pass@1` | 初回試行で成功 / Pass on first attempt | ≥ 85% | 自動（Vitest + CI） |
| `pass^3` | 3回連続成功（一貫性必須） / 3 consecutive passes (consistency required) | ≥ 70% | 自動（Vitest + CI） |
| Statement Coverage | ステートメントカバレッジ | > 80% | 自動（Vitest --coverage） |
| Branch Coverage | 分岐カバレッジ | > 70% | 自動（Vitest --coverage） |
| Function Coverage | 関数カバレッジ | > 85% | 自動（Vitest --coverage） |
| E2E Success Rate | E2Eテスト成功率 | 100% | 自動（Playwright + CI） |

## TDD必須 / TDD Required

### ✅ PASS基準（pass^3: 3回連続成功必須） / PASS Criteria (pass^3: 3 consecutive passes required)

1. **Red**: 失敗するテストを先に書く / Write a failing test first
   - ✅ テストファイルのコミットタイムスタンプが実装ファイルより古い / Test file commit timestamp is older than implementation file
   - ✅ テストが最初は失敗することを確認（CIログで検証） / Confirm test initially fails (verified via CI logs)
2. **Green**: テストを通す最小限のコード / Write minimal code to pass the test
   - ✅ すべてのテストが通過（`pnpm test` で 0 failed） / All tests pass (`pnpm test` with 0 failed)
3. **Refactor**: コードを改善 / Improve the code
   - ✅ リファクタリング後もテストが通過（回帰なし） / Tests still pass after refactoring (no regression)
   - ✅ カバレッジが維持または向上 / Coverage maintained or improved

### ❌ FAIL基準 / FAIL Criteria

- ❌ 実装コードが先にコミットされている（TDDサイクル違反） / Implementation code committed before tests (TDD cycle violation)
- ❌ テストが1つでもfailed状態でマージ / Merging with any failed test
- ❌ テストファイルが存在しない実装コード / Implementation code without test files
- ❌ リファクタリングでテストが壊れた（回帰） / Tests broken by refactoring (regression)

### TDD検証方法 / TDD Verification

**自動検証（Git履歴） / Automated Verification (Git History)**:
```bash
# テストファイルが実装ファイルより先にコミットされていることを確認
git log --follow --format="%H %ai" -- tests/search.test.ts
git log --follow --format="%H %ai" -- src/search.ts
```

**CI環境での検証 / CI Verification**:
- プルリクエストの各コミットでテスト実行
- 初期コミットでテストが失敗→後続コミットで成功の流れを確認

テストなしのコードはマージ不可。 / Code without tests cannot be merged.

## カバレッジ目標 / Coverage Targets

| 指標 / Indicator | 目標 / Target |
|------|------|
| ステートメント / Statement | > 80% |
| ブランチ / Branch | > 70% |
| 関数 / Function | > 85% |
| E2E | 主要フロー100% / All major flows 100% |

## テストフレームワーク / Test Frameworks

| 種別 / Type | ツール / Tool | バージョン / Version |
|------|--------|-----------|
| Unit/Integration | Vitest | 4.x（mcp-server, ml, core, webdesign-core）/ 3.2.x（database） |
| E2E | Playwright | 1.57.0 |

## Vitest設定 / Vitest Configuration

メモリ枯渇防止のため最大3ワーカー:

Max 3 workers to prevent memory exhaustion:

```bash
pnpm test --maxWorkers=3
```

### vitest.config.ts推奨設定 / Recommended vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    maxWorkers: 3, // 各ワーカー約3.5GB消費
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/index.ts',
        'src/**/*.test.ts',
        'node_modules/',
        'dist/',
      ],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
      },
    },
  },
});
```

## E2Eテスト（Playwright） / E2E Tests (Playwright)

### ✅ PASS基準（pass@1: 初回成功率 100%） / PASS Criteria (pass@1: 100% first-attempt success rate)

**必須要件 / Required**:
- ✅ Playwright + Chromium使用 / Use Playwright + Chromium
- ✅ スクリーンショット撮影・目視確認 / Screenshot capture and visual verification
- ✅ 保存先: Playwrightの設定に従う（デフォルト: `test-results/`） / Save location follows Playwright config (default: `test-results/`)
- ✅ すべてのE2Eテストが通過（0 failed） / All E2E tests pass (0 failed)

**主要フロー（E2E 100%必須） / Major Flows (E2E 100% required)**:

**MCPサーバー向け / For MCP Server**:
1. ✅ MCPツール実行（layout.ingest, motion.detect, quality.evaluate） / MCP tool execution
2. ✅ Embedding生成・ベクトル検索 / Embedding generation and vector search
3. ✅ HTMLサニタイゼーション・SSRF対策 / HTML sanitization and SSRF protection
4. ✅ エラーハンドリング（無効入力、タイムアウト） / Error handling (invalid input, timeout)

### ❌ FAIL基準 / FAIL Criteria

- ❌ 主要フローのいずれかが通過しない / Any major flow fails
- ❌ スクリーンショットが保存されていない / Screenshots not saved
- ❌ Playwrightの代わりにPuppeteerを使用 / Using Puppeteer instead of Playwright
- ❌ テストが環境依存で不安定（flaky） / Tests are environment-dependent and flaky

### 環境設計（重要） / Environment Design (Important)

**各試行が清潔な環境から開始 / Each trial starts from a clean environment**:
```typescript
// ✅ 良い例: 各テストで独立した状態
test.beforeEach(async ({ page, context }) => {
  // ローカルストレージ・Cookie・キャッシュをクリア
  await context.clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.goto('http://localhost:YOUR_APP_PORT');
});

// ❌ 悪い例: 状態が残る
test('test 1', async ({ page }) => {
  await page.fill('#input', 'value1');
  // 次のテストに状態が漏れる可能性
});
```

**テスト対象 / Test Targets**:
- 新規ページ作成時 / When creating new pages
- UIコンポーネントの重要な変更 / Significant UI component changes
- ユーザーフロー / User flows
- フォーム送信・バリデーション / Form submission and validation

### フレームキャプチャ（アニメーション検証） / Frame Capture (Animation Verification)

**デフォルト設定**: 15px/frame、30fps等価、PNG出力

**詳細仕様**: [references/testing-frame-analysis.md](./references/testing-frame-analysis.md)

## テストコマンド / Test Commands

```bash
pnpm test                          # 全テスト（Vitest）
pnpm test:watch                    # ウォッチモード
pnpm test:coverage                 # カバレッジ
pnpm --filter @reftrix/mcp-server test:e2e:playwright  # E2Eテスト（Playwright）
```

## 品質ゲート（CI必須） / Quality Gates (CI Required)

- テストカバレッジ 80%以上 / Test coverage above 80%
- E2Eテスト 100%パス / E2E tests 100% pass
- ESLintエラー 0件 / ESLint errors: 0
- TypeScriptエラー 0件 / TypeScript errors: 0
- セキュリティ脆弱性（High/Critical）0件 / Security vulnerabilities (High/Critical): 0

## lint/typecheckの実行 / Running lint/typecheck

タスク完了時は必ず `pnpm lint` と `pnpm typecheck` を実行してコードの正確性を確認する。

Always run `pnpm lint` and `pnpm typecheck` upon task completion to verify code correctness.
