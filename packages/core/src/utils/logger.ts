// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Logger utility for Reftrix Packages
 *
 * Provides environment-aware logging:
 * - Development: All logs are output to console
 * - Production: Only errors are output
 *
 * @see CONTRIBUTING.md
 */

const isDev = process.env.NODE_ENV === 'development';
const isTest = process.env.NODE_ENV === 'test';

/**
 * Logger instance with environment-aware methods
 */
export const logger = {
  /**
   * Info level logging - Development only
   */
  info: (...args: unknown[]): void => {
    if (isDev) {
      // eslint-disable-next-line no-console -- Logger utility intentionally uses console
      console.log('[INFO]', ...args);
    }
  },

  /**
   * Warning level logging - Development only
   */
  warn: (...args: unknown[]): void => {
    if (isDev) {
      console.warn('[WARN]', ...args);
    }
  },

  /**
   * Error level logging - All environments (except test)
   */
  error: (...args: unknown[]): void => {
    if (!isTest) {
      console.error('[ERROR]', ...args);
    }
  },

  /**
   * Debug level logging - Development only
   */
  debug: (...args: unknown[]): void => {
    if (isDev) {
      // eslint-disable-next-line no-console -- Logger utility intentionally uses console
      console.log('[DEBUG]', ...args);
    }
  },
};
