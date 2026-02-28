// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Safe parseInt - 環境変数パースの安全化ヘルパー
 *
 * SEC-M2対応: parseInt(process.env.XXX || 'default') パターンの安全化。
 * NaN チェック、範囲チェック（min/max）を含む。
 *
 * @module utils/safe-parse-int
 */

/**
 * safeParseInt のオプション
 */
export interface SafeParseIntOptions {
  /** 最小値。この値未満の場合デフォルト値を返す */
  min?: number;
  /** 最大値。この値超過の場合デフォルト値を返す */
  max?: number;
}

/**
 * 文字列を安全に整数にパースする
 *
 * parseInt のラッパーで、以下の安全性を追加:
 * - undefined/空文字列/非数値文字列 → デフォルト値を返す
 * - NaN/Infinity → デフォルト値を返す
 * - min/max 範囲外 → デフォルト値を返す
 *
 * 使用例:
 * ```typescript
 * // 従来の危険なパターン:
 * const lockDuration = parseInt(process.env.BULLMQ_LOCK_DURATION || '1200000', 10);
 *
 * // 安全なパターン:
 * const lockDuration = safeParseInt(process.env.BULLMQ_LOCK_DURATION, 1200000, { min: 60000 });
 * ```
 *
 * @param value - パースする文字列（undefined の場合はデフォルト値を返す）
 * @param defaultValue - パース失敗時または範囲外の場合に返すデフォルト値
 * @param options - 範囲チェックオプション
 * @returns パースされた整数、またはデフォルト値
 */
export function safeParseInt(
  value: string | undefined,
  defaultValue: number,
  options?: SafeParseIntOptions,
): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return defaultValue;
  }

  const parsed = parseInt(trimmed, 10);

  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  // 範囲チェック
  if (options?.min !== undefined && parsed < options.min) {
    return defaultValue;
  }
  if (options?.max !== undefined && parsed > options.max) {
    return defaultValue;
  }

  return parsed;
}
