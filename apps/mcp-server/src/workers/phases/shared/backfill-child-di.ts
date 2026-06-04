// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backfill Child DI Setup Helper (v0.4.0 PR7e-β4 PR2d)
 *
 * `child_process.fork()` で起動された EmbeddingBackfillWorker child の DI factory
 * 登録を集約するヘルパー。PR2c (Amendment 7) で `embedding-backfill-child.ts` に
 * インライン化されていた DI factory setup (54 LOC) を本ヘルパーに切り出し、
 * 全 7 category child (PR2d で fork 化対象) で再利用可能にする。
 *
 * Helper that consolidates DI factory registration for fork-isolated
 * EmbeddingBackfillWorker children. Extracts the inline DI setup (54 LOC) added
 * to `embedding-backfill-child.ts` in PR2c (Amendment 7) so that **all 7
 * categories** of fork child reuse the same setup logic in PR2d.
 *
 * ## 設計判断 / Design (PR2d §4 D3, TDA-HIGH-1 + SEC-H-2)
 *
 * - **3-factory set (motion backfill DI fix で frame factory 追加)**: 4 面計画
 *   監査の当初の TDA verification では layout 系の 2 factory
 *   (`setEmbeddingServiceFactory` + `setLayoutPrismaClientFactory`) のみで十分と
 *   されていたが、motion backfill (`saveMotionEmbedding`) は frame-embedding
 *   .service.ts 自身の module-scoped `prismaClientFactory` を使うため、その
 *   `setFramePrismaClientFactory` が未登録だと motion backfill child が DB save
 *   時に factory 未設定で失敗していた (defect A)。これを closure するため
 *   `setFramePrismaClientFactory` を追加し、本 helper は **3 factory** を登録する。
 *   SEC が指摘した「category 別 select + exhaustive check」は **DRY 違反** と
 *   なるため不採用 (Amendment 8 LCC-H-1 precedent: Phase 5 child の `setupDI()` も
 *   category 引数なしの単一関数)。
 *   The initial 4-face plan-audit TDA verification deemed the 2 layout factories
 *   (`setEmbeddingServiceFactory` + `setLayoutPrismaClientFactory`) sufficient,
 *   but motion backfill (`saveMotionEmbedding`) uses frame-embedding.service.ts's
 *   own module-scoped `prismaClientFactory`; without registering its
 *   `setFramePrismaClientFactory` the motion backfill child failed at DB save with
 *   an unset factory (defect A). To close this, `setFramePrismaClientFactory` is
 *   added and this helper registers **3 factories**. The SEC-suggested
 *   category-aware switch is rejected as a DRY violation; mirrors the
 *   single-function pattern of Phase 5 child `setupDI()` (Amendment 8 LCC-H-1).
 *
 * - **SEC-H-1 listener-first ordering preserved**: 本ヘルパー自体は listener
 *   登録より後で呼ばれることを前提とし、内部で `Promise.all` 並列 dynamic
 *   import を行う (microtask tick 1 回分に集約)。caller (child entry) は本
 *   helper を `runBackfill()` 内で `await` 経由で呼ぶ責務を持つ。
 *   This helper assumes it is called *after* listener registration (caller
 *   responsibility). Internally batches 4 dynamic imports via `Promise.all`,
 *   collapsing the microtask cost to a single tick.
 *
 * - **Idempotent**: 同一 child process 内で複数回呼ばれても factory state が
 *   上書きされるだけで side-effect は等価 (`setXxxFactory` は LayoutEmbedding
 *   Service の module-scoped variable を update するだけ)。
 *   Idempotent — repeated calls only overwrite factory state with the same
 *   value (factories are module-scoped variables in LayoutEmbeddingService).
 *
 * @module workers/phases/shared/backfill-child-di
 */

/**
 * Set up DI factories required by every embedding backfill child.
 *
 * 全 embedding backfill child で必須となる DI factory を登録する。
 *
 * ## 登録対象 / Registered factories
 *
 * 1. `setEmbeddingServiceFactory(() => mlEmbeddingService)`
 *    — LayoutEmbeddingService から e5-base 推論を駆動するための EmbeddingService。
 * 2. `setPrismaClientFactory(() => prisma)` (alias: `setLayoutPrismaClientFactory`)
 *    — LayoutEmbeddingService の DB save 経路で使う Prisma client。
 * 3. `setFramePrismaClientFactory(() => prisma)`
 *    — frame-embedding.service.ts の `saveMotionEmbedding` DB save 経路で使う
 *    Prisma client (layout 側とは別モジュールの module-scoped factory、motion
 *    backfill DI fix / defect A で追加)。
 *
 * ## SEC-H-1 compliance
 *
 * 本関数内で 4 module を `Promise.all` で並列 dynamic import する。これにより
 * caller 側 (`embedding-backfill-child.ts::runBackfill`) は単一 `await` のみで
 * setup を完了でき、SEC-H-1 listener-first ordering を維持しつつ `vitest`
 * fake-timer environment 下での microtask budget 消費を最小化する (PR2c canary
 * hotfix で実証済の pattern)。
 *
 * Performs concurrent `Promise.all` dynamic import of the 4 target modules so
 * the caller awaits a single microtask tick. Maintains SEC-H-1 listener-first
 * ordering and keeps the vitest fake-timer microtask budget intact (proven
 * pattern from the PR2c canary hotfix).
 *
 * @returns Promise<void> — resolves once all 3 factories are registered
 */
export async function setupBackfillChildDI(): Promise<void> {
  const [layoutModule, databaseModule, mlModule, frameModule] = await Promise.all([
    import("../../../services/layout-embedding.service.js"),
    import("@reftrixmcp/database"),
    import("@reftrixmcp/ml"),
    import("../../../services/motion/frame-embedding.service.js"),
  ]);
  const { setEmbeddingServiceFactory, setPrismaClientFactory: setLayoutPrismaClientFactory } =
    layoutModule;
  const { prisma } = databaseModule;
  const { embeddingService: mlEmbeddingService } = mlModule;
  const { setFramePrismaClientFactory } = frameModule;
  setEmbeddingServiceFactory(() => mlEmbeddingService);
  setLayoutPrismaClientFactory(() => prisma as never);
  // motion backfill の saveMotionEmbedding は frame-embedding.service.ts 自身の
  // module-scoped prismaClientFactory を使うため、別途登録が必要 (layout 側とは別モジュール)。
  setFramePrismaClientFactory(() => prisma as never);
}
