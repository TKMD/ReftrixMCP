// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Worker-thread ONNX device gate helpers
 *
 * Pure, side-effect-free helpers that decide the effective ONNX execution
 * device for the e5-base embedding worker thread. Extracted from
 * `worker-thread.ts` so the gate logic is directly unit-testable — the worker
 * module itself only runs as a Worker Thread (it requires `parentPort` at
 * import time), so its gate could otherwise not be exercised in-place.
 *
 * The contract mirrors the in-process gate
 * (`service.ts` `resolveInProcessDevice`, FIND-IMPL-PR1-H-NEW-01): the effective
 * device must HONOR the already-resolved provider (the result of
 * `detectExecutionProvider()` + the OS-level `LD_LIBRARY_PATH` check) and must
 * NOT fall back to a raw `config.device` value (which is set straight from the
 * `ONNX_EXECUTION_PROVIDER` env var). Letting `config.device="cuda"` override a
 * gate decision of `"cpu"` passes an unbacked CUDA device to transformers, which
 * raw-throws on the native `dlopen()` failure when the EP `.so` is absent
 * (root-cause decision `019ec56b`).
 *
 * @module embeddings/worker-thread-device
 */

import type { ExecutionProvider } from "../onnx-provider-detect.js";

/**
 * Resolve the effective ONNX device for the worker-thread pipeline.
 *
 * `resolvedProvider` is already the result of the init gate
 * (`detectExecutionProvider()` — a CUDA EP `.so` filesystem check — plus the
 * OS-level `LD_LIBRARY_PATH` check in `initializePipeline`). This helper simply
 * honors that decision. It deliberately does NOT consult `config.device`: doing
 * so was the line-97 bug that let a `"cuda"` env override a `"cpu"` gate result.
 *
 * Parity: `service.ts` `resolveInProcessDevice()` likewise returns the gate
 * result (`resolved`), never a raw configured device when CUDA is unbacked.
 *
 * @param resolvedProvider - The provider already resolved by the init gate.
 * @returns The effective device to pass to the transformers pipeline.
 */
export function resolveWorkerEffectiveDevice(
  resolvedProvider: ExecutionProvider
): ExecutionProvider {
  return resolvedProvider;
}

/**
 * Decide whether a `switch-provider` request to CUDA may proceed.
 *
 * Mirrors the init-time AND gate (`initializePipeline`, line ~88): CUDA may be
 * used only if BOTH the CUDA EP shared library is present
 * (`verifyCudaAvailability`) AND `LD_LIBRARY_PATH` was set at the OS level
 * (`isLdLibraryPathSetAtOsLevel`). Pre-fix, `switch-provider` gated on
 * `verifyCudaAvailability` alone — so a host with the EP `.so` but an unset
 * `LD_LIBRARY_PATH` would let `resolvedProvider="cuda"` through, producing an
 * unbacked CUDA device and a `dlopen()` raw throw (UB-6 init parity).
 *
 * The two checks are passed in as functions so this helper stays pure and
 * deterministically testable (the production caller passes the real
 * `verifyCudaAvailability` / `isLdLibraryPathSetAtOsLevel`).
 *
 * @param verifyCuda - CUDA EP `.so` filesystem availability check.
 * @param isLdSet - OS-level `LD_LIBRARY_PATH` presence check.
 * @returns true only if both checks pass (CUDA switch permitted).
 */
export function canSwitchToCuda(verifyCuda: () => boolean, isLdSet: () => boolean): boolean {
  return verifyCuda() && isLdSet();
}
