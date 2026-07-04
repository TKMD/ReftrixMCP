// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-CROP-RETENTION-001
 * (Crop retention = "until data.delete" — GDPR Art.17 crop-dir cascade parity
 *  with the screenshot H-1 inline fallback contract)
 *
 * INV-CROP-RETENTION-001 (W6 Issue A PR-3b, ADR-0044 §Decision 4 / ADR-0041
 *   §Amendment Crop Retention Parity / Registry F-03/F-06/F-07/F-08/F-12/F-13):
 *   crop の保持 trigger-event は `data.delete` のみ。`CROP_PERSISTENCE_ENABLED`
 *   を ON にすると `<root>/crops/<webPageId>/<kind>-<entityId>.png` が disk に
 *   生成されるため、single (`deletePage`) と batch (`deleteAllUserData`) の両
 *   削除経路が crop dir を best-effort で unlink し、第三者 visual-PII が永久
 *   残存しないことを保証する (Art.17 fail-closed)。さらに crop cascade は DI
 *   factory 配線に依存しない (cascade は `resolveCropRoot()` env-only 依存ゆえ
 *   構造的に factory non-dependent = screenshot H-1 inline fallback と同等の
 *   配線非依存性)。
 *
 * INV-CROP-RETENTION-001: the crop retention trigger event is `data.delete`
 *   only; with `CROP_PERSISTENCE_ENABLED` ON, crop files appear on disk at
 *   `<root>/crops/<webPageId>/<kind>-<entityId>.png`, so BOTH the single
 *   (`deletePage`) AND batch (`deleteAllUserData`) deletion paths best-effort
 *   unlink the crop dir, ensuring third-party visual-PII never persists
 *   (Art.17 fail-closed). The crop cascade does not depend on DI factory wiring
 *   (it depends only on `resolveCropRoot()` env, structurally factory-independent
 *   — equivalent wiring-independence to the screenshot H-1 inline fallback).
 *
 * Assertions:
 *   #1  single path (factory-unwired): deletePage → 事前配置 crop file が FS 消滅
 *       + web_pages 行削除 (real-DB + real-FS, F-03 #1).
 *   #2  batch path (factory-unwired): deleteAllUserData で複数ページ crop dir が
 *       全消滅 (real-DB + real-FS, F-03 #2).
 *   #3  orphan reconcile / 冪等 re-run: partial-failure 状態から `data.delete`
 *       冪等 re-run で残存 crop が回収される (`fs.rm force:true` recursive 冪等,
 *       EDPB 2025 CEF Report on the right to erasure (Art.17, Feb 2026)
 *       "verify that erasure has been carried out and be able to demonstrate
 *       such erasure" parity, F-12 #3).
 *   #4  3s SLA: `data.delete` (crop unlink 込) が **絶対 3000ms** 内 (SLA_WITHIN_MS
 *       SSOT import, performance.now() delta, F-08 #4).
 *   #5  negative: `data.delete` 後 crop root 配下に当該 webPageId crop file 0件
 *       (real-FS glob, F-03 #5).
 *   #6  negative traversal: non-UUID webPageId (`../sibling`, null-byte) を
 *       `buildSafeCropDir` に渡すと throw し `fs.rm` 到達せず (F-06 defense-in-depth).
 *
 * F-07 (lstatSync symlink-escape TOCTOU): accepted-risk。`buildSafeCropDir` は
 *   `buildSafePathWithinRoot` (lexical 検証) 経由で per-page dir を返し、crop dir は
 *   `saveCropFromBuffer` が `fs.mkdir mode:0o700` で real-dir のみ生成する (symlink
 *   非生成) + root owner-0o700 ゆえ live exploit なし。defense-in-depth な lstatSync
 *   再 check は将来 PR (docs note のみ、本 INV では未 assert)。
 *
 * Sandbox 制約 (ADR-0041 D-1a / Registry F-13): FS 操作は `os.tmpdir()` 配下
 *   sandbox root を REFTRIX_SCREENSHOT_ROOT 注入で使用 (crop root = `<root>/crops`
 *   derive)。production default root への mkdir/rmSync を一切行わない。`resolvedRootCache`
 *   は raw-input keyed ゆえ env を resolve 前に set + test 間で clear。afterAll で
 *   production default root 非作成・非削除を assert。
 *
 * @see  §Decision 4
 * @see  §Amendment Crop Retention Parity
 * @see apps/mcp-server/src/services/gdpr-deletion.service.ts (deleteCropDirBestEffort)
 * @see apps/mcp-server/src/services/part/crop-persistence.helper.ts (buildSafeCropDir)
 * @see apps/mcp-server/tests/regression/standing/gdpr-delete/inv-data-delete-002-core.test.ts (SLA_WITHIN_MS SSOT)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import { PrismaClient } from "@prisma/client";

import { assertInvName } from "../_setup/inv-assert";
import {
  createTestPrismaClient,
  ensureSchemaAppliedOnce,
  seedGdprFixture,
  truncateGdprDomainTables,
  type GdprFixtureIds,
} from "../_setup/gdpr-test-fixtures";
import {
  dataDeleteHandler,
  setDataDeleteServiceFactory,
  resetDataDeleteServiceFactory,
} from "../../../../src/tools/data/data.tool";
import {
  GdprDeletionService,
  setGdprPrismaClientFactory,
  resetGdprPrismaClientFactory,
  resetGdprScreenshotPersistenceFactory,
  resetGdprDeletionService,
  type GdprPrismaClient,
} from "../../../../src/services/gdpr-deletion.service";
import {
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../../../src/services/audit-log.service";
import { clearResolvedRootCache } from "../../../../src/services/screenshot-persistence.service";
import {
  resolveCropRoot,
  buildSafeCropDir,
  type CropKind,
} from "../../../../src/services/part/crop-persistence.helper";
// F-08: 3s SLA SSOT 定数を import (3000 literal 再宣言禁止)。
import { SLA_WITHIN_MS } from "./inv-data-delete-002-core.test";

// ============================================================================
// Production default root — must never be created or deleted by this test
// (Registry F-13 / ADR-0041 D-1a sandbox constraint).
// ============================================================================

function resolveProductionDefaultRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(base, "reftrix", "screenshots");
}

// ============================================================================
// Sandbox crop-dir fixture helper (os.tmpdir() guard, F-13)
// ============================================================================

/**
 * crop fixture file を `<cropRoot>/<webPageId>/<kind>-<entityId>.png` に生成し
 * 絶対 path を返す。`gdpr-test-fixtures.ts` の `createScreenshotFixtureFile`
 * と同じ `/tmp/reftrix-test-` sandbox guard を遵守する (F-13)。
 *
 * Creates a crop fixture file at `<cropRoot>/<webPageId>/<kind>-<entityId>.png`
 * and returns its absolute path, honoring the same `/tmp/reftrix-test-` sandbox
 * guard as `createScreenshotFixtureFile` (F-13).
 */
const MIN_PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a" + "0000000d49484452" + "00000001000000010806000000" + "1f15c489",
  "hex"
);

async function createCropFixtureFile(
  webPageId: string,
  kind: CropKind,
  entityId: string
): Promise<string> {
  const cropRoot = await resolveCropRoot();
  // sandbox guard: crop root は `<REFTRIX_SCREENSHOT_ROOT>/crops` ゆえ
  // os.tmpdir() 配下 (/tmp/reftrix-test-*) でなければ refuse。
  if (!cropRoot.includes("/reftrix-test-")) {
    throw new Error(
      "[inv-crop-retention-001] crop root is not a test-only path; refuse to write fixture: " +
        cropRoot
    );
  }
  const perPageDir = path.join(cropRoot, webPageId);
  fs.mkdirSync(perPageDir, { recursive: true, mode: 0o700 });
  const absPath = path.join(perPageDir, `${kind}-${entityId}.png`);
  fs.writeFileSync(absPath, MIN_PNG_BYTES, { mode: 0o600 });
  return absPath;
}

/** crop root 配下に当該 webPageId の crop file が何件あるか数える (real-FS glob)。 */
async function countCropFilesForPage(webPageId: string): Promise<number> {
  const cropRoot = await resolveCropRoot();
  const perPageDir = path.join(cropRoot, webPageId);
  if (!fs.existsSync(perPageDir)) return 0;
  return fs
    .readdirSync(perPageDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".png")).length;
}

let prisma: PrismaClient;
let productionRootExistedBefore: boolean;
let previousCropFlag: string | undefined;

describe("INV-CROP-RETENTION-001: crop retention = until data.delete (GDPR Art.17 crop-dir cascade, single + batch, factory-unwired)", () => {
  beforeAll(async () => {
    await ensureSchemaAppliedOnce(process.env.DATABASE_URL!);
    prisma = createTestPrismaClient();
    await prisma.$connect();

    // CROP_PERSISTENCE_ENABLED を test 内で ON にする (production flip とは独立に、
    // crop file fixture を seed するため)。afterAll で復元。
    previousCropFlag = process.env.CROP_PERSISTENCE_ENABLED;
    process.env.CROP_PERSISTENCE_ENABLED = "true";

    // DI wire-up: 実 Prisma Client を GdprDeletionService / AuditLogService に注入。
    // **重要**: screenshot persistence factory は意図的に配線しない (crop cascade が
    //          DI 配線非依存であることを exercise; crop は factory を持たない)。
    setGdprPrismaClientFactory(() => prisma as unknown as GdprPrismaClient);
    setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);
    resetGdprScreenshotPersistenceFactory(); // explicit: factory unwired

    const gdprSvc = new GdprDeletionService();
    setDataDeleteServiceFactory(() => gdprSvc);

    // sandbox root resolve cache を sibling test と共有しないよう clear (F-13)。
    clearResolvedRootCache();

    // F-13: production default root の事前存在状態を記録 (afterAll で不変検証)。
    productionRootExistedBefore = fs.existsSync(resolveProductionDefaultRoot());
  });

  afterAll(async () => {
    resetDataDeleteServiceFactory();
    resetGdprPrismaClientFactory();
    resetGdprScreenshotPersistenceFactory();
    resetAuditLogPrismaClientFactory();
    resetGdprDeletionService();
    resetAuditLogService();
    await prisma?.$disconnect();

    // CROP_PERSISTENCE_ENABLED を復元。
    if (previousCropFlag === undefined) {
      delete process.env.CROP_PERSISTENCE_ENABLED;
    } else {
      process.env.CROP_PERSISTENCE_ENABLED = previousCropFlag;
    }

    // F-13 test-encoded assert: production default root が本テストにより作成も
    // 削除もされていないこと (coupling-drift / sandbox violation 検知)。
    const prodRoot = resolveProductionDefaultRoot();
    const productionRootExistsAfter = fs.existsSync(prodRoot);
    expect(
      productionRootExistsAfter,
      `[INV-CROP-RETENTION-001] sandbox violation: production default root ` +
        `existence changed (${productionRootExistedBefore} -> ${productionRootExistsAfter}). ` +
        `Tests MUST only touch the os.tmpdir() sandbox root.`
    ).toBe(productionRootExistedBefore);
  });

  beforeEach(async () => {
    await truncateGdprDomainTables(prisma);
  });

  // ==========================================================================
  // Assertion #1: single path factory-unwired crop unlink (F-03 #1)
  // ==========================================================================
  it("INV-CROP-RETENTION-001: factory-unwired data.delete(page) unlinks the crop dir (single path)", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-RETENTION-001");

    const ids: GdprFixtureIds = await seedGdprFixture(prisma);
    // crop fixture: section + part crop の 2 file を per-page dir に配置。
    const sectionCrop = await createCropFixtureFile(ids.webPageId, "section", ids.sectionPatternId);
    const partCrop = await createCropFixtureFile(ids.webPageId, "part", ids.componentPartId);
    expect(fs.existsSync(sectionCrop)).toBe(true);
    expect(fs.existsSync(partCrop)).toBe(true);

    const result = await dataDeleteHandler({
      target: "page",
      id: ids.webPageId,
      reason: "INV-CROP-RETENTION-001 — crop-dir cascade (page)",
      confirm: true,
    });
    expect(result.success).toBe(true);

    // crop file が FS から消滅していること (cascade が DI 配線非依存)。
    expect(fs.existsSync(sectionCrop)).toBe(false);
    expect(fs.existsSync(partCrop)).toBe(false);

    // web_pages 行も削除済。
    const wpCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM web_pages WHERE id = $1::uuid`,
      ids.webPageId
    );
    expect(Number(wpCount[0]!.count)).toBe(0);
  }, 60_000);

  // ==========================================================================
  // Assertion #2: batch path factory-unwired crop unlink (F-03 #2)
  // ==========================================================================
  it("INV-CROP-RETENTION-001: factory-unwired data.delete(all_user_data) unlinks crop dirs for all pages (batch path)", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-RETENTION-001");

    const idsA: GdprFixtureIds = await seedGdprFixture(prisma);
    const idsB: GdprFixtureIds = await seedGdprFixture(prisma);
    const cropA = await createCropFixtureFile(idsA.webPageId, "section", idsA.sectionPatternId);
    const cropB = await createCropFixtureFile(idsB.webPageId, "section", idsB.sectionPatternId);
    expect(fs.existsSync(cropA)).toBe(true);
    expect(fs.existsSync(cropB)).toBe(true);

    const result = await dataDeleteHandler({
      target: "all_user_data",
      id: crypto.randomUUID(),
      page_ids: [idsA.webPageId, idsB.webPageId],
      reason: "INV-CROP-RETENTION-001 — crop-dir cascade (batch)",
      confirm: true,
    });
    expect(result.success).toBe(true);

    // batch 経路でも両ページの crop file が消滅していること。
    expect(fs.existsSync(cropA)).toBe(false);
    expect(fs.existsSync(cropB)).toBe(false);

    const wpCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM web_pages`
    );
    expect(Number(wpCount[0]!.count)).toBe(0);
  }, 60_000);

  // ==========================================================================
  // Assertion #3: orphan reconcile / 冪等 re-run (F-12 #3)
  // ==========================================================================
  it("INV-CROP-RETENTION-001: idempotent data.delete re-run reaps residual crop files (orphan reconcile)", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-RETENTION-001");

    const ids: GdprFixtureIds = await seedGdprFixture(prisma);
    const crop = await createCropFixtureFile(ids.webPageId, "section", ids.sectionPatternId);
    expect(fs.existsSync(crop)).toBe(true);

    // 1st data.delete: web_pages 行 + crop file を削除。
    const first = await dataDeleteHandler({
      target: "page",
      id: ids.webPageId,
      reason: "INV-CROP-RETENTION-001 — orphan reconcile (1st)",
      confirm: true,
    });
    expect(first.success).toBe(true);
    expect(fs.existsSync(crop)).toBe(false);

    // partial-failure シミュレーション: crop file を再配置し orphan 状態を再現
    // (web_pages 行は既に削除済 = DB orphan、FS に crop だけ残った状態)。
    const orphanCrop = await createCropFixtureFile(ids.webPageId, "section", ids.sectionPatternId);
    expect(fs.existsSync(orphanCrop)).toBe(true);

    // 2nd data.delete (冪等 re-run): web_pages 行は無いが crop dir cascade は
    // `fs.rm force:true recursive` で ENOENT 冪等に残存 crop を回収する。
    // web_pages 行が無いので deletePage は "Page not found" を throw する想定 →
    // all_user_data 経路 (page_ids 明示) で冪等 re-run し crop dir cascade を駆動。
    const second = await dataDeleteHandler({
      target: "all_user_data",
      id: crypto.randomUUID(),
      page_ids: [ids.webPageId],
      reason: "INV-CROP-RETENTION-001 — orphan reconcile (2nd idempotent re-run)",
      confirm: true,
    });
    expect(second.success).toBe(true);

    // 冪等 re-run で残存 crop が回収されていること。
    expect(fs.existsSync(orphanCrop)).toBe(false);
    expect(await countCropFilesForPage(ids.webPageId)).toBe(0);
  }, 60_000);

  // ==========================================================================
  // Assertion #4: 3s SLA (absolute pin via SLA_WITHIN_MS SSOT, F-08 #4)
  // ==========================================================================
  it(
    "INV-CROP-RETENTION-001: data.delete with crop-dir unlink completes within the 3s SLA (absolute SSOT pin)",
    async () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-RETENTION-001");

      const ids: GdprFixtureIds = await seedGdprFixture(prisma);
      // per-page bounded crop file 群 (MAX_DYNAMIC_FALLBACK_SECTIONS 規模) を seed し
      // crop `fs.rm` が SLA を壊さないことを確認 (per-page O(n) bounded)。
      for (let i = 0; i < 20; i++) {
        await createCropFixtureFile(ids.webPageId, "section", crypto.randomUUID());
      }

      const startMs = performance.now();
      const result = await dataDeleteHandler({
        target: "page",
        id: ids.webPageId,
        reason: "INV-CROP-RETENTION-001 — 3s SLA",
        confirm: true,
      });
      const elapsedMs = performance.now() - startMs;
      expect(result.success).toBe(true);

      expect(
        elapsedMs,
        `[INV-CROP-RETENTION-001] 3s SLA measured: ${elapsedMs.toFixed(2)} ms (limit ${SLA_WITHIN_MS})`
      ).toBeLessThan(SLA_WITHIN_MS);

      // crop dir も消滅。
      expect(await countCropFilesForPage(ids.webPageId)).toBe(0);
    },
    SLA_WITHIN_MS * 4
  );

  // ==========================================================================
  // Assertion #5: negative — 0-file after delete (F-03 #5)
  // ==========================================================================
  it("INV-CROP-RETENTION-001: after data.delete, the crop root holds 0 crop files for the deleted webPageId (negative)", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-RETENTION-001");

    const ids: GdprFixtureIds = await seedGdprFixture(prisma);
    await createCropFixtureFile(ids.webPageId, "section", ids.sectionPatternId);
    await createCropFixtureFile(ids.webPageId, "part", ids.componentPartId);
    expect(await countCropFilesForPage(ids.webPageId)).toBe(2);

    const result = await dataDeleteHandler({
      target: "page",
      id: ids.webPageId,
      reason: "INV-CROP-RETENTION-001 — 0-file negative",
      confirm: true,
    });
    expect(result.success).toBe(true);

    expect(await countCropFilesForPage(ids.webPageId)).toBe(0);
  }, 60_000);

  // ==========================================================================
  // Assertion #6: negative traversal — buildSafeCropDir rejects non-UUID (F-06)
  // ==========================================================================
  it("INV-CROP-RETENTION-001: buildSafeCropDir rejects non-UUID webPageId before any fs.rm reaches it (negative traversal)", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-RETENTION-001");

    // path-traversal payloads: 相対 escape / null-byte / 親 dir。
    const malformedIds = ["../sibling", "..", "a/../../etc", "id\0null", "not-a-uuid", ""];

    for (const bad of malformedIds) {
      await expect(
        buildSafeCropDir(bad),
        `buildSafeCropDir("${bad.replace(/\0/g, "\\0")}") must throw (UUID_REGEX gate before fs)`
      ).rejects.toThrow();
    }

    // 正常 UUID は throw せず per-page dir を返し、crop root 配下に収まること。
    const okId = crypto.randomUUID();
    const dir = await buildSafeCropDir(okId);
    const cropRoot = await resolveCropRoot();
    expect(dir.startsWith(cropRoot)).toBe(true);
    expect(dir.endsWith(okId)).toBe(true);
  }, 60_000);

  // ==========================================================================
  // Assertion #7: backfill-generated crops are reaped by the SAME cascade (W6 PR-4a, R8)
  //
  // PR-4a's one-shot backfill (`scripts/backfill-crops.ts`) writes crops under the
  // SAME per-page dir convention `<cropRoot>/<webPageId>/<kind>-<entityId>.png` via
  // the SAME `saveCropFromBuffer` SSOT. So a backfill-generated crop is
  // indistinguishable from a Phase-5 crop for retention and is reaped by the SAME
  // `deleteCropDirBestEffort` cascade (NO new GDPR leg, ADR-0044 §Decision 4). This
  // fixture asserts a crop written via the production `saveCropFromBuffer` path (the
  // path the backfill script uses) is reaped by `data.delete`.
  // ==========================================================================
  it("INV-CROP-RETENTION-001: a backfill-generated crop (via saveCropFromBuffer SSOT) is reaped by the same data.delete cascade (R8, no new GDPR leg)", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-RETENTION-001");

    const ids: GdprFixtureIds = await seedGdprFixture(prisma);

    // Write a crop via the SAME production SSOT the backfill script uses
    // (saveCropFromBuffer), not the test-local fixture helper, to prove the
    // backfill-write path produces a crop the cascade reaps.
    const cropMod = await import("../../../../src/services/part/crop-persistence.helper");
    const cropPath = await cropMod.saveCropFromBuffer({
      webPageId: ids.webPageId,
      kind: "section",
      entityId: ids.sectionPatternId,
      pngBuffer: MIN_PNG_BYTES,
    });
    expect(cropPath, "saveCropFromBuffer must persist the backfill crop (flag ON)").not.toBeNull();
    expect(fs.existsSync(cropPath as string)).toBe(true);

    const result = await dataDeleteHandler({
      target: "page",
      id: ids.webPageId,
      reason: "INV-CROP-RETENTION-001 — backfill crop cascade (R8)",
      confirm: true,
    });
    expect(result.success).toBe(true);

    // The backfill-generated crop is reaped by the same cascade.
    expect(fs.existsSync(cropPath as string)).toBe(false);
    expect(await countCropFilesForPage(ids.webPageId)).toBe(0);
  }, 60_000);
});
