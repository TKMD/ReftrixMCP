// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GPU有効化ブラウザ起動フラグの共通定義
 *
 * page-ingest-adapter.ts と webgl-animation-handler.ts の両方で使用される
 * Chromiumブラウザ起動フラグを一元管理する。
 *
 * @module utils/gpu-browser-args
 */

/**
 * GPU有効化ブラウザの共通起動フラグ
 *
 * - `--use-angle=gl`: ANGLE GLバックエンドを使用
 * - `--enable-gpu-rasterization`: GPUラスタライズを有効化
 * - `--ignore-gpu-blocklist`: GPUブロックリストを無視
 * - `--disable-dev-shm-usage`: Docker環境対応（/dev/shm枯渇防止）
 * - `--disable-setuid-sandbox`: setuid sandbox無効化（ネットワークsandboxは維持）
 * - `--gpu-sandbox-start-early`: GPUサンドボックスの早期起動（セキュリティ強化）
 */
export const GPU_BROWSER_BASE_ARGS: readonly string[] = [
  '--use-angle=gl',
  '--enable-gpu-rasterization',
  '--ignore-gpu-blocklist',
  '--disable-dev-shm-usage',
  '--disable-setuid-sandbox',
  '--gpu-sandbox-start-early',
] as const;

/**
 * WebGL検出用の追加フラグ
 *
 * GPU有効化に加えて `--enable-webgl` を含む。
 * canvas.getContext('webgl') が null を返す問題を回避するために必要。
 */
export const WEBGL_BROWSER_ARGS: readonly string[] = [
  ...GPU_BROWSER_BASE_ARGS,
  '--enable-webgl',
] as const;
