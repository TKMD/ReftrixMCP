// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reftrix Database Seed Script
 * Seeds initial brand palettes data (WebDesign-only)
 *
 * [OSS] User seed removed - User table deleted
 */

import { PrismaClient } from "@prisma/client";
import { seedPalettes } from "./seed/palette-seed";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log("[Seed] Starting database seed...");
  console.log("=".repeat(60));

  try {
    await seedPalettes(prisma);

    console.log("=".repeat(60));
    console.log("[Seed] Database seeding completed successfully!");
  } catch (error) {
    console.error("[Seed] Error during seeding:", error);
    throw error;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
