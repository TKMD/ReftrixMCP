// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CO-SAMEURL-02 D1 — fail-open key-missing transient discrimination (unit).
 *
 * `handleFailOpen` inner catch (`enqueue-with-collision-guard.ts`) discriminates
 * the BullMQ "Missing key for job …" transient (raised under a same-URL race
 * when a loser re-adds the same jobId mid-lifecycle) from a generic fail-open
 * add failure, emitting a DISTINCT structured warn. Pure observability: the
 * returned outcome is `enqueued_fail_open` in BOTH branches (dedup logic
 * unchanged; D1 never flips fail-open → fail-closed).
 *
 * Non-vacuity (large-page domain):
 *   - key-missing message → distinct transient warn fires (NOT the generic warn);
 *   - non-key-missing message → generic warn still fires (the discrimination
 *     does not swallow real failures);
 *   - outcome === "enqueued_fail_open" in both cases (behaviour preserved).
 * Mutation: reverting the regex discrimination → the distinct transient warn
 * never fires for the key-missing case → RED.
 *
 * @see  §Sub-item 4 / §UB-6
 * @see apps/mcp-server/src/queues/enqueue-with-collision-guard.ts (BULLMQ_KEY_MISSING_TRANSIENT_RE)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/utils/logger";
import {
  BULLMQ_KEY_MISSING_TRANSIENT_RE,
  enqueueWithCollisionGuard,
  type EnqueueWithCollisionGuardOptions,
} from "../../src/queues/enqueue-with-collision-guard";

// ============================================================================
// Helpers — minimal fail-open-forcing mock queue
// ============================================================================

interface FakeJobData {
  marker: string;
}

/**
 * Build options whose `queue.client` rejects (forcing the fail-open path in
 * `enqueueWithCollisionGuard`) and whose `queue.add` throws `addError` so the
 * inner `handleFailOpen` catch is exercised.
 */
function buildFailOpenOptions(
  addError: unknown
): EnqueueWithCollisionGuardOptions<FakeJobData, unknown> {
  const queue = {
    // Rejecting `client` short-circuits enqueueWithCollisionGuard → handleFailOpen.
    get client(): Promise<never> {
      return Promise.reject(new Error("redis unreachable"));
    },
    add: vi.fn(async () => {
      throw addError;
    }),
  } as unknown as EnqueueWithCollisionGuardOptions<FakeJobData, unknown>["queue"];

  return {
    queue,
    queueName: "page-analyze",
    jobId: "00000000-0000-5000-8000-000000000abc",
    data: { marker: "co-sameurl-02-d1" },
    jobOptions: { priority: 10 },
    claimKeyNamespace: "page-analyze",
    webPageId: "11111111-1111-7111-8111-111111111111",
  };
}

const TRANSIENT_WARN =
  "[EnqueueWithCollisionGuard] fail-open queue.add hit BullMQ key-missing transient";
const GENERIC_WARN = "[EnqueueWithCollisionGuard] fail-open queue.add also failed";

function warnMessagesFrom(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

// ============================================================================
// SSOT regex pure assertions (no Redis)
// ============================================================================

describe("CO-SAMEURL-02 D1: BULLMQ_KEY_MISSING_TRANSIENT_RE SSOT regex", () => {
  it("matches the BullMQ key-missing updateProgress transient", () => {
    // INV (large-page): the production fail-open transient shape.
    expect(
      BULLMQ_KEY_MISSING_TRANSIENT_RE.test(
        "Missing key for job bull:page-analyze:abc.updateProgress"
      )
    ).toBe(true);
    expect(BULLMQ_KEY_MISSING_TRANSIENT_RE.test("Missing key for job abc.moveToActive")).toBe(true);
    expect(BULLMQ_KEY_MISSING_TRANSIENT_RE.test("Missing key for job abc.lock")).toBe(true);
  });

  it("does NOT over-match unrelated / security-relevant errors (anchor + lazy)", () => {
    // `^` anchor: a leading prefix must NOT match (no embedded over-match).
    expect(
      BULLMQ_KEY_MISSING_TRANSIENT_RE.test("SSRF blocked: Missing key for job abc.updateProgress")
    ).toBe(false);
    // Missing the lifecycle keyword → not a transient.
    expect(BULLMQ_KEY_MISSING_TRANSIENT_RE.test("Missing key for job abc")).toBe(false);
    expect(BULLMQ_KEY_MISSING_TRANSIENT_RE.test("Connection refused")).toBe(false);
    expect(BULLMQ_KEY_MISSING_TRANSIENT_RE.test("ENOTFOUND example.com")).toBe(false);
  });

  it("does NOT match across a newline (multi-line over-match closure, TDA-IMPL-L-01)", () => {
    // `[^\n]*?` excludes newlines: a multi-line message whose `Missing key for
    // job` line and the lifecycle keyword line are separated by `\n` must NOT
    // be classified as a transient (cross-newline over-match closure).
    expect(BULLMQ_KEY_MISSING_TRANSIENT_RE.test("Missing key for job abc\nupdateProgress")).toBe(
      false
    );
    expect(BULLMQ_KEY_MISSING_TRANSIENT_RE.test("Missing key for job abc\nmoveToActive")).toBe(
      false
    );
    expect(BULLMQ_KEY_MISSING_TRANSIENT_RE.test("Missing key for job abc\nlock")).toBe(false);
    // same-line still matches (real BullMQ transient is single-line).
    expect(BULLMQ_KEY_MISSING_TRANSIENT_RE.test("Missing key for job abc. updateProgress")).toBe(
      true
    );
  });
});

// ============================================================================
// handleFailOpen discrimination (behaviour-preserved, non-vacuity)
// ============================================================================

describe("CO-SAMEURL-02 D1: handleFailOpen transient discrimination", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("key-missing transient → distinct transient warn fires, generic warn does NOT, outcome unchanged", async () => {
    const options = buildFailOpenOptions(
      new Error("Missing key for job bull:page-analyze:abc.updateProgress")
    );

    const result = await enqueueWithCollisionGuard(options);

    // Behaviour preserved: still fail-open (dedup logic unchanged).
    expect(result.outcome).toBe("enqueued_fail_open");

    const messages = warnMessagesFrom(warnSpy);
    // Distinct transient warn fires.
    expect(messages.some((m) => m.startsWith(TRANSIENT_WARN))).toBe(true);
    // Generic add-failure warn does NOT fire for the key-missing case.
    expect(messages.some((m) => m.startsWith(GENERIC_WARN))).toBe(false);
  });

  it("non-key-missing error → generic warn STILL fires (discrimination does not swallow real failures), outcome unchanged", async () => {
    const options = buildFailOpenOptions(new Error("Connection refused"));

    const result = await enqueueWithCollisionGuard(options);

    expect(result.outcome).toBe("enqueued_fail_open");

    const messages = warnMessagesFrom(warnSpy);
    // Generic warn fires for the non-transient error (non-vacuity).
    expect(messages.some((m) => m.startsWith(GENERIC_WARN))).toBe(true);
    // The distinct transient warn does NOT fire (no mis-classification).
    expect(messages.some((m) => m.startsWith(TRANSIENT_WARN))).toBe(false);
  });

  it("PII guard: the transient warn truncates jobId and does not leak the full UUID", async () => {
    const options = buildFailOpenOptions(new Error("Missing key for job abc.lock"));

    await enqueueWithCollisionGuard(options);

    const transientCall = warnSpy.mock.calls.find((c) => String(c[0]).startsWith(TRANSIENT_WARN));
    expect(transientCall).toBeDefined();
    const meta = transientCall?.[1] as { jobId?: string } | undefined;
    // Truncated jobId (8 chars + ellipsis), NOT the full 36-char UUID.
    expect(meta?.jobId).toBe("00000000...");
    expect(meta?.jobId).not.toContain("000000000abc");
  });
});
