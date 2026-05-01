// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004
 *
 * **WorkerType SSOT exhaustive contract (PR-D-8 Plan v1.1 §6.1 SSOT test)**
 *
 * SSOT: `apps/mcp-server/src/types/worker-type.ts`
 *
 * 契約 / Contract:
 *   - `WorkerType` union is exactly 2 values (`"page"` | `"embedding-backfill"`)
 *   - `WORKER_TYPES` const array matches the union exhaustively (runtime iteration source)
 *   - `StartMode = WorkerType | "all"` — CLI convenience type, NOT part of WorkerType proper
 *   - `START_WORKERS_CLI_MAPPING` bridges legacy CLI flag names (`"page-analyze"`) to
 *     SSOT values (`"page"`) + preserves `"embedding-backfill"` + passes through `"all"`
 *   - `assertNeverWorkerType` is wired as the exhaustive switch helper
 *     (TypeScript `never` compile-time check)
 *   - `worker-ipc.schema.ts` consumes WorkerType via named import (schema is T1
 *     canonical; Zod enum runtime must equal WORKER_TYPES at every instantiation)
 *
 * SSOT consistency contract for WorkerType. 2 values exhaustive, `WORKER_TYPES`
 * const matches union, `START_WORKERS_CLI_MAPPING` bridges legacy CLI flags,
 * `assertNeverWorkerType` enforces compile-time drift detection.
 *
 * Binding / 束縛:
 *   - FIND-PLAN-TDA-01 H (Plan Decision v2 §10 contract #5)
 *   - FIND-PLAN-TPA-02 H (IPC schema SSOT, cross-check)
 *
 * @see Plan v1.1 §3.2.1 (WorkerType SSOT)
 * @see Plan v1.1 §6.1 (SSOT-enforcement test block)
 * @see Finding Registry v2 §10 contracts #2 + #5
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  addMcpServerSourceFile,
  createAstProject,
  extractConstStringArray,
  setDifference,
} from "./_extractors";
import {
  WorkerType,
  WORKER_TYPES,
  StartMode,
  START_WORKERS_CLI_MAPPING,
  assertNeverWorkerType,
} from "../../../../src/types/worker-type";
import {
  WorkerIpcMessageSchema,
  parseWorkerIpcStrict,
} from "../../../../src/schemas/worker-ipc.schema";

/**
 * Plan v1.1 §3.2.1 で確定した 2 値: `"page"` / `"embedding-backfill"`。
 * 本 suite はこの 2 値を unit 化している全ての SSOT 出口 (type alias / const /
 * CLI mapping / IPC schema) が相互整合していることを assert する。
 *
 * Plan v1.1 §3.2.1 finalises 2 values. This suite asserts every SSOT egress
 * (type alias / const / CLI mapping / IPC schema) stays in lockstep.
 */
const EXPECTED_WORKER_TYPES: readonly WorkerType[] = ["page", "embedding-backfill"];

describe("INV-SCHEMA-ENUM-004: WorkerType SSOT consistency (PR-D-8)", () => {
  let ssotRuntimeValues: readonly string[];
  let ssotSourceArray: string[];

  beforeAll(() => {
    ssotRuntimeValues = WORKER_TYPES;

    // AST-level source-pin: `WORKER_TYPES` const declaration must literally
    // list the expected values. Prevents the case where runtime export happens
    // to be correct but the const was rewritten to a non-literal expression.
    //
    // AST レベル source-pin: `WORKER_TYPES` 宣言が実際に期待値を literal で
    // 持つか検証する。runtime export だけは一致していても const 定義が
    // 非 literal に書き換わった場合を検出する。
    const project = createAstProject();
    const typesFile = addMcpServerSourceFile(project, "src/types/worker-type.ts");
    ssotSourceArray = extractConstStringArray(typesFile, "WORKER_TYPES");
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
  });

  it("INV-SCHEMA-ENUM-004: WORKER_TYPES has exactly 2 values (`page`, `embedding-backfill`) / WORKER_TYPES が 2 値のみで構成される", () => {
    expect(ssotRuntimeValues).toHaveLength(2);
    expect([...ssotRuntimeValues]).toEqual(["page", "embedding-backfill"]);

    // Source-pin: source file array literal matches runtime (catches drift
    // between `export const WORKER_TYPES = [...]` and what's actually exported).
    // source-pin: source 配列 literal と runtime export が一致すること
    expect(ssotSourceArray).toHaveLength(2);
    const diff = setDifference(EXPECTED_WORKER_TYPES as readonly string[], ssotSourceArray);
    expect(diff.onlyInA, "Expected WorkerType missing from source literal").toEqual([]);
    expect(diff.onlyInB, "Unexpected WorkerType present in source literal").toEqual([]);
  });

  it("INV-SCHEMA-ENUM-004: START_WORKERS_CLI_MAPPING bridges legacy CLI flags to SSOT values / 旧 CLI flag を SSOT 値に橋渡しする", () => {
    // Legacy CLI flag "page-analyze" must map to SSOT "page" (not drift back).
    // 旧 CLI flag "page-analyze" が SSOT "page" にマップされる (drift しない)。
    expect(START_WORKERS_CLI_MAPPING["page-analyze"]).toBe("page");

    // embedding-backfill is identity (no legacy alias).
    // embedding-backfill は identity (legacy alias 無し)。
    expect(START_WORKERS_CLI_MAPPING["embedding-backfill"]).toBe("embedding-backfill");

    // "all" passes through unchanged (StartMode convenience only; NOT a WorkerType).
    // "all" は StartMode 便宜値で WorkerType に含まれない。
    expect(START_WORKERS_CLI_MAPPING.all).toBe("all");

    // Mapping must produce only valid StartMode values (WorkerType ∪ "all").
    // Mapping の出力は StartMode 値のみ (WorkerType または "all") に制限される。
    const allowed = new Set<StartMode>(["page", "embedding-backfill", "all"]);
    for (const value of Object.values(START_WORKERS_CLI_MAPPING)) {
      expect(allowed.has(value as StartMode)).toBe(true);
    }
  });

  it("INV-SCHEMA-ENUM-004: assertNeverWorkerType throws with a descriptive error on unexpected input / 想定外入力で throw する", () => {
    // Runtime safety net — should compile-time error prevent reaching here,
    // but if a cast slips through (e.g., JSON deserialized as any-cast), the
    // helper throws rather than silently proceed.
    //
    // Runtime safety net — compile 時に never check で防御するのが第一だが、
    // any-cast や JSON 復元で到達した場合は throw して fail-closed に倒す。
    expect(() => assertNeverWorkerType("unknown-value" as never)).toThrow(/Unexpected WorkerType/);
  });

  it("INV-SCHEMA-ENUM-004: exhaustive switch on WorkerType compiles without fallthrough / exhaustive switch が compile エラーを起こさない", () => {
    // TypeScript compile-time exhaustiveness: if a new WorkerType is added
    // without handling here, `assertNeverWorkerType` will be called with a
    // non-`never` argument and `tsc --noEmit` will fail. The runtime here
    // simply asserts both branches are reachable with expected labels.
    //
    // TypeScript compile 時 exhaustiveness: 新 WorkerType 追加時は本 switch
    // で非 `never` が assertNeverWorkerType に渡り `tsc --noEmit` が失敗する。
    // runtime では両分岐が期待 label を返すことを確認する。
    function labelFor(workerType: WorkerType): string {
      switch (workerType) {
        case "page":
          return "page-label";
        case "embedding-backfill":
          return "backfill-label";
        default:
          return assertNeverWorkerType(workerType);
      }
    }

    expect(labelFor("page")).toBe("page-label");
    expect(labelFor("embedding-backfill")).toBe("backfill-label");
  });

  it("INV-SCHEMA-ENUM-004: WorkerIpcMessageSchema.workerType enum is equivalent to WORKER_TYPES SSOT / IPC schema が SSOT と一致する", () => {
    // IPC schema consumes WorkerType via named import and builds a z.enum().
    // Verify it parses every SSOT value and rejects any value not in SSOT
    // (drift detection for INV-SCHEMA-ENUM-004 + INV-WORKER-LOCK-003 IPC).
    //
    // IPC schema は named import で WorkerType を受け取り z.enum() を構築。
    // SSOT の全値を parse し、SSOT 外の値を reject することを検証
    // (INV-SCHEMA-ENUM-004 + INV-WORKER-LOCK-003 の IPC 交差束縛)。
    for (const workerType of WORKER_TYPES) {
      const parsed = WorkerIpcMessageSchema.safeParse({
        type: "heartbeat",
        workerType,
        timestamp: Date.now(),
      });
      expect(parsed.success, `WorkerIpcMessageSchema must accept SSOT value "${workerType}"`).toBe(
        true
      );
    }

    // Reject an obviously-invalid value (drift from SSOT).
    // SSOT から drift した値を reject する。
    const rejected = WorkerIpcMessageSchema.safeParse({
      type: "heartbeat",
      workerType: "unknown-type",
      timestamp: Date.now(),
    });
    expect(rejected.success).toBe(false);

    // parseWorkerIpcStrict must route the same rejection to the
    // "unknown-workerType" branch (not "schema-invalid") so fail-closed
    // dispatch logic (SIGTERM + 60s suppress + audit) is triggered.
    // parseWorkerIpcStrict は同 rejection を "unknown-workerType" 分岐に振る。
    const dispatch = parseWorkerIpcStrict({
      type: "heartbeat",
      workerType: "unknown-type",
      timestamp: Date.now(),
    });
    expect(dispatch.ok).toBe(false);
    if (!dispatch.ok) {
      expect(dispatch.reason).toBe("unknown-workerType");
    }
  });
});
