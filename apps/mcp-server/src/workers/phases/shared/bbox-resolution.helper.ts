// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Bbox Resolution Helper (Skeleton)
 *
 * Part bounding box 解決を Phase 5 embedding パスと repair script /
 * Queue-based Backfill から共通利用するための thin wrapper ヘルパー。
 *
 * Thin-wrapper helper that unifies Part bounding box resolution across
 * the Phase 5 embedding path and the repair script / Queue-based Backfill.
 *
 * ## 背景 / Background
 *
 * v0.4.0 PR7e-α で、Part Bbox 解決を以下 3 箇所から同じロジックで呼び出す
 * 必要が生じた:
 *
 * v0.4.0 PR7e-α unified Part Bbox resolution invocations across 3 call
 * sites:
 *
 * 1. Phase 5 Embedding (同期) / Phase 5 Embedding (synchronous)
 * 2. Queue-based Backfill worker (非同期) / Queue-based Backfill worker (async)
 * 3. `repair-orphaned-backfill-records.ts` (運用) / Operator repair script
 *
 * 重複排除と以下の保証を集中管理することが本ヘルパーの役目:
 *
 * This helper centralizes DRY and enforces:
 *
 * - SSRF 再検証 (`validateExternalUrl`) — α backfill 経路で URL が DB から
 *   読み出される場合の二重防御 (SEC HIGH-1)
 * - sharedBrowser fallback — `isConnected()` チェック + standalone Chromium
 *   launch
 * - LaunchSemaphore — 複数ジョブ同時実行時の Chromium 競合抑制 (max=1)
 * - `skipReason=ssrf_blocked_on_backfill` の discriminated result
 *
 * ## α0 スコープ / α0 Scope
 *
 * 本ファイルは **型定義 + 骨格のみ** 提供する。実装は PR7e-α で完成する。
 * α0 の目的は、後続 PR が参照する型を先行確立して diff 境界を明確化する
 * ことにある。
 *
 * This file provides **type definitions + skeleton only**. The actual
 * implementation lands in PR7e-α. α0's purpose is to pre-establish types
 * so that subsequent PRs have a clean diff boundary.
 *
 * @module workers/phases/shared/bbox-resolution.helper
 */

import type { PrismaClient } from "@prisma/client";
import type { Browser } from "playwright";
import { validateExternalUrl } from "../../../utils/url-validator";
import { logger } from "../../../utils/logger";
import { partBboxLaunchSemaphore } from "../../../utils/launch-semaphore";
import { sanitizeErrorMessage } from "../../../utils/sanitize-error";
import { resolvePartBoundingBoxes } from "../../../services/part/part-bbox-playwright.service";
import { getAuditLogService } from "../../../services/audit-log.service";

/**
 * Part bbox 解決ヘルパーのパラメータ
 * Parameters for the Part bbox resolution helper
 */
export interface BboxResolutionParams {
  /** WebPage DB ID */
  webPageId: string;
  /** ソースURL / Source URL */
  url: string;
  /** Prisma クライアント / Prisma client */
  prisma: PrismaClient;
  /**
   * 共有ブラウザ。`null` / `undefined` の場合は standalone Chromium を起動する。
   * Shared browser. When `null` / `undefined`, a standalone Chromium is launched.
   */
  sharedBrowser: Browser | null;
  /**
   * `false` を指定した場合のみ SSRF 再検証をスキップする。既定 (`undefined`) では
   * 必ず `validateExternalUrl` を再実行する (SEC HIGH-1)。
   *
   * SSRF re-validation is skipped only when explicitly set to `false`. The
   * default (`undefined`) always re-runs `validateExternalUrl` per SEC HIGH-1.
   */
  validateUrl?: boolean;
  /**
   * 実行主体 (repair script での actor 記録用)。Phase 5 / backfill では省略可。
   * Operator identifier (used by the repair script for actor tracking).
   * Optional for Phase 5 / backfill paths.
   */
  operator?: string;
  /** ビューポート幅 / Viewport width */
  viewportWidth?: number;
  /** ビューポート高さ / Viewport height */
  viewportHeight?: number;
}

/**
 * Part bbox 解決ヘルパーの結果
 * Result of the Part bbox resolution helper
 */
export interface BboxResolutionResult {
  /** bounding box を更新したパーツ数 / Number of parts with updated bounding boxes */
  resolvedCount: number;
  /** マッチできずスキップしたパーツ数 / Number of parts skipped (no match found) */
  skippedCount: number;
  /**
   * SSRF 再検証でブロックされた場合 `true`。
   * `true` のとき `resolvedCount` / `skippedCount` は 0 で返り、Phase 5 /
   * backfill 側は `skipReason=ssrf_blocked_on_backfill` を記録すべき。
   *
   * `true` when SSRF re-validation blocked the request. In that case
   * `resolvedCount` / `skippedCount` are both 0, and the caller should
   * record `skipReason=ssrf_blocked_on_backfill`.
   */
  ssrfBlocked: boolean;
  /**
   * PR-D-9 Wave 4 (C-06 / FIND-PLAN-SEC-02): observability fields propagated
   * from `resolvePartBoundingBoxes` BBOX_RESOLVE_RELOAD pass. All optional
   * (undefined when reload pass disabled / not entered).
   *
   * 観測性: BBOX_RESOLVE_RELOAD safety budget の per-page metrics 伝播。
   */
  reloadCount?: number;
  reloadTotalTimeMs?: number;
  reloadBudgetExhausted?: boolean;
}

/**
 * Part bbox を Playwright で解決する共通ヘルパー (v0.4.0 PR7e-α 本実装)。
 *
 * Unified helper that resolves Part bboxes via Playwright (PR7e-α body).
 *
 * ## 動作 / Behaviour
 *
 * 1. `validateUrl !== false` のとき `validateExternalUrl(params.url)` を実行。
 *    ブロックされたら `{ ssrfBlocked: true, resolvedCount: 0, skippedCount: 0 }`
 *    を返す (SEC HIGH-1)。
 *    When `validateUrl !== false`, re-runs `validateExternalUrl`. On block,
 *    returns the `ssrfBlocked` shape (SEC HIGH-1).
 *
 * 2. `partBboxLaunchSemaphore` (max=1) を取得してから既存 `resolvePartBoundingBoxes`
 *    を呼び出す (SEC HIGH-3)。
 *    Acquires `partBboxLaunchSemaphore` (max=1) before delegating to the
 *    existing `resolvePartBoundingBoxes` (SEC HIGH-3).
 *
 * 3. `resolvePartBoundingBoxes` 内部でも SSRF 検証が走るが、Backfill 経路では
 *    URL が DB から読み出されるため二重防御として本関数で先行検証する。
 *    `resolvePartBoundingBoxes` also re-validates SSRF internally; the extra
 *    pre-check here provides defence-in-depth for the DB-sourced URL in the
 *    backfill path.
 *
 * 4. `operator` が指定された場合 (repair script 経路) は `audit_logs` に記録。
 *    Phase 5 / Queue-based Backfill 経路では記録しない (過剰な書き込み回避)。
 *    When `operator` is provided (repair-script path) an `audit_logs` entry
 *    is written. Phase 5 / Queue-based Backfill paths skip to avoid write
 *    amplification.
 */
export async function resolvePartBoundingBoxesWithFallback(
  params: BboxResolutionParams
): Promise<BboxResolutionResult> {
  const { webPageId, url, prisma, sharedBrowser, validateUrl, operator } = params;

  // (1) SSRF 再検証 — `validateUrl === false` の場合のみスキップ。
  // SSRF re-validation — skip only when explicitly disabled.
  if (validateUrl !== false) {
    const validation = validateExternalUrl(url);
    if (!validation.valid) {
      logger.warn("[BboxResolutionHelper] URL blocked by SSRF validation (backfill path)", {
        error: validation.error,
        webPageId: webPageId.slice(0, 8) + "...",
        operator: operator ?? "(none)",
      });
      return { ssrfBlocked: true, resolvedCount: 0, skippedCount: 0 };
    }
  }

  // (2) Chromium launch を直列化する — Phase 5 child との競合回避。
  // Serialise Chromium launches to avoid contention with Phase 5 child.
  const release = await partBboxLaunchSemaphore.acquire();
  let result: BboxResolutionResult = { ssrfBlocked: false, resolvedCount: 0, skippedCount: 0 };
  try {
    // (3) 既存サービスへ delegate。
    // Delegate to existing service.
    const delegateArgs: Parameters<typeof resolvePartBoundingBoxes>[0] = {
      webPageId,
      url,
      prisma,
    };
    if (sharedBrowser !== null && sharedBrowser !== undefined) {
      delegateArgs.sharedBrowser = sharedBrowser as Browser;
    }
    if (params.viewportWidth !== undefined) {
      delegateArgs.viewportWidth = params.viewportWidth;
    }
    if (params.viewportHeight !== undefined) {
      delegateArgs.viewportHeight = params.viewportHeight;
    }
    const serviceResult = await resolvePartBoundingBoxes(delegateArgs);
    // PR-D-9 Wave 4 (C-06): only include reload* fields when set (avoid
    // exactOptionalPropertyTypes friction on undefined assignment).
    result = {
      ssrfBlocked: false,
      resolvedCount: serviceResult.resolvedCount,
      skippedCount: serviceResult.skippedCount,
      ...(serviceResult.reloadCount !== undefined
        ? { reloadCount: serviceResult.reloadCount }
        : {}),
      ...(serviceResult.reloadTotalTimeMs !== undefined
        ? { reloadTotalTimeMs: serviceResult.reloadTotalTimeMs }
        : {}),
      ...(serviceResult.reloadBudgetExhausted !== undefined
        ? { reloadBudgetExhausted: serviceResult.reloadBudgetExhausted }
        : {}),
    };
  } finally {
    release();
  }

  // (4) operator 指定時のみ audit_logs 記録 (LCC MEDIUM-2 / repair script).
  // Emit audit_logs only when `operator` is set (LCC MEDIUM-2 / repair path).
  if (operator) {
    try {
      await getAuditLogService().log({
        action: "part_bbox_resolved_via_repair",
        actor: `repair-script:${operator}`,
        targetType: "web_page",
        targetId: webPageId,
        details: {
          resolvedCount: result.resolvedCount,
          skippedCount: result.skippedCount,
        },
        result: "success",
      });
    } catch (auditError) {
      // Audit log failure must not fail the repair run.
      // 監査ログ失敗は主処理をブロックしない。
      logger.warn("[BboxResolutionHelper] audit_logs write failed (non-fatal)", {
        error: sanitizeErrorMessage(auditError),
        webPageId: webPageId.slice(0, 8) + "...",
      });
    }
  }

  return result;
}
