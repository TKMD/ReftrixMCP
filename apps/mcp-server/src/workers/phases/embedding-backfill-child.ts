// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Child Process Entry (v0.4.0 PR7e-β4 PR2d)
 *
 * `child_process.fork()` で起動される EmbeddingBackfillWorker の子プロセス
 * エントリポイント。ADR-0015 Decision #1 + Amendment 8 に従い、ONNX Runtime
 * の e5-base 推論を child process 内で実行することで glibc malloc sbrk heap
 * 断片化を回避し、child `exit(0)` 時に OS が全メモリを回収する (Phase 5 fork
 * と同じ pattern)。
 *
 * Child-process entry invoked by `child_process.fork()` for the
 * EmbeddingBackfillWorker. Per ADR-0015 Decision #1 + Amendment 8, ONNX
 * Runtime (e5-base) runs inside the child so that OS memory reclamation on
 * `exit(0)` fully recovers glibc malloc sbrk heap fragmentation (same pattern
 * as Phase 5 fork).
 *
 * ## 設計方針 / Design (PR2d §4 D1, SEC-H-1 + SEC-H-2 + TPA-H-1 + TPA-H-2)
 *
 * 1. **DRY 再利用 (§4 D1)**: 既存 service-layer wrapper (`backfillXxxForPage`)
 *    を category dispatch switch 経由で再利用し、独自 backfill logic は実装
 *    しない。IPC layer は薄い wrapper。
 *    DRY reuse — dispatches to existing per-category service wrappers
 *    (`backfillXxxForPage`) via switch; no backfill logic of its own.
 * 2. **Listener-first ordering (SEC-H-1)**: `process.on("message")` を import 文
 *    直後の最上行で登録し、重い service-layer import は dynamic import で遅延。
 *    これによりロード中にも SIGTERM / parent disconnect / invalid message を
 *    確実に捕捉する。
 *    The message listener is registered immediately after imports, before any
 *    heavy dynamic import, so SIGTERM / parent disconnect / invalid messages
 *    are caught even while heavy modules are loading.
 * 3. **Double-send 防止 (SEC-H-2)**: `alreadyReported` flag と `reportAndExit()`
 *    集約で uncaughtException / unhandledRejection の二重送信を防止。
 *    `alreadyReported` + centralized `reportAndExit()` prevents double IPC sends
 *    from overlapping uncaughtException / unhandledRejection handlers.
 * 4. **Observability 対称性 (TPA-H-1)**: `backfill.done` IPC で `failedCount`
 *    / `memorySkipCount` / `errors` を送信し、in-process 経路と同等の観測情報を
 *    orchestrator に戻す。
 *    Emits `failedCount` / `memorySkipCount` / `errors` on `backfill.done` to
 *    match in-process observability.
 * 5. **Type discriminator (TPA-H-2)**: `BackfillParentMessage` schema に `type`
 *    が含まれるため shared `runChildProcess` の TInitMessage 制約を満たす。
 *    `BackfillParentMessage` includes `type` per schema, satisfying the shared
 *    `runChildProcess` TInitMessage constraint.
 * 6. **Category dispatch switch (PR2d HIGH-β)**: `runBackfill` 内部で `params.
 *    category` に基づき 7 category service wrapper のいずれかへ routing する。
 *    `dispatchBackfillByCategory()` で抽出し exhaustive `never` check (TDA
 *    MEDIUM-1) でコンパイル時に全経路網羅を保証。新 category 追加時は
 *    `EMBEDDING_BACKFILL_CATEGORIES` 配列追加 → 本 switch に case 追加で完結。
 *    Internal `dispatchBackfillByCategory()` switch routes by `params.category`
 *    to one of 7 category service wrappers. Exhaustive `never` check (TDA
 *    MEDIUM-1) compile-time-asserts coverage of all branches.
 * 7. **DI factory helper (PR2d HIGH-α / TDA-HIGH-1)**: `setupBackfillChildDI()`
 *    helper (`shared/backfill-child-di.ts`) を呼ぶことで全 7 category child で
 *    DI factory 設定を共通化。PR2c 以前は本 child 内に 54 LOC インライン化
 *    されていた処理を helper 1 行に置換。
 *    `setupBackfillChildDI()` (`shared/backfill-child-di.ts`) consolidates DI
 *    factory setup across all 7 category children. Replaces the 54-LOC inline
 *    setup that PR2c added directly into this child file.
 *
 * ## 非目標 (PR2d) / Out of scope in PR2d
 *
 * - `EMBEDDING_BACKFILL_FORK_ENABLED` の default 切替は別 commit
 *   (`PR2d-switchover`) で実施。本 PR は default `false` 維持。
 *   Default flag switch is a separate `PR2d-switchover` commit; this PR keeps
 *   `EMBEDDING_BACKFILL_FORK_ENABLED=false` as the default.
 *
 * @module workers/phases/embedding-backfill-child
 */

// ---- Lightweight imports only (listener registration top) ----
// ---- 軽量 import のみ (listener を最上行に登録) ----
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { truncateId } from "../../utils/truncate-id";
import {
  BackfillParentMessage,
  ERRORS_PAYLOAD_CAP,
  type BackfillParentMessageT,
  type BackfillChildMessageT,
} from "./embedding-backfill-ipc";

// ============================================================================
// Constants
// ============================================================================

/**
 * Heartbeat IPC interval (ms).
 *
 * Heartbeat IPC 送信間隔 (ms)。parent 側 watchdog (`PHASE5_HEARTBEAT_TIMEOUT_MS`
 * と同等の 60s 系) の半分を目処に 30s を採用。
 *
 * v0.4.0 PR7e-β4 PR2b-β (TDA-M-2 反映): 本定数は `embedding-backfill-fork-
 * orchestrator.ts::BACKFILL_EXTEND_LOCK_INTERVAL_MS` と意味論的に独立
 * (BullMQ lock renew vs parent watchdog reset) だが、30s 一致を運用ベースライン
 * とする。変更時は対向側との整合を確認すること。
 *
 * TDA-M-2 (v0.4.0 PR7e-β4 PR2b-β): This constant is semantically independent
 * from `BACKFILL_EXTEND_LOCK_INTERVAL_MS` in the fork orchestrator (BullMQ
 * lock renew vs parent watchdog reset) but MUST remain 30s as the operational
 * baseline. Verify counterpart alignment when modifying.
 *
 * v0.4.0 PR7e-β4 PR2b-β (TDA-L-3 反映): `ERRORS_PAYLOAD_CAP` は
 * `embedding-backfill-ipc.ts` に集約済 (single source of truth)。
 */
const HEARTBEAT_INTERVAL_MS = 30_000 as const;

// ============================================================================
// State (module-scoped)
// ============================================================================

/**
 * SEC-H-2: Prevent double-report when multiple global handlers
 * (uncaughtException / unhandledRejection / runBackfill catch) fire in sequence.
 *
 * SEC-H-2: uncaughtException / unhandledRejection / runBackfill catch が連続
 * 発火したときの二重送信を防止する。
 */
let alreadyReported = false;

// ============================================================================
// IPC helpers
// ============================================================================

/**
 * Send an IPC message to parent. Silently no-op if parent has disconnected —
 * the child will eventually be killed via SIGTERM/SIGKILL by the orchestrator's
 * AbortSignal escalation.
 *
 * parent へ IPC 送信。parent 切断時は無音。最終的に orchestrator の
 * AbortSignal escalation で SIGTERM/SIGKILL を受ける。
 */
function sendToParent(msg: BackfillChildMessageT): void {
  try {
    if (process.connected && process.send) {
      process.send(msg);
    }
  } catch {
    // Parent may have exited; child will eventually timeout.
    // 親プロセスが終了している可能性あり。子プロセスは最終的に timeout。
  }
}

/**
 * Sanitize and report an error to parent, then exit(1). Idempotent — repeated
 * calls are ignored (SEC-H-2 alreadyReported gate).
 *
 * error を sanitize して parent へ report 後 exit(1)。`alreadyReported` flag
 * により冪等。
 */
function reportAndExit(err: unknown): void {
  if (alreadyReported) return;
  alreadyReported = true;
  sendToParent({ kind: "backfill.error", message: sanitizeErrorMessage(err) });
  process.exit(1);
}

// ============================================================================
// SEC-H-1: Listener MUST be registered FIRST, before heavy imports
// ============================================================================

/**
 * SEC-H-1: Register the IPC message listener at the very top of module
 * evaluation — before any heavy import (`backfillJsAnimationsForPage`) — so the
 * child can respond to SIGTERM, parent disconnect, or malformed init messages
 * even while heavier modules are being loaded.
 *
 * SEC-H-1: IPC listener を module 評価の最上行で登録。重い
 * `backfillJsAnimationsForPage` の import より前に実行されるため、ロード中でも
 * SIGTERM / parent disconnect / 不正 init message に反応可能。
 */
process.on("message", (raw: unknown) => {
  const parsed = BackfillParentMessage.safeParse(raw);
  if (!parsed.success) {
    sendToParent({
      kind: "backfill.error",
      message: "Invalid parent message shape (strict parse failed)",
    });
    process.exit(1);
    return;
  }
  const params = parsed.data;
  void runBackfill(params).catch((error: unknown) => {
    logger.warn("[BackfillChild] runBackfill failed", {
      webPageId: truncateId(params.webPageId),
      category: params.category,
      error: sanitizeErrorMessage(error),
    });
    reportAndExit(error);
  });
});

// SEC-H-2: Route global handlers through the centralized reportAndExit() so the
// `alreadyReported` gate prevents double IPC sends.
//
// SEC-H-2: 両 global handler を `reportAndExit` に集約し、`alreadyReported` で
// 二重送信を防止。
process.on("uncaughtException", reportAndExit);
process.on("unhandledRejection", reportAndExit);

// ============================================================================
// Heavy work deferred until init message received
// ============================================================================

/**
 * Common shape of every per-category service wrapper return value.
 *
 * 全 category service wrapper の共通戻り値 shape (PerCategoryBackfillResult
 * の dispatch 経路で扱う minimum subset)。
 */
interface BackfillCategoryResultMinimum {
  generated: number;
  failed?: number;
  memorySkips?: number;
  errors?: string[];
}

/**
 * Common signature of every per-category service wrapper invoked from the
 * dispatch switch. Mirrors the shape exposed by
 * `apps/mcp-server/src/services/embedding-backfill.service.ts` for
 * `backfill{Part,SectionVisual,Motion,Background,JsAnimations,Responsive}For
 * Page` and `backfillPartTextForPage`.
 *
 * dispatch switch から呼ばれる service wrapper の共通 signature。
 */
type CategoryServiceWrapper = (
  webPageId: string,
  options?: {
    partsLimit?: number;
    onProgress?: (type: string, done: number, total: number) => void;
  }
) => Promise<BackfillCategoryResultMinimum>;

/**
 * v0.4.0 PR7e-β4 PR2d (HIGH-β + TDA-MEDIUM-1): Category-aware dispatch switch.
 *
 * `params.category` に基づき 7 category service wrapper のいずれかへ routing
 * する。dispatch 専用関数として抽出することで `runBackfill` 本体の cyclomatic
 * complexity を < 10 に維持し、TDA MEDIUM-1 を満足する。
 *
 * 各 case の routing 先は `apps/mcp-server/src/services/embedding-backfill.
 * service.ts` の per-category wrapper:
 *   - `part_text` → `backfillPartTextForPage`
 *   - `part_visual` → `backfillPartVisualsForPage` (注: PR2d 時点では service
 *     layer に未実装。下記 `case "part_visual"` で実装ギャップを ADR-0015
 *     Amendment 8 LCC-M-2 経由で記録。fork 経路では現状 in-process fallback
 *     される (processViaFork catch 経路))
 *   - `section_visual` → `backfillSectionVisualsForPage`
 *   - `motion` → `backfillMotionsForPage`
 *   - `background` → `backfillBackgroundsForPage`
 *   - `js_animation` → `backfillJsAnimationsForPage`
 *   - `responsive` → `backfillResponsiveForPage`
 *
 * Exhaustive check: `default` branch assigns `params.category` to a `never`-typed
 * variable so adding a new SSOT category that is not handled here triggers a
 * compile-time TS error.
 *
 * Exhaustive check: `default` 句で `never` 代入することで SSOT 追加忘れを
 * compile time に検出する (TDA MEDIUM-1)。
 */
async function dispatchBackfillByCategory(
  params: BackfillParentMessageT,
  options: { onProgress: (type: string, done: number, total: number) => void }
): Promise<BackfillCategoryResultMinimum> {
  // SEC-H-1: Dynamic import keeps the listener registration at the top of
  // module evaluation. NodeNext moduleResolution requires `.js` suffix for
  // compiled output.
  //
  // SEC-H-1: dynamic import で listener 登録を最上行に保つ。NodeNext のため
  // `.js` 拡張子を明示する (compiled output を参照)。
  const serviceModule = await import("../../services/embedding-backfill.service.js");

  switch (params.category) {
    case "part_text": {
      const fn: CategoryServiceWrapper = serviceModule.backfillPartTextForPage;
      return fn(params.webPageId, {
        partsLimit: params.partsLimit,
        onProgress: options.onProgress,
      });
    }
    case "section_visual": {
      const fn: CategoryServiceWrapper = serviceModule.backfillSectionVisualsForPage;
      return fn(params.webPageId, {
        partsLimit: params.partsLimit,
        onProgress: options.onProgress,
      });
    }
    case "motion": {
      const fn: CategoryServiceWrapper = serviceModule.backfillMotionsForPage;
      return fn(params.webPageId, {
        partsLimit: params.partsLimit,
        onProgress: options.onProgress,
      });
    }
    case "background": {
      const fn: CategoryServiceWrapper = serviceModule.backfillBackgroundsForPage;
      return fn(params.webPageId, {
        partsLimit: params.partsLimit,
        onProgress: options.onProgress,
      });
    }
    case "js_animation": {
      // TPA-H-1 (PR2b-β audit) — preserve `partsLimit` so the fork path
      // respects the ADR-0007 head-100 contract.
      // TPA-H-1: `partsLimit` を service 層に伝達し ADR-0007 head-100 契約を
      // fork 経路でも遵守する。
      const fn: CategoryServiceWrapper = serviceModule.backfillJsAnimationsForPage;
      return fn(params.webPageId, {
        partsLimit: params.partsLimit,
        onProgress: options.onProgress,
      });
    }
    case "responsive": {
      const fn: CategoryServiceWrapper = serviceModule.backfillResponsiveForPage;
      return fn(params.webPageId, {
        partsLimit: params.partsLimit,
        onProgress: options.onProgress,
      });
    }
    case "part_visual": {
      // v0.4.0 PR7e-β4 PR2d (LCC-M-2 known gap): The `part_visual` category
      // requires the heavy `runVisualEmbeddingSubPhases` flow (DINOv2 +
      // Playwright bbox resolution) currently driven from the in-process
      // `PartVisualProcessor` (`embedding-backfill-processors.ts`). A native
      // service-layer `backfillPartVisualsForPage(webPageId, options)` does not
      // yet exist. Until PR3b ships that wrapper, the fork orchestrator handles
      // `part_visual` via the in-process catch-fallback (SEC-M-3 path) — this
      // child throws so the orchestrator triggers the documented fallback.
      //
      // PR2d (LCC-M-2 既知ギャップ): `part_visual` は `runVisualEmbeddingSub
      // Phases` (DINOv2 + Playwright bbox) を必要とし、現状 in-process
      // `PartVisualProcessor` に閉じている。service layer `backfillPartVisuals
      // ForPage` 未実装のため、fork 経路は in-process fallback (SEC-M-3) に
      // 委譲する。本 child は明示的に throw して orchestrator の catch-
      // fallback 経路に乗せる。PR3b で service wrapper を実装し本 case を
      // 通常 dispatch に統合予定。
      throw new Error(
        "part_visual fork path requires service-layer wrapper (PR3b); falling back to in-process per ADR-0015 Amendment 8 LCC-M-2"
      );
    }
    default: {
      // Exhaustive check (TDA MEDIUM-1): adding a new SSOT category without a
      // case here triggers a compile-time TS error.
      // Exhaustive check (TDA MEDIUM-1): SSOT 追加忘れをコンパイル時に検出。
      const _exhaustive: never = params.category;
      throw new Error(`Unhandled backfill category: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Run the backfill via the appropriate per-category service. All heavy work
 * (ONNX Runtime init, Prisma query, embedding persistence) lives inside the
 * dispatched service wrapper. This function is an IPC wrapper only.
 *
 * 既存 service wrapper を経由して backfill を実行。ONNX Runtime 初期化・
 * Prisma クエリ・embedding 永続化は service wrapper 内部で行われ、本関数は
 * IPC wrapper に徹する。
 */
async function runBackfill(params: BackfillParentMessageT): Promise<void> {
  // ==========================================================================
  // PR2d (HIGH-α + TDA-HIGH-1): DI factory setup helper
  // ==========================================================================
  //
  // PR2c (Amendment 7) で本 child にインライン化されていた DI factory setup
  // (54 LOC) を `setupBackfillChildDI()` helper に切り出し済 (PR2d HIGH-α)。
  // 本 helper 経由で全 7 category child が同一 setup logic を共有し、新
  // category 追加時の DI 欠落 regression を構造的に防ぐ (PR2c canary 82/82
  // 件失敗の root cause だった factory 欠落の再発防止)。
  //
  // PR2d (HIGH-α + TDA-HIGH-1): The 54-LOC inline DI factory setup added in
  // PR2c (Amendment 7) is now factored into `setupBackfillChildDI()`. All 7
  // category children share the same setup, structurally preventing the kind
  // of DI omission that caused the PR2c canary 82/82 failure.
  //
  // SEC-H-1 compliance: helper internally batches 3 dynamic imports via
  // `Promise.all` (single microtask tick), preserving listener-first ordering.
  //
  // SEC-H-1 遵守: helper 内部で 3 module を `Promise.all` で並列 dynamic
  // import し microtask tick 1 回分に集約 (listener-first ordering 維持)。
  const { setupBackfillChildDI } = await import("./shared/backfill-child-di.js");
  await setupBackfillChildDI();

  const heartbeat = setInterval(() => {
    sendToParent({ kind: "backfill.heartbeat", at: new Date().toISOString() });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === "function") {
    heartbeat.unref();
  }

  try {
    const result = await dispatchBackfillByCategory(params, {
      onProgress: (_type: string, done: number, total: number) => {
        sendToParent({
          kind: "backfill.progress",
          processedCount: done,
          totalCount: total,
        });
      },
    });

    // TPA-H-1: Surface failed / memorySkips / errors so the orchestrator can
    // propagate them to `BackfillCategoryResult` — keeping fork observability
    // symmetric with the in-process path.
    //
    // TPA-H-1: failed / memorySkips / errors を露出し、orchestrator 経由で
    // `BackfillCategoryResult` に伝搬させる (fork 経路を in-process と対称化)。
    //
    // SEC-M-1 (CWE-209): service layer may push raw `error.message` into
    // `result.errors`. Sanitize each entry before IPC emission so Prisma error
    // codes, connection string fragments, table/column names, and ORT stack
    // text cannot leak to the parent process (and downstream logs / BullMQ job
    // state).
    //
    // SEC-M-1 (CWE-209): service 層で raw `error.message` が
    // `result.errors` に push されうる。Prisma error code / connection
    // string / table・column 名 / ORT stack が parent プロセス (および下流
    // ログ / BullMQ job state) に漏出しないよう、IPC 送信前に各要素を
    // サニタイズする。
    //
    // PII-protection invariant (LCC-H-1, ADR-0015 Amendment 8): every error
    // payload that crosses the IPC boundary MUST pass through
    // `sanitizeErrorMessage`, mirroring Amendment 7's PII pattern. New
    // categories added via the dispatch switch automatically inherit this
    // invariant because all routes funnel through this single emission point.
    //
    // PII 保護不変条件 (LCC-H-1, ADR-0015 Amendment 8): IPC 境界を越える
    // 全 error payload は `sanitizeErrorMessage` 経由で送信する。本 emission
    // 点 1 箇所に集約されているため、新 category 追加時も自動的に同 invariant
    // を継承する。
    sendToParent({
      kind: "backfill.done",
      processedCount: result.generated,
      failedCount: result.failed ?? 0,
      memorySkipCount: result.memorySkips ?? 0,
      errors: (result.errors ?? [])
        .slice(0, ERRORS_PAYLOAD_CAP)
        .map((e) => sanitizeErrorMessage(new Error(e))),
    });
    process.exit(0);
  } finally {
    clearInterval(heartbeat);
  }
}
