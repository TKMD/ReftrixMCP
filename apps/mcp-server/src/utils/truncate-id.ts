// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PII切り詰めユーティリティ / PII truncation utility
 *
 * IDをログ出力用にtruncateする（PII配慮）
 * Truncate ID for log output (PII consideration)
 *
 * @module utils/truncate-id
 */

/**
 * IDを指定長に切り詰める / Truncate ID to specified length
 *
 * @param id - 切り詰め対象のID / ID to truncate
 * @param length - 切り詰め長（デフォルト8） / Truncation length (default 8)
 * @returns 切り詰められたID / Truncated ID
 */
export function truncateId(id: string | undefined, length: number = 8): string {
  if (!id) return "undefined";
  return id.length > length ? id.slice(0, length) + "..." : id;
}
