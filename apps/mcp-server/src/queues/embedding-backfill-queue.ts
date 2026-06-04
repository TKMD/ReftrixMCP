// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Queue — BullMQ Queue for Async Part Embedding Backfill
 *
 * v0.4.0 PR4: page.analyze の Phase 5 (Embedding) で Part text / visual
 * embedding の対象が 100 件を超えた場合、最初の 100 件のみ同期処理し、
 * 残余を本 Queue に投入して非同期ワーカーでバックフィルする。
 *
 * v0.4.0 PR4: When Phase 5 (Embedding) of `page.analyze` has more than 100
 * Part text / visual embedding candidates per page, only the first 100 are
 * processed synchronously; the remainder are enqueued here and backfilled
 * asynchronously by a dedicated worker.
 *
 * 設計判断 / Design decisions:
 * - attempts=3 + exponential backoff: 一時的な OOM / VRAM 逼迫からの回復を狙う
 *   (attempts=3 with exponential backoff: recovers from transient OOM / VRAM pressure)
 * - jobId=<webPageId>__<category>: 同一ページ × 同一カテゴリの重複投入を防止
 *   (jobId uniqueness prevents duplicate enqueue for the same page × category)
 * - 24h/7d 保持ポリシー: page-analyze-queue と揃える
 *   (24h completed / 7d failed retention aligned with page-analyze-queue)
 *
 * @module queues/embedding-backfill-queue
 */

import { Queue, QueueEvents, type Job, type ConnectionOptions } from "bullmq";
import { z } from "zod";
import { getRedisConfig, type RedisConfig } from "../config/redis";
import { getAuditLogService } from "../services/audit-log.service";
import { logger } from "../utils/logger";
import { sanitizeAnalysisErrorForClient, sanitizeErrorMessage } from "../utils/sanitize-error";
import { truncateId } from "../utils/truncate-id";
import { enqueueWithCollisionGuard, type EnqueueResult } from "./enqueue-with-collision-guard";

/**
 * Queue name constant
 */
export const EMBEDDING_BACKFILL_QUEUE_NAME = "embedding-backfill";

/**
 * Back-pressure 上限：waiting 件数がこの値を超えると新規 enqueue を拒否する
 * （SEC HIGH-2 / ADR-0008 PR7b）。
 *
 * Back-pressure cap: reject new enqueue when waiting count exceeds this value
 * (SEC HIGH-2 / ADR-0008 PR7b).
 *
 * 10,000 件の根拠 / Rationale for 10,000:
 *   - 1 件平均 5 秒（`EMBEDDING_BACKFILL_AVG_MS_PER_ITEM` デフォルト）× 10,000 件
 *     = 約 14 時間分の処理キュー。これ以上は OOM / Redis メモリ圧迫リスクが顕著。
 *   - At 5s/item average × 10,000 = ~14 hours of work — beyond this, OOM and
 *     Redis memory pressure become significant risks.
 */
export const EMBEDDING_BACKFILL_QUEUE_WAITING_CAP = 10_000;

/**
 * 再試行上限（ADR-0008 #8 / SEC HIGH-1 / PR7b-convergence TDA M-1）。
 * `embeddingBackfillRetryCount` がこの値を超えたページは `failed` に固定し、
 * audit log に記録した上で再投入を停止する。BullMQ 内部の `attempts=3` とは独立
 * （各 attempt 内の transient OOM 復旧は BullMQ retry に委ねる）。
 *
 * 本定数は Worker (`page-analyze-worker.ts`) と Cron (`backfill-reconciliation.service.ts`) の
 * **両方から import** される SSOT。Zod schema (`output.schemas.ts`
 * `backfillPendingSkipRecoverySchema.retryCount.max`) もこの値を参照する。
 *
 * Retry cap (ADR-0008 #8 / SEC HIGH-1 / PR7b-convergence TDA M-1). Pages whose
 * `embeddingBackfillRetryCount` exceeds this value are pinned to `failed`,
 * audit-logged, and never re-enqueued. Independent from BullMQ's internal
 * `attempts=3` (which handles transient OOM within a single attempt).
 *
 * This constant is the SSOT imported from **both** the Worker
 * (`page-analyze-worker.ts`) and the Cron
 * (`backfill-reconciliation.service.ts`). The Zod schema (`output.schemas.ts`
 * `backfillPendingSkipRecoverySchema.retryCount.max`) also references this value.
 */
export const SKIP_RECOVERY_RETRY_CAP = 5;

/**
 * Memory-pressure 経路の初期 delay (ms)。skip recovery で
 * `skipped_memory_pressure` から再投入する際、メモリ回収を待つ猶予として
 * `delay` プロパティに設定する。BullMQ 自身の exponential backoff (#3) は
 * `attempts` 失敗時の再試行間隔として別途適用される。
 *
 * Initial delay (ms) for the memory-pressure recovery path. Applied to the
 * BullMQ `delay` option when re-enqueueing from `skipped_memory_pressure` to
 * give the OS time to reclaim memory. BullMQ's own exponential backoff (#3)
 * is applied separately on `attempts` failure.
 *
 * 環境変数 `EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS` で 1000 〜 600000ms
 * の範囲で上書き可能。デフォルト 60000ms（60 秒）は ADR-0007 の旧 60s 固定値と
 * 互換性を保つために選択（後方互換）。
 *
 * Configurable via `EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS` (clamped to
 * 1000–600000ms). Default 60000ms (60s) preserves backward compatibility with
 * the fixed-60s value from ADR-0007.
 */
const MEMORY_PRESSURE_DELAY_MIN_MS = 1_000;
const MEMORY_PRESSURE_DELAY_MAX_MS = 600_000;
const MEMORY_PRESSURE_DELAY_DEFAULT_MS = 60_000;

const MemoryPressureDelaySchema = z
  .number()
  .int()
  .min(MEMORY_PRESSURE_DELAY_MIN_MS)
  .max(MEMORY_PRESSURE_DELAY_MAX_MS)
  .default(MEMORY_PRESSURE_DELAY_DEFAULT_MS);

/**
 * Resolve the memory-pressure delay (ms) from the environment variable, with
 * Zod validation and a safe fallback.
 *
 * 環境変数からメモリ圧迫経路の delay (ms) を解決する。Zod 検証で範囲外 / NaN /
 * Infinity は拒否し、デフォルト値にフォールバックする。
 *
 * PR7b-convergence (SEC MEDIUM-1): Thundering Herd 対策として ±20% の full jitter
 * を付与する。複数ページが同時刻に memory_pressure から re-enqueue された場合に
 * BullMQ 内部スケジューラを同期的に発火させず、VRAM 圧迫の復旧に余裕を持たせる。
 *
 * PR7b-convergence (SEC MEDIUM-1): Applies ±20% full jitter as Thundering Herd
 * defense. When multiple pages re-enqueue from memory_pressure simultaneously,
 * this prevents BullMQ's internal scheduler from firing synchronously, giving
 * the VRAM recovery more headroom.
 */
export function resolveMemoryPressureDelayMs(): number {
  const raw = process.env["EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS"];
  const baseDelay = ((): number => {
    if (raw === undefined || raw === "") {
      return MEMORY_PRESSURE_DELAY_DEFAULT_MS;
    }
    const parsed = Number(raw);
    const result = MemoryPressureDelaySchema.safeParse(parsed);
    if (!result.success) {
      logger.warn(
        "[EmbeddingBackfillQueue] invalid EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS — falling back to default",
        {
          raw,
          parsed,
          default: MEMORY_PRESSURE_DELAY_DEFAULT_MS,
        }
      );
      return MEMORY_PRESSURE_DELAY_DEFAULT_MS;
    }
    return result.data;
  })();

  // ±20% full jitter: base * (0.8 + random * 0.4)
  // Math.random() は暗号学的強度を要求しない文脈（DoS 分散）のため使用可
  // Math.random() is acceptable here (DoS dispersion, not cryptographic)
  const jitterFactor = 0.8 + Math.random() * 0.4;
  const jittered = Math.floor(baseDelay * jitterFactor);

  // Clamp within MEMORY_PRESSURE_DELAY_MIN_MS..MEMORY_PRESSURE_DELAY_MAX_MS to
  // guarantee the schema invariant holds after jitter application.
  if (jittered < MEMORY_PRESSURE_DELAY_MIN_MS) return MEMORY_PRESSURE_DELAY_MIN_MS;
  if (jittered > MEMORY_PRESSURE_DELAY_MAX_MS) return MEMORY_PRESSURE_DELAY_MAX_MS;
  return jittered;
}

/**
 * Backfill 対象カテゴリ SSOT（Single Source of Truth, v0.4.0 PR7a-2）
 * Backfill target categories — Single Source of Truth (v0.4.0 PR7a-2)
 *
 * v0.4.0 PR7a-2 で 7 カテゴリに拡張。v0.4.0 PR4 時点では runtime に enqueue
 * されるのは `part_text` / `part_visual` の 2 種のみだが、PR7b の Skip recovery
 * enqueue パス実装時に残り 5 種（`section_visual` / `motion` / `background` /
 * `js_animation` / `responsive`）も runtime 利用される。
 *
 * 本配列は Zod enum（`EmbeddingBackfillJobDataSchema.category`）、TypeScript 型
 * （`EmbeddingBackfillCategory`）、Strategy Pattern（`embedding-backfill-processors.ts`
 * の `PROCESSORS` Record）すべての根源となる。**カテゴリの追加/削除は本配列のみで行う**。
 * 重複定義は型レベルで禁止される。
 *
 * Expanded to 7 categories in v0.4.0 PR7a-2. Only `part_text` / `part_visual` are
 * actually enqueued at runtime as of v0.4.0 PR4; the remaining 5 (`section_visual` /
 * `motion` / `background` / `js_animation` / `responsive`) become runtime-active
 * when the Skip recovery enqueue path is implemented in PR7b.
 *
 * This array is the SSOT for the Zod enum (`EmbeddingBackfillJobDataSchema.category`),
 * the TypeScript union (`EmbeddingBackfillCategory`), and the Strategy Pattern
 * `PROCESSORS` Record in `embedding-backfill-processors.ts`. **Add/remove categories
 * here only**. Duplicate definitions are forbidden at the type level.
 */
export const EMBEDDING_BACKFILL_CATEGORIES = [
  "part_text",
  "part_visual",
  "section_visual",
  "motion",
  "background",
  "js_animation",
  "responsive",
] as const;

/**
 * Backfill 対象カテゴリ型（const assertion から派生）
 * Backfill category type (derived from the const assertion array)
 */
export type EmbeddingBackfillCategory = (typeof EMBEDDING_BACKFILL_CATEGORIES)[number];

/**
 * Embedding backfill 失敗理由 SSOT (Single Source of Truth)
 *
 * Plan v3 T3-Backfill V1 §3.1 + ADR-0030 で定義された
 * `failed_with_known_reason` ステータス用の失敗理由列挙。
 * `BackfillRecoveryReconciliationService` が auto_recoverable /
 * terminal_unrecoverable / legacy_existing_path のいずれかに classify する
 * (`classifyFailureReasonPolicy`)。
 *
 * 新理由の追加時:
 *   1. この const tuple に push (alphabetic order 推奨)
 *   2. `classifyFailureReasonPolicy` switch を update (exhaustiveness check 強制)
 *   3. ADR-0030 ↔ Plan v3 T3-Backfill cross-ref を update
 *
 * Embedding backfill failure reason SSOT enum (Wave 2 T3-Backfill).
 * Consumed by `BackfillRecoveryReconciliationService` +
 * `embedding-backfill-failure-reason-helpers` for classification and audit
 * emit. Adding a new reason requires updating
 * `classifyFailureReasonPolicy` switch (TS exhaustiveness check enforces).
 *
 * Exported as `EMBEDDING_BACKFILL_FAILURE_REASONS` (FIND-WAVE4-TDA-V2-H-01
 * export contract).
 */
export const EMBEDDING_BACKFILL_FAILURE_REASONS = [
  // Auto-recoverable bucket (T3-Backfill axis A/B/C — recovery service drives)
  "vision_residual",
  "vision_unload_timeout",
  "memory_pressure",
  "stall_timeout",
  "lock_lost",
  "supervisor_restart_orphan",
  "dual_run_race",
  // Terminal unrecoverable bucket (SEC contract — never retry)
  "ssrf_blocked",
  // Legacy existing path bucket (covered by existing skipped_* retry)
  "parity_check_failed",
  "bbox_unresolvable",
  "screenshot_missing",
  "fork_error",
] as const;

/**
 * Embedding backfill 失敗理由型（const assertion から派生）
 * Embedding backfill failure reason type (derived from the const assertion).
 *
 * Exported as `EmbeddingBackfillFailureReason` (FIND-WAVE4-TDA-V2-H-01 export
 * contract).
 */
export type EmbeddingBackfillFailureReason = (typeof EMBEDDING_BACKFILL_FAILURE_REASONS)[number];

/**
 * screenshotStoragePath の最大長（byte ではなく UTF-16 code unit 数）
 * Max length of screenshotStoragePath (UTF-16 code units, not bytes)
 *
 * SEC M-1 (v0.4.0 PR4 audit): 長大文字列による DoS 防御。
 * SEC M-1 (v0.4.0 PR4 audit): DoS defense against oversized strings.
 */
const SCREENSHOT_PATH_MAX_LENGTH = 512;

/**
 * requestId の最大長
 * Max length of requestId
 */
const REQUEST_ID_MAX_LENGTH = 128;

/**
 * Embedding backfill ジョブデータの Zod スキーマ（SEC M-1 / v0.4.0 PR4 audit）。
 *
 * BullMQ Redis 越しに受信するジョブデータは外部入力同等として扱い、キュー投入時
 * およびワーカー受信時の 2 か所で parse する（defense in depth）。不正 UUID /
 * 改行・コロン混入による jobId 衝突、長大文字列による DoS を防御する。
 *
 * Zod schema for embedding backfill job data (SEC M-1 / v0.4.0 PR4 audit).
 *
 * Job data received via BullMQ Redis is treated as external input and parsed
 * at both enqueue time and worker receipt time (defense in depth). Defends
 * against jobId collision via invalid UUID / newline / colon injection and
 * DoS via oversized strings.
 */
export const EmbeddingBackfillJobDataSchema = z.object({
  webPageId: z.string().uuid(),
  // z.enum は const assertion された string tuple を要求する。SSOT と一致した列挙を
  // コンパイル時に保証する。
  // z.enum requires a `readonly [string, ...string[]]` tuple. Sharing the SSOT array
  // enforces exhaustive enum compliance at compile time.
  category: z.enum(EMBEDDING_BACKFILL_CATEGORIES),
  screenshotStoragePath: z.string().max(SCREENSHOT_PATH_MAX_LENGTH).optional(),
  requiresBboxResolution: z.boolean().optional(),
  createdAt: z.string().datetime({ offset: true }),
  requestId: z.string().max(REQUEST_ID_MAX_LENGTH).optional(),
});

/**
 * Job data for embedding backfill / バックフィルジョブデータ
 */
export interface EmbeddingBackfillJobData {
  /** WebPage ID (UUID v4/v7) */
  webPageId: string;
  /** Backfill 対象カテゴリ / Backfill target category */
  category: EmbeddingBackfillCategory;
  /**
   * PR1 で永続化された screenshot の絶対パス（`part_visual` で必須）
   * Absolute path of the screenshot persisted by PR1 (required for `part_visual`)
   *
   * `part_text` の場合は未指定で可（テキスト処理には不要）。
   * May be omitted for `part_text` (unused for text processing).
   */
  screenshotStoragePath?: string | undefined;
  /**
   * Part bbox 解決が必要かを示すヒント（`part_visual` で true）
   * Hint whether Part bounding box resolution is required (true for `part_visual`)
   *
   * Playwright による bbox 再取得を実施するかをワーカー側の判断材料とする。
   * The worker uses this hint to decide whether Playwright bbox resolution is required.
   */
  requiresBboxResolution?: boolean | undefined;
  /** Job creation timestamp (ISO 8601) */
  createdAt: string;
  /** Optional request ID for tracing */
  requestId?: string | undefined;
}

/**
 * Job result for embedding backfill / バックフィルジョブ結果
 */
export interface EmbeddingBackfillJobResult {
  /** WebPage ID */
  webPageId: string;
  /** Backfill category */
  category: EmbeddingBackfillCategory;
  /** Successfully generated embedding count / 生成成功件数 */
  generatedCount: number;
  /** Failed embedding count / 生成失敗件数 */
  failedCount: number;
  /** Processing duration (ms) */
  processingTimeMs: number;
  /** Completion timestamp (ISO 8601) */
  completedAt: string;
  /** Error message if failed / 失敗時のエラーメッセージ */
  error?: string | undefined;
  /**
   * Graceful Degradation スキップ理由 (v0.4.0 PR7e-α / bug⑦ observability)。
   *
   * Values:
   *   - `ssrf_blocked_on_backfill` — PR7e-α (SSRF guard skipped Backfill)
   *   - `parity_check_failed` — PR-D-4 (INV-EMBEDDING-INTEGRITY-003 parity
   *     gate failed; DB row routed to `skipped_fork_error` retry bucket while
   *     BullMQ job completes successfully)
   *   - `bbox_unresolvable` — PR-D-9 Wave 4 (C-02 + C-04 / ADR-0018 §Decision 1
   *     Supplement S3): Playwright-residual catch-all from `PartVisualProcessor`
   *     when 1st-pass + opt-in `BBOX_RESOLVE_RELOAD` reload pass both fail to
   *     resolve a part bbox. Mutually exclusive with `bbox_invalid` (JSDOM-origin
   *     catch-all, surfaced via `EmbeddingPhaseResult.skipReason` not Backfill).
   *
   * Graceful Degradation skip reason (v0.4.0 PR7e-α / bug ⑦ observability).
   *
   * Values:
   *   - `ssrf_blocked_on_backfill` — SSRF guard skipped Backfill (PR7e-α)
   *   - `parity_check_failed` — INV-EMBEDDING-INTEGRITY-003 parity gate
   *     failed; DB row routed to retry bucket (`skipped_fork_error`) while
   *     the BullMQ job completes successfully (PR-D-4)
   *   - `bbox_unresolvable` — PR-D-9 Wave 4: Playwright-residual catch-all
   *     (1st-pass + reload pass both fail). See ADR-0018 §Decision 1 Supplement S3.
   */
  skipReason?: "ssrf_blocked_on_backfill" | "parity_check_failed" | "bbox_unresolvable" | undefined;
}

/**
 * Job status for polling / ポーリング用ステータス
 */
export interface EmbeddingBackfillJobStatus {
  jobId: string;
  state: "waiting" | "active" | "completed" | "failed" | "delayed" | "unknown";
  progress: number;
  result?: EmbeddingBackfillJobResult | undefined;
  error?: string | undefined;
  timestamps: {
    created?: number;
    started?: number;
    completed?: number;
    failed?: number;
  };
}

/**
 * Convert RedisConfig to BullMQ ConnectionOptions for Queue / QueueEvents.
 *
 * BullMQ requires `maxRetriesPerRequest: null` for Queue / QueueEvents /
 * Worker connections (per https://docs.bullmq.io/guide/connections and
 * taskforcesh/bullmq#2466). We override unconditionally to null here so that
 * a misconfigured `REDIS_MAX_RETRIES_PER_REQUEST` env var cannot silently
 * break delayed-job pickup for the backfill queue.
 *
 * BullMQ は Queue/QueueEvents/Worker 接続で `maxRetriesPerRequest: null` を公式必須
 * とする。env var が誤設定されても delayed job pickup が停止しないよう、ここでは
 * 無条件に null を強制する。
 */
function toConnectionOptions(config: RedisConfig): ConnectionOptions {
  return {
    host: config.host,
    port: config.port,
    maxRetriesPerRequest: null,
  };
}

/**
 * Build the canonical job id for an embedding backfill job.
 * webPageId と category を組み合わせて重複投入を防止する。
 * Combines webPageId and category to prevent duplicate enqueue.
 *
 * **Why `__` (double underscore) and not `:`**:
 * BullMQ 5.x rejects custom job IDs containing `:` with
 * `Custom Id cannot contain :` (used internally for Redis key separators).
 * `__` is safe (UUIDv7 + enum values never contain it) and round-trip parseable.
 */
export const BACKFILL_JOB_ID_SEPARATOR = "__";

export function buildBackfillJobId(webPageId: string, category: EmbeddingBackfillCategory): string {
  return `${webPageId}${BACKFILL_JOB_ID_SEPARATOR}${category}`;
}

/**
 * Full canonical jobId regex for embedding-backfill BullMQ jobs.
 *
 * Form: `<UUID v4/v7>__<category>` per `buildBackfillJobId(webPageId, category)` SSOT factory.
 *   - UUID portion: RFC 4122 hyphen positions enforced (8-4-4-4-12 layout)
 *   - Separator: `__` (per `BACKFILL_JOB_ID_SEPARATOR`)
 *   - Category portion: dynamic union of `EMBEDDING_BACKFILL_CATEGORIES` SSOT array
 *     to prevent SSOT drift when new categories are added
 *
 * @see PR-D-9-patch Plan v1.2 §4.2 (Option B regex union with SSOT export)
 * @see PR-D-9-patch Plan v1.2 §3.2 trade-off matrix (Option B selected)
 * @see PR-D-9-patch ADR-0011 Amendment 3 §A.2 (Phase 3 docs-sync deliverable)
 *
 * Used by:
 *   - `apps/mcp-server/src/schemas/worker-ipc.schema.ts:57` (Wave 3 schema union, Commit 2)
 *   - `apps/mcp-server/tests/regression/standing/worker-lifecycle/inv-worker-lock-003-embedding-backfill-supervisor.test.ts` (case #15-#18, Wave 2 Commit 1)
 *
 * @internal exported for cross-package consumption (workers + schemas + tests)
 */
export const BACKFILL_JOB_ID_REGEX: RegExp = new RegExp(
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__(${EMBEDDING_BACKFILL_CATEGORIES.join("|")})$`
);

/**
 * Create the embedding backfill queue
 *
 * @param configOverrides - Optional Redis configuration overrides
 * @returns BullMQ Queue instance
 */
export function createEmbeddingBackfillQueue(
  configOverrides?: Partial<RedisConfig>
): Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> {
  const config = getRedisConfig(configOverrides);

  return new Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>(
    EMBEDDING_BACKFILL_QUEUE_NAME,
    {
      connection: toConnectionOptions(config),
      defaultJobOptions: {
        // Plan v2 Cond 7 (anchor 019dedb1-ef6f) closure: SEC FIND-PLAN-SEC-V1-03
        // (commitment 原則 A7 retry amplification アンチパターン、CWE-693+754) を
        // formal closure するため、`attempts: 3` を撤回し `attempts: 1` に統一。
        // BullMQ job-level retry は ZERO、structural fix は Plan v2 §1 (Pre-Return
        // Pause 復活 + Phase-by-Phase tx) で transient race を排除する。
        // INV-RETRY-AMPLIFICATION-001 (worker-lifecycle standing regression) で
        // CI gate。例外は HTTP client / Playwright nav / Ollama Vision / Prisma
        // deadlock layer の internal retry のみ allowed。
        //
        // Plan v2 Cond 7 (anchor 019dedb1-ef6f) closure: retracts `attempts: 3`
        // (Plan v1) and uniforms to `attempts: 1`. SEC FIND-PLAN-SEC-V1-03
        // (commitment principle A7 retry amplification anti-pattern, CWE-693+754)
        // is formally closed; structural fix is delivered in Plan v2 §1 (Pre-Return
        // Pause restore + Phase-by-Phase tx). BullMQ job-level retry is ZERO.
        // INV-RETRY-AMPLIFICATION-001 (worker-lifecycle standing regression) gates
        // this in CI. Allowed retry layers (internal): HTTP client / Playwright
        // navigation / Ollama Vision / Prisma deadlock only.
        attempts: 1,
        backoff: {
          type: "exponential",
          delay: 5000,
          // backoff は `attempts: 1` のため事実上 dead code だが、将来 idempotency
          // contract 確立後に `attempts > 1` を条件付きで再導入する場合の保留として
          // ±50% jitter 設定を残す (Cond 7 §2.2 (4) gating contract 参照)。
          //
          // backoff is effectively dead code under `attempts: 1` but retained as
          // reserve for the conditional re-introduction of `attempts > 1` once
          // idempotency contracts land (see Cond 7 §2.2 (4) gating contract).
          jitter: 0.5,
        },
        // 24h 保持（クライアントポーリング用） / 24h retention (for client polling)
        removeOnComplete: {
          age: 24 * 60 * 60,
          count: 1000,
        },
        // 7d 保持（デバッグ用） / 7d retention (for debugging)
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
          count: 500,
        },
      },
    }
  );
}

/**
 * Create queue events for monitoring
 */
export function createEmbeddingBackfillQueueEvents(
  configOverrides?: Partial<RedisConfig>
): QueueEvents {
  const config = getRedisConfig(configOverrides);
  return new QueueEvents(EMBEDDING_BACKFILL_QUEUE_NAME, {
    connection: toConnectionOptions(config),
  });
}

/**
 * Optional override knobs for {@link addEmbeddingBackfillJob}.
 * `delay` is used by the skip-recovery path (memory_pressure) to defer the
 * first attempt; BullMQ exponential backoff is applied independently on retry.
 *
 * `delay` は skip recovery (memory_pressure) で初回試行を遅延させるために使う。
 * BullMQ の exponential backoff は retry 時に独立して適用される。
 */
export interface AddEmbeddingBackfillJobOptions {
  /** Job priority (lower = higher priority, default 10) */
  priority?: number;
  /** Initial delay (ms) before the first attempt (default 0) */
  delay?: number;
}

/**
 * Add a backfill job to the queue / バックフィルジョブを投入する
 *
 * jobId に `<webPageId>__<category>` を指定することで、同一ページ×同一カテゴリの
 * 重複投入を BullMQ レベルで防止する。既存ジョブがあった場合 BullMQ は新規作成を
 * スキップし既存ジョブを返す（冪等性）。
 *
 * Uses `<webPageId>__<category>` as jobId to deduplicate the same page × category
 * at the BullMQ level. When an existing job is present, BullMQ skips creation
 * and returns the existing job (idempotent behaviour).
 *
 * @deprecated Use {@link addEmbeddingBackfillJobWithGuard} instead (PR-D-6,
 *   FIND-TDA-02). The legacy helper lacks the atomic SETNX claim + terminal
 *   retention guard required by RC-A. Kept temporarily for backward-compatible
 *   interop during the migration window; do not add new call sites.
 *   `addEmbeddingBackfillJobWithGuard` を使用すること (PR-D-6, FIND-TDA-02)。
 *   旧 helper は RC-A 対策の atomic SETNX claim と terminal retention guard を
 *   持たない。並立期間の後方互換のため一時保持。新規 call site 追加禁止。
 *
 * @param queue - BullMQ Queue instance
 * @param data - Job data (without createdAt — filled in here)
 * @param priorityOrOptions - Backward-compatible priority number, or an options
 *   object including `delay`. Default priority 10, delay 0.
 * @returns Job instance
 */
export async function addEmbeddingBackfillJob(
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>,
  data: Omit<EmbeddingBackfillJobData, "createdAt">,
  priorityOrOptions: number | AddEmbeddingBackfillJobOptions = 10
): Promise<Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>> {
  const jobData: EmbeddingBackfillJobData = {
    ...data,
    createdAt: new Date().toISOString(),
  };

  // SEC M-1 (v0.4.0 PR4 audit): Zod validation at enqueue boundary.
  // 不正 UUID / 改行混入 / 長大文字列を拒否し、攻撃入力の拡散を防止する。
  // Rejects invalid UUID / newline injection / oversized strings to prevent
  // propagation of malicious input.
  try {
    EmbeddingBackfillJobDataSchema.parse(jobData);
  } catch (error) {
    throw new Error(`[EmbeddingBackfillQueue] Invalid job data: ${sanitizeErrorMessage(error)}`);
  }

  const jobId = buildBackfillJobId(data.webPageId, data.category);

  // Backward compatibility: bare number → priority only
  // 後方互換: 旧 number シグネチャは priority のみ
  const opts: AddEmbeddingBackfillJobOptions =
    typeof priorityOrOptions === "number" ? { priority: priorityOrOptions } : priorityOrOptions;

  const bullJobOpts: { jobId: string; priority: number; delay?: number } = {
    jobId,
    priority: opts.priority ?? 10,
  };
  if (opts.delay !== undefined && Number.isFinite(opts.delay) && opts.delay > 0) {
    bullJobOpts.delay = Math.floor(opts.delay);
  }

  return queue.add(EMBEDDING_BACKFILL_QUEUE_NAME, jobData, bullJobOpts);
}

/**
 * Back-pressure check (SEC HIGH-2 / ADR-0008 PR7b).
 *
 * waiting 件数が {@link EMBEDDING_BACKFILL_QUEUE_WAITING_CAP} を超えていれば
 * `allowEnqueue: false` を返し、呼び出し側に新規 enqueue を抑止させる。Queue 照会
 * が失敗した場合は **fail-open**（`allowEnqueue: true` を返す）— 一時的な Redis
 * 障害で skip recovery 経路が完全停止することを防ぐ。
 *
 * Returns `allowEnqueue: false` when waiting count exceeds
 * {@link EMBEDDING_BACKFILL_QUEUE_WAITING_CAP}. On query failure this is
 * **fail-open** (returns `allowEnqueue: true`) so a transient Redis hiccup does
 * not freeze the entire skip-recovery path.
 */
export async function checkBackfillQueueBackPressure(
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): Promise<{ allowEnqueue: boolean; waitingCount: number }> {
  try {
    const waitingCount = await queue.getWaitingCount();
    const safeCount = Number.isFinite(waitingCount) && waitingCount >= 0 ? waitingCount : 0;
    return {
      allowEnqueue: safeCount <= EMBEDDING_BACKFILL_QUEUE_WAITING_CAP,
      waitingCount: safeCount,
    };
  } catch (error) {
    // Fail-open: Redis 障害時に skip recovery を完全停止させない
    // Fail-open: do not freeze skip recovery on Redis failure
    logger.warn(
      "[EmbeddingBackfillQueue] back-pressure check failed; allowing enqueue (fail-open)",
      {
        error: sanitizeErrorMessage(error),
      }
    );
    return { allowEnqueue: true, waitingCount: 0 };
  }
}

/**
 * Get job status by ID / ジョブステータスを取得
 *
 * @param queue - BullMQ Queue instance
 * @param jobId - Job ID (`<webPageId>__<category>`)
 * @returns Status or null if not found
 */
// eslint-disable-next-line complexity -- Pre-existing CC=15, FIND-TDA-07 Q3-2026 backlog successor issue refactor (PR-D-6 IO spot decision 019db5a5-b84d-71cd-a198-95f9c8c1cbb7 Option A scope)
export async function getEmbeddingBackfillJobStatus(
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>,
  jobId: string
): Promise<EmbeddingBackfillJobStatus | null> {
  const job = await queue.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  const progress =
    typeof job.progress === "number" && Number.isFinite(job.progress) ? job.progress : 0;

  const timestamps: EmbeddingBackfillJobStatus["timestamps"] = {};
  if (job.timestamp !== undefined) timestamps.created = job.timestamp;
  if (job.processedOn !== undefined) timestamps.started = job.processedOn;
  if (state === "completed" && job.finishedOn !== undefined) timestamps.completed = job.finishedOn;
  if (state === "failed" && job.finishedOn !== undefined) timestamps.failed = job.finishedOn;

  const status: EmbeddingBackfillJobStatus = {
    jobId: job.id ?? jobId,
    state: state as EmbeddingBackfillJobStatus["state"],
    progress,
    timestamps,
  };

  if (state === "completed" && job.returnvalue) {
    status.result = job.returnvalue;
  }
  if (state === "failed" && job.failedReason) {
    // Plan v3 Track T4 SEC L-03 / CO-T4-02: sanitise BullMQ failedReason to
    // client-safe `analysis_pipeline_interrupted` for T4 reasons; pass-through
    // for non-T4 reasons. Defense-in-depth at queue boundary. CWE-209.
    // Plan v3 T4 SEC L-03: BullMQ `failedReason` 生暴露を queue 境界で sanitise。
    const sanitised = sanitizeAnalysisErrorForClient(job.failedReason);
    if (sanitised !== null) {
      status.error = sanitised;
    }
  }

  return status;
}

/**
 * Gracefully close the queue / キューをグレースフルに閉じる
 */
export async function closeEmbeddingBackfillQueue(
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): Promise<void> {
  await queue.close();
}

/**
 * Check if queue is healthy / キューのヘルスチェック
 */
export async function checkEmbeddingBackfillQueueHealth(
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>
): Promise<{
  healthy: boolean;
  stats: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  error?: string;
}> {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      healthy: true,
      stats: { waiting, active, completed, failed, delayed },
    };
  } catch (err) {
    return {
      healthy: false,
      stats: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// PR-D-6 Phase 2: Collision-guarded enqueue helpers
// ============================================================================

/**
 * Redis key namespace for the atomic SETNX jobId claim of the backfill queue.
 * `reftrix:backfill:jobclaim:<jobId>` 形式に展開される。
 *
 * Redis key namespace for atomic SETNX jobId claim on the backfill queue.
 */
const BACKFILL_CLAIM_KEY_NAMESPACE = "backfill";

// ============================================================================
// Backfill Job ID Regex SSOT (3 patterns)
// ============================================================================
// 1. BACKFILL_JOB_ID_REGEX (full): `<UUID>__<category>` for IPC schema validation
//    + worker schema enforcement. RFC 4122 strict hyphen positions.
// 2. JOBID_TRUNCATED_REGEX (truncated): `<8-char>...__<category>` for PII-safe
//    audit_logs payloads (see CWE-209 / GDPR Art.30 compliance).
// 3. RETRY_JOBID_TRUNCATED_REGEX (retry truncated): adds `__retry_<uuid>` suffix
//    for retry attempt audit trail.
//
// All three derive from `EMBEDDING_BACKFILL_CATEGORIES` SSOT array to prevent
// drift when new categories are added. Truncated regexes (2/3) currently
// hardcode `[a-z_]+` for the category portion; SSOT unification follow-up
// tracked as OBS-PRDD9-PATCH-08 (M, backlog 2026-Q3).
//
// ============================================================================

/**
 * PII-safe truncated jobId regex (Plan v1.2 §3.1.4 US-1 (c) binding).
 *
 * Form: `<8-char>...__<category>` (e.g. `a1b2c3d4...__part_text`).
 * Enforces that audit payloads never leak full 36-char UUID webPageId.
 *
 * @internal exported for Block C #11 CI-failing positive regex assertion.
 */
export const JOBID_TRUNCATED_REGEX = /^[a-f0-9]{8}\.{3}__[a-z_]+$/;

/**
 * PII-safe truncated retry jobId regex (Plan v1.2 §3.1.4 US-1 (c) binding).
 *
 * Form: `<8-char>...__<category>__retry_<uuidv7>` where the uuid suffix is
 * either UUIDv7 (preferred) or UUIDv4 (Node.js 20.19-21.x fallback) — both
 * conform to `[0-9a-f-]{36}`.
 *
 * @internal exported for Block C #11 CI-failing positive regex assertion.
 */
export const RETRY_JOBID_TRUNCATED_REGEX = /^[a-f0-9]{8}\.{3}__[a-z_]+__retry_[0-9a-f-]{36}$/;

/**
 * Zod schema for the `embedding_backfill_collision_resolved` audit action
 * payload (Plan v1.2 §3.1.4 UP-4 + US-1 binding).
 *
 * `.strict()` で future field injection を禁止し、runtime regex validation で
 * PII leak (full 36-char UUID) を schema-level で閉塞する。`AuditLogEntry`
 * 受け渡し時は caller が本 schema を `parse` した後で `details` に spread する。
 *
 * Strict 5-field contract for `embedding_backfill_collision_resolved`. Runtime
 * regex validation closes the PII-leak path (full 36-char UUID never reaches
 * `audit_logs.details`).
 */
export const CollisionAuditPayloadSchema = z
  .object({
    /** 11-char truncated webPageId (`<8-char>...`), post `truncateId(webPageId, 8)`. */
    webPageId: z.string().length(11),
    /** `<8-char>...__<category>` — no 36-char UUID leak. */
    originalJobId: z.string().regex(JOBID_TRUNCATED_REGEX),
    /** `<8-char>...__<category>__retry_<uuidv7>` — no 36-char UUID leak. */
    retryJobId: z.string().regex(RETRY_JOBID_TRUNCATED_REGEX),
    /** Original job state at collision detection time. */
    originalState: z.enum(["active", "waiting", "delayed", "completed", "failed", "unknown"]),
    /** ISO-8601 timestamp at collision detection time. */
    timestamp: z.string().datetime(),
  })
  .strict();

export type CollisionAuditPayload = z.infer<typeof CollisionAuditPayloadSchema>;

/**
 * Truncate the webPageId portion of a canonical jobId (`<uuid>__<category>`)
 * to 11 chars via the `utils/truncate-id.ts:17 truncateId` SSOT, keeping the
 * category suffix intact.
 *
 * Local-scope helper (Plan v1.2 §3.1.4 US-1 (a)(b) binding) — no new export
 * added to `utils/truncate-id.ts`; reuses the existing `truncateId` SSOT.
 *
 * Local-scope helper that truncates the webPageId portion of `<uuid>__<category>`
 * via the `truncateId` SSOT, preserving the category suffix. Throws on invalid
 * input rather than producing malformed audit payloads.
 *
 * @throws {Error} when the input does not match `<uuid>__<category>` form.
 */
function truncateOrigJobId(origJobId: string): string {
  if (typeof origJobId !== "string" || origJobId.length === 0) {
    throw new Error("truncateOrigJobId: origJobId must be a non-empty string");
  }
  const sepIndex = origJobId.indexOf("__");
  if (sepIndex <= 0 || sepIndex === origJobId.length - 2) {
    throw new Error("truncateOrigJobId: invalid '<webPageId>__<category>' form");
  }
  const webPageId = origJobId.slice(0, sepIndex);
  const category = origJobId.slice(sepIndex + 2);
  return `${truncateId(webPageId, 8)}__${category}`;
}

/**
 * Truncate the webPageId portion of a retry jobId
 * (`<origJobId>__retry_<uuidv7>`) while preserving the retry UUID suffix.
 *
 * Delegates to {@link truncateOrigJobId} for the leading `<uuid>__<category>`
 * segment; the 36-char retry suffix is always preserved verbatim.
 *
 * Local-scope helper per Plan v1.2 §3.1.4 US-1 (a) binding.
 *
 * @throws {Error} when the input does not match `<origJobId>__retry_<uuidv7>` form.
 */
function truncateRetryJobId(retryJobId: string): string {
  if (typeof retryJobId !== "string" || retryJobId.length === 0) {
    throw new Error("truncateRetryJobId: retryJobId must be a non-empty string");
  }
  const retryMatch = retryJobId.match(/^(.+?)__retry_([0-9a-f-]{36})$/);
  if (!retryMatch || retryMatch[1] === undefined || retryMatch[2] === undefined) {
    throw new Error("truncateRetryJobId: invalid '<origJobId>__retry_<uuidv7>' form");
  }
  return `${truncateOrigJobId(retryMatch[1])}__retry_${retryMatch[2]}`;
}

/**
 * Emit the `embedding_backfill_collision_resolved` audit row after a
 * collision-retry was enqueued. Schema-validated via
 * {@link CollisionAuditPayloadSchema} before hand-off to `AuditLogService`.
 *
 * Invoked by the generic {@link enqueueWithCollisionGuard} `auditEmitter`
 * callback — see {@link addEmbeddingBackfillJobWithGuard}.
 *
 * Emits the `embedding_backfill_collision_resolved` audit row; validated via
 * `CollisionAuditPayloadSchema` before routing through `AuditLogService`.
 */
async function emitCollisionAudit(event: {
  webPageId: string;
  originalJobId: string;
  retryJobId: string;
  originalState: "completed" | "failed";
}): Promise<void> {
  const payload: CollisionAuditPayload = CollisionAuditPayloadSchema.parse({
    webPageId: truncateId(event.webPageId, 8),
    originalJobId: truncateOrigJobId(event.originalJobId),
    retryJobId: truncateRetryJobId(event.retryJobId),
    originalState: event.originalState,
    timestamp: new Date().toISOString(),
  });

  try {
    await getAuditLogService().log({
      action: "embedding_backfill_collision_resolved",
      actor: "system:embedding-backfill-queue",
      targetType: "web_page",
      targetId: event.webPageId,
      details: payload,
      result: "success",
    });
  } catch (err) {
    // Audit emission failures must not block the retry enqueue itself.
    logger.warn("[EmbeddingBackfillQueue] collision audit emit failed (non-fatal)", {
      error: sanitizeErrorMessage(err),
    });
  }
}

/**
 * Collision-guarded enqueue (SSOT helper) for embedding backfill jobs.
 *
 * Phase 2 PR-D-6 binding: atomic SETNX Lua claim + 5 sub-handler dispatch + 6-variant
 * {@link EnqueueResult} discriminated union. Wraps the generic
 * {@link enqueueWithCollisionGuard} with backfill-specific Zod validation + audit
 * emit. Callers should migrate from legacy {@link addEmbeddingBackfillJob} to
 * this helper per Registry v3 Binding 3.
 *
 * Atomic-claim SSOT helper for embedding backfill jobs. Wraps the generic
 * helper with domain-specific Zod validation and audit emission.
 *
 * **Fail-open behaviour**: on Redis unreachable or unexpected claim failure,
 * falls through to a plain `queue.add` and returns
 * `{ outcome: "enqueued_fail_open", ... }`. This mirrors the WorkerActiveLockService
 * SEC M-1 precedent (ADR-0011) — availability preferred over strict collision
 * guard for transient Redis hiccups.
 *
 * @param queue - BullMQ Queue instance
 * @param data - Job data (without createdAt — filled in here)
 * @param options - Optional priority / delay overrides
 * @returns {@link EnqueueResult} discriminated by `outcome`
 */
export async function addEmbeddingBackfillJobWithGuard(
  queue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>,
  data: Omit<EmbeddingBackfillJobData, "createdAt">,
  options: AddEmbeddingBackfillJobOptions = {}
): Promise<EnqueueResult> {
  const jobData: EmbeddingBackfillJobData = {
    ...data,
    createdAt: new Date().toISOString(),
  };

  // SEC M-1 (v0.4.0 PR4 audit): Zod validation at enqueue boundary.
  try {
    EmbeddingBackfillJobDataSchema.parse(jobData);
  } catch (error) {
    throw new Error(`[EmbeddingBackfillQueue] Invalid job data: ${sanitizeErrorMessage(error)}`);
  }

  const jobId = buildBackfillJobId(data.webPageId, data.category);

  // Assemble BullMQ job options (priority / delay with finite guards).
  const jobOptions: { priority: number; delay?: number } = {
    priority: options.priority ?? 10,
  };
  if (options.delay !== undefined && Number.isFinite(options.delay) && options.delay > 0) {
    jobOptions.delay = Math.floor(options.delay);
  }

  return await enqueueWithCollisionGuard<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>({
    queue,
    queueName: EMBEDDING_BACKFILL_QUEUE_NAME,
    jobId,
    data: jobData,
    jobOptions,
    claimKeyNamespace: BACKFILL_CLAIM_KEY_NAMESPACE,
    webPageId: data.webPageId,
    auditEmitter: emitCollisionAudit,
  });
}

/**
 * Register the observability-only `"duplicated"` event listener on an
 * embedding-backfill {@link QueueEvents} instance.
 *
 * PR-D-6 Registry v4 §15.2 Patch Binding B (FIND-TPA-IMPL-02 + FIND-SEC-04
 * co-close): mirrors `registerPageAnalyzeDuplicatedListener` in
 * `page-analyze-queue.ts:767`. Emits a `logger.warn` for every duplicated-jobId
 * event as a secondary evidence stream correlated with
 * `embedding_backfill_collision_resolved` audit rows. Listener is detached by
 * the returned callback during `shutdownWorkers` lifecycle tear-down.
 *
 * Registers an observability-only `"duplicated"` listener on the
 * embedding-backfill QueueEvents instance. Emits `logger.warn` on each
 * duplicated-jobId event as correlated evidence for
 * `embedding_backfill_collision_resolved` audit rows.
 *
 * PII safety: `jobId` is truncated to 8-hex prefix via the `utils/truncate-id.ts`
 * SSOT before logging. `prev` (if present) is truncated the same way. Full
 * 36-char UUIDs never reach the log.
 *
 * @param queueEvents - BullMQ QueueEvents instance for the embedding-backfill queue
 * @returns Unregister callback; call during shutdown to detach the listener.
 */
export function registerEmbeddingBackfillDuplicatedListener(queueEvents: QueueEvents): () => void {
  const handler = ({ jobId }: { jobId: string }): void => {
    try {
      logger.warn("[EmbeddingBackfillQueue] QueueEvents.duplicated fired", {
        // PII-safe: truncate the <webPageId>__<category> prefix via the SSOT
        // helper. For composite jobIds the split happens at the first `__`.
        jobId: truncateId(jobId.split("__")[0] ?? jobId, 8),
      });
    } catch (err) {
      // FIND-SEC-04 closure: guard the listener itself against thrown errors.
      // A listener exception must not crash the QueueEvents event loop.
      logger.warn("[EmbeddingBackfillQueue] duplicated listener handler failed (non-fatal)", {
        error: sanitizeErrorMessage(err),
      });
    }
  };
  queueEvents.on("duplicated", handler);
  return (): void => {
    try {
      queueEvents.off("duplicated", handler);
    } catch {
      /* best-effort detach */
    }
  };
}

// ============================================================================
// Internal re-exports for test surface (Block C #11 assertion binding)
// ============================================================================

/**
 * @internal Exported exclusively for the INV-WORKER-LOCK-003 Block C #11
 * CI-failing assertion (positive / negative regex form enforcement).
 * Production callers must use {@link addEmbeddingBackfillJobWithGuard}.
 */
export const __test_only__ = {
  truncateOrigJobId,
  truncateRetryJobId,
  emitCollisionAudit,
} as const;
