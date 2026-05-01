// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill IPC Schema (v0.4.0 PR7e-β4 PR2a)
 *
 * `child_process.fork()` で分離された EmbeddingBackfillWorker の親子間 IPC
 * メッセージスキーマ。Phase 5 の IPC スキーマ (`phase-5-child-ipc.ts`) とは
 * **完全に独立** しており、Phase 5 の外部契約・内部実装を一切変更しない
 * (ADR-0015 Decision #5)。
 *
 * IPC schema for parent/child messaging in the fork-isolated
 * EmbeddingBackfillWorker. **Fully independent** of the Phase 5 IPC schema
 * (`phase-5-child-ipc.ts`); Phase 5's contract is left untouched
 * (ADR-0015 Decision #5).
 *
 * ## セキュリティ設計 / Security design
 *
 * 全 `z.object({...})` に `.strict()` を付与し unknown-key 混入
 * (`__proto__` / `constructor` 等による CWE-502 prototype pollution 経路) を
 * reject する (SEC H-2)。Zod のデフォルトは unknown-key を silently strip して
 * parse 成功とみなすため、`.strict()` なしでは IPC 経路に proxy が挟まった
 * 場合の observability を失う。
 *
 * All `z.object({...})` use `.strict()` to reject unknown keys
 * (CWE-502 prototype-pollution surface via `__proto__` / `constructor`) per
 * SEC H-2. Zod's default silently strips unknown keys, which would mask any
 * injected payload on the IPC path.
 *
 * ## カテゴリスコープ / Category scope
 *
 * v0.4.0 PR7e-β4 PR2d (HIGH-β): 7 全 category (`part_text` / `part_visual` /
 * `section_visual` / `motion` / `background` / `js_animation` / `responsive`)
 * を fork 化対象に拡張。`category` enum は SSOT
 * (`EMBEDDING_BACKFILL_CATEGORIES`) を直接参照するため、SSOT への追加で
 * 自動的に enum も追従する (drift 不可能)。PR2c 以前は `js_animation` のみ
 * canary 対象だった。
 *
 * PR2d (HIGH-β): Expanded to all 7 categories (`part_text` / `part_visual` /
 * `section_visual` / `motion` / `background` / `js_animation` / `responsive`).
 * The `category` enum directly references the SSOT
 * (`EMBEDDING_BACKFILL_CATEGORIES`) so drift is impossible — adding to the
 * SSOT auto-extends the enum. Pre-PR2c the canary was `js_animation` only.
 *
 * @module workers/phases/embedding-backfill-ipc
 */

import { z } from "zod";
// v0.4.0 PR7e-β4 PR2d (HIGH-β): Re-use the canonical SSOT for backfill
// categories so the IPC schema cannot drift from `EMBEDDING_BACKFILL_CATEGORIES`
// (`apps/mcp-server/src/queues/embedding-backfill-queue.ts` L180). Introducing
// a parallel hardcoded enum here would create a second source of truth and
// guarantee drift on the next category add/remove. The TPA Option C SSOT
// requirement is satisfied by this single import.
//
// PR2d (HIGH-β): SSOT を queues/embedding-backfill-queue.ts に集約済の
// `EMBEDDING_BACKFILL_CATEGORIES` から再 import する。本ファイルで重複定義
// すると drift リスクが生じるため、TPA Option C の SSOT 要求は本 import で
// 満足する。
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  type EmbeddingBackfillCategory,
} from "../../queues/embedding-backfill-queue";

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum parts processed per fork invocation (Zod hard cap).
 *
 * fork 呼び出しあたりの最大パーツ件数 (Zod hard cap)。
 *
 * safety upper bound として 1000 を schema で強制する。GDPR Art.5(1)(c)
 * (データ最小化原則) + CWE-770 (DoS 防御) の双方に寄与。
 */
export const BACKFILL_PARTS_LIMIT_MAX = 1000 as const;

/**
 * Default parts limit for canary fork invocations.
 *
 * canary fork 呼び出しの既定パーツ件数。
 *
 * v0.4.0 PR7e-β4 PR2b-β (TPA-M-1 PR2b-β audit 反映): 従来は `processors.ts` の
 * `partsLimit: 100` としてインラインに記述されていたが、ADR-0007 head-100 契約
 * を単一 source of truth として保つため本定数に集約。PR3a+ で motion / background
 * カテゴリ追加時も同一定数を参照し drift を防止する。`.max(BACKFILL_PARTS_LIMIT_MAX)`
 * の absolute upper bound とは別物 (canary rollout の運用値)。
 *
 * TPA-M-1 (PR7e-β4 PR2b-β audit): Previously inlined as `partsLimit: 100` in
 * `processors.ts`. Consolidated here as the single source of truth for the
 * ADR-0007 head-100 contract so PR3a+ (motion / background) reuse the same
 * constant without drift. Distinct from the `.max(BACKFILL_PARTS_LIMIT_MAX)`
 * absolute upper bound (this is the canary rollout operational value).
 */
export const BACKFILL_PARTS_LIMIT_DEFAULT = 100 as const;

/**
 * IPC `errors` payload hard cap — single source of truth for
 * `BackfillDoneMessage.errors.max(...)` and the child-side truncation slice.
 *
 * v0.4.0 PR7e-β4 PR2b-β (TDA-L-3 反映): 従来は `embedding-backfill-child.ts` 側に
 * もローカル定数が定義されていたが、drift 防止のため本 IPC schema に一本化し、
 * child 側 / parent schema の両方が本定数を参照する。
 *
 * TDA-L-3 (PR7e-β4 PR2b-β): Previously duplicated in
 * `embedding-backfill-child.ts` as a private constant. Unified here so both
 * the child-side slice and the Zod schema cap reference the same value.
 */
export const ERRORS_PAYLOAD_CAP = 100 as const;

// ============================================================================
// Parent → Child Messages
// ============================================================================

/**
 * Parent → Child: fork 開始時に child へ送信される初期メッセージ。
 *
 * Sent by parent immediately after fork() to start the backfill run.
 *
 * SEC H-2: `.strict()` で unknown-key 混入を reject する。
 *
 * ## v0.4.0 PR7e-β4 PR2b-α 拡張 / PR2b-α extension
 *
 * **TPA-H-2 反映**: `type: z.literal("backfill.run")` を追加し、shared
 * `runChildProcess` の TInitMessage 制約 (`{ type: string }` を要求) を満たす。
 * これにより orchestrator 側の `BackfillParentMessageT & { type: string }` hack
 * を除去できる。`kind` と `type` は同一値 (`"backfill.run"`) で、discriminated
 * union の分岐に使う `kind` と init-message discriminator の `type` を両方持つ。
 *
 * **TPA-H-2 reflected**: Adds `type: z.literal("backfill.run")` so that the
 * message satisfies the shared `runChildProcess` TInitMessage constraint
 * (`{ type: string }`). This eliminates the `BackfillParentMessageT & { type: string }`
 * hack in the orchestrator. `kind` and `type` share the same value
 * (`"backfill.run"`) — `kind` is used for discriminated-union branching while
 * `type` is the init-message discriminator.
 */
export const BackfillParentMessage = z
  .object({
    type: z.literal("backfill.run"),
    kind: z.literal("backfill.run"),
    jobId: z.string().min(1),
    webPageId: z.string().uuid(),
    /**
     * v0.4.0 PR7e-β4 PR2d (HIGH-β): All 7 categories supported. Backed by
     * the canonical SSOT (`EMBEDDING_BACKFILL_CATEGORIES`); add/remove
     * categories from the SSOT array only — IPC enum follows automatically.
     *
     * PR2d (HIGH-β): 7 全 category 対応。SSOT (`EMBEDDING_BACKFILL_CATEGORIES`)
     * を直接参照するため、追加/削除は SSOT 配列のみで完結する。
     */
    category: z.enum(EMBEDDING_BACKFILL_CATEGORIES),
    partsLimit: z.number().int().positive().max(BACKFILL_PARTS_LIMIT_MAX),
    startedAt: z.string().datetime(),
  })
  .strict();

/**
 * Parent → Child message type.
 *
 * 親 → 子 メッセージ型。
 */
export type BackfillParentMessageT = z.infer<typeof BackfillParentMessage>;

/**
 * Re-export the canonical SSOT category union so consumers of this IPC schema
 * (orchestrator / processors / contract test) can import the type from a single
 * stable location alongside the message types. Definition lives in
 * `apps/mcp-server/src/queues/embedding-backfill-queue.ts` (the only place
 * categories are added or removed).
 *
 * v0.4.0 PR7e-β4 PR2d (HIGH-β): SSOT category union を re-export し、IPC schema
 * 利用者 (orchestrator / processors / contract test) から本ファイル経由で
 * 型を取得可能にする。実体定義は `embedding-backfill-queue.ts` のみ。
 */
export type { EmbeddingBackfillCategory };

// ============================================================================
// Child → Parent Messages (discriminated union)
// ============================================================================

/**
 * Child → Parent: progress update (BullMQ `job.updateProgress` にブリッジ)。
 *
 * Progress update bridged to BullMQ `job.updateProgress`.
 */
export const BackfillProgressMessage = z
  .object({
    kind: z.literal("backfill.progress"),
    processedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Child → Parent: heartbeat (parent 側 watchdog reset 用)。
 *
 * Heartbeat resets the parent-side watchdog timer.
 */
export const BackfillHeartbeatMessage = z
  .object({
    kind: z.literal("backfill.heartbeat"),
    at: z.string().datetime(),
  })
  .strict();

/**
 * Child → Parent: done (終了時に送信、直後に child が exit(0))。
 *
 * Sent on successful completion, followed by child `exit(0)`.
 *
 * `skipReason` は `EmbeddingBackfillStatus=skipped_*` に相当する skip 理由を
 * 文字列で伝える optional フィールド (例: memory pressure / no-parts-remaining)。
 *
 * ## v0.4.0 PR7e-β4 PR2b-α 拡張 / PR2b-α extension (TPA-H-1 反映 / reflected)
 *
 * observability 対称性のため `failedCount` / `memorySkipCount` / `errors` を
 * optional で追加。fork 経路でも in-process 経路と同等の観測情報を
 * `JsAnimationProcessor` に戻すことで、`BackfillCategoryResult` の
 * `{ failed, memorySkips, errors }` が丸め込まれるリスクを防ぐ。
 *
 * Added optional `failedCount` / `memorySkipCount` / `errors` for observability
 * symmetry. The fork path now surfaces the same observability info as the
 * in-process path, preventing the `BackfillCategoryResult`
 * `{ failed, memorySkips, errors }` fields from being rounded away.
 *
 * - `failedCount`: child が検出した embedding 生成失敗数 / failed embedding count
 * - `memorySkipCount`: RSS 圧迫で skip した件数 / memory-pressure skip count
 * - `errors`: child が捕捉したエラーメッセージの先頭 100 件 (IPC payload bound) /
 *   first 100 error messages captured by child (IPC payload bound)
 */
export const BackfillDoneMessage = z
  .object({
    kind: z.literal("backfill.done"),
    processedCount: z.number().int().nonnegative(),
    skipReason: z.string().optional(),
    failedCount: z.number().int().nonnegative().optional(),
    memorySkipCount: z.number().int().nonnegative().optional(),
    // TDA-L-3 (v0.4.0 PR7e-β4 PR2b-β): Single source of truth — see
    // ERRORS_PAYLOAD_CAP above. Child-side slice truncation uses the same
    // constant to guarantee consistency between IPC emission and schema cap.
    errors: z.array(z.string()).max(ERRORS_PAYLOAD_CAP).optional(),
  })
  .strict();

/**
 * Child → Parent: error (child 側で sanitize 済みの message、parent は再 sanitize しない)。
 *
 * Error already sanitized on the child side; parent does NOT re-sanitize
 * (SEC M-2 idempotency policy).
 */
export const BackfillErrorMessage = z
  .object({
    kind: z.literal("backfill.error"),
    message: z.string(),
    code: z.string().optional(),
  })
  .strict();

/**
 * Child → Parent: discriminated union of all child messages.
 *
 * 子 → 親 メッセージの discriminated union。
 *
 * Zod の `discriminatedUnion` は runtime で `kind` フィールドのみで分岐するため
 * `safeParse` 失敗時 (unknown kind / unknown-key 混入) は明確な error path を返す。
 */
export const BackfillChildMessage = z.discriminatedUnion("kind", [
  BackfillProgressMessage,
  BackfillHeartbeatMessage,
  BackfillDoneMessage,
  BackfillErrorMessage,
]);

/**
 * Child → Parent message type (discriminated union).
 *
 * 子 → 親 メッセージ型 (discriminated union)。
 */
export type BackfillChildMessageT = z.infer<typeof BackfillChildMessage>;

/**
 * Individual child message types (for narrowed consumers).
 *
 * 個別 child メッセージ型 (narrowed 消費者用)。
 */
export type BackfillProgressMessageT = z.infer<typeof BackfillProgressMessage>;
export type BackfillHeartbeatMessageT = z.infer<typeof BackfillHeartbeatMessage>;
export type BackfillDoneMessageT = z.infer<typeof BackfillDoneMessage>;
export type BackfillErrorMessageT = z.infer<typeof BackfillErrorMessage>;
