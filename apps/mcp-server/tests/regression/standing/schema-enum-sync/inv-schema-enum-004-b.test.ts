// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004-B
 *
 * `EmbeddingBackfillStatus` enum の 4-way sync 検証 (PR4 Queue-based Backfill)。
 *
 * 1. **Prisma schema** (T1 Canonical): `@prisma/client` runtime の
 *    `EmbeddingBackfillStatus` enum (現在 8 値: `not_required` / `queued` /
 *    `in_progress` / `completed` / `failed` / `skipped_memory_pressure` /
 *    `skipped_fork_error` / `skipped_screenshot_missing`)
 * 2. **TypeScript literal union**: `src/workers/page-analyze-worker.ts` の
 *    `EmbeddingBackfillStatusValue` 型
 * 3. **CLI/script SSOT**: `scripts/force-reconcile-backfill.ts` の
 *    `VALID_STATUSES` (run-time validation 用)
 * 4. **Repair target**: `scripts/repair-orphaned-backfill-records.ts` が書く
 *    `skipped_screenshot_missing` は Prisma に存在しなければならない (PR7d-1)
 *
 * 1. Prisma schema (T1 Canonical): `@prisma/client` runtime
 *    `EmbeddingBackfillStatus` (8 values as of v0.4.0 PR7d-1).
 * 2. TypeScript literal union: `EmbeddingBackfillStatusValue` in
 *    `src/workers/page-analyze-worker.ts`.
 * 3. CLI/script SSOT: `VALID_STATUSES` in `scripts/force-reconcile-backfill.ts`.
 * 4. Repair target: `skipped_screenshot_missing` written by
 *    `scripts/repair-orphaned-backfill-records.ts` must exist in Prisma (PR7d-1).
 *
 * **Note**: unlike `EmbeddingSkipReason`, this enum IS persisted
 * (`web_pages.embeddingBackfillStatus`). Prisma is T1 canonical.
 *
 * ADR-0016 Amendment 2-C mapping (§ Existing Test Migration):
 * - `tests/workers/page-analyze-phase5-backfill-dispatch.test.ts`
 * - `tests/workers/embedding-backfill-worker.test.ts`
 * - `tests/scripts/force-reconcile-backfill.integration.test.ts`
 *
 * @see ADR-0016 § Invariants (INV-SCHEMA-ENUM-004-B)
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  addMcpServerSourceFile,
  createAstProject,
  extractConstStringArray,
  extractStringLiteralUnion,
  loadPrismaEnumValues,
  setDifference,
} from "./_extractors";

describe("INV-SCHEMA-ENUM-004-B: EmbeddingBackfillStatus 4-way sync", () => {
  let prismaValues: string[];
  let tsUnionValues: string[];
  let scriptValidStatuses: string[];

  beforeAll(() => {
    // 1. Prisma T1 canonical
    prismaValues = loadPrismaEnumValues("EmbeddingBackfillStatus");

    const project = createAstProject();

    // 2. TypeScript literal union
    const workerFile = addMcpServerSourceFile(project, "src/workers/page-analyze-worker.ts");
    tsUnionValues = extractStringLiteralUnion(workerFile, "EmbeddingBackfillStatusValue");

    // 3. CLI / script SSOT (`VALID_STATUSES as const satisfies readonly EmbeddingBackfillStatus[]`)
    const scriptFile = addMcpServerSourceFile(project, "scripts/force-reconcile-backfill.ts");
    scriptValidStatuses = extractConstStringArray(scriptFile, "VALID_STATUSES");
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004-B");
  });

  it("INV-SCHEMA-ENUM-004-B: Prisma has at least 7 documented values incl. PR7d-1 skipped_screenshot_missing", () => {
    // PR7d-1 時点で 8 値 (`skipped_screenshot_missing` 追加済)。下方境界として
    // 最低 7 の documented core + `skipped_screenshot_missing` を必須とする。
    // PR7d-1 adds `skipped_screenshot_missing`; core 7 values + this 1 = 8.
    expect(prismaValues.length).toBeGreaterThanOrEqual(8);
    expect(prismaValues).toContain("not_required");
    expect(prismaValues).toContain("queued");
    expect(prismaValues).toContain("in_progress");
    expect(prismaValues).toContain("completed");
    expect(prismaValues).toContain("failed");
    expect(prismaValues).toContain("skipped_memory_pressure");
    expect(prismaValues).toContain("skipped_fork_error");
    expect(prismaValues).toContain("skipped_screenshot_missing");
  });

  it("INV-SCHEMA-ENUM-004-B: TS literal union `EmbeddingBackfillStatusValue` matches Prisma", () => {
    const diff = setDifference(prismaValues, tsUnionValues);
    expect(
      diff.onlyInA,
      `TypeScript literal union \`EmbeddingBackfillStatusValue\` in ` +
        `page-analyze-worker.ts is missing Prisma enum values: ${JSON.stringify(diff.onlyInA)}. ` +
    ).toEqual([]);
    expect(
      diff.onlyInB,
      `TypeScript literal union \`EmbeddingBackfillStatusValue\` contains values not ` +
        `present in Prisma: ${JSON.stringify(diff.onlyInB)}. Remove stale values or add ` +
        `them to Prisma schema via migration.`
    ).toEqual([]);
  });

  it("INV-SCHEMA-ENUM-004-B: CLI `VALID_STATUSES` matches Prisma", () => {
    // `VALID_STATUSES` is annotated with `as const satisfies readonly EmbeddingBackfillStatus[]`,
    // giving compile-time protection. This test adds runtime drift detection.
    const diff = setDifference(prismaValues, scriptValidStatuses);
    expect(
      diff.onlyInA,
      `CLI \`VALID_STATUSES\` in scripts/force-reconcile-backfill.ts is missing ` +
        `Prisma enum values: ${JSON.stringify(diff.onlyInA)}. Update the CLI validator ` +
        `whenever the Prisma enum changes.`
    ).toEqual([]);
    expect(
      diff.onlyInB,
      `CLI \`VALID_STATUSES\` contains values not present in Prisma: ` +
        `${JSON.stringify(diff.onlyInB)}. Remove stale values.`
    ).toEqual([]);
  });

  it("INV-SCHEMA-ENUM-004-B: TS literal union and CLI `VALID_STATUSES` are internally consistent", () => {
    // Prisma 経由の間接 equal は推移律で成立するが、明示的な直接比較で
    // どちらかの drift を早期に可視化する。
    const diff = setDifference(tsUnionValues, scriptValidStatuses);
    expect(diff.onlyInA, "worker union has values missing from CLI validator").toEqual([]);
    expect(diff.onlyInB, "CLI validator has values missing from worker union").toEqual([]);
  });
});
