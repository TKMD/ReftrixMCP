// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * IVisionAnalyzerインターフェース定義テスト
 * TDD Red Phase: ビジョン解析アダプタのインターフェース・型定義の検証
 *
 * 目的:
 * - IVisionAnalyzerインターフェースの型チェック
 * - VisionAnalysisResultの構造チェック
 * - VisionFeatureの構造チェック
 * - VisionFeatureDataの各種バリエーション検証
 * - 型ガード関数の動作確認
 *
 * 参照:
 * - docs/plans/webdesign/00-overview.md (ビジョン解析アダプタ セクション)
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// =============================================================================
// TDD Red: 以下のインポートは実装後に有効化する
// =============================================================================

import {
  // インターフェース
  type IVisionAnalyzer,
  type VisionAdapterFactory,
  // 入力オプション
  type VisionAnalysisOptions,
  // 結果型
  type VisionAnalysisResult,
  type VisionFeature,
  type VisionFeatureType,
  type VisionFeatureData,
  // 各特徴データ型
  type LayoutStructureData,
  type ColorPaletteData,
  type TypographyData,
  type VisualHierarchyData,
  type WhitespaceData,
  type DensityData,
  type RhythmData,
  type SectionBoundariesData,
  // 型ガード関数
  isLayoutStructureData,
  isColorPaletteData,
  isTypographyData,
  isVisualHierarchyData,
  isWhitespaceData,
  isDensityData,
  isRhythmData,
  isSectionBoundariesData,
  // Zodスキーマ
  visionAnalysisOptionsSchema,
  visionAnalysisResultSchema,
  visionFeatureSchema,
  visionFeatureTypeSchema,
} from '@/services/vision-adapter/interface';

// =============================================================================
// テストケース
// =============================================================================

describe('IVisionAnalyzerインターフェース定義', () => {
  // ===========================================================================
  // VisionFeatureType テスト
  // ===========================================================================

  describe('VisionFeatureType', () => {
    describe('正常系', () => {
      it('すべての有効な特徴タイプが検証できること', () => {
        const validTypes: VisionFeatureType[] = [
          'layout_structure',
          'color_palette',
          'typography',
          'visual_hierarchy',
          'whitespace',
          'density',
          'rhythm',
          'section_boundaries',
        ];

        validTypes.forEach((type) => {
          const result = visionFeatureTypeSchema.safeParse(type);
          expect(result.success).toBe(true);
        });
      });
    });

    describe('異常系', () => {
      it('無効な特徴タイプでエラーになること', () => {
        const invalidTypes = ['invalid_type', '', 'LAYOUT_STRUCTURE', 'layoutStructure'];

        invalidTypes.forEach((type) => {
          const result = visionFeatureTypeSchema.safeParse(type);
          expect(result.success).toBe(false);
        });
      });
    });
  });

  // ===========================================================================
  // VisionAnalysisOptions テスト
  // ===========================================================================

  describe('VisionAnalysisOptions', () => {
    describe('正常系', () => {
      it('必須フィールドのみで検証できること', () => {
        const options: VisionAnalysisOptions = {
          imageBuffer: Buffer.from('test image data'),
          mimeType: 'image/png',
        };

        const result = visionAnalysisOptionsSchema.safeParse(options);
        expect(result.success).toBe(true);
      });

      it('すべてのフィールドを含むオプションが検証できること', () => {
        const options: VisionAnalysisOptions = {
          imageBuffer: Buffer.from('test image data'),
          mimeType: 'image/jpeg',
          prompt: 'Analyze the layout structure',
          features: ['layout_structure', 'color_palette'],
          timeout: 30000,
        };

        const result = visionAnalysisOptionsSchema.safeParse(options);
        expect(result.success).toBe(true);
      });

      it('すべてのMIMEタイプが検証できること', () => {
        const mimeTypes: Array<'image/png' | 'image/jpeg' | 'image/webp'> = [
          'image/png',
          'image/jpeg',
          'image/webp',
        ];

        mimeTypes.forEach((mimeType) => {
          const options: VisionAnalysisOptions = {
            imageBuffer: Buffer.from('test'),
            mimeType,
          };

          const result = visionAnalysisOptionsSchema.safeParse(options);
          expect(result.success).toBe(true);
        });
      });
    });

    describe('異常系', () => {
      it('imageBufferがないとエラーになること', () => {
        const invalidOptions = {
          mimeType: 'image/png',
        };

        const result = visionAnalysisOptionsSchema.safeParse(invalidOptions);
        expect(result.success).toBe(false);
      });

      it('無効なMIMEタイプでエラーになること', () => {
        const invalidOptions = {
          imageBuffer: Buffer.from('test'),
          mimeType: 'image/gif', // サポートされていない
        };

        const result = visionAnalysisOptionsSchema.safeParse(invalidOptions);
        expect(result.success).toBe(false);
      });

      it('無効な特徴タイプでエラーになること', () => {
        const invalidOptions = {
          imageBuffer: Buffer.from('test'),
          mimeType: 'image/png',
          features: ['invalid_feature'],
        };

        const result = visionAnalysisOptionsSchema.safeParse(invalidOptions);
        expect(result.success).toBe(false);
      });

      it('負のタイムアウトでエラーになること', () => {
        const invalidOptions = {
          imageBuffer: Buffer.from('test'),
          mimeType: 'image/png',
          timeout: -1,
        };

        const result = visionAnalysisOptionsSchema.safeParse(invalidOptions);
        expect(result.success).toBe(false);
      });
    });
  });

  // ===========================================================================
  // VisionAnalysisResult テスト
  // ===========================================================================

  describe('VisionAnalysisResult', () => {
    describe('正常系', () => {
      it('成功レスポンスが検証できること', () => {
        const result: VisionAnalysisResult = {
          success: true,
          features: [
            {
              type: 'layout_structure',
              confidence: 0.95,
              data: {
                type: 'layout_structure',
                gridType: 'two-column',
                mainAreas: ['header', 'main', 'sidebar', 'footer'],
                description: 'Two column layout with sidebar',
              },
            },
          ],
          processingTimeMs: 1500,
          modelName: 'llama-vision-3.2',
        };

        const parseResult = visionAnalysisResultSchema.safeParse(result);
        expect(parseResult.success).toBe(true);
      });

      it('エラーレスポンスが検証できること', () => {
        const result: VisionAnalysisResult = {
          success: false,
          features: [],
          error: 'Failed to analyze image: timeout',
          processingTimeMs: 30000,
          modelName: 'llama-vision-3.2',
        };

        const parseResult = visionAnalysisResultSchema.safeParse(result);
        expect(parseResult.success).toBe(true);
      });

      it('rawResponseを含むレスポンスが検証できること', () => {
        const result: VisionAnalysisResult = {
          success: true,
          features: [],
          rawResponse: '{"layout": "grid", "colors": ["#fff"]}',
          processingTimeMs: 500,
          modelName: 'mock-vision',
        };

        const parseResult = visionAnalysisResultSchema.safeParse(result);
        expect(parseResult.success).toBe(true);
      });

      it('複数の特徴を含むレスポンスが検証できること', () => {
        const result: VisionAnalysisResult = {
          success: true,
          features: [
            {
              type: 'layout_structure',
              confidence: 0.9,
              data: {
                type: 'layout_structure',
                gridType: 'single-column',
                mainAreas: ['hero', 'content'],
                description: 'Single column layout',
              },
            },
            {
              type: 'color_palette',
              confidence: 0.85,
              data: {
                type: 'color_palette',
                dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF'],
                mood: 'professional and clean',
                contrast: 'high',
              },
            },
            {
              type: 'whitespace',
              confidence: 0.8,
              data: {
                type: 'whitespace',
                amount: 'generous',
                distribution: 'even',
              },
            },
          ],
          processingTimeMs: 2500,
          modelName: 'llama-vision-3.2',
        };

        const parseResult = visionAnalysisResultSchema.safeParse(result);
        expect(parseResult.success).toBe(true);
      });
    });

    describe('異常系', () => {
      it('successがないとエラーになること', () => {
        const invalidResult = {
          features: [],
          processingTimeMs: 100,
          modelName: 'test',
        };

        const parseResult = visionAnalysisResultSchema.safeParse(invalidResult);
        expect(parseResult.success).toBe(false);
      });

      it('processingTimeMsが負でエラーになること', () => {
        const invalidResult = {
          success: true,
          features: [],
          processingTimeMs: -100,
          modelName: 'test',
        };

        const parseResult = visionAnalysisResultSchema.safeParse(invalidResult);
        expect(parseResult.success).toBe(false);
      });

      it('modelNameが空でエラーになること', () => {
        const invalidResult = {
          success: true,
          features: [],
          processingTimeMs: 100,
          modelName: '',
        };

        const parseResult = visionAnalysisResultSchema.safeParse(invalidResult);
        expect(parseResult.success).toBe(false);
      });
    });
  });

  // ===========================================================================
  // VisionFeature テスト
  // ===========================================================================

  describe('VisionFeature', () => {
    describe('正常系', () => {
      it('confidenceが0-1の範囲で検証できること', () => {
        const validConfidences = [0, 0.5, 1, 0.75, 0.01, 0.99];

        validConfidences.forEach((confidence) => {
          const feature: VisionFeature = {
            type: 'density',
            confidence,
            data: {
              type: 'density',
              level: 'balanced',
              description: 'Test',
            },
          };

          const result = visionFeatureSchema.safeParse(feature);
          expect(result.success).toBe(true);
        });
      });
    });

    describe('異常系', () => {
      it('confidenceが1を超えるとエラーになること', () => {
        const invalidFeature = {
          type: 'density',
          confidence: 1.1,
          data: {
            type: 'density',
            level: 'balanced',
            description: 'Test',
          },
        };

        const result = visionFeatureSchema.safeParse(invalidFeature);
        expect(result.success).toBe(false);
      });

      it('confidenceが負でエラーになること', () => {
        const invalidFeature = {
          type: 'density',
          confidence: -0.1,
          data: {
            type: 'density',
            level: 'balanced',
            description: 'Test',
          },
        };

        const result = visionFeatureSchema.safeParse(invalidFeature);
        expect(result.success).toBe(false);
      });
    });
  });

  // ===========================================================================
  // VisionFeatureData 各種バリエーション テスト
  // ===========================================================================

  describe('VisionFeatureData', () => {
    describe('LayoutStructureData', () => {
      it('有効なLayoutStructureDataが検証できること', () => {
        const data: LayoutStructureData = {
          type: 'layout_structure',
          gridType: 'two-column',
          mainAreas: ['header', 'main', 'sidebar', 'footer'],
          description: 'A two column layout with sidebar',
        };

        expect(isLayoutStructureData(data)).toBe(true);
      });

      it('すべてのgridTypeが有効であること', () => {
        const gridTypes: LayoutStructureData['gridType'][] = [
          'single-column',
          'two-column',
          'three-column',
          'grid',
          'masonry',
          'asymmetric',
        ];

        gridTypes.forEach((gridType) => {
          const data: LayoutStructureData = {
            type: 'layout_structure',
            gridType,
            mainAreas: [],
            description: 'Test',
          };

          expect(isLayoutStructureData(data)).toBe(true);
        });
      });
    });

    describe('ColorPaletteData', () => {
      it('有効なColorPaletteDataが検証できること', () => {
        const data: ColorPaletteData = {
          type: 'color_palette',
          dominantColors: ['#3B82F6', '#1D4ED8', '#FFFFFF', '#000000'],
          mood: 'professional and trustworthy',
          contrast: 'high',
        };

        expect(isColorPaletteData(data)).toBe(true);
      });

      it('すべてのcontrastレベルが有効であること', () => {
        const contrastLevels: ColorPaletteData['contrast'][] = ['high', 'medium', 'low'];

        contrastLevels.forEach((contrast) => {
          const data: ColorPaletteData = {
            type: 'color_palette',
            dominantColors: ['#FFF'],
            mood: 'test',
            contrast,
          };

          expect(isColorPaletteData(data)).toBe(true);
        });
      });
    });

    describe('TypographyData', () => {
      it('有効なTypographyDataが検証できること', () => {
        const data: TypographyData = {
          type: 'typography',
          headingStyle: 'bold sans-serif, large size',
          bodyStyle: 'regular serif, medium size',
          hierarchy: ['h1 - 48px', 'h2 - 36px', 'h3 - 24px', 'body - 16px'],
        };

        expect(isTypographyData(data)).toBe(true);
      });
    });

    describe('VisualHierarchyData', () => {
      it('有効なVisualHierarchyDataが検証できること', () => {
        const data: VisualHierarchyData = {
          type: 'visual_hierarchy',
          focalPoints: ['hero image', 'CTA button', 'headline'],
          flowDirection: 'z-pattern',
          emphasisTechniques: ['size contrast', 'color contrast', 'whitespace'],
        };

        expect(isVisualHierarchyData(data)).toBe(true);
      });

      it('すべてのflowDirectionが有効であること', () => {
        const directions: VisualHierarchyData['flowDirection'][] = [
          'top-to-bottom',
          'left-to-right',
          'z-pattern',
          'f-pattern',
        ];

        directions.forEach((flowDirection) => {
          const data: VisualHierarchyData = {
            type: 'visual_hierarchy',
            focalPoints: [],
            flowDirection,
            emphasisTechniques: [],
          };

          expect(isVisualHierarchyData(data)).toBe(true);
        });
      });
    });

    describe('WhitespaceData', () => {
      it('有効なWhitespaceDataが検証できること', () => {
        const data: WhitespaceData = {
          type: 'whitespace',
          amount: 'generous',
          distribution: 'even',
        };

        expect(isWhitespaceData(data)).toBe(true);
      });

      it('すべてのamountレベルが有効であること', () => {
        const amounts: WhitespaceData['amount'][] = ['minimal', 'moderate', 'generous', 'extreme'];

        amounts.forEach((amount) => {
          const data: WhitespaceData = {
            type: 'whitespace',
            amount,
            distribution: 'even',
          };

          expect(isWhitespaceData(data)).toBe(true);
        });
      });

      it('すべてのdistributionパターンが有効であること', () => {
        const distributions: WhitespaceData['distribution'][] = [
          'even',
          'top-heavy',
          'bottom-heavy',
          'centered',
        ];

        distributions.forEach((distribution) => {
          const data: WhitespaceData = {
            type: 'whitespace',
            amount: 'moderate',
            distribution,
          };

          expect(isWhitespaceData(data)).toBe(true);
        });
      });
    });

    describe('DensityData', () => {
      it('有効なDensityDataが検証できること', () => {
        const data: DensityData = {
          type: 'density',
          level: 'balanced',
          description: 'Well-balanced information density with good readability',
        };

        expect(isDensityData(data)).toBe(true);
      });

      it('すべてのlevelが有効であること', () => {
        const levels: DensityData['level'][] = ['sparse', 'balanced', 'dense', 'cluttered'];

        levels.forEach((level) => {
          const data: DensityData = {
            type: 'density',
            level,
            description: 'Test',
          };

          expect(isDensityData(data)).toBe(true);
        });
      });
    });

    describe('RhythmData', () => {
      it('有効なRhythmDataが検証できること', () => {
        const data: RhythmData = {
          type: 'rhythm',
          pattern: 'regular',
          description: 'Consistent spacing and element sizes throughout',
        };

        expect(isRhythmData(data)).toBe(true);
      });

      it('すべてのpatternが有効であること', () => {
        const patterns: RhythmData['pattern'][] = [
          'regular',
          'irregular',
          'progressive',
          'alternating',
        ];

        patterns.forEach((pattern) => {
          const data: RhythmData = {
            type: 'rhythm',
            pattern,
            description: 'Test',
          };

          expect(isRhythmData(data)).toBe(true);
        });
      });
    });

    describe('SectionBoundariesData', () => {
      it('有効なSectionBoundariesDataが検証できること', () => {
        const data: SectionBoundariesData = {
          type: 'section_boundaries',
          sections: [
            { type: 'hero', startY: 0, endY: 600, confidence: 0.95 },
            { type: 'features', startY: 600, endY: 1200, confidence: 0.9 },
            { type: 'cta', startY: 1200, endY: 1500, confidence: 0.85 },
            { type: 'footer', startY: 1500, endY: 1800, confidence: 0.92 },
          ],
        };

        expect(isSectionBoundariesData(data)).toBe(true);
      });

      it('空のsections配列が有効であること', () => {
        const data: SectionBoundariesData = {
          type: 'section_boundaries',
          sections: [],
        };

        expect(isSectionBoundariesData(data)).toBe(true);
      });
    });
  });

  // ===========================================================================
  // 型ガード関数 テスト
  // ===========================================================================

  describe('型ガード関数', () => {
    const layoutData: LayoutStructureData = {
      type: 'layout_structure',
      gridType: 'single-column',
      mainAreas: [],
      description: 'Test',
    };

    const colorData: ColorPaletteData = {
      type: 'color_palette',
      dominantColors: ['#FFF'],
      mood: 'test',
      contrast: 'high',
    };

    const typographyData: TypographyData = {
      type: 'typography',
      headingStyle: 'bold',
      bodyStyle: 'regular',
      hierarchy: [],
    };

    const visualHierarchyData: VisualHierarchyData = {
      type: 'visual_hierarchy',
      focalPoints: [],
      flowDirection: 'top-to-bottom',
      emphasisTechniques: [],
    };

    const whitespaceData: WhitespaceData = {
      type: 'whitespace',
      amount: 'moderate',
      distribution: 'even',
    };

    const densityData: DensityData = {
      type: 'density',
      level: 'balanced',
      description: 'Test',
    };

    const rhythmData: RhythmData = {
      type: 'rhythm',
      pattern: 'regular',
      description: 'Test',
    };

    const sectionBoundariesData: SectionBoundariesData = {
      type: 'section_boundaries',
      sections: [],
    };

    describe('isLayoutStructureData', () => {
      it('LayoutStructureDataに対してtrueを返すこと', () => {
        expect(isLayoutStructureData(layoutData)).toBe(true);
      });

      it('他の型に対してfalseを返すこと', () => {
        expect(isLayoutStructureData(colorData)).toBe(false);
        expect(isLayoutStructureData(typographyData)).toBe(false);
        expect(isLayoutStructureData(densityData)).toBe(false);
      });
    });

    describe('isColorPaletteData', () => {
      it('ColorPaletteDataに対してtrueを返すこと', () => {
        expect(isColorPaletteData(colorData)).toBe(true);
      });

      it('他の型に対してfalseを返すこと', () => {
        expect(isColorPaletteData(layoutData)).toBe(false);
        expect(isColorPaletteData(rhythmData)).toBe(false);
      });
    });

    describe('isTypographyData', () => {
      it('TypographyDataに対してtrueを返すこと', () => {
        expect(isTypographyData(typographyData)).toBe(true);
      });

      it('他の型に対してfalseを返すこと', () => {
        expect(isTypographyData(layoutData)).toBe(false);
        expect(isTypographyData(colorData)).toBe(false);
      });
    });

    describe('isVisualHierarchyData', () => {
      it('VisualHierarchyDataに対してtrueを返すこと', () => {
        expect(isVisualHierarchyData(visualHierarchyData)).toBe(true);
      });

      it('他の型に対してfalseを返すこと', () => {
        expect(isVisualHierarchyData(layoutData)).toBe(false);
        expect(isVisualHierarchyData(whitespaceData)).toBe(false);
      });
    });

    describe('isWhitespaceData', () => {
      it('WhitespaceDataに対してtrueを返すこと', () => {
        expect(isWhitespaceData(whitespaceData)).toBe(true);
      });

      it('他の型に対してfalseを返すこと', () => {
        expect(isWhitespaceData(layoutData)).toBe(false);
        expect(isWhitespaceData(densityData)).toBe(false);
      });
    });

    describe('isDensityData', () => {
      it('DensityDataに対してtrueを返すこと', () => {
        expect(isDensityData(densityData)).toBe(true);
      });

      it('他の型に対してfalseを返すこと', () => {
        expect(isDensityData(layoutData)).toBe(false);
        expect(isDensityData(rhythmData)).toBe(false);
      });
    });

    describe('isRhythmData', () => {
      it('RhythmDataに対してtrueを返すこと', () => {
        expect(isRhythmData(rhythmData)).toBe(true);
      });

      it('他の型に対してfalseを返すこと', () => {
        expect(isRhythmData(layoutData)).toBe(false);
        expect(isRhythmData(densityData)).toBe(false);
      });
    });

    describe('isSectionBoundariesData', () => {
      it('SectionBoundariesDataに対してtrueを返すこと', () => {
        expect(isSectionBoundariesData(sectionBoundariesData)).toBe(true);
      });

      it('他の型に対してfalseを返すこと', () => {
        expect(isSectionBoundariesData(layoutData)).toBe(false);
        expect(isSectionBoundariesData(colorData)).toBe(false);
      });
    });
  });

  // ===========================================================================
  // IVisionAnalyzer インターフェース テスト
  // ===========================================================================

  describe('IVisionAnalyzer インターフェース', () => {
    it('インターフェースの構造が正しいこと', () => {
      // Mock実装を使用してインターフェースの構造をテスト
      const mockAnalyzer: IVisionAnalyzer = {
        name: 'MockVisionAnalyzer',
        modelName: 'mock-vision-1.0',
        isAvailable: async () => true,
        analyze: async (options: VisionAnalysisOptions): Promise<VisionAnalysisResult> => ({
          success: true,
          features: [],
          processingTimeMs: 100,
          modelName: 'mock-vision-1.0',
        }),
        generateTextRepresentation: (result: VisionAnalysisResult): string => {
          return `Features: ${result.features.length}`;
        },
      };

      // 型チェック: コンパイルが通ればOK
      expect(mockAnalyzer.name).toBe('MockVisionAnalyzer');
      expect(mockAnalyzer.modelName).toBe('mock-vision-1.0');
      expect(typeof mockAnalyzer.isAvailable).toBe('function');
      expect(typeof mockAnalyzer.analyze).toBe('function');
      expect(typeof mockAnalyzer.generateTextRepresentation).toBe('function');
    });

    it('isAvailableがPromise<boolean>を返すこと', async () => {
      const mockAnalyzer: IVisionAnalyzer = {
        name: 'Test',
        modelName: 'test',
        isAvailable: async () => false,
        analyze: async () => ({
          success: false,
          features: [],
          error: 'Not available',
          processingTimeMs: 0,
          modelName: 'test',
        }),
        generateTextRepresentation: () => '',
      };

      const result = await mockAnalyzer.isAvailable();
      expect(typeof result).toBe('boolean');
    });

    it('analyzeがPromise<VisionAnalysisResult>を返すこと', async () => {
      const mockAnalyzer: IVisionAnalyzer = {
        name: 'Test',
        modelName: 'test',
        isAvailable: async () => true,
        analyze: async (options) => ({
          success: true,
          features: [
            {
              type: 'density',
              confidence: 0.8,
              data: {
                type: 'density',
                level: 'balanced',
                description: 'Test',
              },
            },
          ],
          processingTimeMs: 500,
          modelName: 'test',
        }),
        generateTextRepresentation: (result) => `Features: ${result.features.length}`,
      };

      const result = await mockAnalyzer.analyze({
        imageBuffer: Buffer.from('test'),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.features).toHaveLength(1);
      expect(result.modelName).toBe('test');
    });

    it('generateTextRepresentationが文字列を返すこと', () => {
      const mockAnalyzer: IVisionAnalyzer = {
        name: 'Test',
        modelName: 'test',
        isAvailable: async () => true,
        analyze: async () => ({
          success: true,
          features: [],
          processingTimeMs: 100,
          modelName: 'test',
        }),
        generateTextRepresentation: (result) => {
          const parts: string[] = [];
          result.features.forEach((f) => {
            if (isLayoutStructureData(f.data)) {
              parts.push(`Layout: ${f.data.gridType}`);
            }
            if (isDensityData(f.data)) {
              parts.push(`Density: ${f.data.level}`);
            }
          });
          return parts.join(', ') || 'No features detected';
        },
      };

      const result = mockAnalyzer.generateTextRepresentation({
        success: true,
        features: [
          {
            type: 'layout_structure',
            confidence: 0.9,
            data: {
              type: 'layout_structure',
              gridType: 'grid',
              mainAreas: [],
              description: 'Test',
            },
          },
        ],
        processingTimeMs: 100,
        modelName: 'test',
      });

      expect(typeof result).toBe('string');
      expect(result).toContain('Layout: grid');
    });
  });

  // ===========================================================================
  // VisionAdapterFactory テスト
  // ===========================================================================

  describe('VisionAdapterFactory', () => {
    it('ファクトリ関数がIVisionAnalyzerを返すこと', () => {
      const factory: VisionAdapterFactory = () => ({
        name: 'FactoryCreatedAnalyzer',
        modelName: 'factory-model',
        isAvailable: async () => true,
        analyze: async () => ({
          success: true,
          features: [],
          processingTimeMs: 0,
          modelName: 'factory-model',
        }),
        generateTextRepresentation: () => '',
      });

      const analyzer = factory();

      expect(analyzer.name).toBe('FactoryCreatedAnalyzer');
      expect(typeof analyzer.isAvailable).toBe('function');
      expect(typeof analyzer.analyze).toBe('function');
    });
  });
});

// =============================================================================
// 統合テスト
// =============================================================================

describe('統合テスト: 型の整合性', () => {
  it('VisionFeatureのtypeとdataのtypeが一致すること', () => {
    // 正しいパターン
    const validFeature: VisionFeature = {
      type: 'layout_structure',
      confidence: 0.9,
      data: {
        type: 'layout_structure', // typeが一致
        gridType: 'single-column',
        mainAreas: [],
        description: 'Test',
      },
    };

    expect(validFeature.type).toBe(validFeature.data.type);
  });

  it('すべての特徴タイプに対応するデータ型が存在すること', () => {
    const featureTypes: VisionFeatureType[] = [
      'layout_structure',
      'color_palette',
      'typography',
      'visual_hierarchy',
      'whitespace',
      'density',
      'rhythm',
      'section_boundaries',
    ];

    const typeGuards = [
      isLayoutStructureData,
      isColorPaletteData,
      isTypographyData,
      isVisualHierarchyData,
      isWhitespaceData,
      isDensityData,
      isRhythmData,
      isSectionBoundariesData,
    ];

    // 8つの特徴タイプに対して8つの型ガードが存在
    expect(featureTypes.length).toBe(typeGuards.length);
    expect(featureTypes.length).toBe(8);
  });
});
