// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-DB leg for `getHighPiiSectionIds` / `getSectionDetail` (services/section-detail.service).
 *
 * Carries over the real-DB part of the former gallery-pii leg (a) for the section high-PII SSOT
 * (INV-CROP-PII-EXCLUDED-001 surface 4/4b, INV-SECTION-INSPECT-PII-REDACTION-001): against a real
 * Postgres a section holding a high-PII part is in the set and has its `htmlSnippet` nulled, while
 * a non-PII sibling is not and keeps it.
 *
 * HAS_DB-gated; CI (`CI=true`) without DATABASE_URL FAILS the precondition test (fail-closed, no
 * `.skip` / `.todo`). Fixture rows use a reserved `.test` domain + uuid and are exact-match
 * cascade-deleted by page id in afterEach (existing data is never touched).
 *
 * @module tests/integration/section-detail-high-pii.integration
 */

import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@reftrixmcp/database";
import { getHighPiiSectionIds, getSectionDetail } from "../../src/services/section-detail.service";

const IS_CI = process.env.CI === "true" || process.env.CI === "1";
const HAS_DB = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

const createdWebPageIds: string[] = [];

afterEach(async () => {
  if (!HAS_DB || createdWebPageIds.length === 0) return;
  await prisma.webPage.deleteMany({ where: { id: { in: createdWebPageIds.splice(0) } } });
});

async function createSection(
  webPageId: string,
  positionIndex: number,
  pii: "high" | "low"
): Promise<string> {
  const id = randomUUID();
  await prisma.sectionPattern.create({
    data: {
      id,
      webPageId,
      sectionType: "team",
      positionIndex,
      htmlSnippet: `<section>fixture-${positionIndex}</section>`,
      layoutInfo: { position: { startY: 0, height: 400 } },
    },
  });
  await prisma.componentPart.create({
    data: {
      id: randomUUID(),
      webPageId,
      sectionPatternId: id,
      partType: "text",
      computedStyles: {},
      attributes: {},
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      interactionInfo: {},
      piiRiskLevel: pii,
      extractedAt: new Date(),
    },
  });
  return id;
}

describe("section-detail high-PII real-DB legs (HAS_DB-gated, fail-closed on CI)", () => {
  it("precondition: CI provides DATABASE_URL (no silent short-circuit)", () => {
    if (IS_CI) {
      expect(process.env.DATABASE_URL, "CI MUST provide a real PostgreSQL").toBeTruthy();
    }
    expect(typeof HAS_DB).toBe("boolean");
  });

  it("getHighPiiSectionIds returns only the section holding a high-PII part; getSectionDetail redacts it", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB leg skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    const webPageId = randomUUID();
    await prisma.webPage.create({
      data: {
        id: webPageId,
        url: `https://section-detail-pii-${webPageId}.example.test/`,
        title: "section-detail high-PII fixture",
        sourceType: "user_provided",
        usageScope: "inspiration_only",
      },
    });
    createdWebPageIds.push(webPageId);
    const high = await createSection(webPageId, 0, "high");
    const low = await createSection(webPageId, 1, "low");

    const set = await getHighPiiSectionIds([high, low]);
    expect([...set]).toEqual([high]);

    const highDetail = await getSectionDetail(high);
    const lowDetail = await getSectionDetail(low);
    expect(highDetail?.htmlSnippet).toBeNull();
    expect(lowDetail?.htmlSnippet).toBe("<section>fixture-1</section>");
  }, 60_000);
});
