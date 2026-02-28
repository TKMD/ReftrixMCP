// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RLS Transaction Utilities
 *
 * Provides transaction wrappers that properly set RLS context.
 *
 * Reference: docs/plans/rls-implementation-plan.md
 * SEC-RLS-004: Fail-close behavior guaranteed
 */

import type { PrismaClient, Prisma } from "@prisma/client";

/**
 * RLS-protected table models
 * These models require user context to be set before access
 */
export const RLS_PROTECTED_MODELS = [
  // Tier 1: Direct user ownership
  "Project",
  // Tier 2: Indirect ownership (via Project)
  "ProjectBrandSetting",
  // [DELETED Phase 1] Removed: Account, Session, ProjectPage, ProjectBrief,
  //   ProjectLayoutVersion, ProjectLayoutScore, ProjectCodeExport
  // [DELETED OSS] Removed: ApiKey, User
] as const;

export type RlsProtectedModel = (typeof RLS_PROTECTED_MODELS)[number];

/**
 * Check if a model is RLS-protected
 */
export function isRlsProtectedModel(
  model: string | undefined
): model is RlsProtectedModel {
  return model
    ? RLS_PROTECTED_MODELS.includes(model as RlsProtectedModel)
    : false;
}

/**
 * Execute operations within RLS context
 *
 * This function wraps database operations in a transaction and sets
 * the current user ID in the session context. This ensures RLS policies
 * are properly enforced.
 *
 * **Fail-Close Behavior (SEC-RLS-004):**
 * - If userId is null, undefined, or empty string, the context is still set
 * - get_current_user_id() will return NULL in these cases
 * - RLS policies will reject all rows (fail-close, NOT fail-open)
 *
 * @param prisma - Prisma client instance
 * @param userId - User ID to set in context (null/undefined/empty = fail-close)
 * @param fn - Function to execute within the RLS context
 * @returns Result of the function execution
 *
 * @example
 * ```typescript
 * const projects = await withRlsContext(prisma, userId, async (tx) => {
 *   return tx.project.findMany();
 * });
 * ```
 */
export async function withRlsContext<T>(
  prisma: PrismaClient,
  userId: string | null | undefined,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Escape single quotes in userId to prevent SQL injection
    // If userId is null/undefined/empty, set empty string
    // This triggers fail-close: get_current_user_id() returns NULL
    // and RLS policies reject all rows
    const safeUserId = userId?.replace(/'/g, "''") ?? "";

    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_user_id = '${safeUserId}'`
    );

    // Log in development for debugging
    if (process.env.NODE_ENV === "development") {
      console.log(
        `[RLS] Context set: user_id=${safeUserId || "(empty - fail-close)"}`
      );
    }

    return fn(tx);
  });
}

/**
 * @deprecated Use withAdminBypass() from admin-operation.ts instead.
 *
 * This function is deprecated because session variable bypass is not secure.
 * SEC-RLS-001 requires using dedicated database roles (reftrix_admin) instead.
 *
 * @see packages/database/src/utils/admin-operation.ts
 * @see docs/plans/rls-implementation-plan.md section 4.11
 */
export async function withRlsBypass<T>(
  _prisma: PrismaClient,
  _fn: (tx: Prisma.TransactionClient) => Promise<T>,
  _reason: string
): Promise<T> {
  throw new Error(
    "[SEC-RLS-001] withRlsBypass is deprecated. Use withAdminBypass() with prismaAdmin instead. " +
      "See docs/plans/rls-implementation-plan.md section 4.11"
  );
}
