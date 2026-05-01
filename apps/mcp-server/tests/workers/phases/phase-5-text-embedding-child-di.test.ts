// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5 Text Embedding Child — DI Completeness Regression Tests
 *
 * v0.4.0 PR7e-β3 regression guard: Ensures the fork child `setupDI()` registers
 * all DI factories required by `runTextEmbeddingSubPhases` and its downstream
 * handlers. Historically, `setMotionPersistence*Factory` was missing from the
 * child fork, causing `getMotionPersistenceService().isAvailable()` to return
 * false and silently skip all motion embedding generation
 * (motion_embeddings = 0 across all pages).
 *
 * v0.4.0 PR7e-β3 回帰防止: fork child の `setupDI()` が
 * `runTextEmbeddingSubPhases` と下流ハンドラーが必要とする DI factory を全て
 * 登録していることを保証する。過去、`setMotionPersistence*Factory` が
 * 欠落していたため `getMotionPersistenceService().isAvailable()` が false を
 * 返し motion embedding 生成が全件 silent skip されていた
 * (全ページで motion_embeddings = 0)。
 *
 * @module tests/workers/phases/phase-5-text-embedding-child-di
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Phase 5 Text Embedding Child — setupDI() completeness", () => {
  const childPath = path.resolve(
    __dirname,
    "../../../src/workers/phases/phase-5-text-embedding-child.ts"
  );
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(childPath, "utf8");
  });

  // ==========================================================================
  // Required imports
  // ==========================================================================

  describe("imports", () => {
    it("imports setMotionPersistenceEmbeddingServiceFactory from motion-persistence.service", () => {
      expect(source).toMatch(/setMotionPersistenceEmbeddingServiceFactory/);
      expect(source).toMatch(/from\s+["'][^"']*motion-persistence\.service["']/);
    });

    it("imports setMotionPersistencePrismaClientFactory from motion-persistence.service", () => {
      expect(source).toMatch(/setMotionPersistencePrismaClientFactory/);
    });

    it("imports setFramePrismaClientFactory from frame-embedding.service", () => {
      expect(source).toMatch(/setFramePrismaClientFactory/);
      expect(source).toMatch(/from\s+["'][^"']*motion\/frame-embedding\.service["']/);
    });

    it("imports Background and MotionLayout setters from embedding-handler", () => {
      expect(source).toMatch(/setBackgroundEmbeddingServiceFactory/);
      expect(source).toMatch(/setBackgroundPrismaClientFactory/);
      expect(source).toMatch(/setMotionLayoutEmbeddingServiceFactory/);
    });

    it("imports Layout setters from layout-embedding.service", () => {
      expect(source).toMatch(/setLayoutPrismaClientFactory/);
      expect(source).toMatch(/setEmbeddingServiceFactory/);
    });
  });

  // ==========================================================================
  // setupDI() body: all factories registered
  // ==========================================================================

  describe("setupDI() body", () => {
    let setupDIBody: string;

    beforeAll(() => {
      const fnStart = source.indexOf("function setupDI");
      expect(fnStart).toBeGreaterThan(-1);
      // Extract function body (assumes setupDI is followed by the next `//` section header)
      const bodyStart = source.indexOf("{", fnStart);
      // Find matching brace by simple counting (setupDI is single-level)
      let depth = 0;
      let bodyEnd = bodyStart;
      for (let i = bodyStart; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
          depth--;
          if (depth === 0) {
            bodyEnd = i + 1;
            break;
          }
        }
      }
      setupDIBody = source.slice(bodyStart, bodyEnd);
    });

    it("calls setEmbeddingServiceFactory", () => {
      expect(setupDIBody).toMatch(/setEmbeddingServiceFactory\(/);
    });

    it("calls setLayoutPrismaClientFactory", () => {
      expect(setupDIBody).toMatch(/setLayoutPrismaClientFactory\(/);
    });

    it("calls setBackgroundEmbeddingServiceFactory", () => {
      expect(setupDIBody).toMatch(/setBackgroundEmbeddingServiceFactory\(/);
    });

    it("calls setBackgroundPrismaClientFactory", () => {
      expect(setupDIBody).toMatch(/setBackgroundPrismaClientFactory\(/);
    });

    it("calls setMotionLayoutEmbeddingServiceFactory", () => {
      expect(setupDIBody).toMatch(/setMotionLayoutEmbeddingServiceFactory\(/);
    });

    it("calls setFramePrismaClientFactory", () => {
      expect(setupDIBody).toMatch(/setFramePrismaClientFactory\(/);
    });

    // ========================================================================
    // v0.4.0 PR7e-β3 regression guards: motion persistence factories MUST be
    // present to prevent silent-skip of motion_embeddings.
    // ========================================================================

    it("PR7e-β3: calls setMotionPersistenceEmbeddingServiceFactory", () => {
      expect(setupDIBody).toMatch(/setMotionPersistenceEmbeddingServiceFactory\(/);
    });

    it("PR7e-β3: calls setMotionPersistencePrismaClientFactory", () => {
      expect(setupDIBody).toMatch(/setMotionPersistencePrismaClientFactory\(/);
    });
  });
});

describe("embedding-backfill-worker — motion backfill DI", () => {
  const workerPath = path.resolve(__dirname, "../../../src/workers/embedding-backfill-worker.ts");
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(workerPath, "utf8");
  });

  it("PR7e-β3: imports setFramePrismaClientFactory", () => {
    expect(source).toMatch(/setFramePrismaClientFactory/);
    expect(source).toMatch(/from\s+["'][^"']*motion\/frame-embedding\.service["']/);
  });

  it("PR7e-β3: calls setFramePrismaClientFactory at module scope", () => {
    // Must appear at top-level (not inside a function) — find before first `export function`
    const firstFnIdx = source.indexOf("export function");
    const moduleScope = firstFnIdx > 0 ? source.slice(0, firstFnIdx) : source;
    expect(moduleScope).toMatch(/setFramePrismaClientFactory\(/);
  });
});

describe("embedding-handler — silent-skip defense", () => {
  const handlerPath = path.resolve(
    __dirname,
    "../../../src/tools/page/handlers/embedding-handler.ts"
  );
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(handlerPath, "utf8");
  });

  it("PR7e-β3: generateMotionEmbeddings escalates DI unavailability to logger.error", () => {
    const fnStart = source.indexOf("export async function generateMotionEmbeddings");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSlice = source.slice(fnStart, fnStart + 5000);
    // Must use logger.error (not logger.warn) for DI unavailability to surface in production logs
    expect(fnSlice).toMatch(/logger\.error\([^)]*MotionPersistenceService DI not initialized/);
  });

  it("PR7e-β3: generateMotionEmbeddings records structured error in result.errors", () => {
    const fnStart = source.indexOf("export async function generateMotionEmbeddings");
    const fnSlice = source.slice(fnStart, fnStart + 5000);
    // Must push a discriminated error entry to result.errors for observability
    expect(fnSlice).toMatch(/result\.errors\.push\([\s\S]*__di_unavailable__/);
  });
});
