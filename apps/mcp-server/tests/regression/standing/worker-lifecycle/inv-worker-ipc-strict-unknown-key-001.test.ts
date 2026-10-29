// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WORKER-IPC-STRICT-UNKNOWN-KEY-001 (worker-lifecycle)
 *
 * zod 4 prep (DEP1-13): every object schema of the Phase 5 child IPC (`phase-5-child-ipc.ts`) and
 * of the embedding-backfill IPC (`embedding-backfill-ipc.ts`, plus the
 * `CollisionAuditPayloadSchema` audit payload in `queues/embedding-backfill-queue.ts`) is
 * `z.strictObject`, nested objects included. `z.strictObject` rejects unknown keys on zod 3 and
 * zod 4 alike, so the later bump cannot turn the boundary into a "strip" (fail-open) one.
 *
 * The AST counter (`_setup/z-strict-object-scan.ts`) reads the call structure (receiver `z`,
 * member name), so the newline form `z\n  .strictObject` that prettier produces for nested chains
 * is counted like the one-line form. The positive / negative controls below pin that line layout;
 * the real files are asserted only on what the contract needs (the strictObject count and no
 * `z.object` / `.strict()` / loose form), not on how prettier wraps a chain.
 *
 * Known limit of the counter: it does not look inside a wrapper call, so
 * `z.preprocess(fn, z.strictObject({...}))` counts as a `z.strictObject` while the wrapper is not
 * inspected. The IPC schemas have no such wrap; review one if it appears.
 *
 * AST-fixed set (PR-C1, before the change): `.strict()` appears in 3 src files / 16 sites
 * (embedding-backfill-ipc.ts 5, phase-5-child-ipc.ts 10, queues/embedding-backfill-queue.ts 1),
 * and 2 more `z.object` are nested without `.strict()` (chunkedEncoderTelemetry and its
 * partialCompletion in childTextResultSchema). After the change: 18 `z.strictObject`.
 *
 * Out of scope on purpose (the contract covers the Phase 5 child IPC and the embedding-backfill
 * IPC only):
 * - `schemas/worker-ipc.schema.ts` (WorkerIpcMessageSchema). It is the supervisor <-> worker
 *   message base that sibling schemas extend with keys it does not model (failedReason,
 *   spawn_recorded), so strict there would reject real messages. zod 4 keeps it as strip, so it
 *   does not regress.
 * - `EmbeddingBackfillJobDataSchema` (queues/embedding-backfill-queue.ts). It validates BullMQ job
 *   data read from Redis, not an IPC message; strict there would reject existing jobs.
 */
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import { scanFile, scanText, withoutLayout, type Scan } from "../_setup/z-strict-object-scan";
import {
  BackfillDoneMessage,
  BackfillErrorMessage,
  BackfillHeartbeatMessage,
  BackfillParentMessage,
  BackfillProgressMessage,
} from "../../../../src/workers/phases/embedding-backfill-ipc";
import { EMBEDDING_BACKFILL_CATEGORIES } from "../../../../src/queues/embedding-backfill-queue";
import { childTextResultSchema } from "../../../../src/workers/phases/phase-5-child-ipc";

const INV = "INV-WORKER-IPC-STRICT-UNKNOWN-KEY-001";
const SRC = path.resolve(__dirname, "../../../../src");

const FILES = {
  backfillIpc: "workers/phases/embedding-backfill-ipc.ts",
  phase5Ipc: "workers/phases/phase-5-child-ipc.ts",
  queue: "queues/embedding-backfill-queue.ts",
} as const;

function scan(rel: string, onlyDeclaration?: string): Omit<Scan, "multilineStrictObject"> {
  return withoutLayout(scanFile(path.join(SRC, rel), onlyDeclaration));
}

describe(`${INV}: AST counter positive / negative controls`, () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
  });

  it(`${INV}: counts the one-line and the newline form (z\n  .strictObject) alike`, () => {
    const oneLine = scanText("one.ts", "export const A = z.strictObject({ a: z.string() });");
    expect(oneLine.strictObject).toBe(1);
    expect(oneLine.multilineStrictObject).toBe(0);
    const newline = scanText(
      "nl.ts",
      "export const A = z.strictObject({\n  n: z\n    .strictObject({ a: z.string() })\n    .optional(),\n});"
    );
    expect(newline.strictObject).toBe(2);
    expect(newline.multilineStrictObject).toBe(1);
  });

  it(`${INV}: flags z.object, the newline z.object form, .strict() and loose forms`, () => {
    const s = scanText(
      "neg.ts",
      "const A = z.object({});\nconst B = z\n  .object({})\n  .strict();\nconst C = z.strictObject({}).passthrough();"
    );
    expect(s.nonStrictObject).toEqual(["neg.ts:1", "neg.ts:2"]);
    // a chained call reports the line where its whole chain starts (the `z` of `z\n  .object`)
    expect(s.strictChain).toEqual(["neg.ts:2"]);
    expect(s.looseForms).toEqual(["neg.ts:5"]);
  });

  it(`${INV}: a declaration filter matches the whole name, not a name that starts with it`, () => {
    const text =
      "export const FooSchemaV2 = z.object({});\nexport const FooSchema = z.strictObject({});";
    const s = scanText("filter.ts", text, "FooSchema");
    expect(s.strictObject).toBe(1);
    expect(s.nonStrictObject).toEqual([]);
    // an absent name fails loudly instead of scanning nothing
    expect(() => scanText("filter.ts", text, "Foo")).toThrow(/no top-level declaration named Foo/);
  });

  it(`${INV}: known limit — a wrapper call around the object is not inspected`, () => {
    const s = scanText("wrap.ts", "export const A = z.preprocess(fn, z.strictObject({}));");
    // counted as a strictObject; what the wrapper does to the input is not looked at
    expect(s.strictObject).toBe(1);
    expect(s.nonStrictObject).toEqual([]);
  });
});

describe(`${INV}: IPC object schemas are z.strictObject (AST)`, () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
  });

  it(`${INV}: embedding-backfill-ipc.ts has 5 strictObject and no z.object / .strict() / loose form`, () => {
    const s = scan(FILES.backfillIpc);
    expect(s).toEqual({
      strictObject: 5,
      nonStrictObject: [],
      strictChain: [],
      looseForms: [],
    });
  });

  it(`${INV}: phase-5-child-ipc.ts has 12 strictObject (10 top-level + 2 nested) and no z.object / .strict()`, () => {
    const s = scan(FILES.phase5Ipc);
    // The 2 nested objects of childTextResultSchema are the newline form (`z\n  .strictObject`);
    // that layout is pinned by the positive control above, not by this real file.
    expect(s).toEqual({
      strictObject: 12,
      nonStrictObject: [],
      strictChain: [],
      looseForms: [],
    });
  });

  it(`${INV}: CollisionAuditPayloadSchema (embedding-backfill-queue.ts) is a strictObject`, () => {
    const s = scan(FILES.queue, "CollisionAuditPayloadSchema");
    expect(s).toEqual({
      strictObject: 1,
      nonStrictObject: [],
      strictChain: [],
      looseForms: [],
    });
  });
});

describe(`${INV}: unknown keys are rejected, nested objects included`, () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
  });

  const text = {
    type: "text-result" as const,
    sectionEmbeddingsGenerated: 0,
    motionEmbeddingsGenerated: 0,
    bgEmbeddingsGenerated: 0,
    jsAnimationEmbeddingsGenerated: 0,
    responsiveEmbeddingsGenerated: 0,
    partEmbeddingsGenerated: 0,
    embeddingFailedChunks: 0,
  };

  it(`${INV}: nested chunkedEncoderTelemetry rejects an unknown key`, () => {
    const ok = { ...text, chunkedEncoderTelemetry: { budgetExceededChunkIndex: 1 } };
    expect(childTextResultSchema.safeParse(ok).success).toBe(true);
    const bad = { ...text, chunkedEncoderTelemetry: { budgetExceededChunkIndex: 1, evil: 1 } };
    expect(childTextResultSchema.safeParse(bad).success).toBe(false);
  });

  it(`${INV}: doubly nested partialCompletion rejects an unknown key`, () => {
    const pc = { chunksDone: 1, totalChunks: 2 };
    const ok = { ...text, chunkedEncoderTelemetry: { partialCompletion: pc } };
    expect(childTextResultSchema.safeParse(ok).success).toBe(true);
    const bad = { ...text, chunkedEncoderTelemetry: { partialCompletion: { ...pc, evil: 1 } } };
    expect(childTextResultSchema.safeParse(bad).success).toBe(false);
  });

  it(`${INV}: backfill IPC messages reject an unknown key`, () => {
    const at = "2026-10-27T00:00:00.000Z";
    const cases: Array<
      [string, { safeParse(v: unknown): { success: boolean } }, Record<string, unknown>]
    > = [
      [
        "progress",
        BackfillProgressMessage,
        { kind: "backfill.progress", processedCount: 1, totalCount: 2 },
      ],
      ["heartbeat", BackfillHeartbeatMessage, { kind: "backfill.heartbeat", at }],
      ["done", BackfillDoneMessage, { kind: "backfill.done", processedCount: 1 }],
      ["error", BackfillErrorMessage, { kind: "backfill.error", message: "x" }],
      [
        "parent",
        BackfillParentMessage,
        {
          type: "backfill.run",
          kind: "backfill.run",
          jobId: "j1",
          webPageId: "11111111-1111-4111-8111-111111111111",
          category: EMBEDDING_BACKFILL_CATEGORIES[0],
          partsLimit: 10,
          startedAt: at,
        },
      ],
    ];
    for (const [name, schema, body] of cases) {
      expect(schema.safeParse(body).success, `${name} valid`).toBe(true);
      expect(schema.safeParse({ ...body, evil: 1 }).success, `${name} unknown key`).toBe(false);
    }
  });
});
