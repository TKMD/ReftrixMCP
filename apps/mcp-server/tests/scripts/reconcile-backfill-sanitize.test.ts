// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * reconcile-backfill.ts — outer-catch sanitize regression test (PR-D-5).
 *
 * Verifies FIND-TPA-PLAN-02 co-land: the `main().catch(...)` outer-catch in
 * `reconcile-backfill.ts:212` now routes the error through
 * `sanitizeErrorMessage(error)`, eliminating the CWE-209 latent risk from
 * raw `error instanceof Error ? error.message` ternary.
 *
 * @module tests/scripts/reconcile-backfill-sanitize
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SCRIPT_PATH = path.resolve(__dirname, "../../src/scripts/reconcile-backfill.ts");

describe("reconcile-backfill.ts — outer-catch sanitize (FIND-TPA-PLAN-02)", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");

  it("imports sanitizeErrorMessage (existing import preserved)", () => {
    expect(source).toMatch(
      /import\s*\{\s*sanitizeErrorMessage\s*\}\s*from\s*['"]\.\.\/utils\/sanitize-error['"]/
    );
  });

  it("outer main().catch uses sanitizeErrorMessage, no raw error.message ternary", () => {
    // Regression: the outer catch block must not contain the old ternary.
    const outerCatchRegion = source.match(
      /if \(isRunDirectly\(\)\) \{[\s\S]+?process\.exit\(1\);[\s\S]+?\}\)/
    );
    expect(outerCatchRegion).toBeTruthy();
    expect(outerCatchRegion![0]).toMatch(/sanitizeErrorMessage\(error\)/);
    expect(outerCatchRegion![0]).not.toMatch(
      /error instanceof Error \? error\.message : String\(error\)/
    );
  });
});
