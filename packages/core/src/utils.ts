// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core Utility Functions
 *
 * 共通ユーティリティ関数群
 */

/**
 * 開発環境かどうかを判定
 *
 * @returns 開発環境の場合true
 */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

/**
 * 本番環境かどうかを判定
 *
 * @returns 本番環境の場合true
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * テスト環境かどうかを判定
 *
 * @returns テスト環境の場合true
 */
export function isTest(): boolean {
  return process.env.NODE_ENV === 'test';
}
