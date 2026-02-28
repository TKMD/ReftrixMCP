// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Project Context Tests
 *
 * TDD Red Phase: Phase1-S3
 * Tests for resolveProjectId function
 *
 * Priority order:
 * 1. Tool input (input.project_id)
 * 2. Environment variable (DEFAULT_PROJECT_ID)
 * 3. Undefined (fallback to original behavior)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import from relative path (TDD Green)
import {
  resolveProjectId,
  isValidUUIDv7,
} from '../../src/lib/project-context';

describe('project-context', () => {
  const VALID_UUID = '019acd22-c570-706c-8906-6c855874bc4d';
  const ANOTHER_UUID = '019acd22-c570-706c-8906-6c855874bc4e';
  const INVALID_UUID = 'not-a-uuid';

  describe('resolveProjectId', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv };
      delete process.env.DEFAULT_PROJECT_ID;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return input project_id when provided', () => {
      const result = resolveProjectId(VALID_UUID);
      expect(result).toBe(VALID_UUID);
    });

    it('should return DEFAULT_PROJECT_ID when input is undefined', () => {
      process.env.DEFAULT_PROJECT_ID = VALID_UUID;
      const result = resolveProjectId(undefined);
      expect(result).toBe(VALID_UUID);
    });

    it('should return undefined when both input and env are not set', () => {
      delete process.env.DEFAULT_PROJECT_ID;
      const result = resolveProjectId(undefined);
      expect(result).toBeUndefined();
    });

    it('should prefer input over environment variable', () => {
      process.env.DEFAULT_PROJECT_ID = ANOTHER_UUID;
      const result = resolveProjectId(VALID_UUID);
      expect(result).toBe(VALID_UUID);
    });

    it('should ignore invalid UUID format in environment variable', () => {
      process.env.DEFAULT_PROJECT_ID = INVALID_UUID;
      const result = resolveProjectId(undefined);
      expect(result).toBeUndefined();
    });

    it('should handle empty string input as undefined', () => {
      process.env.DEFAULT_PROJECT_ID = VALID_UUID;
      const result = resolveProjectId('');
      expect(result).toBe(VALID_UUID);
    });

    it('should validate and return valid UUID from input even if env has invalid', () => {
      process.env.DEFAULT_PROJECT_ID = INVALID_UUID;
      const result = resolveProjectId(VALID_UUID);
      expect(result).toBe(VALID_UUID);
    });
  });

  describe('isValidUUIDv7', () => {
    it('should return true for valid UUIDv7', () => {
      expect(isValidUUIDv7(VALID_UUID)).toBe(true);
    });

    it('should return false for invalid UUID', () => {
      expect(isValidUUIDv7(INVALID_UUID)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidUUIDv7('')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isValidUUIDv7(null as unknown as string)).toBe(false);
      expect(isValidUUIDv7(undefined as unknown as string)).toBe(false);
    });

    it('should return false for UUIDv4 (version 4)', () => {
      // UUIDv4 has '4' in version position
      const uuidV4 = '550e8400-e29b-41d4-a716-446655440000';
      expect(isValidUUIDv7(uuidV4)).toBe(false);
    });

    it('should return true for valid UUIDv7 format (version 7)', () => {
      // UUIDv7 has '7' in version position (13th character)
      // Format: xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
      const validUUIDv7 = '019acd22-c570-7abc-9906-6c855874bc4d';
      expect(isValidUUIDv7(validUUIDv7)).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should support layout.search use case: no project_id input with DEFAULT_PROJECT_ID', () => {
      // Scenario: User calls layout.search without project_id
      // Expected: Use DEFAULT_PROJECT_ID from environment
      process.env.DEFAULT_PROJECT_ID = VALID_UUID;

      const mockToolInput = { query: 'hero section', limit: 10 };
      const resolvedProjectId = resolveProjectId(mockToolInput.project_id);

      expect(resolvedProjectId).toBe(VALID_UUID);
    });

    it('should support layout.search use case: explicit project_id overrides default', () => {
      // Scenario: User explicitly specifies project_id
      // Expected: Use the explicit value, not DEFAULT_PROJECT_ID
      process.env.DEFAULT_PROJECT_ID = ANOTHER_UUID;

      const mockToolInput = { query: 'hero section', limit: 10, project_id: VALID_UUID };
      const resolvedProjectId = resolveProjectId(mockToolInput.project_id);

      expect(resolvedProjectId).toBe(VALID_UUID);
    });

    it('should support style.get_palette use case: palette_id with project context', () => {
      // Scenario: style.get_palette needs project context for palette retrieval
      process.env.DEFAULT_PROJECT_ID = VALID_UUID;

      const mockStyleInput = { palette_id: 'some-palette-id' };
      const resolvedProjectId = resolveProjectId(mockStyleInput.project_id);

      expect(resolvedProjectId).toBe(VALID_UUID);
    });

    it('should handle graceful fallback when no project context available', () => {
      // Scenario: Neither input nor env has project_id
      // Expected: Return undefined, tool should handle this gracefully
      delete process.env.DEFAULT_PROJECT_ID;

      const mockToolInput = { query: 'icon' };
      const resolvedProjectId = resolveProjectId(mockToolInput.project_id);

      expect(resolvedProjectId).toBeUndefined();
    });
  });
});
