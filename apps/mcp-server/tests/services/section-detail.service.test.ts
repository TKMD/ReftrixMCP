// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Section detail service unit tests (`src/services/section-detail.service.ts`).
 *
 * Covers `getSectionDetail` (its tests moved here from the internal API test suite,
 * which was removed together with the internal read HTTP API),
 * `getSectionParts` (per-part redaction, query shape, hasCrop), the empty-input
 * short-circuit of `getHighPiiSectionIds`, and the read-only source pin for the module.
 * Prisma is mocked (no real DB); the real-DB leg lives in
 * `tests/integration/section-detail-high-pii.integration.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@reftrixmcp/database", () => ({
  prisma: {
    sectionPattern: { findUnique: vi.fn() },
    componentPart: { findMany: vi.fn() },
  },
}));

import { prisma } from "@reftrixmcp/database";
import {
  getSectionDetail,
  getSectionParts,
  getHighPiiSectionIds,
} from "../../src/services/section-detail.service";

const WEB_PAGE_ID = "0190b6f0-1234-7abc-89ab-0123456789ab";
const SECTION_A = "0190b6f0-aaaa-7abc-89ab-0123456789ab";

const mockedPartFindMany = prisma.componentPart.findMany as ReturnType<typeof vi.fn>;
const mockedSectionFindUnique = prisma.sectionPattern.findUnique as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSectionDetail — single-section read (W6 Issue A PR-1, section.inspect SSOT)", () => {
  it("returns null for a non-existent section_id (IDOR-shaped reject upstream)", async () => {
    mockedSectionFindUnique.mockResolvedValue(null);
    const result = await getSectionDetail(SECTION_A);
    expect(result).toBeNull();
  });

  it("returns metadata + htmlSnippet for a clean (non-high-PII) section", async () => {
    mockedSectionFindUnique.mockResolvedValue({
      id: SECTION_A,
      webPageId: WEB_PAGE_ID,
      sectionType: "hero",
      sectionName: "Hero",
      positionIndex: 0,
      layoutInfo: { position: { startY: 0, endY: 600, height: 600 } },
      htmlSnippet: "<section>clean</section>",
    });
    mockedPartFindMany.mockResolvedValue([]);

    const result = await getSectionDetail(SECTION_A);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(SECTION_A);
    expect(result!.webPageId).toBe(WEB_PAGE_ID);
    expect(result!.sectionType).toBe("hero");
    expect(result!.position).toEqual({ startY: 0, endY: 600, height: 600 });
    expect(result!.htmlSnippet).toBe("<section>clean</section>");
  });

  it("nulls htmlSnippet via the getHighPiiSectionIds SSOT when the section has a high-PII part", async () => {
    mockedSectionFindUnique.mockResolvedValue({
      id: SECTION_A,
      webPageId: WEB_PAGE_ID,
      sectionType: "team",
      sectionName: null,
      positionIndex: 4,
      layoutInfo: null,
      htmlSnippet: "<section><img alt='avatar'></section>",
    });
    mockedPartFindMany.mockResolvedValue([{ sectionPatternId: SECTION_A }]);

    const result = await getSectionDetail(SECTION_A);
    expect(result).not.toBeNull();
    expect(result!.htmlSnippet).toBeNull();
    // SSOT call shape: filter by piiRiskLevel='high' on this section id.
    const callArg = mockedPartFindMany.mock.calls[0]?.[0] as {
      where?: { sectionPatternId?: { in?: string[] }; piiRiskLevel?: string };
    };
    expect(callArg?.where?.piiRiskLevel).toBe("high");
    expect(callArg?.where?.sectionPatternId?.in).toContain(SECTION_A);
  });
});

describe("getSectionParts — section-scoped parts (section.inspect, per-part redaction)", () => {
  const partRow = (id: string, pii: string): Record<string, unknown> => ({
    id,
    partType: "form",
    sectionPatternId: SECTION_A,
    boundingBox: { x: 0, y: 0, width: 1, height: 1 },
    piiRiskLevel: pii,
    htmlSnippet: `<input value="${id}@secret.example.com">`,
    cssClasses: [`cls-${id}`],
    attributes: { value: `${id}@secret.example.com` },
  });

  it("redacts high-PII parts, keeps the marker and non-PII parts", async () => {
    mockedPartFindMany.mockResolvedValue([partRow("hi", "high"), partRow("lo", "none")]);
    const parts = await getSectionParts(SECTION_A, 50);
    const hi = parts.find((p) => p.id === "hi")!;
    const lo = parts.find((p) => p.id === "lo")!;
    expect(hi.htmlSnippet).toBeNull();
    expect(hi.cssClasses).toEqual([]);
    expect(hi.attributes).toBeNull();
    expect(hi.piiRiskLevel).toBe("high");
    expect(JSON.stringify(hi)).not.toContain("hi@secret.example.com");
    expect(lo.htmlSnippet).toContain("lo@secret.example.com");
  });

  it("queries by sectionPatternId with sampleIndex asc and the given take cap", async () => {
    mockedPartFindMany.mockResolvedValue([]);
    await getSectionParts(SECTION_A, 7);
    expect(mockedPartFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sectionPatternId: SECTION_A },
        orderBy: { sampleIndex: "asc" },
        take: 7,
      })
    );
  });

  it("derives hasCrop from crop_storage_path presence only (raw path never exposed)", async () => {
    mockedPartFindMany.mockResolvedValue([
      { ...partRow("c", "none"), embedding: { cropStoragePath: "/x/y.png" } },
    ]);
    const [p] = await getSectionParts(SECTION_A, 50);
    expect(p.hasCrop).toBe(true);
    expect(JSON.stringify(p)).not.toContain("/x/y.png");
  });
});

describe("getHighPiiSectionIds — SSOT predicate", () => {
  it("returns an empty set without querying when given no ids", async () => {
    const set = await getHighPiiSectionIds([]);
    expect(set.size).toBe(0);
    expect(mockedPartFindMany).not.toHaveBeenCalled();
  });
});

describe("INV-WEBUI-READONLY-NEGATIVE-001 — section-detail service is read-only (UB-6)", () => {
  it("section-detail.service.ts contains no Prisma write verbs", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "src", "services", "section-detail.service.ts"),
      "utf8"
    );
    const writeVerbRe =
      /prisma\.\w+\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/;
    expect(writeVerbRe.test(src)).toBe(false);
    expect(src).toMatch(/prisma\.\w+\.(findUnique|findFirst|findMany|count)\b/);
  });
});
