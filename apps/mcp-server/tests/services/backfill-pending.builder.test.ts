// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * buildBackfillPending Tests (v0.4.0 PR6 TDA TD-3)
 *
 * Pure function として page-analyze-worker.ts から抽出された
 * `buildBackfillPending` のユニットテスト。副作用なし、DB 非依存。
 *
 * Unit tests for the pure function `buildBackfillPending` extracted from
 * page-analyze-worker.ts (no side effects, no DB dependency).
 */

import { describe, it, expect } from "vitest";
import {
  buildBackfillPending,
  buildSkipRecoveryBackfillPending,
  isBackfillPendingSourceConflict,
} from "../../src/services/backfill-pending.builder";
import {
  buildBackfillJobId,
  type EmbeddingBackfillCategory,
} from "../../src/queues/embedding-backfill-queue";

const WEB_PAGE_ID = "019bc123-4567-7890-abcd-ef1234567890";

describe("buildBackfillPending (v0.4.0 PR6 TDA TD-3)", () => {
  it("returns null when no category is enqueued", () => {
    const result = buildBackfillPending({
      partsSaved: 697,
      threshold: 100,
      avgMsPerItem: 5000,
      webPageId: WEB_PAGE_ID,
      enqueuedTextCategory: false,
      enqueuedVisualCategory: false,
    });
    expect(result).toBeNull();
  });

  it("builds text-only pending with estimatedCompletionAt", () => {
    const result = buildBackfillPending({
      partsSaved: 697,
      threshold: 100,
      avgMsPerItem: 5000,
      webPageId: WEB_PAGE_ID,
      enqueuedTextCategory: true,
      enqueuedVisualCategory: false,
    });
    expect(result).not.toBeNull();
    expect(result!.partTextPending).toBe(597);
    expect(result!.partVisualPending).toBe(0);
    expect(result!.jobIds).toEqual([buildBackfillJobId(WEB_PAGE_ID, "part_text")]);
    expect(result!.estimatedCompletionAt).toBeDefined();
    expect(() => new Date(result!.estimatedCompletionAt!)).not.toThrow();
  });

  it("builds text+visual pending with both jobIds", () => {
    const result = buildBackfillPending({
      partsSaved: 697,
      threshold: 100,
      avgMsPerItem: 5000,
      webPageId: WEB_PAGE_ID,
      enqueuedTextCategory: true,
      enqueuedVisualCategory: true,
    });
    expect(result).not.toBeNull();
    expect(result!.partTextPending).toBe(597);
    expect(result!.partVisualPending).toBe(597);
    expect(result!.jobIds).toEqual([
      buildBackfillJobId(WEB_PAGE_ID, "part_text"),
      buildBackfillJobId(WEB_PAGE_ID, "part_visual"),
    ]);
  });

  it("clamps remainder to 0 when partsSaved <= threshold", () => {
    const result = buildBackfillPending({
      partsSaved: 100,
      threshold: 100,
      avgMsPerItem: 5000,
      webPageId: WEB_PAGE_ID,
      enqueuedTextCategory: true,
      enqueuedVisualCategory: false,
    });
    expect(result).not.toBeNull();
    expect(result!.partTextPending).toBe(0);
    // maxPending=0 → no estimated completion
    expect(result!.estimatedCompletionAt).toBeUndefined();
  });

  it("handles NaN avgMsPerItem safely (no Infinity/NaN leak)", () => {
    const result = buildBackfillPending({
      partsSaved: 697,
      threshold: 100,
      avgMsPerItem: Number.NaN,
      webPageId: WEB_PAGE_ID,
      enqueuedTextCategory: true,
      enqueuedVisualCategory: false,
    });
    expect(result).not.toBeNull();
    expect(result!.estimatedCompletionAt).toBeUndefined();
  });

  it("handles Infinity avgMsPerItem safely", () => {
    const result = buildBackfillPending({
      partsSaved: 697,
      threshold: 100,
      avgMsPerItem: Number.POSITIVE_INFINITY,
      webPageId: WEB_PAGE_ID,
      enqueuedTextCategory: true,
      enqueuedVisualCategory: false,
    });
    expect(result).not.toBeNull();
    expect(result!.estimatedCompletionAt).toBeUndefined();
  });

  it("handles negative avgMsPerItem safely (treated as 0)", () => {
    const result = buildBackfillPending({
      partsSaved: 697,
      threshold: 100,
      avgMsPerItem: -1000,
      webPageId: WEB_PAGE_ID,
      enqueuedTextCategory: true,
      enqueuedVisualCategory: false,
    });
    expect(result).not.toBeNull();
    expect(result!.estimatedCompletionAt).toBeUndefined();
  });

  it("produces visual-only pending when text not enqueued", () => {
    const result = buildBackfillPending({
      partsSaved: 500,
      threshold: 100,
      avgMsPerItem: 5000,
      webPageId: WEB_PAGE_ID,
      enqueuedTextCategory: false,
      enqueuedVisualCategory: true,
    });
    expect(result).not.toBeNull();
    expect(result!.partTextPending).toBe(0);
    expect(result!.partVisualPending).toBe(400);
    expect(result!.jobIds).toEqual([buildBackfillJobId(WEB_PAGE_ID, "part_visual")]);
  });

  // PR7b (ADR-0008 #7): `source` discriminated union の regression check
  // PR7b (ADR-0008 #7): regression check for the `source` discriminated union
  it("sync_overflow variant carries source discriminator", () => {
    const result = buildBackfillPending({
      partsSaved: 200,
      threshold: 100,
      avgMsPerItem: 5000,
      webPageId: WEB_PAGE_ID,
      enqueuedTextCategory: true,
      enqueuedVisualCategory: true,
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("sync_overflow");
  });

  // ============================================================================
  // v0.4.0 PR7e-α (バグ⑥): section_visual backfill dispatch support
  // v0.4.0 PR7e-α (bug ⑥): section_visual backfill dispatch support
  // ============================================================================
  describe("PR7e-α bug⑥: section_visual category", () => {
    it("returns null when ONLY section_visual is false", () => {
      // 既存挙動維持: text/visual いずれも false なら null
      const result = buildBackfillPending({
        partsSaved: 697,
        threshold: 100,
        avgMsPerItem: 5000,
        webPageId: WEB_PAGE_ID,
        enqueuedTextCategory: false,
        enqueuedVisualCategory: false,
        enqueuedSectionVisualCategory: false,
      });
      expect(result).toBeNull();
    });

    it("returns pending when ONLY section_visual is enqueued", () => {
      const result = buildBackfillPending({
        partsSaved: 50, // below threshold — no part remainder
        threshold: 100,
        avgMsPerItem: 5000,
        webPageId: WEB_PAGE_ID,
        enqueuedTextCategory: false,
        enqueuedVisualCategory: false,
        enqueuedSectionVisualCategory: true,
      });
      expect(result).not.toBeNull();
      expect(result!.partTextPending).toBe(0);
      expect(result!.partVisualPending).toBe(0);
      expect(result!.sectionVisualPending).toBe(0);
      expect(result!.jobIds).toEqual([buildBackfillJobId(WEB_PAGE_ID, "section_visual")]);
    });

    it("includes section_visual jobId alongside part_text / part_visual", () => {
      const result = buildBackfillPending({
        partsSaved: 697,
        threshold: 100,
        avgMsPerItem: 5000,
        webPageId: WEB_PAGE_ID,
        enqueuedTextCategory: true,
        enqueuedVisualCategory: true,
        enqueuedSectionVisualCategory: true,
      });
      expect(result!.jobIds).toEqual([
        buildBackfillJobId(WEB_PAGE_ID, "part_text"),
        buildBackfillJobId(WEB_PAGE_ID, "part_visual"),
        buildBackfillJobId(WEB_PAGE_ID, "section_visual"),
      ]);
      expect(result!.sectionVisualPending).toBe(0);
    });

    it("omits sectionVisualPending when section_visual is NOT enqueued", () => {
      const result = buildBackfillPending({
        partsSaved: 697,
        threshold: 100,
        avgMsPerItem: 5000,
        webPageId: WEB_PAGE_ID,
        enqueuedTextCategory: true,
        enqueuedVisualCategory: true,
        // enqueuedSectionVisualCategory undefined
      });
      expect(result!.sectionVisualPending).toBeUndefined();
    });
  });
});

// ============================================================================
// buildSkipRecoveryBackfillPending — PR7b (v0.4.0 / ADR-0008 #7)
// ============================================================================

describe("buildSkipRecoveryBackfillPending (v0.4.0 PR7b / ADR-0008 #7)", () => {
  const FIXED_NOW = new Date("2026-04-13T10:00:00.000Z");
  const ALL_SEVEN: EmbeddingBackfillCategory[] = [
    "part_text",
    "part_visual",
    "section_visual",
    "motion",
    "background",
    "js_animation",
    "responsive",
  ];

  it("builds skip_recovery payload for skipped_fork_error with all 7 categories", () => {
    const result = buildSkipRecoveryBackfillPending({
      skipReason: "text_fork_failed",
      enqueuedCategories: ALL_SEVEN,
      retryCount: 1,
      enqueuedAt: FIXED_NOW,
    });
    expect(result.source).toBe("skip_recovery");
    expect(result.skipReason).toBe("text_fork_failed");
    expect(result.enqueuedCategories).toEqual(ALL_SEVEN);
    expect(result.retryCount).toBe(1);
    expect(result.enqueuedAt).toBe(FIXED_NOW.toISOString());
  });

  it("builds skip_recovery payload for skipped_memory_pressure (system_memavailable_low)", () => {
    const result = buildSkipRecoveryBackfillPending({
      skipReason: "system_memavailable_low",
      enqueuedCategories: ["part_text", "motion", "responsive"], // no screenshot → only 3
      retryCount: 2,
      enqueuedAt: FIXED_NOW,
    });
    expect(result.source).toBe("skip_recovery");
    expect(result.skipReason).toBe("system_memavailable_low");
    expect(result.enqueuedCategories).toEqual(["part_text", "motion", "responsive"]);
    expect(result.retryCount).toBe(2);
  });

  it("accepts retryCount boundary values 0 and 5 (within SKIP_RECOVERY_RETRY_CAP)", () => {
    const lo = buildSkipRecoveryBackfillPending({
      skipReason: "v8_heap_headroom_low",
      enqueuedCategories: ["part_text"],
      retryCount: 0,
      enqueuedAt: FIXED_NOW,
    });
    expect(lo.retryCount).toBe(0);

    const hi = buildSkipRecoveryBackfillPending({
      skipReason: "v8_heap_headroom_low",
      enqueuedCategories: ["part_text"],
      retryCount: 5,
      enqueuedAt: FIXED_NOW,
    });
    expect(hi.retryCount).toBe(5);
  });

  it("clamps negative retryCount to 0", () => {
    const result = buildSkipRecoveryBackfillPending({
      skipReason: "visual_fork_failed",
      enqueuedCategories: ["section_visual"],
      retryCount: -1,
      enqueuedAt: FIXED_NOW,
    });
    expect(result.retryCount).toBe(0);
  });

  it("clamps non-finite retryCount (NaN/Infinity) to 0", () => {
    const nan = buildSkipRecoveryBackfillPending({
      skipReason: "dispatch_phase_failed",
      enqueuedCategories: ["part_text"],
      retryCount: Number.NaN,
      enqueuedAt: FIXED_NOW,
    });
    expect(nan.retryCount).toBe(0);

    const inf = buildSkipRecoveryBackfillPending({
      skipReason: "dispatch_phase_failed",
      enqueuedCategories: ["part_text"],
      retryCount: Number.POSITIVE_INFINITY,
      enqueuedAt: FIXED_NOW,
    });
    expect(inf.retryCount).toBe(0);
  });

  it("falls back to current ISO timestamp when enqueuedAt is Invalid Date", () => {
    const result = buildSkipRecoveryBackfillPending({
      skipReason: "text_child_abnormal_exit",
      enqueuedCategories: ["part_text"],
      retryCount: 1,
      enqueuedAt: new Date("invalid"),
    });
    // Must still be a valid ISO-8601 string (not "Invalid Date")
    expect(() => new Date(result.enqueuedAt)).not.toThrow();
    expect(Number.isFinite(new Date(result.enqueuedAt).getTime())).toBe(true);
  });

  it("copies enqueuedCategories defensively (no shared reference)", () => {
    const source: EmbeddingBackfillCategory[] = ["part_text", "part_visual"];
    const result = buildSkipRecoveryBackfillPending({
      skipReason: "text_ipc_race",
      enqueuedCategories: source,
      retryCount: 1,
      enqueuedAt: FIXED_NOW,
    });
    source.push("motion");
    expect(result.enqueuedCategories).toEqual(["part_text", "part_visual"]);
  });

  it("discriminates between sync_overflow and skip_recovery via source field", () => {
    const syncOverflow = buildBackfillPending({
      partsSaved: 200,
      threshold: 100,
      avgMsPerItem: 5000,
      webPageId: WEB_PAGE_ID,
      enqueuedTextCategory: true,
      enqueuedVisualCategory: false,
    });
    const skipRecovery = buildSkipRecoveryBackfillPending({
      skipReason: "text_fork_failed",
      enqueuedCategories: ["part_text"],
      retryCount: 1,
      enqueuedAt: FIXED_NOW,
    });
    expect(syncOverflow!.source).toBe("sync_overflow");
    expect(skipRecovery.source).toBe("skip_recovery");
    // Ensure TypeScript narrowing reaches into variant-specific fields
    if (skipRecovery.source === "skip_recovery") {
      expect(skipRecovery.skipReason).toBe("text_fork_failed");
    }
    if (syncOverflow && syncOverflow.source === "sync_overflow") {
      expect(syncOverflow.partTextPending).toBe(100);
    }
  });
});

// ============================================================================
// isBackfillPendingSourceConflict — ADR-0008 invariant guard
// ============================================================================

describe("isBackfillPendingSourceConflict (v0.4.0 PR7b / ADR-0008 #7)", () => {
  const FIXED_NOW = new Date("2026-04-13T10:00:00.000Z");

  const syncOverflow = buildBackfillPending({
    partsSaved: 200,
    threshold: 100,
    avgMsPerItem: 5000,
    webPageId: WEB_PAGE_ID,
    enqueuedTextCategory: true,
    enqueuedVisualCategory: false,
  });
  const skipRecovery = buildSkipRecoveryBackfillPending({
    skipReason: "text_fork_failed",
    enqueuedCategories: ["part_text"],
    retryCount: 1,
    enqueuedAt: FIXED_NOW,
  });

  it("returns false when only sync_overflow is present", () => {
    expect(isBackfillPendingSourceConflict(syncOverflow, null)).toBe(false);
    expect(isBackfillPendingSourceConflict(syncOverflow, undefined)).toBe(false);
  });

  it("returns false when only skip_recovery is present", () => {
    expect(isBackfillPendingSourceConflict(null, skipRecovery)).toBe(false);
    expect(isBackfillPendingSourceConflict(undefined, skipRecovery)).toBe(false);
  });

  it("returns false when neither is present", () => {
    expect(isBackfillPendingSourceConflict(null, null)).toBe(false);
    expect(isBackfillPendingSourceConflict(undefined, undefined)).toBe(false);
  });

  it("returns true when both sync_overflow and skip_recovery are present (ADR-0008 violation)", () => {
    expect(isBackfillPendingSourceConflict(syncOverflow, skipRecovery)).toBe(true);
  });
});
