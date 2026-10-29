// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod 4 bump contract; GHSA-mrhx-c7xc-m3w5, CWE-770)
 *
 * INV-ZOD-OVERSIZED-ARRAY-BOUNDED-001: an array that is over its `.max()` is rejected without
 * walking every element. zod 3 (and zod < 4.6.6) validates all elements of an oversized array
 * and returns one issue per bad element, so a 1e6-element input costs time, heap and a 1e6-issue
 * error object that the tool layer then formats. After the bump the cost of rejecting an oversized
 * array stays small and the number of issues does not grow with the number of elements.
 *
 *  (a) product schemas (part.compare part_ids, part.search tags) reject 1e5 and 1e6 elements with
 *      a bounded issue count, time and heap growth
 *  (b) positive control: the same measurement on the bundled zod 3 (`zod/v3`) violates the bound,
 *      so the thresholds are not vacuous (this is the RED measured on zod 3)
 */
import { describe, it, expect } from "vitest";
import { z as z3 } from "zod/v3";

import { partCompareInputSchema, partSearchInputSchema } from "../../src/services/part/schemas";

const MAX_ISSUES = 10;
const MAX_MS = 2000;
const MAX_HEAP_MB = 100;

interface Measure {
  success: boolean;
  issues: number;
  ms: number;
  heapMb: number;
}

function measure(parse: (input: unknown) => { success: boolean; issues: number }, input: unknown) {
  globalThis.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const r = parse(input);
  const ms = performance.now() - t0;
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1e6;
  return { ...r, ms, heapMb } satisfies Measure;
}

const strings = (n: number): string[] => Array.from({ length: n }, (_, i) => `x${i}`);
const UUID = "019bc123-4567-7890-abcd-ef1234567890";

describe("INV-ZOD-OVERSIZED-ARRAY-BOUNDED-001", () => {
  describe.each([1e5, 1e6])("(a) %d elements", (n) => {
    it("part.compare part_ids: rejected with a bounded issue count, time and heap", () => {
      const m = measure((input) => {
        const r = partCompareInputSchema.safeParse({ part_ids: input });
        return { success: r.success, issues: r.success ? 0 : r.error.issues.length };
      }, strings(n));
      expect(m.success).toBe(false);
      expect(m.issues).toBeGreaterThan(0);
      expect(m.issues).toBeLessThanOrEqual(MAX_ISSUES);
      expect(m.ms).toBeLessThan(MAX_MS);
      expect(m.heapMb).toBeLessThan(MAX_HEAP_MB);
    });

    it("part.search tags: rejected with a bounded issue count, time and heap", () => {
      const m = measure(
        (input) => {
          const r = partSearchInputSchema.safeParse({ query: "q", tags: input });
          return { success: r.success, issues: r.success ? 0 : r.error.issues.length };
        },
        Array.from({ length: n }, () => "x".repeat(60))
      );
      expect(m.success).toBe(false);
      expect(m.issues).toBeLessThanOrEqual(MAX_ISSUES);
      expect(m.ms).toBeLessThan(MAX_MS);
      expect(m.heapMb).toBeLessThan(MAX_HEAP_MB);
    });

    it("the issue count does not depend on the element count", () => {
      const count = (k: number): number => {
        const r = partCompareInputSchema.safeParse({ part_ids: strings(k) });
        return r.success ? 0 : r.error.issues.length;
      };
      expect(count(n)).toBe(count(100));
    });
  });

  it("an in-bounds input still parses (the bound is not a blanket reject)", () => {
    expect(partCompareInputSchema.safeParse({ part_ids: [UUID, UUID] }).success).toBe(true);
  });

  it("(b) positive control: the zod 3 equivalent of part_ids returns one issue per element", () => {
    const schema = z3.array(z3.string().uuid()).min(2).max(5);
    const m = measure((input) => {
      const r = schema.safeParse(input);
      return { success: r.success, issues: r.success ? 0 : r.error.issues.length };
    }, strings(1e5));
    expect(m.success).toBe(false);
    expect(m.issues).toBeGreaterThan(MAX_ISSUES);
  });
});
