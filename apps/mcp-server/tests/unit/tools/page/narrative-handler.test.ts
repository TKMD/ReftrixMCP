// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze narrative統合ハンドラーのユニットテスト
 * TDD Red Phase: 失敗するテストを先に作成
 *
 * Narrative分析オプションを追加し、Webページから世界観・レイアウト構成を自動抽出する機能のテスト
 *
 * テスト対象:
 * - narrativeOptions スキーマバリデーション
 * - handleNarrativeAnalysis 関数
 * - NarrativeAnalysisService 統合
 * - DB保存フロー
 * - エラーハンドリング
 *
 * @module tests/unit/tools/page/narrative-handler.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

// =====================================================
// TDD Green Phase: インポート
// 実装完了のため、実際のモジュールをインポート
// =====================================================

// スキーマインポート
import { narrativeOptionsSchema, narrativeResultSchema, pageAnalyzeDataSchema } from '../../../../src/tools/page/schemas';

// ハンドラーインポート
import {
  handleNarrativeAnalysis,
  setNarrativeServiceFactory,
  resetNarrativeServiceFactory,
} from '../../../../src/tools/page/handlers/narrative-handler';
import type { NarrativeHandlerInput } from '../../../../src/tools/page/handlers/types';

// =====================================================
// モックサービス
// =====================================================

/**
 * NarrativeAnalysisServiceのモック
 */
function createMockNarrativeAnalysisService() {
  return {
    analyze: vi.fn().mockResolvedValue({
      worldView: {
        moodCategory: 'professional',
        moodDescription: 'Clean and professional design with emphasis on clarity',
        colorImpression: {
          overall: 'cool and professional',
          dominantEmotion: 'trust',
          harmony: 'complementary' as const,
        },
        typographyPersonality: {
          style: 'modern',
          readability: 'high' as const,
          hierarchy: 'clear' as const,
        },
        overallTone: {
          primary: 'professional',
          formality: 0.7,
          energy: 0.4,
        },
      },
      layoutStructure: {
        gridSystem: {
          type: 'css-grid' as const,
          columns: 12,
        },
        visualHierarchy: {
          primaryElements: ['hero-title', 'cta-button'],
          secondaryElements: ['feature-cards'],
          tertiaryElements: ['footer-links'],
          sectionFlow: 'linear' as const,
          weightDistribution: {
            top: 0.5,
            middle: 0.35,
            bottom: 0.15,
          },
        },
        spacingRhythm: {
          baseUnit: '8px',
          scale: [1, 2, 3, 4, 6, 8],
          sectionGaps: {
            min: '24px',
            max: '80px',
            average: '48px',
          },
        },
        sectionRelationships: [],
        graphicElements: {
          imageLayout: {
            pattern: 'contained' as const,
            aspectRatios: ['16:9', '4:3'],
            positions: ['hero', 'inline'] as ('hero' | 'inline' | 'background' | 'decorative')[],
          },
          decorations: {
            hasGradients: false,
            hasShadows: true,
            hasBorders: true,
            hasIllustrations: false,
          },
          visualBalance: {
            symmetry: 'symmetric' as const,
            density: 'balanced' as const,
            whitespace: 0.45,
          },
        },
      },
      metadata: {
        textRepresentation: 'passage: Professional web design with clean layout...',
        embedding: new Array(768).fill(0.1),
        confidence: {
          overall: 0.85,
          worldView: 0.88,
          layoutStructure: 0.82,
          breakdown: {
            visionAnalysis: 0.9,
            cssStaticAnalysis: 0.85,
            htmlStructureAnalysis: 0.8,
            motionAnalysis: 0.75,
          },
        },
        analysisTimeMs: 2500,
        visionUsed: true,
      },
    }),
    save: vi.fn().mockResolvedValue({
      id: '019c2a92-0000-7f42-81a7-000000000001',
      webPageId: '019c2a92-0000-7f42-81a7-000000000002',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    analyzeAndSave: vi.fn().mockResolvedValue({
      id: '019c2a92-0000-7f42-81a7-000000000001',
      webPageId: '019c2a92-0000-7f42-81a7-000000000002',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    isVisionAvailable: vi.fn().mockResolvedValue(true),
  };
}

// =====================================================
// テスト: narrativeOptions スキーマバリデーション
// =====================================================

describe('narrativeOptionsSchema', () => {
  it('should accept valid narrativeOptions with all fields', () => {
    const validInput = {
      enabled: true,
      saveToDb: true,
      includeVision: true,
    };

    const result = narrativeOptionsSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('should use default values when not provided', () => {
    const result = narrativeOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.saveToDb).toBe(true);
      expect(result.data.includeVision).toBe(true);
    }
  });

  it('should reject invalid enabled type', () => {
    const invalidInput = {
      enabled: 'true', // should be boolean
    };

    const result = narrativeOptionsSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });
});

// =====================================================
// テスト: handleNarrativeAnalysis 関数
// =====================================================

describe('handleNarrativeAnalysis', () => {
  let mockService: ReturnType<typeof createMockNarrativeAnalysisService>;

  beforeEach(() => {
    mockService = createMockNarrativeAnalysisService();
    // モックサービスファクトリを設定
    setNarrativeServiceFactory(() => mockService as unknown as ReturnType<typeof import('../../../../src/services/narrative/narrative-analysis.service').createNarrativeAnalysisService>);
  });

  afterEach(() => {
    vi.clearAllMocks();
    // ファクトリをリセット
    resetNarrativeServiceFactory();
  });

  describe('正常系', () => {
    it('should return narrative analysis result when enabled', async () => {
      const input: NarrativeHandlerInput = {
        html: '<html><body><h1>Test</h1></body></html>',
        screenshot: 'base64-screenshot-data',
        webPageId: '019c2a92-0000-7f42-81a7-000000000002',
        narrativeOptions: {
          enabled: true,
          saveToDb: true,
          includeVision: true,
        },
        existingAnalysis: {
          cssVariables: {},
          motionPatterns: { patterns: [], totalCount: 0, categories: {} },
          sections: [],
        },
      };

      const result = await handleNarrativeAnalysis(input);

      expect(result.success).toBe(true);
      expect(result.narrative).toBeDefined();
      expect(result.narrative?.worldView.moodCategory).toBe('professional');
    });

    it('should skip analysis when enabled is false', async () => {
      const input: NarrativeHandlerInput = {
        html: '<html><body><h1>Test</h1></body></html>',
        narrativeOptions: {
          enabled: false,
        },
      };

      const result = await handleNarrativeAnalysis(input);

      expect(result.success).toBe(true);
      expect(result.narrative).toBeUndefined();
      expect(result.skipped).toBe(true);
    });

    it('should save to DB when saveToDb is true', async () => {
      const input: NarrativeHandlerInput = {
        html: '<html><body><h1>Test</h1></body></html>',
        webPageId: '019c2a92-0000-7f42-81a7-000000000002',
        narrativeOptions: {
          enabled: true,
          saveToDb: true,
        },
      };

      const result = await handleNarrativeAnalysis(input);

      expect(mockService.analyzeAndSave).toHaveBeenCalled();
      expect(result.savedId).toBeDefined();
    });

    it('should not save to DB when saveToDb is false', async () => {
      const input: NarrativeHandlerInput = {
        html: '<html><body><h1>Test</h1></body></html>',
        webPageId: '019c2a92-0000-7f42-81a7-000000000002',
        narrativeOptions: {
          enabled: true,
          saveToDb: false,
        },
      };

      const result = await handleNarrativeAnalysis(input);

      expect(mockService.analyze).toHaveBeenCalled();
      expect(mockService.analyzeAndSave).not.toHaveBeenCalled();
      expect(result.savedId).toBeUndefined();
    });

    it('should pass existing analysis results to service', async () => {
      const existingAnalysis = {
        cssVariables: {
          customProperties: [{ name: '--primary-color', value: '#3366cc' }],
        },
        motionPatterns: {
          patterns: [{ id: '1', name: 'fade-in', type: 'css_animation' }],
          totalCount: 1,
          categories: { entrance: 1 },
        },
        sections: [{ id: '1', type: 'hero', positionIndex: 0 }],
        visualFeatures: {
          colors: { primary: '#3366cc' },
          theme: 'light',
        },
      };

      const input: NarrativeHandlerInput = {
        html: '<html><body><h1>Test</h1></body></html>',
        narrativeOptions: {
          enabled: true,
          saveToDb: false,
        },
        existingAnalysis,
      };

      await handleNarrativeAnalysis(input);

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          existingAnalysis: expect.objectContaining({
            cssVariables: existingAnalysis.cssVariables,
            motionPatterns: existingAnalysis.motionPatterns,
          }),
        })
      );
    });
  });

  describe('Vision設定', () => {
    it('should use Vision when includeVision is true', async () => {
      const input: NarrativeHandlerInput = {
        html: '<html><body><h1>Test</h1></body></html>',
        screenshot: 'base64-screenshot-data',
        narrativeOptions: {
          enabled: true,
          includeVision: true,
        },
      };

      await handleNarrativeAnalysis(input);

      // includeVision=trueの場合、forceVisionはundefinedになる（デフォルト動作）
      expect(mockService.analyze).toHaveBeenCalled();
    });

    it('should skip Vision when includeVision is false', async () => {
      const input: NarrativeHandlerInput = {
        html: '<html><body><h1>Test</h1></body></html>',
        screenshot: 'base64-screenshot-data',
        narrativeOptions: {
          enabled: true,
          includeVision: false,
        },
      };

      await handleNarrativeAnalysis(input);

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            forceVision: false, // explicitly disabled
          }),
        })
      );
    });
  });

  describe('エラーハンドリング', () => {
    it('should handle service error gracefully', async () => {
      mockService.analyze.mockRejectedValue(new Error('Service unavailable'));

      const input: NarrativeHandlerInput = {
        html: '<html><body><h1>Test</h1></body></html>',
        narrativeOptions: {
          enabled: true,
        },
      };

      const result = await handleNarrativeAnalysis(input);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('NARRATIVE_ANALYSIS_FAILED');
    });

    it('should handle missing webPageId when saveToDb is true', async () => {
      const input: NarrativeHandlerInput = {
        html: '<html><body><h1>Test</h1></body></html>',
        // webPageId is missing
        narrativeOptions: {
          enabled: true,
          saveToDb: true,
        },
      };

      const result = await handleNarrativeAnalysis(input);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should handle DB save error gracefully', async () => {
      mockService.analyzeAndSave.mockRejectedValue(new Error('DB connection failed'));

      const input: NarrativeHandlerInput = {
        html: '<html><body><h1>Test</h1></body></html>',
        webPageId: '019c2a92-0000-7f42-81a7-000000000002',
        narrativeOptions: {
          enabled: true,
          saveToDb: true,
        },
      };

      const result = await handleNarrativeAnalysis(input);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NARRATIVE_SAVE_FAILED');
    });
  });
});

// =====================================================
// テスト: NarrativeResult型の構造
// =====================================================

describe('NarrativeResult type structure', () => {
  it('should match expected structure', () => {
    const validResult = {
      id: '019c2a92-0000-7f42-81a7-000000000001',
      webPageId: '019c2a92-0000-7f42-81a7-000000000002',
      worldView: {
        moodCategory: 'professional',
        secondaryMoodCategory: 'minimal',
        moodDescription: 'Clean and professional design',
        colorImpression: 'cool and trustworthy',
        typographyPersonality: 'modern sans-serif',
        motionEmotion: 'subtle and elegant',
        overallTone: 'professional',
      },
      layoutStructure: {
        gridSystem: 'css-grid',
        columnCount: 12,
        visualHierarchy: {
          primaryElements: ['hero-title'],
          sectionFlow: 'linear',
        },
        spacingRhythm: {
          baseUnit: '8px',
          scale: [1, 2, 3, 4, 6, 8],
        },
      },
      confidence: 0.85,
      analyzedAt: '2026-02-05T10:00:00Z',
    };

    const result = narrativeResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
  });
});

// =====================================================
// テスト: page.analyze統合
// =====================================================

describe('page.analyze narrative integration', () => {
  it('should include narrative in PageAnalyzeData when narrativeOptions.enabled is true', () => {
    const dataWithNarrative = {
      id: '019c2a92-0000-7f42-81a7-000000000002',
      url: 'https://example.com',
      normalizedUrl: 'https://example.com/',
      metadata: {
        title: 'Test Page',
      },
      source: {
        type: 'user_provided',
        usageScope: 'inspiration_only',
      },
      layout: {
        success: true,
        sectionCount: 5,
        sectionTypes: {},
        processingTimeMs: 1000,
      },
      narrative: {
        id: '019c2a92-0000-7f42-81a7-000000000001',
        webPageId: '019c2a92-0000-7f42-81a7-000000000002',
        worldView: {
          moodCategory: 'professional',
          moodDescription: 'Clean design',
          colorImpression: 'cool',
          typographyPersonality: 'modern',
          overallTone: 'professional',
        },
        layoutStructure: {
          gridSystem: 'css-grid',
          columnCount: 12,
        },
        confidence: 0.85,
        analyzedAt: '2026-02-05T10:00:00Z',
      },
      totalProcessingTimeMs: 3000,
      analyzedAt: '2026-02-05T10:00:00Z',
    };

    const result = pageAnalyzeDataSchema.safeParse(dataWithNarrative);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.narrative).toBeDefined();
      expect(result.data.narrative?.worldView.moodCategory).toBe('professional');
    }
  });

  it('should allow narrative to be undefined when not enabled', () => {
    const dataWithoutNarrative = {
      id: '019c2a92-0000-7f42-81a7-000000000002',
      url: 'https://example.com',
      normalizedUrl: 'https://example.com/',
      metadata: {
        title: 'Test Page',
      },
      source: {
        type: 'user_provided',
        usageScope: 'inspiration_only',
      },
      layout: {
        success: true,
        sectionCount: 5,
        sectionTypes: {},
        processingTimeMs: 1000,
      },
      // narrative is not included
      totalProcessingTimeMs: 2000,
      analyzedAt: '2026-02-05T10:00:00Z',
    };

    const result = pageAnalyzeDataSchema.safeParse(dataWithoutNarrative);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.narrative).toBeUndefined();
    }
  });
});
