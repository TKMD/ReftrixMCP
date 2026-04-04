// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @reftrixmcp/ml パッケージの非ML exports が onnxruntime-node 不在でも
 * インポート可能であることを検証する。
 *
 * onnxruntime-node を optionalDependencies に移行した結果、
 * パッケージの import 自体がクラッシュしないことを保証する。
 *
 * @module tests/no-onnx-exports
 */

import { describe, it, expect } from "vitest";

describe("@reftrixmcp/ml non-ML exports (no onnxruntime-node dependency)", () => {
  it("should export cosineSimilarity without requiring onnxruntime-node", async () => {
    const { cosineSimilarity } = await import("../src/index.js");
    expect(typeof cosineSimilarity).toBe("function");
  });

  it("should export RRF search utilities without requiring onnxruntime-node", async () => {
    const { calculateRRF, mergeWithRRF, normalizeRRFScore, toRankedItems } =
      await import("../src/index.js");
    expect(typeof calculateRRF).toBe("function");
    expect(typeof mergeWithRRF).toBe("function");
    expect(typeof normalizeRRFScore).toBe("function");
    expect(typeof toRankedItems).toBe("function");
  });

  it("should export hybrid search utilities without requiring onnxruntime-node", async () => {
    const { executeHybridSearch, buildFulltextConditions, buildFulltextRankExpression } =
      await import("../src/index.js");
    expect(typeof executeHybridSearch).toBe("function");
    expect(typeof buildFulltextConditions).toBe("function");
    expect(typeof buildFulltextRankExpression).toBe("function");
  });

  it("should export onnx-availability checker without requiring onnxruntime-node", async () => {
    const { isOnnxRuntimeAvailable, OnnxRuntimeUnavailableError, safeImportOnnx } =
      await import("../src/index.js");
    expect(typeof isOnnxRuntimeAvailable).toBe("function");
    expect(typeof safeImportOnnx).toBe("function");
    expect(OnnxRuntimeUnavailableError).toBeDefined();
  });
});
