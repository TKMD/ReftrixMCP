// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LlamaVisionAdapter - Unit Tests
 *
 * Vision CPU完走保証 Phase 2: LlamaVisionAdapterの統合テスト
 *
 * テスト対象:
 * - ImageOptimizerとの統合
 * - HardwareDetectorによるGPU/CPU判定
 * - 動的タイムアウト計算
 * - CPU時の自動画像最適化
 * - Graceful Degradation
 *
 * @see apps/mcp-server/src/services/vision/llama-vision-adapter.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LlamaVisionAdapter,
  type VisionAnalysisOptions,
  type VisionAnalysisResult,
  type LlamaVisionAdapterConfig,
} from '../../../src/services/vision/llama-vision-adapter.js';
import { HardwareType, type HardwareInfo } from '../../../src/services/vision/hardware-detector.js';
import { OptimizationStrategy, type OptimizeResult } from '../../../src/services/vision/image-optimizer.js';
import { VisionAnalysisError } from '../../../src/services/vision/vision.errors.js';

// =============================================================================
// Mock Types
// =============================================================================

interface MockHardwareDetector {
  detect: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
}

interface MockImageOptimizer {
  optimizeForCPU: ReturnType<typeof vi.fn>;
  selectStrategy: ReturnType<typeof vi.fn>;
  estimateOptimalSize: ReturnType<typeof vi.fn>;
}

interface MockOllamaVisionClient {
  generate: ReturnType<typeof vi.fn>;
  generateJSON: ReturnType<typeof vi.fn>;
  generateWithImageSize: ReturnType<typeof vi.fn>;
  generateJSONWithImageSize: ReturnType<typeof vi.fn>;
  isAvailable: ReturnType<typeof vi.fn>;
}

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * モックHardwareDetectorを作成
 */
function createMockHardwareDetector(overrides?: Partial<MockHardwareDetector>): MockHardwareDetector {
  return {
    detect: vi.fn().mockResolvedValue({
      type: HardwareType.GPU,
      vramBytes: 8_000_000_000,
      isGpuAvailable: true,
    }),
    clearCache: vi.fn(),
    ...overrides,
  };
}

/**
 * モックImageOptimizerを作成
 */
function createMockImageOptimizer(overrides?: Partial<MockImageOptimizer>): MockImageOptimizer {
  const createOptimizeResult = (buffer: Buffer): OptimizeResult => ({
    buffer,
    originalSizeBytes: buffer.length,
    optimizedSizeBytes: buffer.length,
    dimensions: { width: 1024, height: 768 },
    compressionRatio: 1,
    processingTimeMs: 10,
    skipped: true,
    reason: 'No optimization needed',
  });

  return {
    optimizeForCPU: vi.fn().mockImplementation(async (input: Buffer | string) => {
      const buffer = typeof input === 'string' ? Buffer.from(input, 'base64') : input;
      return createOptimizeResult(buffer);
    }),
    selectStrategy: vi.fn().mockReturnValue(OptimizationStrategy.NONE),
    estimateOptimalSize: vi.fn().mockReturnValue({
      maxWidth: undefined,
      maxHeight: undefined,
      quality: undefined,
      strategy: OptimizationStrategy.NONE,
    }),
    ...overrides,
  };
}

/**
 * モックOllamaVisionClientを作成
 */
function createMockOllamaVisionClient(overrides?: Partial<MockOllamaVisionClient>): MockOllamaVisionClient {
  return {
    generate: vi.fn().mockResolvedValue('Analysis result text'),
    generateJSON: vi.fn().mockResolvedValue({ result: 'json' }),
    generateWithImageSize: vi.fn().mockResolvedValue('Analysis result text'),
    generateJSONWithImageSize: vi.fn().mockResolvedValue({ result: 'json' }),
    isAvailable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/**
 * テスト用のBase64画像を作成
 */
function createTestBase64Image(sizeBytes: number = 1000): string {
  const buffer = Buffer.alloc(sizeBytes, 'A');
  return buffer.toString('base64');
}

// =============================================================================
// Tests
// =============================================================================

describe('LlamaVisionAdapter', () => {
  let adapter: LlamaVisionAdapter;
  let mockHardwareDetector: MockHardwareDetector;
  let mockImageOptimizer: MockImageOptimizer;
  let mockOllamaClient: MockOllamaVisionClient;

  beforeEach(() => {
    mockHardwareDetector = createMockHardwareDetector();
    mockImageOptimizer = createMockImageOptimizer();
    mockOllamaClient = createMockOllamaVisionClient();

    adapter = new LlamaVisionAdapter({
      hardwareDetector: mockHardwareDetector,
      imageOptimizer: mockImageOptimizer,
      ollamaClient: mockOllamaClient,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Constructor and Configuration
  // ==========================================================================

  describe('Constructor and Configuration', () => {
    it('should create adapter with dependencies', () => {
      expect(adapter).toBeInstanceOf(LlamaVisionAdapter);
    });

    it('should create adapter with default dependencies when not provided', () => {
      const defaultAdapter = new LlamaVisionAdapter();
      expect(defaultAdapter).toBeInstanceOf(LlamaVisionAdapter);
    });

    it('should accept custom configuration', () => {
      const customConfig: LlamaVisionAdapterConfig = {
        enableOptimization: false,
        maxImageSizeBytes: 1_000_000,
        ollamaUrl: 'http://custom:11434',
      };

      const customAdapter = new LlamaVisionAdapter({
        ...customConfig,
        hardwareDetector: mockHardwareDetector,
        imageOptimizer: mockImageOptimizer,
        ollamaClient: mockOllamaClient,
      });

      expect(customAdapter).toBeInstanceOf(LlamaVisionAdapter);
    });
  });

  // ==========================================================================
  // analyze() - Core Functionality
  // ==========================================================================

  describe('analyze()', () => {
    it('should analyze image and return result', async () => {
      const image = createTestBase64Image(50_000);
      const prompt = 'Analyze this image';

      const result = await adapter.analyze(image, prompt);

      expect(result).toBeDefined();
      expect(result.response).toBe('Analysis result text');
      expect(result.metrics).toBeDefined();
    });

    it('should detect hardware type before analysis', async () => {
      const image = createTestBase64Image();
      await adapter.analyze(image, 'test prompt');

      expect(mockHardwareDetector.detect).toHaveBeenCalledTimes(1);
    });

    it('should skip optimization on GPU', async () => {
      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.GPU,
        vramBytes: 8_000_000_000,
        isGpuAvailable: true,
      });

      const image = createTestBase64Image(500_000);
      const result = await adapter.analyze(image, 'test');

      expect(result.metrics.hardwareType).toBe(HardwareType.GPU);
      expect(result.metrics.optimizationApplied).toBe(false);
    });

    it('should use dynamic timeout based on hardware and image size', async () => {
      const image = createTestBase64Image(200_000);
      await adapter.analyze(image, 'test');

      expect(mockOllamaClient.generateWithImageSize).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // CPU Optimization Integration
  // ==========================================================================

  describe('CPU Optimization', () => {
    beforeEach(() => {
      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
      });
    });

    it('should optimize large images on CPU', async () => {
      const originalSize = 600_000;
      const optimizedSize = 200_000;

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: Buffer.alloc(optimizedSize),
        originalSizeBytes: originalSize,
        optimizedSizeBytes: optimizedSize,
        dimensions: { width: 768, height: 768 },
        compressionRatio: optimizedSize / originalSize,
        processingTimeMs: 50,
        skipped: false,
      });

      const image = createTestBase64Image(originalSize);
      const result = await adapter.analyze(image, 'test');

      expect(mockImageOptimizer.optimizeForCPU).toHaveBeenCalled();
      expect(result.metrics.optimizationApplied).toBe(true);
      expect(result.metrics.originalSizeBytes).toBe(originalSize);
      expect(result.metrics.optimizedSizeBytes).toBe(optimizedSize);
    });

    it('should skip optimization for small images on CPU', async () => {
      const smallImage = createTestBase64Image(50_000);

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: Buffer.alloc(50_000),
        originalSizeBytes: 50_000,
        optimizedSizeBytes: 50_000,
        dimensions: { width: 500, height: 500 },
        compressionRatio: 1,
        processingTimeMs: 1,
        skipped: true,
        reason: 'No optimization needed',
      });

      const result = await adapter.analyze(smallImage, 'test');

      expect(result.metrics.optimizationApplied).toBe(false);
      expect(result.metrics.optimizationSkipReason).toBe('No optimization needed');
    });

    it('should calculate compression ratio correctly', async () => {
      const originalSize = 800_000;
      const optimizedSize = 200_000;
      const expectedRatio = optimizedSize / originalSize;

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: Buffer.alloc(optimizedSize),
        originalSizeBytes: originalSize,
        optimizedSizeBytes: optimizedSize,
        dimensions: { width: 768, height: 768 },
        compressionRatio: expectedRatio,
        processingTimeMs: 100,
        skipped: false,
      });

      const result = await adapter.analyze(createTestBase64Image(originalSize), 'test');

      expect(result.metrics.compressionRatio).toBeCloseTo(expectedRatio, 2);
    });
  });

  // ==========================================================================
  // Options Handling
  // ==========================================================================

  describe('Options Handling', () => {
    it('should respect enableOptimization: false option', async () => {
      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
      });

      const options: VisionAnalysisOptions = {
        enableOptimization: false,
      };

      const result = await adapter.analyze(createTestBase64Image(600_000), 'test', options);

      // Should skip optimization despite large image
      expect(result.metrics.optimizationApplied).toBe(false);
    });

    it('should respect forceOriginal option', async () => {
      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
      });

      const options: VisionAnalysisOptions = {
        forceOriginal: true,
      };

      const result = await adapter.analyze(createTestBase64Image(600_000), 'test', options);

      expect(result.metrics.optimizationApplied).toBe(false);
    });

    it('should use maxImageSizeBytes option for threshold', async () => {
      const adapterWithThreshold = new LlamaVisionAdapter({
        hardwareDetector: mockHardwareDetector,
        imageOptimizer: mockImageOptimizer,
        ollamaClient: mockOllamaClient,
        maxImageSizeBytes: 50_000, // Lower threshold
      });

      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
      });

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: Buffer.alloc(40_000),
        originalSizeBytes: 60_000,
        optimizedSizeBytes: 40_000,
        dimensions: { width: 800, height: 800 },
        compressionRatio: 0.67,
        processingTimeMs: 30,
        skipped: false,
      });

      const result = await adapterWithThreshold.analyze(createTestBase64Image(60_000), 'test');

      // Should optimize because image > maxImageSizeBytes (50KB)
      expect(result.metrics.optimizationApplied).toBe(true);
    });
  });

  // ==========================================================================
  // Graceful Degradation
  // ==========================================================================

  describe('Graceful Degradation', () => {
    it('should continue with original image if optimization fails', async () => {
      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
      });

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: Buffer.alloc(600_000),
        originalSizeBytes: 600_000,
        optimizedSizeBytes: 600_000,
        dimensions: { width: 0, height: 0 },
        compressionRatio: 1,
        processingTimeMs: 5,
        skipped: true,
        error: 'Invalid image format',
      });

      const result = await adapter.analyze(createTestBase64Image(600_000), 'test');

      // Should still complete analysis with original image
      expect(result.response).toBeDefined();
      expect(result.metrics.optimizationApplied).toBe(false);
      expect(result.metrics.optimizationError).toBe('Invalid image format');
    });

    it('should fallback to CPU if HardwareDetector fails', async () => {
      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
        error: 'Ollama connection failed',
      });

      const result = await adapter.analyze(createTestBase64Image(), 'test');

      expect(result.metrics.hardwareType).toBe(HardwareType.CPU);
      expect(result.metrics.hardwareDetectionError).toBe('Ollama connection failed');
    });

    it('should throw VisionAnalysisError if Ollama is unavailable', async () => {
      mockOllamaClient.generateWithImageSize.mockRejectedValue(
        new VisionAnalysisError('Cannot connect to Ollama', 'OLLAMA_UNAVAILABLE', true)
      );

      await expect(adapter.analyze(createTestBase64Image(), 'test')).rejects.toThrow(
        VisionAnalysisError
      );
    });

    it('should handle timeout errors gracefully', async () => {
      mockOllamaClient.generateWithImageSize.mockRejectedValue(
        new VisionAnalysisError('Request timeout', 'TIMEOUT', true)
      );

      await expect(adapter.analyze(createTestBase64Image(), 'test')).rejects.toThrow('timeout');
    });
  });

  // ==========================================================================
  // Metrics and Logging
  // ==========================================================================

  describe('Metrics', () => {
    it('should include all required metrics in result', async () => {
      const result = await adapter.analyze(createTestBase64Image(), 'test');

      expect(result.metrics).toMatchObject({
        hardwareType: expect.any(String),
        originalSizeBytes: expect.any(Number),
        optimizationApplied: expect.any(Boolean),
        totalProcessingTimeMs: expect.any(Number),
      });
    });

    it('should track optimization time separately', async () => {
      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
      });

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: Buffer.alloc(200_000),
        originalSizeBytes: 600_000,
        optimizedSizeBytes: 200_000,
        dimensions: { width: 768, height: 768 },
        compressionRatio: 0.33,
        processingTimeMs: 100, // Optimization took 100ms
        skipped: false,
      });

      const result = await adapter.analyze(createTestBase64Image(600_000), 'test');

      expect(result.metrics.optimizationTimeMs).toBe(100);
    });

    it('should include compression ratio in metrics', async () => {
      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
      });

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: Buffer.alloc(200_000),
        originalSizeBytes: 800_000,
        optimizedSizeBytes: 200_000,
        dimensions: { width: 768, height: 768 },
        compressionRatio: 0.25,
        processingTimeMs: 80,
        skipped: false,
      });

      const result = await adapter.analyze(createTestBase64Image(800_000), 'test');

      expect(result.metrics.compressionRatio).toBe(0.25);
    });
  });

  // ==========================================================================
  // isAvailable() Delegation
  // ==========================================================================

  describe('isAvailable()', () => {
    it('should delegate to OllamaVisionClient', async () => {
      mockOllamaClient.isAvailable.mockResolvedValue(true);

      const result = await adapter.isAvailable();

      expect(mockOllamaClient.isAvailable).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should return false if Ollama is unavailable', async () => {
      mockOllamaClient.isAvailable.mockResolvedValue(false);

      const result = await adapter.isAvailable();

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // JSON Analysis
  // ==========================================================================

  describe('analyzeJSON()', () => {
    it('should analyze image and return JSON result', async () => {
      mockOllamaClient.generateJSONWithImageSize.mockResolvedValue({
        mood: 'professional',
        confidence: 0.85,
      });

      const result = await adapter.analyzeJSON<{ mood: string; confidence: number }>(
        createTestBase64Image(),
        'Analyze mood'
      );

      expect(result.response).toEqual({
        mood: 'professional',
        confidence: 0.85,
      });
      expect(result.metrics).toBeDefined();
    });

    it('should optimize image before JSON analysis on CPU', async () => {
      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
      });

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: Buffer.alloc(200_000),
        originalSizeBytes: 600_000,
        optimizedSizeBytes: 200_000,
        dimensions: { width: 768, height: 768 },
        compressionRatio: 0.33,
        processingTimeMs: 50,
        skipped: false,
      });

      mockOllamaClient.generateJSONWithImageSize.mockResolvedValue({
        result: 'optimized',
      });

      const result = await adapter.analyzeJSON(createTestBase64Image(600_000), 'test');

      expect(mockImageOptimizer.optimizeForCPU).toHaveBeenCalled();
      expect(result.metrics.optimizationApplied).toBe(true);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle empty image', async () => {
      const emptyImage = '';

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: Buffer.alloc(0),
        originalSizeBytes: 0,
        optimizedSizeBytes: 0,
        dimensions: { width: 0, height: 0 },
        compressionRatio: 1,
        processingTimeMs: 0,
        skipped: true,
        error: 'Empty buffer',
      });

      const result = await adapter.analyze(emptyImage, 'test');

      expect(result.metrics.optimizationError).toBeDefined();
    });

    it('should handle very large images', async () => {
      const largeImage = createTestBase64Image(10_000_000); // 10MB

      mockHardwareDetector.detect.mockResolvedValue({
        type: HardwareType.CPU,
        vramBytes: 0,
        isGpuAvailable: false,
      });

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: Buffer.alloc(500_000),
        originalSizeBytes: 10_000_000,
        optimizedSizeBytes: 500_000,
        dimensions: { width: 768, height: 768 },
        compressionRatio: 0.05,
        processingTimeMs: 500,
        skipped: false,
      });

      const result = await adapter.analyze(largeImage, 'test');

      expect(result.metrics.optimizationApplied).toBe(true);
      expect(result.metrics.compressionRatio).toBeCloseTo(0.05, 2);
    });

    it('should handle Buffer input', async () => {
      const bufferImage = Buffer.alloc(50_000, 'B');

      mockImageOptimizer.optimizeForCPU.mockResolvedValue({
        buffer: bufferImage,
        originalSizeBytes: 50_000,
        optimizedSizeBytes: 50_000,
        dimensions: { width: 500, height: 500 },
        compressionRatio: 1,
        processingTimeMs: 1,
        skipped: true,
        reason: 'No optimization needed',
      });

      const result = await adapter.analyze(bufferImage, 'test');

      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
    });

    it('should handle concurrent analysis requests', async () => {
      const images = Array(5).fill(null).map(() => createTestBase64Image(100_000));

      const results = await Promise.all(
        images.map((image) => adapter.analyze(image, 'concurrent test'))
      );

      expect(results).toHaveLength(5);
      results.forEach((result) => {
        expect(result.response).toBeDefined();
      });
    });
  });
});
