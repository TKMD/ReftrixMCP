// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * repair-false-failed-backfill.ts — outer-catch sanitize regression test (PR-D-5).
 *
 * Verifies FIND-IMPL-IO-15 landing: the `main().catch(...)` outer-catch now
 * routes the error through `sanitizeErrorMessage(error)` instead of surfacing
 * the raw `error instanceof Error ? error.message` ternary.
 *
 * @module tests/scripts/repair-false-failed-backfill-sanitize
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SCRIPT_PATH = path.resolve(__dirname, "../../src/scripts/repair-false-failed-backfill.ts");

describe("repair-false-failed-backfill.ts — outer-catch sanitize (FIND-IMPL-IO-15)", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");

  it("imports sanitizeErrorMessage", () => {
    expect(source).toMatch(
      /import\s*\{\s*sanitizeErrorMessage\s*\}\s*from\s*['"]\.\.\/utils\/sanitize-error['"]/
    );
  });

  it("outer main().catch uses sanitizeErrorMessage, no raw error.message ternary", () => {
    expect(source).toMatch(
      /main\(\)\.catch\(\(error\) => \{[^}]*sanitizeErrorMessage\(error\)[^}]*\}\)/s
    );
    // Negative: no raw ternary in the outer catch region.
    const outerCatchRegion = source.match(
      /if \(isRunDirectly\(\)\) \{[\s\S]+?process\.exit\(1\);[\s\S]+?\}\)/
    );
    expect(outerCatchRegion).toBeTruthy();
    expect(outerCatchRegion![0]).not.toMatch(
      /error instanceof Error \? error\.message : String\(error\)/
    );
  });
});
