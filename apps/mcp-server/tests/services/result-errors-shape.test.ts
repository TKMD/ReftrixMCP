// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PR-D-7 Wave 3 — `result.errors[]` 5-shape whitelist CI-failing regression test
 *
 * Plan v1.2 §3.5.2 Step 6 に基づき、`FIND-PLAN-TPA-01` (H severity) の
 * H severity は **CI で落ちる実行可能テスト** が必須、accepted-risk 禁止。
 *
 * PR-D-7 Wave 3 — `result.errors[]` 5-shape whitelist CI-failing regression test.
 *
 * Per Plan v1.2 §3.5.2 Step 6, this test landing is the contract binding for
 * H findings to land as **a CI-failing executable test**; accepted-risk is
 * prohibited.
 *
 * 5-shape whitelist (T1 production reality):
 *   (a) `string[]`                                — service-registrar-search,
 *                                                   part-backfill, part-embedding-db
 *   (b) `{ name: string; error: string }[]`      — background-design-embedding
 *   (c) `{ id: string; error: string }[]`        — responsive-analysis-embedding
 *   (d) `{ sectionId: string; error: string }[]` — embedding-handler section
 *   (e) `{ patternId: string; error: string }[]` — embedding-handler motion
 *
 * Contract:
 *   - Shape enforcement (type + runtime)
 *   - Sanitize pass-through for string[] shape (CWE-209 defense)
 *   - Indiscriminate string concat prohibition (grep-based AST regex)
 *   - `extractPrismaCode` helper coverage (strict `/^P\d{4}$/`)
 *
 * @module tests/services/result-errors-shape
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { extractPrismaCode, sanitizeErrorMessage } from "../../src/utils/sanitize-error";

import type {
  SectionEmbeddingResult,
  MotionEmbeddingResult,
} from "../../src/tools/page/handlers/embedding-handler";
import type { BackgroundDesignEmbeddingResult } from "../../src/services/background/background-design-embedding.service";
import type { ResponsiveAnalysisEmbeddingResult } from "../../src/services/responsive/responsive-analysis-embedding.service";
import type { SearchRegistrarResult } from "../../src/services/service-registrar-search";
import type { BackfillResult as PartBackfillResult } from "../../src/services/part/part-backfill.service";
import type { PartEmbeddingSaveResult } from "../../src/services/part/part-embedding-db.service";

// =====================================================
// Source file paths for AST regex checks
// =====================================================

const SRC_ROOT = path.resolve(__dirname, "../../src");

const SHAPE_A_SOURCE_FILES = [
  path.join(SRC_ROOT, "services/service-registrar-search.ts"),
  path.join(SRC_ROOT, "services/part/part-backfill.service.ts"),
  path.join(SRC_ROOT, "services/part/part-embedding-db.service.ts"),
] as const;

// PR-D-7 Wave 7.1 (UB-TPA-IMPL-03): shape (b) / shape (c) sanitize pass-through
// whitelist. Bound to UB-TPA-IMPL-01 / UB-TPA-IMPL-02 (M severity) — additive
// only, no type rename (Plan v1.2 §5.8 non-breaking scope).
// PR-D-7 Wave 7.1 (UB-TPA-IMPL-03): shape (b) / shape (c) sanitize pass-through
// ホワイトリスト。UB-TPA-IMPL-01 / UB-TPA-IMPL-02 (M severity) の binding、
// additive-only、型 rename 禁止 (Plan v1.2 §5.8 non-breaking scope)。
const SHAPE_B_SOURCE_FILES = [
  path.join(SRC_ROOT, "services/background/background-design-embedding.service.ts"),
] as const;

const SHAPE_C_SOURCE_FILES = [
  path.join(SRC_ROOT, "services/responsive/responsive-analysis-embedding.service.ts"),
] as const;

// Regex: any `result.errors.push(`...${error.message}...`)` or
// `result.errors.push(`...${something.error.message}...`)` style call.
// We accept sanitized variables (`safeMessage`) and reject raw `error.message`.
const RAW_ERROR_MESSAGE_IN_PUSH_REGEX =
  /result\.errors\.push\s*\([^)]*\$\{\s*[A-Za-z_][A-Za-z0-9_]*\.message\s*\}/;

// PR-D-7 Wave 7.1: Object-form push regex. Detects `result.errors.push({ ...,
// error: <raw_error_ref>.message })` style — i.e., a raw `.message` lookup
// used as the `error` field value in an object literal pushed onto errors[].
// We reject raw `.message` (e.g., `error.message`, `err.message`) and accept
// sanitized variables (e.g., `safeMessage`, a pre-computed sanitize result).
// PR-D-7 Wave 7.1: オブジェクト形式 push の regex。`error.message` / `err.message` 等の
// raw `.message` を object literal の `error` field 値として push している箇所を検出。
// sanitize 済みの変数 (`safeMessage` 等) は許容。
const RAW_ERROR_MESSAGE_OBJECT_PUSH_REGEX =
  /result\.errors\.push\s*\(\s*\{[^}]*error\s*:\s*[A-Za-z_][A-Za-z0-9_]*\.message[^}]*\}\s*\)/;

// PR-D-7 Wave 7.1: Legacy `errorMessage` variable anti-pattern. Detects the
// pre-fix form `const errorMessage = error instanceof Error ? error.message :`
// (or similar) that bridges raw `.message` → object push via a variable named
// `errorMessage`. If this pattern exists AND is used as `error: errorMessage`
// inside a push, it leaks raw `.message` through indirection. The fix form
// uses `safeMessage = sanitizeErrorMessage(error)` and keeps `rawMessage` only
// for server-side logger calls.
// PR-D-7 Wave 7.1: Legacy `errorMessage` 変数アンチパターン。修正前の
// `const errorMessage = error instanceof Error ? error.message :` 形式 (raw
// `.message` を `errorMessage` 変数経由で object push に流す形) を検出。
// 修正形は `safeMessage = sanitizeErrorMessage(error)` を使い、raw `.message` は
// server-side logger の `rawMessage` に限定する。
const LEGACY_ERROR_MESSAGE_VAR_REGEX = /const\s+errorMessage\s*=\s*[^;]*\.message\s*[:;]/;

// =====================================================
// 1. Shape enforcement — type-level + runtime assertions
// =====================================================

describe("PR-D-7 Wave 3 — 5-shape whitelist enforcement (FIND-PLAN-TPA-01 H)", () => {
  describe("Shape (a): string[]", () => {
    it("service-registrar-search SearchRegistrarResult.errors is string[]", () => {
      // INV-PLAN-TPA-01: string[] shape preservation (additive-only, no rename).
      const fixture: SearchRegistrarResult = {
        registeredFactories: [],
        categories: [],
        skipped: [],
        errors: ["Narrative: Database operation failed"],
        skippedCategoriesInfo: [],
        errorsInfo: [],
      };
      expect(Array.isArray(fixture.errors)).toBe(true);
      expect(typeof fixture.errors[0]).toBe("string");
    });

    it("part-backfill PartBackfillResult.errors is string[]", () => {
      const fixture: PartBackfillResult = {
        pagesProcessed: 0,
        sectionsProcessed: 0,
        partsExtracted: 0,
        embeddingsGenerated: 0,
        errors: ["Section abcd1234: Database operation failed"],
        durationMs: 0,
      };
      expect(Array.isArray(fixture.errors)).toBe(true);
      expect(typeof fixture.errors[0]).toBe("string");
    });

    it("part-embedding-db PartEmbeddingSaveResult.errors is string[]", () => {
      const fixture: PartEmbeddingSaveResult = {
        generatedCount: 0,
        filteredNonFinite: 0,
        errors: ["Transaction rolled back (5 embeddings): Database operation failed"],
      };
      expect(Array.isArray(fixture.errors)).toBe(true);
      expect(typeof fixture.errors[0]).toBe("string");
    });
  });

  describe("Shape (b): { name: string; error: string }[]", () => {
    it("background-design-embedding errors are {name, error}[]", () => {
      const fixture: BackgroundDesignEmbeddingResult = {
        success: true,
        generatedCount: 0,
        failedCount: 1,
        errors: [{ name: "hero-bg", error: "Database operation failed" }],
      };
      expect(Array.isArray(fixture.errors)).toBe(true);
      expect(typeof fixture.errors[0]!.name).toBe("string");
      expect(typeof fixture.errors[0]!.error).toBe("string");
    });
  });

  describe("Shape (c): { id: string; error: string }[]", () => {
    it("responsive-analysis-embedding errors are {id, error}[]", () => {
      const fixture: ResponsiveAnalysisEmbeddingResult = {
        success: true,
        generatedCount: 0,
        failedCount: 1,
        errors: [{ id: "resp-1", error: "Database operation failed" }],
      };
      expect(Array.isArray(fixture.errors)).toBe(true);
      expect(typeof fixture.errors[0]!.id).toBe("string");
      expect(typeof fixture.errors[0]!.error).toBe("string");
    });
  });

  describe("Shape (d): { sectionId: string; error: string }[]", () => {
    it("embedding-handler SectionEmbeddingResult errors are {sectionId, error}[]", () => {
      const fixture: SectionEmbeddingResult = {
        success: true,
        generatedCount: 0,
        failedCount: 1,
        errors: [{ sectionId: "sec-1", error: "Database operation failed" }],
      };
      expect(Array.isArray(fixture.errors)).toBe(true);
      expect(typeof fixture.errors[0]!.sectionId).toBe("string");
      expect(typeof fixture.errors[0]!.error).toBe("string");
    });

    it("embedding-handler SectionEmbeddingResult.visionEmbedding errors are {sectionId, error}[]", () => {
      const fixture: SectionEmbeddingResult = {
        success: true,
        generatedCount: 0,
        failedCount: 0,
        errors: [],
        visionEmbedding: {
          generatedCount: 0,
          failedCount: 1,
          errors: [{ sectionId: "sec-1", error: "Database operation failed" }],
        },
      };
      expect(fixture.visionEmbedding).toBeDefined();
      const visionErrors = fixture.visionEmbedding!.errors;
      expect(typeof visionErrors[0]!.sectionId).toBe("string");
      expect(typeof visionErrors[0]!.error).toBe("string");
    });
  });

  describe("Shape (e): { patternId: string; error: string }[]", () => {
    it("embedding-handler MotionEmbeddingResult errors are {patternId, error}[]", () => {
      const fixture: MotionEmbeddingResult = {
        success: true,
        savedCount: 0,
        patternIds: [],
        embeddingIds: [],
        errors: [{ patternId: "mot-1", error: "Database operation failed" }],
      };
      expect(Array.isArray(fixture.errors)).toBe(true);
      expect(typeof fixture.errors[0]!.patternId).toBe("string");
      expect(typeof fixture.errors[0]!.error).toBe("string");
    });
  });
});

// =====================================================
// 2. Indiscriminate string concat prohibition
//    (grep-based AST regex on source files)
// =====================================================

describe("PR-D-7 Wave 3 — indiscriminate string concat prohibition (shape (a) files)", () => {
  it.each(SHAPE_A_SOURCE_FILES)(
    "%s must NOT contain raw `${...error.message}` inside `result.errors.push(...)`",
    (filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      const match = source.match(RAW_ERROR_MESSAGE_IN_PUSH_REGEX);
      // Fail-if-matched: a positive match indicates a client-facing CWE-209 risk.
      // CWE-209: Information Exposure Through an Error Message.
      expect(
        match,
        `[${path.basename(filePath)}] Found raw error.message in result.errors.push(...): "${match?.[0] ?? ""}" — must route through sanitizeErrorMessage()`
      ).toBeNull();
    }
  );
});

// =====================================================
// 3. Sanitize pass-through enforcement (contract)
// =====================================================

describe("PR-D-7 Wave 3 — sanitize pass-through contract for shape (a)", () => {
  // Contract: callers of shape (a) `string[]` errors MUST route every pushed
  // string through `sanitizeErrorMessage` before client-facing exposure. We
  // verify this indirectly by (1) confirming the source contains calls to
  // `sanitizeErrorMessage` near the `result.errors.push` sites, and (2)
  // validating `sanitizeErrorMessage` itself does not leak internal schema.

  it.each(SHAPE_A_SOURCE_FILES)(
    "%s imports `sanitizeErrorMessage` and uses it before `result.errors.push`",
    (filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      // All three shape-(a) files must import sanitizeErrorMessage.
      expect(source, `[${path.basename(filePath)}] must import sanitizeErrorMessage`).toMatch(
        /import[^;]*sanitizeErrorMessage[^;]*from\s+["'][^"']*sanitize-error["']/
      );
      // And must call sanitizeErrorMessage somewhere in the file.
      expect(source, `[${path.basename(filePath)}] must call sanitizeErrorMessage`).toMatch(
        /sanitizeErrorMessage\s*\(/
      );
    }
  );

  it("sanitizeErrorMessage does not leak raw Prisma error messages", () => {
    const rawPrisma = Object.assign(
      new Error("Unique constraint failed on the fields: (`email`)"),
      {
        code: "P2002",
      }
    );
    const safe = sanitizeErrorMessage(rawPrisma);
    // Mapped P2002 message (no SQL identifiers / internal table fields).
    expect(safe).toBe("A record with this value already exists");
    expect(safe).not.toContain("email");
    expect(safe).not.toContain("Unique constraint");
  });

  it("sanitizeErrorMessage falls back to generic internal message for unknown errors", () => {
    const safe = sanitizeErrorMessage(new Error("some obscure internal failure"));
    expect(safe).toBe("An internal error occurred");
  });
});

// =====================================================
// 3.1. PR-D-7 Wave 7.1 — shape (b) {name, error}[] sanitize pass-through
//      (UB-TPA-IMPL-01 / UB-TPA-IMPL-03 binding, M severity)
// =====================================================

describe("PR-D-7 Wave 7.1 — shape (b) {name, error}[] sanitize pass-through (UB-TPA-IMPL-01)", () => {
  // Contract: shape (b) callers MUST route every `error` field value through
  // `sanitizeErrorMessage` before client-facing exposure. Server-side logs may
  // preserve raw `error.message` for debugging — only the pushed object's
  // `error` field is contract-bound.
  // Contract: shape (b) の caller は `error` field 値を必ず sanitizeErrorMessage()
  // 経由で sanitize してから client に返却する。server-side log は debug 目的で
  // raw error.message を保持してよい。契約対象は push object の `error` field のみ。

  it.each(SHAPE_B_SOURCE_FILES)(
    "%s must NOT contain raw `<ref>.message` inside `result.errors.push({ ..., error: <ref>.message })`",
    (filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      const match = source.match(RAW_ERROR_MESSAGE_OBJECT_PUSH_REGEX);
      // Fail-if-matched: raw `.message` in object-form push is CWE-209 risk.
      // CWE-209: Information Exposure Through an Error Message.
      expect(
        match,
        `[${path.basename(filePath)}] Found raw <ref>.message in result.errors.push({ ..., error: ... }): "${match?.[0] ?? ""}" — must route through sanitizeErrorMessage()`
      ).toBeNull();
    }
  );

  it.each(SHAPE_B_SOURCE_FILES)(
    "%s imports `sanitizeErrorMessage` from sanitize-error",
    (filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      expect(source, `[${path.basename(filePath)}] must import sanitizeErrorMessage`).toMatch(
        /import[^;]*sanitizeErrorMessage[^;]*from\s+["'][^"']*sanitize-error["']/
      );
      expect(source, `[${path.basename(filePath)}] must call sanitizeErrorMessage`).toMatch(
        /sanitizeErrorMessage\s*\(/
      );
    }
  );

  it.each(SHAPE_B_SOURCE_FILES)(
    "%s must NOT reintroduce legacy `const errorMessage = ...message` anti-pattern",
    (filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      const match = source.match(LEGACY_ERROR_MESSAGE_VAR_REGEX);
      expect(
        match,
        `[${path.basename(filePath)}] Found legacy errorMessage variable bridging raw .message: "${match?.[0] ?? ""}" — use safeMessage = sanitizeErrorMessage(error) instead.`
      ).toBeNull();
    }
  );
});

// =====================================================
// 3.2. PR-D-7 Wave 7.1 — shape (c) {id, error}[] sanitize pass-through
//      (UB-TPA-IMPL-02 / UB-TPA-IMPL-03 binding, M severity)
// =====================================================

describe("PR-D-7 Wave 7.1 — shape (c) {id, error}[] sanitize pass-through (UB-TPA-IMPL-02)", () => {
  // Contract: shape (c) callers MUST route every `error` field value through
  // `sanitizeErrorMessage` before client-facing exposure. Server-side logs may
  // preserve raw `error.message` for debugging — only the pushed object's
  // `error` field is contract-bound.
  // Contract: shape (c) の caller は `error` field 値を必ず sanitizeErrorMessage()
  // 経由で sanitize してから client に返却する。server-side log は debug 目的で
  // raw error.message を保持してよい。契約対象は push object の `error` field のみ。

  it.each(SHAPE_C_SOURCE_FILES)(
    "%s must NOT contain raw `<ref>.message` inside `result.errors.push({ ..., error: <ref>.message })`",
    (filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      const match = source.match(RAW_ERROR_MESSAGE_OBJECT_PUSH_REGEX);
      // Fail-if-matched: raw `.message` in object-form push is CWE-209 risk.
      // CWE-209: Information Exposure Through an Error Message.
      expect(
        match,
        `[${path.basename(filePath)}] Found raw <ref>.message in result.errors.push({ ..., error: ... }): "${match?.[0] ?? ""}" — must route through sanitizeErrorMessage()`
      ).toBeNull();
    }
  );

  it.each(SHAPE_C_SOURCE_FILES)(
    "%s imports `sanitizeErrorMessage` from sanitize-error",
    (filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      expect(source, `[${path.basename(filePath)}] must import sanitizeErrorMessage`).toMatch(
        /import[^;]*sanitizeErrorMessage[^;]*from\s+["'][^"']*sanitize-error["']/
      );
      expect(source, `[${path.basename(filePath)}] must call sanitizeErrorMessage`).toMatch(
        /sanitizeErrorMessage\s*\(/
      );
    }
  );

  it.each(SHAPE_C_SOURCE_FILES)(
    "%s must NOT reintroduce legacy `const errorMessage = ...message` anti-pattern",
    (filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      const match = source.match(LEGACY_ERROR_MESSAGE_VAR_REGEX);
      expect(
        match,
        `[${path.basename(filePath)}] Found legacy errorMessage variable bridging raw .message: "${match?.[0] ?? ""}" — use safeMessage = sanitizeErrorMessage(error) instead.`
      ).toBeNull();
    }
  );
});

// =====================================================
// 4. extractPrismaCode helper coverage (FIND-PLAN-TPA-01 SSOT binding)
// =====================================================

describe("PR-D-7 Wave 3 — extractPrismaCode helper (strict /^P\\d{4}$/)", () => {
  it("returns the code when error exposes a valid P\\d{4} string", () => {
    const err = Object.assign(new Error("..."), { code: "P2002" });
    expect(extractPrismaCode(err)).toBe("P2002");
  });

  it("returns the code for lesser-known but well-formed Prisma code P1017", () => {
    const err = Object.assign(new Error("..."), { code: "P1017" });
    expect(extractPrismaCode(err)).toBe("P1017");
  });

  it("returns undefined when error has no `code` field", () => {
    expect(extractPrismaCode(new Error("plain"))).toBeUndefined();
  });

  it("returns undefined when error `code` is not a string (number)", () => {
    const err = Object.assign(new Error("..."), { code: 42 as unknown as string });
    expect(extractPrismaCode(err)).toBeUndefined();
  });

  it("returns undefined when error `code` is a non-Prisma string (NOT_PRISMA)", () => {
    const err = Object.assign(new Error("..."), { code: "NOT_PRISMA" });
    expect(extractPrismaCode(err)).toBeUndefined();
  });

  it("returns undefined when error `code` is Prisma-like but not strict P\\d{4} (P200)", () => {
    // Too few digits → must fail strict regex.
    const err = Object.assign(new Error("..."), { code: "P200" });
    expect(extractPrismaCode(err)).toBeUndefined();
  });

  it("returns undefined when error `code` is Prisma-like but too many digits (P20020)", () => {
    const err = Object.assign(new Error("..."), { code: "P20020" });
    expect(extractPrismaCode(err)).toBeUndefined();
  });

  it("returns undefined for null/undefined/non-object inputs", () => {
    expect(extractPrismaCode(null)).toBeUndefined();
    expect(extractPrismaCode(undefined)).toBeUndefined();
    expect(extractPrismaCode("string error")).toBeUndefined();
    expect(extractPrismaCode(42)).toBeUndefined();
    expect(extractPrismaCode(true)).toBeUndefined();
  });

  it("works on plain objects (not only Error instances)", () => {
    // Prisma-like plain object fixtures can appear on deserialised IPC payloads.
    const plain = { code: "P2025", message: "Record not found" };
    expect(extractPrismaCode(plain)).toBe("P2025");
  });
});
