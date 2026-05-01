// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill IPC Schema Tests (v0.4.0 PR7e-β4 PR2b-α)
 *
 * PR2b-α §5.3.2 に従い、`embedding-backfill-ipc.ts` の Zod schema を検証する。
 * PR2a で merge 済みの基本 schema に加え、PR2b-α 追加の `type` discriminator
 * (TPA-H-2) と `backfill.done` 拡張フィールド (TPA-H-1) を網羅する。
 *
 * Validates the Zod schemas in `embedding-backfill-ipc.ts` per PR2b-α §5.3.2,
 * covering the PR2b-α additions (TPA-H-2 `type` discriminator, TPA-H-1 done-message
 * observability fields) on top of the existing PR2a schema.
 *
 * - T01: `BackfillParentMessage` valid payload (type + jobId + webPageId + category + partsLimit + startedAt)
 * - T02: missing `type` field → strict parse fails (TPA-H-2)
 * - T03: missing `jobId` / `webPageId` / `startedAt` → fail
 * - T04: invalid UUID / unknown-key injection (`__proto__` / `constructor`) → fail (SEC H-2 CWE-502)
 * - T05: invalid category (not `js_animation`) → fail
 * - T06: `BackfillProgressMessage` valid
 * - T07: `BackfillHeartbeatMessage` valid
 * - T08: `BackfillDoneMessage` valid with TPA-H-1 fields (failedCount / memorySkipCount / errors)
 * - T09: `BackfillErrorMessage` valid
 * - T10: `BackfillChildMessage` invalid discriminator (unknown `kind`) → fail
 * - T11: `BackfillChildMessage` unknown-key injection → strict parse fails (SEC H-2)
 *
 * @module tests/workers/phases/embedding-backfill-ipc
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BackfillParentMessage,
  BackfillProgressMessage,
  BackfillHeartbeatMessage,
  BackfillDoneMessage,
  BackfillErrorMessage,
  BackfillChildMessage,
} from "../../../src/workers/phases/embedding-backfill-ipc";

// ============================================================================
// Helpers
// ============================================================================

const IPC_SRC = path.resolve(__dirname, "../../../src/workers/phases/embedding-backfill-ipc.ts");
const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
const VALID_ISO = "2026-04-18T10:00:00.000Z";

function validParent(): Record<string, unknown> {
  return {
    type: "backfill.run",
    kind: "backfill.run",
    jobId: "job-1",
    webPageId: VALID_UUID,
    category: "js_animation",
    partsLimit: 100,
    startedAt: VALID_ISO,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("embedding-backfill-ipc Zod schemas (PR7e-β4 PR2b-α)", () => {
  // --------------------------------------------------------------------------
  // SPDX header contract (shared across the IPC file and the child entry)
  // --------------------------------------------------------------------------
  it("SPDX header: IPC source has AGPL-3.0-only tag in the first two lines", () => {
    const head = fs.readFileSync(IPC_SRC, "utf-8").split("\n").slice(0, 2).join("\n");
    expect(head).toContain("SPDX-License-Identifier: AGPL-3.0-only");
  });

  // --------------------------------------------------------------------------
  // T01: valid BackfillParentMessage with TPA-H-2 type discriminator.
  // --------------------------------------------------------------------------
  it("T01: BackfillParentMessage valid payload (with type discriminator)", () => {
    const result = BackfillParentMessage.safeParse(validParent());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("backfill.run");
      expect(result.data.kind).toBe("backfill.run");
      expect(result.data.category).toBe("js_animation");
      expect(result.data.partsLimit).toBe(100);
    }
  });

  // --------------------------------------------------------------------------
  // T02: missing `type` field → strict parse fails (TPA-H-2).
  // --------------------------------------------------------------------------
  it("T02: missing `type` field fails strict parse (TPA-H-2)", () => {
    const payload = validParent();
    delete (payload as { type?: unknown }).type;
    const result = BackfillParentMessage.safeParse(payload);
    expect(result.success).toBe(false);
  });

  // --------------------------------------------------------------------------
  // T03: missing jobId / webPageId / startedAt → fail.
  // --------------------------------------------------------------------------
  it("T03a: missing `jobId` fails", () => {
    const payload = validParent();
    delete (payload as { jobId?: unknown }).jobId;
    expect(BackfillParentMessage.safeParse(payload).success).toBe(false);
  });

  it("T03b: missing `webPageId` fails", () => {
    const payload = validParent();
    delete (payload as { webPageId?: unknown }).webPageId;
    expect(BackfillParentMessage.safeParse(payload).success).toBe(false);
  });

  it("T03c: missing `startedAt` fails", () => {
    const payload = validParent();
    delete (payload as { startedAt?: unknown }).startedAt;
    expect(BackfillParentMessage.safeParse(payload).success).toBe(false);
  });

  // --------------------------------------------------------------------------
  // T04: invalid UUID + unknown-key injection (SEC H-2 CWE-502).
  // --------------------------------------------------------------------------
  it("T04a: invalid UUID `webPageId` fails", () => {
    const payload = validParent();
    payload.webPageId = "not-a-uuid";
    expect(BackfillParentMessage.safeParse(payload).success).toBe(false);
  });

  it("T04b: unknown-key injection (`__proto__`) fails strict parse (SEC H-2 CWE-502)", () => {
    const payload: Record<string, unknown> = {
      ...validParent(),
      __proto__: { polluted: true },
    };
    const result = BackfillParentMessage.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("T04c: unknown-key injection (`constructor`) fails strict parse (SEC H-2 CWE-502)", () => {
    const payload: Record<string, unknown> = {
      ...validParent(),
      constructor: "bogus",
    };
    const result = BackfillParentMessage.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("T04d: unknown-key (arbitrary) fails strict parse", () => {
    const payload: Record<string, unknown> = {
      ...validParent(),
      extraUnexpectedKey: "xyz",
    };
    expect(BackfillParentMessage.safeParse(payload).success).toBe(false);
  });

  // --------------------------------------------------------------------------
  // T05 (PR2d HIGH-β): invalid category (not in 7-value SSOT) → fail.
  //
  // PR2d expanded the enum from 1-value (`js_animation`) to the full
  // SSOT-backed 7-value union (`part_text` / `part_visual` / `section_visual`
  // / `motion` / `background` / `js_animation` / `responsive`). The previous
  // PR2c-era assertion used `"motion"` as an invalid value; PR2d makes
  // `"motion"` valid, so use a clearly-invalid sentinel `"invalid_category"`
  // instead.
  //
  // T05 (PR2d HIGH-β): PR2d で enum を 1 値 → SSOT 7 値 union に拡張したため、
  // 旧 invalid 値 `"motion"` は valid となった。明らかに invalid な
  // `"invalid_category"` で再検証する。
  // --------------------------------------------------------------------------
  it("T05 (PR2d HIGH-β): invalid category (not in 7-value SSOT) fails", () => {
    const payload = validParent();
    payload.category = "invalid_category";
    expect(BackfillParentMessage.safeParse(payload).success).toBe(false);
  });

  // --------------------------------------------------------------------------
  // T05b (PR2d HIGH-β): all 7 SSOT categories are valid.
  //
  // T05b (PR2d HIGH-β): SSOT 7 全 category が valid。
  // --------------------------------------------------------------------------
  it("T05b (PR2d HIGH-β): all 7 SSOT categories pass parse", () => {
    const categories = [
      "part_text",
      "part_visual",
      "section_visual",
      "motion",
      "background",
      "js_animation",
      "responsive",
    ];
    for (const category of categories) {
      const payload = validParent();
      payload.category = category;
      expect(BackfillParentMessage.safeParse(payload).success).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // T06: BackfillProgressMessage valid.
  // --------------------------------------------------------------------------
  it("T06: BackfillProgressMessage valid", () => {
    const result = BackfillProgressMessage.safeParse({
      kind: "backfill.progress",
      processedCount: 5,
      totalCount: 20,
    });
    expect(result.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T07: BackfillHeartbeatMessage valid.
  // --------------------------------------------------------------------------
  it("T07: BackfillHeartbeatMessage valid", () => {
    const result = BackfillHeartbeatMessage.safeParse({
      kind: "backfill.heartbeat",
      at: VALID_ISO,
    });
    expect(result.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T08: BackfillDoneMessage valid with TPA-H-1 fields.
  // --------------------------------------------------------------------------
  it("T08a: BackfillDoneMessage valid without new observability fields", () => {
    const result = BackfillDoneMessage.safeParse({
      kind: "backfill.done",
      processedCount: 3,
    });
    expect(result.success).toBe(true);
  });

  it("T08b: BackfillDoneMessage valid with TPA-H-1 failedCount/memorySkipCount/errors", () => {
    const result = BackfillDoneMessage.safeParse({
      kind: "backfill.done",
      processedCount: 10,
      failedCount: 2,
      memorySkipCount: 1,
      errors: ["embedding timeout", "prisma P2025"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.failedCount).toBe(2);
      expect(result.data.memorySkipCount).toBe(1);
      expect(result.data.errors).toEqual(["embedding timeout", "prisma P2025"]);
    }
  });

  it("T08c: BackfillDoneMessage rejects errors array longer than 100 entries", () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `err-${i}`);
    const result = BackfillDoneMessage.safeParse({
      kind: "backfill.done",
      processedCount: 0,
      errors: tooMany,
    });
    expect(result.success).toBe(false);
  });

  it("T08d: BackfillDoneMessage rejects negative counts", () => {
    expect(
      BackfillDoneMessage.safeParse({
        kind: "backfill.done",
        processedCount: -1,
      }).success
    ).toBe(false);
    expect(
      BackfillDoneMessage.safeParse({
        kind: "backfill.done",
        processedCount: 0,
        failedCount: -1,
      }).success
    ).toBe(false);
  });

  // --------------------------------------------------------------------------
  // T09: BackfillErrorMessage valid.
  // --------------------------------------------------------------------------
  it("T09: BackfillErrorMessage valid", () => {
    const result = BackfillErrorMessage.safeParse({
      kind: "backfill.error",
      message: "Record not found",
      code: "P2025",
    });
    expect(result.success).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T10: BackfillChildMessage discriminated union — unknown `kind` fails.
  // --------------------------------------------------------------------------
  it("T10: BackfillChildMessage with unknown discriminator fails", () => {
    const result = BackfillChildMessage.safeParse({
      kind: "backfill.bogus",
      processedCount: 1,
    });
    expect(result.success).toBe(false);
  });

  // --------------------------------------------------------------------------
  // T11: BackfillChildMessage with unknown key fails strict parse (SEC H-2).
  // --------------------------------------------------------------------------
  it("T11: BackfillChildMessage with unknown key fails strict parse (SEC H-2)", () => {
    const result = BackfillChildMessage.safeParse({
      kind: "backfill.done",
      processedCount: 1,
      __proto__: { polluted: true },
    });
    expect(result.success).toBe(false);
  });
});
