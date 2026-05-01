// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerType SSOT — single source of truth for all worker-type enumerations.
 *
 * Consumed by: worker-supervisor.service.ts, worker-active-lock.service.ts,
 *              start-workers.ts, _worker-spawn-helper.ts, worker-ipc.schema.ts.
 *
 * Extensions require updating:
 *   - INV-SCHEMA-ENUM-004 standing regression (tests/regression/standing/schema-enum-sync/)
 *   - ADR-0011 Amendment (§Worker types + boot token per-type contract)
 *
 * PR-D-8 Phase 2 — Plan v1.1 §3.2.1 (TDA-01 H resolution).
 * Resolves 3-way WorkerType collision:
 *   - worker-active-lock.service.ts (1 value: "page")
 *   - start-workers.ts (3 values incl. "page-analyze" / "embedding-backfill" / "all")
 *   - WorkerSupervisor ad-hoc usage
 *
 * @module types/worker-type
 */

/**
 * Canonical worker-type union (2 values, exhaustive).
 *
 * 正典 WorkerType union (2 値、exhaustive)。
 */
export type WorkerType = "page" | "embedding-backfill";

/**
 * Runtime-iterable list of all known WorkerType values.
 *
 * Runtime 反復可能な全 WorkerType 値の一覧。
 */
export const WORKER_TYPES: readonly WorkerType[] = ["page", "embedding-backfill"] as const;

/**
 * start-workers.ts CLI flag type — adds `"all"` orthogonally to WorkerType.
 *
 * `"all"` is NOT part of WorkerType itself (it is a CLI convenience meaning
 * "start every worker type"); it exists only at the CLI boundary.
 *
 * start-workers.ts の CLI flag 型。`"all"` は WorkerType には含まれず、
 * CLI 境界でのみ意味を持つ便宜値 ("全種別の worker を起動する") である。
 */
export type StartMode = WorkerType | "all";

/**
 * Legacy CLI flag → SSOT value mapping.
 *
 * Pre-PR-D-8 the start-workers.ts `WORKER_TYPES` const used `"page-analyze"`
 * as the CLI flag name. This mapping preserves the legacy flag for 1-cycle
 * backward compatibility while all internal code references the SSOT value.
 *
 * PR-D-8 以前は start-workers.ts 内で `"page-analyze"` CLI flag を使用していた。
 * このマッピングで legacy flag を 1 release cycle だけ互換維持しつつ、内部
 * コードはすべて SSOT 値 ("page") を参照する。
 */
export const START_WORKERS_CLI_MAPPING = {
  "page-analyze": "page",
  "embedding-backfill": "embedding-backfill",
  all: "all",
} as const satisfies Record<string, StartMode>;

/**
 * Exhaustive-switch helper. Using this in default-case of a `switch (x: WorkerType)`
 * statement makes TypeScript fail compile if a new WorkerType is added without
 * handling it in every switch site.
 *
 * switch (x: WorkerType) の default で呼ぶことで、新 WorkerType 追加時に
 * TypeScript コンパイルエラーで漏れを検出する。
 *
 * @example
 *   switch (workerType) {
 *     case "page": return ...;
 *     case "embedding-backfill": return ...;
 *     default: return assertNeverWorkerType(workerType);
 *   }
 */
export function assertNeverWorkerType(x: never): never {
  throw new Error(`Unexpected WorkerType: ${JSON.stringify(x)}`);
}
