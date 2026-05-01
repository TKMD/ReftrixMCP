#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Check Embedding Coverage
 *
 * Diagnostic script to report embedding coverage across all web pages.
 * Shows how many patterns have embeddings and how many are missing.
 *
 * Usage:
 *   pnpm check:embeddings                    # All pages
 *   pnpm check:embeddings -- --url stripe.com # Specific URL
 *
 * @module scripts/check-embedding-coverage
 */

import { prisma } from "@reftrixmcp/database";
import { loadEnvLocal } from "@reftrixmcp/core";
import {
  checkWebPageEmbeddingCoverage,
  findWebPagesWithMissingEmbeddings,
} from "../services/embedding-backfill.service";

/* eslint-disable no-console */

async function main(): Promise<void> {
  // PR7e-β1: use shared @reftrixmcp/core loader (SEC-β-01 / SEC-β-07)
  loadEnvLocal({ verbose: false });

  const args = process.argv.slice(2);
  const urlFilter = args.includes("--url") ? args[args.indexOf("--url") + 1] : undefined;

  console.log("=== Embedding Coverage Report ===\n");

  if (urlFilter) {
    // Single page report
    const webPage = await prisma.webPage.findFirst({
      where: { url: { contains: urlFilter } },
      select: { id: true, url: true },
    });

    if (!webPage) {
      console.log(`No web page found matching: ${urlFilter}`);
      process.exit(1);
    }

    console.log(`Page: ${webPage.url} (${webPage.id})\n`);
    const coverage = await checkWebPageEmbeddingCoverage(webPage.id);
    printCoverage(coverage);
  } else {
    // All pages with missing embeddings
    const pagesWithMissing = await findWebPagesWithMissingEmbeddings();

    if (pagesWithMissing.length === 0) {
      console.log("All pages have complete embeddings!");

      // Show total counts
      const totalPages = await prisma.webPage.count();
      console.log(`\nTotal pages: ${totalPages}`);
    } else {
      console.log(`Pages with missing embeddings: ${pagesWithMissing.length}\n`);

      let grandTotalMissing = 0;
      for (const { webPageId, url, missingCount } of pagesWithMissing) {
        console.log(`--- ${url} ---`);
        console.log(`  Missing: ${missingCount}`);
        const coverage = await checkWebPageEmbeddingCoverage(webPageId);
        printCoverage(coverage, "  ");
        console.log("");
        grandTotalMissing += missingCount;
      }

      console.log(`\nGrand total missing: ${grandTotalMissing}`);
    }
  }

  await prisma.$disconnect();
}

function printCoverage(
  coverage: { type: string; total: number; embedded: number; missing: number }[],
  indent = ""
): void {
  for (const c of coverage) {
    const pct = c.total > 0 ? Math.round((c.embedded / c.total) * 100) : 100;
    const status = c.missing === 0 ? "OK" : "MISSING";
    console.log(`${indent}${c.type}: ${c.embedded}/${c.total} (${pct}%) [${status}]`);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
