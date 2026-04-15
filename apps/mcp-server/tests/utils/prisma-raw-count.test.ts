// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * countNonNullVector Tests (v0.4.0 PR6 TDA TD-1)
 *
 * page-analyze-worker.ts から抽出された raw count util のユニットテスト。
 * table / column の allowlist 検証、webPageId のパラメータ化、BigInt/string の
 * 両対応を確認する。
 *
 * Unit tests for the raw count util extracted from page-analyze-worker.ts.
 * Covers allowlist validation, webPageId parameterization, and BigInt/string
 * count parsing.
 */

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  countNonNullVector,
  ALLOWED_EMBEDDING_TABLES,
  ALLOWED_VECTOR_COLUMNS,
} from "../../src/utils/prisma-raw-count";

const WEB_PAGE_ID = "019bc123-4567-7890-abcd-ef1234567890";

function buildPrismaMock(resolveValue: Array<{ count: bigint | string }>): {
  prisma: PrismaClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async () => resolveValue);
  const prisma = { $queryRawUnsafe: spy } as unknown as PrismaClient;
  return { prisma, spy };
}

describe("countNonNullVector (v0.4.0 PR6 TDA TD-1)", () => {
  it("returns count as number from bigint", async () => {
    const { prisma, spy } = buildPrismaMock([{ count: BigInt(42) }]);
    const result = await countNonNullVector({
      prisma,
      table: "section_embeddings",
      column: "text_embedding",
      joinFragment: "JOIN section_patterns sp ON t.section_pattern_id = sp.id",
      webPageIdColumn: "sp.web_page_id",
      webPageId: WEB_PAGE_ID,
    });
    expect(result).toBe(42);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("returns count as number from string", async () => {
    const { prisma } = buildPrismaMock([{ count: "123" }]);
    const result = await countNonNullVector({
      prisma,
      table: "component_part_embeddings",
      column: "visual_embedding",
      joinFragment: "JOIN component_parts cp ON t.component_part_id = cp.id",
      webPageIdColumn: "cp.web_page_id",
      webPageId: WEB_PAGE_ID,
    });
    expect(result).toBe(123);
  });

  it("returns 0 when no rows", async () => {
    const { prisma } = buildPrismaMock([]);
    const result = await countNonNullVector({
      prisma,
      table: "section_embeddings",
      column: "vision_embedding",
      joinFragment: "JOIN section_patterns sp ON t.section_pattern_id = sp.id",
      webPageIdColumn: "sp.web_page_id",
      webPageId: WEB_PAGE_ID,
    });
    expect(result).toBe(0);
  });

  it("parameterizes webPageId (not inlined in SQL)", async () => {
    const { prisma, spy } = buildPrismaMock([{ count: BigInt(5) }]);
    await countNonNullVector({
      prisma,
      table: "section_embeddings",
      column: "text_embedding",
      joinFragment: "JOIN section_patterns sp ON t.section_pattern_id = sp.id",
      webPageIdColumn: "sp.web_page_id",
      webPageId: WEB_PAGE_ID,
    });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("$1::uuid"), WEB_PAGE_ID);
  });

  it("rejects invalid table (defense in depth)", async () => {
    const { prisma } = buildPrismaMock([]);
    await expect(
      countNonNullVector({
        prisma,
        table: "malicious_table" as never,
        column: "text_embedding",
        joinFragment: "",
        webPageIdColumn: "x",
        webPageId: WEB_PAGE_ID,
      })
    ).rejects.toThrow(/Invalid table/);
  });

  it("rejects invalid column", async () => {
    const { prisma } = buildPrismaMock([]);
    await expect(
      countNonNullVector({
        prisma,
        table: "section_embeddings",
        column: "not_a_vector" as never,
        joinFragment: "JOIN section_patterns sp ON t.section_pattern_id = sp.id",
        webPageIdColumn: "sp.web_page_id",
        webPageId: WEB_PAGE_ID,
      })
    ).rejects.toThrow(/Invalid column/);
  });

  it("rejects webPageIdColumn with SQL injection characters", async () => {
    const { prisma } = buildPrismaMock([]);
    await expect(
      countNonNullVector({
        prisma,
        table: "section_embeddings",
        column: "text_embedding",
        joinFragment: "",
        webPageIdColumn: "sp.web_page_id; DROP TABLE users; --",
        webPageId: WEB_PAGE_ID,
      })
    ).rejects.toThrow(/Invalid webPageIdColumn/);
  });

  it("clamps negative / NaN / non-finite count to 0", async () => {
    const { prisma } = buildPrismaMock([{ count: "abc" }]);
    const result = await countNonNullVector({
      prisma,
      table: "section_embeddings",
      column: "text_embedding",
      joinFragment: "JOIN section_patterns sp ON t.section_pattern_id = sp.id",
      webPageIdColumn: "sp.web_page_id",
      webPageId: WEB_PAGE_ID,
    });
    expect(result).toBe(0);
  });

  it("exports allowlist constants", () => {
    expect(ALLOWED_EMBEDDING_TABLES).toContain("section_embeddings");
    expect(ALLOWED_EMBEDDING_TABLES).toContain("component_part_embeddings");
    expect(ALLOWED_VECTOR_COLUMNS).toContain("text_embedding");
    expect(ALLOWED_VECTOR_COLUMNS).toContain("visual_embedding");
    expect(ALLOWED_VECTOR_COLUMNS).toContain("vision_embedding");
  });
});
