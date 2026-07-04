// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * resolveQueryEmbedding SSOT テスト (plan v4 §4.1 / §5.2 T6/T7、PR-2a)
 *
 * service層 SSOT `resolveQueryEmbedding(factory, generate)` の検証:
 * - T6: factory=null → { status: "unavailable" }
 * - T7: catch → { status: "failed", reason } (reason に query 本文・.so を含まない、CWE-209 + PII)
 * - ok: 生成成功 → { status: "ok", embedding }
 * - toDegradedReason: status → DegradedReason enum mapping
 *
 * @module tests/services/_shared/resolve-query-embedding
 */

import { describe, it, expect, vi } from "vitest";
import {
  resolveQueryEmbedding,
  toDegradedReason,
  type QueryEmbeddingResult,
  type DegradedReason,
} from "../../../src/services/_shared/resolve-query-embedding";

describe("resolveQueryEmbedding SSOT (plan v4 §4.1)", () => {
  it("T6: factory=null → { status: 'unavailable' }", async () => {
    const result = await resolveQueryEmbedding(null, async () => {
      throw new Error("should not be called");
    });
    expect(result.status).toBe("unavailable");
  });

  it("ok: 生成成功 → { status: 'ok', embedding }", async () => {
    const embedding = [0.1, 0.2, 0.3];
    const factory = () => ({
      generateEmbedding: vi.fn().mockResolvedValue(embedding),
    });
    const result = await resolveQueryEmbedding(factory, (svc) =>
      svc.generateEmbedding("hello", "query")
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.embedding).toEqual(embedding);
    }
  });

  it("T7: generate throw → { status: 'failed', reason } で reason に query 本文を含まない (PII, GDPR Art.5(1)(c))", async () => {
    const secretQuery = "super-secret-user-query-12345";
    const factory = () => ({
      generateEmbedding: vi.fn().mockRejectedValue(new Error(`failed to embed ${secretQuery}`)),
    });
    const result = await resolveQueryEmbedding(factory, (svc) =>
      svc.generateEmbedding(secretQuery, "query")
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      // reason は sanitizeErrorMessage 経由 → query 本文を含まない
      expect(result.reason).not.toContain(secretQuery);
      expect(typeof result.reason).toBe("string");
    }
  });

  it("T7: generate throw (real dlopen error fixture) → reason に .so / libonnxruntime を含まない (CWE-209)", async () => {
    // real ONNX dlopen error message fixture (vacuous 排除、SEC-RE-L-5)
    const dlopenError = new Error(
      "libonnxruntime_providers_cuda.so: cannot open shared object file: No such file or directory"
    );
    const factory = () => ({
      generateEmbedding: vi.fn().mockRejectedValue(dlopenError),
    });
    const result = await resolveQueryEmbedding(factory, (svc) =>
      svc.generateEmbedding("query", "query")
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).not.toContain(".so");
      expect(result.reason).not.toContain("libonnxruntime");
      expect(result.reason).not.toContain("shared object");
    }
  });

  it("toDegradedReason: status → DegradedReason enum mapping", () => {
    const unavailable: DegradedReason = toDegradedReason("unavailable");
    const failed: DegradedReason = toDegradedReason("failed");
    expect(unavailable).toBe("embedding_unavailable");
    expect(failed).toBe("embedding_failed");
  });

  it("型: QueryEmbeddingResult discriminated union が 3 状態を表現", async () => {
    // 型レベル契約: ok/unavailable/failed の 3 状態
    const ok: QueryEmbeddingResult = { status: "ok", embedding: [1] };
    const unavailable: QueryEmbeddingResult = { status: "unavailable" };
    const failed: QueryEmbeddingResult = { status: "failed", reason: "x" };
    expect(ok.status).toBe("ok");
    expect(unavailable.status).toBe("unavailable");
    expect(failed.status).toBe("failed");
  });
});
