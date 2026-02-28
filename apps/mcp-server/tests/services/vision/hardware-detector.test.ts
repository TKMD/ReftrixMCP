// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HardwareDetector - Unit Tests
 *
 * Vision CPU完走保証 Phase 1: GPU/CPU検出機能のテスト
 *
 * テスト対象:
 * - Ollama /api/ps からのGPU検出（size_vram > 0）
 * - CPU検出（size_vram === 0 または Ollama未起動）
 * - 5分間キャッシュ機能
 * - Graceful Degradation（Ollama未起動時はCPUフォールバック）
 * - 強制CPUモード（NVMLドライバ不整合対策）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HardwareDetector,
  HardwareType,
  HardwareInfo,
  HARDWARE_CACHE_TTL_MS,
} from '../../../src/services/vision/hardware-detector.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('HardwareDetector', () => {
  let detector: HardwareDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    detector = new HardwareDetector();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // GPU Detection Tests
  // ==========================================================================

  describe('GPU Detection', () => {
    it('should detect GPU when size_vram > 0', async () => {
      // Arrange: Ollama returns model with VRAM usage
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'llama3.2-vision:latest',
              size: 4_000_000_000,
              size_vram: 3_500_000_000, // GPU usage
            },
          ],
        }),
      });

      // Act
      const result = await detector.detect();

      // Assert
      expect(result.type).toBe(HardwareType.GPU);
      expect(result.vramBytes).toBe(3_500_000_000);
      expect(result.isGpuAvailable).toBe(true);
    });

    it('should detect GPU with multiple models (use max VRAM)', async () => {
      // Arrange: Multiple models loaded
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'model1', size: 1000, size_vram: 500 },
            { name: 'llama3.2-vision', size: 4000, size_vram: 3500 },
            { name: 'model3', size: 2000, size_vram: 1000 },
          ],
        }),
      });

      // Act
      const result = await detector.detect();

      // Assert
      expect(result.type).toBe(HardwareType.GPU);
      expect(result.vramBytes).toBe(3500); // Max VRAM
    });
  });

  // ==========================================================================
  // CPU Detection Tests
  // ==========================================================================

  describe('CPU Detection', () => {
    it('should detect CPU when size_vram === 0', async () => {
      // Arrange: Ollama returns model with no VRAM (CPU mode)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'llama3.2-vision:latest',
              size: 4_000_000_000,
              size_vram: 0, // CPU mode
            },
          ],
        }),
      });

      // Act
      const result = await detector.detect();

      // Assert
      expect(result.type).toBe(HardwareType.CPU);
      expect(result.vramBytes).toBe(0);
      expect(result.isGpuAvailable).toBe(false);
    });

    it('should detect CPU when no models are loaded', async () => {
      // Arrange: No models currently loaded
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [],
        }),
      });

      // Act
      const result = await detector.detect();

      // Assert
      expect(result.type).toBe(HardwareType.CPU);
      expect(result.vramBytes).toBe(0);
    });
  });

  // ==========================================================================
  // Graceful Degradation Tests
  // ==========================================================================

  describe('Graceful Degradation', () => {
    it('should fallback to CPU when Ollama is not running', async () => {
      // Arrange: Connection refused
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      // Act
      const result = await detector.detect();

      // Assert
      expect(result.type).toBe(HardwareType.CPU);
      expect(result.isGpuAvailable).toBe(false);
      expect(result.error).toContain('Ollama');
    });

    it('should fallback to CPU on HTTP error', async () => {
      // Arrange: Ollama returns error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      // Act
      const result = await detector.detect();

      // Assert
      expect(result.type).toBe(HardwareType.CPU);
      expect(result.error).toBeDefined();
    });

    it('should fallback to CPU on timeout', async () => {
      // Arrange: Request times out
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('AbortError')), 6000);
          })
      );

      // Act
      const detectPromise = detector.detect();
      vi.advanceTimersByTime(6000);
      const result = await detectPromise;

      // Assert
      expect(result.type).toBe(HardwareType.CPU);
    });

    it('should fallback to CPU on invalid JSON response', async () => {
      // Arrange: Invalid response format
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invalid: 'format' }),
      });

      // Act
      const result = await detector.detect();

      // Assert
      expect(result.type).toBe(HardwareType.CPU);
    });
  });

  // ==========================================================================
  // Cache Tests
  // ==========================================================================

  describe('Cache Functionality', () => {
    it('should cache result for 5 minutes', async () => {
      // Arrange: First call returns GPU
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: 'model', size: 1000, size_vram: 500 }],
        }),
      });

      // Act: First call
      const result1 = await detector.detect();
      expect(result1.type).toBe(HardwareType.GPU);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Act: Second call (should use cache)
      const result2 = await detector.detect();
      expect(result2.type).toBe(HardwareType.GPU);
      expect(mockFetch).toHaveBeenCalledTimes(1); // No additional call
    });

    it('should refresh cache after TTL expires', async () => {
      // Arrange: First call returns GPU
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: 'model', size: 1000, size_vram: 500 }],
        }),
      });

      // Act: First call
      await detector.detect();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance time past TTL (5 minutes)
      vi.advanceTimersByTime(HARDWARE_CACHE_TTL_MS + 1000);

      // Arrange: Second call returns CPU (hardware changed)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: 'model', size: 1000, size_vram: 0 }],
        }),
      });

      // Act: Second call (should refresh)
      const result = await detector.detect();
      expect(result.type).toBe(HardwareType.CPU);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should allow manual cache clear', async () => {
      // Arrange
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: 'model', size: 1000, size_vram: 500 }],
        }),
      });

      // Act: First call
      await detector.detect();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Clear cache
      detector.clearCache();

      // Act: Second call (should fetch again)
      await detector.detect();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Configuration Tests
  // ==========================================================================

  describe('Configuration', () => {
    it('should use custom Ollama URL', async () => {
      // Arrange
      const customUrl = 'http://custom-ollama:11434';
      const customDetector = new HardwareDetector({ ollamaUrl: customUrl });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });

      // Act
      await customDetector.detect();

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        `${customUrl}/api/ps`,
        expect.any(Object)
      );
    });

    it('should use default Ollama URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });

      // Act
      await detector.detect();

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/ps',
        expect.any(Object)
      );
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle null models array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: null }),
      });

      const result = await detector.detect();
      expect(result.type).toBe(HardwareType.CPU);
    });

    it('should handle undefined size_vram', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: 'model', size: 1000 }], // no size_vram
        }),
      });

      const result = await detector.detect();
      expect(result.type).toBe(HardwareType.CPU);
    });

    it('should handle concurrent detect calls', async () => {
      // Arrange: Slow response
      let resolveFirst: (value: unknown) => void;
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      );

      // Act: Start multiple concurrent calls
      const promise1 = detector.detect();
      const promise2 = detector.detect();
      const promise3 = detector.detect();

      // Resolve the fetch
      resolveFirst!({
        ok: true,
        json: async () => ({
          models: [{ name: 'model', size: 1000, size_vram: 500 }],
        }),
      });

      const [result1, result2, result3] = await Promise.all([
        promise1,
        promise2,
        promise3,
      ]);

      // Assert: All should return same result, only one fetch
      expect(result1.type).toBe(HardwareType.GPU);
      expect(result2.type).toBe(HardwareType.GPU);
      expect(result3.type).toBe(HardwareType.GPU);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Force CPU Mode Tests (NVMLドライバ不整合対策)
  // ==========================================================================

  describe('Force CPU Mode', () => {
    it('should return CPU when forceCpuMode is enabled via constructor', async () => {
      // Arrange: Force CPU mode via constructor option
      const forcedDetector = new HardwareDetector({ forceCpuMode: true });

      // Note: mockFetch should NOT be called when force CPU mode is enabled

      // Act
      const result = await forcedDetector.detect();

      // Assert
      expect(result.type).toBe(HardwareType.CPU);
      expect(result.isGpuAvailable).toBe(false);
      expect(result.vramBytes).toBe(0);
      expect(result.error).toContain('Force CPU mode');
      expect(mockFetch).not.toHaveBeenCalled(); // No API call
    });

    it('should return CPU when VISION_FORCE_CPU_MODE env is true', async () => {
      // Arrange: Set environment variable
      const originalEnv = process.env.VISION_FORCE_CPU_MODE;
      process.env.VISION_FORCE_CPU_MODE = 'true';

      try {
        // Create detector after setting env
        const envDetector = new HardwareDetector();

        // Act
        const result = await envDetector.detect();

        // Assert
        expect(result.type).toBe(HardwareType.CPU);
        expect(result.isGpuAvailable).toBe(false);
        expect(result.error).toContain('Force CPU mode');
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        // Cleanup
        if (originalEnv === undefined) {
          delete process.env.VISION_FORCE_CPU_MODE;
        } else {
          process.env.VISION_FORCE_CPU_MODE = originalEnv;
        }
      }
    });

    it('should handle case-insensitive VISION_FORCE_CPU_MODE=TRUE', async () => {
      // Arrange
      const originalEnv = process.env.VISION_FORCE_CPU_MODE;
      process.env.VISION_FORCE_CPU_MODE = 'TRUE';

      try {
        const envDetector = new HardwareDetector();
        const result = await envDetector.detect();

        expect(result.type).toBe(HardwareType.CPU);
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.VISION_FORCE_CPU_MODE;
        } else {
          process.env.VISION_FORCE_CPU_MODE = originalEnv;
        }
      }
    });

    it('should prioritize constructor option over environment variable', async () => {
      // Arrange: Env says true, but constructor says false
      const originalEnv = process.env.VISION_FORCE_CPU_MODE;
      process.env.VISION_FORCE_CPU_MODE = 'true';

      try {
        // Constructor explicitly sets forceCpuMode: false
        const detector = new HardwareDetector({ forceCpuMode: false });

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [{ name: 'model', size: 1000, size_vram: 500 }],
          }),
        });

        // Act
        const result = await detector.detect();

        // Assert: Should detect GPU because constructor overrides env
        expect(result.type).toBe(HardwareType.GPU);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.VISION_FORCE_CPU_MODE;
        } else {
          process.env.VISION_FORCE_CPU_MODE = originalEnv;
        }
      }
    });

    it('should report force CPU mode status via isForceCpuModeEnabled()', () => {
      // Arrange & Act
      const defaultDetector = new HardwareDetector();
      const forcedDetector = new HardwareDetector({ forceCpuMode: true });

      // Assert
      expect(defaultDetector.isForceCpuModeEnabled()).toBe(false);
      expect(forcedDetector.isForceCpuModeEnabled()).toBe(true);
    });

    it('should not be affected by VISION_FORCE_CPU_MODE=false', async () => {
      // Arrange
      const originalEnv = process.env.VISION_FORCE_CPU_MODE;
      process.env.VISION_FORCE_CPU_MODE = 'false';

      try {
        const detector = new HardwareDetector();

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [{ name: 'model', size: 1000, size_vram: 500 }],
          }),
        });

        // Act
        const result = await detector.detect();

        // Assert: Should detect GPU normally
        expect(result.type).toBe(HardwareType.GPU);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.VISION_FORCE_CPU_MODE;
        } else {
          process.env.VISION_FORCE_CPU_MODE = originalEnv;
        }
      }
    });

    it('should bypass cache when force CPU mode is enabled', async () => {
      // Arrange: Force CPU mode
      const forcedDetector = new HardwareDetector({ forceCpuMode: true });

      // Act: Multiple calls
      const result1 = await forcedDetector.detect();
      const result2 = await forcedDetector.detect();
      const result3 = await forcedDetector.detect();

      // Assert: All return CPU, no fetch calls, no cache used
      expect(result1.type).toBe(HardwareType.CPU);
      expect(result2.type).toBe(HardwareType.CPU);
      expect(result3.type).toBe(HardwareType.CPU);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Export Constants
  // ==========================================================================

  describe('Constants', () => {
    it('should export HARDWARE_CACHE_TTL_MS as 5 minutes', () => {
      expect(HARDWARE_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    });
  });
});
