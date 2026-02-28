// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Operation Utilities
 *
 * Provides functions for executing admin operations that bypass RLS.
 * All admin operations are logged for audit purposes.
 *
 * Reference: docs/plans/rls-implementation-plan.md Section 4.11
 * SEC-RLS-001: Uses dedicated database role (reftrix_admin) instead of session variables
 */

import { PrismaClient } from "@prisma/client";

/**
 * Admin Prisma Client (RLS Bypass)
 *
 * This client connects using the reftrix_admin role which has BYPASSRLS privilege.
 * Use sparingly and always with withAdminBypass() for proper audit logging.
 *
 * Environment variable: ADMIN_DATABASE_URL
 * Expected format: postgresql://reftrix_admin:password@localhost:26432/reftrix
 */
const globalForPrismaAdmin = globalThis as unknown as {
  prismaAdmin: PrismaClient | undefined;
};

/**
 * Get or create admin Prisma client
 *
 * Note: Returns null if ADMIN_DATABASE_URL is not configured.
 * This is intentional - admin operations should fail if not properly configured.
 */
function getAdminClient(): PrismaClient | null {
  const adminUrl = process.env.ADMIN_DATABASE_URL;

  if (!adminUrl) {
    console.warn(
      "[ADMIN] ADMIN_DATABASE_URL not configured. Admin operations will fail."
    );
    return null;
  }

  if (!globalForPrismaAdmin.prismaAdmin) {
    globalForPrismaAdmin.prismaAdmin = new PrismaClient({
      datasources: {
        db: { url: adminUrl },
      },
      log:
        process.env.NODE_ENV === "development"
          ? ["query", "error", "warn"]
          : ["error"],
    });
  }

  return globalForPrismaAdmin.prismaAdmin;
}

/**
 * Audit log entry for admin operations
 */
interface AdminAuditEntry {
  operation: string;
  reason: string;
  durationMs: number;
  status: "success" | "error";
  error?: string;
  timestamp: string;
}

/**
 * Log admin operation to console and optionally to database
 *
 * In production, consider sending to external logging service
 */
async function logAdminOperation(
  prismaAdmin: PrismaClient,
  entry: AdminAuditEntry
): Promise<void> {
  // Always log to console with warning level
  const logFn = entry.status === "error" ? console.error : console.warn;
  logFn("[ADMIN_BYPASS]", JSON.stringify(entry));

  // Attempt to log to database audit_logs table
  // This may fail if the table doesn't exist yet, so we catch errors
  try {
    // Note: audit_logs table may use different column naming conventions
    // Adjust the raw query based on actual schema
    await prismaAdmin.$executeRaw`
      INSERT INTO audit_logs (id, action, entity_type, metadata, created_at)
      VALUES (
        gen_random_uuid(),
        ${entry.status === "error" ? "ADMIN_BYPASS_FAILED" : "ADMIN_BYPASS"},
        'system',
        ${JSON.stringify({
          operation: entry.operation,
          reason: entry.reason,
          durationMs: entry.durationMs,
          error: entry.error,
        })}::jsonb,
        NOW()
      )
    `;
  } catch (dbError) {
    // Database logging failed, but console logging succeeded
    // This is acceptable during development/migration
    if (process.env.NODE_ENV === "development") {
      console.warn("[ADMIN] Failed to write audit log to database:", dbError);
    }
  }
}

/**
 * Execute an admin operation that bypasses RLS
 *
 * This function uses the reftrix_admin database role which has BYPASSRLS privilege.
 * All operations are logged for audit purposes.
 *
 * **Security Requirements (SEC-RLS-001):**
 * - Use only when absolutely necessary (migrations, data fixes, etc.)
 * - Always provide a clear reason for the bypass
 * - Operations are logged to console and audit_logs table
 *
 * @param operation - Short description of the operation (e.g., "migrate_user_data")
 * @param reason - Detailed reason why RLS bypass is needed
 * @param fn - Function to execute with admin privileges
 * @returns Result of the function execution
 * @throws Error if ADMIN_DATABASE_URL is not configured
 *
 * @example
 * ```typescript
 * const allProjects = await withAdminBypass(
 *   "list_all_projects",
 *   "Admin dashboard overview requires cross-user data",
 *   async (prismaAdmin) => {
 *     return prismaAdmin.project.findMany();
 *   }
 * );
 * ```
 */
export async function withAdminBypass<T>(
  operation: string,
  reason: string,
  fn: (prismaAdmin: PrismaClient) => Promise<T>
): Promise<T> {
  const prismaAdmin = getAdminClient();

  if (!prismaAdmin) {
    throw new Error(
      "[SEC-RLS-001] ADMIN_DATABASE_URL is not configured. " +
        "Admin operations require a dedicated admin database connection. " +
        "See docs/plans/rls-implementation-plan.md section 4.11"
    );
  }

  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  // Log operation start
  console.warn("[ADMIN_BYPASS] Operation started", {
    operation,
    reason,
    timestamp,
  });

  try {
    const result = await fn(prismaAdmin);

    // Log successful operation
    await logAdminOperation(prismaAdmin, {
      operation,
      reason,
      durationMs: Date.now() - startTime,
      status: "success",
      timestamp,
    });

    return result;
  } catch (error) {
    // Log failed operation
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    await logAdminOperation(prismaAdmin, {
      operation,
      reason,
      durationMs: Date.now() - startTime,
      status: "error",
      error: errorMessage,
      timestamp,
    });

    throw error;
  }
}

/**
 * Check if admin database connection is available
 *
 * Useful for conditional admin features or graceful degradation
 */
export function isAdminConnectionAvailable(): boolean {
  return !!process.env.ADMIN_DATABASE_URL;
}

/**
 * Get admin Prisma client directly (use with caution)
 *
 * Prefer withAdminBypass() for proper audit logging.
 * Only use this for specific cases like migrations where
 * the audit infrastructure may not be available.
 *
 * @throws Error if ADMIN_DATABASE_URL is not configured
 */
export function getAdminPrismaClient(): PrismaClient {
  const client = getAdminClient();

  if (!client) {
    throw new Error(
      "[SEC-RLS-001] ADMIN_DATABASE_URL is not configured. " +
        "See docs/plans/rls-implementation-plan.md section 4.11"
    );
  }

  return client;
}
