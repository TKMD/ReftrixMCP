// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Category Processors (v0.4.0 PR7a-2)
 *
 * Strategy Pattern でカテゴリ別のバックフィル処理を表現する。`EmbeddingBackfillWorker`
 * の巨大 switch 分岐（TDA H-2）を解消し、カテゴリ追加時の影響を Processor 実装
 * だけに閉じ込める。
 *
 * SSOT は `embedding-backfill-queue.ts` の `EMBEDDING_BACKFILL_CATEGORIES`。
 * 本モジュールは `Record<EmbeddingBackfillCategory, BackfillCategoryProcessor>`
 * としてコンパイル時の exhaustiveness を保証する。
 *
 * Strategy Pattern representing per-category backfill logic. Replaces the
 * monolithic switch in `EmbeddingBackfillWorker` (TDA H-2) so adding a category
 * only touches the new processor.
 *
 * SSOT lives in `embedding-backfill-queue.ts` (`EMBEDDING_BACKFILL_CATEGORIES`).
 * This module guarantees compile-time exhaustiveness via
 * `Record<EmbeddingBackfillCategory, BackfillCategoryProcessor>`.
 *
 * @module queues/embedding-backfill-processors
 */

import path from "node:path";
import type { Job, Queue } from "bullmq";
import { prisma as sharedPrismaClient } from "@reftrixmcp/database";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { truncateId } from "../utils/truncate-id";
import { getAuditLogService } from "../services/audit-log.service";
import { AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED } from "../audit/audit-actions";
import {
  backfillBackgroundsForPage,
  backfillJsAnimationsForPage,
  backfillMotionsForPage,
  backfillPartTextForPage,
  backfillResponsiveForPage,
  backfillSectionVisualsForPage,
  countMissingResponsiveEmbeddings,
  countPartVisualBackfillTargets,
  countSectionVisualBackfillTargets,
} from "../services/embedding-backfill.service";
import {
  runVisualEmbeddingSubPhases,
  type EmbeddingPhasePrismaClient,
} from "../workers/phases/phase-5-embedding";
import { resolvePartBoundingBoxesWithFallback } from "../workers/phases/shared/bbox-resolution.helper";
import { BACKFILL_PARTS_LIMIT_DEFAULT } from "../workers/phases/embedding-backfill-ipc";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  addEmbeddingBackfillJobWithGuard,
  type EmbeddingBackfillCategory,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "./embedding-backfill-queue";

// v0.4.0 PR7e-β4 PR2d (HIGH-α): re-used across all 7 category Processors via
// `runForkOrFallback`. See ADR-0015 Amendment 8.
// PR2d (HIGH-α): 7 全 Processor で `runForkOrFallback` 経由で再利用。

// =====================================================
// Progress sentinel values — aligned with embedding-backfill-worker
// =====================================================

const PROGRESS_AFTER_FETCH = 10;
const PROGRESS_AFTER_EMBEDDING = 90;

// =====================================================
// Types
// =====================================================

/**
 * Prisma client の最小サーフェス — countPartVisualBackfillTargets 等は
 * `prisma` シングルトン経由で呼び出すため、ここでは screenshot 参照用の最小限のみ定義。
 * Minimal Prisma surface — `countPartVisualBackfillTargets` uses the shared
 * singleton; here we only need the screenshot surface when required.
 */
export interface BackfillPrismaClientLike {
  webPage: {
    findUnique: (args: unknown) => Promise<{ screenshotStoragePath?: string | null } | null>;
  };
}

/**
 * Embedding service の最小サーフェス
 * Minimal embedding service surface
 */
export interface BackfillEmbeddingServiceLike {
  generateFromText: (text: string) => Promise<{ embedding: number[] }>;
  disposeEmbeddingPipeline: () => Promise<void>;
}

/**
 * Processor が受け取る context
 * Context passed to each processor
 */
export interface BackfillProcessContext {
  webPageId: string;
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  /**
   * Screenshot の絶対パス（Worker 側で allowlist 検証済み）
   * Absolute path to the validated screenshot (allowlist-checked by the Worker)
   */
  screenshotStoragePath?: string | undefined;
  /**
   * Prisma client（DINOv2 等で必要な場合のみ使用）
   * Prisma client (used only when the processor requires DB access beyond helpers)
   */
  prisma?: EmbeddingPhasePrismaClient | undefined;
}

/**
 * Processor の戻り値
 * Processor return shape
 */
export interface BackfillCategoryResult {
  /** 対象カテゴリ / target category */
  category: EmbeddingBackfillCategory;
  /** 生成成功件数 / generated count */
  generated: number;
  /** 生成失敗件数 / failed count */
  failed: number;
  /** メモリ圧迫でスキップした回数 / memory-skip count */
  memorySkips: number;
  /** バックフィル中に蓄積したエラー詳細 / accumulated error messages */
  errors: string[];
  /**
   * スキップ理由 (Graceful Degradation 時のみセット)。
   *   - `ssrf_blocked_on_backfill` — Backfill 経路の SSRF 再検証でブロック (SEC HIGH-1 + PR7e-α bug⑦)
   *   - `bbox_unresolvable` — PR-D-9 Wave 4 (C-02 + C-04 / ADR-0018 §Decision 1
   *     Supplement S3): Playwright-residual catch-all。1st-pass + opt-in reload
   *     pass 共に失敗した residual parts。`bbox_invalid` と mutually exclusive。
   *
   * Skip reason (set only for Graceful Degradation skips):
   *   - `ssrf_blocked_on_backfill` — SSRF re-validation blocked
   *   - `bbox_unresolvable` — PR-D-9 Wave 4: Playwright-residual catch-all
   *
   * @see ADR-0018 §Decision 1 Supplement S3 (decision boundary table)
   */
  skipReason?: "ssrf_blocked_on_backfill" | "bbox_unresolvable";
}

// =====================================================
// PR-D-9 Wave 4 (C-16 / FIND-PLAN-TDA-06): classifyBboxFailure helper
// =====================================================

/**
 * PR-D-9 Wave 4 (C-16 / FIND-PLAN-TDA-06): bbox failure 分類 helper。
 *
 * Plan §5.1.7 / §5.1.8: 4-way switch (`iframe` / `shadow_dom` / `dom_disposed`
 * / catch-all `bbox_unresolvable`) を private helper 関数に extract して、
 * `embedding-backfill-processors.ts` の cyclomatic complexity delta を
 * `≤ +2` に制限する。
 *
 * **PR-D-9 scope**: 1st-pass で classification 情報がまだ propagation されない
 * ため、本 helper は default branch (residual catch-all) のみを実装する。
 * `iframe` / `shadow_dom` / `dom_disposed` の細分化は future PR で `service` 層
 * から `BboxResolutionResult` に classification field を追加することを想定。
 * 現状 Phase 5 の bbox-resolution.helper は failure mode を保持しないため、
 * 4-way switch の structural shell を保持しつつ、3 case はすべて catch-all
 * (`bbox_unresolvable`) と同じ扱いにする (ADR-0018 §Decision 1 Supplement S3
 * `bbox_unresolvable` definition: "1st-pass resolution + optional reload pass
 * both fail" の包括的 catch-all)。
 *
 * Helper extracted to keep CC delta ≤ +2 per FIND-PLAN-TDA-06. Currently the
 * 4 cases all map to the residual `bbox_unresolvable` catch-all because the
 * service layer does not yet propagate per-failure classification (future PR
 * will subdivide).
 *
 * @see ADR-0018 §Decision 1 Supplement S3
 * @see Plan v1.1 §5.1.7 / §5.1.8 (helper extraction contract)
 */
type SkipReasonClassification = {
  skipReason: "bbox_unresolvable";
};

function classifyBboxFailure(reason: string): SkipReasonClassification {
  switch (reason) {
    case "iframe":
    case "shadow_dom":
    case "dom_disposed":
      // PR-D-9 scope: future PR will introduce iframe / shadow_dom /
      // dom_disposed-specific skipReason values; for now all classified
      // failures fold into the residual catch-all per ADR-0018 §Decision 1
      // Supplement S3 (`bbox_unresolvable` covers "1st-pass + reload both
      // fail").
      return { skipReason: "bbox_unresolvable" };
    default:
      return { skipReason: "bbox_unresolvable" };
  }
}

/**
 * Strategy Pattern: カテゴリ別の処理を表すインターフェース
 * Strategy Pattern interface for per-category processing
 */
export interface BackfillCategoryProcessor {
  /** 対象カテゴリ（`Record` キーと一致させる） / target category */
  readonly category: EmbeddingBackfillCategory;
  /**
   * Screenshot が必要か（`part_visual` / `section_visual` → true）
   * Whether a persisted screenshot is required (true for `part_visual` / `section_visual`)
   */
  requiresScreenshot(): boolean;
  /**
   * メイン処理 — 生成件数 / 失敗件数 / memorySkip を返す
   * Main processor — returns generated / failed / memorySkips
   */
  process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult>;
}

// =====================================================
// Progress helper — linear 10 → 90 interpolation
// =====================================================

function makeOnProgress(
  job: Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): (type: string, done: number, total: number) => void {
  return (_type, done, total) => {
    const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
    const pct =
      PROGRESS_AFTER_FETCH + Math.round(ratio * (PROGRESS_AFTER_EMBEDDING - PROGRESS_AFTER_FETCH));
    job.updateProgress(pct).catch(() => {
      /* fire-and-forget — progress reporting is best-effort */
    });
  };
}

// =====================================================
// Fork-or-Fallback shared helper — PR7e-β4 PR2d (HIGH-α)
// =====================================================

/**
 * Shared fork-or-fallback helper used by every category Processor.
 *
 * v0.4.0 PR7e-β4 PR2d (HIGH-α): PR2b-β で `JsAnimationProcessor.processViaFork`
 * (~70 LOC) として canary 限定で実装されていたロジックを 7 全 category で
 * 再利用するために抽出。`EMBEDDING_BACKFILL_FORK_ENABLED=true` のときのみ
 * fork orchestrator 経由で `child_process.fork()` を起動し、ONNX Runtime を
 * isolate する (ADR-0015)。各 Processor は本 helper を 1 行呼び出すだけで、
 * SEC-M-3 fail-open / TPA-H-1 observability 対称性 / TPA-M-2 fallback 再帰
 * セマンティクスを継承する。
 *
 * PR2d (HIGH-α): Extracted from `JsAnimationProcessor.processViaFork` (~70
 * LOC, PR2b-β canary-only) so all 7 categories reuse it. Each Processor calls
 * the helper in a single line and inherits SEC-M-3 fail-open, TPA-H-1
 * observability symmetry, and TPA-M-2 fallback recursion semantics.
 *
 * ## Saved invariants / 継承不変条件
 *
 * - **SEC-M-3 fail-open**: dynamic import / orchestrator 読み込み / fork 実行時
 *   失敗 → `inProcessFallback()` 呼び出しで Job 完走 (ADR-0015 §SEC-M-3)。
 * - **TPA-H-1 observability**: fork child の `backfill.done` IPC から
 *   failedCount / memorySkipCount / errors を取得し BackfillCategoryResult に
 *   伝搬する (in-process 経路と対称化)。
 * - **TPA-M-2 fallback recursion**: `inProcessFallback()` が再度 throw した
 *   場合は BullMQ Worker へ伝搬し、`attempts=3` retry + DLQ (ADR-0007) に委譲。
 * - **PII protection invariant (ADR-0015 Amendment 8 LCC-H-1)**: catch 経路の
 *   `sanitizeErrorMessage(error)` は CWE-209 PII 漏洩を防止。新 category
 *   Processor は本 helper 経由で自動的に同 invariant を継承する。
 */
async function runForkOrFallback(
  category: EmbeddingBackfillCategory,
  ctx: BackfillProcessContext,
  inProcessFallback: () => Promise<BackfillCategoryResult>,
  loggerLabel: string
): Promise<BackfillCategoryResult> {
  if (process.env["EMBEDDING_BACKFILL_FORK_ENABLED"] !== "true") {
    return inProcessFallback();
  }
  // Fix-2 (INFRA-EMBEDDING-MOTION-SIGABRT-001): dispose the parent Worker
  // Thread's ONNX session BEFORE fork() so the child does not inherit a
  // mid-inference native pthread state via copy-on-write. ONNX Runtime's
  // pthread COW inheritance is the same race that drives Fix-1; pre-fork
  // dispose is the parent-side complement that prevents SIGABRT during the
  // fork-orchestrator handoff.
  //
  // Best-effort: dispose failure must never block the fork (SEC-M-3 fail-open
  // semantics; the in-process fallback path remains the safety net).
  //
  // Observability (TPA-MOTION-02 M): emit `pre_fork_dispose_duration_ms` so
  // future regressions where dispose stalls (>500ms warn threshold) surface
  // in production logs. Future SLO: Loki rate query on the warn line.
  //
  // Cross-ref: IO §13.16.4 Plan Decision (Fix-2 mandated co-landing with
  //            Fix-1), ADR-0015 §SEC-M-3 fail-open.
  const preForkDisposeStart = Date.now();
  try {
    const { embeddingService: mlEmbeddingService } = await import("@reftrixmcp/ml");
    await mlEmbeddingService.dispose();
  } catch (error) {
    // Best-effort: do not block fork on dispose failure.
    logger.warn("[EmbeddingBackfill] pre-fork dispose failed (non-fatal)", {
      finding: "INFRA-EMBEDDING-MOTION-SIGABRT-001",
      error: sanitizeErrorMessage(error),
    });
  }
  const preForkDisposeDurationMs = Date.now() - preForkDisposeStart;
  if (preForkDisposeDurationMs > 500) {
    // Slow-dispose sentinel (TPA-MOTION-02): >500ms warn for future regression
    // detection. Threshold derived from typical ONNX session teardown < 200ms;
    // 500ms suggests a stuck session (potential dispose-time race).
    logger.warn("[EmbeddingBackfill] pre-fork dispose slow", {
      finding: "INFRA-EMBEDDING-MOTION-SIGABRT-001",
      pre_fork_dispose_duration_ms: preForkDisposeDurationMs,
      threshold_ms: 500,
    });
  }
  try {
    const { runEmbeddingBackfillFork, BACKFILL_EXTEND_LOCK_DURATION_MS } =
      await import("../workers/phases/embedding-backfill-fork-orchestrator.js");
    const jobToken = ctx.job.token;
    const forkResult = await runEmbeddingBackfillFork({
      jobId: String(ctx.job.id),
      webPageId: ctx.webPageId,
      category,
      // TPA-M-1 (PR2b-β audit): Single source of truth — see
      // `BACKFILL_PARTS_LIMIT_DEFAULT` in embedding-backfill-ipc.ts.
      // TPA-M-1 (PR2b-β 監査): ADR-0007 head-100 contract の single source。
      partsLimit: BACKFILL_PARTS_LIMIT_DEFAULT,
      onProgress: async (processed: number, total: number): Promise<void> => {
        await ctx.job.updateProgress({ processed, total });
      },
      // BullMQ `job.extendLock(token, duration)` requires the worker's lock
      // token. When `ctx.job.token` is undefined (e.g. Job manufactured outside
      // a Worker context) we skip relay; orchestrator heartbeat + SIGKILL
      // escalation handles the stuck case.
      //
      // BullMQ の `job.extendLock(token, duration)` は Worker 由来の token が
      // 必要。`ctx.job.token` 未定義時は relay を skip する。stall 対応は
      // orchestrator 側 heartbeat / SIGKILL に委譲。
      extendLock: async (): Promise<void> => {
        if (jobToken) {
          await ctx.job.extendLock(jobToken, BACKFILL_EXTEND_LOCK_DURATION_MS);
        }
      },
    });
    return {
      category,
      generated: forkResult.processedCount,
      failed: forkResult.failedCount ?? 0,
      memorySkips: forkResult.memorySkipCount ?? 0,
      errors: forkResult.errors ?? [],
    };
  } catch (error) {
    // SEC-M-3 + TPA-M-2: fall back to in-process so the Job completes; no
    // further automatic fallback (errors propagate to BullMQ retry / DLQ).
    // SEC-M-3 + TPA-M-2: in-process fallback で Job を完走させる。さらなる
    // 自動 fallback は無し (BullMQ retry / DLQ に委譲)。
    // Canary runbook は本 warn の発火頻度を監視し、非ゼロ継続時は
    // `EMBEDDING_BACKFILL_FORK_ENABLED` を即 rollback すること。
    logger.warn(`[${loggerLabel}] Fork path unavailable, falling back to in-process`, {
      error: sanitizeErrorMessage(error),
    });
    return inProcessFallback();
  }
}

// =====================================================
// Processors — per-category implementations
// =====================================================

class PartTextProcessor implements BackfillCategoryProcessor {
  readonly category = "part_text" as const;

  requiresScreenshot(): boolean {
    return false;
  }

  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "PartTextProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    const result = await backfillPartTextForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });
    return {
      category: this.category,
      generated: result.generated,
      failed: result.failed,
      memorySkips: result.memorySkips,
      errors: result.errors,
    };
  }
}

class PartVisualProcessor implements BackfillCategoryProcessor {
  readonly category = "part_visual" as const;

  requiresScreenshot(): boolean {
    return true;
  }

  /**
   * v0.4.0 PR7e-β4 PR2d (HIGH-β + LCC-M-2): fork-or-fallback dispatch.
   *
   * `EMBEDDING_BACKFILL_FORK_ENABLED=true` のときは `runForkOrFallback` 経由で
   * fork orchestrator を試行する。child 側 dispatch switch は `part_visual`
   * を意図的に throw する (DINOv2 + Playwright bbox flow を要するため、
   * service-layer wrapper `backfillPartVisualsForPage` 未実装、PR3b で対応予定)。
   * その結果 helper の catch 経路が `processInProcess` (既存ロジック) に
   * fallback し、Job は完走する。これにより future PR3b で service wrapper を
   * 実装した時点で fork 経路に乗り、本 Processor は再変更不要となる。
   *
   * PR2d (HIGH-β + LCC-M-2): When the flag is on, `runForkOrFallback` attempts
   * the fork path; the child dispatch deliberately throws for `part_visual`
   * (heavy DINOv2 + Playwright bbox flow not yet wrapped in the service layer
   * — tracked for PR3b). Helper catch routes to `processInProcess`, so the Job
   * still completes. PR3b's service-layer addition will then activate fork
   * automatically without further Processor changes.
   */
  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "PartVisualProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    // Screenshot 無しは Graceful Degradation（0 件成功扱い）
    // No screenshot → Graceful Degradation (treat as 0 processed)
    if (!ctx.screenshotStoragePath) {
      return this.emptyResult();
    }

    // v0.4.0 PR7e-α (バグ② fix): requiresBboxResolution が true の場合、
    // Part bbox を Playwright で再解決してから Visual Embedding を生成する。
    // 従来は Phase 5 と IPC race で bbox 未解決のまま放置されており、
    // part_visual embedding 生成 silent skip の原因だった。
    //
    // v0.4.0 PR7e-α (bug ② fix): when requiresBboxResolution is true,
    // re-resolve Part bboxes via Playwright before generating visual
    // embeddings. Previously the bboxes were left unresolved due to an IPC
    // race with Phase 5, causing part_visual embeddings to be silently skipped.
    if (ctx.job.data.requiresBboxResolution === true) {
      const bboxOutcome = await this.resolveAndPersistBboxes(ctx);
      if (bboxOutcome !== null) {
        return bboxOutcome; // ssrf_blocked_on_backfill 等の早期リターン
      }
    }

    const { pendingCount } = await countPartVisualBackfillTargets(ctx.webPageId);
    if (pendingCount === 0) {
      return this.emptyResult();
    }

    if (!ctx.prisma) {
      return {
        category: this.category,
        generated: 0,
        failed: pendingCount,
        memorySkips: 0,
        errors: [`part_visual: prisma client unavailable`],
      };
    }

    const dinov2ModelPath = resolveDinov2ModelPath();
    const subResult = await runVisualEmbeddingSubPhases({
      webPageId: ctx.webPageId,
      url: "",
      screenshotPngPath: ctx.screenshotStoragePath,
      sectionIdMapping: new Map<string, string>(),
      partsSavedCount: pendingCount,
      layoutResultJson: null,
      fallbackEnabled: false,
      dinov2ModelPath,
      prisma: ctx.prisma,
      onLockExtend: (_label: string) => {
        // Worker lockDuration が十分に長いので明示的な extendLock は不要
        // Lock duration is long enough — no explicit extension needed
      },
      onProgress: (completed: number, total: number) => {
        const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
        const pct =
          PROGRESS_AFTER_FETCH +
          Math.round(ratio * (PROGRESS_AFTER_EMBEDDING - PROGRESS_AFTER_FETCH));
        ctx.job.updateProgress(pct).catch(() => {
          /* fire-and-forget */
        });
      },
    });

    return {
      category: this.category,
      generated: subResult.partVisualEmbeddingsGenerated,
      failed: subResult.embeddingFailedChunks,
      memorySkips: 0,
      errors: [],
    };
  }

  /**
   * Part bbox を Playwright で後付け解決する。
   *   - URL は DB (`web_pages.url`) から取得し、`resolvePartBoundingBoxesWithFallback`
   *     で SSRF 再検証 + LaunchSemaphore + 既存サービス delegate を実行する。
   *   - SSRF ブロック時は `skipReason=ssrf_blocked_on_backfill` で早期 return。
   *   - URL 取得失敗や bbox 解決失敗は non-fatal — null を返して呼び出し側で
   *     通常の visual embedding パスに進む (Graceful Degradation)。
   *
   * Returns a final BackfillCategoryResult on early-exit (SSRF block), or
   * null to indicate the caller should proceed with the standard visual
   * embedding path.
   */
  private async resolveAndPersistBboxes(
    ctx: BackfillProcessContext
  ): Promise<BackfillCategoryResult | null> {
    // URL は DB から取得 (job.data に無いため)。失敗時は bbox 解決をスキップ。
    // Fetch URL from DB (not present on job.data). On failure, skip bbox
    // resolution and fall through to standard path.
    let pageUrl: string | null = null;
    try {
      const row = await sharedPrismaClient.webPage.findUnique({
        where: { id: ctx.webPageId },
        select: { url: true },
      });
      pageUrl = row?.url ?? null;
    } catch (dbError) {
      logger.warn("[PartVisualProcessor] Failed to fetch URL for bbox resolution", {
        error: sanitizeErrorMessage(dbError),
        webPageId: ctx.webPageId.slice(0, 8) + "...",
      });
      return null; // fall through to standard path
    }

    if (!pageUrl) {
      if (process.env["NODE_ENV"] !== "production") {
        logger.info("[PartVisualProcessor] No URL recorded; skipping bbox resolution", {
          webPageId: ctx.webPageId.slice(0, 8) + "...",
        });
      }
      return null;
    }

    try {
      const bboxResult = await resolvePartBoundingBoxesWithFallback({
        webPageId: ctx.webPageId,
        url: pageUrl,
        prisma: sharedPrismaClient,
        sharedBrowser: null,
        // validateUrl は default (再検証あり) — SEC HIGH-1 / PR7e-α
      });

      if (bboxResult.ssrfBlocked) {
        logger.warn("[PartVisualProcessor] SSRF re-validation blocked bbox resolution (backfill)", {
          webPageId: truncateId(ctx.webPageId, 8),
        });
        return {
          category: this.category,
          generated: 0,
          failed: 0,
          memorySkips: 0,
          errors: ["part_visual: SSRF re-validation blocked URL on backfill"],
          skipReason: "ssrf_blocked_on_backfill",
        };
      }

      logger.info("[PartVisualProcessor] Resolved Part bboxes on backfill", {
        webPageId: truncateId(ctx.webPageId, 8),
        resolvedCount: bboxResult.resolvedCount,
        skippedCount: bboxResult.skippedCount,
        reloadCount: bboxResult.reloadCount ?? 0,
        reloadTotalTimeMs: bboxResult.reloadTotalTimeMs ?? 0,
        reloadBudgetExhausted: bboxResult.reloadBudgetExhausted ?? false,
      });

      // PR-D-9 Wave 4 (C-04 + C-06 / ADR-0018 §Decision 1 Supplement S3 + S4):
      // emit `embedding_part_visual_skipped` audit_logs entry per residual
      // unresolved part. Triggered when:
      //   (a) reload budget was exhausted (`reloadBudgetExhausted=true`), OR
      //   (b) reload pass disabled but parts remain unresolved
      //       (`skippedCount > 0` after 1st-pass).
      //
      // GDPR Art.30 audit trail: action SSOT constant +
      // `details.skipReason='bbox_unresolvable'` per ADR-0018 §Decision 1
      // Supplement S4. PII: `targetId` is `truncateTargetId()`-truncated
      // automatically by `AuditLogService.log()`.
      if (bboxResult.skippedCount > 0) {
        const classification = classifyBboxFailure(
          bboxResult.reloadBudgetExhausted ? "dom_disposed" : "default"
        );
        try {
          await getAuditLogService().log({
            action: AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED,
            actor: "system:embedding-backfill-worker",
            targetType: "web_page",
            targetId: ctx.webPageId,
            details: {
              skipReason: classification.skipReason,
              skippedCount: bboxResult.skippedCount,
              resolvedCount: bboxResult.resolvedCount,
              reloadCount: bboxResult.reloadCount ?? 0,
              reloadTotalTimeMs: bboxResult.reloadTotalTimeMs ?? 0,
              reloadBudgetExhausted: bboxResult.reloadBudgetExhausted ?? false,
            },
            result: "failure",
          });
        } catch (auditError) {
          // Audit emit failure must NOT halt backfill. Logged only.
          logger.warn("[PartVisualProcessor] audit_logs emit failed (non-fatal)", {
            error: sanitizeErrorMessage(auditError),
            webPageId: truncateId(ctx.webPageId, 8),
          });
        }
      }
    } catch (resolveError) {
      // Non-fatal — proceed to standard visual embedding path with whatever
      // bboxes are already in the DB.
      logger.warn("[PartVisualProcessor] bbox resolution failed (non-fatal)", {
        error: sanitizeErrorMessage(resolveError),
        webPageId: ctx.webPageId.slice(0, 8) + "...",
      });
    }
    return null;
  }

  /** 空結果 (Graceful Degradation) — 共通化で complexity 削減 */
  private emptyResult(): BackfillCategoryResult {
    return {
      category: this.category,
      generated: 0,
      failed: 0,
      memorySkips: 0,
      errors: [],
    };
  }
}

class SectionVisualProcessor implements BackfillCategoryProcessor {
  readonly category = "section_visual" as const;

  requiresScreenshot(): boolean {
    // Section vision embedding は DINOv2 を使うため screenshot 必須（PR7b で
    // DINOv2 再生成パスを統合）。Worker は `web_pages.screenshotStoragePath`
    // から allowlist + realpath 検証済みパスを ctx に伝搬する。
    //
    // Section vision embeddings require DINOv2 → screenshot mandatory (PR7b
    // integrates the DINOv2 regeneration path). The Worker propagates the
    // allowlist + realpath-validated screenshot path via ctx.
    return true;
  }

  /**
   * v0.4.0 PR7e-β4 PR2d (HIGH-β): fork-or-fallback dispatch. fork 経路では
   * child 側 dispatch が `backfillSectionVisualsForPage` (text 部分) を実行
   * する。DINOv2 sub-path は本 Processor の `processInProcess` 内で in-process
   * fallback として継続実行される (PR3b で fork 経路に統合予定)。
   *
   * PR2d (HIGH-β): fork attempts `backfillSectionVisualsForPage` (text part).
   * The DINOv2 sub-path stays in-process via `processInProcess` until PR3b
   * unifies the visual path into the fork.
   */
  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "SectionVisualProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    // 1) Text-side recovery（既存パス）
    //    section_embeddings レコードそのものが存在しない section の text embedding
    //    を補完する。0 件の場合でも非エラー（後続の DINOv2 パスへ進む）。
    //
    // 1) Text-side recovery (existing path)
    //    Backfill text embeddings for sections that have no `section_embeddings`
    //    row at all. Returning 0 here is non-error — we still proceed to DINOv2.
    const textResult = await backfillSectionVisualsForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });

    // 2) Screenshot 無しは DINOv2 パスを Graceful Degradation でスキップ
    //    text 側の生成数のみ返す。
    //
    // 2) Skip the DINOv2 path with Graceful Degradation when no screenshot.
    //    Return only the text-side count.
    if (!ctx.screenshotStoragePath) {
      return {
        category: this.category,
        generated: textResult.generated,
        failed: textResult.failed,
        memorySkips: textResult.memorySkips,
        errors: textResult.errors,
      };
    }

    // 3) DINOv2 で vision_embedding を再生成する対象を集計
    //    text_embedding が既に存在し vision_embedding が NULL の section が対象。
    //    PII フィルタ（piiRiskLevel='high' を含む section の除外）は
    //    `runVisualEmbeddingSubPhases` 内で適用される。
    //
    // 3) Count DINOv2 regeneration candidates.
    //    Sections with text_embedding present and vision_embedding NULL.
    //    PII filter (excluding sections containing piiRiskLevel='high' parts)
    //    is applied inside `runVisualEmbeddingSubPhases`.
    const { pendingCount } = await countSectionVisualBackfillTargets(ctx.webPageId);
    if (pendingCount === 0) {
      return {
        category: this.category,
        generated: textResult.generated,
        failed: textResult.failed,
        memorySkips: textResult.memorySkips,
        errors: textResult.errors,
      };
    }

    if (!ctx.prisma) {
      return {
        category: this.category,
        generated: textResult.generated,
        failed: textResult.failed + pendingCount,
        memorySkips: textResult.memorySkips,
        errors: [...textResult.errors, "section_visual: prisma client unavailable"],
      };
    }

    // 4) DINOv2 で section vision embedding を再生成
    //    `runVisualEmbeddingSubPhases` は `sectionIdMapping.size > 0` をエントリ条件と
    //    し、内部で `vision_embedding IS NULL` の section を DB から再取得する。
    //    backfill 文脈ではセンチネルとして 1 件入りの Map を渡す（実際のキー値は使われない）。
    //    `partsSavedCount: 0` で Part visual パスはスキップする。
    //
    // 4) Regenerate section vision embeddings via DINOv2.
    //    `runVisualEmbeddingSubPhases` keys off `sectionIdMapping.size > 0` and
    //    re-fetches `vision_embedding IS NULL` sections internally. We pass a
    //    1-entry sentinel map (the key is unused). `partsSavedCount: 0` keeps
    //    the Part visual path inert.
    const dinov2ModelPath = resolveDinov2ModelPath();
    const sentinelMap = new Map<string, string>([
      ["__backfill_sentinel__", "__backfill_sentinel__"],
    ]);
    const subResult = await runVisualEmbeddingSubPhases({
      webPageId: ctx.webPageId,
      url: "",
      screenshotPngPath: ctx.screenshotStoragePath,
      sectionIdMapping: sentinelMap,
      partsSavedCount: 0,
      layoutResultJson: null,
      // backfill 経路では Section Screenshot Fallback（Playwright 個別キャプチャ）を
      // 起動しない。永続化済み fullPage screenshot のみを使う。
      // Disable Section Screenshot Fallback (Playwright per-section capture) in
      // the backfill path; rely on the persisted fullPage screenshot only.
      fallbackEnabled: false,
      dinov2ModelPath,
      prisma: ctx.prisma,
      onLockExtend: (_label: string) => {
        // Worker lockDuration が十分に長いので明示的な extendLock は不要
        // Lock duration is long enough — no explicit extension needed
      },
      onProgress: (completed: number, total: number) => {
        const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
        const pct =
          PROGRESS_AFTER_FETCH +
          Math.round(ratio * (PROGRESS_AFTER_EMBEDDING - PROGRESS_AFTER_FETCH));
        ctx.job.updateProgress(pct).catch(() => {
          /* fire-and-forget */
        });
      },
    });

    // 5) 集計: text 側 + DINOv2 側を合算。embeddingFailedChunks はチャンク単位の
    //    失敗回数なので「失敗 section 数」とは厳密一致しないが、観測性のため
    //    failed に加算する（PartVisualProcessor と同じ扱い）。
    //
    // 5) Aggregate: text-side + DINOv2-side. `embeddingFailedChunks` is a
    //    chunk-level failure count (not strict section count), but added to
    //    `failed` for observability — same convention as PartVisualProcessor.
    return {
      category: this.category,
      generated: textResult.generated + subResult.sectionVisualEmbeddingsGenerated,
      failed: textResult.failed + subResult.embeddingFailedChunks,
      memorySkips: textResult.memorySkips,
      errors: textResult.errors,
    };
  }
}

class MotionProcessor implements BackfillCategoryProcessor {
  readonly category = "motion" as const;

  requiresScreenshot(): boolean {
    return false;
  }

  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "MotionProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    const result = await backfillMotionsForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });
    return {
      category: this.category,
      generated: result.generated,
      failed: result.failed,
      memorySkips: result.memorySkips,
      errors: result.errors,
    };
  }
}

class BackgroundProcessor implements BackfillCategoryProcessor {
  readonly category = "background" as const;

  requiresScreenshot(): boolean {
    return false;
  }

  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "BackgroundProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    const result = await backfillBackgroundsForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });
    return {
      category: this.category,
      generated: result.generated,
      failed: result.failed,
      memorySkips: result.memorySkips,
      errors: result.errors,
    };
  }
}

class JsAnimationProcessor implements BackfillCategoryProcessor {
  readonly category = "js_animation" as const;

  requiresScreenshot(): boolean {
    return false;
  }

  /**
   * v0.4.0 PR7e-β4 PR2d (HIGH-α): fork-or-fallback dispatch via shared helper.
   *
   * PR2b-β で本 Processor 限定で実装されていた `processViaFork` (~70 LOC) は
   * `runForkOrFallback` ヘルパーに抽出され、6 他 Processor と共有される。
   * 本 Processor は helper 1 行呼び出しのみで SEC-M-3 fail-open / TPA-H-1
   * observability / TPA-M-2 fallback recursion を継承する。
   *
   * PR2d (HIGH-α): The `processViaFork` (~70 LOC) previously implemented in
   * this Processor is now extracted to `runForkOrFallback` and shared with
   * the other 6 Processors. This Processor inherits SEC-M-3 / TPA-H-1 / TPA-
   * M-2 invariants via a single helper call.
   */
  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "JsAnimationProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    const result = await backfillJsAnimationsForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });
    return {
      category: this.category,
      generated: result.generated,
      failed: result.failed,
      memorySkips: result.memorySkips,
      errors: result.errors,
    };
  }
}

class ResponsiveProcessor implements BackfillCategoryProcessor {
  readonly category = "responsive" as const;

  requiresScreenshot(): boolean {
    return false;
  }

  async process(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    return runForkOrFallback(
      this.category,
      ctx,
      () => this.processInProcess(ctx),
      "ResponsiveProcessor"
    );
  }

  private async processInProcess(ctx: BackfillProcessContext): Promise<BackfillCategoryResult> {
    // PR-D-9 Wave 3 (FIND-PLAN-LCC-02 / C-13 PII): diagnostic probe BEFORE the
    // backfill call to compute `expectedCount` (rows in `responsive_analyses`
    // missing `responsive_analysis_embeddings`). When `expectedCount > 0` but
    // `result.generated === 0`, emit a structured warn log so silent stalls
    // become observable. PII: `webPageId` is truncated via `truncateId(..., 8)`
    // per `.claude/rules/security.md` CWE-532 PII-in-log policy.
    //
    // PR-D-9 Wave 3 (FIND-PLAN-LCC-02 / C-13 PII): probe expectedCount before
    // the backfill so silent stalls (expected > 0 yet generated === 0) emit a
    // structured warn log. PII: `webPageId` truncated per CWE-532.
    let expectedCount = 0;
    try {
      expectedCount = await countMissingResponsiveEmbeddings(ctx.webPageId);
    } catch (probeError) {
      // Probe failure is non-fatal — proceed with backfill. The diagnostic log
      // simply omits the assertion check.
      logger.warn("[ResponsiveProcessor] expectedCount probe failed (non-fatal)", {
        error: sanitizeErrorMessage(probeError),
        webPageId: truncateId(ctx.webPageId, 8),
      });
    }

    const result = await backfillResponsiveForPage(ctx.webPageId, {
      onProgress: makeOnProgress(ctx.job),
    });

    // Diagnostic log: only when expectedCount > 0 but no rows were generated.
    // This is the silent-stall signature documented in PR-D-7 §32.2 (responsive
    // generatedCount:0 despite missing rows existing).
    if (expectedCount > 0 && result.generated === 0) {
      logger.warn("[ResponsiveProcessor] generatedCount mismatch (expected > 0, generated 0)", {
        webPageId: truncateId(ctx.webPageId, 8),
        expectedCount,
        generatedCount: result.generated,
        failedCount: result.failed,
        memorySkips: result.memorySkips,
      });
    }

    return {
      category: this.category,
      generated: result.generated,
      failed: result.failed,
      memorySkips: result.memorySkips,
      errors: result.errors,
    };
  }
}

// =====================================================
// Helpers
// =====================================================

/**
 * DINOv2 モデルパスを解決する（`phase-5-embedding.ts` の dispatchEmbeddingPhase と
 * `embedding-backfill-worker.ts` の resolveDinov2ModelPath と同一ロジック）。
 * Resolve the DINOv2 model path (mirrors the helpers in `phase-5-embedding.ts`
 * dispatchEmbeddingPhase and `embedding-backfill-worker.ts`).
 */
function resolveDinov2ModelPath(): string {
  if (process.env["DINOV2_MODEL_PATH"]) {
    return process.env["DINOV2_MODEL_PATH"];
  }
  const mlMainPath = require.resolve("@reftrixmcp/ml");
  const mlRoot = path.resolve(path.dirname(mlMainPath), "..");
  return path.join(mlRoot, "models", "dinov2-base", "model.onnx");
}

// =====================================================
// SSOT Registry — `Record` guarantees compile-time exhaustiveness
// =====================================================

/**
 * Processor レジストリ — `Record<EmbeddingBackfillCategory, ...>` で全カテゴリの
 * Processor 実装を強制する。SSOT の配列にカテゴリを追加すると本 Record も
 * コンパイルエラーになるため、Processor の追加忘れを防ぐ。
 *
 * Processor registry — `Record<EmbeddingBackfillCategory, ...>` makes the compiler
 * enforce that every category has an implementation. Adding a new category to
 * the SSOT array causes a compile error here if the processor is missing.
 */
export const PROCESSORS: Record<EmbeddingBackfillCategory, BackfillCategoryProcessor> = {
  part_text: new PartTextProcessor(),
  part_visual: new PartVisualProcessor(),
  section_visual: new SectionVisualProcessor(),
  motion: new MotionProcessor(),
  background: new BackgroundProcessor(),
  js_animation: new JsAnimationProcessor(),
  responsive: new ResponsiveProcessor(),
};

/**
 * カテゴリから Processor を取得する type-safe ヘルパー
 * Type-safe helper for fetching a processor by category
 */
export function getBackfillProcessor(
  category: EmbeddingBackfillCategory
): BackfillCategoryProcessor {
  return PROCESSORS[category];
}

// =====================================================
// Skip Recovery Helper (PR7b-convergence TDA H-1 / H-2 / M-2)
// =====================================================

/**
 * Skip recovery 経路で全 7 カテゴリを一括 enqueue するヘルパー
 * （PR7b-convergence TDA H-1 / H-2 / M-2）。
 *
 * 元々 Worker (`page-analyze-worker.ts` の `dispatchSkipRecoveryBackfill`) と
 * Cron (`backfill-reconciliation.service.ts` の `reconcileSkippedRows`) に
 * 30 行 × 2 で重複していた enqueue ループを SSOT 化する。
 * 複雑度 14 → 10 以下への収束にも寄与する。
 *
 * 挙動 / Behaviour:
 *   - `screenshot` が必須のカテゴリ (`part_visual` / `section_visual`) は
 *     `screenshotStoragePath` が undefined の場合スキップ（Graceful Degradation）
 *   - 各 enqueue 失敗は warn log のみで continue（一部失敗しても他カテゴリは enqueue 続行）
 *   - 成功カテゴリと失敗カテゴリを分離して返す
 *
 * Bulk-enqueues all 7 categories for the skip-recovery path. Replaces the
 * duplicated enqueue loops (~30 lines × 2) in the Worker
 * (`page-analyze-worker.ts` `dispatchSkipRecoveryBackfill`) and the Cron
 * (`backfill-reconciliation.service.ts` `reconcileSkippedRows`) with a shared
 * SSOT. Also drives the host functions' complexity from 14 to ≤10.
 *
 * Behaviour:
 *   - Screenshot-required categories (`part_visual` / `section_visual`) are
 *     skipped when `screenshotStoragePath` is undefined (Graceful Degradation)
 *   - Each enqueue failure only emits a warn log and continues (partial
 *     failure does not halt the remaining categories)
 *   - Returns enqueued and failed categories separately
 *
 * @param queue - BullMQ Queue
 * @param params - Enqueue 条件
 * @returns enqueued / failed カテゴリ一覧
 */
export async function enqueueAllCategoriesForSkipRecovery(
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>,
  params: {
    /** 対象ページ ID / Target page ID */
    webPageId: string;
    /** 永続化済み screenshot パス（screenshot 必須カテゴリで使用） / Persisted screenshot path */
    screenshotStoragePath?: string | undefined;
    /** `skipped_memory_pressure` 経路の初期 delay (ms)。`skipped_fork_error` は 0。 */
    initialDelayMs: number;
    /** 呼び出し元（ログ用） / Caller for logging */
    source: "worker" | "cron";
  }
): Promise<{
  enqueued: EmbeddingBackfillCategory[];
  failed: EmbeddingBackfillCategory[];
}> {
  const { webPageId, screenshotStoragePath, initialDelayMs, source } = params;
  const enqueued: EmbeddingBackfillCategory[] = [];
  const failed: EmbeddingBackfillCategory[] = [];

  for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
    const processor = getBackfillProcessor(category);

    // screenshot 必須カテゴリで screenshot 無し → スキップ（Graceful Degradation）
    // Screenshot-required category without screenshot → skip (Graceful Degradation)
    if (processor.requiresScreenshot() && !screenshotStoragePath) {
      continue;
    }

    const jobData: Omit<EmbeddingBackfillJobData, "createdAt"> = {
      webPageId,
      category,
      ...(processor.requiresScreenshot() && screenshotStoragePath
        ? {
            screenshotStoragePath,
            requiresBboxResolution: category === "part_visual",
          }
        : {}),
    };

    const opts: { priority: number; delay?: number } = { priority: 10 };
    if (initialDelayMs > 0) {
      opts.delay = initialDelayMs;
    }

    try {
      // PR-D-6 Phase 2: migrate legacy `addEmbeddingBackfillJob` → with-guard SSOT
      // PR-D-6 Phase 2: legacy API → with-guard. outcome is observed for
      // skip-recovery telemetry; successful variants (enqueued_* / reused_*)
      // all count as "category successfully enqueued".
      const result = await addEmbeddingBackfillJobWithGuard(queue, jobData, opts);
      enqueued.push(category);
      if (result.outcome !== "enqueued_new") {
        logger.info(`[EmbeddingBackfillProcessors] Skip-recovery enqueue outcome (${source})`, {
          outcome: result.outcome,
          collision: result.collision,
          webPageId: webPageId.slice(0, 8) + "...",
          category,
          source,
        });
      }
    } catch (enqueueError) {
      failed.push(category);
      logger.warn(
        `[EmbeddingBackfillProcessors] Failed to enqueue skip-recovery category (${source}, non-fatal)`,
        {
          error: sanitizeErrorMessage(enqueueError),
          webPageId: webPageId.slice(0, 8) + "...",
          category,
          source,
        }
      );
    }
  }

  return { enqueued, failed };
}

// =====================================================
// Test-only exports
// =====================================================

// テスト用にクラスを export（本番コードからは `PROCESSORS` のみ使用する想定）
// Classes exported for tests only — production code should go through `PROCESSORS`.
export {
  PartTextProcessor,
  PartVisualProcessor,
  SectionVisualProcessor,
  MotionProcessor,
  BackgroundProcessor,
  JsAnimationProcessor,
  ResponsiveProcessor,
};
