// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * vision-unload-handshake unit tests (PR-D-9 UNB-IMPL-1).
 *
 * ADR-0011 Amendment 2 §A2.2.3 Precondition Check の 3 分岐を網羅:
 *   - vision_unloaded (no Vision residual / size_vram === 0 → proceed)
 *   - vision_residual (size_vram > 0 → fail-closed defer + paired audit emit)
 *   - probe_failed (timeout / network / non-OK / parse → fail-closed defer)
 *
 * @see apps/mcp-server/src/services/vision/vision-unload-handshake.ts
 * @see ADR-0011 Amendment 2 §A2.2.3 (line 481-496)
 * @see PR-D-9 Finding Registry TPA-IMPL-01 + IO Impl Decision UNB-IMPL-1
 *
 * @module tests/services/vision/vision-unload-handshake
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  verifyVisionUnloadPrecondition,
  type VisionPreconditionResult,
} from "../../../src/services/vision/vision-unload-handshake";
import {
  AUDIT_ACTION_VISION_RESIDUAL_DETECTED,
  AUDIT_ACTION_BACKFILL_SECONDARY_DEFERRED,
  AUDIT_ACTION_VISION_PROBE_FAILED,
} from "../../../src/audit/audit-actions";

// ============================================================================
// Helpers
// ============================================================================

type AuditEmitArgs = [
  string,
  "page" | "embedding-backfill",
  Record<string, unknown>,
  "success" | "failure" | "denied",
];

interface OllamaModel {
  name?: string;
  size_vram?: number;
}

function makeOllamaPsResponse(models: OllamaModel[] | null | undefined): Response {
  return {
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => ({ models }),
  } as unknown as Response;
}

function makeOllamaErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: async (): Promise<unknown> => ({}),
  } as unknown as Response;
}

// ============================================================================
// Tests
// ============================================================================

describe("verifyVisionUnloadPrecondition (PR-D-9 UNB-IMPL-1, ADR-0011 Amendment 2 §A2.2.3)", () => {
  let auditEmit: ReturnType<typeof vi.fn<AuditEmitArgs, void>>;

  beforeEach(() => {
    auditEmit = vi.fn<AuditEmitArgs, void>();
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Branch (a): Vision unloaded → proceed (no audit emit)
  // --------------------------------------------------------------------------

  it("Branch (a) — empty models array → vision_unloaded (no audit emit)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeOllamaPsResponse([]));
    const result: VisionPreconditionResult = await verifyVisionUnloadPrecondition({
      fetchFn,
      auditEmit,
    });
    expect(result.status).toBe("vision_unloaded");
    if (result.status === "vision_unloaded") {
      expect(result.sizeVramBytes).toBe(0);
    }
    expect(auditEmit).not.toHaveBeenCalled();
  });

  it("Branch (a) — null models field → vision_unloaded (no audit emit)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeOllamaPsResponse(null));
    const result = await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });
    expect(result.status).toBe("vision_unloaded");
    expect(auditEmit).not.toHaveBeenCalled();
  });

  it("Branch (a) — undefined models field → vision_unloaded (no audit emit)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeOllamaPsResponse(undefined));
    const result = await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });
    expect(result.status).toBe("vision_unloaded");
    expect(auditEmit).not.toHaveBeenCalled();
  });

  it("Branch (a) — non-vision model with size_vram > 0 → vision_unloaded", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(makeOllamaPsResponse([{ name: "llama3.1:8b", size_vram: 5_000_000_000 }]));
    const result = await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });
    expect(result.status).toBe("vision_unloaded");
    expect(auditEmit).not.toHaveBeenCalled();
  });

  it("Branch (a) — vision model with size_vram === 0 → vision_unloaded (Vision idle)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(makeOllamaPsResponse([{ name: "llama3.2-vision:11b", size_vram: 0 }]));
    const result = await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });
    expect(result.status).toBe("vision_unloaded");
    expect(auditEmit).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Branch (b): Vision residual → fail-closed defer + paired audit emit
  // --------------------------------------------------------------------------

  it("Branch (b) — vision model with size_vram > 0 → vision_residual + paired audit emit", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        makeOllamaPsResponse([{ name: "llama3.2-vision:11b", size_vram: 11_403_141_120 }])
      );
    const result = await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });

    expect(result.status).toBe("vision_residual");
    if (result.status === "vision_residual") {
      expect(result.sizeVramBytes).toBe(11_403_141_120);
      expect(result.modelName).toBe("llama3.2-vision:11b");
      expect(result.deferred).toBe(true);
    }

    // Paired emit: residual diagnostic + spawn defer rationale.
    expect(auditEmit).toHaveBeenCalledTimes(2);
    expect(auditEmit).toHaveBeenNthCalledWith(
      1,
      AUDIT_ACTION_VISION_RESIDUAL_DETECTED,
      "embedding-backfill",
      { sizeVramBytes: 11_403_141_120, modelName: "llama3.2-vision:11b" },
      "failure"
    );
    expect(auditEmit).toHaveBeenNthCalledWith(
      2,
      AUDIT_ACTION_BACKFILL_SECONDARY_DEFERRED,
      "embedding-backfill",
      { reason: "vision_residual", sizeVramBytes: 11_403_141_120 },
      "denied"
    );
  });

  it("Branch (b) — Apple Silicon Metal Unified Memory reported as size_vram > 0 → vision_residual", async () => {
    // ADR-0011 Amendment 1 §C: Apple Silicon Metal Unified Memory も
    // /api/ps の size_vram > 0 で報告される。同 contract path で defer する。
    const fetchFn = vi
      .fn()
      .mockResolvedValue(makeOllamaPsResponse([{ name: "llama3.2-vision:11b", size_vram: 1 }]));
    const result = await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });
    expect(result.status).toBe("vision_residual");
    expect(auditEmit).toHaveBeenCalledTimes(2);
  });

  it("Branch (b) — finds first vision residual when multiple models loaded", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeOllamaPsResponse([
        { name: "llama3.1:8b", size_vram: 5_000_000_000 },
        { name: "llama3.2-vision:11b", size_vram: 10_000_000_000 },
      ])
    );
    const result = await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });
    expect(result.status).toBe("vision_residual");
    if (result.status === "vision_residual") {
      expect(result.modelName).toBe("llama3.2-vision:11b");
    }
  });

  // --------------------------------------------------------------------------
  // Branch (c): probe_failed → fail-closed defer + paired audit emit
  // --------------------------------------------------------------------------

  it("Branch (c) — fetch throws (network error) → probe_failed + paired audit emit", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });

    expect(result.status).toBe("probe_failed");
    if (result.status === "probe_failed") {
      expect(result.failClosed).toBe(true);
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }

    // Paired emit: probe failure diagnostic + spawn defer rationale.
    expect(auditEmit).toHaveBeenCalledTimes(2);
    const firstCall = auditEmit.mock.calls[0];
    const secondCall = auditEmit.mock.calls[1];
    if (!firstCall || !secondCall) throw new Error("expected audit emit calls");
    expect(firstCall[0]).toBe(AUDIT_ACTION_VISION_PROBE_FAILED);
    expect(firstCall[1]).toBe("embedding-backfill");
    expect(firstCall[3]).toBe("failure");
    expect(secondCall[0]).toBe(AUDIT_ACTION_BACKFILL_SECONDARY_DEFERRED);
    expect(secondCall[1]).toBe("embedding-backfill");
    expect((secondCall[2] as { reason: string }).reason).toBe("probe_failed");
    expect(secondCall[3]).toBe("failure");
  });

  it("Branch (c) — non-OK HTTP status → probe_failed + paired audit emit", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeOllamaErrorResponse(503));
    const result = await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });

    expect(result.status).toBe("probe_failed");
    if (result.status === "probe_failed") {
      expect(result.error).toContain("503");
    }
    expect(auditEmit).toHaveBeenCalledTimes(2);
    expect(auditEmit.mock.calls[0]?.[0]).toBe(AUDIT_ACTION_VISION_PROBE_FAILED);
    expect(auditEmit.mock.calls[1]?.[0]).toBe(AUDIT_ACTION_BACKFILL_SECONDARY_DEFERRED);
  });

  it("Branch (c) — JSON parse failure → probe_failed + paired audit emit", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => {
        throw new Error("Invalid JSON");
      },
    } as unknown as Response);

    const result = await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });
    expect(result.status).toBe("probe_failed");
    expect(auditEmit).toHaveBeenCalledTimes(2);
  });

  // --------------------------------------------------------------------------
  // SSRF + URL validation
  // --------------------------------------------------------------------------

  it("Uses validateOllamaLocalhostUrl — non-localhost OLLAMA_HOST falls back to default", async () => {
    process.env.OLLAMA_HOST = "http://evil.example.com:11434";
    const fetchFn = vi.fn().mockResolvedValue(makeOllamaPsResponse([]));
    await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = fetchFn.mock.calls[0]?.[0] as string;
    expect(url.startsWith("http://localhost:11434")).toBe(true);
    expect(url).not.toContain("evil.example.com");
  });

  it("Uses validateOllamaLocalhostUrl — accepts 127.0.0.1 and ::1 hosts", async () => {
    process.env.OLLAMA_HOST = "http://127.0.0.1:11434";
    const fetchFn = vi.fn().mockResolvedValue(makeOllamaPsResponse([]));
    await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });
    const url = fetchFn.mock.calls[0]?.[0] as string;
    expect(url.startsWith("http://127.0.0.1:11434")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Probe target verification (always /api/ps with timeout)
  // --------------------------------------------------------------------------

  it("Probes /api/ps endpoint with AbortSignal (3s timeout per ADR-0011 Amendment 2 §A2.2.3 step 1)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeOllamaPsResponse([]));
    await verifyVisionUnloadPrecondition({ fetchFn, auditEmit });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/api/ps")).toBe(true);
    expect(init.method).toBe("GET");
    expect(init.signal).toBeDefined();
  });
});
