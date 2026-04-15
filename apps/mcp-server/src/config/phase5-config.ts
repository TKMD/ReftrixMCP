// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5 Configuration (v0.4.0 PR7a-2)
 *
 * Phase 5（Embedding）開始前の RSS ガード等、Phase 5 全体に関わる runtime
 * 設定を Zod で検証してロードする。本 PR（PR7a-2）では設定の定義のみを行い、
 * 実際の RSS ガード判定（Phase 5 開始前の early skip）は PR7b で活性化する。
 *
 * Zod で検証する目的:
 * - 環境変数の NaN / Infinity / 負値 / 過大値を型レベルで拒絶し、後続の比較
 *   ロジックが `NaN` をリテラル比較してサイレントに壊れることを防ぐ。
 * - 検証失敗時はログ出力の上でデフォルト値にフォールバック（CLI や本番での
 *   起動失敗を避ける）。
 *
 * Loads and validates Phase 5 runtime configuration (RSS guards, etc.) via Zod.
 * In this PR (PR7a-2) only the schema and loader are introduced; the actual
 * RSS guard check that skips Phase 5 when the parent process RSS exceeds the
 * threshold will be activated in PR7b.
 *
 * Why validate with Zod:
 * - Reject NaN / Infinity / negative / oversized env-var values at the type level
 *   so later numeric comparisons (`rss > threshold`) never silently break.
 * - On validation failure, log and fall back to the default instead of crashing
 *   at startup (safe behaviour for both CLI and production).
 *
 * @module config/phase5-config
 */

import { z } from "zod";
import { logger } from "../utils/logger";

/**
 * Phase 5 Parent RSS Max (MB) デフォルト値
 * Default for Phase 5 parent-process RSS ceiling (MB)
 *
 * 3072 MB (3 GB) は page-analyze-worker の典型的な RSS 上限（Phase 5 開始時点）と
 * 同等。これを超えている場合、child process の Visual Embedding（DINOv2 〜800MB）
 * と Text Embedding（e5-base 〜500MB）を同時に起動すると OOM リスクが高い。
 *
 * 3072 MB (3 GB) matches the typical page-analyze-worker RSS at Phase 5 entry.
 * Above this, spawning both the Visual Embedding child (DINOv2 ~800MB) and the
 * Text Embedding child (e5-base ~500MB) risks OOM.
 */
const DEFAULT_PARENT_RSS_MAX_MB = 3072;

/**
 * 許容レンジ
 * - 下限 512 MB: 最低限 1 つの child process を起動できる余地を確保
 * - 上限 131072 MB (128 GB): 単一ノードの現実的な上限 (over-provisioning 防御)
 *
 * Allowed range:
 * - Lower bound 512 MB: reserves minimal headroom for at least one child process
 * - Upper bound 131072 MB (128 GB): realistic single-node ceiling (over-provisioning guard)
 */
const PARENT_RSS_MIN_MB = 512;
const PARENT_RSS_MAX_MB = 131072;

/**
 * Phase 5 Config Zod スキーマ
 * Phase 5 config Zod schema
 */
export const Phase5ConfigSchema = z.object({
  /**
   * Phase 5 開始前に許容する親プロセス RSS の上限（MB）
   * Parent-process RSS ceiling (MB) allowed at Phase 5 entry
   *
   * PR7a-2 では定義のみ。PR7b で Phase 5 開始前の early skip 判定に使用される。
   * Defined only in PR7a-2; used in PR7b for the Phase 5 early-skip guard.
   */
  parentRssMaxMb: z
    .number()
    .int()
    .min(PARENT_RSS_MIN_MB)
    .max(PARENT_RSS_MAX_MB)
    .default(DEFAULT_PARENT_RSS_MAX_MB),
});

export type Phase5Config = z.infer<typeof Phase5ConfigSchema>;

/**
 * 環境変数から Phase 5 設定をロードする
 * Load Phase 5 config from environment variables
 *
 * 環境変数:
 * - `PHASE5_PARENT_RSS_MAX_MB`: 親プロセス RSS 上限（MB、整数）
 *
 * Environment variables:
 * - `PHASE5_PARENT_RSS_MAX_MB`: parent RSS ceiling in MB (integer)
 *
 * 不正値（NaN / 負値 / 過大値）は warn してデフォルトにフォールバック。
 * Invalid values (NaN / negative / oversized) warn and fall back to defaults.
 */
export function loadPhase5Config(): Phase5Config {
  const raw = process.env["PHASE5_PARENT_RSS_MAX_MB"];

  // 未設定の場合は Zod default に任せる
  // When unset, let Zod apply the default
  if (raw === undefined || raw === "") {
    return Phase5ConfigSchema.parse({});
  }

  const parsed = Number(raw);
  const result = Phase5ConfigSchema.safeParse({ parentRssMaxMb: parsed });
  if (!result.success) {
    logger.warn("[Phase5Config] invalid PHASE5_PARENT_RSS_MAX_MB — falling back to default", {
      raw,
      parsed,
      default: DEFAULT_PARENT_RSS_MAX_MB,
      issues: result.error.issues.map((i) => i.message),
    });
    return { parentRssMaxMb: DEFAULT_PARENT_RSS_MAX_MB };
  }
  return result.data;
}
