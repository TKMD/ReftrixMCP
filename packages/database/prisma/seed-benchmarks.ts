// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reftrix Quality Benchmarks Seed Script
 *
 * Extracts high-quality section patterns (Overall Score >= 85) from quality_evaluations
 * and populates the quality_benchmarks table for pattern-driven quality evaluation.
 *
 * Usage: pnpm seed:benchmarks
 *
 * Data Flow:
 * 1. page.analyze → quality_evaluations (stores overall_score per web_page)
 * 2. This script → quality_benchmarks (extracts patterns from high-score pages)
 *
 * Requirements:
 * - ADMIN_DATABASE_URL environment variable (admin privileges for RLS bypass)
 * - quality_benchmarks table must exist (run migrations first)
 * - quality_evaluations with overall_score >= 85 for data population
 * - section_patterns and section_embeddings for the evaluated web_pages
 *
 * @see docs/planning/db-schema-changes.md Section 9
 */

import { PrismaClient } from "@prisma/client";

// Use ADMIN_DATABASE_URL for admin privileges (required for materialized view refresh)
const databaseUrl = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "[Seed:Benchmarks] ERROR: DATABASE_URL or ADMIN_DATABASE_URL environment variable is required"
  );
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl,
    },
  },
});

interface BenchmarkStats {
  totalPatterns: number;
  patternsWithQualityScore: number;
  highQualityPatterns: number;
  patternsWithEmbeddings: number;
  extractedBenchmarks: number;
}

/**
 * Check the current state of quality evaluations and section patterns
 */
async function checkPatternStats(): Promise<BenchmarkStats> {
  console.log("[Seed:Benchmarks] Checking database statistics...");

  // Total patterns
  const totalPatterns = await prisma.sectionPattern.count();

  // Total quality evaluations
  const totalEvaluationsResult = await prisma.$queryRaw<
    { count: bigint }[]
  >`SELECT COUNT(*) as count FROM quality_evaluations`;
  const patternsWithQualityScore = Number(totalEvaluationsResult[0]?.count ?? 0);

  // Get section_embeddings count (use raw SQL due to Unsupported vector type)
  const embeddingsResult = await prisma.$queryRaw<
    { count: bigint }[]
  >`
    SELECT COUNT(*) as count
    FROM section_embeddings
    WHERE text_embedding IS NOT NULL
  `;
  const patternsWithEmbeddings = Number(embeddingsResult[0]?.count ?? 0);

  // Check high quality evaluations (score >= 85) from quality_evaluations table
  const highQualityResult = await prisma.$queryRaw<
    { count: bigint }[]
  >`
    SELECT COUNT(*) as count
    FROM quality_evaluations qe
    WHERE qe.overall_score >= 85
  `;

  const highQualityPatterns = Number(highQualityResult[0]?.count ?? 0);

  // Current benchmarks count
  const currentBenchmarks = await prisma.$queryRaw<
    { count: bigint }[]
  >`SELECT COUNT(*) as count FROM quality_benchmarks`;

  return {
    totalPatterns,
    patternsWithQualityScore,
    highQualityPatterns,
    patternsWithEmbeddings,
    extractedBenchmarks: Number(currentBenchmarks[0]?.count ?? 0),
  };
}

/**
 * Extract high-quality patterns and insert into quality_benchmarks
 *
 * Strategy:
 * 1. Query quality_evaluations where overall_score >= 85 and target_type = 'web_page'
 * 2. Join with web_pages to get source info
 * 3. Join with section_patterns to get individual sections
 * 4. Join with section_embeddings to get vector embeddings
 * 5. Insert into quality_benchmarks with proper axis score extraction
 */
async function extractBenchmarks(): Promise<number> {
  console.log("[Seed:Benchmarks] Extracting high-quality patterns from quality_evaluations...");

  // Execute raw SQL for complex JSON extraction with proper type handling
  // Join quality_evaluations → web_pages → section_patterns → section_embeddings
  const result = await prisma.$executeRaw`
    INSERT INTO quality_benchmarks (
      section_pattern_id,
      web_page_id,
      section_type,
      overall_score,
      grade,
      characteristics,
      embedding,
      axis_scores,
      source_url,
      source_type,
      html_snippet,
      updated_at
    )
    SELECT
      sp.id as section_pattern_id,
      sp.web_page_id,
      COALESCE(sp.section_type, 'unknown') as section_type,
      qe.overall_score,
      qe.grade,
      COALESCE(sp.tags, ARRAY[]::TEXT[]) as characteristics,
      se.text_embedding as embedding,
      jsonb_build_object(
        'originality', COALESCE(
          (qe.anti_ai_cliche->'axes'->'visual_motifs'->>'score')::int,
          (qe.overall_score * 0.9)::int
        ),
        'craftsmanship', COALESCE(
          (qe.anti_ai_cliche->'axes'->'composition'->>'score')::int,
          (qe.overall_score * 0.95)::int
        ),
        'contextuality', COALESCE(
          (qe.anti_ai_cliche->'axes'->'context'->>'score')::int,
          (qe.overall_score * 0.85)::int
        )
      ) as axis_scores,
      COALESCE(wp.url, 'unknown') as source_url,
      COALESCE(wp.source_type, 'user_provided') as source_type,
      LEFT(sp.html_snippet, 10000) as html_snippet,
      NOW() as updated_at
    FROM quality_evaluations qe
    INNER JOIN web_pages wp ON wp.id = qe.target_id::uuid AND qe.target_type = 'web_page'
    INNER JOIN section_patterns sp ON sp.web_page_id = wp.id
    INNER JOIN section_embeddings se ON se.section_pattern_id = sp.id
    WHERE qe.overall_score >= 85
      AND se.text_embedding IS NOT NULL
    ON CONFLICT DO NOTHING
  `;

  return Number(result);
}

/**
 * Refresh materialized views
 */
async function refreshMaterializedViews(): Promise<void> {
  console.log("[Seed:Benchmarks] Refreshing materialized views...");

  try {
    // Refresh industry quality averages
    await prisma.$executeRaw`
      REFRESH MATERIALIZED VIEW CONCURRENTLY mv_industry_quality_averages
    `;
    console.log("[Seed:Benchmarks] - mv_industry_quality_averages refreshed");
  } catch (error) {
    // CONCURRENTLY requires unique index; if fails, try without
    console.log(
      "[Seed:Benchmarks] - mv_industry_quality_averages: using non-concurrent refresh"
    );
    await prisma.$executeRaw`
      REFRESH MATERIALIZED VIEW mv_industry_quality_averages
    `;
  }

  try {
    // Refresh section type benchmarks
    await prisma.$executeRaw`
      REFRESH MATERIALIZED VIEW CONCURRENTLY mv_section_type_benchmarks
    `;
    console.log("[Seed:Benchmarks] - mv_section_type_benchmarks refreshed");
  } catch (error) {
    console.log(
      "[Seed:Benchmarks] - mv_section_type_benchmarks: using non-concurrent refresh"
    );
    await prisma.$executeRaw`
      REFRESH MATERIALIZED VIEW mv_section_type_benchmarks
    `;
  }
}

/**
 * Display benchmark summary by section type
 */
async function displayBenchmarkSummary(): Promise<void> {
  const summary = await prisma.$queryRaw<
    {
      section_type: string;
      count: bigint;
      avg_score: number;
    }[]
  >`
    SELECT
      section_type,
      COUNT(*) as count,
      ROUND(AVG(overall_score), 2) as avg_score
    FROM quality_benchmarks
    GROUP BY section_type
    ORDER BY count DESC
  `;

  if (summary.length > 0) {
    console.log("\n[Seed:Benchmarks] Benchmark Summary by Section Type:");
    console.log("-".repeat(50));
    console.log(
      `${"Section Type".padEnd(20)} | ${"Count".padStart(6)} | ${"Avg Score".padStart(10)}`
    );
    console.log("-".repeat(50));

    for (const row of summary) {
      console.log(
        `${row.section_type.padEnd(20)} | ${String(row.count).padStart(6)} | ${String(row.avg_score).padStart(10)}`
      );
    }
    console.log("-".repeat(50));
  }
}

/**
 * Main seed function
 */
async function seedBenchmarks(): Promise<void> {
  console.log("[Seed:Benchmarks] Starting benchmark extraction...");
  console.log("=".repeat(60));

  // Step 1: Check current stats
  const stats = await checkPatternStats();

  console.log("\n[Seed:Benchmarks] Current Statistics:");
  console.log(`  - Total section_patterns: ${stats.totalPatterns}`);
  console.log(`  - Total quality_evaluations: ${stats.patternsWithQualityScore}`);
  console.log(`  - High-quality evaluations (>= 85): ${stats.highQualityPatterns}`);
  console.log(`  - Section embeddings available: ${stats.patternsWithEmbeddings}`);
  console.log(`  - Current benchmarks count: ${stats.extractedBenchmarks}`);

  // Step 2: Handle case where no high-quality patterns exist
  if (stats.highQualityPatterns === 0) {
    console.log("\n[Seed:Benchmarks] No high-quality patterns found.");
    console.log(
      "[Seed:Benchmarks] Benchmarks will be automatically populated when:"
    );
    console.log("  1. Pages are analyzed with page.analyze MCPツール");
    console.log("  2. quality.evaluate scores a pattern >= 85");
    console.log(
      "  3. The benchmark extraction runs again (manually or scheduled)"
    );
    console.log(
      "\n[Seed:Benchmarks] To populate benchmarks, analyze high-quality web pages:"
    );
    console.log("  await mcp__reftrix__page_analyze({ url: 'https://...' })");
    console.log("\n=".repeat(60));
    console.log(
      "[Seed:Benchmarks] Completed with 0 benchmarks (no high-quality patterns available)"
    );
    return;
  }

  // Step 3: Extract benchmarks
  const extractedCount = await extractBenchmarks();
  console.log(`\n[Seed:Benchmarks] Extracted ${extractedCount} benchmark records`);

  // Step 4: Refresh materialized views
  await refreshMaterializedViews();

  // Step 5: Display summary
  await displayBenchmarkSummary();

  // Step 6: Final stats
  const finalStats = await checkPatternStats();
  console.log("\n[Seed:Benchmarks] Final Statistics:");
  console.log(`  - Total benchmarks: ${finalStats.extractedBenchmarks}`);

  console.log("\n=".repeat(60));
  console.log("[Seed:Benchmarks] Benchmark extraction completed successfully!");
}

// Main execution
seedBenchmarks()
  .catch((error) => {
    console.error("[Seed:Benchmarks] ERROR:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
