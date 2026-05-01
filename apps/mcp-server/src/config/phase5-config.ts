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
 * PR7e-β2 段階緩和 (2026-04-17):
 * - 4096 MB → 7168 MB (7 GB) にさらに段階緩和
 * - 理由 (実測ベース):
 *     - β1 4096 MB: reftrix.io / Stripe で RSS=5028-5528 MB → skip
 *     - 中間値 6144 MB で再検証: reftrix.io で Phase 4 narrative 完了後
 *       RSS=6363 MB → 依然として skip
 *     - 6363 MB の主因: Phase 4 (Narrative) が e5-base embedding worker
 *       thread (~500-800 MB) を起動し、その分が積み上がる。Phase 4→5
 *       handoff の選択的解放 (P0-2) では中間データのみ破棄し worker thread
 *       は維持する (Phase 5 で再利用するため)。
 *     - 観測最大値 6363 MB に ~13% マージンを取って 7168 MB (7 GB) に設定。
 *     - システム RAM 16 GB の場合、Phase 5 fork 子プロセス (DINOv2 ~800 MB
 *       + e5-base ~500 MB ≈ 1300 MB) を加えても 7168 + 1300 = 8468 MB <
 *       16 GB の半分以下に収まる。
 *   β3 (PR7e 本体) で embedding worker thread の Phase 4→5 dispose 等の
 *   構造的最適化を行い ceiling を再度引き下げることを検討する。
 *
 * PR7e-β2 tier relaxation (2026-04-17):
 * - Raised 4096 MB → 7168 MB (7 GB) in further tier relaxation.
 * - Rationale (measurement-driven):
 *     - β1 4096 MB: reftrix.io / Stripe measured RSS=5028-5528 MB → skip
 *     - Mid-step 6144 MB re-test: reftrix.io measured RSS=6363 MB after
 *       Phase 4 narrative → still skip
 *     - Root cause of 6363 MB: Phase 4 (Narrative) spawns the e5-base
 *       embedding worker thread (~500-800 MB) which accumulates. The
 *       Phase 4→5 handoff selective disposal (P0-2) drops only intermediate
 *       data and intentionally preserves the worker thread (re-used in Phase 5).
 *     - Setting ceiling to 7168 MB (~13% headroom over observed max 6363 MB).
 *     - On a 16 GB RAM system, Phase 5 fork children (DINOv2 ~800 MB +
 *       e5-base ~500 MB ≈ 1300 MB) on top of the 7168 MB parent still leaves
 *       7168 + 1300 = 8468 MB, well under half of 16 GB.
 *   β3 (PR7e main) will explore structural optimizations (e.g. disposing the
 *   embedding worker thread at the Phase 4→5 boundary) to lower the ceiling
 *   again.
 *
 * PR7e-β1 tier relaxation (2026-04-16, superseded by β2):
 * - Raised 3072 MB → 4096 MB
 * - Rationale: on Stripe (697 parts), parent RSS at Phase 5 entry hit
 *   5027 MB and early-skip fired, producing zero visual embeddings.
 *
 * 旧コメント / Legacy comment:
 * 3072 MB (3 GB) matches the typical page-analyze-worker RSS at Phase 5 entry.
 * Above this, spawning both the Visual Embedding child (DINOv2 ~800MB) and the
 * Text Embedding child (e5-base ~500MB) risks OOM.
 */
const DEFAULT_PARENT_RSS_MAX_MB = 7168;

/**
 * Phase 4 → Phase 5 handoff 時の layoutResultForNarrative.sections 件数上限
 * デフォルト値
 * Default cap on layoutResultForNarrative.sections count at the Phase 4 → 5 handoff
 *
 * 大量セクションを含むページ (例: Stripe 697 parts / ~100 sections) で Phase 5
 * に丸ごと入力すると、各セクションの DINOv2 Visual Embedding 生成 (768D ×
 * セクション数) で DINOv2 子プロセスの RSS が急増し OOM を誘発する。50 件は
 * β1 時点のユーザー要求 (主要レイアウト構造が確認できる件数) と OOM 防止の
 * バランスから暫定決定。β3 で観測ログを元に再評価する。
 *
 * Ingesting all sections from a section-heavy page (e.g. Stripe 697 parts /
 * ~100 sections) into Phase 5 at once makes the DINOv2 child's RSS spike
 * during per-section Visual Embedding (768D × sections) and triggers OOM.
 * 50 balances β1 user needs (still captures main layout structure) against
 * OOM prevention. To be re-evaluated in β3 using observability data.
 */
const DEFAULT_MAX_SECTIONS_INPUT = 50;

/**
 * layoutResultForNarrative.sections 件数上限の許容レンジ
 * - 下限 1: 最低 1 セクションは渡せる (テスト容易性)
 * - 上限 500: 旧来の Section Post-Processor MAX_INPUT_SECTIONS と同値
 *
 * Allowed range for the sections cap:
 * - Lower bound 1: allow at least 1 section (testability)
 * - Upper bound 500: matches the existing Section Post-Processor MAX_INPUT_SECTIONS
 */
const MAX_SECTIONS_INPUT_MIN = 1;
const MAX_SECTIONS_INPUT_MAX = 500;

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
  /**
   * Phase 4 → Phase 5 handoff 時の sections 件数上限
   * Cap on sections count at Phase 4 → Phase 5 handoff
   *
   * PR7e-β1 新設 (ADR-0012 §3 BLOCKER 4)
   * PR7e-β1 addition (ADR-0012 §3 BLOCKER 4)
   */
  maxSectionsInput: z
    .number()
    .int()
    .min(MAX_SECTIONS_INPUT_MIN)
    .max(MAX_SECTIONS_INPUT_MAX)
    .default(DEFAULT_MAX_SECTIONS_INPUT),
});

export type Phase5Config = z.infer<typeof Phase5ConfigSchema>;

/**
 * 環境変数から Phase 5 設定をロードする
 * Load Phase 5 config from environment variables
 *
 * 環境変数 / Environment variables:
 * - `PHASE5_PARENT_RSS_MAX_MB`: 親プロセス RSS 上限（MB、整数）/ parent RSS ceiling (MB, integer)
 * - `PHASE5_MAX_SECTIONS_INPUT`: Phase 4→5 handoff の sections 件数上限 / sections cap at Phase 4→5 handoff
 *
 * 不正値（NaN / Infinity / 負値 / 過大値）は warn してデフォルトにフォールバック。
 * Invalid values (NaN / Infinity / negative / oversized) warn and fall back to defaults.
 */
export function loadPhase5Config(): Phase5Config {
  const rssRaw = process.env["PHASE5_PARENT_RSS_MAX_MB"];
  const sectionsRaw = process.env["PHASE5_MAX_SECTIONS_INPUT"];

  // Build an input object containing only env-supplied values; Zod applies defaults otherwise.
  const input: Partial<Phase5Config> = {};

  // parentRssMaxMb
  let parentRssValidationFailed = false;
  let parsedRss: number | undefined;
  if (rssRaw !== undefined && rssRaw !== "") {
    parsedRss = Number(rssRaw);
    if (!Number.isFinite(parsedRss)) {
      parentRssValidationFailed = true;
    } else {
      input.parentRssMaxMb = parsedRss;
    }
  }

  // maxSectionsInput
  let maxSectionsValidationFailed = false;
  let parsedSections: number | undefined;
  if (sectionsRaw !== undefined && sectionsRaw !== "") {
    parsedSections = Number(sectionsRaw);
    if (!Number.isFinite(parsedSections)) {
      maxSectionsValidationFailed = true;
    } else {
      input.maxSectionsInput = parsedSections;
    }
  }

  const result = Phase5ConfigSchema.safeParse(input);
  if (!result.success) {
    logger.warn("[Phase5Config] invalid env values — falling back to defaults", {
      rssRaw,
      parsedRss,
      sectionsRaw,
      parsedSections,
      defaults: {
        parentRssMaxMb: DEFAULT_PARENT_RSS_MAX_MB,
        maxSectionsInput: DEFAULT_MAX_SECTIONS_INPUT,
      },
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return {
      parentRssMaxMb: DEFAULT_PARENT_RSS_MAX_MB,
      maxSectionsInput: DEFAULT_MAX_SECTIONS_INPUT,
    };
  }

  if (parentRssValidationFailed || maxSectionsValidationFailed) {
    logger.warn("[Phase5Config] env contained NaN/Infinity — using defaults for affected fields", {
      parentRssInvalid: parentRssValidationFailed,
      maxSectionsInvalid: maxSectionsValidationFailed,
    });
  }

  return result.data;
}
