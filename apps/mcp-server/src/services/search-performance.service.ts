// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 検索パフォーマンスSLO監視サービス
 *
 * 検索ツールのパフォーマンスを監視し、SLO違反を検出するサービス。
 *
 * 主な機能:
 * - 検索時間の記録
 * - ツールごとのSLO定義
 * - P50/P95/P99パーセンタイルの計算
 * - SLO違反の検出
 *
 * @module SearchPerformanceService
 */

/**
 * 検索パフォーマンス統計
 */
export interface SearchPerformanceStats {
  /** 記録された検索回数 */
  count: number;
  /** P50（中央値）レイテンシ（ミリ秒） */
  p50: number;
  /** P95レイテンシ（ミリ秒） */
  p95: number;
  /** P99レイテンシ（ミリ秒） */
  p99: number;
  /** SLO違反回数 */
  sloViolations: number;
}

/**
 * SLO定義
 */
export interface SLODefinition {
  /** P95レイテンシの閾値（ミリ秒） */
  p95: number;
  /** P99レイテンシの閾値（ミリ秒） */
  p99: number;
}

/**
 * ツールごとの検索時間データ
 */
interface ToolMetrics {
  /** 記録された検索時間（ミリ秒）の配列 */
  durations: number[];
  /** SLO違反回数 */
  sloViolations: number;
}

/**
 * DoS攻撃耐性のためのメモリ上限設定
 */
const MEMORY_LIMITS = {
  /** ツールあたりの最大記録数（リングバッファ方式で管理） */
  MAX_DURATIONS_PER_TOOL: 10_000,
  /** 最大ツール数（未知のツール名による肥大化を防止） */
  MAX_TOOL_ENTRIES: 100,
} as const;

/**
 * デフォルトのSLO定義
 *
 * @see https://docs.reftrix.dev/mcp-tools-reference
 *
 * layout.search: P95 < 500ms, P99 < 1000ms
 * motion.search: P95 < 500ms, P99 < 1000ms
 */
const DEFAULT_SLO_DEFINITIONS: Record<string, SLODefinition> = {
  'layout.search': { p95: 500, p99: 1000 },
  'motion.search': { p95: 500, p99: 1000 },
};

/**
 * 検索パフォーマンスSLO監視サービス
 *
 * ツールごとの検索時間を記録し、パーセンタイル統計とSLO違反を追跡します。
 *
 * @example
 * ```typescript
 * const service = new SearchPerformanceService();
 *
 * // 検索時間を記録
 * service.recordSearchTime('layout.search', 150);
 *
 * // 統計を取得
 * const stats = service.getStats('layout.search');
 * console.log(`P95: ${stats?.p95}ms`);
 *
 * // SLO違反をチェック
 * const isViolation = service.checkSLOViolation('layout.search', 600);
 * ```
 */
export class SearchPerformanceService {
  /** ツールごとの検索メトリクス */
  private metrics: Map<string, ToolMetrics> = new Map();

  /**
   * 検索時間を記録する
   *
   * 負の値や0も記録可能（エラーにはならない）。
   * SLO違反が発生した場合、自動的にカウントされる。
   *
   * メモリ上限:
   * - ツール数が MAX_TOOL_ENTRIES を超えると新規ツールは記録されない
   * - 記録数が MAX_DURATIONS_PER_TOOL を超えると最古のデータが削除される（リングバッファ）
   *
   * @param toolName ツール名（例: 'layout.search'）
   * @param durationMs 検索時間（ミリ秒）
   */
  recordSearchTime(toolName: string, durationMs: number): void {
    let toolMetrics = this.metrics.get(toolName);

    // ツール数上限チェック（DoS攻撃対策）
    if (!toolMetrics) {
      if (this.metrics.size >= MEMORY_LIMITS.MAX_TOOL_ENTRIES) {
        // 上限に達した場合は警告のみで記録しない
        if (process.env.NODE_ENV === 'development') {
          console.warn(
            `[SearchPerformanceService] Max tool entries reached (${MEMORY_LIMITS.MAX_TOOL_ENTRIES}). ` +
              `Ignoring new tool: ${toolName}`
          );
        }
        return;
      }
      toolMetrics = { durations: [], sloViolations: 0 };
      this.metrics.set(toolName, toolMetrics);
    }

    // 記録数上限チェック（リングバッファ方式）
    if (toolMetrics.durations.length >= MEMORY_LIMITS.MAX_DURATIONS_PER_TOOL) {
      toolMetrics.durations.shift(); // 最古のデータを削除
    }

    toolMetrics.durations.push(durationMs);

    // SLO違反をチェックしてカウント
    if (this.checkSLOViolation(toolName, durationMs)) {
      toolMetrics.sloViolations++;
    }
  }

  /**
   * ツールのSLO定義を取得する
   *
   * @param toolName ツール名
   * @returns SLO定義。未定義のツールの場合はundefined
   */
  getSLO(toolName: string): SLODefinition | undefined {
    return DEFAULT_SLO_DEFINITIONS[toolName];
  }

  /**
   * ツールの統計情報を取得する
   *
   * @param toolName ツール名
   * @returns 統計情報。未記録のツールの場合はundefined
   */
  getStats(toolName: string): SearchPerformanceStats | undefined {
    const toolMetrics = this.metrics.get(toolName);

    if (!toolMetrics || toolMetrics.durations.length === 0) {
      return undefined;
    }

    const { durations, sloViolations } = toolMetrics;

    return {
      count: durations.length,
      p50: this.calculatePercentile(durations, 50),
      p95: this.calculatePercentile(durations, 95),
      p99: this.calculatePercentile(durations, 99),
      sloViolations,
    };
  }

  /**
   * SLO違反をチェックする
   *
   * P95 SLO閾値を超える場合にtrueを返す。
   * 未定義のツールに対しては常にfalseを返す。
   *
   * @param toolName ツール名
   * @param durationMs 検索時間（ミリ秒）
   * @returns SLO違反の場合はtrue
   */
  checkSLOViolation(toolName: string, durationMs: number): boolean {
    const slo = this.getSLO(toolName);

    if (!slo) {
      return false;
    }

    // P95 SLO閾値を超える場合は違反
    // 閾値ちょうどの場合は違反ではない（<=）
    return durationMs > slo.p95;
  }

  /**
   * 全統計をリセットする
   *
   * SLO定義はリセットされない（定数のため）。
   */
  reset(): void {
    this.metrics.clear();
  }

  /**
   * パーセンタイルを計算する
   *
   * 線形補間を使用してパーセンタイルを計算。
   * データが1件の場合は、その値をそのまま返す。
   *
   * @param data 数値の配列
   * @param percentile パーセンタイル（0-100）
   * @returns パーセンタイル値
   */
  private calculatePercentile(data: number[], percentile: number): number {
    if (data.length === 0) {
      return 0;
    }

    // ソートされたコピーを作成
    const sorted = [...data].sort((a, b) => a - b);

    if (sorted.length === 1) {
      // 必ず要素が存在するので非null断言を使用
      return sorted[0]!;
    }

    // パーセンタイルのインデックスを計算
    // 0-indexed なので (length - 1) * (percentile / 100) を使用
    const index = ((sorted.length - 1) * percentile) / 100;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    // lowerとupperは常に有効なインデックス（0 <= lower <= upper <= length - 1）
    const lowerValue = sorted[lower]!;
    const upperValue = sorted[upper]!;

    if (lower === upper) {
      return lowerValue;
    }

    // 線形補間
    const weight = index - lower;
    return lowerValue * (1 - weight) + upperValue * weight;
  }
}
