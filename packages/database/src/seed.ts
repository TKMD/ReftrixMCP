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
  // eslint-disable-next-line no-console -- CLI seed script: stdout is intentional
  console.log("[Seed] Starting database seed...");
  // eslint-disable-next-line no-console -- CLI seed script: stdout is intentional
  console.log("=".repeat(60));

  try {
    await seedPalettes(prisma);

    // eslint-disable-next-line no-console -- CLI seed script: stdout is intentional
    console.log("=".repeat(60));
    // eslint-disable-next-line no-console -- CLI seed script: stdout is intentional
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
