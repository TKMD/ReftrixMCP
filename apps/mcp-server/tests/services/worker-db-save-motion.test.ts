// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker DB Save - Motion Pattern Tests
 *
 * Tests for saveMotionPatterns function:
 * - propertiesDetailed is used when available (from/to values preserved)
 * - Fallback to properties (string[]) when propertiesDetailed is absent
 * - Correct field mapping to DB
 *
 * @module tests/services/worker-db-save-motion
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveMotionPatterns,
  type MotionPatternPrismaClient,
  type MotionPatternInput,
} from '../../src/services/worker-db-save.service';

// Mock Prisma client
function createMockPrisma(
  overrides?: Partial<MotionPatternPrismaClient['motionPattern']>
): MotionPatternPrismaClient {
  const model = {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
    ...overrides,
  };
  return {
    motionPattern: model,
    $transaction: vi.fn().mockImplementation(
      (fn: (tx: Pick<MotionPatternPrismaClient, 'motionPattern'>) => Promise<unknown>) =>
        fn({ motionPattern: model })
    ),
  };
}

describe('saveMotionPatterns', () => {
  let mockPrisma: MotionPatternPrismaClient;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
  });

  it('should use propertiesDetailed with from/to values when available', async () => {
    const patterns: MotionPatternInput[] = [
      {
        name: 'fadeIn',
        type: 'css_animation',
        category: 'entrance',
        trigger: 'page_load',
        duration: 300,
        easing: 'ease-out',
        properties: ['opacity'],
        propertiesDetailed: [
          { property: 'opacity', from: '0', to: '1' },
        ],
      },
    ];

    const result = await saveMotionPatterns(
      mockPrisma,
      'web-page-id',
      patterns,
      'https://example.com'
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);

    // Verify createMany was called with propertiesDetailed values
    const createManyCall = vi.mocked(mockPrisma.motionPattern.createMany).mock.calls[0];
    expect(createManyCall).toBeDefined();
    const data = (createManyCall?.[0] as { data: Record<string, unknown>[] })?.data;
    expect(data).toHaveLength(1);

    const savedProperties = data?.[0]?.properties as Array<{ property: string; from: string; to: string }>;
    expect(savedProperties).toHaveLength(1);
    expect(savedProperties?.[0]?.property).toBe('opacity');
    expect(savedProperties?.[0]?.from).toBe('0');
    expect(savedProperties?.[0]?.to).toBe('1');
  });

  it('should fallback to empty from/to when propertiesDetailed is not available', async () => {
    const patterns: MotionPatternInput[] = [
      {
        name: 'fadeIn',
        type: 'css_animation',
        category: 'entrance',
        trigger: 'page_load',
        duration: 300,
        easing: 'ease-out',
        properties: ['opacity', 'transform'],
      },
    ];

    const result = await saveMotionPatterns(
      mockPrisma,
      'web-page-id',
      patterns,
      'https://example.com'
    );

    expect(result.success).toBe(true);

    const createManyCall = vi.mocked(mockPrisma.motionPattern.createMany).mock.calls[0];
    const data = (createManyCall?.[0] as { data: Record<string, unknown>[] })?.data;

    const savedProperties = data?.[0]?.properties as Array<{ property: string; from: string; to: string }>;
    expect(savedProperties).toHaveLength(2);
    expect(savedProperties?.[0]?.property).toBe('opacity');
    expect(savedProperties?.[0]?.from).toBe('');
    expect(savedProperties?.[0]?.to).toBe('');
    expect(savedProperties?.[1]?.property).toBe('transform');
    expect(savedProperties?.[1]?.from).toBe('');
    expect(savedProperties?.[1]?.to).toBe('');
  });

  it('should handle multiple properties with from/to values', async () => {
    const patterns: MotionPatternInput[] = [
      {
        name: 'slideUp',
        type: 'css_animation',
        category: 'entrance',
        trigger: 'page_load',
        duration: 500,
        easing: 'ease-in-out',
        properties: ['transform', 'opacity'],
        propertiesDetailed: [
          { property: 'transform', from: 'translateY(20px)', to: 'translateY(0)' },
          { property: 'opacity', from: '0', to: '1' },
        ],
      },
    ];

    const result = await saveMotionPatterns(
      mockPrisma,
      'web-page-id',
      patterns,
      'https://example.com'
    );

    expect(result.success).toBe(true);

    const createManyCall = vi.mocked(mockPrisma.motionPattern.createMany).mock.calls[0];
    const data = (createManyCall?.[0] as { data: Record<string, unknown>[] })?.data;

    const savedProperties = data?.[0]?.properties as Array<{ property: string; from: string; to: string }>;
    expect(savedProperties).toHaveLength(2);

    const transformProp = savedProperties?.find((p) => p.property === 'transform');
    expect(transformProp?.from).toBe('translateY(20px)');
    expect(transformProp?.to).toBe('translateY(0)');

    const opacityProp = savedProperties?.find((p) => p.property === 'opacity');
    expect(opacityProp?.from).toBe('0');
    expect(opacityProp?.to).toBe('1');
  });

  it('should return empty result for empty patterns array', async () => {
    const result = await saveMotionPatterns(
      mockPrisma,
      'web-page-id',
      [],
      'https://example.com'
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.ids).toEqual([]);
    expect(vi.mocked(mockPrisma.motionPattern.createMany)).not.toHaveBeenCalled();
  });

  it('should handle propertiesDetailed with partial from/to (only from)', async () => {
    const patterns: MotionPatternInput[] = [
      {
        name: 'partialAnim',
        type: 'css_animation',
        category: 'entrance',
        trigger: 'page_load',
        properties: ['background-color'],
        propertiesDetailed: [
          { property: 'background-color', from: 'red' },
        ],
      },
    ];

    const result = await saveMotionPatterns(
      mockPrisma,
      'web-page-id',
      patterns,
      'https://example.com'
    );

    expect(result.success).toBe(true);

    const createManyCall = vi.mocked(mockPrisma.motionPattern.createMany).mock.calls[0];
    const data = (createManyCall?.[0] as { data: Record<string, unknown>[] })?.data;

    const savedProperties = data?.[0]?.properties as Array<{ property: string; from: string; to: string }>;
    expect(savedProperties?.[0]?.property).toBe('background-color');
    expect(savedProperties?.[0]?.from).toBe('red');
    expect(savedProperties?.[0]?.to).toBe('');
  });
});
