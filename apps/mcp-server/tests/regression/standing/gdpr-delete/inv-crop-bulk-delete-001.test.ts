// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-CROP-BULK-DELETE-001
 * (legacy crop bulk deletion leaves no crop file, no stored path and one audit row)
 *
 * INV-CROP-BULK-DELETE-001: after `purge-legacy-crops.ts --confirm`
 *   (a) no UUID directory remains under `<root>/crops/`,
 *   (b) 0 rows with a non-NULL `crop_storage_path` remain in `section_embeddings`
 *       and `component_part_embeddings`,
 *   (c) `hasCrop` (the `section.inspect` part summary) is false for the page,
 *   (d) exactly 1 `crop_legacy_bulk_deleted` audit row exists for the run,
 *   (e) when the stored paths point outside the resolved crops directory the
 *       database is NOT touched and the run is reported as failed.
 *
 * Positive controls: the dry-run test proves the fixture really has crops, paths
 * and a `hasCrop = true` page before the confirm run, so a zero afterwards is not
 * vacuous; the mismatch test proves the assertions detect a residue.
 *
 * Real database (testcontainer) + sandbox file system under `os.tmpdir()`.
 * `.skip()` / `.todo()` are prohibited.
 *
 * @see apps/mcp-server/scripts/purge-legacy-crops.ts
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertInvName } from "../_setup/inv-assert";
import {
  createTestPrismaClient,
  seedGdprFixture,
  truncateGdprDomainTables,
  type GdprFixtureIds,
} from "../_setup/gdpr-test-fixtures";
import {
  isFailedRun,
  parseArgs,
  runPurge,
  type PurgePrismaClient,
} from "../../../../scripts/purge-legacy-crops";
import { AUDIT_ACTION_CROP_LEGACY_BULK_DELETED } from "../../../../src/audit/audit-actions";
import {
  bootstrapAuditLogServiceForScript,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
} from "../../../../src/services/audit-log.service";
import { resolveCropRoot } from "../../../../src/services/part/crop-persistence.helper";
import { getSectionParts } from "../../../../src/services/section-detail.service";
import { clearResolvedRootCache } from "../../../../src/services/screenshot-persistence.service";

let prisma: PrismaClient;

async function placeCrops(ids: GdprFixtureIds): Promise<string> {
  const cropRoot = await resolveCropRoot();
  if (!cropRoot.includes("/reftrix-test-")) {
    throw new Error(
      `[inv-crop-bulk-delete-001] refusing to write outside the test root: ${cropRoot}`
    );
  }
  const dir = path.join(cropRoot, ids.webPageId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "section.png"), "png", { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "part.png"), "png", { mode: 0o600 });
  await prisma.$executeRawUnsafe(
    `UPDATE section_embeddings SET crop_storage_path = $1 WHERE section_pattern_id = $2::uuid`,
    path.join(dir, "section.png"),
    ids.sectionPatternId
  );
  await prisma.$executeRawUnsafe(
    `UPDATE component_part_embeddings SET crop_storage_path = $1 WHERE component_part_id = $2::uuid`,
    path.join(dir, "part.png"),
    ids.componentPartId
  );
  return dir;
}

async function nonNullPathRows(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT (SELECT COUNT(*) FROM section_embeddings WHERE crop_storage_path IS NOT NULL)
          + (SELECT COUNT(*) FROM component_part_embeddings WHERE crop_storage_path IS NOT NULL) AS n`
  );
  return Number(rows[0]!.n);
}

async function auditRowCount(): Promise<number> {
  return prisma.auditLog.count({ where: { action: AUDIT_ACTION_CROP_LEGACY_BULK_DELETED } });
}

async function hasCrop(ids: GdprFixtureIds): Promise<boolean> {
  const parts = await getSectionParts(ids.sectionPatternId, 50);
  return parts.some((p) => p.hasCrop);
}

/** sha256 over every relative path and file content under dir (absent dir hashes the empty tree). */
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      h.update(`${path.relative(dir, full)}\0`);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) h.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return h.digest("hex");
}

function cropDirsIn(cropRoot: string): string[] {
  return fs.existsSync(cropRoot) ? fs.readdirSync(cropRoot) : [];
}

describe("INV-CROP-BULK-DELETE-001: legacy crop bulk deletion leaves no file, no path and one audit row", () => {
  beforeAll(async () => {
    prisma = createTestPrismaClient();
    await prisma.$connect();
    bootstrapAuditLogServiceForScript(prisma);
    clearResolvedRootCache();
  });

  afterAll(async () => {
    resetAuditLogService();
    resetAuditLogPrismaClientFactory();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await truncateGdprDomainTables(prisma);
    const cropRoot = await resolveCropRoot();
    if (cropRoot.includes("/reftrix-test-")) fs.rmSync(cropRoot, { recursive: true, force: true });
  });

  it("INV-CROP-BULK-DELETE-001: dry-run changes nothing (positive control: the fixture has crops, paths and hasCrop = true)", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BULK-DELETE-001");
    const ids = await seedGdprFixture(prisma);
    await placeCrops(ids);
    const cropRoot = await resolveCropRoot();
    const treeBefore = treeHash(cropRoot);

    const r = await runPurge(prisma as unknown as PurgePrismaClient, {
      dryRun: true,
      confirm: false,
    });

    expect(r.dirsDeleted).toBe(1);
    expect(treeHash(cropRoot)).toBe(treeBefore);
    expect(cropDirsIn(cropRoot)).toEqual([ids.webPageId]);
    expect(await nonNullPathRows()).toBe(2);
    expect(await hasCrop(ids)).toBe(true);
    expect(await auditRowCount()).toBe(0);
  }, 60_000);

  it("INV-CROP-BULK-DELETE-001: confirm leaves 0 crop directories, 0 stored paths, hasCrop = false and exactly 1 audit row", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BULK-DELETE-001");
    const idsA = await seedGdprFixture(prisma);
    const idsB = await seedGdprFixture(prisma);
    await placeCrops(idsA);
    await placeCrops(idsB);
    const cropRoot = await resolveCropRoot();
    expect(await nonNullPathRows()).toBe(4);
    expect(await hasCrop(idsA)).toBe(true);

    const r = await runPurge(prisma as unknown as PurgePrismaClient, {
      dryRun: false,
      confirm: true,
    });

    expect(isFailedRun(r)).toBe(false);
    expect(cropDirsIn(cropRoot)).toEqual([]);
    expect(await nonNullPathRows()).toBe(0);
    expect(await hasCrop(idsA)).toBe(false);
    expect(await hasCrop(idsB)).toBe(false);
    expect(await auditRowCount()).toBe(1);

    // idempotent: the second run finds nothing and adds no audit row
    const again = await runPurge(prisma as unknown as PurgePrismaClient, {
      dryRun: false,
      confirm: true,
    });
    expect(again.dirsDeleted + again.sectionRowsCleared + again.partRowsCleared).toBe(0);
    expect(isFailedRun(again)).toBe(false);
    expect(await auditRowCount()).toBe(1);
  }, 60_000);

  it("INV-CROP-BULK-DELETE-001: stored paths outside the resolved crops directory delete nothing (files, database, audit) and fail the run", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BULK-DELETE-001");
    const ids = await seedGdprFixture(prisma);
    await placeCrops(ids);
    await prisma.$executeRawUnsafe(
      `UPDATE section_embeddings SET crop_storage_path = '/elsewhere/crops/x/section.png'
        WHERE section_pattern_id = $1::uuid`,
      ids.sectionPatternId
    );
    const cropRoot = await resolveCropRoot();
    const treeBefore = treeHash(cropRoot);
    expect(treeBefore).not.toBe(treeHash(path.join(cropRoot, "absent")));

    const r = await runPurge(prisma as unknown as PurgePrismaClient, {
      dryRun: false,
      confirm: true,
    });

    expect(r.rootMismatchRows).toBeGreaterThan(0);
    expect(isFailedRun(r)).toBe(true);
    expect(r.dirsDeleted).toBe(0);
    expect(treeHash(cropRoot)).toBe(treeBefore);
    expect(await nonNullPathRows()).toBe(2);
    expect(await hasCrop(ids)).toBe(true);
    expect(await auditRowCount()).toBe(0);
  }, 60_000);

  it("INV-CROP-BULK-DELETE-001: a UUID-named symlink and a non-UUID entry are left in place, their page keeps its stored path, and the run fails", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BULK-DELETE-001");
    const kept = await seedGdprFixture(prisma);
    const removed = await seedGdprFixture(prisma);
    const keptDir = await placeCrops(kept);
    await placeCrops(removed);
    const cropRoot = await resolveCropRoot();
    // replace the kept page's directory with a symlink to a target outside the crops root
    const target = fs.mkdtempSync(path.join(path.dirname(cropRoot), "symlink-target-"));
    fs.writeFileSync(path.join(target, "keep.png"), "png");
    fs.rmSync(keptDir, { recursive: true, force: true });
    fs.symlinkSync(target, keptDir);
    fs.writeFileSync(path.join(cropRoot, "not-a-uuid.txt"), "x");
    const targetBefore = treeHash(target);

    const r = await runPurge(prisma as unknown as PurgePrismaClient, {
      dryRun: false,
      confirm: true,
    });

    expect(r.skippedUnsafe).toBe(2);
    expect(isFailedRun(r)).toBe(true);
    expect(r.dirsDeleted).toBe(1);
    expect(fs.lstatSync(keptDir).isSymbolicLink()).toBe(true);
    expect(treeHash(target)).toBe(targetBefore);
    expect(fs.existsSync(path.join(cropRoot, "not-a-uuid.txt"))).toBe(true);
    // the kept page keeps both stored paths; the removed page loses its own
    expect(await nonNullPathRows()).toBe(2);
    expect(await hasCrop(kept)).toBe(true);
    expect(await hasCrop(removed)).toBe(false);
    // the audit row records the partial run as a failure
    const audit = await prisma.auditLog.findMany({
      where: { action: AUDIT_ACTION_CROP_LEGACY_BULK_DELETED },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.result).toBe("failure");
    fs.rmSync(target, { recursive: true, force: true });
  }, 60_000);

  it("INV-CROP-BULK-DELETE-001: a crops directory that is a symlink aborts the run before anything is deleted", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BULK-DELETE-001");
    const ids = await seedGdprFixture(prisma);
    const cropRoot = await resolveCropRoot();
    const real = fs.mkdtempSync(path.join(path.dirname(cropRoot), "crops-real-"));
    fs.rmSync(cropRoot, { recursive: true, force: true });
    fs.symlinkSync(real, cropRoot);
    fs.mkdirSync(path.join(real, ids.webPageId));
    fs.writeFileSync(path.join(real, ids.webPageId, "section.png"), "png");
    const before = treeHash(real);

    await expect(
      runPurge(prisma as unknown as PurgePrismaClient, { dryRun: false, confirm: true })
    ).rejects.toThrow(/symlink/);

    expect(treeHash(real)).toBe(before);
    expect(await auditRowCount()).toBe(0);
    fs.rmSync(cropRoot, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }, 60_000);

  it("INV-CROP-BULK-DELETE-001: an orphan directory (no web_pages row) is deleted and counted", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BULK-DELETE-001");
    const cropRoot = await resolveCropRoot();
    const orphan = path.join(cropRoot, randomUUID());
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "section.png"), "png");

    const r = await runPurge(prisma as unknown as PurgePrismaClient, {
      dryRun: false,
      confirm: true,
    });

    expect(r.orphanDirs).toBe(1);
    expect(r.dirsDeleted).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(await auditRowCount()).toBe(1);
  }, 60_000);

  it("INV-CROP-BULK-DELETE-001: --web-page-id limits the run to that page", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BULK-DELETE-001");
    const target = await seedGdprFixture(prisma);
    const other = await seedGdprFixture(prisma);
    await placeCrops(target);
    const otherDir = await placeCrops(other);

    const r = await runPurge(prisma as unknown as PurgePrismaClient, {
      dryRun: false,
      confirm: true,
      webPageId: target.webPageId,
    });

    expect(r.dirsDeleted).toBe(1);
    expect(await hasCrop(target)).toBe(false);
    expect(await hasCrop(other)).toBe(true);
    expect(fs.existsSync(otherDir)).toBe(true);
  }, 60_000);

  it("INV-CROP-BULK-DELETE-001: when the database update fails after files were deleted, the run throws and still writes a failure audit row", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BULK-DELETE-001");
    const ids = await seedGdprFixture(prisma);
    const dir = await placeCrops(ids);
    const failing: PurgePrismaClient = {
      $queryRaw: (q, ...v) => (prisma as unknown as PurgePrismaClient).$queryRaw(q, ...v),
      $executeRaw: () => Promise.reject(new Error("simulated connection loss")),
    };

    await expect(runPurge(failing, { dryRun: false, confirm: true })).rejects.toThrow(
      /simulated connection loss/
    );

    expect(fs.existsSync(dir)).toBe(false);
    const audit = await prisma.auditLog.findMany({
      where: { action: AUDIT_ACTION_CROP_LEGACY_BULK_DELETED },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.result).toBe("failure");
    expect((audit[0]!.details as { dirsDeleted?: number; aborted?: boolean }).dirsDeleted).toBe(1);
    expect((audit[0]!.details as { aborted?: boolean }).aborted).toBe(true);
  }, 60_000);

  it("INV-CROP-BULK-DELETE-001: parseArgs is dry-run unless --confirm and rejects a malformed --web-page-id", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-BULK-DELETE-001");
    expect(parseArgs(["node", "s"]).dryRun).toBe(true);
    expect(parseArgs(["node", "s", "--confrim"]).dryRun).toBe(true);
    expect(parseArgs(["node", "s", "--confirm"]).dryRun).toBe(false);
    expect(() => parseArgs(["node", "s", "--web-page-id=../x"])).toThrow(/valid UUID/);
  });
});
