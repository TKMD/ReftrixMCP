// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ML Worker Thread Resource Limits (PR7e-β1)
 *
 * ONNX Runtime が CPU fallback (onnxruntime-node) に切り替わったとき、
 * `execArgv: []` を指定した Worker Thread は親プロセスの
 * `--max-old-space-size` を継承しないため、デフォルトでは V8 old space
 * が 4GB 未満の既定値に制限されてしまう。その結果、e5-base / DINOv2 の
 * CPU 推論で OOM クラッシュが発生し、Queue-based Backfill が永久に
 * `in_progress` のまま滞留する。
 *
 * When ONNX Runtime falls back to CPU (`onnxruntime-node`), a Worker Thread
 * spawned with `execArgv: []` does NOT inherit the parent's
 * `--max-old-space-size` flag, so V8 old-space defaults to less than 4GB.
 * This causes OOM crashes during e5-base / DINOv2 CPU inference and leaves
 * Queue-based Backfill jobs stuck `in_progress` indefinitely.
 *
 * Fix: explicitly pass `resourceLimits` to `new Worker(...)` so that the
 * worker gets an explicit old-space / young-space / code-range ceiling.
 *
 * 参照 / References:
 * - ADR-0012 §3 BLOCKER 4
 * - Node.js docs: https://nodejs.org/api/worker_threads.html#new-workerfilename-options
 *
 * @module config/worker-resource-limits
 */

import { z } from "zod";

/**
 * Default old-space ceiling (MB) for ML Worker Threads.
 *
 * 4096 MB は e5-base (~500MB arena) + DINOv2 (~800MB arena) + transformers.js
 * pipeline overhead を同時に CPU でロードしても OOM にならない実測値。
 * さらに β1 では Phase 5 親プロセス RSS 上限を 4096 MB に段階緩和するため、
 * Worker old-space をそれと同水準に揃えることで、親プロセスと子 Worker の
 * メモリ上限を対称化する。
 *
 * 4096 MB is empirically the minimum old-space ceiling that keeps e5-base
 * (~500MB arena) + DINOv2 (~800MB arena) + transformers.js pipeline overhead
 * from OOMing on CPU. β1 also raises the Phase 5 parent-process RSS ceiling
 * to 4096 MB, so aligning the Worker old-space with the parent RSS keeps
 * parent/child memory ceilings symmetric.
 */
const DEFAULT_ML_WORKER_MAX_OLD_SPACE_MB = 4096;

/**
 * Fixed secondary limits.
 *
 * young-space=512MB and code-range=256MB are Node.js defaults scaled for
 * ONNX Runtime's large tensor allocations; exposing them as env vars would
 * create too many configuration surfaces.
 */
const ML_WORKER_MAX_YOUNG_GENERATION_MB = 512;
const ML_WORKER_CODE_RANGE_MB = 256;

/**
 * 許容レンジ
 * - 下限 512 MB: e5-base の初期化 (tokenizer + model metadata) だけでも
 *   約 300MB 必要で、ヘッドルームを確保する最小値
 * - 上限 8192 MB: 単一 Worker Thread で 8GB を超える old-space は現実的な
 *   ユースケースが存在せず、over-provisioning 防御
 *
 * Allowed range:
 * - Lower bound 512 MB: e5-base init (tokenizer + model metadata) alone needs
 *   ~300MB, so this is the minimum that preserves any headroom.
 * - Upper bound 8192 MB: no realistic use case for > 8GB old-space in a single
 *   Worker Thread; guards against over-provisioning.
 */
const ML_WORKER_MAX_OLD_SPACE_MIN_MB = 512;
const ML_WORKER_MAX_OLD_SPACE_MAX_MB = 8192;

/**
 * ML Worker resource-limits Zod schema
 */
export const MLWorkerResourceLimitsSchema = z.object({
  /**
   * Worker Thread の V8 old-space 上限（MB）
   * V8 old-space ceiling (MB) for the Worker Thread
   */
  maxOldGenerationSizeMb: z
    .number()
    .int()
    .min(ML_WORKER_MAX_OLD_SPACE_MIN_MB)
    .max(ML_WORKER_MAX_OLD_SPACE_MAX_MB)
    .default(DEFAULT_ML_WORKER_MAX_OLD_SPACE_MB),
  /**
   * Worker Thread の V8 young-space 上限（MB）
   * V8 young-space ceiling (MB) for the Worker Thread
   */
  maxYoungGenerationSizeMb: z.number().int().positive().default(ML_WORKER_MAX_YOUNG_GENERATION_MB),
  /**
   * Worker Thread の code-range 上限（MB）
   * Code-range ceiling (MB) for the Worker Thread
   */
  codeRangeSizeMb: z.number().int().positive().default(ML_WORKER_CODE_RANGE_MB),
});

export type MLWorkerResourceLimits = z.infer<typeof MLWorkerResourceLimitsSchema>;

/**
 * 環境変数から ML Worker Thread の resource-limits をロードする。
 * Load ML Worker Thread resource-limits from environment variables.
 *
 * 環境変数 / Environment variables:
 * - `ML_WORKER_MAX_OLD_SPACE_MB`: V8 old-space ceiling (MB, integer, 512..8192)
 *
 * 不正値（NaN / Infinity / 負値 / 範囲外）は warn してデフォルトにフォールバック。
 * Invalid values (NaN / Infinity / negative / out of range) warn and fall back
 * to defaults.
 *
 * 副作用 / Side effects:
 * - なし (純粋関数) / None (pure function)
 * - 呼び出し側でログ出力すること / Caller is responsible for logging
 */
export function loadMLWorkerResourceLimits(): MLWorkerResourceLimits {
  const raw = process.env["ML_WORKER_MAX_OLD_SPACE_MB"];

  // 未設定 → Zod default
  // Unset → Zod default
  if (raw === undefined || raw === "") {
    return MLWorkerResourceLimitsSchema.parse({});
  }

  const parsed = Number(raw);

  // NaN / Infinity 早期拒絶 (Zod でも弾けるが明示的に)
  // Reject NaN / Infinity explicitly
  if (!Number.isFinite(parsed)) {
    return {
      maxOldGenerationSizeMb: DEFAULT_ML_WORKER_MAX_OLD_SPACE_MB,
      maxYoungGenerationSizeMb: ML_WORKER_MAX_YOUNG_GENERATION_MB,
      codeRangeSizeMb: ML_WORKER_CODE_RANGE_MB,
    };
  }

  const result = MLWorkerResourceLimitsSchema.safeParse({ maxOldGenerationSizeMb: parsed });
  if (!result.success) {
    return {
      maxOldGenerationSizeMb: DEFAULT_ML_WORKER_MAX_OLD_SPACE_MB,
      maxYoungGenerationSizeMb: ML_WORKER_MAX_YOUNG_GENERATION_MB,
      codeRangeSizeMb: ML_WORKER_CODE_RANGE_MB,
    };
  }

  return result.data;
}

/**
 * 新しい Worker Thread を作成する際に渡す resourceLimits オプションを返す。
 * Returns the `resourceLimits` option object to pass to `new Worker(...)`.
 *
 * 使用例 / Usage:
 * ```ts
 * import { getMLWorkerThreadOptions } from "@reftrixmcp/ml/config/worker-resource-limits";
 * new Worker(scriptPath, { execArgv: [], ...getMLWorkerThreadOptions() });
 * ```
 */
export function getMLWorkerThreadOptions(): {
  resourceLimits: {
    maxOldGenerationSizeMb: number;
    maxYoungGenerationSizeMb: number;
    codeRangeSizeMb: number;
  };
} {
  const limits = loadMLWorkerResourceLimits();
  return {
    resourceLimits: {
      maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
      codeRangeSizeMb: limits.codeRangeSizeMb,
    },
  };
}
