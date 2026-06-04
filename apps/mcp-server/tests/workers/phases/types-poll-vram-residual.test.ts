// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `pollVramResidual()` helper unit test (V1 §1.7 / U-T3V-7).
 *
 * Plan v3 T3-Vision V1 §1.7 で `unloadOllamaVisionModelAndVerify()` の
 * cyclomatic complexity を ≤5 に抑えるため抽出された helper の動作検証。
 *
 * Plan v3 IO Impl Decision V1 §5 Option (a) refactor (2026-05-11):
 *   `pollVramResidual()` を 3 sub-helpers に split:
 *     - `extractMaxResidual()` : pure max-extraction from `models[]` array
 *     - `attemptVramProbe()`   : single HTTP GET /api/ps + parse + extract
 *     - `pollWithBudget()`     : retry loop orchestrator (3-attempt + budget)
 *   各 sub-helper は cyclomatic ≤5 contract を遵守。本テストは:
 *     1. 各 sub-helper を独立 unit-test (boundary cases)
 *     2. 既存 6 cases を parent `pollVramResidual()` で維持 (semantic equivalence)
 *
 * Coverage per V1 §6.2:
 *   - 200 OK with size_vram=0 → maxResidualBytes=0, observedSuccessfully=true (early-return)
 *   - 200 OK with size_vram>0 → maxResidualBytes preserved
 *   - 5xx response → probeError populated, observedSuccessfully=false
 *   - timeout / network error → probeError populated, observedSuccessfully=false
 *
 * @see Plan v3 T3-Vision V1 §1.7 / §6.2 (NEW unit test)
 * @see IO Impl Decision V1 §5 (Option (a) cyclomatic mitigation)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function psResponse(models: Array<{ name?: string; size_vram?: number }>): Response {
  return new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================================
// Sub-helper #1: extractMaxResidual()
// Pure function — does not perform I/O; tests do not need vi.stubGlobal('fetch').
// ============================================================================

describe("extractMaxResidual — IO Impl Decision V1 §5 sub-helper #1", () => {
  it("empty array → 0", async () => {
    const { extractMaxResidual } = await import("../../../src/workers/phases/types");
    expect(extractMaxResidual([])).toBe(0);
  });

  it("single matching model → returns its size_vram", async () => {
    const { extractMaxResidual } = await import("../../../src/workers/phases/types");
    expect(extractMaxResidual([{ name: "llama3.2-vision", size_vram: 1_500 }])).toBe(1_500);
  });

  it("multiple matching models → returns max", async () => {
    const { extractMaxResidual } = await import("../../../src/workers/phases/types");
    expect(
      extractMaxResidual([
        { name: "llama3.2-vision", size_vram: 1_000 },
        { name: "llama3.2-vision:11b", size_vram: 8_000_000_000 },
        { name: "llama3.2-vision", size_vram: 2_000 },
      ])
    ).toBe(8_000_000_000);
  });

  it("non-matching prefix ignored (e.g. llama3.2-text)", async () => {
    const { extractMaxResidual } = await import("../../../src/workers/phases/types");
    expect(extractMaxResidual([{ name: "llama3.2-text", size_vram: 9_999 }])).toBe(0);
  });

  it("Apple Silicon Metal Unified Memory: llama3.2-vision:11b matched via prefix", async () => {
    const { extractMaxResidual } = await import("../../../src/workers/phases/types");
    expect(extractMaxResidual([{ name: "llama3.2-vision:11b", size_vram: 8_000_000_000 }])).toBe(
      8_000_000_000
    );
  });

  it("NaN size_vram defended (Number.isFinite filter)", async () => {
    const { extractMaxResidual } = await import("../../../src/workers/phases/types");
    expect(extractMaxResidual([{ name: "llama3.2-vision", size_vram: Number.NaN }])).toBe(0);
  });

  it("Infinity size_vram defended (Number.isFinite filter)", async () => {
    const { extractMaxResidual } = await import("../../../src/workers/phases/types");
    expect(
      extractMaxResidual([{ name: "llama3.2-vision", size_vram: Number.POSITIVE_INFINITY }])
    ).toBe(0);
  });

  it("missing name / size_vram fields → ignored", async () => {
    const { extractMaxResidual } = await import("../../../src/workers/phases/types");
    expect(
      extractMaxResidual([
        { size_vram: 5_000 }, // no name
        { name: "llama3.2-vision" }, // no size_vram
        { name: "llama3.2-vision", size_vram: 3_000 }, // valid
      ])
    ).toBe(3_000);
  });

  it("null/undefined entries safely ignored", async () => {
    const { extractMaxResidual } = await import("../../../src/workers/phases/types");
    expect(
      extractMaxResidual([null, undefined, { name: "llama3.2-vision", size_vram: 7_000 }])
    ).toBe(7_000);
  });
});

// ============================================================================
// Sub-helper #2: attemptVramProbe()
// Single HTTP attempt — uses mockFetch.
// ============================================================================

describe("attemptVramProbe — IO Impl Decision V1 §5 sub-helper #2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("200 OK → observedSuccessfully=true, attemptResidual extracted", async () => {
    mockFetch.mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 4_500 }]));
    const { attemptVramProbe } = await import("../../../src/workers/phases/types");

    const result = await attemptVramProbe("http://127.0.0.1:11434", 1_000);

    expect(result.observedSuccessfully).toBe(true);
    expect(result.attemptResidual).toBe(4_500);
    expect(result.probeError).toBeUndefined();
  });

  it("200 OK with size_vram=0 → observedSuccessfully=true, attemptResidual=0", async () => {
    mockFetch.mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 0 }]));
    const { attemptVramProbe } = await import("../../../src/workers/phases/types");

    const result = await attemptVramProbe("http://127.0.0.1:11434", 1_000);

    expect(result.observedSuccessfully).toBe(true);
    expect(result.attemptResidual).toBe(0);
    expect(result.probeError).toBeUndefined();
  });

  it("HTTP 503 → observedSuccessfully=false, probeError contains HTTP 503", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const { attemptVramProbe } = await import("../../../src/workers/phases/types");

    const result = await attemptVramProbe("http://127.0.0.1:11434", 1_000);

    expect(result.observedSuccessfully).toBe(false);
    expect(result.attemptResidual).toBe(0);
    expect(result.probeError).toMatch(/HTTP 503/);
  });

  it("HTTP 500 → observedSuccessfully=false, probeError contains HTTP 500", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const { attemptVramProbe } = await import("../../../src/workers/phases/types");

    const result = await attemptVramProbe("http://127.0.0.1:11434", 1_000);

    expect(result.observedSuccessfully).toBe(false);
    expect(result.probeError).toMatch(/HTTP 500/);
  });

  it("network error (ECONNREFUSED) → observedSuccessfully=false, probeError sanitized", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { attemptVramProbe } = await import("../../../src/workers/phases/types");

    const result = await attemptVramProbe("http://127.0.0.1:11434", 1_000);

    expect(result.observedSuccessfully).toBe(false);
    expect(result.attemptResidual).toBe(0);
    expect(typeof result.probeError).toBe("string");
    // PII contract — sanitizeErrorMessage strips internal stack frames (CWE-209)
    expect(result.probeError).not.toMatch(/\bat\s+/);
  });

  it("malformed JSON response → observedSuccessfully=false (parse error caught)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("not-valid-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const { attemptVramProbe } = await import("../../../src/workers/phases/types");

    const result = await attemptVramProbe("http://127.0.0.1:11434", 1_000);

    expect(result.observedSuccessfully).toBe(false);
    expect(typeof result.probeError).toBe("string");
  });

  it("missing models[] array → observedSuccessfully=true, attemptResidual=0", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const { attemptVramProbe } = await import("../../../src/workers/phases/types");

    const result = await attemptVramProbe("http://127.0.0.1:11434", 1_000);

    expect(result.observedSuccessfully).toBe(true);
    expect(result.attemptResidual).toBe(0);
  });
});

// ============================================================================
// Sub-helper #3: pollWithBudget()
// Retry loop orchestrator — uses mockFetch sequence + budget edge cases.
// ============================================================================

describe("pollWithBudget — IO Impl Decision V1 §5 sub-helper #3", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("first attempt observes residual=0 → early-return, attemptsUsed=1", async () => {
    mockFetch.mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 0 }]));
    const { pollWithBudget } = await import("../../../src/workers/phases/types");

    const result = await pollWithBudget("http://127.0.0.1:11434", 2_000, 3, 50);

    expect(result.maxResidualBytes).toBe(0);
    expect(result.observedSuccessfully).toBe(true);
    expect(result.attemptsUsed).toBe(1);
  });

  it("3 attempts with non-zero residual → max preserved, attemptsUsed=3", async () => {
    mockFetch
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 1_000 }]))
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 5_000 }]))
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 2_000 }]));
    const { pollWithBudget } = await import("../../../src/workers/phases/types");

    const result = await pollWithBudget("http://127.0.0.1:11434", 2_000, 3, 50);

    expect(result.maxResidualBytes).toBe(5_000);
    expect(result.observedSuccessfully).toBe(true);
    expect(result.attemptsUsed).toBe(3);
  });

  it("all attempts 5xx → observedSuccessfully=false, lastProbeError preserved", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const { pollWithBudget } = await import("../../../src/workers/phases/types");

    const result = await pollWithBudget("http://127.0.0.1:11434", 2_000, 3, 50);

    expect(result.observedSuccessfully).toBe(false);
    expect(result.probeError).toMatch(/HTTP 503/);
    expect(result.attemptsUsed).toBe(3);
    expect(result.maxResidualBytes).toBe(0);
  });

  it("mix of success + failure → observedSuccessfully=true if any attempt succeeds", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 3_000 }]))
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 7_000 }]));
    const { pollWithBudget } = await import("../../../src/workers/phases/types");

    const result = await pollWithBudget("http://127.0.0.1:11434", 2_000, 3, 50);

    expect(result.observedSuccessfully).toBe(true);
    expect(result.maxResidualBytes).toBe(7_000);
    expect(result.attemptsUsed).toBe(3);
  });

  it("deadlineMs near 0 → probe timeout still clamped to ≥500ms (no immediate failure)", async () => {
    mockFetch.mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 0 }]));
    const { pollWithBudget } = await import("../../../src/workers/phases/types");

    const result = await pollWithBudget("http://127.0.0.1:11434", 0, 3, 10);

    expect(result.observedSuccessfully).toBe(true);
    expect(result.maxResidualBytes).toBe(0);
  });

  it("attempts=1 → only one probe, no interval delay", async () => {
    mockFetch.mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 9_000 }]));
    const { pollWithBudget } = await import("../../../src/workers/phases/types");

    const start = Date.now();
    const result = await pollWithBudget("http://127.0.0.1:11434", 2_000, 1, 5_000);
    const elapsed = Date.now() - start;

    expect(result.attemptsUsed).toBe(1);
    expect(result.maxResidualBytes).toBe(9_000);
    // attempts=1 → no setTimeout(intervalMs=5000) called.
    expect(elapsed).toBeLessThan(2_000);
  });
});

// ============================================================================
// Parent: pollVramResidual()
// Existing 6 cases preserved unchanged — semantic equivalence after refactor.
// ============================================================================

describe("pollVramResidual — Plan v3 T3-Vision V1 §1.7 helper unit test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("200 OK with size_vram=0 → early return, observedSuccessfully=true, maxResidualBytes=0", async () => {
    mockFetch.mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 0 }]));
    const { pollVramResidual } = await import("../../../src/workers/phases/types");

    const result = await pollVramResidual(2_000, 3, 100);

    expect(result.maxResidualBytes).toBe(0);
    expect(result.observedSuccessfully).toBe(true);
    expect(result.attemptsUsed).toBe(1); // early return
    expect(result.probeError).toBeUndefined();
  });

  it("200 OK with size_vram>0 across 3 attempts → max preserved, observedSuccessfully=true", async () => {
    mockFetch
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 1_000 }]))
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 5_000 }]))
      .mockResolvedValueOnce(psResponse([{ name: "llama3.2-vision", size_vram: 2_000 }]));
    const { pollVramResidual } = await import("../../../src/workers/phases/types");

    const result = await pollVramResidual(2_000, 3, 50);

    expect(result.maxResidualBytes).toBe(5_000);
    expect(result.observedSuccessfully).toBe(true);
    expect(result.attemptsUsed).toBe(3);
  });

  it("5xx HTTP response across all attempts → probeError populated, observedSuccessfully=false", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const { pollVramResidual } = await import("../../../src/workers/phases/types");

    const result = await pollVramResidual(2_000, 3, 50);

    expect(result.observedSuccessfully).toBe(false);
    expect(result.probeError).toMatch(/HTTP 503/);
    expect(result.attemptsUsed).toBe(3);
    expect(result.maxResidualBytes).toBe(0); // unconfirmed
  });

  it("network error across all attempts → probeError populated, observedSuccessfully=false", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const { pollVramResidual } = await import("../../../src/workers/phases/types");

    const result = await pollVramResidual(2_000, 3, 50);

    expect(result.observedSuccessfully).toBe(false);
    expect(typeof result.probeError).toBe("string");
    // PII contract — sanitizeErrorMessage applied.
    expect(result.probeError).not.toMatch(/\bat\s+/);
  });

  it("model name does not match llama3.2-vision prefix → ignored", async () => {
    mockFetch.mockResolvedValueOnce(psResponse([{ name: "llama3.2-text", size_vram: 9_999 }]));
    const { pollVramResidual } = await import("../../../src/workers/phases/types");

    const result = await pollVramResidual(2_000, 3, 50);

    expect(result.maxResidualBytes).toBe(0);
    expect(result.observedSuccessfully).toBe(true);
  });

  it("Apple Silicon Metal Unified Memory: llama3.2-vision:11b also matched", async () => {
    mockFetch.mockResolvedValueOnce(
      psResponse([{ name: "llama3.2-vision:11b", size_vram: 8_000_000_000 }])
    );
    const { pollVramResidual } = await import("../../../src/workers/phases/types");

    const result = await pollVramResidual(2_000, 3, 50);

    // Prefix match (llama3.2-vision*) per ADR-0011 Amendment 1 §C.
    expect(result.maxResidualBytes).toBe(8_000_000_000);
    expect(result.observedSuccessfully).toBe(true);
  }, 10_000);
});
