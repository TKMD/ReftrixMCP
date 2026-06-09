// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Child Process IPC Type Definitions and Zod Schemas
 *
 * Defines the IPC message protocol between the parent (fork orchestrator)
 * and child processes (text-embedding, visual-embedding).
 *
 * P0-2: All IPC messages are validated with Zod discriminatedUnion schemas.
 * P0-10: Error messages are sanitized via sanitizeErrorMessage (CWE-209).
 * P1-14: IPC error messages are capped at 1000 characters.
 *
 * @module workers/phases/phase-5-child-ipc
 */

import { z } from "zod";

import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { safeParseInt } from "../../utils/safe-parse-int";
// PR-BT-5 (M-1-RSS, ADR-0039 Decision 3, Conflict 1): the additive `subPhase`
// IPC discriminator is SSOT-derived from these const arrays via `z.enum(...)`
// — NO hand-written enum literals (enforced by
// `inv-schema-enum-004-phase5-subphase.test.ts`). Scope = IPC-internal 2-site
// (TS const ↔ Zod); Prisma↔MCP 4-site is N/A (subPhase is neither persisted nor
// MCP-exposed, IO V-4).
import { PHASE5_TEXT_SUBPHASES, PHASE5_VISUAL_SUBPHASES } from "./phase-5-subphases.const";

// ============================================================================
// Constants
// ============================================================================

/** Maximum length for IPC error messages (P1-14) */
export const IPC_ERROR_MESSAGE_MAX_LENGTH = 1000;

/** Maximum length for IPC string fields */
const IPC_STRING_MAX_LENGTH = 10_000;

/** Maximum length for serialized JSON data fields (50MB safety) */
const IPC_DATA_MAX_LENGTH = 50_000_000;

// ============================================================================
// Parent → Child Messages
// ============================================================================

/**
 * Zod schema for IdMapping entries (Map<string, string> serialized as array)
 */
const idMappingEntrySchema = z.tuple([
  z.string().max(IPC_STRING_MAX_LENGTH),
  z.string().max(IPC_STRING_MAX_LENGTH),
]);

/**
 * Parent → Child: Initialize text embedding child process
 */
export const parentInitTextSchema = z
  .object({
    type: z.literal("init-text"),
    webPageId: z.string().uuid(),
    url: z.string().max(IPC_STRING_MAX_LENGTH),
    // SaveResult idMappings serialized as [key, value][] arrays
    sectionIdMapping: z.array(idMappingEntrySchema).nullable(),
    motionIdMapping: z.array(idMappingEntrySchema).nullable(),
    jsIdMapping: z.array(idMappingEntrySchema).nullable(),
    bgIds: z.array(z.string().max(IPC_STRING_MAX_LENGTH)).nullable(),
    scrollVisionIdMapping: z.array(idMappingEntrySchema).nullable(),
    // Serialized analysis results (JSON strings for large payloads)
    layoutResultJson: z.string().max(IPC_DATA_MAX_LENGTH).nullable(),
    motionResultJson: z.string().max(IPC_DATA_MAX_LENGTH).nullable(),
    jsAnimationsJson: z.string().max(IPC_DATA_MAX_LENGTH).nullable(),
    scrollVisionResultJson: z.string().max(IPC_DATA_MAX_LENGTH).nullable(),
    responsiveAnalysisId: z.string().max(IPC_STRING_MAX_LENGTH).optional(),
    partsSavedCount: z.number().int().min(0).optional(),
    /**
     * v0.4.0 PR4: 子プロセスで処理する Part text embedding の上限件数。
     * 100 件超のページで 100 に設定される。
     *
     * v0.4.0 PR4: Cap on the number of Part text embeddings processed in the
     * child. Set to 100 when a page has more than 100 Parts.
     */
    partsLimit: z.number().int().min(1).optional(),
    /**
     * PR-BT-5 (M-1-RSS, ADR-0039 Decision 3): per-sub-phase fork discriminator.
     * When set, the text child runs ONLY this single text sub-phase and
     * `exit(0)`s (the per-sub-phase fork model — each fork reclaims its arena on
     * exit, rooting out the inter-sub-phase reload). When **omitted**, the child
     * grandfathers to the legacy "run all 7 text sub-phases" behaviour
     * (backward-compatible). SSOT-derived via `z.enum(PHASE5_TEXT_SUBPHASES)`
     * — no hand-written literals.
     *
     * PR-BT-5 (M-1-RSS): per-sub-phase fork 識別子。指定時は当 1 sub-phase のみ
     * 実行して exit(0)。省略時は legacy 全 7 sub-phase 実行に grandfather。
     */
    subPhase: z.enum(PHASE5_TEXT_SUBPHASES).optional(),
    // FIND-PLAN-M-02 (SEC-M-1, SEC H-2 parity): reject unknown keys at the IPC
    // boundary (CWE-20 improper input validation). PR-1 GPU-COORD adds .strict()
    // to all 10 phase-5-child-ipc schemas (was 0 before; ADR/master-plan prose
    // claiming "existing .strict()" is a known doc-error per FIND-PLAN-DOC-01).
    // PR-BT-5 keeps .strict() while adding the additive `subPhase` field above.
  })
  .strict();

/**
 * Parent → Child: Initialize visual embedding child process
 */
export const parentInitVisualSchema = z
  .object({
    type: z.literal("init-visual"),
    webPageId: z.string().uuid(),
    url: z.string().max(IPC_STRING_MAX_LENGTH),
    screenshotPngPath: z.string().max(IPC_STRING_MAX_LENGTH),
    sectionIdMapping: z.array(idMappingEntrySchema).nullable(),
    partsSavedCount: z.number().int().min(0).optional(),
    /**
     * v0.4.0 PR4: 子プロセスで処理する Part visual embedding の上限件数。
     * v0.4.0 PR4: Cap on the number of Part visual embeddings processed in the child.
     */
    partsLimit: z.number().int().min(1).optional(),
    layoutResultJson: z.string().max(IPC_DATA_MAX_LENGTH).nullable(),
    viewportWidth: z.number().int().min(1).max(4096).optional(),
    viewportHeight: z.number().int().min(1).max(4096).optional(),
    fallbackEnabled: z.boolean(),
    dinov2ModelPath: z.string().max(IPC_STRING_MAX_LENGTH),
    /**
     * PR-BT-5 (M-1-RSS, ADR-0039 Decision 3): per-sub-phase fork discriminator.
     * When set, the visual child runs ONLY this single visual sub-phase and
     * `exit(0)`s. When **omitted**, the child grandfathers to the legacy "run
     * both section_visual + part_visual" behaviour (backward-compatible).
     * SSOT-derived via `z.enum(PHASE5_VISUAL_SUBPHASES)` — no hand-written
     * literals.
     *
     * PR-BT-5 (M-1-RSS): per-sub-phase fork 識別子。指定時は当 1 sub-phase のみ
     * 実行して exit(0)。省略時は legacy 全 visual sub-phase 実行に grandfather。
     */
    subPhase: z.enum(PHASE5_VISUAL_SUBPHASES).optional(),
  })
  .strict();

/**
 * Parent → Child: Relay lock extension acknowledgment
 */
export const parentLockAckSchema = z
  .object({
    type: z.literal("lock-ack"),
    success: z.boolean(),
  })
  .strict();

/**
 * Parent → Child: Graceful shutdown request
 */
export const parentShutdownSchema = z
  .object({
    type: z.literal("shutdown"),
  })
  .strict();

/**
 * Union of all parent → child message types
 */
export const parentToChildSchema = z.discriminatedUnion("type", [
  parentInitTextSchema,
  parentInitVisualSchema,
  parentLockAckSchema,
  parentShutdownSchema,
]);

export type ParentToChildMessage = z.infer<typeof parentToChildSchema>;

// ============================================================================
// Child → Parent Messages
// ============================================================================

/**
 * Child → Parent: Heartbeat (keeps parent aware child is alive)
 *
 * v0.4.0 PR3: `rssDeltaMb` was added to enable delta-based RSS monitoring.
 * Linux fork() Copy-on-Write semantics cause the child to inherit the parent's
 * RSS at startup, so absolute RSS values are misleading. The child now reports
 * both the absolute `rssMb` (for observability / DB logs) and the delta
 * (`currentRss - initialRss`) which is used for threshold enforcement.
 *
 * v0.4.0 PR3: `rssDeltaMb` は delta ベース RSS 監視のために追加された必須
 * フィールド。Linux fork() の Copy-on-Write セマンティクスにより子プロセスは
 * 起動時に親の RSS を継承するため、絶対値では判定できない。子プロセスは
 * 絶対値 `rssMb`（可観測性 / DB ログ用）と delta（`currentRss - initialRss`、
 * 閾値判定用）の両方を報告する。
 */
export const childHeartbeatSchema = z
  .object({
    type: z.literal("heartbeat"),
    rssMb: z.number().min(0),
    rssDeltaMb: z.number(),
    phase: z.string().max(200),
  })
  .strict();

/**
 * Child → Parent: Request lock extension relay
 */
export const childLockRequestSchema = z
  .object({
    type: z.literal("lock-request"),
    label: z.string().max(200),
  })
  .strict();

/**
 * Child → Parent: Progress update
 */
export const childProgressSchema = z
  .object({
    type: z.literal("progress"),
    completed: z.number().int().min(0),
    total: z.number().int().min(0),
    phase: z.string().max(200),
  })
  .strict();

/**
 * Child → Parent: Text embedding result (success)
 *
 * PR-V3-T1a §3.2 C1/C3 (FIND-V3-IO-H-01 closure): additively added optional
 * `chunkedEncoderTelemetry` to surface streaming chunked encoder hardening
 * outcomes — per-chunk RSS overshoot (C1) and partial-completion (C3) — back
 * to the parent so the parent can emit `audit_logs` entries via the SSOT
 * AUDIT_ACTION constants. Legacy child messages (without this field) are
 * accepted via `optional()` to preserve forward compatibility (parents on
 * the new schema accept old children).
 *
 * `partialCompletion` semantic (C3): `chunksDone < totalChunks` indicates the
 * text-section chunk loop broke early; chunks `[0..chunksDone-1]` are durable
 * forward intent (already persisted), chunks `[chunksDone..totalChunks-1]`
 * are skipped and surfaced via post-Phase-5 backfill enumeration.
 *
 * `budgetExceededChunkIndex` semantic (C1): the chunk index whose per-chunk
 * peak RSS exceeded `PER_CHUNK_RSS_BUDGET_MB`. When set, `partialCompletion`
 * is also set with `chunksDone = budgetExceededChunkIndex`.
 *
 * PR-V3-T1a §3.2 C1/C3: additively added optional `chunkedEncoderTelemetry`
 * carrying C1 (per-chunk RSS overshoot) and C3 (partial completion) outcomes
 * back to the parent for `audit_logs` emission. Optional for forward
 * compatibility.
 */
export const childTextResultSchema = z
  .object({
    type: z.literal("text-result"),
    sectionEmbeddingsGenerated: z.number().int().min(0),
    motionEmbeddingsGenerated: z.number().int().min(0),
    bgEmbeddingsGenerated: z.number().int().min(0),
    jsAnimationEmbeddingsGenerated: z.number().int().min(0),
    responsiveEmbeddingsGenerated: z.number().int().min(0),
    partEmbeddingsGenerated: z.number().int().min(0),
    embeddingFailedChunks: z.number().int().min(0),
    chunkedEncoderTelemetry: z
      .object({
        partialCompletion: z
          .object({
            chunksDone: z.number().int().min(0),
            totalChunks: z.number().int().min(1),
          })
          .optional(),
        budgetExceededChunkIndex: z.number().int().min(0).optional(),
        idempotencyChunkSkippedCount: z.number().int().min(0).optional(),
      })
      .optional(),
  })
  .strict();

/**
 * Child → Parent: Visual embedding result (success)
 *
 * PR-D-2 (INV-EMBEDDING-INTEGRITY-005): `partVisualSkippedBboxInvalid` を
 * additive に optional 追加。古い child からの message (field 欠落) は
 * Zod default で 0 扱いになり後方互換を維持する。
 *
 * PR-D-2 (INV-EMBEDDING-INTEGRITY-005): additively added optional
 * `partVisualSkippedBboxInvalid`. Legacy child messages (missing this field)
 * default to 0 via Zod, preserving backward compatibility.
 */
export const childVisualResultSchema = z
  .object({
    type: z.literal("visual-result"),
    sectionVisualEmbeddingsGenerated: z.number().int().min(0),
    partVisualEmbeddingsGenerated: z.number().int().min(0),
    partVisualSkippedBboxInvalid: z.number().int().min(0).optional().default(0),
    // ADR-0018 Amendment 7 §7.6 exit #2 (Plan v2 PR-B): additively added optional
    // `partVisualSkippedBboxUnresolvable`. Legacy child messages (missing this
    // field) default to 0 via Zod, preserving backward compatibility (symmetric
    // with partVisualSkippedBboxInvalid).
    partVisualSkippedBboxUnresolvable: z.number().int().min(0).optional().default(0),
    // ADR-0018 Amendment 13 (truncated-screenshot data-loss fix): additively added
    // optional `partVisualSkippedScreenshotTruncated`. Legacy child messages
    // (missing this field) default to 0 via Zod, preserving backward compatibility
    // (symmetric with partVisualSkippedBboxUnresolvable).
    partVisualSkippedScreenshotTruncated: z.number().int().min(0).optional().default(0),
    embeddingFailedChunks: z.number().int().min(0),
  })
  .strict();

/**
 * Child → Parent: Error report
 */
export const childErrorSchema = z
  .object({
    type: z.literal("error"),
    message: z.string().max(IPC_ERROR_MESSAGE_MAX_LENGTH),
    phase: z.string().max(200).optional(),
  })
  .strict();

/**
 * Union of all child → parent message types
 */
export const childToParentSchema = z.discriminatedUnion("type", [
  childHeartbeatSchema,
  childLockRequestSchema,
  childProgressSchema,
  childTextResultSchema,
  childVisualResultSchema,
  childErrorSchema,
]);

export type ChildToParentMessage = z.infer<typeof childToParentSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate an IPC message from parent to child.
 * Returns null if validation fails (with logged warning).
 */
export function validateParentMessage(raw: unknown): ParentToChildMessage | null {
  const result = parentToChildSchema.safeParse(raw);
  if (!result.success) {
    // Log validation failure (no PII — only schema error details)
    console.warn("[Phase5-IPC] Invalid parent message:", result.error.issues[0]?.message);
    return null;
  }
  return result.data;
}

/**
 * Validate an IPC message from child to parent.
 * Returns null if validation fails (with logged warning).
 */
export function validateChildMessage(raw: unknown): ChildToParentMessage | null {
  const result = childToParentSchema.safeParse(raw);
  if (!result.success) {
    // Log validation failure (no PII — only schema error details)
    console.warn("[Phase5-IPC] Invalid child message:", result.error.issues[0]?.message);
    return null;
  }
  return result.data;
}

// ============================================================================
// Serialization Helpers
// ============================================================================

/**
 * Truncate an error message to IPC maximum length (P1-14).
 */
export function truncateErrorForIPC(message: string): string {
  if (message.length <= IPC_ERROR_MESSAGE_MAX_LENGTH) return message;
  return message.slice(0, IPC_ERROR_MESSAGE_MAX_LENGTH);
}

/**
 * Serialize a Map<string, string> to IPC-safe [key, value][] array.
 */
export function serializeIdMapping(
  map: Map<string, string> | undefined | null
): [string, string][] | null {
  if (!map || map.size === 0) return null;
  return Array.from(map.entries());
}

/**
 * Deserialize an IPC [key, value][] array back to Map<string, string>.
 */
export function deserializeIdMapping(entries: [string, string][] | null): Map<string, string> {
  if (!entries) return new Map();
  return new Map(entries);
}

/**
 * Append ?connection_limit=N to a DATABASE_URL (P0-3).
 * Handles URLs that already have query parameters.
 */
export function appendConnectionLimit(databaseUrl: string, limit: number): string {
  const separator = databaseUrl.includes("?") ? "&" : "?";
  return `${databaseUrl}${separator}connection_limit=${limit}`;
}

// ============================================================================
// Shared Child Process IPC Helpers
// ============================================================================
// These functions are shared between text-embedding-child and visual-embedding-child
// to eliminate 71-line IPC duplication (TDA audit finding).
// Any change here is automatically reflected in both child processes.

// ============================================================================
// Child RSS Self-Monitoring Constants (v0.4.0 PR3: delta-based)
// ============================================================================
//
// Delta ベース RSS 監視の背景 / Why delta-based RSS monitoring:
//
// Linux の fork() は Copy-on-Write (COW) セマンティクスで動作するため、
// 子プロセスは起動直後から親プロセスの RSS を継承する。v0.3.0 の実装では
// 絶対値閾値 (PHASE5_CHILD_RSS_KILL_MB=5120MB) で self-kill 判定していたが、
// 親ワーカーが Phase 0-4 完了時点で既に 4600MB の RSS を使用していたため、
// 子プロセスが ONNX をロードした直後 (RSS ~5100MB) に即 self-kill が発動し、
// Phase 5 embedding が 0 件で完了する致命的なバグが発生した (Stripe 事例)。
//
// v0.4.0 PR3 では、初期 RSS (起動直後の親継承分) をベースラインとして記録し、
// `currentRss - initialRss` の delta 値で閾値判定する。これにより子プロセス
// 自身が割り当てたメモリ (ONNX / Sharp / glibc) のみを閾値に照らすことが
// でき、親の RSS サイズに依存しない堅牢な監視が可能になる。
//
// Linux fork() uses Copy-on-Write (COW) semantics, so the child inherits the
// parent's RSS immediately at startup. The v0.3.0 implementation compared
// absolute RSS against PHASE5_CHILD_RSS_KILL_MB=5120MB, but by Phase 5 the
// parent worker typically held ~4600MB of RSS already. The child would trip
// self-kill shortly after loading ONNX (RSS ~5100MB), finishing Phase 5 with
// zero embeddings generated (observed on Stripe).
//
// In v0.4.0 PR3 the child records its initial RSS (inherited from the parent)
// as a baseline and compares `currentRss - initialRss` (delta) against the
// thresholds. Only memory the child itself allocates (ONNX / Sharp / glibc)
// counts, making monitoring independent of the parent's RSS footprint.

/** RSS delta warning threshold (MB) — log warning when child-allocated
 *  memory exceeds this delta. Default 2560 MB (2.5GB): ONNX e5-base CPU mode
 *  allocates ~2.3GB via glibc sbrk heap, so a delta above 2.5GB indicates
 *  unusual growth beyond the expected e5-base footprint.
 *  RSS delta 警告閾値 (MB) — 子プロセスが割り当てたメモリ delta がこの値を
 *  超えた場合にログ警告を出す。デフォルト 2560 MB (2.5GB)。ONNX e5-base CPU
 *  モードは glibc sbrk ヒープ経由で ~2.3GB を割り当てるため、2.5GB 超は異常。*/
const RAW_CHILD_RSS_WARN_DELTA_MB = safeParseInt(process.env.PHASE5_CHILD_RSS_WARN_DELTA_MB, 2560, {
  min: 256,
  max: 16384,
});

/** RSS delta kill threshold (MB) — child self-terminates when the delta
 *  exceeds this value. Default 4096 MB (4GB): ONNX e5-base CPU mode allocates
 *  ~3.1GB delta via glibc sbrk heap (observed on reftrix.io: delta=3121MB at
 *  kill). Previous default 3072MB was insufficient for CPU-only embedding.
 *  Fork children are short-lived — OS reclaims all memory on exit(0).
 *
 *  β2-P1: 3072→4096 に引き上げ。e5-base CPU 推論の glibc sbrk ヒープ使用量が
 *  ~3.1GB delta に達するため、以前のデフォルト 3072MB では不足。fork 子プロセスは
 *  短命であり exit(0) 時に OS が全メモリを回収するため安全。
 *  RSS delta 強制終了閾値 (MB) — delta がこの値を超えた場合に子プロセスが
 *  自己終了する。デフォルト 4096 MB (4GB)。 */
const RAW_CHILD_RSS_KILL_DELTA_MB = safeParseInt(process.env.PHASE5_CHILD_RSS_KILL_DELTA_MB, 4096, {
  min: 512,
  max: 32768,
});

/**
 * Cross-consistency validation (SEC-L2): kill must be > warn.
 * If misconfigured (e.g., PHASE5_CHILD_RSS_KILL_DELTA_MB <= WARN_DELTA_MB),
 * fall back to safe defaults to prevent immediate self-kill at startup.
 *
 * 交叉一貫性検証 (SEC-L2): kill は warn より大きくなければならない。
 * 設定ミスの場合は安全なデフォルト値にフォールバックする。
 */
function validateRssDeltaThresholds(warn: number, kill: number): { warn: number; kill: number } {
  if (kill <= warn) {
    console.warn(
      `[Phase5-IPC] Invalid RSS delta thresholds: kill (${kill}MB) must be > warn (${warn}MB). ` +
        `Falling back to defaults: warnDelta=2560, killDelta=4096.`
    );
    return { warn: 2560, kill: 4096 };
  }
  return { warn, kill };
}

const _validatedDelta = validateRssDeltaThresholds(
  RAW_CHILD_RSS_WARN_DELTA_MB,
  RAW_CHILD_RSS_KILL_DELTA_MB
);

/** RSS delta warn threshold (MB), validated against kill threshold. */
export const CHILD_RSS_WARN_DELTA_MB = _validatedDelta.warn;

/** RSS delta kill threshold (MB), validated against warn threshold. */
export const CHILD_RSS_KILL_DELTA_MB = _validatedDelta.kill;

/** Heartbeat interval handle (module-level singleton for child process) */
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/** Track whether RSS kill exit is in progress to prevent double-exit */
let rssKillInProgress = false;

/**
 * Baseline RSS captured at startHeartbeat() time (MB).
 *
 * This represents the RSS inherited from the parent via fork() Copy-on-Write
 * plus any minimal startup overhead before child-specific work begins. All
 * delta calculations in the heartbeat loop are `current - baseline`.
 *
 * startHeartbeat() 呼び出し時点で記録するベースライン RSS (MB)。これは親
 * プロセスからの COW 継承分 + 最小限の起動オーバーヘッドを表す。heartbeat
 * ループ内の delta 計算は全て `current - baseline` で行う。
 */
let initialRssMb = 0;

/**
 * Send a typed IPC message to parent. Fire-and-forget.
 * Used for heartbeats, lock-request relay, and progress updates.
 */
export function sendToParent(msg: ChildToParentMessage): void {
  try {
    if (process.send) {
      process.send(msg);
    }
  } catch {
    // Parent may have already disconnected
  }
}

/**
 * Send a typed IPC message and wait for it to be flushed to the kernel buffer.
 * Must be called before process.exit() to prevent IPC race condition.
 * Safety timeout: 5 seconds (SEC/TDA recommendation).
 */
export async function sendToParentAndFlush(msg: ChildToParentMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000); // Safety timeout (SEC/TDA recommendation)
    try {
      if (process.send) {
        process.send(msg, () => {
          clearTimeout(timer);
          resolve();
        });
      } else {
        clearTimeout(timer);
        resolve();
      }
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * Start periodic heartbeat to keep parent aware the child is alive.
 *
 * v0.4.0 PR3: RSS self-monitoring uses **delta** (currentRss - initialRss)
 * instead of absolute RSS. See the constants section above for rationale
 * (fork() Copy-on-Write makes absolute-value thresholds unreliable).
 *
 * Two-layer self-defense (delta-based):
 * - delta > CHILD_RSS_WARN_DELTA_MB: log warning, continue processing
 * - delta > CHILD_RSS_KILL_DELTA_MB: send error to parent, process.exit(1)
 *
 * v0.4.0 PR3: RSS 自己監視は絶対値ではなく delta
 * (currentRss - initialRss) ベースで行う。fork() COW により絶対値閾値は
 * 信頼できない (上のコメント参照)。
 *
 * @param phase - Phase identifier for heartbeat messages
 *   (e.g. "text-embedding", "visual-embedding")
 */
export function startHeartbeat(phase: string): void {
  // Capture baseline RSS (inherited from parent via fork() Copy-on-Write).
  // This baseline lets us evaluate thresholds against the delta of memory
  // allocated by the child itself, ignoring the inherited parent RSS.
  // 起動直後の RSS をベースラインとして記録 (親から COW 継承した分)。
  // これにより子プロセスが新規に割り当てたメモリのみを閾値と比較できる。
  initialRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // SEC M-2: Non-COW environment detection.
  // If the initial RSS is unexpectedly low (< 100 MB), fork() Copy-on-Write
  // may not be behaving as expected — the child did not inherit the parent's
  // RSS. This is observed on WSL2 and some rootless Docker configurations.
  // In such environments the delta approximates the child's full RSS rather
  // than just child-allocated memory, potentially over-counting. Log-only;
  // heartbeat continues (graceful degradation).
  //
  // SEC M-2: 非 COW 環境検知。initialRssMb が想定外に低い (< 100 MB) 場合、
  // fork() COW が期待通りに機能していない可能性がある (WSL2 / 一部 rootless
  // Docker で観測される症状)。この場合 delta は「子固有の割り当て」ではなく
  // 「子プロセス全体の RSS」に近い値となり、過大計測の可能性がある。警告
  // のみでheartbeat は継続する (Graceful Degradation)。
  if (initialRssMb < 100) {
    console.warn(
      `[Phase5Child][${phase}] Unexpectedly low initial RSS (${initialRssMb}MB). ` +
        `Expected parent RSS inheritance via fork() COW. ` +
        `Possible non-COW environment (WSL2 rootless Docker?). ` +
        `Delta monitoring may over-count child allocations.`,
      { initialRssMb }
    );
  }

  const tick = (): void => {
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const rssDeltaMb = rssMb - initialRssMb;

    sendToParent({
      type: "heartbeat",
      rssMb,
      rssDeltaMb,
      phase,
    });

    // Delta-based self-kill: child-allocated memory exceeds kill threshold.
    // delta ベース自己終了: 子プロセスが割り当てたメモリが kill 閾値を超えた場合。
    if (rssDeltaMb > CHILD_RSS_KILL_DELTA_MB && !rssKillInProgress) {
      rssKillInProgress = true;
      console.error(
        `[Phase5-${phase}] RSS delta ${rssDeltaMb}MB exceeds kill threshold ` +
          `${CHILD_RSS_KILL_DELTA_MB}MB (current=${rssMb}MB, initial=${initialRssMb}MB), ` +
          `self-terminating`
      );
      sendToParentAndFlush({
        type: "error",
        message: truncateErrorForIPC(
          `RSS self-kill: delta=${rssDeltaMb}MB > ${CHILD_RSS_KILL_DELTA_MB}MB ` +
            `(current=${rssMb}MB, initial=${initialRssMb}MB)`
        ),
        phase: `${phase}-rss-kill`,
      }).finally(() => process.exit(1));
      return;
    }

    // Delta-based warn: child-allocated memory exceeds warn threshold.
    // delta ベース警告: 子プロセスが割り当てたメモリが warn 閾値を超えた場合。
    if (rssDeltaMb > CHILD_RSS_WARN_DELTA_MB) {
      console.warn(
        `[Phase5-${phase}] RSS delta ${rssDeltaMb}MB exceeds warn threshold ` +
          `${CHILD_RSS_WARN_DELTA_MB}MB (current=${rssMb}MB, initial=${initialRssMb}MB)`
      );
    }
  };

  // Emit an immediate tick so parent sees the baseline RSS without waiting 10s.
  // 初回 tick を即座に実行し、親が 10 秒待たずにベースライン RSS を観測できるようにする。
  tick();

  heartbeatInterval = setInterval(tick, 10_000);
}

/**
 * Stop heartbeat interval.
 *
 * Resets the rssKillInProgress flag and initialRssMb baseline (TDA M-2:
 * test isolation and re-entrancy safety — relevant when startHeartbeat()
 * is called again in the same process during tests).
 *
 * rssKillInProgress フラグと initialRssMb ベースラインをリセット (TDA M-2:
 * テスト分離と再入安全性 — 同一プロセスで startHeartbeat() を再度呼ぶ場合)。
 */
export function stopHeartbeat(): void {
  rssKillInProgress = false;
  initialRssMb = 0;
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Register process-level error handlers for uncaught exceptions and unhandled rejections.
 * Both handlers send sanitized error messages to parent via IPC and exit with code 1.
 *
 * @param phase - Phase identifier prefix (e.g. "text-embedding", "visual-embedding")
 */
export function registerProcessErrorHandlers(phase: string): void {
  process.on("uncaughtException", (error) => {
    sendToParentAndFlush({
      type: "error",
      message: truncateErrorForIPC(sanitizeErrorMessage(error)),
      phase: `${phase}-uncaught`,
    }).finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    sendToParentAndFlush({
      type: "error",
      message: truncateErrorForIPC(
        sanitizeErrorMessage(reason instanceof Error ? reason : new Error(String(reason)))
      ),
      phase: `${phase}-unhandled`,
    }).finally(() => process.exit(1));
  });
}

/**
 * Handle graceful shutdown: stop heartbeat, disconnect Prisma, and exit.
 * Used in the "shutdown" message handler of both child processes.
 *
 * @param prismaClient - Prisma client instance to disconnect (typed as { $disconnect(): Promise<void> } for flexibility)
 */
export async function handleShutdown(prismaClient: {
  $disconnect(): Promise<void>;
}): Promise<never> {
  stopHeartbeat();
  try {
    await prismaClient.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
