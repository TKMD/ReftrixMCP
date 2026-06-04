// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WORKER-LOCK-003 (Phase 5 IPC `.strict()` parity)
 *
 * **PR-1 GPU-COORD / IO Plan Decision V1 APPROVE (anchor 019e562d)**
 * **FIND-PLAN-M-02 (SEC-M-1) closure — SEC H-2 `.strict()` parity**
 *
 * ## Contract / 不変条件
 *
 * **All Phase 5 child IPC Zod object schemas (`phase-5-child-ipc.ts`) MUST be
 * `.strict()` so that unknown keys are rejected at the IPC boundary** — matching
 * the SEC H-2 `.strict()` unknown-key-reject contract already enforced on
 * `embedding-backfill-ipc.ts`.
 *
 * **IO flag (Plan Decision V1 / FIND-PLAN-DOC-01)**: ADR-0038 / master-plan prose
 * claiming "the existing `.strict()` is unchanged" is a known doc-error
 * (Phase 3 docs-sync correction). The authoritative instruction is THIS Registry
 * FIND-PLAN-M-02: `phase-5-child-ipc.ts` had `.strict()` = 0 (none) before PR-1;
 * PR-1 ADDS `.strict()` to all 10 schemas. T1 (this CI-failing test) wins.
 *
 * ## Why a standing regression / なぜ常設 regression か
 *
 * The fork() IPC boundary deserializes parent↔child messages. Without
 * `.strict()`, a message carrying extra (unmodelled) keys passes validation
 * silently — a CWE-20 (improper input validation) latent surface at the OS-level
 * process boundary. `.strict()` makes unknown-key injection a hard validation
 * failure (the schema's `validateParentMessage` / `validateChildMessage` return
 * null), structurally closing the surface and reaching parity with SEC H-2.
 *
 * ## Scope (test cases)
 *
 * | # | What it pins                                                                       |
 * | - | ---------------------------------------------------------------------------------- |
 * | 1 | parentInitText rejects unknown key                                                 |
 * | 2 | parentInitVisual rejects unknown key                                               |
 * | 3 | parentLockAck / parentShutdown reject unknown key                                  |
 * | 4 | childHeartbeat / childLockRequest / childProgress reject unknown key               |
 * | 5 | childTextResult / childVisualResult / childError reject unknown key                |
 * | 6 | validateParentMessage / validateChildMessage return null on unknown-key injection  |
 * | 7 | AST/source gate: ≥ 10 `.strict()` calls present (no schema left non-strict)         |
 *
 * @see ADR-0038 §1.6 / Security section (FIND-PLAN-M-02 / SEC-M-1 / SEC H-2)
 * @see CONTRIBUTING.md §"Embedding backfill IPC unconstrained-string surfaces" (SEC H-2 sibling)
 * @module tests/regression/standing/worker-lifecycle/inv-worker-lock-003-phase5-ipc-strict
 */

import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  parentInitTextSchema,
  parentInitVisualSchema,
  parentLockAckSchema,
  parentShutdownSchema,
  childHeartbeatSchema,
  childLockRequestSchema,
  childProgressSchema,
  childTextResultSchema,
  childVisualResultSchema,
  childErrorSchema,
  validateParentMessage,
  validateChildMessage,
} from "../../../../src/workers/phases/phase-5-child-ipc";

const INV = "INV-WORKER-LOCK-003";
const IPC_SRC = path.resolve(__dirname, "../../../../src/workers/phases/phase-5-child-ipc.ts");

/** Valid base message bodies (without the unknown key). */
const validBodies = {
  initText: {
    type: "init-text" as const,
    webPageId: "11111111-1111-1111-1111-111111111111",
    url: "https://example.com",
    sectionIdMapping: null,
    motionIdMapping: null,
    jsIdMapping: null,
    bgIds: null,
    scrollVisionIdMapping: null,
    layoutResultJson: null,
    motionResultJson: null,
    jsAnimationsJson: null,
    scrollVisionResultJson: null,
  },
  initVisual: {
    type: "init-visual" as const,
    webPageId: "11111111-1111-1111-1111-111111111111",
    url: "https://example.com",
    screenshotPngPath: "/tmp/x.png",
    sectionIdMapping: null,
    layoutResultJson: null,
    fallbackEnabled: true,
    dinov2ModelPath: "/models/dinov2.onnx",
  },
  lockAck: { type: "lock-ack" as const, success: true },
  shutdown: { type: "shutdown" as const },
  heartbeat: { type: "heartbeat" as const, rssMb: 100, rssDeltaMb: 10, phase: "text-embedding" },
  lockRequest: { type: "lock-request" as const, label: "lock" },
  progress: { type: "progress" as const, completed: 1, total: 2, phase: "text-embedding" },
  textResult: {
    type: "text-result" as const,
    sectionEmbeddingsGenerated: 0,
    motionEmbeddingsGenerated: 0,
    bgEmbeddingsGenerated: 0,
    jsAnimationEmbeddingsGenerated: 0,
    responsiveEmbeddingsGenerated: 0,
    partEmbeddingsGenerated: 0,
    embeddingFailedChunks: 0,
  },
  visualResult: {
    type: "visual-result" as const,
    sectionVisualEmbeddingsGenerated: 0,
    partVisualEmbeddingsGenerated: 0,
    embeddingFailedChunks: 0,
  },
  error: { type: "error" as const, message: "boom" },
};

describe(`${INV}: Phase 5 child IPC schemas reject unknown keys (.strict() parity, SEC H-2)`, () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
  });

  it(`${INV}: parent init schemas reject unknown keys`, () => {
    expect(parentInitTextSchema.safeParse(validBodies.initText).success).toBe(true);
    expect(parentInitTextSchema.safeParse({ ...validBodies.initText, evil: 1 }).success).toBe(
      false
    );

    expect(parentInitVisualSchema.safeParse(validBodies.initVisual).success).toBe(true);
    expect(parentInitVisualSchema.safeParse({ ...validBodies.initVisual, evil: 1 }).success).toBe(
      false
    );
  });

  it(`${INV}: parent control schemas reject unknown keys`, () => {
    expect(parentLockAckSchema.safeParse({ ...validBodies.lockAck, evil: 1 }).success).toBe(false);
    expect(parentShutdownSchema.safeParse({ ...validBodies.shutdown, evil: 1 }).success).toBe(
      false
    );
  });

  it(`${INV}: child telemetry schemas reject unknown keys`, () => {
    expect(childHeartbeatSchema.safeParse({ ...validBodies.heartbeat, evil: 1 }).success).toBe(
      false
    );
    expect(childLockRequestSchema.safeParse({ ...validBodies.lockRequest, evil: 1 }).success).toBe(
      false
    );
    expect(childProgressSchema.safeParse({ ...validBodies.progress, evil: 1 }).success).toBe(false);
  });

  it(`${INV}: child result/error schemas reject unknown keys`, () => {
    expect(childTextResultSchema.safeParse(validBodies.textResult).success).toBe(true);
    expect(childTextResultSchema.safeParse({ ...validBodies.textResult, evil: 1 }).success).toBe(
      false
    );
    expect(
      childVisualResultSchema.safeParse({ ...validBodies.visualResult, evil: 1 }).success
    ).toBe(false);
    expect(childErrorSchema.safeParse({ ...validBodies.error, evil: 1 }).success).toBe(false);
  });

  it(`${INV}: validateParentMessage / validateChildMessage return null on unknown-key injection`, () => {
    expect(validateParentMessage({ ...validBodies.initText, evil: 1 })).toBeNull();
    expect(validateChildMessage({ ...validBodies.textResult, evil: 1 })).toBeNull();
    // Sanity: valid messages still parse.
    expect(validateParentMessage(validBodies.initText)).not.toBeNull();
    expect(validateChildMessage(validBodies.textResult)).not.toBeNull();
  });

  it(`${INV}: source gate — at least 10 .strict() calls present (no schema left non-strict)`, () => {
    const src = fs.readFileSync(IPC_SRC, "utf-8");
    const strictCount = (src.match(/\.strict\(\)/g) ?? []).length;
    expect(
      strictCount,
      `phase-5-child-ipc.ts MUST have >= 10 .strict() calls (one per IPC object schema, FIND-PLAN-M-02). Found ${strictCount}.`
    ).toBeGreaterThanOrEqual(10);
  });
});
