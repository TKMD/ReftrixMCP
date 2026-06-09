// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004 additive (Plan v2 PR-D /
 * ADR-0018 Amendment 13)
 *
 * ADR-0018 Amendment 7 §7.1 / §7.5 req4 (UB-10) + Amendment 13 §8.8 (re-definition):
 * the `visual_skip_reason` marker's WRITABLE value set MUST be in lockstep across
 * the 4 canonical sites:
 *
 *   1. Prisma migration CHECK constraint on `component_part_embeddings.visual_skip_reason`
 *   2. Prisma schema field `ComponentPartEmbedding.visualSkipReason` (TEXT nullable)
 *   3. TS SSOT writable set `EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS`
 *      (= terminal subset `EMBEDDING_PART_VISUAL_SKIP_REASONS` ∪ {screenshot_truncated})
 *   4. The `PartVisualWritableSkipReason` type / marker writer consumer set
 *
 * **Amendment 13 §8.8 re-definition (visual-backfill truncated-screenshot
 * data-loss fix)**: previously the CHECK == terminal subset (the 2-way pending
 * predicate excluded ALL non-NULL). Now `screenshot_truncated` is WRITABLE but
 * NON-terminal (the 3-way pending predicate keeps it pending and retries it), so
 * the CHECK == the full WRITABLE set (terminal subset ∪ {screenshot_truncated}),
 * NOT the terminal subset. The CHECK was additively widened by migration
 * `20260608120000_add_screenshot_truncated_skip_reasons` (part 2 -> 4 values).
 *
 * The expectation is SSOT-derived from `EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS`
 * (hardcoded literal forbidden, §"Canonical CWE-209 PII Protection Pattern" rigor);
 * this test fails CI on any drift (a value present in one site but missing in
 * another).
 *
 * Complements (does NOT replace) `inv-schema-enum-004*.test.ts`.
 *
 * `.skip` / `.todo` are forbidden (LCC-PHASE2-3 mandatory CI-failing landing).
 *
 * @see ADR-0018 Amendment 7 §7.1 (SSOT derive), §7.5 req4 (additive obligation)
 * @see ADR-0018 Amendment 13 §8.8 (CHECK == writable set re-definition)
 *
 * Severity: M (LCC-PHASE2-3)
 *
 * @module tests/regression/standing/schema-enum-sync/inv-schema-enum-004-part-visual-skip-reason
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { assertInvName } from "../_setup/inv-assert";
import {
  EMBEDDING_PART_VISUAL_SKIP_REASONS,
  EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS,
  EMBEDDING_SKIP_REASONS,
} from "../../../../src/workers/phases/types";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const SCHEMA_PATH = path.resolve(REPO_ROOT, "packages/database/prisma/schema.prisma");
// ADR-0018 Amendment 13 §8.8: the CHECK is now defined by the latest additive
// migration (DROP/ADD widening to the 4-value writable set). The original
// 2-value CHECK migration (20260523090000) is superseded for value-set assertions.
const COLUMN_MIGRATION_PATH = path.resolve(
  REPO_ROOT,
  "packages/database/prisma/migrations/20260523090000_add_part_visual_skip_reason/migration.sql"
);
const CHECK_MIGRATION_PATH = path.resolve(
  REPO_ROOT,
  "packages/database/prisma/migrations/20260608120000_add_screenshot_truncated_skip_reasons/migration.sql"
);

/**
 * Extract the part `visual_skip_reason` IN(...) literal list from the ACTIVE CHECK.
 *
 * SQL line-comments (`-- ...`) are stripped BEFORE matching so a rollback example
 * in the migration header (which shows the prior 2-value CHECK) does not shadow
 * the active executable DDL (mirrors the section extractor's comment-stripping).
 */
function extractCheckConstraintValues(migrationSql: string): string[] {
  // CHECK ("visual_skip_reason" IS NULL OR "visual_skip_reason" IN ('a', 'b'))
  const executableSql = migrationSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const m = executableSql.match(/"visual_skip_reason"\s+IN\s*\(([^)]*)\)/i);
  if (!m) return [];
  return (m[1].match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
}

describe("INV-SCHEMA-ENUM-004: visual_skip_reason 4-site sync (Amendment 13 writable set)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
  });

  it("INV-SCHEMA-ENUM-004: TS SSOT terminal subset == {bbox_invalid, bbox_unresolvable, screenshot_truncated_expired} (screenshot_truncated EXCLUDED, non-terminal)", () => {
    // Terminal subset gains `screenshot_truncated_expired` (Amendment 13) but NOT
    // `screenshot_truncated` (which is writable but non-terminal / stays pending).
    expect([...EMBEDDING_PART_VISUAL_SKIP_REASONS].sort()).toEqual([
      "bbox_invalid",
      "bbox_unresolvable",
      "screenshot_truncated_expired",
    ]);
    // Derived (not hardcoded): each must be a member of the EMBEDDING_SKIP_REASONS SSOT.
    for (const reason of EMBEDDING_PART_VISUAL_SKIP_REASONS) {
      expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain(reason);
    }
    // `screenshot_truncated` is NON-terminal: it must NOT be in the terminal subset.
    expect(EMBEDDING_PART_VISUAL_SKIP_REASONS as readonly string[]).not.toContain(
      "screenshot_truncated"
    );
  });

  it("INV-SCHEMA-ENUM-004: TS writable set == terminal subset ∪ {screenshot_truncated} (SSOT-derived)", () => {
    const expectedWritable = [...EMBEDDING_PART_VISUAL_SKIP_REASONS, "screenshot_truncated"].sort();
    expect([...EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS].sort()).toEqual(expectedWritable);
    // Derived (not hardcoded): each writable value must be a member of the SSOT.
    for (const reason of EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS) {
      expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain(reason);
    }
  });

  it("INV-SCHEMA-ENUM-004: Prisma migration CHECK constraint allowed values == TS writable set (Amendment 13)", () => {
    const migrationSql = fs.readFileSync(CHECK_MIGRATION_PATH, "utf8");
    const checkValues = extractCheckConstraintValues(migrationSql).sort();
    const writableValues = [...EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS].sort();
    expect(
      checkValues,
      "Prisma migration CHECK constraint values MUST equal the TS writable set EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS (4-site drift)"
    ).toEqual(writableValues);
  });

  it("INV-SCHEMA-ENUM-004: Prisma schema declares the visual_skip_reason field (TEXT nullable, mapped to visual_skip_reason)", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    // The model field must exist with the snake_case @map and be nullable (String?).
    expect(schema).toMatch(/visualSkipReason\s+String\?\s+@map\("visual_skip_reason"\)/);
  });

  it("INV-SCHEMA-ENUM-004: original column migration is additive non-breaking DDL (ADD COLUMN IF NOT EXISTS + CHECK + partial index)", () => {
    const migrationSql = fs.readFileSync(COLUMN_MIGRATION_PATH, "utf8");
    expect(migrationSql).toMatch(
      /ALTER TABLE\s+"component_part_embeddings"\s+ADD COLUMN IF NOT EXISTS\s+"visual_skip_reason"\s+TEXT/i
    );
    expect(migrationSql).toMatch(
      /ADD CONSTRAINT\s+"component_part_embeddings_visual_skip_reason_check"/i
    );
    expect(migrationSql).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+"component_part_embeddings_visual_skip_reason_idx"/i
    );
  });

  it("INV-SCHEMA-ENUM-004: Amendment 13 CHECK migration is additive DROP/ADD (no data-rejecting DDL)", () => {
    const migrationSql = fs.readFileSync(CHECK_MIGRATION_PATH, "utf8");
    expect(migrationSql).toMatch(
      /DROP CONSTRAINT IF EXISTS\s+"component_part_embeddings_visual_skip_reason_check"/i
    );
    expect(migrationSql).toMatch(
      /ADD CONSTRAINT\s+"component_part_embeddings_visual_skip_reason_check"/i
    );
  });

  it("INV-SCHEMA-ENUM-004: the writable set count matches the CHECK constraint count (no orphan value in either site)", () => {
    const migrationSql = fs.readFileSync(CHECK_MIGRATION_PATH, "utf8");
    const checkValues = extractCheckConstraintValues(migrationSql);
    expect(checkValues).toHaveLength(EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS.length);
    // terminal subset 3 (bbox_invalid + bbox_unresolvable + screenshot_truncated_expired)
    // + screenshot_truncated = 4 writable values.
    expect(EMBEDDING_PART_VISUAL_SKIP_REASONS).toHaveLength(3);
    expect(EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS).toHaveLength(4);
  });
});
