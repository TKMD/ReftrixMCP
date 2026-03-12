// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Worker Integration Tests (Phase 1.1)
 *
 * page-analyze-worker.ts 内の Phase 1.1 パーツ抽出統合ロジックをテスト。
 * Tests Phase 1.1 part extraction integration logic within page-analyze-worker.ts.
 *
 * テスト対象:
 * - Phase 1.1 runs when layout has sections with DB IDs
 * - Phase 1.1 skips when extractParts (partExtractionOptions.enabled) is false
 * - Phase 1.1 skips on RSS memory limit exceeded
 * - Phase 1.1 timeout after 30s continues pipeline
 * - Phase 1.1 error does not block subsequent phases
 *
 * @module tests/services/part/part-worker-integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the part extraction service
vi.mock('../../../src/services/part/part-extraction.service', () => ({
  extractPartsFromSection: vi.fn(),
}));

// Mock the part DB service
vi.mock('../../../src/services/part/part-db.service', () => ({
  saveExtractedParts: vi.fn(),
}));

import { extractPartsFromSection } from '../../../src/services/part/part-extraction.service';
import { saveExtractedParts } from '../../../src/services/part/part-db.service';
import { DEFAULT_PART_EXTRACTION_CONFIG, type PartExtractionConfig, type PartExtractionResult } from '../../../src/services/part/types';
import type { PartSaveResult } from '../../../src/services/part/part-db.service';

// ============================================================================
// Test helpers: simulate Phase 1.1 logic extracted from page-analyze-worker.ts
// ============================================================================

/**
 * Simulate Phase 1.1 part extraction logic (extracted from worker for unit testing)
 *
 * This function mirrors the Phase 1.1 block in page-analyze-worker.ts
 * without requiring BullMQ job infrastructure.
 */
async function executePhase1_1(params: {
  options: {
    partExtractionOptions?: {
      enabled?: boolean;
      rssLimitBytes?: number;
      timeoutMs?: number;
    };
  };
  completedPhases: string[];
  layoutSections: Array<{
    id: string;
    type: string;
    positionIndex: number;
    confidence: number;
    htmlSnippet?: string;
    position?: { startY: number; endY: number; height: number };
  }> | null;
  sectionIdMapping: Map<string, string> | null;
  actualWebPageId: string;
  url: string;
  screenshotBase64?: string;
  mockRssBytes?: number;
  prisma: unknown;
}): Promise<{
  skipped: boolean;
  skipReason?: string;
  result?: {
    sectionsProcessed: number;
    totalPartsExtracted: number;
    totalPartsSaved: number;
    durationMs: number;
  };
  error?: string;
}> {
  const {
    options,
    completedPhases,
    layoutSections,
    sectionIdMapping,
    actualWebPageId,
    url,
    screenshotBase64,
    mockRssBytes,
    prisma,
  } = params;

  // Check if part extraction is enabled
  const partExtractionEnabled =
    options.partExtractionOptions?.enabled !== false &&
    completedPhases.includes('layout') &&
    layoutSections &&
    Array.isArray(layoutSections) &&
    layoutSections.length > 0 &&
    sectionIdMapping &&
    sectionIdMapping.size > 0;

  if (!partExtractionEnabled) {
    return { skipped: true, skipReason: 'disabled_or_no_sections' };
  }

  const partExtractionStartTime = Date.now();

  // RSS Memory Guard [C-1]
  const rssLimitBytes = options.partExtractionOptions?.rssLimitBytes
    ?? DEFAULT_PART_EXTRACTION_CONFIG.rssLimitBytes;
  const currentRss = mockRssBytes ?? process.memoryUsage().rss;

  if (currentRss > rssLimitBytes) {
    return { skipped: true, skipReason: 'rss_exceeded' };
  }

  // Build part extraction config
  const partConfig: PartExtractionConfig = {
    ...DEFAULT_PART_EXTRACTION_CONFIG,
    ...(options.partExtractionOptions?.timeoutMs !== undefined
      ? { timeoutMs: options.partExtractionOptions.timeoutMs }
      : {}),
    ...(options.partExtractionOptions?.rssLimitBytes !== undefined
      ? { rssLimitBytes: options.partExtractionOptions.rssLimitBytes }
      : {}),
  };

  const partTimeoutMs = partConfig.timeoutMs;

  try {
    const partExtractionResult = await Promise.race([
      (async (): Promise<{
        sectionsProcessed: number;
        totalPartsExtracted: number;
        totalPartsSaved: number;
      }> => {
        let sectionsProcessed = 0;
        let totalPartsExtracted = 0;
        let totalPartsSaved = 0;

        let screenshotBuffer: Buffer | undefined;
        if (screenshotBase64) {
          try {
            screenshotBuffer = Buffer.from(screenshotBase64, 'base64');
          } catch {
            // ignore
          }
        }

        for (let i = 0; i < layoutSections!.length; i++) {
          const section = layoutSections![i];
          const sectionPatternId = sectionIdMapping!.get(section.id);
          if (!sectionPatternId) continue;

          const sectionHtml = section.htmlSnippet ?? '';
          if (!sectionHtml) continue;

          try {
            const extractionResult = await (extractPartsFromSection as ReturnType<typeof vi.fn>)({
              sectionHtml,
              sectionIndex: i,
              config: partConfig,
              computedStylesMap: new Map(),
              sectionBoundingBox: {
                x: 0,
                y: section.position?.startY ?? 0,
                width: 1280,
                height: section.position?.height ?? 0,
              },
              fullScreenshot: screenshotBuffer,
              sourceUrl: url,
            });

            if (extractionResult.parts.length > 0) {
              const saveResult: PartSaveResult = await (saveExtractedParts as ReturnType<typeof vi.fn>)(
                prisma,
                actualWebPageId,
                sectionPatternId,
                extractionResult.parts,
                url,
              );
              totalPartsSaved += saveResult.savedCount;
            }

            totalPartsExtracted += extractionResult.parts.length;
            sectionsProcessed++;
          } catch {
            // Per-section error: continue
          }
        }

        return { sectionsProcessed, totalPartsExtracted, totalPartsSaved };
      })(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error(`Part extraction timeout after ${partTimeoutMs}ms`)),
          partTimeoutMs,
        );
      }),
    ]);

    const partDurationMs = Date.now() - partExtractionStartTime;
    return {
      skipped: false,
      result: {
        ...partExtractionResult,
        durationMs: partDurationMs,
      },
    };
  } catch (partError) {
    return {
      skipped: false,
      error: partError instanceof Error ? partError.message : String(partError),
    };
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Phase 1.1: Part Extraction Worker Integration', () => {
  const mockPrisma = {} as unknown;

  const mockSections = [
    {
      id: 'section-1',
      type: 'hero',
      positionIndex: 0,
      confidence: 0.95,
      htmlSnippet: '<section class="hero"><h1>Title</h1><button>CTA</button></section>',
      position: { startY: 0, endY: 800, height: 800 },
    },
    {
      id: 'section-2',
      type: 'features',
      positionIndex: 1,
      confidence: 0.88,
      htmlSnippet: '<section class="features"><div class="card">Feature</div></section>',
      position: { startY: 800, endY: 1600, height: 800 },
    },
  ];

  const mockIdMapping = new Map([
    ['section-1', 'db-uuid-1'],
    ['section-2', 'db-uuid-2'],
  ]);

  const mockExtractionResult: PartExtractionResult = {
    parts: [
      {
        partType: 'button',
        partSubtype: null,
        htmlSnippet: '<button>CTA</button>',
        computedStyles: {},
        boundingBox: { x: 100, y: 200, width: 150, height: 40 },
        cssClasses: ['cta'],
        attributes: {},
        interactionInfo: { hasHover: true, hasFocus: true, hasActive: true, hasTransition: false },
        visualSignature: 'abc123',
        sampleIndex: 0,
        piiRiskLevel: 'none',
        tags: ['button', 'cta'],
        metadata: {},
        sourceUrl: 'https://example.com',
        usageScope: 'inspiration_only',
        cropBuffer: null,
      },
    ],
    skippedCount: 0,
    durationMs: 50,
  };

  const mockSaveResult: PartSaveResult = {
    savedCount: 1,
    skippedDuplicates: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (extractPartsFromSection as ReturnType<typeof vi.fn>).mockResolvedValue(mockExtractionResult);
    (saveExtractedParts as ReturnType<typeof vi.fn>).mockResolvedValue(mockSaveResult);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Test 1: Phase 1.1 runs when layout has sections with DB IDs
  // -----------------------------------------------------------------------
  it('should extract and save parts when layout has sections with DB IDs', async () => {
    const result = await executePhase1_1({
      options: {},
      completedPhases: ['ingest', 'layout'],
      layoutSections: mockSections,
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    expect(result.result!.sectionsProcessed).toBe(2);
    expect(result.result!.totalPartsExtracted).toBe(2); // 1 part per section x 2 sections
    expect(result.result!.totalPartsSaved).toBe(2); // 1 saved per section x 2 sections
    expect(result.result!.durationMs).toBeGreaterThanOrEqual(0);

    // Verify extractPartsFromSection was called for each section
    expect(extractPartsFromSection).toHaveBeenCalledTimes(2);
    expect(saveExtractedParts).toHaveBeenCalledTimes(2);

    // Verify saveExtractedParts called with correct sectionPatternId from idMapping
    expect(saveExtractedParts).toHaveBeenCalledWith(
      mockPrisma,
      'web-page-uuid-1',
      'db-uuid-1',
      mockExtractionResult.parts,
      'https://example.com',
    );
    expect(saveExtractedParts).toHaveBeenCalledWith(
      mockPrisma,
      'web-page-uuid-1',
      'db-uuid-2',
      mockExtractionResult.parts,
      'https://example.com',
    );
  });

  // -----------------------------------------------------------------------
  // Test 2: Phase 1.1 skips when enabled=false
  // -----------------------------------------------------------------------
  it('should skip when partExtractionOptions.enabled is false', async () => {
    const result = await executePhase1_1({
      options: {
        partExtractionOptions: { enabled: false },
      },
      completedPhases: ['ingest', 'layout'],
      layoutSections: mockSections,
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('disabled_or_no_sections');
    expect(extractPartsFromSection).not.toHaveBeenCalled();
    expect(saveExtractedParts).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 3: Phase 1.1 skips when layout phase did not complete
  // -----------------------------------------------------------------------
  it('should skip when layout phase did not complete', async () => {
    const result = await executePhase1_1({
      options: {},
      completedPhases: ['ingest'], // no 'layout'
      layoutSections: mockSections,
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('disabled_or_no_sections');
    expect(extractPartsFromSection).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 4: Phase 1.1 skips when no sections in layout result
  // -----------------------------------------------------------------------
  it('should skip when layout result has no sections', async () => {
    const result = await executePhase1_1({
      options: {},
      completedPhases: ['ingest', 'layout'],
      layoutSections: [],
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('disabled_or_no_sections');
  });

  // -----------------------------------------------------------------------
  // Test 5: Phase 1.1 skips when no section ID mapping
  // -----------------------------------------------------------------------
  it('should skip when sectionIdMapping is empty', async () => {
    const result = await executePhase1_1({
      options: {},
      completedPhases: ['ingest', 'layout'],
      layoutSections: mockSections,
      sectionIdMapping: new Map(),
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('disabled_or_no_sections');
  });

  // -----------------------------------------------------------------------
  // Test 6: Phase 1.1 skips on RSS memory limit exceeded
  // -----------------------------------------------------------------------
  it('should skip when RSS exceeds limit', async () => {
    const result = await executePhase1_1({
      options: {
        partExtractionOptions: {
          rssLimitBytes: 1024, // very low limit
        },
      },
      completedPhases: ['ingest', 'layout'],
      layoutSections: mockSections,
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      mockRssBytes: 2048, // exceeds 1024 limit
      prisma: mockPrisma,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('rss_exceeded');
    expect(extractPartsFromSection).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 7: Phase 1.1 timeout continues pipeline (graceful degradation)
  // -----------------------------------------------------------------------
  it('should return error on timeout and not throw', async () => {
    // Mock extractPartsFromSection to take longer than timeout
    (extractPartsFromSection as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(mockExtractionResult), 5000))
    );

    const result = await executePhase1_1({
      options: {
        partExtractionOptions: {
          timeoutMs: 100, // 100ms timeout
        },
      },
      completedPhases: ['ingest', 'layout'],
      layoutSections: mockSections,
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    expect(result.skipped).toBe(false);
    expect(result.error).toContain('Part extraction timeout');
    expect(result.result).toBeUndefined();
  }, 10000);

  // -----------------------------------------------------------------------
  // Test 8: Phase 1.1 extraction error does not throw (graceful degradation)
  // -----------------------------------------------------------------------
  it('should handle extraction service errors gracefully', async () => {
    (extractPartsFromSection as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('JSDOM parsing failed')
    );

    const result = await executePhase1_1({
      options: {},
      completedPhases: ['ingest', 'layout'],
      layoutSections: mockSections,
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    // Per-section errors are caught, so the extraction completes with 0 parts
    expect(result.skipped).toBe(false);
    expect(result.result).toBeDefined();
    expect(result.result!.sectionsProcessed).toBe(0);
    expect(result.result!.totalPartsExtracted).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 9: Phase 1.1 saveExtractedParts error does not throw
  // -----------------------------------------------------------------------
  it('should handle save errors gracefully (per-section catch)', async () => {
    (saveExtractedParts as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database connection failed')
    );

    const result = await executePhase1_1({
      options: {},
      completedPhases: ['ingest', 'layout'],
      layoutSections: mockSections,
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    // Per-section errors caught; sections increment extractedParts count
    // but save fails so savedCount stays 0
    expect(result.skipped).toBe(false);
    expect(result.result).toBeDefined();
    expect(result.result!.sectionsProcessed).toBe(0); // both sections failed
    expect(result.result!.totalPartsSaved).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 10: Sections without htmlSnippet are skipped
  // -----------------------------------------------------------------------
  it('should skip sections without htmlSnippet', async () => {
    const sectionsWithoutHtml = [
      { id: 'section-1', type: 'hero', positionIndex: 0, confidence: 0.95 },
      { id: 'section-2', type: 'features', positionIndex: 1, confidence: 0.88, htmlSnippet: '' },
    ];

    const result = await executePhase1_1({
      options: {},
      completedPhases: ['ingest', 'layout'],
      layoutSections: sectionsWithoutHtml,
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    expect(result.skipped).toBe(false);
    expect(result.result!.sectionsProcessed).toBe(0);
    expect(extractPartsFromSection).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 11: Sections without matching ID in idMapping are skipped
  // -----------------------------------------------------------------------
  it('should skip sections without matching sectionPatternId', async () => {
    const unmatchedIdMapping = new Map([
      ['section-999', 'db-uuid-999'], // no match for section-1 or section-2
    ]);

    const result = await executePhase1_1({
      options: {},
      completedPhases: ['ingest', 'layout'],
      layoutSections: mockSections,
      sectionIdMapping: unmatchedIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    // idMapping.size > 0 so it enters the block, but no sections match
    expect(result.skipped).toBe(false);
    expect(result.result!.sectionsProcessed).toBe(0);
    expect(extractPartsFromSection).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 12: Empty extraction result (0 parts) does not call save
  // -----------------------------------------------------------------------
  it('should not call saveExtractedParts when extraction yields 0 parts', async () => {
    const emptyResult: PartExtractionResult = {
      parts: [],
      skippedCount: 0,
      durationMs: 10,
    };
    (extractPartsFromSection as ReturnType<typeof vi.fn>).mockResolvedValue(emptyResult);

    const result = await executePhase1_1({
      options: {},
      completedPhases: ['ingest', 'layout'],
      layoutSections: mockSections,
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    expect(result.skipped).toBe(false);
    expect(result.result!.sectionsProcessed).toBe(2);
    expect(result.result!.totalPartsExtracted).toBe(0);
    expect(saveExtractedParts).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 13: Default config values are applied correctly
  // -----------------------------------------------------------------------
  it('should use default config when no options provided', async () => {
    await executePhase1_1({
      options: {},
      completedPhases: ['ingest', 'layout'],
      layoutSections: mockSections,
      sectionIdMapping: mockIdMapping,
      actualWebPageId: 'web-page-uuid-1',
      url: 'https://example.com',
      prisma: mockPrisma,
    });

    // Verify the config passed to extractPartsFromSection uses defaults
    const callArgs = (extractPartsFromSection as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.config.maxPartsPerType).toBe(DEFAULT_PART_EXTRACTION_CONFIG.maxPartsPerType);
    expect(callArgs.config.minPartSize).toBe(DEFAULT_PART_EXTRACTION_CONFIG.minPartSize);
    expect(callArgs.config.cropSize).toBe(DEFAULT_PART_EXTRACTION_CONFIG.cropSize);
    expect(callArgs.config.timeoutMs).toBe(DEFAULT_PART_EXTRACTION_CONFIG.timeoutMs);
  });
});
