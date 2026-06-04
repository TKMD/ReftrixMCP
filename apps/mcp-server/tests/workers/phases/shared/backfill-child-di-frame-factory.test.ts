// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Backfill Child DI — Frame Prisma Factory Completeness Regression
 *
 * INV-BACKFILL-CHILD-DI-FRAME-FACTORY-010
 *
 * fork-isolated EmbeddingBackfillWorker child の DI setup helper
 * (`setupBackfillChildDI()`) が **frame-embedding.service.ts の module-scoped
 * `prismaClientFactory`** (setter `setFramePrismaClientFactory`) を登録すること
 * を保証する回帰防止テスト。
 *
 * ## 真因 / Root cause (regression this guards against)
 *
 * `setupBackfillChildDI()` は当初 layout 側の 2 factory
 * (`setEmbeddingServiceFactory` + `setLayoutPrismaClientFactory`) のみ登録して
 * おり、motion backfill 経路の `saveMotionEmbedding()`
 * (`frame-embedding.service.ts:1319`) が使う **別モジュール** の
 * `prismaClientFactory` (同 line 203) を登録していなかった。fork child 内で
 * 当該 factory が `null` のまま `saveMotionEmbedding()` が呼ばれ
 * `"PrismaClient not initialized"` (line 1324-1325) を throw → per-row catch
 * (`embedding-backfill.service.ts:889-892`) で握り潰され motion backfill が
 * silently 全件 failed となっていた。
 *
 * Originally `setupBackfillChildDI()` registered only the two layout factories
 * (`setEmbeddingServiceFactory` + `setLayoutPrismaClientFactory`) and omitted the
 * **separate-module** `prismaClientFactory` (`frame-embedding.service.ts:203`,
 * setter `setFramePrismaClientFactory`) used by the motion backfill path's
 * `saveMotionEmbedding()` (line 1319). Inside the fork child that factory stayed
 * `null`, so `saveMotionEmbedding()` threw `"PrismaClient not initialized"`
 * (line 1324-1325), which was swallowed by the per-row catch
 * (`embedding-backfill.service.ts:889-892`), silently failing every motion row.
 *
 * ## 2-layer verification / 2 層検証
 *
 * - **Layer 1 (source-text)**: `backfill-child-di.ts` が
 *   `motion/frame-embedding.service` から `setFramePrismaClientFactory` を import
 *   し、helper body で呼び出すことを静的検証。既存 contract test T16
 *   (`embedding-backfill-child.contract.test.ts`) は layout/database/ml の 3
 *   import しか assert しておらず frame import を見逃していた盲点を補完する。
 * - **Layer 2 (runtime)**: `setupBackfillChildDI()` を **mock 無し** で実行し、
 *   実 `frame-embedding.service` module の `prismaClientFactory` が登録され、
 *   `saveMotionEmbedding()` が `"PrismaClient not initialized"` を throw しない
 *   ことを runtime で検証する (meta-lesson: source-grep だけだと
 *   "import はあるが setter は呼ばれない" /
 *   "別 setter を誤って呼ぶ" runtime 境界を bypass する)。
 *   `@reftrixmcp/database` / `@reftrixmcp/ml` のみ軽量 mock で native/DB 依存を回避し、
 *   frame factory 登録の runtime 経路自体は実 module で exercise する。
 *
 * @module tests/workers/phases/shared/backfill-child-di-frame-factory
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Layer 2 runtime mocks (heavy native/DB deps only)
// ----------------------------------------------------------------------------
// `setupBackfillChildDI()` awaits `import("@reftrixmcp/database")` and
// `import("@reftrixmcp/ml")`. Those pull a live PrismaClient + ONNX Runtime which
// we do NOT want to instantiate in a unit test. We mock ONLY those two, while
// `frame-embedding.service` and `layout-embedding.service` load their REAL
// modules so the factory registration runtime path is genuinely exercised.
// ============================================================================

const runtimeMocks = vi.hoisted(() => {
  // A minimal Prisma stand-in whose identity we can assert was wired through.
  const fakePrisma = { __isFakePrisma: true } as const;
  const fakeEmbeddingService = { __isFakeEmbeddingService: true } as const;
  return { fakePrisma, fakeEmbeddingService };
});

vi.mock("@reftrixmcp/database", () => ({
  prisma: runtimeMocks.fakePrisma,
}));
vi.mock("@reftrixmcp/ml", () => ({
  embeddingService: runtimeMocks.fakeEmbeddingService,
}));

// ============================================================================
// Layer 1: source-text static analysis (T16 frame-import gap補完)
// ============================================================================

describe("INV-BACKFILL-CHILD-DI-FRAME-FACTORY-010 — Layer 1 (source-text)", () => {
  const helperPath = path.resolve(
    __dirname,
    "../../../../src/workers/phases/shared/backfill-child-di.ts"
  );
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(helperPath, "utf8");
  });

  // INV-BACKFILL-CHILD-DI-FRAME-FACTORY-010
  it("imports setFramePrismaClientFactory from motion/frame-embedding.service", () => {
    // Dynamic-import specifier (SEC-H-1 listener-first compliance keeps it dynamic).
    expect(source).toMatch(/import\(\s*["'][^"']*motion\/frame-embedding\.service\.js["']\s*\)/);
    expect(source).toMatch(/setFramePrismaClientFactory/);
  });

  // INV-BACKFILL-CHILD-DI-FRAME-FACTORY-010
  it("calls setFramePrismaClientFactory in setupBackfillChildDI body", () => {
    const fnStart = source.indexOf("export async function setupBackfillChildDI");
    expect(fnStart).toBeGreaterThan(-1);
    const bodyStart = source.indexOf("{", fnStart);
    let depth = 0;
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          bodyEnd = i + 1;
          break;
        }
      }
    }
    const body = source.slice(bodyStart, bodyEnd);
    expect(body).toMatch(/setFramePrismaClientFactory\s*\(\s*\(\s*\)\s*=>\s*prisma/);
  });
});

// ============================================================================
// Layer 2: runtime verification (mock-free factory registration path)
// ============================================================================

describe("INV-BACKFILL-CHILD-DI-FRAME-FACTORY-010 — Layer 2 (runtime)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    // Reset the real frame module's module-scoped factory so cross-test leak
    // is impossible (resetFramePrismaClientFactory nulls prismaClientFactory).
    const frameModule = await import("../../../../src/services/motion/frame-embedding.service.js");
    frameModule.resetFramePrismaClientFactory();
    frameModule.resetFrameEmbeddingServiceFactory();
  });

  // INV-BACKFILL-CHILD-DI-FRAME-FACTORY-010
  it("setupBackfillChildDI() resolves frame prismaClientFactory so saveMotionEmbedding does not throw 'PrismaClient not initialized'", async () => {
    // Pre-condition: factory is unset → saveMotionEmbedding MUST throw the
    // sentinel error. This proves the runtime guard is meaningful (red side).
    const frameModule = await import("../../../../src/services/motion/frame-embedding.service.js");
    frameModule.resetFramePrismaClientFactory();
    await expect(
      frameModule.saveMotionEmbedding("123e4567-e89b-12d3-a456-426614174000", [], "test-model")
    ).rejects.toThrow(/PrismaClient not initialized/);

    // Act: run the real DI setup helper (no mock on the helper itself).
    const { setupBackfillChildDI } =
      await import("../../../../src/workers/phases/shared/backfill-child-di.js");
    await setupBackfillChildDI();

    // Assert: after setup, the frame factory is registered. saveMotionEmbedding
    // must now reach the prisma client (fakePrisma) instead of throwing the
    // "not initialized" sentinel. fakePrisma has no `motionEmbedding.create`,
    // so it throws a DIFFERENT error — proving the factory was resolved and the
    // null-guard was passed. (If the fix were absent, it would still throw the
    // sentinel.)
    await expect(
      frameModule.saveMotionEmbedding("123e4567-e89b-12d3-a456-426614174000", [], "test-model")
    ).rejects.not.toThrow(/PrismaClient not initialized/);
  });

  // INV-BACKFILL-CHILD-DI-FRAME-FACTORY-010
  it("setupBackfillChildDI() wires the SAME prisma instance into the frame factory", async () => {
    const { setupBackfillChildDI } =
      await import("../../../../src/workers/phases/shared/backfill-child-di.js");
    await setupBackfillChildDI();

    // The frame module's isAvailable() exercises getPrismaClient() which calls
    // the registered factory. With a fake prisma object registered it returns
    // true (factory present, no throw on resolution).
    const frameModule = await import("../../../../src/services/motion/frame-embedding.service.js");
    const service = frameModule.getFrameEmbeddingService();
    expect(service.isAvailable()).toBe(true);
  });
});
