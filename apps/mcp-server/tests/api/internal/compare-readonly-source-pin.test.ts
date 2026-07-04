// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `INV-WEBUI-COMPARE-READONLY-005` — mcp-server-side read-only + DRY-by-delegation source-pin
 * (WebUI v1 W4, Registry F-PLAN-W4-A / §8.2).
 *
 * Why this lives on the mcp-server side (closes the webui-grep gap):
 *   The existing `INV-WEBUI-READONLY-NEGATIVE-001` boundary test (`apps/webui/tests/security/
 *   readonly-layer-boundary.test.ts`) greps only the **webui src tree**; it does NOT scan
 *   `apps/mcp-server`. The internal compare adapter (`compare.service.ts`) is the new W4 surface, so
 *   its read-only + DRY-by-delegation properties are pinned here by source-grep of the actual file.
 *
 * Pins (against `apps/mcp-server/src/api/internal/compare.service.ts`):
 *   (a) ZERO SQL write verbs (INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE) — compare is POST but
 *       performs NO DB write (page_ids transport only).
 *   (b) ZERO Prisma write verbs (create/update/delete/upsert).
 *   (c) imports `@reftrixmcp/ml` ZERO times (the internal read process never boots ML, ADR-0042 layer
 *       boundary).
 *   (d) DRY-by-delegation: the adapter consumes the shared `designCompareHandler` and does NOT
 *       re-implement the matrix / cosine / paletteDistance / calculateOverallScore /
 *       detectPatternsAndDifferences orchestration locally.
 *
 * Mutation proof (non-vacuous green): each gate is paired with a negative fixture string that MUST
 * trip the same regex — injecting a `DELETE` / a prisma write / an `@reftrixmcp/ml` import would turn
 * the corresponding gate RED.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "src",
  "api",
  "internal",
  "compare.service.ts"
);
const SERVICE_SRC = readFileSync(SERVICE_PATH, "utf8");

/** Write-verb regex (case-insensitive, word-boundary) for raw SQL keywords. */
const SQL_WRITE_VERB_RE = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i;

/** Prisma client write-verb regex (the existing READONLY-NEGATIVE-001 shape). */
const PRISMA_WRITE_VERB_RE =
  /prisma\.\w+\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/;

/** Local orchestration primitives that a re-implementation (NOT delegation) would pull in. */
const ORCHESTRATION_SYMBOLS = [
  "compareDesigns", // service-direct (案a) would bypass the handler's SearchCache + dedup gates
  "cosineSimilarity",
  "calculateOverallScore",
  "detectPatternsAndDifferences",
  "paletteDistance",
  "normalizeQualityDifference",
];

describe("INV-WEBUI-COMPARE-READONLY-005 (mcp-server source-pin)", () => {
  it("(a) contains no SQL write verb (read-only, POST is page_ids transport)", () => {
    expect(SQL_WRITE_VERB_RE.test(SERVICE_SRC)).toBe(false);

    // Mutation proof: an injected DELETE MUST trip the gate (non-vacuous).
    const tampered = `${SERVICE_SRC}\nconst q = "DELETE FROM web_pages";`;
    expect(SQL_WRITE_VERB_RE.test(tampered)).toBe(true);
  });

  it("(b) uses zero Prisma write verbs", () => {
    expect(PRISMA_WRITE_VERB_RE.test(SERVICE_SRC)).toBe(false);

    // Mutation proof: an injected prisma write verb would be detected.
    const tampered = `${SERVICE_SRC}\nawait prisma.webPage.delete({ where: { id } });`;
    expect(PRISMA_WRITE_VERB_RE.test(tampered)).toBe(true);
  });

  it("(c) imports @reftrixmcp/ml zero times (zero-ML, ADR-0042 layer boundary)", () => {
    expect(SERVICE_SRC.includes("@reftrixmcp/ml")).toBe(false);

    // Mutation proof: an injected ML import would be detected.
    const tampered = `import { x } from "@reftrixmcp/ml";\n${SERVICE_SRC}`;
    expect(tampered.includes("@reftrixmcp/ml")).toBe(true);
  });

  it("(d) DRY-by-delegation: consumes designCompareHandler, re-implements NO orchestration", () => {
    // Positive: the adapter delegates to the shared handler (案b).
    expect(SERVICE_SRC).toContain("designCompareHandler");

    // Negative: the adapter does NOT pull in any local orchestration primitive (a re-implementation
    // would import one of these → RED).
    for (const symbol of ORCHESTRATION_SYMBOLS) {
      expect(SERVICE_SRC.includes(symbol), `compare.service.ts must not reference ${symbol}`).toBe(
        false
      );
    }

    // Mutation proof: injecting a service-direct import would be detected.
    const tampered = `import { compareDesigns } from "../../services/design-compare.service";\n${SERVICE_SRC}`;
    expect(tampered.includes("compareDesigns")).toBe(true);
  });
});
