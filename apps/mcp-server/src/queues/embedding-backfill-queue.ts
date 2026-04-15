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
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

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
 * 旧 API 互換エイリアス — 後方互換のため残す（新規コードは `EMBEDDING_BACKFILL_CATEGORIES` を使う）
 * Legacy alias for backward compatibility (new code should use `EMBEDDING_BACKFILL_CATEGORIES`)
 */
export const BACKFILLABLE_CATEGORIES: readonly EmbeddingBackfillCategory[] =
  EMBEDDING_BACKFILL_CATEGORIES;

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
   * 現在は `ssrf_blocked_on_backfill` のみ。PR7e-β 以降で拡張予定。
   *
   * Graceful Degradation skip reason (v0.4.0 PR7e-α / bug ⑦ observability).
   * Only `ssrf_blocked_on_backfill` for now; expanded in later PRs.
   */
  skipReason?: "ssrf_blocked_on_backfill" | undefined;
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
        // 一時的な OOM / VRAM 逼迫から回復するため、最大 3 回まで再試行
        // Retry up to 3 times to recover from transient OOM / VRAM pressure
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
          // PR7b-convergence (SEC MEDIUM-1): Thundering Herd 対策として ±50%
          // jitter を付与。BullMQ 5.x built-in strategy に組み込まれており、
          // exponential delay × (1 ± jitter) の範囲で randomize される。
          // 複数ページが同時刻に失敗→再試行するケースで VRAM / Redis に一気に
          // 負荷が集中することを防止。
          //
          // PR7b-convergence (SEC MEDIUM-1): ±50% jitter for Thundering Herd
          // defense. Provided by BullMQ 5.x built-in strategy; randomizes within
          // exponential delay × (1 ± jitter). Prevents concurrent failure→retry
          // across multiple pages from bursting VRAM / Redis simultaneously.
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
    status.error = job.failedReason;
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
