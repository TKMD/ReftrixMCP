// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * embedding-failure-response SSOT テスト (plan v4 §4.2 / §4.3 / §5.2 T12、PR-2a)
 *
 * tool層 SSOT `embedding-failure-response.ts` の検証:
 * - buildEmbeddingFailureError(reason): degradedReason / code / message を返す
 * - degradedReason は DegradedReason enum union のみ (UB-V1-5)
 * - message は query 本文・.so を含まない (CWE-209 + PII)
 * - 必須性マトリクス: part text-mode は embedding optional / visual・hybrid は required
 *
 * @module tests/tools/_shared/embedding-failure-response
 */

import { describe, it, expect } from "vitest";
import {
  buildEmbeddingFailureError,
  isPartEmbeddingRequired,
  EMBEDDING_FAILURE_CODE,
  type EmbeddingFailureError,
} from "../../../src/tools/_shared/embedding-failure-response";
import type { DegradedReason } from "../../../src/services/_shared/resolve-query-embedding";

describe("embedding-failure-response SSOT (plan v4 §4.2/§4.3)", () => {
  it("buildEmbeddingFailureError(unavailable): degradedReason=embedding_unavailable + SERVICE_UNAVAILABLE code", () => {
    const err: EmbeddingFailureError = buildEmbeddingFailureError("unavailable");
    expect(err.degradedReason).toBe("embedding_unavailable");
    expect(err.code).toBe(EMBEDDING_FAILURE_CODE.SERVICE_UNAVAILABLE);
  });

  it("buildEmbeddingFailureError(failed): degradedReason=embedding_failed + EMBEDDING_FAILED code", () => {
    const err = buildEmbeddingFailureError("failed");
    expect(err.degradedReason).toBe("embedding_failed");
    expect(err.code).toBe(EMBEDDING_FAILURE_CODE.EMBEDDING_FAILED);
  });

  it("T12: degradedReason が DegradedReason enum union 以外を取らない", () => {
    const valid: DegradedReason[] = ["embedding_unavailable", "embedding_failed"];
    for (const r of [
      buildEmbeddingFailureError("unavailable"),
      buildEmbeddingFailureError("failed"),
    ]) {
      expect(valid).toContain(r.degradedReason);
    }
  });

  it("CWE-209 + PII: message に query 本文・.so / libonnxruntime を含まない", () => {
    // reason は呼び出し側で sanitizeErrorMessage 済の文字列 (failed の場合)。
    // buildEmbeddingFailureError は generic 安全メッセージのみ生成する。
    const errUnavailable = buildEmbeddingFailureError("unavailable");
    const errFailed = buildEmbeddingFailureError("failed");
    for (const e of [errUnavailable, errFailed]) {
      expect(e.message).not.toContain(".so");
      expect(e.message).not.toContain("libonnxruntime");
    }
  });

  it("必須性マトリクス: part text-mode は embedding optional (false)", () => {
    expect(isPartEmbeddingRequired("text")).toBe(false);
  });

  it("必須性マトリクス: part visual / hybrid は embedding required (true)", () => {
    expect(isPartEmbeddingRequired("visual")).toBe(true);
    expect(isPartEmbeddingRequired("hybrid")).toBe(true);
  });
});
