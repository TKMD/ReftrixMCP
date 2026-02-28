// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E2Eテスト用データベースURL定数
 *
 * セキュリティ注意:
 * - 本番DB接続情報をハードコードしないこと
 * - フォールバック値は開発環境専用（change_me は明示的なプレースホルダー）
 * - 本番・ステージング環境では必ず DATABASE_URL 環境変数を設定すること
 *
 * @see SEC-H2: E2EテストにおけるハードコードされたDB接続文字列の集約
 */

/**
 * E2Eテスト用データベースURL
 *
 * 環境変数 DATABASE_URL が設定されている場合はそちらを優先。
 * 未設定の場合はローカル開発環境用のフォールバックを使用。
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://reftrix:change_me@localhost:26432/reftrix';
