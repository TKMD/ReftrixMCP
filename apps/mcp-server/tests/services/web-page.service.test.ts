// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebPageService Unit Tests
 *
 * motion.detectツールで使用するWebPage取得サービスのテスト
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Prismaモック
vi.mock('@reftrix/database', () => ({
  prisma: {
    webPage: {
      findUnique: vi.fn(),
    },
  },
}));

// loggerモック
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: () => true,
}));

import { prisma } from '@reftrix/database';
import { webPageService, createWebPageService } from '../../src/services/web-page.service';

describe('WebPageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getPageById', () => {
    it('should return WebPage with HTML content when found', async () => {
      const mockPage = {
        id: '01234567-89ab-cdef-0123-456789abcdef',
        htmlContent: '<html><body><h1>Test Page</h1></body></html>',
      };

      vi.mocked(prisma.webPage.findUnique).mockResolvedValue(mockPage as never);

      const result = await webPageService.getPageById(mockPage.id);

      expect(result).toEqual({
        id: mockPage.id,
        htmlContent: mockPage.htmlContent,
      });

      expect(prisma.webPage.findUnique).toHaveBeenCalledWith({
        where: { id: mockPage.id },
        select: {
          id: true,
          htmlContent: true,
        },
      });
    });

    it('should return null when page is not found', async () => {
      vi.mocked(prisma.webPage.findUnique).mockResolvedValue(null);

      const result = await webPageService.getPageById('nonexistent-id');

      expect(result).toBeNull();
    });

    it('should return null when page has no HTML content', async () => {
      const mockPage = {
        id: '01234567-89ab-cdef-0123-456789abcdef',
        htmlContent: null,
      };

      vi.mocked(prisma.webPage.findUnique).mockResolvedValue(mockPage as never);

      const result = await webPageService.getPageById(mockPage.id);

      expect(result).toBeNull();
    });

    it('should throw error when database query fails', async () => {
      const dbError = new Error('Database connection failed');
      vi.mocked(prisma.webPage.findUnique).mockRejectedValue(dbError);

      await expect(webPageService.getPageById('any-id')).rejects.toThrow(
        'Database connection failed'
      );
    });
  });

  describe('createWebPageService', () => {
    it('should return a service instance with getPageById method', () => {
      const service = createWebPageService();

      expect(service).toBeDefined();
      expect(typeof service.getPageById).toBe('function');
    });

    it('should return the same singleton instance', () => {
      const service1 = createWebPageService();
      const service2 = createWebPageService();

      // Both should reference the same singleton
      expect(service1).toBe(service2);
    });
  });
});

describe('WebPageService Integration with motion.detect', () => {
  it('should provide compatible interface for IMotionDetectService', async () => {
    // motion.detect expects: { id: string; htmlContent: string; cssContent?: string }
    const mockPage = {
      id: 'test-page-id',
      htmlContent: '<html><head><style>body { color: red; }</style></head><body>Test</body></html>',
    };

    vi.mocked(prisma.webPage.findUnique).mockResolvedValue(mockPage as never);

    const result = await webPageService.getPageById(mockPage.id);

    // Verify the result matches the expected interface
    expect(result).toBeDefined();
    expect(result?.id).toBe(mockPage.id);
    expect(result?.htmlContent).toBe(mockPage.htmlContent);
    // cssContent is optional and may be undefined
    expect(result?.cssContent).toBeUndefined();
  });
});
