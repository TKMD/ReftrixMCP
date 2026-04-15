// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Embedding Phase Structure Tests
 *
 * Verifies that dispatchEmbeddingPhase is the entry point for Phase 5
 * embedding generation, and that the fork-based pipeline is intact.
 *
 * @module tests/workers/page-analyze-worker-embedding-phase
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("PageAnalyzeWorker - Embedding Phase Structure", () => {
  const typesPath = path.resolve(__dirname, "../../src/workers/phases/types.ts");
  const phase5Path = path.resolve(__dirname, "../../src/workers/phases/phase-5-embedding.ts");
  const orchestratorPath = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");

  let workerSource: string;

  beforeAll(() => {
    workerSource =
      fs.readFileSync(typesPath, "utf8") +
      "\n" +
      fs.readFileSync(phase5Path, "utf8") +
      "\n" +
      fs.readFileSync(orchestratorPath, "utf8");
  });

  // ==========================================================================
  // dispatchEmbeddingPhase entry point
  // ==========================================================================

  describe("dispatchEmbeddingPhase function", () => {
    it("should define dispatchEmbeddingPhase as an exported async function", () => {
      expect(workerSource).toContain("export async function dispatchEmbeddingPhase");
    });

    it("should accept EmbeddingPhaseParams as parameter", () => {
      expect(workerSource).toContain("EmbeddingPhaseParams");
    });

    it("should return EmbeddingPhaseResult", () => {
      expect(workerSource).toContain("EmbeddingPhaseResult");
    });
  });

  // ==========================================================================
  // EmbeddingPhaseParams / EmbeddingPhaseResult type definitions
  // ==========================================================================

  describe("type definitions", () => {
    it("should define EmbeddingPhaseParams interface", () => {
      expect(workerSource).toMatch(/(?:interface|type)\s+EmbeddingPhaseParams/);
    });

    it("should define EmbeddingPhaseResult interface", () => {
      expect(workerSource).toMatch(/(?:interface|type)\s+EmbeddingPhaseResult/);
    });

    it("EmbeddingPhaseParams should include webPageId", () => {
      const paramsSection = workerSource.slice(
        workerSource.indexOf("EmbeddingPhaseParams"),
        workerSource.indexOf("EmbeddingPhaseParams") + 1500
      );
      expect(paramsSection).toContain("webPageId");
    });

    it("EmbeddingPhaseResult should include embedding counts", () => {
      // PR2 (v0.4.0): EmbeddingSkipReason が EmbeddingPhaseResult の前に
      // JSDoc で何度も参照されているため、`interface EmbeddingPhaseResult`
      // キーワードで interface 本体を特定する。
      // PR2 (v0.4.0): EmbeddingSkipReason is referenced in JSDoc above the
      // interface, so locate the interface body explicitly.
      const interfaceStart = workerSource.indexOf("interface EmbeddingPhaseResult");
      expect(interfaceStart).toBeGreaterThan(-1);
      const resultSection = workerSource.slice(interfaceStart, interfaceStart + 1500);
      expect(resultSection).toContain("sectionEmbeddingsGenerated");
      expect(resultSection).toContain("motionEmbeddingsGenerated");
    });
  });

  // ==========================================================================
  // processPageAnalyzeJob calls dispatchEmbeddingPhase
  // ==========================================================================

  describe("integration with processPageAnalyzeJob", () => {
    it("processPageAnalyzeJob should call dispatchEmbeddingPhase", () => {
      const fnStart = workerSource.indexOf("function processPageAnalyzeJob");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart);
      expect(fnBody).toContain("dispatchEmbeddingPhase");
    });
  });

  // ==========================================================================
  // Legacy processEmbeddingPhase removed
  // ==========================================================================

  describe("legacy path removal", () => {
    it("should NOT define processEmbeddingPhase (legacy in-process path removed)", () => {
      expect(workerSource).not.toContain("export async function processEmbeddingPhase");
    });

    it("should NOT reference PHASE5_FORK_ENABLED constant (flag removed)", () => {
      expect(workerSource).not.toMatch(/export const PHASE5_FORK_ENABLED/);
    });
  });

  // ==========================================================================
  // Lock extension within embedding sub-phases
  // ==========================================================================

  describe("lock extension in embedding sub-phases", () => {
    it("sub-phase functions should call extendJobLock with expected labels", () => {
      // Verify each sub-phase function has the expected lock label
      expect(workerSource).toContain('"embedding-sections"');
      expect(workerSource).toContain('"embedding-motions"');
      expect(workerSource).toContain('"embedding-backgrounds"');
      expect(workerSource).toContain('"embedding-js-animations"');
    });
  });
});
