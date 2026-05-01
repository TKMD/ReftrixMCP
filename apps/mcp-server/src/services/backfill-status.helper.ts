// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backfill Status Helper — SSOT for "remaining embedding" decision
 *
 * v0.4.0 PR7e-β2 carryover (SSOT unification): `embedding-backfill-worker.ts` と
 * `backfill-reconciliation.service.ts` の両方で「残り backfill 対象があるか」を
 * 判定する必要があるが、2 箇所で独自に数えると drift する（backfill 成功後も
 * reconciliation が誤って failed に遷移させる誤判定の原因だった）。本 helper に
 * 集約し、Worker / Reconciliation の両方から同じ prisma-injection 可能な関数を
 * 参照させることで SSOT を保証する。
 *
 * v0.4.0 PR7e-β2 carryover (SSOT unification): Both the worker and the
 * reconciliation service must decide "are there remaining backfill items for
 * this page?". Maintaining two parallel implementations drifted and caused the
 * reconciliation to mis-transition rows to `failed` even after a successful
 * backfill. Consolidating into this helper with prisma injection guarantees a
 * single source of truth shared by the worker and the reconciliation path.
 *
 * v0.4.0 PR-D-4 (INV-EMBEDDING-INTEGRITY-003 full landing): adds
 * `collectCategoryPendingSnapshot` as a shared helper that returns the per-
 * category pending-count snapshot in a single DB round-trip. Refactors
 * `computeRemainingStatusWithPrisma` to consume this helper and return both
 * `finalStatus` and `pendingSnapshot` in one round-trip, eliminating the
 * phantom-read surface that would otherwise exist between the finalStatus
 * check and the parity check. Adds `verifyCategoryParity` as a lightweight
 * validator over a pre-collected snapshot (no additional DB round-trip).
 *
 * v0.4.0 PR-D-4 (INV-EMBEDDING-INTEGRITY-003 full landing): introduces
 * `collectCategoryPendingSnapshot` as a shared single-round-trip helper.
 * `computeRemainingStatusWithPrisma` is refactored to return both
 * `finalStatus` and `pendingSnapshot`, structurally eliminating the phantom-
 * read surface. `verifyCategoryParity` validates a pre-collected snapshot
 * without an extra DB round-trip. Resolves FIND-PLAN-IO-02
 * (TPA-01 + SEC-01 + TDA-01 + Plan FIND-08) atomically.
 *
 * 公開 API 契約 / Public API contract:
 *   - `collectCategoryPendingSnapshot(webPageId, prisma)` - 7 カテゴリ全ての
 *     pending count を Promise.all で並列取得する shared helper。
 *     `computeRemainingStatusWithPrisma` と `verifyCategoryParity` の両方が
 *     consume する (DRY 解決、FIND-PLAN-IO-02)。
 *   - `computeRemainingStatusWithPrisma(webPageId, prisma)` - single round-trip
 *     で `{finalStatus, pendingSnapshot}` を返す (PR-D-4 refactor)。
 *     `finalStatus` は `'completed' | 'in_progress'`。
 *   - `verifyCategoryParity(pendingSnapshot)` - 軽量 validator。与えられた
 *     snapshot を `ok/pendingSnapshot` 形式で返す (DB round-trip なし)。
 *   - `countPartVisualBackfillTargetsWithPrisma(webPageId, prisma)` - 既存 API。
 *     `{ pendingCount: number }` を返す。
 *
 * Public API contract:
 *   - `collectCategoryPendingSnapshot(webPageId, prisma)` is the shared helper
 *     that collects the 7-category pending-count snapshot via a single
 *     Promise.all. Consumed by both `computeRemainingStatusWithPrisma` and
 *     `verifyCategoryParity` (DRY resolution per FIND-PLAN-IO-02).
 *   - `computeRemainingStatusWithPrisma(webPageId, prisma)` returns
 *     `{finalStatus, pendingSnapshot}` in a single round-trip (PR-D-4
 *     refactor). `finalStatus` is `'completed' | 'in_progress'`.
 *   - `verifyCategoryParity(pendingSnapshot)` is a lightweight validator over
 *     a pre-collected snapshot (no DB round-trip).
 *   - `countPartVisualBackfillTargetsWithPrisma(webPageId, prisma)` (existing)
 *     returns `{ pendingCount: number }`.
 *
 * @module services/backfill-status.helper
 */

import type { PrismaClient } from "@prisma/client";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  type EmbeddingBackfillCategory,
} from "../queues/embedding-backfill-queue";

/**
 * Per-category pending-count snapshot. Keys are Set-equal to
 * `EMBEDDING_BACKFILL_CATEGORIES` T1 SSOT (currently 7 categories), values are
 * non-negative integer pending counts.
 *
 * **PII safety invariant (FIND-PLAN-IO-10, L)**: this shape MUST remain
 * numeric-only. Do NOT extend with per-entity identifiers (IDs / hashes /
 * URLs / user identifiers) in future revisions. Only category key +
 * numeric count is permitted. Violation risks GDPR Art.5(1)(c) minimization.
 *
 * Keys Set-equal to `EMBEDDING_BACKFILL_CATEGORIES` (currently 7) and values
 * are non-negative integer pending counts. MUST remain numeric-only to
 * preserve PII-minimization guarantees (FIND-PLAN-IO-10).
 */
export type CategoryPendingSnapshot = Record<EmbeddingBackfillCategory, number>;

/**
 * Part visual embedding (DINOv2) backfill 対象件数（prisma 注入版）
 *
 * v0.4.0 PR7e-β2 carryover: `embedding-backfill.service.ts` の
 * `countPartVisualBackfillTargets` と同じクエリだが、引数で prisma を受け取る。
 * SSOT helper なので blank image skip / section カバー外 parts には関与しない
 * （それらは Phase 5 の screenshot 絞り込みで表現される）。
 *
 * v0.4.0 PR7e-β2 carryover: Same query as
 * `countPartVisualBackfillTargets` in `embedding-backfill.service.ts` but
 * accepts an injected `prisma`. Blank-image skips / out-of-section parts are
 * already filtered upstream via Phase 5 screenshot narrowing.
 */
export async function countPartVisualBackfillTargetsWithPrisma(
  webPageId: string,
  prisma: PrismaClient
): Promise<{ pendingCount: number }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | string }>>(
    `SELECT COUNT(*)::bigint AS count FROM component_parts cp
     JOIN component_part_embeddings cpe ON cp.id = cpe.component_part_id
     WHERE cp.web_page_id = $1::uuid
       AND cp.pii_risk_level != 'high'
       AND cpe.visual_embedding IS NULL`,
    webPageId
  );
  const raw = rows[0]?.count ?? 0;
  const n = typeof raw === "bigint" ? Number(raw) : Number.parseInt(String(raw), 10);
  return { pendingCount: Number.isFinite(n) && n > 0 ? n : 0 };
}

/**
 * 正規化された section_visual 生 bigint → number 変換（defensive）
 * Normalize a raw section_visual bigint-or-string count to a non-negative number.
 */
function parseBigintCount(rows: Array<{ count: bigint | string }>): number {
  const raw = rows[0]?.count ?? 0;
  const n = typeof raw === "bigint" ? Number(raw) : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * 7 カテゴリ全ての pending count snapshot を単一 Promise.all で取得する shared helper。
 *
 * `computeRemainingStatusWithPrisma` と `verifyCategoryParity` の両方が本 helper を
 * consume し、DRY を保ちつつ single DB round-trip で snapshot を取得する
 * (FIND-PLAN-IO-02 / TPA-01 + SEC-01 + TDA-01 + Plan FIND-08 原子的解決)。
 *
 * **Fail-closed contract (FIND-PLAN-IO-06 (i))**: Promise.all 内のいずれかの
 * クエリが reject された場合、本 helper は silent に 0 を返さず必ず error を
 * throw する。caller (`computeRemainingStatusWithPrisma`) はこの error を呼び出し
 * 元に伝播し、`parity_check_failed` retry bucket への遷移を保証する。GDPR
 * Art.5(1)(d) accuracy 遵守。
 *
 * Shared helper that collects the 7-category pending-count snapshot via a
 * single Promise.all, consumed by both `computeRemainingStatusWithPrisma` and
 * `verifyCategoryParity` (DRY resolution; atomic resolution of FIND-PLAN-IO-02
 * = TPA-01 + SEC-01 + TDA-01 + Plan FIND-08).
 *
 * **Fail-closed contract (FIND-PLAN-IO-06 (i))**: On rejection of any query
 * in Promise.all, this helper MUST NOT silently return 0 — it MUST throw so
 * the caller (`computeRemainingStatusWithPrisma`) propagates the error to the
 * upstream, guaranteeing a transition to the `parity_check_failed` retry
 * bucket (GDPR Art.5(1)(d) accuracy compliance).
 *
 * @param webPageId - target web page UUID
 * @param prisma    - injected Prisma client (worker / reconciliation share the helper)
 * @returns snapshot keyed by EmbeddingBackfillCategory with pending counts
 * @throws when any of the 7 Promise.all queries rejects (fail-closed)
 */
export async function collectCategoryPendingSnapshot(
  webPageId: string,
  prisma: PrismaClient
): Promise<CategoryPendingSnapshot> {
  const [
    partTextPending,
    partVisualPending,
    sectionVisualPending,
    motionPending,
    backgroundPending,
    jsAnimationPending,
    responsivePending,
  ] = await Promise.all([
    // part_text
    prisma.componentPart.count({
      where: {
        webPageId,
        piiRiskLevel: { not: "high" },
        embedding: { is: null },
      },
    }),
    // part_visual
    countPartVisualBackfillTargetsWithPrisma(webPageId, prisma),
    // section_visual: text_embedding がある section のうち vision_embedding NULL
    // section_visual: sections with text_embedding but vision_embedding NULL
    prisma.$queryRawUnsafe<Array<{ count: bigint | string }>>(
      `SELECT COUNT(*)::bigint AS count FROM section_embeddings se
       JOIN section_patterns sp ON se.section_pattern_id = sp.id
       WHERE sp.web_page_id = $1::uuid
         AND se.text_embedding IS NOT NULL
         AND se.vision_embedding IS NULL`,
      webPageId
    ),
    // motion: motion_patterns に対応する motion_embeddings 行が無い件数
    // motion: motion_patterns rows lacking a corresponding motion_embeddings row
    prisma.motionPattern.count({
      where: { webPageId, embedding: { is: null } },
    }),
    // background: background_designs に対応する embedding 行が無い件数
    // background: background_designs lacking an embedding row
    prisma.backgroundDesign.count({
      where: { webPageId, embedding: { is: null } },
    }),
    // js_animation
    prisma.jSAnimationPattern.count({
      where: { webPageId, embedding: { is: null } },
    }),
    // responsive
    prisma.responsiveAnalysis.count({
      where: { webPageId, embedding: { is: null } },
    }),
  ]);

  const sectionVisualCount = parseBigintCount(sectionVisualPending);

  // Snapshot 構築。keys は EMBEDDING_BACKFILL_CATEGORIES と Set-equal でなければ
  // ならない (regression detection は tests で pin)。
  // Snapshot keys are Set-equal to EMBEDDING_BACKFILL_CATEGORIES (regression
  // pinned in tests).
  const snapshot: CategoryPendingSnapshot = {
    part_text: Number.isFinite(partTextPending) && partTextPending >= 0 ? partTextPending : 0,
    part_visual: partVisualPending.pendingCount,
    section_visual: sectionVisualCount,
    motion: Number.isFinite(motionPending) && motionPending >= 0 ? motionPending : 0,
    background:
      Number.isFinite(backgroundPending) && backgroundPending >= 0 ? backgroundPending : 0,
    js_animation:
      Number.isFinite(jsAnimationPending) && jsAnimationPending >= 0 ? jsAnimationPending : 0,
    responsive:
      Number.isFinite(responsivePending) && responsivePending >= 0 ? responsivePending : 0,
  };

  // Invariant (runtime guard): snapshot keys must equal SSOT categories.
  // This is defensive; a test (`INV-EMBEDDING-INTEGRITY-003 B5`) pins the
  // Set-equality at AST level. A runtime mismatch would indicate a newly
  // added category in SSOT without updating this helper.
  for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
    if (!(category in snapshot)) {
      throw new Error(
        `[backfill-status.helper] SSOT category drift: '${category}' present in ` +
          "EMBEDDING_BACKFILL_CATEGORIES but missing from pendingSnapshot. Update " +
          "collectCategoryPendingSnapshot to cover the new category."
      );
    }
  }

  return snapshot;
}

/**
 * INV-EMBEDDING-INTEGRITY-003 strict parity gate (lightweight validator).
 *
 * **Preferred path (PR-D-4, FIND-PLAN-IO-02)**: 呼び出し側から `pendingSnapshot` を
 * 渡すだけの軽量関数として動作する (追加 DB round-trip なし)。
 * `computeRemainingStatusWithPrisma` が `{finalStatus, pendingSnapshot}` を単一
 * round-trip で返すため、phantom-read surface は構造的に消滅する。
 *
 * **Invocation-ordering contract (FIND-PLAN-IO-10)**: MUST be called BEFORE
 * `updateEmbeddingBackfillStatus(webPageId, 'completed')`. Reordering is a
 * contract violation — if the `completed` transition is written before parity
 * is verified, the TOCTOU guarantee collapses.
 *
 * **PII invariant (FIND-PLAN-IO-10)**: `pendingSnapshot` MUST NOT be extended
 * to include per-entity PII fields (IDs / hashes / URLs / user identifiers)
 * in future revisions. Keys MUST remain `EmbeddingBackfillCategory` and values
 * MUST remain numeric counts. Violation risks GDPR Art.5(1)(c) minimization.
 *
 * Strict parity gate for INV-EMBEDDING-INTEGRITY-003.
 *
 * **Preferred path (PR-D-4, FIND-PLAN-IO-02)**: lightweight validator — the
 * caller passes a pre-collected snapshot, no additional DB round-trip. With
 * `computeRemainingStatusWithPrisma` returning `{finalStatus, pendingSnapshot}`
 * in a single round-trip, the phantom-read surface disappears structurally.
 *
 * **Invocation-ordering contract (FIND-PLAN-IO-10)**: MUST be called BEFORE
 * `updateEmbeddingBackfillStatus(webPageId, 'completed')`.
 *
 * **PII invariant (FIND-PLAN-IO-10)**: Future revisions MUST NOT extend
 * `pendingSnapshot` to include per-entity PII fields. Keys remain
 * `EmbeddingBackfillCategory`; values remain numeric.
 *
 * @param pendingSnapshot - snapshot produced by `collectCategoryPendingSnapshot`
 * @returns `{ok, pendingSnapshot}` — `ok: true` iff all categories are zero
 */
export function verifyCategoryParity(pendingSnapshot: CategoryPendingSnapshot): {
  ok: boolean;
  pendingSnapshot: CategoryPendingSnapshot;
} {
  let totalPending = 0;
  for (const value of Object.values(pendingSnapshot)) {
    // Defense against NaN/Infinity: treat non-finite as 0 for the aggregate.
    // The snapshot producer (`collectCategoryPendingSnapshot`) already
    // normalizes, but downstream callers may pass hand-built snapshots.
    if (Number.isFinite(value) && value > 0) {
      totalPending += value;
    }
  }
  return { ok: totalPending === 0, pendingSnapshot };
}

/**
 * Worker 実行後の残余 backfill 状態を返す（prisma 注入版 — SSOT）
 *
 * 全 7 カテゴリの pending 件数を一括で集計し、いずれかが残っていれば
 * `'in_progress'`、全て 0 なら `'completed'` を返す。`embedding-backfill-worker.ts`
 * の `computeRemainingStatus` と `backfill-reconciliation.service.ts` の
 * reconciliation 判定は同じこの helper を呼び出す。
 *
 * v0.4.0 PR-D-4: `collectCategoryPendingSnapshot` を 1 回呼び、`{finalStatus, pendingSnapshot}`
 * を単一 round-trip で返す形に refactor。以前は `finalStatus` のみを返していたが、
 * parity check 経路で pendingSnapshot を再利用できるようにした。phantom-read
 * surface が構造的に消滅する (FIND-PLAN-IO-02)。
 *
 * v0.4.0 PR-D-4: refactored to invoke `collectCategoryPendingSnapshot` once
 * and return `{finalStatus, pendingSnapshot}` in a single round-trip, so the
 * parity-check path reuses the same snapshot. Phantom-read surface is
 * structurally eliminated (FIND-PLAN-IO-02).
 *
 * カテゴリ / Categories (matching `EMBEDDING_BACKFILL_CATEGORIES`):
 *   - part_text: component_parts.embedding IS NULL
 *   - part_visual: component_part_embeddings.visual_embedding IS NULL (PII filtered)
 *   - section_visual: section_embeddings.text_embedding IS NOT NULL AND vision_embedding IS NULL
 *   - motion: motion_patterns without motion_embeddings row
 *   - background: background_designs without background_design_embeddings row
 *   - js_animation: js_animation_patterns without js_animation_embeddings row
 *   - responsive: responsive_analyses without responsive_analysis_embeddings row
 *
 * Computes the post-run remaining backfill state across all 7 categories.
 * Returns `{finalStatus, pendingSnapshot}` in a single DB round-trip. Both
 * the worker's `computeRemainingStatus` and the reconciliation's SSOT
 * decision delegate to this helper.
 *
 * **Fail-closed**: On DB failure (any category query rejects), this function
 * propagates the error to the caller (does NOT silently default to
 * `completed`). Caller is expected to route to `parity_check_failed` retry
 * bucket (GDPR Art.5(1)(d) accuracy).
 */
export async function computeRemainingStatusWithPrisma(
  webPageId: string,
  prisma: PrismaClient
): Promise<{
  finalStatus: "completed" | "in_progress";
  pendingSnapshot: CategoryPendingSnapshot;
}> {
  // Single-query refactor: both finalStatus verdict and pendingSnapshot come
  // from one collectCategoryPendingSnapshot call (FIND-PLAN-IO-02).
  const pendingSnapshot = await collectCategoryPendingSnapshot(webPageId, prisma);

  let totalPending = 0;
  for (const value of Object.values(pendingSnapshot)) {
    if (Number.isFinite(value) && value > 0) {
      totalPending += value;
    }
  }

  const finalStatus: "completed" | "in_progress" = totalPending === 0 ? "completed" : "in_progress";
  return { finalStatus, pendingSnapshot };
}
