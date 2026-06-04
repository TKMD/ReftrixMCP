// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-VISION-UNLOAD-001: `unloadOllamaVisionModelAndVerify()` MUST verify
 *   Ollama Vision residual via `/api/ps` polling (3 attempts) after
 *   `POST /api/generate keep_alive=0`, persist the outcome via
 *   `audit_logs.action='vision_unload_verified'` (residualBytes=0) or
 *   `'vision_unload_residual_persisted'` (residualBytes>0), and tolerate
 *   audit emit failure via L1.5 SLO_MARKER fail-open compensation.
 *
 * INV-VISION-UNLOAD-001: `unloadOllamaVisionModelAndVerify()` must verify
 *   Vision residual after unload, emit appropriate audit_logs action, and
 *   fall back to `[SLO_MARKER] vision_unload_audit_emit_failed` on emit
 *   failure.
 *
 * ## Test cases per V1 §4.1 + §6.1
 *
 *   - A: success path — `unloaded=true`, audit emit `vision_unload_verified`
 *   - B: residual persisted (3 attempts) — `unloaded=false`, audit emit
 *     `vision_unload_residual_persisted`
 *   - C: unload ack failed (5xx) + probe success — `unloaded=true`
 *     (probe trumps POST 5xx)
 *   - D: probe timeout — `unloaded=false`, `probeError` populated
 *   - F (V1 NEW per U-T3V-3): emit fail-open — `[SLO_MARKER]
 *     vision_unload_audit_emit_failed` log line preserved on emit throw
 *
 * @see Plan v3 T3-Vision V1 §3.1 Layer 1 / §4.1 INV-VISION-UNLOAD-001
 * @see Plan v3 T3-Vision V1 §1.3 U-T3V-3 (L1.5 SLO_MARKER)
 * @see ADR-0011 Amendment 3 SLO 5-tier (L0/L1/L1.5/L2/L3)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertInvName } from "../_setup/inv-assert";

// ============================================================================
// Mock setup — fetch + emitSupervisorAuditLog
// ============================================================================

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const mockEmit = vi.fn();
vi.mock("../../../../src/services/worker-supervisor-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/services/worker-supervisor-helpers")>();
  return {
    ...actual,
    emitSupervisorAuditLog: (...args: unknown[]) => mockEmit(...args),
  };
});

describe("INV-VISION-UNLOAD-001 — unloadOllamaVisionModelAndVerify contract", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-VISION-UNLOAD-001");
    vi.clearAllMocks();
    // Reset emit mock implementation between tests (otherwise case F's throw
    // bleeds into case G).
    mockEmit.mockReset();
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Helper: build /api/ps response
  // --------------------------------------------------------------------------
  function psResponse(models: Array<{ name?: string; size_vram?: number }>): Response {
    return new Response(JSON.stringify({ models }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --------------------------------------------------------------------------
  // Case A — success path (unloaded=true)
  // --------------------------------------------------------------------------
  it("INV-VISION-UNLOAD-001 case A: unload + verify success → vision_unload_verified emit", async () => {
    // Arrange: POST /api/generate succeeds; /api/ps returns size_vram=0.
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // POST keep_alive=0
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 0 }])); // /api/ps

    const { unloadOllamaVisionModelAndVerify } =
      await import("../../../../src/workers/phases/types");

    // Act
    const result = await unloadOllamaVisionModelAndVerify();

    // Assert: unloaded contract.
    expect(result.unloaded).toBe(true);
    expect(result.residualBytes).toBe(0);
    expect(result.unloadAckReceived).toBe(true);
    expect(result.probeAttempted).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.elapsedMs)).toBe(true);

    // Assert: audit emit primary path with vision_unload_verified action.
    expect(mockEmit).toHaveBeenCalledWith(
      "vision_unload_verified",
      "page",
      expect.objectContaining({
        model: "llama3.2-vision",
        residualBytes: 0,
      }),
      "success"
    );
  });

  // --------------------------------------------------------------------------
  // Case B — residual persisted (3 attempts)
  // --------------------------------------------------------------------------
  it("INV-VISION-UNLOAD-001 case B: residual persisted → vision_unload_residual_persisted emit", async () => {
    // Arrange: POST succeeds, all 3 /api/ps polls show residual.
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(psResponse([{ name: "llama3.2-vision", size_vram: 5_000_000_000 }]));

    const { unloadOllamaVisionModelAndVerify } =
      await import("../../../../src/workers/phases/types");

    // Act
    const result = await unloadOllamaVisionModelAndVerify();

    // Assert
    expect(result.unloaded).toBe(false);
    expect(result.residualBytes).toBe(5_000_000_000);
    expect(result.probeAttempted).toBe(true);

    // Audit: residual_persisted action.
    expect(mockEmit).toHaveBeenCalledWith(
      "vision_unload_residual_persisted",
      "page",
      expect.objectContaining({
        residualBytes: 5_000_000_000,
        model: "llama3.2-vision",
      }),
      "failure"
    );
  }, 15_000);

  // --------------------------------------------------------------------------
  // Case C — POST 5xx + probe success → unloaded=true (probe trumps POST)
  // --------------------------------------------------------------------------
  it("INV-VISION-UNLOAD-001 case C: POST 5xx but probe shows size_vram=0 → unloaded=true", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 })) // POST 5xx
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 0 }])); // /api/ps

    const { unloadOllamaVisionModelAndVerify } =
      await import("../../../../src/workers/phases/types");

    const result = await unloadOllamaVisionModelAndVerify();

    expect(result.unloaded).toBe(true);
    expect(result.unloadAckReceived).toBe(false);
    expect(result.residualBytes).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case D — probe error all 3 attempts → unloaded=false, probeError set
  // --------------------------------------------------------------------------
  it("INV-VISION-UNLOAD-001 case D: probe error → unloaded=false + probeError populated", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // POST
      .mockRejectedValue(new Error("ECONNREFUSED")); // /api/ps × 3

    const { unloadOllamaVisionModelAndVerify } =
      await import("../../../../src/workers/phases/types");

    const result = await unloadOllamaVisionModelAndVerify();

    expect(result.unloaded).toBe(false);
    expect(result.probeAttempted).toBe(true);
    expect(typeof result.probeError).toBe("string");
    // PII contract: probeError is sanitized (no internal stack traces).
    expect(result.probeError).not.toMatch(/\bat\s+/);
  }, 15_000);

  // --------------------------------------------------------------------------
  // Case F (V1 NEW U-T3V-3) — emit fail-open compensation
  // --------------------------------------------------------------------------
  it("INV-VISION-UNLOAD-001 case F: emit throw → [SLO_MARKER] log line + caller behavior unchanged", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 0 }]));

    // Stub emit to throw (DB unavailable simulation).
    mockEmit.mockImplementation(() => {
      throw new Error("Audit DB connection refused");
    });

    // Spy on console.error for [SLO_MARKER] capture.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unloadOllamaVisionModelAndVerify } =
      await import("../../../../src/workers/phases/types");

    // Act — must NOT throw despite emit failure.
    const result = await unloadOllamaVisionModelAndVerify();

    // Caller behavior unchanged.
    expect(result.unloaded).toBe(true);
    expect(result.residualBytes).toBe(0);

    // [SLO_MARKER] log line emitted (L1.5 SLO source).
    const slo_marker_calls = consoleErrorSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("[SLO_MARKER] vision_unload_audit_emit_failed")
    );
    expect(slo_marker_calls.length).toBeGreaterThanOrEqual(1);

    // PII contract — payload contains only allowed fields.
    const sloPayload = slo_marker_calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(sloPayload).toBeDefined();
    expect(sloPayload).toHaveProperty("reason");
    expect(sloPayload).toHaveProperty("residualBytes", 0);
    expect(sloPayload).toHaveProperty("model", "llama3.2-vision");
    // No URL paths / boot tokens / stack traces.
    const reason = sloPayload?.["reason"] as string;
    expect(reason).not.toMatch(/\bat\s+/);

    consoleErrorSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // NaN/Infinity defense (V1 §3.1 step 5)
  // --------------------------------------------------------------------------
  it("INV-VISION-UNLOAD-001 case G (NaN defense): /api/ps returns size_vram=NaN → residualBytes=0", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: NaN }]));

    const { unloadOllamaVisionModelAndVerify } =
      await import("../../../../src/workers/phases/types");

    const result = await unloadOllamaVisionModelAndVerify();

    // NaN defended → 0 → unloaded=true.
    expect(result.unloaded).toBe(true);
    expect(result.residualBytes).toBe(0);
    expect(Number.isFinite(result.residualBytes)).toBe(true);
  });
});
