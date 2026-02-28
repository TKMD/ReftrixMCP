// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Database Utilities
 *
 * Re-exports utility functions for RLS and admin operations.
 */

export {
  withRlsContext,
  withRlsBypass,
  isRlsProtectedModel,
  RLS_PROTECTED_MODELS,
  type RlsProtectedModel,
} from "./rls-transaction";

export {
  withAdminBypass,
  isAdminConnectionAvailable,
  getAdminPrismaClient,
} from "./admin-operation";
