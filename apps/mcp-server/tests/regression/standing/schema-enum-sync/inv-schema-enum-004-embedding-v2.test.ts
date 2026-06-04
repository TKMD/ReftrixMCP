// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004 v2 (alias / redirect)
 *
 * The PR-V3-T1a Phase 2 Step 5 update consolidated this file into
 * `inv-schema-enum-004-embedding-skip-reason.test.ts` (the path cited by the
 * T1a design / registry / audits per the SSOT extension at
 * `EMBEDDING_SKIP_REASONS` 16 → 18 values).
 *
 * This v2 stub file is preserved so historical citations
 * (` `pr-d-2-savepartembeddings-bbox-plan.md`)
 * continue to resolve. Vitest's include glob (`*.test.ts`) discovers this
 * file but the canonical assertion suite lives in the skip-reason file; we
 * use a no-op describe block here that cross-links to the canonical location
 * to avoid running duplicate test cases.
 *
 * Alias / redirect file. Canonical assertions live in
 * `inv-schema-enum-004-embedding-skip-reason.test.ts`. This stub preserves
 * the historical filename for stale-path consistency.
 *
 * @see ./inv-schema-enum-004-embedding-skip-reason.test.ts (canonical)
 *
 * @module tests/regression/standing/schema-enum-sync/inv-schema-enum-004-embedding-v2
 */

import { describe, it, expect } from "vitest";

describe("INV-SCHEMA-ENUM-004 v2 alias (canonical: inv-schema-enum-004-embedding-skip-reason.test.ts)", () => {
  it("INV-SCHEMA-ENUM-004: v2 alias file exists for historical citation consistency", () => {
    // This is a deliberate marker assertion; the canonical 5-case suite lives
    // in the skip-reason file. Refer to that file for the full SSOT extension
    // contract (16 → 18 values).
    expect(true).toBe(true);
  });
});
