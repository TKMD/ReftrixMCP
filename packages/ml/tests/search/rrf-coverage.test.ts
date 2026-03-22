// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RRF Additional Coverage Tests
 *
 * Tests for remaining uncovered branches in search/rrf.ts:
 * - Development log output (NODE_ENV=development)
 * - mergeWithRRF when items appear in both result sets (existing item branch)
 * - normalizeRRFScore edge cases
 *
 * @module tests/search/rrf-coverage
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mergeWithRRF,
  normalizeRRFScore,
  calculateRRF,
  type RankedItem,
} from "../../src/search/rrf.js";

describe("RRF - development logging", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("should output log in development mode", () => {
    process.env.NODE_ENV = "development";
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const vectorResults: RankedItem[] = [{ id: "a", rank: 1, name: "A" }];
    const fulltextResults: RankedItem[] = [{ id: "b", rank: 1, name: "B" }];

    mergeWithRRF(vectorResults, fulltextResults);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Search] RRF merge completed:"),
      expect.objectContaining({
        vectorCount: 1,
        fulltextCount: 1,
        mergedCount: 2,
      })
    );

    consoleSpy.mockRestore();
  });

  it("should not output log in production mode", () => {
    process.env.NODE_ENV = "production";
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const vectorResults: RankedItem[] = [{ id: "a", rank: 1, name: "A" }];
    const fulltextResults: RankedItem[] = [];

    mergeWithRRF(vectorResults, fulltextResults);

    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe("RRF - mergeWithRRF item merge branches", () => {
  it("should merge scores when same item appears in both vector and fulltext results", () => {
    const vectorResults: RankedItem[] = [
      { id: "shared", rank: 1, name: "Shared Item", extra: "vector-data" },
      { id: "vector-only", rank: 2, name: "Vector Only" },
    ];
    const fulltextResults: RankedItem[] = [
      { id: "shared", rank: 1, name: "Shared Item", extra: "fulltext-data" },
      { id: "fulltext-only", rank: 2, name: "Fulltext Only" },
    ];

    const result = mergeWithRRF(vectorResults, fulltextResults);

    // "shared" should have combined score from both sources
    const sharedItem = result.find((r) => r.id === "shared");
    expect(sharedItem).toBeDefined();
    expect(sharedItem!.vectorRank).toBe(1);
    expect(sharedItem!.fulltextRank).toBe(1);

    // Combined RRF score should be higher than either alone
    const vectorOnlyItem = result.find((r) => r.id === "vector-only");
    expect(sharedItem!.rrfScore).toBeGreaterThan(vectorOnlyItem!.rrfScore);

    // "shared" should appear first (highest score)
    expect(result[0]!.id).toBe("shared");
  });

  it("should handle existing item in vector results when processing fulltext results", () => {
    const vectorResults: RankedItem[] = [{ id: "item-1", rank: 1, name: "Item 1" }];
    const fulltextResults: RankedItem[] = [{ id: "item-1", rank: 1, name: "Item 1 FT" }];

    const result = mergeWithRRF(vectorResults, fulltextResults);

    expect(result).toHaveLength(1);
    expect(result[0]!.vectorRank).toBe(1);
    expect(result[0]!.fulltextRank).toBe(1);
  });

  it("should use custom weights", () => {
    const vectorResults: RankedItem[] = [{ id: "a", rank: 1, name: "A" }];
    const fulltextResults: RankedItem[] = [{ id: "b", rank: 1, name: "B" }];

    const result = mergeWithRRF(vectorResults, fulltextResults, 0.8, 0.2);

    const itemA = result.find((r) => r.id === "a")!;
    const itemB = result.find((r) => r.id === "b")!;

    // Vector weighted higher, so A should score more
    expect(itemA.rrfScore).toBeGreaterThan(itemB.rrfScore);
  });
});

describe("RRF - normalizeRRFScore", () => {
  it("should normalize score with default max", () => {
    const score = calculateRRF(1, 60) * 0.6 + calculateRRF(1, 60) * 0.4;
    const normalized = normalizeRRFScore(score);
    expect(normalized).toBeCloseTo(1.0, 4);
  });

  it("should normalize score with custom max", () => {
    const score = 0.5;
    const normalized = normalizeRRFScore(score, 1.0);
    expect(normalized).toBeCloseTo(0.5, 4);
  });

  it("should cap at 1.0 for scores exceeding max", () => {
    const normalized = normalizeRRFScore(2.0, 1.0);
    expect(normalized).toBe(1.0);
  });

  it("should return 0 for zero score", () => {
    const normalized = normalizeRRFScore(0);
    expect(normalized).toBe(0);
  });
});
