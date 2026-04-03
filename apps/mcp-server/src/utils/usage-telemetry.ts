// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Usage Telemetry — MCPツール利用計測ログ
 * ツール利用計測のopt-in JSON linesログファイル出力
 *
 * SEC-02: PII/引数除外の厳格な保証
 *   ログエントリは tool/at/durationMs/success の4フィールドのみ。
 *   args, requestId, apiKey, error.message, query, profileId, url 等は絶対に含めない。
 *
 * SEC-03: パストラバーサル防御
 *   path.resolve() + path.normalize() でパスを正規化。
 *   ".." セグメントを含むパスの拒否。
 *   許可ディレクトリ外へのアクセス拒否。
 *
 * TDA: ログローテーション
 *   最大ファイルサイズ 100MB でローテーション。
 *
 * @module utils/usage-telemetry
 */

import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";

// =====================================================
// 定数 / Constants
// =====================================================

/**
 * ログファイル最大サイズ（100MB）
 * Maximum log file size (100MB)
 */
let maxLogFileSizeBytes = 100 * 1024 * 1024;

/**
 * デフォルトログファイル名
 * Default log file name
 */
const DEFAULT_LOG_FILENAME = "tool-usage.jsonl";

/**
 * デフォルトログディレクトリ（プロジェクトルートからの相対）
 * Default log directory (relative to project root)
 */
const DEFAULT_LOG_DIR = "logs";

// =====================================================
// 型定義 / Type Definitions
// =====================================================

/**
 * Usage Telemetryエントリ
 * SEC-02: 4フィールドのみ。PII/引数は含めない。
 *
 * Usage telemetry entry.
 * SEC-02: Only 4 fields. No PII/args included.
 */
export interface UsageTelemetryEntry {
  /** ツール名のみ / Tool name only */
  tool: string;
  /** ISO 8601 タイムスタンプ / ISO 8601 timestamp */
  at: string;
  /** 処理時間（ミリ秒） / Processing duration (milliseconds) */
  durationMs: number;
  /** 成功/失敗 / Success/failure */
  success: boolean;
}

// =====================================================
// 環境変数読み取り / Environment Variable Helpers
// =====================================================

/**
 * Usage Telemetryが有効かどうかを判定
 * TOOL_USAGE_LOG_ENABLED が "true" の場合のみ有効
 *
 * Check if usage telemetry is enabled.
 * Only enabled when TOOL_USAGE_LOG_ENABLED is "true".
 */
export function isUsageTelemetryEnabled(): boolean {
  return process.env.TOOL_USAGE_LOG_ENABLED === "true";
}

/**
 * ログファイルパスを取得
 * TOOL_USAGE_LOG_PATH 環境変数、またはデフォルトパス
 *
 * Get log file path from TOOL_USAGE_LOG_PATH env var or default.
 */
export function getLogPath(): string {
  const envPath = process.env.TOOL_USAGE_LOG_PATH;
  if (envPath) {
    return envPath;
  }
  // デフォルト: プロジェクトルート/logs/tool-usage.jsonl
  // Default: project root / logs / tool-usage.jsonl
  const projectRoot = path.resolve(__dirname, "../..");
  return path.join(projectRoot, DEFAULT_LOG_DIR, DEFAULT_LOG_FILENAME);
}

// =====================================================
// パストラバーサル防御 / Path Traversal Defense
// =====================================================

/**
 * ログファイルパスを検証
 * SEC-03: パストラバーサル防御
 *
 * Validate log file path.
 * SEC-03: Path traversal defense.
 *
 * @param filePath - 検証するファイルパス / File path to validate
 * @returns 正規化されたパス / Normalized path
 * @throws Error パスが不正な場合 / When path is invalid
 */
export function validateLogPath(filePath: string): string {
  // 正規化
  const normalized = path.normalize(path.resolve(filePath));

  // ".." セグメントが元のパスに含まれているか検出
  if (filePath.includes("..")) {
    throw new Error("Path traversal detected: log path must not contain '..' segments");
  }

  // 許可ディレクトリ: プロジェクトルート配下のみ
  const projectRoot = path.resolve(__dirname, "../..");
  if (!normalized.startsWith(projectRoot + path.sep) && normalized !== projectRoot) {
    throw new Error(`Log path must be within the project directory: ${projectRoot}`);
  }

  return normalized;
}

// =====================================================
// エントリ構築 / Entry Builder
// =====================================================

/**
 * テレメトリエントリを構築
 * SEC-02: 4フィールドのみ。PII/引数は含めない。
 *
 * Build a telemetry entry.
 * SEC-02: Only 4 fields. No PII/args included.
 *
 * @param tool - ツール名 / Tool name
 * @param durationMs - 処理時間（ミリ秒）/ Duration in ms
 * @param success - 成功/失敗 / Success/failure
 * @returns UsageTelemetryEntry
 */
export function buildTelemetryEntry(
  tool: string,
  durationMs: number,
  success: boolean
): UsageTelemetryEntry {
  // NaN/Infinity防御 + 負数クランプ
  const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;

  return {
    tool,
    at: new Date().toISOString(),
    durationMs: safeDuration,
    success,
  };
}

// =====================================================
// ログローテーション / Log Rotation
// =====================================================

/**
 * ファイルサイズチェックとローテーション
 * 100MB超の場合、既存ファイルを .old にリネーム
 *
 * Check file size and rotate if > 100MB.
 * Renames existing file to .old suffix.
 *
 * @param filePath - ログファイルパス / Log file path
 */
function rotateIfNeeded(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const stats = fs.statSync(filePath);
    if (stats.size > maxLogFileSizeBytes) {
      const rotatedPath = filePath + ".old";
      fs.renameSync(filePath, rotatedPath);
      logger.info("[UsageTelemetry] Log file rotated", {
        from: filePath,
        to: rotatedPath,
        sizeMB: Math.round(stats.size / 1024 / 1024),
      });
    }
  } catch {
    // ローテーション失敗は無視（fire-and-forget）
    // Rotation failure is ignored (fire-and-forget)
  }
}

/**
 * ローテーション閾値を取得（テスト用）
 * Get rotation threshold (for testing)
 */
export function getMaxLogFileSizeBytes(): number {
  return maxLogFileSizeBytes;
}

/**
 * ローテーション閾値を設定（テスト専用）
 * Set rotation threshold (testing only)
 *
 * @param sizeBytes - 閾値（バイト） / Threshold in bytes
 */
export function setMaxLogFileSizeBytesForTesting(sizeBytes: number): void {
  maxLogFileSizeBytes = sizeBytes;
}

/**
 * ローテーション閾値をデフォルト（100MB）にリセット（テスト用）
 * Reset rotation threshold to default 100MB (for testing)
 */
export function resetMaxLogFileSizeBytes(): void {
  maxLogFileSizeBytes = 100 * 1024 * 1024;
}

// =====================================================
// ログ書き込み / Log Writer
// =====================================================

/**
 * テレメトリエントリをログファイルに書き込む
 * fire-and-forget パターン: 書き込み失敗はツール実行をブロックしない
 *
 * Write telemetry entry to log file.
 * Fire-and-forget pattern: write failure does not block tool execution.
 *
 * @param entry - テレメトリエントリ / Telemetry entry
 */
export async function logToolUsage(entry: UsageTelemetryEntry): Promise<void> {
  // opt-inチェック
  if (!isUsageTelemetryEnabled()) {
    return;
  }

  try {
    const logPath = getLogPath();

    // パス検証
    let validatedPath: string;
    try {
      validatedPath = validateLogPath(logPath);
    } catch {
      // パス検証失敗は無視（fire-and-forget）
      logger.warn("[UsageTelemetry] Invalid log path, skipping", {
        path: logPath,
      });
      return;
    }

    // ディレクトリ作成（存在しない場合）
    const dir = path.dirname(validatedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    }

    // ローテーションチェック
    rotateIfNeeded(validatedPath);

    // JSON lines 形式で追記
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(validatedPath, line, { encoding: "utf-8", mode: 0o640 });
  } catch {
    // fire-and-forget: ログ書き込み失敗は無視
    // fire-and-forget: write failure is silently ignored
  }
}
