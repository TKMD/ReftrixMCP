// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Project Context Management
 *
 * Provides utilities for resolving project_id with automatic fallback
 * to DEFAULT_PROJECT_ID environment variable.
 *
 * Priority Order:
 * 1. Explicit input (tool input.project_id)
 * 2. Environment variable (DEFAULT_PROJECT_ID)
 * 3. Undefined (original behavior)
 *
 * @module lib/project-context
 * @see docs/specs/project-id-auto-injection-spec.md
 */

/**
 * UUIDv7 validation regex pattern
 *
 * Format: xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
 * - Version 7 indicated by '7' at position 13
 * - Variant bits [89ab] at position 17
 */
const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates if a string is a valid UUIDv7 format
 *
 * @param id - String to validate
 * @returns true if valid UUIDv7 format, false otherwise
 *
 * @example
 * ```typescript
 * isValidUUIDv7('019acd22-c570-706c-8906-6c855874bc4d') // true
 * isValidUUIDv7('not-a-uuid') // false
 * isValidUUIDv7(null) // false
 * ```
 */
export const isValidUUIDv7 = (id: string | null | undefined): boolean => {
  if (!id || typeof id !== 'string') {
    return false;
  }
  return UUIDV7_PATTERN.test(id);
};

/**
 * Resolves project_id with automatic fallback to DEFAULT_PROJECT_ID
 *
 * Priority:
 * 1. If inputProjectId is provided and valid, use it
 * 2. If DEFAULT_PROJECT_ID env var is set and valid, use it
 * 3. Otherwise, return undefined
 *
 * @param inputProjectId - Explicit project_id from tool input
 * @returns Resolved project_id or undefined
 *
 * @example
 * ```typescript
 * // With explicit input
 * resolveProjectId('019acd22-c570-706c-8906-6c855874bc4d')
 * // Returns: '019acd22-c570-706c-8906-6c855874bc4d'
 *
 * // Without input, uses DEFAULT_PROJECT_ID from env
 * process.env.DEFAULT_PROJECT_ID = '019acd22-c570-706c-8906-6c855874bc4d'
 * resolveProjectId(undefined)
 * // Returns: '019acd22-c570-706c-8906-6c855874bc4d'
 *
 * // Neither input nor env set
 * delete process.env.DEFAULT_PROJECT_ID
 * resolveProjectId(undefined)
 * // Returns: undefined
 * ```
 */
export const resolveProjectId = (
  inputProjectId?: string
): string | undefined => {
  // Priority 1: Use explicit input if valid
  if (inputProjectId && isValidUUIDv7(inputProjectId)) {
    return inputProjectId;
  }

  // Handle empty string as undefined
  if (inputProjectId === '') {
    // Fall through to env var check
  } else if (inputProjectId) {
    // Input provided but invalid UUID format - still return it for backwards compatibility
    // The API layer will validate and reject if needed
    return inputProjectId;
  }

  // Priority 2: Use environment variable if valid
  const envProjectId = process.env.DEFAULT_PROJECT_ID;
  if (envProjectId && isValidUUIDv7(envProjectId)) {
    return envProjectId;
  }

  // Priority 3: Return undefined (original behavior)
  return undefined;
};

/**
 * Gets the DEFAULT_PROJECT_ID from environment
 * Useful for debugging and logging
 *
 * @returns DEFAULT_PROJECT_ID value or undefined
 */
export const getDefaultProjectId = (): string | undefined => {
  return process.env.DEFAULT_PROJECT_ID;
};
