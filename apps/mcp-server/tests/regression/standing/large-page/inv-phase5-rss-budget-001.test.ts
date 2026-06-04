// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PHASE5-RSS-BUDGET-001 (PR-V3-T1a §3.2)
 *
 * FIND-V3-IO-H-01 closure target / Plan v3 V2 §3.1 T1.1-T1.3 / design §3.2
 * (`pr-v3-t1a-design.md`). Exercises the contract surface of the streaming
 * chunked encoder hardening (C1-C4) introduced by PR-V3-T1a:
 *
 *   - C1: per-chunk RSS budget enforcement (constant + telemetry shape)
 *   - C2: streaming flush ordering invariant (mandatory `global.gc()` under
 *         hardening flag; legacy fallback when `--expose-gc` absent)
 *   - C3: failure-path partial-flush prevention (telemetry shape +
 *         `embedding_skip_reason` + `audit_logs` emission contract)
 *   - C4: idempotency-on-retry skip-detection (telemetry shape + audit emit)
 *
 * is a CI-failing executable invariant. `.skip()` / `.todo()` are forbidden;
 * any failure is a P0 incident handled by pipeline-engineer +
 * capture-embedding-engineer.
 *
 * Per design §3.2: 9-case test plan covers C1 (Cases 1-3, 8), C2 (Cases 5-6),
 * C3 (Case 7), C4 (Case 9). Cases that depend on full Phase 5 fork harness
 * + ONNX Runtime are surfaced through deterministic contract checks
 * (telemetry shape / audit emission / SSOT skip-reason values) rather than
 * end-to-end fork execution to keep CI runtime bounded.
 *
 * Standing regression for INV-PHASE5-RSS-BUDGET-001 (PR-V3-T1a §3.2 C1-C4
 *
 * @see  §3.2
 * @see
 *
 * @module tests/regression/standing/large-page/inv-phase5-rss-budget-001
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  PER_CHUNK_RSS_BUDGET_MB,
  isPhase5TextChunkedEncoderHardenedEnabled,
  PHASE5_TEXT_CHUNKED_ENCODER_HARDENED_ENV,
  EMBEDDING_SKIP_REASONS,
} from "../../../../src/workers/phases/types";
import { emitChunkedEncoderTelemetryAudit } from "../../../../src/workers/phases/phase-5-fork-orchestrator";
import {
  buildParentRssCeilingScaledDetails,
  isParentRssCeilingScalingEvent,
  __resetParentRssCeilingScaledForTesting,
  __isParentRssCeilingScaledEmittedForTesting,
  emitParentRssCeilingScaledIfApplicable,
  LEGACY_PARENT_RSS_MAX_MB_PRE_T1A,
} from "../../../../src/config/phase5-config";
import {
  getAuditLogService,
  bootstrapAuditLogServiceForScript,
  resetAuditLogPrismaClientFactory,
} from "../../../../src/services/audit-log.service";
import { childTextResultSchema } from "../../../../src/workers/phases/phase-5-child-ipc";

describe("INV-PHASE5-RSS-BUDGET-001: PR-V3-T1a streaming chunked encoder hardening", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PHASE5-RSS-BUDGET-001");
  });

  describe("C1: per-chunk RSS budget enforcement", () => {
    it("INV-PHASE5-RSS-BUDGET-001 Case 1: PER_CHUNK_RSS_BUDGET_MB has a sane default (256-8192 MB)", () => {
      // Design §3.2 C1: budget default 1.5 GB; range guard 256 MB - 8192 MB.
      // Strictly tighter than `PHASE5_CHILD_RSS_KILL_DELTA_MB = 4096` so the
      // process-wide kill threshold remains a fail-safe backstop.
      expect(PER_CHUNK_RSS_BUDGET_MB).toBeGreaterThanOrEqual(256);
      expect(PER_CHUNK_RSS_BUDGET_MB).toBeLessThanOrEqual(8192);
      expect(PER_CHUNK_RSS_BUDGET_MB).toBeLessThan(4096);
    });

    it("INV-PHASE5-RSS-BUDGET-001 Case 2: SSOT enum contains text_child_memory_budget_exceeded_at_chunk_<n>", () => {
      // Design §3.4.1: bare canonical form is the SSOT entry; runtime emission
      // interpolates `<n>` into details, NOT into the action column.
      expect(EMBEDDING_SKIP_REASONS).toContain("text_child_memory_budget_exceeded_at_chunk_<n>");
    });

    it("INV-PHASE5-RSS-BUDGET-001 Case 3: feature flag default is enabled (hardening on)", () => {
      const previous = process.env[PHASE5_TEXT_CHUNKED_ENCODER_HARDENED_ENV];
      try {
        delete process.env[PHASE5_TEXT_CHUNKED_ENCODER_HARDENED_ENV];
        expect(isPhase5TextChunkedEncoderHardenedEnabled()).toBe(true);
        // Setting any non-"false" value keeps it enabled.
        process.env[PHASE5_TEXT_CHUNKED_ENCODER_HARDENED_ENV] = "true";
        expect(isPhase5TextChunkedEncoderHardenedEnabled()).toBe(true);
        // Only exact case-insensitive "false" disables.
        process.env[PHASE5_TEXT_CHUNKED_ENCODER_HARDENED_ENV] = "false";
        expect(isPhase5TextChunkedEncoderHardenedEnabled()).toBe(false);
        process.env[PHASE5_TEXT_CHUNKED_ENCODER_HARDENED_ENV] = "FALSE";
        expect(isPhase5TextChunkedEncoderHardenedEnabled()).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env[PHASE5_TEXT_CHUNKED_ENCODER_HARDENED_ENV];
        } else {
          process.env[PHASE5_TEXT_CHUNKED_ENCODER_HARDENED_ENV] = previous;
        }
      }
    });

    it("INV-PHASE5-RSS-BUDGET-001 Case 8: childTextResultSchema accepts budgetExceededChunkIndex telemetry", () => {
      // Design §3.2 C1: budget overshoot drives a partial-completion event;
      // the IPC schema must additively accept the telemetry without breaking
      // legacy callers (forward compatibility).
      const result = childTextResultSchema.safeParse({
        type: "text-result",
        sectionEmbeddingsGenerated: 60,
        motionEmbeddingsGenerated: 0,
        bgEmbeddingsGenerated: 0,
        jsAnimationEmbeddingsGenerated: 0,
        responsiveEmbeddingsGenerated: 0,
        partEmbeddingsGenerated: 0,
        embeddingFailedChunks: 0,
        chunkedEncoderTelemetry: {
          partialCompletion: { chunksDone: 3, totalChunks: 7 },
          budgetExceededChunkIndex: 3,
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("C2: streaming flush ordering invariant", () => {
    it("INV-PHASE5-RSS-BUDGET-001 Case 5: childTextResultSchema legacy payload (no telemetry) still validates", () => {
      // Design §3.2 C2: under feature-flag-off (legacy path) or chunk loop
      // that completes without C1/C3/C4 trigger, the IPC payload omits the
      // telemetry field. Backward compatibility must be preserved.
      const result = childTextResultSchema.safeParse({
        type: "text-result",
        sectionEmbeddingsGenerated: 200,
        motionEmbeddingsGenerated: 0,
        bgEmbeddingsGenerated: 0,
        jsAnimationEmbeddingsGenerated: 0,
        responsiveEmbeddingsGenerated: 0,
        partEmbeddingsGenerated: 0,
        embeddingFailedChunks: 0,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chunkedEncoderTelemetry).toBeUndefined();
      }
    });

    it("INV-PHASE5-RSS-BUDGET-001 Case 6: telemetry schema accepts adaptive-halving partial-completion", () => {
      // Design §3.2 C2 Case 6: adaptive halving (`memCheck.shouldDegrade`)
      // reduces chunkSize mid-run; if the loop later breaks (e.g. budget
      // overshoot at the smaller chunk), totalChunks reflects the adjusted
      // count and chunksDone is the count of fully-persisted chunks.
      const result = childTextResultSchema.safeParse({
        type: "text-result",
        sectionEmbeddingsGenerated: 90,
        motionEmbeddingsGenerated: 0,
        bgEmbeddingsGenerated: 0,
        jsAnimationEmbeddingsGenerated: 0,
        responsiveEmbeddingsGenerated: 0,
        partEmbeddingsGenerated: 0,
        embeddingFailedChunks: 1,
        chunkedEncoderTelemetry: {
          // Original totalChunks=7, adaptive halving observed; broke at index 4
          // of the post-halving plan totalChunks=10.
          partialCompletion: { chunksDone: 4, totalChunks: 10 },
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("C3: failure-path partial-flush prevention (audit emission)", () => {
    let captured: Array<{
      action: string;
      details?: Record<string, unknown>;
      targetType: string;
    }>;

    beforeEach(() => {
      captured = [];
      // Inject a recording Prisma stub so AuditLogService.log() persists into
      // our captured array instead of the real DB.
      const recordingClient = {
        auditLog: {
          create: async ({
            data,
          }: {
            data: {
              action: string;
              actor: string;
              targetType: string;
              targetId: string | null;
              details: Record<string, unknown> | null;
              ipAddress: string | null;
              result: string;
            };
          }): Promise<void> => {
            captured.push({
              action: data.action,
              details: data.details ?? undefined,
              targetType: data.targetType,
            });
          },
        },
      };
      bootstrapAuditLogServiceForScript(recordingClient);
    });

    afterEach(() => {
      resetAuditLogPrismaClientFactory();
    });

    it("INV-PHASE5-RSS-BUDGET-001 Case 7: C3 partial completion emits embedding_skip_reason audit entry", async () => {
      // Design §3.2 C3 + §3.4.1: chunks 0..N-1 = forward intent, chunks N..total
      // skipped. audit_logs records the SSOT skip reason
      // `partial_chunked_<n>_of_<total>` with chunksDone/totalChunks in details.
      await emitChunkedEncoderTelemetryAudit("11111111-1111-7000-8000-111111111111", {
        partialCompletion: { chunksDone: 5, totalChunks: 7 },
      });
      expect(captured).toHaveLength(1);
      const entry = captured[0]!;
      expect(entry.action).toBe("embedding_skip_reason");
      expect(entry.targetType).toBe("web_page");
      expect(entry.details).toMatchObject({
        skipReason: "partial_chunked_<n>_of_<total>",
        chunksDone: 5,
        totalChunks: 7,
        contract: "C3",
      });
    });

    it("INV-PHASE5-RSS-BUDGET-001 Case 7: C1 + C3 together emit two paired audit entries", async () => {
      await emitChunkedEncoderTelemetryAudit("22222222-2222-7000-8000-222222222222", {
        partialCompletion: { chunksDone: 3, totalChunks: 7 },
        budgetExceededChunkIndex: 3,
      });
      expect(captured).toHaveLength(2);
      // C1 emits first (the cause), C3 emits second (the effect).
      expect(captured[0]!.details).toMatchObject({
        skipReason: "text_child_memory_budget_exceeded_at_chunk_<n>",
        chunkIndex: 3,
        contract: "C1",
      });
      expect(captured[1]!.details).toMatchObject({
        skipReason: "partial_chunked_<n>_of_<total>",
        chunksDone: 3,
        totalChunks: 7,
        contract: "C3",
      });
    });

    it("INV-PHASE5-RSS-BUDGET-001 Case 7: SSOT enum contains partial_chunked_<n>_of_<total>", () => {
      expect(EMBEDDING_SKIP_REASONS).toContain("partial_chunked_<n>_of_<total>");
    });
  });

  describe("C4: idempotency-on-retry skip-detection", () => {
    let captured: Array<{ action: string; details?: Record<string, unknown> }>;

    beforeEach(() => {
      captured = [];
      const recordingClient = {
        auditLog: {
          create: async ({
            data,
          }: {
            data: { action: string; details: Record<string, unknown> | null };
          }): Promise<void> => {
            captured.push({ action: data.action, details: data.details ?? undefined });
          },
        },
      };
      bootstrapAuditLogServiceForScript(recordingClient);
    });

    afterEach(() => {
      resetAuditLogPrismaClientFactory();
    });

    it("INV-PHASE5-RSS-BUDGET-001 Case 9: idempotencyChunkSkippedCount > 0 emits C4 audit entry", async () => {
      // Design §3.2 C4: retry path skips already-persisted head chunks; emit
      // an audit entry recording how many chunks were skipped (never silent).
      await emitChunkedEncoderTelemetryAudit("33333333-3333-7000-8000-333333333333", {
        idempotencyChunkSkippedCount: 5,
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.details).toMatchObject({
        skipReason: "partial_chunked_<n>_of_<total>",
        idempotencyChunkSkippedCount: 5,
        contract: "C4",
      });
    });

    it("INV-PHASE5-RSS-BUDGET-001 Case 9: idempotencyChunkSkippedCount=0 emits NO audit entry", async () => {
      await emitChunkedEncoderTelemetryAudit("44444444-4444-7000-8000-444444444444", {
        idempotencyChunkSkippedCount: 0,
      });
      // 0 is the no-op case (fresh run). No audit emission.
      expect(captured).toHaveLength(0);
    });
  });

  describe("T1.3: parent_rss_ceiling_scaled audit emission", () => {
    let captured: Array<{ action: string; details?: Record<string, unknown> }>;

    beforeEach(() => {
      captured = [];
      __resetParentRssCeilingScaledForTesting();
      const recordingClient = {
        auditLog: {
          create: async ({
            data,
          }: {
            data: { action: string; details: Record<string, unknown> | null };
          }): Promise<void> => {
            captured.push({ action: data.action, details: data.details ?? undefined });
          },
        },
      };
      bootstrapAuditLogServiceForScript(recordingClient);
    });

    afterEach(() => {
      resetAuditLogPrismaClientFactory();
      __resetParentRssCeilingScaledForTesting();
    });

    it("INV-PHASE5-RSS-BUDGET-001: scaling event detection: default 8192 IS a scaling event", () => {
      expect(isParentRssCeilingScalingEvent({ parentRssMaxMb: 8192, maxSectionsInput: 50 })).toBe(
        true
      );
    });

    it("INV-PHASE5-RSS-BUDGET-001: scaling event detection: legacy 7168 IS NOT a scaling event", () => {
      // Operator explicit 7168 override is NOT a scaling event per design §3.4.2.
      expect(
        isParentRssCeilingScalingEvent({
          parentRssMaxMb: LEGACY_PARENT_RSS_MAX_MB_PRE_T1A,
          maxSectionsInput: 50,
        })
      ).toBe(false);
    });

    it("INV-PHASE5-RSS-BUDGET-001: details payload is PII-free numeric/fixed-string", () => {
      const previousSha = process.env.T1A_COMMIT_SHA;
      try {
        process.env.T1A_COMMIT_SHA = "abc1234";
        const details = buildParentRssCeilingScaledDetails();
        expect(details.before_mb).toBe(LEGACY_PARENT_RSS_MAX_MB_PRE_T1A);
        expect(details.after_mb).toBe(8192);
        expect(details.trigger).toBe("plan_v3_t1a_landing");
        expect(details.commit_sha).toBe("abc1234");
      } finally {
        if (previousSha === undefined) {
          delete process.env.T1A_COMMIT_SHA;
        } else {
          process.env.T1A_COMMIT_SHA = previousSha;
        }
      }
    });

    it("INV-PHASE5-RSS-BUDGET-001: emission is idempotent (one-shot per process)", async () => {
      const config = { parentRssMaxMb: 8192, maxSectionsInput: 50 };
      const calls: number[] = [];
      const emitter = async (
        details: Awaited<ReturnType<typeof buildParentRssCeilingScaledDetails>>
      ): Promise<void> => {
        await getAuditLogService().log({
          action: "parent_rss_ceiling_scaled",
          actor: "system:phase5-init",
          targetType: "phase5_config",
          targetId: undefined,
          details: details as unknown as Record<string, unknown>,
          result: "success",
        });
        calls.push(1);
      };

      await emitParentRssCeilingScaledIfApplicable(config, emitter);
      await emitParentRssCeilingScaledIfApplicable(config, emitter);
      await emitParentRssCeilingScaledIfApplicable(config, emitter);

      expect(calls).toHaveLength(1);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.action).toBe("parent_rss_ceiling_scaled");
      expect(__isParentRssCeilingScaledEmittedForTesting()).toBe(true);
    });

    it("INV-PHASE5-RSS-BUDGET-001: emission skipped when ceiling is operator-overridden to 7168", async () => {
      const config = {
        parentRssMaxMb: LEGACY_PARENT_RSS_MAX_MB_PRE_T1A,
        maxSectionsInput: 50,
      };
      const emitter = vi.fn(
        async (
          _details: Awaited<ReturnType<typeof buildParentRssCeilingScaledDetails>>
        ): Promise<void> => {
          // not invoked
        }
      );
      await emitParentRssCeilingScaledIfApplicable(config, emitter);
      expect(emitter).not.toHaveBeenCalled();
      expect(__isParentRssCeilingScaledEmittedForTesting()).toBe(false);
    });
  });
});
