// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete fixture helpers
 * / gdpr-delete fixture ヘルパー
 *
 * ADR-0016 § INV-DATA-DELETE-002 Assertion Contract の 5 項目独立 assertion
 * および Amendment 2-A の pgvector 11 tables 完全網羅に対応するための fixture
 * seed / cleanup / count ヘルパー。
 *
 * Fixture helpers for ADR-0016 § INV-DATA-DELETE-002 Assertion Contract
 * (5-item independent assertion) and Amendment 2-A (pgvector 11 tables).
 *
 * ## Canonical 11 tables (Amendment 2-A)
 *
 * 9 page-linked embedding tables:
 *   section_embeddings / component_part_embeddings / motion_embeddings /
 *   js_animation_embeddings / webgl_animation_embeddings /
 *   motion_analysis_embeddings / design_narrative_embeddings /
 *   background_design_embeddings / responsive_analysis_embeddings
 *
 * + quality_benchmarks (2 経路 OR DELETE)
 * + design_snapshot_sections (CASCADE via design_snapshots)
 *
 * Out-of-scope (profile path, `deleteProfile`):
 *   preference_profiles / preference_signals
 *
 * @module tests/regression/standing/_setup/gdpr-test-fixtures
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

// ============================================================================
// Constants
// ============================================================================

/**
 * Amendment 2-A で確定した pgvector 11 tables (data.delete(page) が row=0 化する)。
 * Canonical list of 11 pgvector tables verified by ADR-0016 Amendment 2-A.
 */
export const PGVECTOR_11_TABLES_FOR_PAGE = [
  // 9 page-linked embedding tables
  "section_embeddings",
  "component_part_embeddings",
  "motion_embeddings",
  "js_animation_embeddings",
  "webgl_animation_embeddings",
  "motion_analysis_embeddings",
  "design_narrative_embeddings",
  "background_design_embeddings",
  "responsive_analysis_embeddings",
  // 1 benchmark table (二経路 OR DELETE)
  "quality_benchmarks",
  // 1 snapshot-cascade table (via design_snapshots → web_pages.id)
  "design_snapshot_sections",
] as const;

/**
 * data.delete(page) 対象外の profile 経路テーブル (Amendment 2-A で明記)。
 * Profile-path tables that are **out-of-scope** for data.delete(page).
 *
 * preference_profiles / preference_signals は `deleteProfile()` 経路で削除される。
 * These are deleted via the `deleteProfile()` path, NOT `deletePage()`.
 */
export const OUT_OF_SCOPE_PROFILE_TABLES = ["preference_profiles", "preference_signals"] as const;

// ============================================================================
// Types
// ============================================================================

/**
 * seedGdprFixture が作成したエンティティの ID 集 (fixture 全体のトレース用)。
 * IDs created by seedGdprFixture (traceable across assertions).
 */
export interface GdprFixtureIds {
  webPageId: string;
  sectionPatternId: string;
  componentPartId: string;
  motionPatternId: string;
  jsAnimationPatternId: string;
  webglAnimationPatternId: string;
  motionAnalysisResultId: string;
  designNarrativeId: string;
  backgroundDesignId: string;
  responsiveAnalysisId: string;
  /** quality_benchmarks via direct web_page_id FK (二経路 OR DELETE: 経路 1) */
  qbDirectId: string;
  /** quality_benchmarks via indirect section_pattern_id FK (経路 2; web_page_id NULL) */
  qbIndirectId: string;
  designSnapshotId: string;
  designSnapshotSectionId: string;
  /** 絶対 path / absolute path to persisted screenshot PNG */
  screenshotPath: string;
  // Out-of-scope (profile path, NEVER deleted by data.delete(target=page))
  preferenceProfileId: string;
  preferenceSignalId: string;
}

/**
 * countPageVectorRows: 11 tables で webPageId 由来の row 数を集計する。
 * Counts rows tied to webPageId across the 11 pgvector tables.
 *
 * 各 embedding は FK parent table (例 section_patterns) 経由で紐づくため、
 * 集計は subquery ベースで行う。
 *
 * Each embedding table is linked via its FK parent table (e.g., section_patterns),
 * so counts are computed via subqueries.
 */
export interface PageVectorCounts {
  section_embeddings: number;
  component_part_embeddings: number;
  motion_embeddings: number;
  js_animation_embeddings: number;
  webgl_animation_embeddings: number;
  motion_analysis_embeddings: number;
  design_narrative_embeddings: number;
  background_design_embeddings: number;
  responsive_analysis_embeddings: number;
  quality_benchmarks_direct: number;
  quality_benchmarks_indirect: number;
  design_snapshot_sections: number;
}

// ============================================================================
// Schema apply
// ============================================================================

/**
 * No-op retained for backward compatibility with earlier beforeAll hooks.
 * Schema application is now performed in `_setup/global-setup.ts` via
 * `applyPrismaSchemaToTestcontainer` (prisma migrate deploy), so there is
 * nothing to do at domain scope.
 *
 * 後方互換のための no-op。schema 適用は global-setup.ts の
 * `applyPrismaSchemaToTestcontainer` (prisma migrate deploy) に移行済。
 */
export async function ensureSchemaAppliedOnce(_databaseUrl?: string): Promise<void> {
  return;
}

// ============================================================================
// Prisma client factory
// ============================================================================

/**
 * Creates a PrismaClient bound to the testcontainer DATABASE_URL.
 * Must be called after global-setup has exported DATABASE_URL.
 *
 * globalSetup 完了後に testcontainer DATABASE_URL を使う PrismaClient を生成。
 */
export function createTestPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[gdpr-test-fixtures] DATABASE_URL not set by globalSetup");
  }
  // fail-closed: production DB 防御 / Production DB safety net
  if (!/^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1|::1|\[::1\])[:\/]/i.test(url)) {
    throw new Error(
      "[gdpr-test-fixtures] Refusing to bind PrismaClient to non-testcontainer DATABASE_URL " +
        "(must target localhost / 127.0.0.1)"
    );
  }
  return new PrismaClient({
    datasources: { db: { url } },
    log: ["error"],
  });
}

// ============================================================================
// Fixture seed
// ============================================================================

function newUuid(): string {
  return crypto.randomUUID();
}

/**
 * Minimum PNG file (IHDR only) — satisfies `fs.existsSync` / `stat.isFile()` assertions.
 * 最小 PNG (IHDR のみ) — existsSync / isFile の assertion に足りる。
 */
const MIN_PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a" + "0000000d49484452" + "00000001000000010806000000" + "1f15c489",
  "hex"
);

/**
 * Screenshot file を fixture として生成し、絶対 path を返す。
 * Creates a screenshot fixture file and returns its absolute path.
 *
 * globalSetup の `enforceTestScreenshotRoot()` によって
 * `REFTRIX_SCREENSHOT_ROOT=/tmp/reftrix-test-<uuid>/` に上書き済の前提。
 *
 * Assumes `REFTRIX_SCREENSHOT_ROOT` has already been overridden to
 * `/tmp/reftrix-test-<uuid>/` by globalSetup's `enforceTestScreenshotRoot()`.
 */
export function createScreenshotFixtureFile(webPageId: string): string {
  const root = process.env.REFTRIX_SCREENSHOT_ROOT;
  if (!root || !root.startsWith("/tmp/reftrix-test-")) {
    throw new Error(
      "[gdpr-test-fixtures] REFTRIX_SCREENSHOT_ROOT is not a test-only path; refuse to write fixture"
    );
  }
  const phase5Dir = path.join(root, "phase5");
  fs.mkdirSync(phase5Dir, { recursive: true, mode: 0o700 });
  const absPath = path.join(phase5Dir, `${webPageId}.png`);
  fs.writeFileSync(absPath, MIN_PNG_BYTES, { mode: 0o600 });
  return absPath;
}

/**
 * ADR-0016 Amendment 2-A の 11 tables 全てに 1 row ずつ seed し、加えて
 * screenshot ファイル + audit_logs 0-row 状態を準備する。
 *
 * Seeds 1 row into each of the 11 pgvector tables per Amendment 2-A, plus a
 * screenshot file and an empty audit_logs state.
 */
export async function seedGdprFixture(prisma: PrismaClient): Promise<GdprFixtureIds> {
  const ids: GdprFixtureIds = {
    webPageId: newUuid(),
    sectionPatternId: newUuid(),
    componentPartId: newUuid(),
    motionPatternId: newUuid(),
    jsAnimationPatternId: newUuid(),
    webglAnimationPatternId: newUuid(),
    motionAnalysisResultId: newUuid(),
    designNarrativeId: newUuid(),
    backgroundDesignId: newUuid(),
    responsiveAnalysisId: newUuid(),
    qbDirectId: newUuid(),
    qbIndirectId: newUuid(),
    designSnapshotId: newUuid(),
    designSnapshotSectionId: newUuid(),
    screenshotPath: "",
    preferenceProfileId: newUuid(),
    preferenceSignalId: newUuid(),
  };

  // Screenshot file
  ids.screenshotPath = createScreenshotFixtureFile(ids.webPageId);

  // DB rows (1 query per row; acceptable given total is ~25 rows).
  // NOTE: Raw SQL bypasses Prisma's `@updatedAt` application-side trigger.
  //       Models with `updated_at TIMESTAMPTZ NOT NULL` require an explicit
  //       `NOW()` value. Tables without `updatedAt` (responsive_analyses,
  //       design_snapshots, design_snapshot_sections, preference_signals,
  //       audit_logs, search_logs) are unaffected.
  //
  // 生 SQL では Prisma の `@updatedAt` が効かないため、updated_at NOT NULL の
  // model には NOW() を明示指定する必要がある。

  // 1. web_pages (root)
  await prisma.$executeRawUnsafe(
    `INSERT INTO web_pages (id, url, source_type, usage_scope, screenshot_storage_path, updated_at)
     VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', $3, NOW())`,
    ids.webPageId,
    `https://example.com/test/${ids.webPageId}`,
    ids.screenshotPath
  );

  // 2. section_patterns + section_embeddings
  await prisma.$executeRawUnsafe(
    `INSERT INTO section_patterns (id, web_page_id, section_type, position_index, layout_info, updated_at)
     VALUES ($1::uuid, $2::uuid, 'hero', 0, '{}'::jsonb, NOW())`,
    ids.sectionPatternId,
    ids.webPageId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO section_embeddings (id, section_pattern_id, model_version, updated_at)
     VALUES ($1::uuid, $2::uuid, 'multilingual-e5-base', NOW())`,
    newUuid(),
    ids.sectionPatternId
  );

  // 3. component_parts + component_part_embeddings
  await prisma.$executeRawUnsafe(
    `INSERT INTO component_parts (id, web_page_id, section_pattern_id, part_type, extracted_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'button', NOW(), NOW())`,
    ids.componentPartId,
    ids.webPageId,
    ids.sectionPatternId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO component_part_embeddings (id, component_part_id, visual_model_version, text_model_version, embedding_timestamp, updated_at)
     VALUES ($1::uuid, $2::uuid, 'dinov2-vit-b-14', 'multilingual-e5-base', NOW(), NOW())`,
    newUuid(),
    ids.componentPartId
  );

  // 4. motion_patterns + motion_embeddings
  await prisma.$executeRawUnsafe(
    `INSERT INTO motion_patterns (id, web_page_id, name, category, trigger_type, animation, implementation, updated_at)
     VALUES ($1::uuid, $2::uuid, 'test-motion', 'scroll_trigger', 'scroll', '{}'::jsonb, '{}'::jsonb, NOW())`,
    ids.motionPatternId,
    ids.webPageId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO motion_embeddings (id, motion_pattern_id, model_version, updated_at)
     VALUES ($1::uuid, $2::uuid, 'multilingual-e5-base', NOW())`,
    newUuid(),
    ids.motionPatternId
  );

  // 5. js_animation_patterns + js_animation_embeddings
  await prisma.$executeRawUnsafe(
    `INSERT INTO js_animation_patterns (id, web_page_id, library_type, name, animation_type, updated_at)
     VALUES ($1::uuid, $2::uuid, 'gsap', 'test-js-anim', 'tween', NOW())`,
    ids.jsAnimationPatternId,
    ids.webPageId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO js_animation_embeddings (id, js_animation_pattern_id, model_version, embedding_timestamp, updated_at)
     VALUES ($1::uuid, $2::uuid, 'multilingual-e5-base', NOW(), NOW())`,
    newUuid(),
    ids.jsAnimationPatternId
  );

  // 6. webgl_animation_patterns + webgl_animation_embeddings
  await prisma.$executeRawUnsafe(
    `INSERT INTO webgl_animation_patterns (id, web_page_id, name, category, frame_analysis, updated_at)
     VALUES ($1::uuid, $2::uuid, 'test-webgl-anim', 'particle', '{}'::jsonb, NOW())`,
    ids.webglAnimationPatternId,
    ids.webPageId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO webgl_animation_embeddings (id, webgl_animation_pattern_id, model_version, embedding_timestamp, updated_at)
     VALUES ($1::uuid, $2::uuid, 'multilingual-e5-base', NOW(), NOW())`,
    newUuid(),
    ids.webglAnimationPatternId
  );

  // 7. motion_analysis_results + motion_analysis_embeddings
  await prisma.$executeRawUnsafe(
    `INSERT INTO motion_analysis_results (id, web_page_id, result_type, frame_index, result_data, updated_at)
     VALUES ($1::uuid, $2::uuid, 'animation_zone', 0, '{}'::jsonb, NOW())`,
    ids.motionAnalysisResultId,
    ids.webPageId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO motion_analysis_embeddings (id, motion_analysis_result_id, model_version, updated_at)
     VALUES ($1::uuid, $2::uuid, 'multilingual-e5-base', NOW())`,
    newUuid(),
    ids.motionAnalysisResultId
  );

  // 8. design_narratives + design_narrative_embeddings
  await prisma.$executeRawUnsafe(
    `INSERT INTO design_narratives (id, web_page_id, mood_category, updated_at)
     VALUES ($1::uuid, $2::uuid, 'professional', NOW())`,
    ids.designNarrativeId,
    ids.webPageId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO design_narrative_embeddings (id, design_narrative_id, model_version, updated_at)
     VALUES ($1::uuid, $2::uuid, 'multilingual-e5-base', NOW())`,
    newUuid(),
    ids.designNarrativeId
  );

  // 9. background_designs + background_design_embeddings
  await prisma.$executeRawUnsafe(
    `INSERT INTO background_designs (id, web_page_id, name, design_type, css_value, updated_at)
     VALUES ($1::uuid, $2::uuid, 'test-bg', 'solid_color', '#000000', NOW())`,
    ids.backgroundDesignId,
    ids.webPageId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO background_design_embeddings (id, background_design_id, model_version, updated_at)
     VALUES ($1::uuid, $2::uuid, 'multilingual-e5-base', NOW())`,
    newUuid(),
    ids.backgroundDesignId
  );

  // 10. responsive_analyses (no updated_at) + responsive_analysis_embeddings
  await prisma.$executeRawUnsafe(
    `INSERT INTO responsive_analyses (id, web_page_id, viewports_analyzed, differences, analysis_time_ms)
     VALUES ($1::uuid, $2::uuid, '[]'::jsonb, '[]'::jsonb, 100)`,
    ids.responsiveAnalysisId,
    ids.webPageId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO responsive_analysis_embeddings (id, responsive_analysis_id, model_version, updated_at)
     VALUES ($1::uuid, $2::uuid, 'multilingual-e5-base', NOW())`,
    newUuid(),
    ids.responsiveAnalysisId
  );

  // 11a. quality_benchmarks (経路 1: web_page_id 直接参照)
  await prisma.$executeRawUnsafe(
    `INSERT INTO quality_benchmarks (id, web_page_id, section_type, overall_score, grade, axis_scores, source_url, updated_at)
     VALUES ($1::uuid, $2::uuid, 'hero', 90, 'A', '{}'::jsonb, $3, NOW())`,
    ids.qbDirectId,
    ids.webPageId,
    "https://example.com/qb-direct"
  );
  // 11b. quality_benchmarks (経路 2: section_pattern_id 経由、web_page_id NULL)
  await prisma.$executeRawUnsafe(
    `INSERT INTO quality_benchmarks (id, section_pattern_id, section_type, overall_score, grade, axis_scores, source_url, updated_at)
     VALUES ($1::uuid, $2::uuid, 'hero', 92, 'A', '{}'::jsonb, $3, NOW())`,
    ids.qbIndirectId,
    ids.sectionPatternId,
    "https://example.com/qb-indirect"
  );

  // 12. design_snapshots + design_snapshot_sections
  await prisma.$executeRawUnsafe(
    `INSERT INTO design_snapshots (id, web_page_id, section_count)
     VALUES ($1::uuid, $2::uuid, 1)`,
    ids.designSnapshotId,
    ids.webPageId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO design_snapshot_sections (id, snapshot_id, section_type, position_index)
     VALUES ($1::uuid, $2::uuid, 'hero', 0)`,
    ids.designSnapshotSectionId,
    ids.designSnapshotId
  );

  // Out-of-scope (profile path): NEVER deleted by data.delete(target=page).
  // Amendment 2-A で明記された対象外テーブル。
  await prisma.$executeRawUnsafe(
    `INSERT INTO preference_profiles (id, name, updated_at)
     VALUES ($1::uuid, 'fixture-out-of-scope', NOW())`,
    ids.preferenceProfileId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO preference_signals (id, profile_id, signal_type, signal_weight, target_type, target_id)
     VALUES ($1::uuid, $2::uuid, 'hearing_positive', 1.0, 'web_page', $3::uuid)`,
    ids.preferenceSignalId,
    ids.preferenceProfileId,
    ids.webPageId
  );

  return ids;
}

// ============================================================================
// Assertion helpers
// ============================================================================

/**
 * Amendment 2-A の 11 tables で webPageId 由来の row 数を集計する。
 * 削除前は 1 ずつ (quality_benchmarks は direct + indirect = 各 1、合計 2)、
 * 削除後は全て 0 となる。
 *
 * Counts rows tied to webPageId across the 11 pgvector tables. Expected
 * before deletion: 1 each (quality_benchmarks direct=1, indirect=1);
 * after deletion: all 0.
 */
export async function countPageVectorRows(
  prisma: PrismaClient,
  ids: GdprFixtureIds
): Promise<PageVectorCounts> {
  const one = async (sql: string, ...args: unknown[]): Promise<number> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(sql, ...args);
    return Number(rows[0]?.count ?? 0n);
  };

  return {
    section_embeddings: await one(
      `SELECT COUNT(*)::bigint AS count FROM section_embeddings
       WHERE section_pattern_id IN (SELECT id FROM section_patterns WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
    component_part_embeddings: await one(
      `SELECT COUNT(*)::bigint AS count FROM component_part_embeddings
       WHERE component_part_id IN (SELECT id FROM component_parts WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
    motion_embeddings: await one(
      `SELECT COUNT(*)::bigint AS count FROM motion_embeddings
       WHERE motion_pattern_id IN (SELECT id FROM motion_patterns WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
    js_animation_embeddings: await one(
      `SELECT COUNT(*)::bigint AS count FROM js_animation_embeddings
       WHERE js_animation_pattern_id IN (SELECT id FROM js_animation_patterns WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
    webgl_animation_embeddings: await one(
      `SELECT COUNT(*)::bigint AS count FROM webgl_animation_embeddings
       WHERE webgl_animation_pattern_id IN (SELECT id FROM webgl_animation_patterns WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
    motion_analysis_embeddings: await one(
      `SELECT COUNT(*)::bigint AS count FROM motion_analysis_embeddings
       WHERE motion_analysis_result_id IN (SELECT id FROM motion_analysis_results WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
    design_narrative_embeddings: await one(
      `SELECT COUNT(*)::bigint AS count FROM design_narrative_embeddings
       WHERE design_narrative_id IN (SELECT id FROM design_narratives WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
    background_design_embeddings: await one(
      `SELECT COUNT(*)::bigint AS count FROM background_design_embeddings
       WHERE background_design_id IN (SELECT id FROM background_designs WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
    responsive_analysis_embeddings: await one(
      `SELECT COUNT(*)::bigint AS count FROM responsive_analysis_embeddings
       WHERE responsive_analysis_id IN (SELECT id FROM responsive_analyses WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
    // quality_benchmarks: 二経路 OR DELETE を分離 count する
    quality_benchmarks_direct: await one(
      `SELECT COUNT(*)::bigint AS count FROM quality_benchmarks WHERE web_page_id = $1::uuid`,
      ids.webPageId
    ),
    quality_benchmarks_indirect: await one(
      `SELECT COUNT(*)::bigint AS count FROM quality_benchmarks
       WHERE section_pattern_id IN (SELECT id FROM section_patterns WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
    design_snapshot_sections: await one(
      `SELECT COUNT(*)::bigint AS count FROM design_snapshot_sections
       WHERE snapshot_id IN (SELECT id FROM design_snapshots WHERE web_page_id = $1::uuid)`,
      ids.webPageId
    ),
  };
}

/**
 * preference_profiles / preference_signals の row が **残存** していることを確認する
 * (profile 経路 = deleteProfile、data.delete(target=page) では絶対に削除されない)。
 *
 * Verifies preference rows **still exist** after data.delete(target=page).
 * These are the profile-path tables that MUST NOT be deleted by the page path.
 */
export async function countOutOfScopeProfileRows(
  prisma: PrismaClient,
  ids: GdprFixtureIds
): Promise<{ preference_profiles: number; preference_signals: number }> {
  const profileRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM preference_profiles WHERE id = $1::uuid`,
    ids.preferenceProfileId
  );
  const signalRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM preference_signals WHERE id = $1::uuid`,
    ids.preferenceSignalId
  );
  return {
    preference_profiles: Number(profileRows[0]?.count ?? 0n),
    preference_signals: Number(signalRows[0]?.count ?? 0n),
  };
}

/**
 * 全 DB テーブルを TRUNCATE して clean state にする (CI worker 内で reuse するため)。
 * Truncates all tables relevant to the gdpr-delete regression to a clean state.
 */
export async function truncateGdprDomainTables(prisma: PrismaClient): Promise<void> {
  // audit_logs + preference_* + web_pages cascade で関連 10+1 table も消える (FK cascade)
  // が、quality_benchmarks は SetNull のため明示 TRUNCATE が必要。
  // web_pages CASCADE removes most deps; quality_benchmarks uses SetNull so clear explicitly.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE
       audit_logs,
       preference_signals,
       preference_profiles,
       quality_benchmarks,
       design_snapshot_sections,
       design_snapshots,
       section_embeddings,
       component_part_embeddings,
       motion_embeddings,
       js_animation_embeddings,
       webgl_animation_embeddings,
       motion_analysis_embeddings,
       design_narrative_embeddings,
       background_design_embeddings,
       responsive_analysis_embeddings,
       section_patterns,
       component_parts,
       motion_patterns,
       js_animation_patterns,
       webgl_animation_patterns,
       motion_analysis_results,
       design_narratives,
       background_designs,
       responsive_analyses,
       web_pages
     RESTART IDENTITY CASCADE`
  );
}
