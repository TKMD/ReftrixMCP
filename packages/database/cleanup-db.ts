// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log('=== DB Cleanup Start ===\n');

  // 1. 関連データの削除（依存関係順）
  console.log('1. Deleting related data...');
  
  // SectionEmbedding削除
  const sectionEmbeddingsDeleted = await prisma.sectionEmbedding.deleteMany({});
  console.log(`   - SectionEmbedding: ${sectionEmbeddingsDeleted.count} records deleted`);
  
  // MotionEmbedding削除
  const motionEmbeddingsDeleted = await prisma.motionEmbedding.deleteMany({});
  console.log(`   - MotionEmbedding: ${motionEmbeddingsDeleted.count} records deleted`);
  
  // SectionPattern削除
  const sectionPatternsDeleted = await prisma.sectionPattern.deleteMany({});
  console.log(`   - SectionPattern: ${sectionPatternsDeleted.count} records deleted`);
  
  // MotionPattern削除
  const motionPatternsDeleted = await prisma.motionPattern.deleteMany({});
  console.log(`   - MotionPattern: ${motionPatternsDeleted.count} records deleted`);
  
  // QualityEvaluation削除
  const qualityEvaluationsDeleted = await prisma.qualityEvaluation.deleteMany({});
  console.log(`   - QualityEvaluation: ${qualityEvaluationsDeleted.count} records deleted`);
  
  // JSAnimationPattern/Embedding削除（存在する場合）
  try {
    const jsAnimationEmbeddingsDeleted = await prisma.jSAnimationEmbedding.deleteMany({});
    console.log(`   - JSAnimationEmbedding: ${jsAnimationEmbeddingsDeleted.count} records deleted`);
    
    const jsAnimationPatternsDeleted = await prisma.jSAnimationPattern.deleteMany({});
    console.log(`   - JSAnimationPattern: ${jsAnimationPatternsDeleted.count} records deleted`);
  } catch (e) {
    console.log('   - JSAnimation tables not found or empty');
  }

  console.log('\n2. Getting unique WebPage URLs...');
  
  // URLの重複を除去（末尾スラッシュの有無で重複している可能性）
  const webPages = await prisma.webPage.findMany({
    select: {
      id: true,
      url: true,
    },
    orderBy: {
      createdAt: 'asc'
    }
  });
  
  // URLを正規化して重複を除去
  const normalizeUrl = (url: string) => url.replace(/\/$/, '');
  
  console.log(`   - Total WebPages: ${webPages.length}`);
  
  // 重複を削除
  const duplicateIds: string[] = [];
  const seenUrls = new Set<string>();
  
  for (const page of webPages) {
    const normalizedUrl = normalizeUrl(page.url);
    if (seenUrls.has(normalizedUrl)) {
      duplicateIds.push(page.id);
    } else {
      seenUrls.add(normalizedUrl);
    }
  }
  
  console.log(`   - Unique URLs: ${seenUrls.size}`);
  
  if (duplicateIds.length > 0) {
    console.log(`\n3. Removing ${duplicateIds.length} duplicate WebPages...`);
    const deletedDuplicates = await prisma.webPage.deleteMany({
      where: {
        id: { in: duplicateIds }
      }
    });
    console.log(`   - Deleted ${deletedDuplicates.count} duplicate WebPages`);
  }
  
  // 残りのWebPageのURLを出力
  const remainingPages = await prisma.webPage.findMany({
    select: {
      id: true,
      url: true,
    },
    orderBy: {
      createdAt: 'asc'
    }
  });
  
  console.log(`\n=== URLs to re-analyze (${remainingPages.length}) ===\n`);
  for (const page of remainingPages) {
    console.log(`${page.url}`);
  }
  
  console.log('\n=== Cleanup Complete ===');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
