// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * backfillPending Zod Discriminated Union Schema Tests
 * (v0.4.0 PR7b / ADR-0008 #7)
 *
 * `page.analyze` / `page.getJobStatus` MCP response の `backfillPending`
 * discriminated union が `source` フィールドで正しく判別され、両 variant の
 * 入力を runtime で検証できることを保証する。
 *
 * Ensures the `backfillPending` discriminated union in the `page.analyze` /
 * `page.getJobStatus` MCP response is correctly discriminated on `source` and
 * validates both variants at runtime.
 */

import { describe, it, expect } from "vitest";
import {
  backfillPendingSchema,
  backfillPendingSkipRecoverySchema,
  backfillPendingSyncOverflowSchema,
} from "../../../src/tools/page/output.schemas";

describe("backfillPendingSchema — discriminated union (PR7b / ADR-0008 #7)", () => {
  it("parses a sync_overflow payload", () => {
    const payload = {
      source: "sync_overflow" as const,
      partTextPending: 597,
      partVisualPending: 0,
      jobIds: ["019bc123-4567-7890-abcd-ef1234567890:part_text"],
      estimatedCompletionAt: "2026-04-13T11:00:00.000Z",
    };
    const parsed = backfillPendingSchema.parse(payload);
    expect(parsed.source).toBe("sync_overflow");
    if (parsed.source === "sync_overflow") {
      expect(parsed.partTextPending).toBe(597);
      expect(parsed.jobIds).toHaveLength(1);
    }
  });

  it("parses a skip_recovery payload", () => {
    const payload = {
      source: "skip_recovery" as const,
      skipReason: "text_fork_failed",
      enqueuedCategories: ["part_text", "motion", "responsive"],
      retryCount: 1,
      enqueuedAt: "2026-04-13T10:00:00.000Z",
    };
    const parsed = backfillPendingSchema.parse(payload);
    expect(parsed.source).toBe("skip_recovery");
    if (parsed.source === "skip_recovery") {
      expect(parsed.skipReason).toBe("text_fork_failed");
      expect(parsed.enqueuedCategories).toEqual(["part_text", "motion", "responsive"]);
    }
  });

  it("rejects payload with unknown source", () => {
    const invalid = {
      source: "bogus",
      partTextPending: 0,
      partVisualPending: 0,
      jobIds: [],
    };
    expect(() => backfillPendingSchema.parse(invalid)).toThrow();
  });

  it("rejects skip_recovery with invalid skipReason (SSOT superRefine)", () => {
    const invalid = {
      source: "skip_recovery",
      skipReason: "not_a_real_reason",
      enqueuedCategories: ["part_text"],
      retryCount: 1,
      enqueuedAt: "2026-04-13T10:00:00.000Z",
    };
    expect(() => backfillPendingSkipRecoverySchema.parse(invalid)).toThrow(/Invalid skipReason/);
  });

  it("rejects skip_recovery with invalid enqueuedCategory (SSOT superRefine)", () => {
    const invalid = {
      source: "skip_recovery",
      skipReason: "text_fork_failed",
      enqueuedCategories: ["part_text", "not_a_category"],
      retryCount: 1,
      enqueuedAt: "2026-04-13T10:00:00.000Z",
    };
    expect(() => backfillPendingSkipRecoverySchema.parse(invalid)).toThrow(
      /Invalid backfill category/
    );
  });

  it("rejects skip_recovery with retryCount out of bounds", () => {
    const tooHigh = {
      source: "skip_recovery",
      skipReason: "text_fork_failed",
      enqueuedCategories: ["part_text"],
      retryCount: 99,
      enqueuedAt: "2026-04-13T10:00:00.000Z",
    };
    expect(() => backfillPendingSkipRecoverySchema.parse(tooHigh)).toThrow();
  });

  it("rejects skip_recovery with non-ISO enqueuedAt", () => {
    const invalid = {
      source: "skip_recovery",
      skipReason: "text_fork_failed",
      enqueuedCategories: ["part_text"],
      retryCount: 1,
      enqueuedAt: "13 Apr 2026 10:00",
    };
    expect(() => backfillPendingSkipRecoverySchema.parse(invalid)).toThrow();
  });

  it("accepts sync_overflow without estimatedCompletionAt (optional)", () => {
    const payload = {
      source: "sync_overflow",
      partTextPending: 0,
      partVisualPending: 0,
      jobIds: [],
    };
    const parsed = backfillPendingSyncOverflowSchema.parse(payload);
    expect(parsed.estimatedCompletionAt).toBeUndefined();
  });

  it("accepts all 12 EMBEDDING_SKIP_REASONS values", () => {
    const reasons = [
      "v8_heap_headroom_low",
      "system_memavailable_low",
      "text_fork_failed",
      "text_child_error",
      "text_child_abnormal_exit",
      "text_ipc_race",
      "visual_fork_failed",
      "visual_child_error",
      "visual_child_abnormal_exit",
      "visual_ipc_race",
      "no_embeddable_items",
      "dispatch_phase_failed",
    ];
    for (const skipReason of reasons) {
      const payload = {
        source: "skip_recovery" as const,
        skipReason,
        enqueuedCategories: ["part_text"],
        retryCount: 0,
        enqueuedAt: "2026-04-13T10:00:00.000Z",
      };
      expect(() => backfillPendingSkipRecoverySchema.parse(payload)).not.toThrow();
    }
  });
});
