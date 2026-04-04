// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * onnx-availability.ts のテスト
 *
 * onnxruntime-node がオプショナル依存になったことに伴い、
 * 可用性チェック・安全インポート・エラークラスの動作を検証する。
 *
 * @module tests/onnx-availability
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isOnnxRuntimeAvailable,
  isOnnxRuntimeAvailableSync,
  safeImportOnnx,
  OnnxRuntimeUnavailableError,
  getOnnxUnavailableReason,
  _resetForTesting,
} from "../src/onnx-availability.js";

describe("onnx-availability", () => {
  beforeEach((): void => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // isOnnxRuntimeAvailable
  // --------------------------------------------------------------------------

  describe("isOnnxRuntimeAvailable()", () => {
    it("should return true when onnxruntime-node is importable", async () => {
      // In this test environment onnxruntime-node is installed as optionalDep
      const result = await isOnnxRuntimeAvailable();
      expect(result).toBe(true);
    });

    it("should cache the result on subsequent calls", async () => {
      const first = await isOnnxRuntimeAvailable();
      const second = await isOnnxRuntimeAvailable();
      expect(first).toBe(second);
    });
  });

  // --------------------------------------------------------------------------
  // isOnnxRuntimeAvailableSync
  // --------------------------------------------------------------------------

  describe("isOnnxRuntimeAvailableSync()", () => {
    it("should return null before async probe is called", () => {
      expect(isOnnxRuntimeAvailableSync()).toBeNull();
    });

    it("should return boolean after async probe completes", async () => {
      await isOnnxRuntimeAvailable();
      const sync = isOnnxRuntimeAvailableSync();
      expect(typeof sync).toBe("boolean");
    });
  });

  // --------------------------------------------------------------------------
  // safeImportOnnx
  // --------------------------------------------------------------------------

  describe("safeImportOnnx()", () => {
    it("should return the module when onnxruntime-node is available", async () => {
      const mod = await safeImportOnnx();
      expect(mod).toBeDefined();
      // onnxruntime-node exports InferenceSession among others
      expect(mod.InferenceSession).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // OnnxRuntimeUnavailableError
  // --------------------------------------------------------------------------

  describe("OnnxRuntimeUnavailableError", () => {
    it("should have descriptive message with install instructions", () => {
      const error = new OnnxRuntimeUnavailableError();
      expect(error.message).toContain("pnpm add onnxruntime-node");
      expect(error.message).toContain("ML features require onnxruntime-node");
      expect(error.name).toBe("OnnxRuntimeUnavailableError");
    });

    it("should include context when provided", () => {
      const error = new OnnxRuntimeUnavailableError("DINOv2 init");
      expect(error.message).toContain("DINOv2 init");
    });

    it("should be an instance of Error", () => {
      const error = new OnnxRuntimeUnavailableError();
      expect(error).toBeInstanceOf(Error);
    });
  });

  // --------------------------------------------------------------------------
  // getOnnxUnavailableReason
  // --------------------------------------------------------------------------

  describe("getOnnxUnavailableReason()", () => {
    it("should return null when onnxruntime-node is available", async () => {
      await isOnnxRuntimeAvailable();
      expect(getOnnxUnavailableReason()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // _resetForTesting
  // --------------------------------------------------------------------------

  describe("_resetForTesting()", () => {
    it("should clear cached state so next probe re-evaluates", async () => {
      await isOnnxRuntimeAvailable();
      expect(isOnnxRuntimeAvailableSync()).not.toBeNull();

      _resetForTesting();

      expect(isOnnxRuntimeAvailableSync()).toBeNull();
      expect(getOnnxUnavailableReason()).toBeNull();
    });
  });
});

// =============================================================================
// Separate describe block: onnxruntime-node unavailable scenario
//
// vi.doMock must be called before dynamic import in the same test, so we
// isolate these tests and use dynamic import of the source module.
// =============================================================================

describe("onnx-availability (onnxruntime-node unavailable)", () => {
  beforeEach((): void => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("isOnnxRuntimeAvailable() should return false when import throws", async () => {
    vi.doMock("onnxruntime-node", () => {
      throw new Error("Cannot find module 'onnxruntime-node'");
    });

    const mod = await import("../src/onnx-availability.js");
    mod._resetForTesting();

    const result = await mod.isOnnxRuntimeAvailable();
    expect(result).toBe(false);
  });

  it("safeImportOnnx() should throw OnnxRuntimeUnavailableError when module missing", async () => {
    vi.doMock("onnxruntime-node", () => {
      throw new Error("Cannot find module 'onnxruntime-node'");
    });

    const mod = await import("../src/onnx-availability.js");

    await expect(mod.safeImportOnnx()).rejects.toThrow(mod.OnnxRuntimeUnavailableError);
    await expect(mod.safeImportOnnx()).rejects.toThrow("pnpm add onnxruntime-node");
  });

  it("getOnnxUnavailableReason() should return a string when unavailable", async () => {
    vi.doMock("onnxruntime-node", () => {
      throw new Error("Cannot find module 'onnxruntime-node'");
    });

    const mod = await import("../src/onnx-availability.js");
    mod._resetForTesting();

    await mod.isOnnxRuntimeAvailable();
    const reason = mod.getOnnxUnavailableReason();
    expect(reason).toBeTypeOf("string");
    expect(reason).toContain("not installed");
  });
});
