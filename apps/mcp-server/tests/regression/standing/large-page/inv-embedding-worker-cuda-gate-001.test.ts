// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-EMBEDDING-WORKER-CUDA-GATE-001 (mandatory standing)
 *
 * Plan v1 §5.1 (`embedding-worker-cuda-gate-fix`, IO Plan Decision V1 PR-1 = APPROVE,
 * anchor `019ec629`). PR-1 (CORE gate parity) standing invariant.
 *
 * ## Contract / 不変条件
 *
 * On a host where the CUDA execution provider shared library
 * (`libonnxruntime_providers_cuda.so`) is ABSENT (or `LD_LIBRARY_PATH` is not set
 * at the OS level), the e5-base embedding **worker-thread** path must resolve its
 * effective ONNX device to `cpu` and complete CPU inference — it must NOT pass an
 * unbacked `device:"cuda"` to transformers (which raw-throws on the native
 * `dlopen()` failure). This mirrors the in-process gate
 * (`service.ts resolveInProcessDevice`, FIND-IMPL-PR1-H-NEW-01).
 *
 * CUDA-EP `.so` 不在 (または OS レベルで `LD_LIBRARY_PATH` 未設定) の host では、
 * e5-base embedding の **worker-thread** path は effective device を `cpu` に解決し
 * CPU 推論を完走しなければならない (unbacked `device:"cuda"` を transformers に
 * 渡さない)。in-process gate (`resolveInProcessDevice`) と parity。
 *
 * ## Why a standing regression / なぜ常設 regression か
 *
 * Pre-fix `worker-thread.ts:97` computed `effectiveDevice = resolvedProvider ===
 * "cuda" ? "cuda" : config.device`. The init gate (line 88-95) correctly resolves
 * `resolvedProvider="cpu"` on a host without the EP `.so`, but `config.device`
 * (set straight from `ONNX_EXECUTION_PROVIDER=cuda`) overrode it → `effectiveDevice
 * ="cuda"` → first-attempt pipeline creation raw-throws on dlopen, the search layer
 * swallows the throw into `null`, and every search tool returns `success:true
 * total:0` (silent degradation / no-fake-success violation, root-cause decision
 * `019ec56b`). A drift back to a `config.device` ternary, or a switch-provider path
 * that gates on `verifyCudaAvailability` alone (without the `LD_LIBRARY_PATH` AND),
 * silently reintroduces the all-types-0-results incident. This standing test makes
 * such drift CI-failing.
 *
 * ## Verification method (Plan §5.1, 2 layers)
 *
 *   - **Layer (i) pure helper unit**: `resolveWorkerEffectiveDevice(resolvedProvider)`
 *     and `canSwitchToCuda(verifyFn, ldFn)` are extracted pure helpers
 *     (`worker-thread-device.ts`) so the gate logic is directly testable — the
 *     production `worker-thread.ts` runs only as a Worker Thread (parentPort
 *     required) and `worker-thread.test.ts` carries a MIRROR implementation, so the
 *     gate is otherwise untestable in-place (TPA-Plan-L-3). The helper is the SAME
 *     module the production worker imports.
 *   - **Layer (iii) AST source-pin**: `worker-thread.ts` source is pinned to (a)
 *     NOT reference `config.device` in the effectiveDevice assignment (= it routes
 *     through the helper / `= resolvedProvider`), and (b) gate the switch-provider
 *     CUDA branch through `isLdLibraryPathSetAtOsLevel` (init parity, UB-6). Follows
 *     the existing large-page AST source-pin precedent
 *     (`inv-rss-budget-001-malloc-arena-max-3-site`).
 *
 * CI-failing executable invariant. `.skip()` / `.todo()` forbidden; failure is a
 * P0 incident handled by capture-embedding-engineer + pipeline-engineer.
 *
 * ## Mock boundary note (SEC-RE-L-5)
 *
 * The unit layer drives the gate deterministically (no real ONNX dlopen). The
 * `.so` non-disclosure assertion uses a REAL ONNX dlopen error message fixture
 * (`libonnxruntime_providers_cuda.so: cannot open shared object file`) through
 * `sanitizeErrorMessage` to make the CWE-209 assertion non-vacuous. The RUNTIME
 * guarantee (real CPU completion + search total>0 on a CUDA-EP-absent host, pass^3)
 * is the real-machine verification gate (Plan §6 Layer A/B/D), NOT claimed here.
 *
 * @see  §5.1
 * @see packages/ml/src/embeddings/worker-thread-device.ts (extracted gate helpers)
 * @see packages/ml/src/embeddings/worker-thread.ts (effectiveDevice line 97 + switch-provider)
 * @see packages/ml/src/embeddings/service.ts resolveInProcessDevice (in-process parity ref)
 *
 * @module tests/regression/standing/large-page/inv-embedding-worker-cuda-gate-001
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  resolveWorkerEffectiveDevice,
  canSwitchToCuda,
} from "../../../../../../packages/ml/src/embeddings/worker-thread-device";
import { sanitizeErrorMessage } from "../../../../src/utils/sanitize-error";

// ============================================================================
// Constants / 定数
// ============================================================================

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const REPO_ROOT = path.resolve(MCP_SERVER_ROOT, "..", "..");
const WORKER_THREAD_PATH = path.resolve(REPO_ROOT, "packages/ml/src/embeddings/worker-thread.ts");

/** A real ONNX Runtime native dlopen error message (CUDA EP .so absent). */
const REAL_DLOPEN_ERROR =
  "Error: libonnxruntime_providers_cuda.so: cannot open shared object file: No such file or directory";

// ============================================================================
// Tests / テスト
// ============================================================================

describe("INV-EMBEDDING-WORKER-CUDA-GATE-001: worker-thread effectiveDevice gate parity", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-EMBEDDING-WORKER-CUDA-GATE-001");
  });

  // ==========================================================================
  // Layer (i) — pure helper unit (gate honoring, config.device NOT referenced)
  // ==========================================================================

  it("INV-EMBEDDING-WORKER-CUDA-GATE-001 (i): CUDA-EP absent (resolvedProvider=cpu) → effectiveDevice=cpu (gate honored, no config.device override)", () => {
    // The gate already resolved 'cpu' (EP .so absent OR LD_LIBRARY_PATH unset).
    // effectiveDevice MUST honor that, regardless of any config.device='cuda'.
    expect(resolveWorkerEffectiveDevice("cpu")).toBe("cpu");
  });

  it("INV-EMBEDDING-WORKER-CUDA-GATE-001 (i): CUDA-EP present (resolvedProvider=cuda) → effectiveDevice=cuda (no regression)", () => {
    expect(resolveWorkerEffectiveDevice("cuda")).toBe("cuda");
  });

  it("INV-EMBEDDING-WORKER-CUDA-GATE-001 (i): switch-provider EP .so present + LD set → cuda permitted (AND gate true)", () => {
    expect(
      canSwitchToCuda(
        () => true, // verifyCudaAvailability: EP .so present
        () => true // isLdLibraryPathSetAtOsLevel: LD set
      )
    ).toBe(true);
  });

  it("INV-EMBEDDING-WORKER-CUDA-GATE-001 (i): switch-provider EP .so present but LD UNSET → cpu downgrade (UB-6 init parity, AND gate false)", () => {
    // This is the residual gap PR-1 Step 1b closes: pre-fix switch-provider gated
    // on verifyCudaAvailability ALONE; a host with the EP .so but LD_LIBRARY_PATH
    // unset would let resolvedProvider="cuda" through → effectiveDevice="cuda" →
    // dlopen raw throw. The AND gate must reject it.
    expect(
      canSwitchToCuda(
        () => true, // verifyCudaAvailability: EP .so present
        () => false // isLdLibraryPathSetAtOsLevel: LD UNSET at OS level
      )
    ).toBe(false);
  });

  it("INV-EMBEDDING-WORKER-CUDA-GATE-001 (i): switch-provider EP .so absent → cpu downgrade (AND gate false)", () => {
    expect(
      canSwitchToCuda(
        () => false, // verifyCudaAvailability: EP .so absent
        () => true
      )
    ).toBe(false);
  });

  // ==========================================================================
  // Layer (i) — CWE-209 .so non-disclosure (SEC-RE-L-5, real dlopen fixture)
  // ==========================================================================

  it("INV-EMBEDDING-WORKER-CUDA-GATE-001 (i): real ONNX dlopen error is sanitized — no libonnxruntime/.so/path leak (non-vacuous)", () => {
    // Non-vacuous guard: the fixture is a REAL ONNX dlopen message that DOES
    // contain the leaking tokens, so a no-op sanitizer would fail this test.
    expect(REAL_DLOPEN_ERROR).toContain("libonnxruntime_providers_cuda.so");

    const sanitized = sanitizeErrorMessage(new Error(REAL_DLOPEN_ERROR));
    expect(sanitized).not.toContain("libonnxruntime");
    expect(sanitized).not.toContain(".so");
    expect(sanitized).not.toContain("/");
  });

  // ==========================================================================
  // Layer (iii) — AST source-pin on worker-thread.ts
  // ==========================================================================

  it("INV-EMBEDDING-WORKER-CUDA-GATE-001 (iii): worker-thread.ts effectiveDevice does NOT reference config.device (gate respected)", () => {
    const source = fs.readFileSync(WORKER_THREAD_PATH, "utf-8");

    // The effectiveDevice assignment must NOT read config.device (the line-97 bug).
    // Pin: there is an `effectiveDevice` assignment, and no
    // `effectiveDevice = ... config.device` ternary/fallback remains.
    // Allow an optional `: ExecutionProvider` type annotation on the declaration.
    const hasEffectiveDeviceAssign = /const\s+effectiveDevice\b[^=\n]*=/.test(source);
    expect(hasEffectiveDeviceAssign).toBe(true);

    const referencesConfigDeviceInAssign = /effectiveDevice\b[^=\n]*=[^;\n]*config\.device/.test(
      source
    );
    expect(referencesConfigDeviceInAssign).toBe(false);

    // Pin: effectiveDevice is derived from the gate result (resolveWorkerEffectiveDevice
    // helper or the resolvedProvider directly).
    const derivesFromGate =
      /effectiveDevice\b[^=\n]*=\s*resolveWorkerEffectiveDevice\s*\(/.test(source) ||
      /effectiveDevice\b[^=\n]*=\s*resolvedProvider\b/.test(source);
    expect(derivesFromGate).toBe(true);
  });

  it("INV-EMBEDDING-WORKER-CUDA-GATE-001 (iii): worker-thread.ts switch-provider CUDA branch ANDs isLdLibraryPathSetAtOsLevel (UB-6 init parity)", () => {
    const source = fs.readFileSync(WORKER_THREAD_PATH, "utf-8");

    // The switch-provider CUDA gate must reference the LD check (via the helper
    // canSwitchToCuda, or inline AND with isLdLibraryPathSetAtOsLevel) so that
    // init (line 88) and switch-provider both AND the two gates.
    const usesCanSwitchHelper = /canSwitchToCuda\s*\(/.test(source);
    const inlineLdAndGate = /isLdLibraryPathSetAtOsLevel\s*\(\s*\)/.test(source);
    expect(usesCanSwitchHelper || inlineLdAndGate).toBe(true);

    // Specifically the switch-provider block must not gate on verifyCudaAvailability
    // ALONE without the LD check anywhere in the file.
    expect(source).toContain("isLdLibraryPathSetAtOsLevel");
  });
});
