// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prisma client singleton for Reftrix
 */

import { PrismaClient as _RuntimePrismaClient } from "./generated/prisma";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  hnswIterativeScanInitialized: boolean | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  (new _RuntimePrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  }) as unknown as PrismaClient);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Enable pgvector 0.8 HNSW iterative scan on the current session.
 * pgvector 0.8 HNSW iterative scan を現在のセッションで有効化。
 *
 * This is a safety net for environments where shared_preload_libraries
 * or ALTER DATABASE SET are not configured (e.g., external PostgreSQL).
 * Docker environments get this via ALTER DATABASE SET in migration.
 *
 * Call once at application startup. Idempotent — safe to call multiple times.
 */
export async function enableHnswIterativeScan(client: PrismaClient = prisma): Promise<void> {
  if (globalForPrisma.hnswIterativeScanInitialized) return;
  try {
    await client.$executeRawUnsafe("LOAD 'vector'");
    await client.$executeRawUnsafe("SET hnsw.iterative_scan = 'relaxed_order'");
    globalForPrisma.hnswIterativeScanInitialized = true;
  } catch (error) {
    // Graceful degradation: search works without iterative scan (standard HNSW behavior).
    // pgvector LOADが失敗してもHNSW検索は通常動作する（iterative scanなし）。
    console.warn(
      "[database] HNSW iterative scan not available:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

// Re-export Prisma types
export type { PrismaClient };
export { Prisma };
