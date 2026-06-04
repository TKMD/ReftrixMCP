// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004 additive (Plan v2 PR-D)
 *
 * ADR-0018 Amendment 7 §7.1 / §7.5 req4 (UB-10): the `visual_skip_reason`
 * terminal-skip marker's allowed value set MUST be in lockstep across the 4
 * canonical sites:
 *
 *   1. Prisma migration CHECK constraint on `component_part_embeddings.visual_skip_reason`
 *   2. Prisma schema field `ComponentPartEmbedding.visualSkipReason` (TEXT nullable)
 *   3. TS SSOT `EMBEDDING_PART_VISUAL_SKIP_REASONS` (derived from EMBEDDING_SKIP_REASONS)
 *   4. The PartVisualTerminalSkipReason type / SSOT exclusion predicate consumer set
 *
 * The set is `{bbox_invalid, bbox_unresolvable}` (currently). Future terminal
 * reason additions MUST extend ALL 4 sites additively (ADR §7.5 req4); this test
 * fails CI on any drift (a value present in one site but missing in another).
 *
 * Complements (does NOT replace) `inv-schema-enum-004*.test.ts`.
 *
 * `.skip` / `.todo` are forbidden (LCC-PHASE2-3 mandatory CI-failing landing).
 *
 * @see ADR-0018 Amendment 7 §7.1 (SSOT derive), §7.5 req4 (additive obligation)
 * @see Plan v2 PR-D §5 TEST (INV-SCHEMA-ENUM-004 additive)
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
  EMBEDDING_SKIP_REASONS,
} from "../../../../src/workers/phases/types";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const SCHEMA_PATH = path.resolve(REPO_ROOT, "packages/database/prisma/schema.prisma");
const MIGRATION_PATH = path.resolve(
  REPO_ROOT,
  "packages/database/prisma/migrations/20260523090000_add_part_visual_skip_reason/migration.sql"
);

/** Extract the IN(...) literal list from the migration CHECK constraint. */
function extractCheckConstraintValues(migrationSql: string): string[] {
  // CHECK ("visual_skip_reason" IS NULL OR "visual_skip_reason" IN ('a', 'b'))
  const m = migrationSql.match(/"visual_skip_reason"\s+IN\s*\(([^)]*)\)/i);
  if (!m) return [];
  return (m[1].match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
}

describe("INV-SCHEMA-ENUM-004: visual_skip_reason 4-site sync (Plan v2 PR-D additive)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
  });

  it("INV-SCHEMA-ENUM-004: TS SSOT EMBEDDING_PART_VISUAL_SKIP_REASONS is the derived terminal subset {bbox_invalid, bbox_unresolvable}", () => {
    expect([...EMBEDDING_PART_VISUAL_SKIP_REASONS].sort()).toEqual([
      "bbox_invalid",
      "bbox_unresolvable",
    ]);
    // Derived (not hardcoded): each must be a member of the 20-value SSOT.
    for (const reason of EMBEDDING_PART_VISUAL_SKIP_REASONS) {
      expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain(reason);
    }
  });

  it("INV-SCHEMA-ENUM-004: Prisma migration CHECK constraint allowed values == TS SSOT set", () => {
    const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
    const checkValues = extractCheckConstraintValues(migrationSql).sort();
    const ssotValues = [...EMBEDDING_PART_VISUAL_SKIP_REASONS].sort();
    expect(
      checkValues,
      "Prisma migration CHECK constraint values MUST equal the TS SSOT EMBEDDING_PART_VISUAL_SKIP_REASONS (4-site drift)"
    ).toEqual(ssotValues);
  });

  it("INV-SCHEMA-ENUM-004: Prisma schema declares the visual_skip_reason field (TEXT nullable, mapped to visual_skip_reason)", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    // The model field must exist with the snake_case @map and be nullable (String?).
    expect(schema).toMatch(/visualSkipReason\s+String\?\s+@map\("visual_skip_reason"\)/);
  });

  it("INV-SCHEMA-ENUM-004: migration uses additive non-breaking DDL (ADD COLUMN IF NOT EXISTS + CHECK + partial index)", () => {
    const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
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

  it("INV-SCHEMA-ENUM-004: the SSOT-derived set count matches the CHECK constraint count (no orphan value in either site)", () => {
    const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
    const checkValues = extractCheckConstraintValues(migrationSql);
    expect(checkValues).toHaveLength(EMBEDDING_PART_VISUAL_SKIP_REASONS.length);
    expect(EMBEDDING_PART_VISUAL_SKIP_REASONS).toHaveLength(2);
  });
});
