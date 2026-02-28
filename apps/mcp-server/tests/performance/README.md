# Performance Tests

**更新日 / Updated**: 2026-03-01
**フェーズ / Phase**: v0.2.0 パフォーマンス最適化（実装完了） / v0.2.0 Performance Optimization (implementation complete)
**ステータス / Status**: 実装済み / Implemented (TDD Green/Refactor フェーズ完了 / TDD Green/Refactor phase complete)

## テスト概要 / Test Overview

パフォーマンス最適化機能のテスト駆動開発（TDD）で作成されたテストスイート。実装は完了しており、`src/services/cache.ts`、`src/services/query-analyzer.ts`、`src/utils/benchmark.ts` が実装済みです。

Test suite created via test-driven development (TDD) for performance optimization features. Implementation is complete, with `src/services/cache.ts`, `src/services/query-analyzer.ts`, and `src/utils/benchmark.ts` implemented.

### 作成したテストファイル / Created Test Files

| ファイル名 / File Name | 説明 / Description | テスト数 / Test Count |
|-----------|------|---------|
| `services/cache.test.ts` | キャッシュサービス（LRU、TTL、ヒット率） / Cache service (LRU, TTL, hit rate) | 24 |
| `services/query-analyzer.test.ts` | クエリ分析（スロークエリ検出、統計、最適化提案） / Query analysis (slow query detection, stats, optimization suggestions) | 21 |
| `performance/search-benchmark.test.ts` | 検索パフォーマンスベンチマーク（P95 < 100ms目標） / Search performance benchmark (P95 < 100ms target) | 22 |

**合計 / Total**: 67テスト / 67 tests

### 技術スタック / Tech Stack

- **Vitest**: ユニットテスト・ベンチマークフレームワーク / Unit test & benchmark framework
- **Performance API**: `performance.now()` による高精度計測 / High-precision measurement via `performance.now()`
- **Fake Timers**: `vi.useFakeTimers()` によるTTLテスト / TTL testing via `vi.useFakeTimers()`
- **統計計算 / Statistics**: P50/P95/P99パーセンタイル計算 / P50/P95/P99 percentile calculations

---

## テスト構成 / Test Structure

### 1. services/cache.test.ts（24テスト / 24 tests）

**カバー範囲 / Coverage**:
- LRU Cache基本操作 / LRU Cache basic operations（get/set/has/delete/clear/size）
- TTL（有効期限）管理 / TTL (expiration) management
- 最大サイズ制限とLRU排出 / Maximum size limit and LRU eviction
- キャッシュヒット率計算 / Cache hit rate calculation
- 検索結果キャッシュ / Search result cache（クエリハッシュ、TTL 5分 / query hash, TTL 5 min）
- Embeddingキャッシュ / Embedding cache（テキストハッシュ、メモリ効率 / text hash, memory efficiency）

**重要なテストケース / Key Test Cases**:
```typescript
describe('Cache Service', () => {
  describe('LRU Cache - 基本操作 / Basic Operations', () => {
    it('値を保存して取得できること / Can store and retrieve values');
    it('存在しないキーでnullを返すこと / Returns null for non-existent keys');
    it('has()でキーの存在を確認できること / Can check key existence with has()');
    it('delete()でエントリを削除できること / Can delete entries with delete()');
  });

  describe('LRU Cache - TTL（有効期限）管理 / TTL Management', () => {
    it('TTL期限内は値を取得できること / Can retrieve values within TTL');
    it('TTL期限切れ後はnullを返すこと / Returns null after TTL expires');
  });

  describe('LRU Cache - 最大サイズ制限とLRU排出 / Max Size and LRU Eviction', () => {
    it('最大サイズを超えると最も古いエントリが削除されること / Oldest entry is evicted when max size is exceeded');
    it('アクセス順序が更新されること / Access order is updated');
  });

  describe('LRU Cache - キャッシュヒット率計算 / Hit Rate Calculation', () => {
    it('ヒット率が正しく計算されること / Hit rate is calculated correctly');
    it('stats()で統計情報を取得できること / Can get statistics with stats()');
  });

  describe('Search Cache Service - 検索結果キャッシュ / Search Result Cache', () => {
    it('検索結果をキャッシュできること / Can cache search results');
    it('クエリハッシュが生成されること / Query hash is generated');
    it('TTL 5分でキャッシュが期限切れになること / Cache expires at 5 min TTL');
  });

  describe('Embedding Cache Service - Embeddingキャッシュ / Embedding Cache', () => {
    it('Embeddingベクトルをキャッシュできること / Can cache embedding vectors');
    it('ベクトル配列のメモリ効率をテストできること / Can test memory efficiency of vector arrays');
  });
});
```

### 2. services/query-analyzer.test.ts（21テスト / 21 tests）

**カバー範囲 / Coverage**:
- クエリ解析 / Query analysis（実行時間計測、実行計画取得 / execution time measurement, execution plan retrieval）
- スロークエリ検出 / Slow query detection（100ms超 / over 100ms）
- 統計収集 / Statistics collection（P50/P95/P99レイテンシ計算 / P50/P95/P99 latency calculation）
- クエリパターン別統計 / Per-pattern statistics
- 時間帯別負荷分析 / Time-based load analysis
- 最適化提案 / Optimization suggestions（インデックス推奨、クエリ書き換え / index recommendations, query rewriting）

**重要なテストケース / Key Test Cases**:
```typescript
describe('Query Analyzer Service', () => {
  describe('クエリ解析 / Query Analysis', () => {
    it('クエリ実行時間を計測できること / Can measure query execution time');
    it('実行計画を取得できること / Can retrieve execution plan');
    it('スロークエリを検出できること（100ms超） / Can detect slow queries (over 100ms)');
  });

  describe('統計収集 - P50/P95/P99レイテンシ計算 / Statistics - Latency Calculation', () => {
    it('P50/P95/P99レイテンシを計算できること / Can calculate P50/P95/P99 latency');
    it('平均値・最小値・最大値を計算できること / Can calculate avg/min/max');
  });

  describe('クエリパターン別統計 / Per-Pattern Statistics', () => {
    it('クエリパターンごとに統計を集計できること / Can aggregate statistics per query pattern');
    it('パターンごとの平均実行時間を計算できること / Can calculate average execution time per pattern');
  });

  describe('時間帯別負荷分析 / Time-Based Load Analysis', () => {
    it('時間帯ごとのクエリ数を集計できること / Can aggregate query count per time period');
    it('時間帯ごとの平均実行時間を計算できること / Can calculate average execution time per time period');
  });

  describe('最適化提案 / Optimization Suggestions', () => {
    it('スロークエリが多い場合、インデックスを推奨すること / Recommends index when many slow queries');
    it('P95が高い場合、クエリ書き換えを推奨すること / Recommends query rewriting when P95 is high');
  });
});
```

### 3. performance/search-benchmark.test.ts（22テスト / 22 tests）

**カバー範囲 / Coverage**:
- レスポンスタイム / Response time（P95 < 100ms目標 / P95 < 100ms target）
- 並列リクエスト / Concurrent requests（10, 50, 100同時 / 10, 50, 100 concurrent）
- コールドスタート vs ウォームスタート / Cold start vs warm start
- スケーラビリティ / Scalability（1,000件 vs 10,000件 vs 100,000件 / 1K vs 10K vs 100K records）
- ページネーション効率 / Pagination efficiency
- スループット計測 / Throughput measurement

**重要なテストケース / Key Test Cases**:
```typescript
describe('Search Benchmark', () => {
  describe('レスポンスタイム - P95 < 100ms 目標 / Response Time - P95 < 100ms Target', () => {
    it('P95レスポンスタイムが100ms未満であること / P95 response time is under 100ms');
    it('P50レスポンスタイムが50ms未満であること / P50 response time is under 50ms');
  });

  describe('並列リクエスト / Concurrent Requests', () => {
    it('10同時リクエストを処理できること / Can handle 10 concurrent requests');
    it('50同時リクエストを処理できること / Can handle 50 concurrent requests');
    it('100同時リクエストを処理できること / Can handle 100 concurrent requests');
  });

  describe('コールドスタート vs ウォームスタート / Cold Start vs Warm Start', () => {
    it('コールドスタート（初回）は遅いこと / Cold start (first run) is slower');
    it('ウォームスタート（キャッシュヒット）は速いこと / Warm start (cache hit) is faster');
  });

  describe('スケーラビリティ / Scalability', () => {
    it('1,000件のデータセットで検索できること / Can search 1,000 record dataset');
    it('10,000件のデータセットで検索できること / Can search 10,000 record dataset');
    it('100,000件のデータセットで検索できること / Can search 100,000 record dataset');
  });

  describe('ページネーション効率 / Pagination Efficiency', () => {
    it('ページネーションで異なるページを取得できること / Can retrieve different pages via pagination');
    it('ページネーションのパフォーマンスが一定であること / Pagination performance is consistent');
  });
});
```

---

## パフォーマンス目標 / Performance Targets

### キャッシュサービス / Cache Service

| 指標 / Indicator | 目標値 / Target |
|------|--------|
| LRUキャッシュヒット率 / LRU cache hit rate | > 80% |
| TTL精度 / TTL precision | ±100ms |
| 検索結果キャッシュTTL / Search result cache TTL | 5分 / 5 min |
| メモリ使用量（Embedding） / Memory usage (Embedding) | < 2KB/エントリ / < 2KB/entry |

### クエリアナライザー / Query Analyzer

| 指標 / Indicator | 目標値 / Target |
|------|--------|
| スロークエリ閾値 / Slow query threshold | > 100ms |
| P95レイテンシ / P95 latency | < 100ms |
| P99レイテンシ / P99 latency | < 150ms |
| インデックス推奨精度 / Index recommendation accuracy | > 70% |

### 検索ベンチマーク / Search Benchmark

| 指標 / Indicator | 目標値 / Target |
|------|--------|
| P95レスポンスタイム / P95 response time | < 100ms |
| P50レスポンスタイム / P50 response time | < 50ms |
| 並列処理（100同時） / Concurrent (100 parallel) | P95 < 500ms |
| スループット / Throughput | > 10 req/s |
| コールドスタート / Cold start | < 200ms |
| ウォームスタート / Warm start | < 20ms |

---

## テスト実行方法 / Test Execution

### 全テスト実行 / Run All Tests

```bash
cd apps/mcp-server
pnpm test
```

### パフォーマンステストのみ / Performance Tests Only

```bash
pnpm test performance
```

### サービステストのみ / Service Tests Only

```bash
pnpm test services
```

### ウォッチモード / Watch Mode

```bash
pnpm test:watch
```

### カバレッジレポート / Coverage Report

```bash
pnpm test:coverage
```

---

## 実装状況 / Implementation Status

| ファイル / File | ステータス / Status |
|---------|----------|
| `src/services/cache.ts` | 実装済み / Implemented |
| `src/services/query-analyzer.ts` | 実装済み / Implemented |
| `src/utils/benchmark.ts` | 実装済み（確認要） / Implemented (needs verification) |
| `src/middleware/cache.ts` | 未確認 / Unverified |
| `src/utils/performance.ts` | 未確認 / Unverified |

---

## 品質目標 / Quality Targets

| 指標 / Indicator | 目標値 / Target | 現在の状態 / Current Status |
|------|--------|-----------|
| テストカバレッジ / Test coverage | > 80% | 実装済み（実測値はCIで確認） / Implemented (actual values verified in CI) |
| パフォーマンステストカバレッジ / Perf test coverage | > 90% | 実装済み（実測値はCIで確認） / Implemented (actual values verified in CI) |
| テスト実行時間 / Test execution time | < 10秒 / < 10s | `pnpm test performance` で計測 / Measured with `pnpm test performance` |
| テストパス率 / Test pass rate | 100% | 実装済み（`pnpm test` で確認） / Implemented (verified with `pnpm test`) |

---

## 参考資料 / References

- **Vitest Benchmarking**: https://vitest.dev/guide/features#benchmarking
- **Node.js Performance APIs**: https://nodejs.org/api/perf_hooks.html
- **LRU Cache Algorithm**: https://en.wikipedia.org/wiki/Cache_replacement_policies#LRU
- **PostgreSQL EXPLAIN ANALYZE**: https://www.postgresql.org/docs/current/sql-explain.html

---

## 備考 / Notes

### TDD Red フェーズの意義 / Significance of TDD Red Phase

このフェーズでは、実装前にテストを書くことで:

In this phase, by writing tests before implementation:

1. **要件の明確化 / Requirements clarification**: パフォーマンス目標が具体的になる / Performance targets become concrete
2. **設計の検証 / Design validation**: APIが使いやすいか確認できる / Verify if the API is easy to use
3. **回帰テストの準備 / Regression test preparation**: 将来の最適化に備える / Prepare for future optimizations
4. **品質保証 / Quality assurance**: テストがない実装は存在しない / No implementation exists without tests

### パフォーマンス計測のベストプラクティス / Performance Measurement Best Practices

- **ウォームアップ / Warmup**: 初回実行はJITコンパイルの影響を受けるため除外 / Exclude initial runs due to JIT compilation effects
- **複数回実行 / Multiple runs**: 平均値ではなくパーセンタイル（P50/P95/P99）を使用 / Use percentiles (P50/P95/P99) instead of averages
- **環境の分離 / Environment isolation**: テスト実行時は他のプロセスを最小化 / Minimize other processes during test execution
- **モックの活用 / Use of mocks**: 外部依存を排除し、ロジックのみを計測 / Eliminate external dependencies, measure logic only

### 学習成果のドキュメント化 / Documenting Learnings

今回学んだ内容:

Learnings from this work:

- Vitestベンチマーク機能の使用方法 / How to use Vitest benchmark features
- Node.js Performance APIの活用 / Utilizing Node.js Performance API
- LRUキャッシュアルゴリズムの実装設計 / LRU cache algorithm implementation design
- パーセンタイル計算ロジック / Percentile calculation logic

学習成果はプロジェクトドキュメントに統合予定。

Learnings will be integrated into project documentation.
