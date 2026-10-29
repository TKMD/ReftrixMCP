// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod error contract; not one of the 4 standing domains)
 *
 * INV-ZOD-ERRORS-READ-ZERO-001: no `.errors` read on a ZodError in apps/mcp-server/src, in any of
 * the forms the scanner knows (property, string-key element access, destructuring, assignment
 * pattern). zod 4 dropped `ZodError#errors`; `.issues` works on zod 3 and 4 (TPA-B2A-05, leg part).
 * The scan uses the package tsconfig; it fails when it saw no source file, when a module did not
 * resolve (TS2307), or when it never resolved a ZodError receiver (a scan that sees nothing).
 * Kept after zod 4 (PR-F1, TPA ruling 2026-10-29): tsc only stops `.errors` on zod 4 by a type
 * accident; this INV asserts the convention, and also catches `@ts-ignore` / `@ts-expect-error`
 * reads and a future re-added getter that would silence tsc.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import { scanZodErrorsReadsDetailed } from "./support/zod-errors-read-scan";

const PKG_ROOT = path.resolve(__dirname, "../..");
const FIXTURES = "tests/utils/support/fixtures/errors-read";

/** 1-based lines of `file` that carry the marker comment. */
function markedLines(file: string, marker: string): number[] {
  return fs
    .readFileSync(path.join(PKG_ROOT, file), "utf8")
    .split("\n")
    .flatMap((text, i) => (text.includes(marker) ? [i + 1] : []));
}

describe("INV-ZOD-ERRORS-READ-ZERO-001 no ZodError .errors reads", () => {
  it("apps/mcp-server/src has 0 reads of `.errors` on a ZodError, and the scan is not vacuous", () => {
    const result = scanZodErrorsReadsDetailed(PKG_ROOT, "src");
    expect(result.sites).toEqual([]);
    expect(result.sourceFileCount).toBeGreaterThan(0);
    expect(result.unresolvedModules).toEqual([]);
    expect(result.zodIssuesReads).toBeGreaterThan(0);
    // 60s: the full-suite run of this file measured 9.3-11.1s, so 30s left only about 3x headroom
  }, 60_000);

  it("the scanner turns red on the violation fixtures and ignores non-ZodError `errors`", () => {
    const { sites, unresolvedModules } = scanZodErrorsReadsDetailed(PKG_ROOT, FIXTURES);
    expect(unresolvedModules).toEqual([]);
    const byFile = (file: string): number[] =>
      sites.filter((s) => s.file === `${FIXTURES}/${file}`).map((s) => s.line);
    expect(byFile("violation.ts")).toEqual([11]);
    expect(byFile("violation-forms.ts")).toEqual(
      markedLines(`${FIXTURES}/violation-forms.ts`, "// VIOLATION")
    );
    expect(byFile("violation-forms.ts")).toHaveLength(12);
    expect(byFile("negatives.ts")).toEqual([]);
  }, 60_000);

  it("each non-vacuity leg can turn red: no file, an unresolved module, no ZodError receiver", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zod-errors-read-"));
    try {
      const rel = path.relative(PKG_ROOT, dir);
      expect(scanZodErrorsReadsDetailed(PKG_ROOT, rel).sourceFileCount).toBe(0);
      fs.writeFileSync(
        path.join(dir, "shim.ts"),
        'import { gone } from "./missing";\nexport const issues = { errors: [gone] }.errors;\n'
      );
      const result = scanZodErrorsReadsDetailed(PKG_ROOT, rel);
      expect(result.sourceFileCount).toBe(1);
      expect(result.unresolvedModules).toHaveLength(1);
      expect(result.zodIssuesReads).toBe(0);
      expect(result.sites).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
