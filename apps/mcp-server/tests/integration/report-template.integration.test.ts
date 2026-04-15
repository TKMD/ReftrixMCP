// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * report.generate Real DB Integration Test
 *
 * Phase 7 SQL カラム修正の検証:
 * mock を使わず実際の PostgreSQL に接続し、修正後の SQL が正しく実行されることを確認する。
 *
 * Phase 7 SQL column fix verification:
 * Connects to real PostgreSQL (no mocks) to verify corrected SQL executes without errors.
 *
 * 前提: DB に analysis_status='completed' の web_page が存在すること
 * Prerequisite: at least one web_page with analysis_status='completed' in DB
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@reftrixmcp/database";
import {
  generateReport,
  setReportPrismaClientFactory,
  resetReportPrismaClientFactory,
} from "../../src/services/report-template.service";

describe("report.generate integration (real DB)", () => {
  let existingWebPageId: string | null = null;

  beforeAll(async () => {
    setReportPrismaClientFactory(
      () => prisma as unknown as { $queryRawUnsafe: (...args: unknown[]) => Promise<unknown> }
    );

    // 既存の analyzed web_page を取得
    const page = await prisma.webPage.findFirst({
      where: { analysisStatus: "completed" },
      select: { id: true },
    });

    if (page) {
      existingWebPageId = page.id;
    }
  });

  afterAll(() => {
    resetReportPrismaClientFactory();
  });

  it("SQL queries run against real DB without column errors (HTML format)", async () => {
    if (!existingWebPageId) {
      console.warn("Skipping: no analyzed web_page in DB");
      return;
    }

    const result = await generateReport({
      webPageId: existingWebPageId,
      format: "html",
      includeMotion: true,
      includeQuality: true,
      includeScreenshot: false,
    });

    expect(result.success).toBe(true);
    expect(result.format).toBe("html");
    expect(result.content).toBeDefined();
    expect(typeof result.content).toBe("string");
    expect(result.contentSizeBytes).toBeGreaterThan(0);
  });

  it("section_patterns SQL returns valid data structure", async () => {
    if (!existingWebPageId) {
      console.warn("Skipping: no analyzed web_page in DB");
      return;
    }

    // section_name AS heading, jsonb_array_length(components) AS component_count を検証
    const sections = (await prisma.$queryRawUnsafe(
      `SELECT section_type,
              section_name AS heading,
              position_index,
              jsonb_array_length(components) AS component_count,
              layout_info->>'type' as layout_type
       FROM section_patterns
       WHERE web_page_id = $1::uuid
       ORDER BY position_index ASC
       LIMIT 5`,
      existingWebPageId
    )) as Array<Record<string, unknown>>;

    expect(Array.isArray(sections)).toBe(true);
    // カラムが存在すること（null でも OK、column does not exist エラーが出ないこと）
    if (sections.length > 0) {
      const first = sections[0];
      expect("heading" in first).toBe(true);
      expect("component_count" in first).toBe(true);
      expect("section_type" in first).toBe(true);
    }
  });

  it("motion_patterns SQL returns valid data structure", async () => {
    if (!existingWebPageId) {
      console.warn("Skipping: no analyzed web_page in DB");
      return;
    }

    // trigger_type AS trigger, animation->>'duration', animation->'easing'->>'type' を検証
    const motions = (await prisma.$queryRawUnsafe(
      `SELECT type,
              name,
              category,
              trigger_type AS trigger,
              (animation->>'duration')::numeric AS duration,
              animation->'easing'->>'type' AS easing
       FROM motion_patterns
       WHERE web_page_id = $1::uuid
       ORDER BY created_at ASC
       LIMIT 5`,
      existingWebPageId
    )) as Array<Record<string, unknown>>;

    expect(Array.isArray(motions)).toBe(true);
    if (motions.length > 0) {
      const first = motions[0];
      expect("trigger" in first).toBe(true);
      expect("type" in first).toBe(true);
    }
  });

  it("quality_evaluations SQL uses target_type/target_id correctly", async () => {
    if (!existingWebPageId) {
      console.warn("Skipping: no analyzed web_page in DB");
      return;
    }

    // WHERE target_type = 'web_page' AND target_id = $1 を検証
    const evals = (await prisma.$queryRawUnsafe(
      `SELECT overall_score, grade, anti_ai_cliche, design_quality, technical_quality
       FROM quality_evaluations
       WHERE target_type = 'web_page' AND target_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT 1`,
      existingWebPageId
    )) as Array<Record<string, unknown>>;

    expect(Array.isArray(evals)).toBe(true);
    if (evals.length > 0) {
      const first = evals[0];
      expect("overall_score" in first).toBe(true);
      expect("grade" in first).toBe(true);
    }
  });

  it("returns PAGE_NOT_FOUND for non-existent web page ID", async () => {
    const result = await generateReport({
      webPageId: "00000000-0000-0000-0000-000000000000",
      format: "html",
      includeMotion: false,
      includeQuality: false,
      includeScreenshot: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("PAGE_NOT_FOUND");
  });
});
