// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * embedding-backfill.service — CWE-209 sanitize + PII truncation tests (PR-D-5).
 *
 * Verifies that all 9 `errors.push(...)` sites in `embedding-backfill.service.ts`
 * surface sanitized error messages and 8-char truncated row.id prefixes
 * (FIND-SEC-01 + SEC-S-01). AST-level regression guard to catch future
 * re-introduction of raw `error.message`.
 *
 * @module tests/services/embedding-backfill-sanitize
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SERVICE_PATH = path.resolve(__dirname, "../../src/services/embedding-backfill.service.ts");

function readSource(): string {
  return fs.readFileSync(SERVICE_PATH, "utf8");
}

describe("embedding-backfill.service — SEC-S-01 + FIND-SEC-01 sanitize (9 loc)", () => {
  const source = readSource();

  it("imports sanitizeErrorMessage from utils/sanitize-error", () => {
    expect(source).toMatch(
      /import\s*\{\s*sanitizeErrorMessage\s*\}\s*from\s*['"]\.\.\/utils\/sanitize-error['"]/
    );
  });

  it("no raw `error instanceof Error ? error.message` remains in errors.push", () => {
    // Full sweep — the project rule is: all 9 sites must be sanitized.
    expect(source).not.toMatch(/error instanceof Error \? error\.message : String\(error\)/);
  });

  it("section[...] loc uses row.id.slice(0, 8) + sanitizeErrorMessage", () => {
    expect(source).toMatch(
      /section\[\$\{row\.id\.slice\(0, 8\) \+ "\.\.\."\}\]: \$\{sanitizeErrorMessage\(error\)\}/
    );
  });

  it("motion[...] loc uses row.id truncation + sanitize", () => {
    expect(source).toMatch(
      /motion\[\$\{row\.id\.slice\(0, 8\) \+ "\.\.\."\}\]: \$\{sanitizeErrorMessage\(error\)\}/
    );
  });

  it("background[...] loc uses row.id truncation + sanitize", () => {
    expect(source).toMatch(
      /background\[\$\{row\.id\.slice\(0, 8\) \+ "\.\.\."\}\]: \$\{sanitizeErrorMessage\(error\)\}/
    );
  });

  it("jsAnimation[...] loc uses row.id truncation + sanitize", () => {
    expect(source).toMatch(
      /jsAnimation\[\$\{row\.id\.slice\(0, 8\) \+ "\.\.\."\}\]: \$\{sanitizeErrorMessage\(error\)\}/
    );
  });

  it("jsAnimation-batch loc uses sanitize (no row.id in batch context)", () => {
    expect(source).toMatch(/jsAnimation-batch: \$\{sanitizeErrorMessage\(error\)\}/);
  });

  it("responsive-<row> loc uses row.id truncation + sanitize", () => {
    expect(source).toMatch(
      /responsive-\$\{row\.id\.slice\(0, 8\) \+ "\.\.\."\}: \$\{sanitizeErrorMessage\(error\)\}/
    );
  });

  it("responsive-batch loc uses sanitize (no row.id)", () => {
    expect(source).toMatch(/responsive-batch: \$\{sanitizeErrorMessage\(error\)\}/);
  });

  it("part[...] loc uses row.id truncation + sanitize", () => {
    expect(source).toMatch(
      /part\[\$\{row\.id\.slice\(0, 8\) \+ "\.\.\."\}\]: \$\{sanitizeErrorMessage\(error\)\}/
    );
  });

  it("part-batch loc uses sanitize (no row.id)", () => {
    expect(source).toMatch(/part-batch: \$\{sanitizeErrorMessage\(error\)\}/);
  });
});
