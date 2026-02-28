// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisionFallbackService - TDD Tests
 *
 * Vision CPU完走保証 Phase 3: Graceful Degradation強化
 *
 * 3つのフォールバック戦略をテスト:
 * 1. Vision timeout → HTML analysis only
 * 2. Vision failure (e.g., Ollama not running) → HTML analysis only
 * 3. No image → HTML analysis only (no warning)
 *
 * @see apps/mcp-server/src/services/vision/vision-fallback.service.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VisionFallbackService, type FallbackResult, type VisionFallbackOptions } from '../../../src/services/vision/vision-fallback.service.js';
import type { VisionAnalysisResult } from '../../../src/services/vision/llama-vision-adapter.js';
import type { DetectedSection } from '@reftrix/webdesign-core';

// =============================================================================
// Mock Types
// =============================================================================

interface MockLlamaVisionAdapter {
  analyze: ReturnType<typeof vi.fn>;
  analyzeJSON: ReturnType<typeof vi.fn>;
  isAvailable: ReturnType<typeof vi.fn>;
}

interface MockSectionDetector {
  detect: ReturnType<typeof vi.fn>;
}

// =============================================================================
// Test Constants
// =============================================================================

const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const TEST_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <section class="hero">
    <h1>Welcome</h1>
    <p>Hero description</p>
    <button>Get Started</button>
  </section>
  <section class="feature">
    <h2>Features</h2>
    <p>Feature description</p>
  </section>
</body>
</html>
`;

const MOCK_VISION_RESULT: VisionAnalysisResult<string> = {
  response: 'This is a landing page with hero section',
  metrics: {
    hardwareType: 'CPU' as const,
    originalSizeBytes: 1024,
    optimizationApplied: false,
    totalProcessingTimeMs: 500,
  },
};

const MOCK_DETECTED_SECTIONS: DetectedSection[] = [
  {
    id: 'test-hero-id',
    type: 'hero',
    confidence: 0.9,
    element: {
      tagName: 'section',
      selector: 'section.hero',
      classes: ['hero'],
    },
    position: {
      startY: 0,
      endY: 400,
      height: 400,
      estimatedTop: 0,
    },
    content: {
      headings: [{ level: 1, text: 'Welcome' }],
      paragraphs: ['Hero description'],
      links: [],
      images: [],
      buttons: [{ text: 'Get Started', type: 'primary' }],
    },
    style: {},
  },
  {
    id: 'test-feature-id',
    type: 'feature',
    confidence: 0.85,
    element: {
      tagName: 'section',
      selector: 'section.feature',
      classes: ['feature'],
    },
    position: {
      startY: 400,
      endY: 800,
      height: 400,
      estimatedTop: 50,
    },
    content: {
      headings: [{ level: 2, text: 'Features' }],
      paragraphs: ['Feature description'],
      links: [],
      images: [],
      buttons: [],
    },
    style: {},
  },
];

// =============================================================================
// Test Suite
// =============================================================================

describe('VisionFallbackService', () => {
  let service: VisionFallbackService;
  let mockVisionAdapter: MockLlamaVisionAdapter;
  let mockSectionDetector: MockSectionDetector;

  beforeEach(() => {
    // Create mocks
    mockVisionAdapter = {
      analyze: vi.fn(),
      analyzeJSON: vi.fn(),
      isAvailable: vi.fn(),
    };

    mockSectionDetector = {
      detect: vi.fn(),
    };

    // Create service with mocked dependencies
    service = new VisionFallbackService({
      visionAdapter: mockVisionAdapter as unknown as import('../../../src/services/vision/llama-vision-adapter.js').LlamaVisionAdapter,
      sectionDetector: mockSectionDetector as unknown as import('@reftrix/webdesign-core').SectionDetector,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Basic Success Cases
  // ===========================================================================

  describe('Success Cases', () => {
    it('should return vision analysis result when vision succeeds', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockResolvedValue(MOCK_VISION_RESULT);
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(true);
      expect(result.htmlAnalysisOnly).toBe(false);
      expect(result.visionAnalysis).toBeDefined();
      expect(result.htmlAnalysis).toBeDefined();
      expect(result.metrics.visionTimedOut).toBe(false);
      expect(result.fallbackReason).toBeUndefined();
    });

    it('should include both vision and HTML analysis in success case', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockResolvedValue(MOCK_VISION_RESULT);
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.visionAnalysis).toEqual(MOCK_VISION_RESULT);
      expect(result.htmlAnalysis.sections).toEqual(MOCK_DETECTED_SECTIONS);
      expect(result.metrics.totalTimeMs).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Strategy 1: Vision Timeout → HTML Analysis Only
  // ===========================================================================

  describe('Strategy 1: Vision Timeout Fallback', () => {
    it('should fallback to HTML analysis when vision times out', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockImplementation(() =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Vision analysis timeout')), 100);
        })
      );
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      const options: VisionFallbackOptions = {
        visionTimeoutMs: 50, // Short timeout to trigger fallback
      };

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(false);
      expect(result.htmlAnalysisOnly).toBe(true);
      expect(result.fallbackReason).toContain('timeout');
      expect(result.visionAnalysis).toBeUndefined();
      expect(result.htmlAnalysis.sections).toEqual(MOCK_DETECTED_SECTIONS);
      expect(result.metrics.visionTimedOut).toBe(true);
      expect(result.metrics.visionAttemptTimeMs).toBeDefined();
    });

    it('should record visionAttemptTimeMs even when timed out', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockImplementation(() =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Vision analysis timeout')), 200);
        })
      );
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      const options: VisionFallbackOptions = {
        visionTimeoutMs: 100,
      };

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, options);

      // Assert
      // Allow small timing variance (95ms instead of strict 100ms)
      expect(result.metrics.visionAttemptTimeMs).toBeGreaterThanOrEqual(95);
      expect(result.metrics.visionTimedOut).toBe(true);
    });

    it('should return error when forceVision is true and vision times out', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockImplementation(() =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Vision analysis timeout')), 100);
        })
      );
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      const options: VisionFallbackOptions = {
        visionTimeoutMs: 50,
        forceVision: true,
      };

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, options);

      // Assert
      expect(result.success).toBe(false);
      expect(result.visionUsed).toBe(false);
      expect(result.htmlAnalysisOnly).toBe(false);
      expect(result.fallbackReason).toContain('forceVision');
      expect(result.metrics.visionTimedOut).toBe(true);
    });
  });

  // ===========================================================================
  // Strategy 2: Vision Failure → HTML Analysis Only
  // ===========================================================================

  describe('Strategy 2: Vision Failure Fallback', () => {
    it('should fallback to HTML analysis when Ollama is not available', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(false);
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(false);
      expect(result.htmlAnalysisOnly).toBe(true);
      expect(result.fallbackReason).toContain('Ollama');
      expect(result.visionAnalysis).toBeUndefined();
      expect(result.htmlAnalysis.sections).toEqual(MOCK_DETECTED_SECTIONS);
      expect(result.metrics.visionTimedOut).toBe(false);
    });

    it('should fallback to HTML analysis when vision analysis throws error', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockRejectedValue(new Error('Ollama connection refused'));
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(false);
      expect(result.htmlAnalysisOnly).toBe(true);
      expect(result.fallbackReason).toContain('error');
      expect(result.htmlAnalysis.sections).toEqual(MOCK_DETECTED_SECTIONS);
      expect(result.metrics.visionTimedOut).toBe(false);
    });

    it('should return error when forceVision is true and Ollama is not available', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(false);
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      const options: VisionFallbackOptions = {
        forceVision: true,
      };

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, options);

      // Assert
      expect(result.success).toBe(false);
      expect(result.visionUsed).toBe(false);
      expect(result.fallbackReason).toContain('forceVision');
    });
  });

  // ===========================================================================
  // Strategy 3: No Image → HTML Analysis Only (No Warning)
  // ===========================================================================

  describe('Strategy 3: No Image Fallback', () => {
    it('should use HTML analysis only when no image is provided', async () => {
      // Arrange
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act - empty string for image
      const result = await service.analyzeWithFallback('', TEST_HTML, {});

      // Assert
      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(false);
      expect(result.htmlAnalysisOnly).toBe(true);
      expect(result.fallbackReason).toBeUndefined(); // No warning for no image case
      expect(result.visionAnalysis).toBeUndefined();
      expect(result.htmlAnalysis.sections).toEqual(MOCK_DETECTED_SECTIONS);
      expect(result.metrics.visionTimedOut).toBe(false);
      expect(result.metrics.visionAttemptTimeMs).toBeUndefined();
    });

    it('should not call vision adapter when no image is provided', async () => {
      // Arrange
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      await service.analyzeWithFallback('', TEST_HTML, {});

      // Assert
      expect(mockVisionAdapter.isAvailable).not.toHaveBeenCalled();
      expect(mockVisionAdapter.analyze).not.toHaveBeenCalled();
    });

    it('should work with undefined image parameter', async () => {
      // Arrange
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      const result = await service.analyzeWithFallback(undefined as unknown as string, TEST_HTML, {});

      // Assert
      expect(result.success).toBe(true);
      expect(result.visionUsed).toBe(false);
      expect(result.htmlAnalysisOnly).toBe(true);
    });
  });

  // ===========================================================================
  // Metrics and Logging
  // ===========================================================================

  describe('Metrics and Logging', () => {
    it('should track total processing time in metrics', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockResolvedValue(MOCK_VISION_RESULT);
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.metrics.totalTimeMs).toBeGreaterThan(0);
      expect(typeof result.metrics.totalTimeMs).toBe('number');
    });

    it('should track vision attempt time when vision is attempted', async () => {
      // Arrange
      const delayedVisionResult = new Promise<VisionAnalysisResult<string>>((resolve) => {
        setTimeout(() => resolve(MOCK_VISION_RESULT), 50);
      });
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockReturnValue(delayedVisionResult);
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      // Allow small timing variance (45ms instead of strict 50ms)
      expect(result.metrics.visionAttemptTimeMs).toBeGreaterThanOrEqual(45);
    });

    it('should have undefined visionAttemptTimeMs when vision is not attempted', async () => {
      // Arrange
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act - no image, so vision is not attempted
      const result = await service.analyzeWithFallback('', TEST_HTML, {});

      // Assert
      expect(result.metrics.visionAttemptTimeMs).toBeUndefined();
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle empty HTML gracefully', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockResolvedValue(MOCK_VISION_RESULT);
      mockSectionDetector.detect.mockResolvedValue([]);

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, '', {});

      // Assert
      expect(result.success).toBe(true);
      expect(result.htmlAnalysis.sections).toEqual([]);
    });

    it('should handle HTML analysis failure', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockResolvedValue(MOCK_VISION_RESULT);
      mockSectionDetector.detect.mockRejectedValue(new Error('HTML parsing failed'));

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      // Even if HTML analysis fails, we should have vision result
      expect(result.visionAnalysis).toEqual(MOCK_VISION_RESULT);
      // The overall success depends on implementation - may fail or have empty HTML analysis
    });

    it('should handle both vision and HTML analysis failure', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockRejectedValue(new Error('Vision failed'));
      mockSectionDetector.detect.mockRejectedValue(new Error('HTML parsing failed'));

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.success).toBe(false);
      expect(result.fallbackReason).toContain('error');
    });

    it('should use default timeout when not specified', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockResolvedValue(MOCK_VISION_RESULT);
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.success).toBe(true);
      // Default timeout should be long enough for normal operation
    });
  });

  // ===========================================================================
  // FallbackResult Interface Validation
  // ===========================================================================

  describe('FallbackResult Interface', () => {
    it('should have all required fields in FallbackResult', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockResolvedValue(MOCK_VISION_RESULT);
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      const result: FallbackResult = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert - Check all required fields exist
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('visionUsed');
      expect(result).toHaveProperty('htmlAnalysisOnly');
      expect(result).toHaveProperty('htmlAnalysis');
      expect(result).toHaveProperty('metrics');
      expect(result.metrics).toHaveProperty('totalTimeMs');
      expect(result.metrics).toHaveProperty('visionTimedOut');
    });

    it('should have optional fields when applicable', async () => {
      // Arrange
      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyze.mockResolvedValue(MOCK_VISION_RESULT);
      mockSectionDetector.detect.mockResolvedValue(MOCK_DETECTED_SECTIONS);

      // Act
      const result = await service.analyzeWithFallback(TEST_IMAGE_BASE64, TEST_HTML, {});

      // Assert
      expect(result.visionAnalysis).toBeDefined(); // Present when vision succeeds
      expect(result.metrics.visionAttemptTimeMs).toBeDefined(); // Present when vision attempted
      expect(result.fallbackReason).toBeUndefined(); // Absent when no fallback
    });
  });
});
