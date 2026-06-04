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
 * Phase 5 Parent RSS Max (MB) — legacy pre-PR-V3-T1a default.
 *
 * Retained as `LEGACY_PARENT_RSS_MAX_MB_PRE_T1A` so the
 * `parent_rss_ceiling_scaled` audit emission can record the before-value
 * deterministically (the SSOT scaling event records 7168 → 8192).
 * Operators that explicitly hold at 7168 via the `PHASE5_PARENT_RSS_MAX_MB`
 * env override are NOT audited as scaling events — that is an operator
 * override, not a scaling event.
 *
 * Legacy pre-PR-V3-T1a ceiling (7168 MB). Retained so the
 * `parent_rss_ceiling_scaled` audit event records the scaling event's
 * before-value deterministically. Operator override at 7168 is NOT a
 * scaling event.
 */
export const LEGACY_PARENT_RSS_MAX_MB_PRE_T1A = 7168;

/**
 * Phase 5 Parent RSS Max (MB) デフォルト値
 * Default for Phase 5 parent-process RSS ceiling (MB)
 *
 * PR-V3-T1a §3.4.2 / Plan v3 V2 §3.1 T1.3 (2026-05-04):
 * - 7168 MB → 8192 MB (8 GB) に segment 化
 * - 理由 (FIND-V3-IO-M-07 closure):
 *     - PR-V3-T1a による streaming chunked encoder hardening で C1 contract
 *       (per-chunk RSS budget 1.5 GB) が導入された結果、parent RSS が一時的に
 *       高止まりするケースでも Phase 5 fork が継続できる安全弁として、parent
 *       ceiling を 16 GB envelope の 50% 相当 (8192 MB) まで segment 化する。
 *     - 8192 + DINOv2 ~800 MB + e5-base ~500 MB ≈ 9492 MB ≈ 59% of 16 GB
 *       (ADR-0013 §Decision Rationale #2 prior 7168+1300 = 53% より約 6
 *       percentage points = ~960 MB tighter); 残 ~6.5 GB は OS / Postgres /
 *       Redis / Chromium の headroom として保持。
 *     - `PHASE5_PARENT_RSS_MAX_MB` env override は引き続き保持。Operator は
 *       16 GB envelope が制約される deployment では 7168 のまま据え置き可能。
 *     - 8192 は ADR-0012 §2.3 が定義する β3 ceiling。さらなる引上げは新規 ADR
 *       を要する。
 *
 * PR-V3-T1a §3.4.2 (2026-05-04): segmented 7168 MB → 8192 MB (8 GB).
 * The streaming chunked encoder hardening introduces the C1 per-chunk RSS
 * budget (1.5 GB), so this segment provides a safety envelope when parent
 * RSS spikes transiently. Total Phase 5 envelope = 8192 + DINOv2 ~800 +
 * e5-base ~500 ≈ 9492 MB ≈ 59% of 16 GB (vs. ADR-0013's prior 53%).
 * `PHASE5_PARENT_RSS_MAX_MB` env override remains; operators may hold at
 * 7168 per-deployment. 8192 is the β3 ceiling defined by ADR-0012 §2.3;
 * further raises require a new ADR.
 *
 * @see ADR-0013 Amendment 1 (parent ceiling 7168 → 8192 MB)
 * @see  §3.4.2
 */
const DEFAULT_PARENT_RSS_MAX_MB = 8192;

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

/**
 * `parent_rss_ceiling_scaled` audit emission idempotency state (PR-V3-T1a
 * §3.4.2). The emission is a one-time-per-process scaling event marker; the
 * second-and-later calls to `emitParentRssCeilingScaledIfApplicable()`
 * within the same process are no-ops (the scaling event is described as
 * "Phase 5 init で **冪等に 1 回 emit**" in design §3.4.2).
 *
 * In test contexts the flag can be reset via
 * `__resetParentRssCeilingScaledForTesting()` to verify emission semantics
 * without leaking state across tests.
 *
 * Idempotency state for the `parent_rss_ceiling_scaled` audit emission.
 * One-time-per-process emission per design §3.4.2. Test-only reset via
 * `__resetParentRssCeilingScaledForTesting()`.
 */
let parentRssCeilingScaledEmitted = false;

/**
 * Test-only: reset the `parent_rss_ceiling_scaled` emission idempotency
 * flag so unit tests can verify emission semantics across multiple calls.
 *
 * Test-only reset for the emission idempotency flag.
 *
 * @internal
 */
export function __resetParentRssCeilingScaledForTesting(): void {
  parentRssCeilingScaledEmitted = false;
}

/**
 * Read the current emission state (test-only observability).
 *
 * Read the emission state (test observability).
 *
 * @internal
 */
export function __isParentRssCeilingScaledEmittedForTesting(): boolean {
  return parentRssCeilingScaledEmitted;
}

/**
 * Determine whether the loaded ceiling represents a PR-V3-T1a scaling event
 * (default 8192 active) vs. an operator override (e.g. 7168 retained or any
 * other env value). The scaling event is emitted once per process when the
 * effective ceiling matches `DEFAULT_PARENT_RSS_MAX_MB` AND the env var
 * `PHASE5_PARENT_RSS_MAX_MB` was NOT explicitly set to 7168 (operator
 * override).
 *
 * Determine whether the loaded ceiling is a scaling event (default 8192,
 * env var not explicitly set to 7168). Operator-explicit 7168 overrides
 * are NOT scaling events.
 */
export function isParentRssCeilingScalingEvent(loaded: Phase5Config): boolean {
  if (loaded.parentRssMaxMb !== DEFAULT_PARENT_RSS_MAX_MB) {
    // Operator override (anything other than the default 8192) is not a
    // scaling event.
    return false;
  }
  // Default is 8192. If the env var was explicitly set to 7168 the safeParse
  // path would have applied that value (so we'd hit the branch above). Any
  // other env value is either accepted (8192 == default no-op) or NaN-fallback.
  return true;
}

/**
 * Build the `details` payload for the `parent_rss_ceiling_scaled` audit
 * emission per design §3.4.2. Numeric / fixed-string only (PII-free,
 * GDPR Art.30 365d retention inherited).
 *
 * Build the `details` payload for the `parent_rss_ceiling_scaled` audit
 * emission. PII-free numeric / fixed-string fields only.
 */
export function buildParentRssCeilingScaledDetails(): {
  before_mb: number;
  after_mb: number;
  trigger: string;
  commit_sha: string;
} {
  const commitSha = process.env.T1A_COMMIT_SHA;
  return {
    before_mb: LEGACY_PARENT_RSS_MAX_MB_PRE_T1A,
    after_mb: DEFAULT_PARENT_RSS_MAX_MB,
    trigger: "plan_v3_t1a_landing",
    commit_sha: commitSha && commitSha.length > 0 ? commitSha : "unknown",
  };
}

/**
 * Emit the `parent_rss_ceiling_scaled` audit event if the loaded config
 * represents a scaling event (PR-V3-T1a §3.4.2). One-shot per process via
 * `parentRssCeilingScaledEmitted` flag. Failure to emit (e.g. emitter
 * throws) is logged at warn level but does NOT break Phase 5 init —
 * audit logging is observability, not a critical path.
 *
 * Caller-supplied `emitter` allows the call site to inject the
 * `AuditLogService` instance from its DI scope (avoids a hard import
 * dependency cycle between `config/` and `services/`).
 *
 * Emit `parent_rss_ceiling_scaled` if the loaded config is a scaling
 * event. One-shot per process. Emitter failures are warned but don't
 * break Phase 5 init. DI-friendly: emitter is caller-supplied.
 *
 * @param loaded the result of `loadPhase5Config()`
 * @param emitter an audit-emitter callback (writes the row + sanitizes details)
 *
 * @see  §3.4.2
 */
export async function emitParentRssCeilingScaledIfApplicable(
  loaded: Phase5Config,
  emitter: (details: {
    before_mb: number;
    after_mb: number;
    trigger: string;
    commit_sha: string;
  }) => Promise<void>
): Promise<void> {
  if (parentRssCeilingScaledEmitted) return;
  if (!isParentRssCeilingScalingEvent(loaded)) return;
  parentRssCeilingScaledEmitted = true;
  try {
    await emitter(buildParentRssCeilingScaledDetails());
  } catch (error) {
    logger.warn("[Phase5Config] failed to emit parent_rss_ceiling_scaled audit event (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
