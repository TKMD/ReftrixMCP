// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004 additive (PR-BACKFILL-TERMINAL
 * 系統B / System B, PR-BT-2)
 *
 * ADR-0018 Amendment (System B): the `vision_skip_reason` terminal-skip marker's
 * allowed value set MUST be in lockstep across the 4 canonical sites (symmetry
 * with the part_visual precedent `inv-schema-enum-004-part-visual-skip-reason.test.ts`):
 *
 *   1. Prisma migration CHECK constraint on `section_embeddings.vision_skip_reason`
 *   2. Prisma schema field `SectionEmbedding.visionSkipReason` (TEXT nullable)
 *   3. TS SSOT `EMBEDDING_SECTION_VISUAL_SKIP_REASONS` (derived from EMBEDDING_SKIP_REASONS)
 *   4. The SectionVisualTerminalSkipReason type / SSOT exclusion predicate consumer set
 *
 * The set is `{section_visual_uncroppable, section_visual_duplicate,
 * section_visual_pii_excluded, section_visual_blank, section_visual_no_position}`
 * (currently 5 values; PR-C4 added `section_visual_pii_excluded` via the additive
 * migration 20260530120000_add_section_visual_pii_excluded_skip_reason, then
 * secvisual-blank-terminal added `section_visual_blank` + `section_visual_no_position`
 * via the additive migration 20260531090000_add_section_visual_blank_no_position_skip_reasons).
 * Future terminal reason additions MUST extend ALL 4 sites additively (ADR-0018
 * §7.5 req4); this test fails CI on any drift (a value present in one site but
 * missing in another).
 *
 * Complements (does NOT replace) `inv-schema-enum-004*.test.ts` and the
 * part_visual precedent.
 *
 * `.skip` / `.todo` are forbidden (FIND-BT-H-02-RESIDUAL is H severity; the
 *
 * @see ADR-0018 Amendment (System B, PR-BT-2) — SSOT derive + terminal-skip symmetry
 * @see backfill-terminal-correctness-design-v2.md §4.3 / §5.4 (migration precedent mirror)
 * @see IO Plan Decision V2 internal `019e5842` (BT-V2-CORR-03)
 *
 * Severity: M (count-coupled drift guard) + H lineage (FIND-BT-H-02-RESIDUAL)
 *
 * @module tests/regression/standing/schema-enum-sync/inv-schema-enum-004-section-visual-skip-reason
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { assertInvName } from "../_setup/inv-assert";
import {
  EMBEDDING_SECTION_VISUAL_SKIP_REASONS,
  EMBEDDING_SECTION_VISUAL_WRITABLE_SKIP_REASONS,
  EMBEDDING_SKIP_REASONS,
} from "../../../../src/workers/phases/types";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const SCHEMA_PATH = path.resolve(REPO_ROOT, "packages/database/prisma/schema.prisma");
// Initial 2-value migration: introduces the column (ADD COLUMN), the partial
// index, and the precedent Privacy block. The ADD COLUMN / index assertions read
// this file.
const INITIAL_MIGRATION_PATH = path.resolve(
  REPO_ROOT,
  "packages/database/prisma/migrations/20260524192012_add_section_visual_skip_reason/migration.sql"
);
// ADR-0018 Amendment 13 additive migration: re-creates the CHECK constraint with
// the 7-value SSOT-derived WRITABLE set (adds `screenshot_truncated` +
// `screenshot_truncated_expired` to the prior 5). The CHECK allowed-values
// assertions read this file (it is the ACTIVE CHECK definition; it supersedes the
// secvisual-blank-terminal 5-value CHECK).
const CHECK_MIGRATION_PATH = path.resolve(
  REPO_ROOT,
  "packages/database/prisma/migrations/20260608120000_add_screenshot_truncated_skip_reasons/migration.sql"
);

/**
 * Extract the IN(...) literal list from the ACTIVE migration CHECK constraint.
 *
 * SQL line-comments (`-- ...`) are stripped BEFORE matching so that a rollback
 * example in the migration header (which may show the prior 2-value CHECK) does
 * not shadow the active executable DDL (the PR-C4 migration documents the 2-value
 * rollback CHECK in its `-- Rollback:` block at the top, then executes the 3-value
 * CHECK at the bottom). Without comment-stripping the first `IN(...)` regex match
 * would be the commented rollback example, not the active DDL.
 */
function extractCheckConstraintValues(migrationSql: string): string[] {
  // CHECK ("vision_skip_reason" IS NULL OR "vision_skip_reason" IN ('a', 'b'))
  const executableSql = migrationSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const m = executableSql.match(/"vision_skip_reason"\s+IN\s*\(([^)]*)\)/i);
  if (!m) return [];
  return (m[1].match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
}

describe("INV-SCHEMA-ENUM-004: vision_skip_reason 4-site sync (PR-BT-2 additive, System B)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
  });

  it("INV-SCHEMA-ENUM-004: TS SSOT terminal subset == prior 5 ∪ {screenshot_truncated_expired} (screenshot_truncated EXCLUDED, non-terminal, Amendment 13)", () => {
    // Amendment 13: terminal subset gains `screenshot_truncated_expired` (terminal)
    // but NOT `screenshot_truncated` (writable but non-terminal / stays pending).
    expect([...EMBEDDING_SECTION_VISUAL_SKIP_REASONS].sort()).toEqual([
      "screenshot_truncated_expired",
      "section_visual_blank",
      "section_visual_duplicate",
      "section_visual_no_position",
      "section_visual_pii_excluded",
      "section_visual_uncroppable",
    ]);
    // Derived (not hardcoded): each must be a member of the EMBEDDING_SKIP_REASONS SSOT.
    for (const reason of EMBEDDING_SECTION_VISUAL_SKIP_REASONS) {
      expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain(reason);
    }
    // `screenshot_truncated` is NON-terminal: it must NOT be in the terminal subset.
    expect(EMBEDDING_SECTION_VISUAL_SKIP_REASONS as readonly string[]).not.toContain(
      "screenshot_truncated"
    );
  });

  it("INV-SCHEMA-ENUM-004: TS writable set == terminal subset ∪ {screenshot_truncated} (SSOT-derived)", () => {
    const expectedWritable = [
      ...EMBEDDING_SECTION_VISUAL_SKIP_REASONS,
      "screenshot_truncated",
    ].sort();
    expect([...EMBEDDING_SECTION_VISUAL_WRITABLE_SKIP_REASONS].sort()).toEqual(expectedWritable);
    for (const reason of EMBEDDING_SECTION_VISUAL_WRITABLE_SKIP_REASONS) {
      expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain(reason);
    }
  });

  it("INV-SCHEMA-ENUM-004: Prisma migration CHECK constraint allowed values == TS writable set (Amendment 13 additive 7-value)", () => {
    // The ACTIVE CHECK is the Amendment 13 additive migration (it re-creates the
    // constraint with the 7-value SSOT-derived WRITABLE set).
    const migrationSql = fs.readFileSync(CHECK_MIGRATION_PATH, "utf8");
    const checkValues = extractCheckConstraintValues(migrationSql).sort();
    const writableValues = [...EMBEDDING_SECTION_VISUAL_WRITABLE_SKIP_REASONS].sort();
    expect(
      checkValues,
      "Prisma migration CHECK constraint values MUST equal the TS writable set EMBEDDING_SECTION_VISUAL_WRITABLE_SKIP_REASONS (4-site drift)"
    ).toEqual(writableValues);
  });

  it("INV-SCHEMA-ENUM-004: Prisma schema declares the vision_skip_reason field (TEXT nullable, mapped to vision_skip_reason)", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    // The model field must exist with the snake_case @map and be nullable (String?).
    expect(schema).toMatch(/visionSkipReason\s+String\?\s+@map\("vision_skip_reason"\)/);
  });

  it("INV-SCHEMA-ENUM-004: initial migration uses additive non-breaking DDL (ADD COLUMN IF NOT EXISTS + CHECK + partial index)", () => {
    const migrationSql = fs.readFileSync(INITIAL_MIGRATION_PATH, "utf8");
    expect(migrationSql).toMatch(
      /ALTER TABLE\s+"section_embeddings"\s+ADD COLUMN IF NOT EXISTS\s+"vision_skip_reason"\s+TEXT/i
    );
    expect(migrationSql).toMatch(/ADD CONSTRAINT\s+"section_embeddings_vision_skip_reason_check"/i);
    expect(migrationSql).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+"section_embeddings_vision_skip_reason_idx"/i
    );
    // Partial index on the non-NULL subset only (the common NULL case is excluded).
    expect(migrationSql).toMatch(/WHERE\s+"vision_skip_reason"\s+IS NOT NULL/i);
  });

  it("INV-SCHEMA-ENUM-004: Amendment 13 migration additively re-creates the CHECK (DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT, non-breaking)", () => {
    // The Amendment 13 additive migration widens the CHECK to 7 values via the
    // DROP/ADD CONSTRAINT idiom (mirrors the precedent migration); existing rows
    // are unaffected (NULL + prior 5 values stay valid → non-breaking).
    const migrationSql = fs.readFileSync(CHECK_MIGRATION_PATH, "utf8");
    expect(migrationSql).toMatch(
      /DROP CONSTRAINT IF EXISTS\s+"section_embeddings_vision_skip_reason_check"/i
    );
    expect(migrationSql).toMatch(/ADD CONSTRAINT\s+"section_embeddings_vision_skip_reason_check"/i);
    // The active CHECK must carry the full 7-value set (the 2 new + 5 prior).
    expect(migrationSql).toContain("screenshot_truncated");
    expect(migrationSql).toContain("screenshot_truncated_expired");
    expect(migrationSql).toContain("section_visual_blank");
    expect(migrationSql).toContain("section_visual_no_position");
    expect(migrationSql).toContain("section_visual_pii_excluded");
  });

  it("INV-SCHEMA-ENUM-004: the writable set count matches the CHECK constraint count (no orphan value in either site)", () => {
    const migrationSql = fs.readFileSync(CHECK_MIGRATION_PATH, "utf8");
    const checkValues = extractCheckConstraintValues(migrationSql);
    // SSOT-derived: lines below auto-follow the SSOT lengths (do NOT hardcode).
    expect(checkValues).toHaveLength(EMBEDDING_SECTION_VISUAL_WRITABLE_SKIP_REASONS.length);
    // terminal subset 6 (prior 5 + screenshot_truncated_expired) + screenshot_truncated = 7 writable.
    expect(EMBEDDING_SECTION_VISUAL_SKIP_REASONS).toHaveLength(6);
    expect(EMBEDDING_SECTION_VISUAL_WRITABLE_SKIP_REASONS).toHaveLength(7);
  });

  it("INV-SCHEMA-ENUM-004: PR-C4 migration Privacy block declares enum-only no-PII + CASCADE + Art.17 subsumption (precedent mirror)", () => {
    // FIND-RA-LCC-L-01 / design §5.4 §8.1: the Privacy block mirrors the precedent
    // part_visual migration's Privacy contract (enum-only, no PII, GDPR Art.4(1)
    // non-personal, CASCADE-deleted via section_patterns -> web_pages, Art.17
    // subsumed). Pin the key Privacy assertions on the PR-C4 migration so a future
    // edit that strips the Privacy contract from the widening migration is caught.
    const migrationSql = fs.readFileSync(CHECK_MIGRATION_PATH, "utf8");
    expect(migrationSql).toMatch(/Privacy/i);
    expect(migrationSql).toMatch(/no PII/i);
    expect(migrationSql).toMatch(/Art\.4\(1\)/);
    expect(migrationSql).toMatch(/CASCADE-deleted/i);
    expect(migrationSql).toMatch(/Art\.17/);
  });
});
