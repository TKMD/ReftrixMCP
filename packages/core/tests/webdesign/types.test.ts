// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Webdesign Types Tests
 * TDD: Webデザイン解析機能の型定義テスト
 *
 * テスト対象:
 * - SourceType, UsageScope, AwardSource enum types
 * - SectionType, MotionType enum types
 * - SourceInfo, PageMetadata, ViewportInfo interfaces
 * - IngestOptions, IngestResult interfaces
 * - SectionPatternData, MotionPatternData interfaces
 * - QualityScore, LayoutInspectResult interfaces
 * - CodeGenerateOptions, GeneratedCodeResult interfaces
 *
 * Reference: /docs/plans/webdesign/07-database-schema.md
 */

import { describe, it, expect } from 'vitest';
import {
  // Enums / Literal types
  sourceTypeSchema,
  usageScopeSchema,
  awardSourceSchema,
  sectionTypeSchema,
  motionTypeSchema,
  analysisStatusSchema,
  // Interfaces (via Zod schemas)
  sourceInfoSchema,
  pageMetadataSchema,
  viewportInfoSchema,
  screenshotResultSchema,
  ingestOptionsSchema,
  ingestResultSchema,
  gridStructureSchema,
  componentNodeSchema,
  sectionPatternDataSchema,
  motionPatternDataSchema,
  qualityScoreSchema,
  layoutInspectResultSchema,
  codeGenerateOptionsSchema,
  generatedCodeResultSchema,
  // Type exports
  type SourceType,
  type UsageScope,
  type AwardSource,
  type SectionType,
  type MotionType,
  type AnalysisStatus,
  type SourceInfo,
  type PageMetadata,
  type ViewportInfo,
  type ScreenshotResult,
  type IngestOptions,
  type IngestResult,
  type GridStructure,
  type ComponentNode,
  type SectionPatternData,
  type MotionPatternData,
  type QualityScore,
  type LayoutInspectResult,
  type CodeGenerateOptions,
  type GeneratedCodeResult,
} from '../../src/webdesign';

// 開発環境ログ出力
if (process.env.NODE_ENV === 'development') {
  console.log('[Test] Running: webdesign/types.test.ts');
}

// =========================================
// SourceType Tests
// =========================================
describe('sourceTypeSchema', () => {
  describe('正常系テスト', () => {
    it('award_gallery を受け入れる', () => {
      const result = sourceTypeSchema.safeParse('award_gallery');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('award_gallery');
      }
    });

    it('user_provided を受け入れる', () => {
      const result = sourceTypeSchema.safeParse('user_provided');
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効な値を拒否する', () => {
      const result = sourceTypeSchema.safeParse('invalid_type');
      expect(result.success).toBe(false);
    });

    it('空文字列を拒否する', () => {
      const result = sourceTypeSchema.safeParse('');
      expect(result.success).toBe(false);
    });

    it('nullを拒否する', () => {
      const result = sourceTypeSchema.safeParse(null);
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// UsageScope Tests
// =========================================
describe('usageScopeSchema', () => {
  describe('正常系テスト', () => {
    it('inspiration_only を受け入れる', () => {
      const result = usageScopeSchema.safeParse('inspiration_only');
      expect(result.success).toBe(true);
    });

    it('owned_asset を受け入れる', () => {
      const result = usageScopeSchema.safeParse('owned_asset');
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効な値を拒否する', () => {
      const result = usageScopeSchema.safeParse('commercial');
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// AwardSource Tests
// =========================================
describe('awardSourceSchema', () => {
  describe('正常系テスト', () => {
    it('cssda を受け入れる', () => {
      const result = awardSourceSchema.safeParse('cssda');
      expect(result.success).toBe(true);
    });

    it('fwa を受け入れる', () => {
      const result = awardSourceSchema.safeParse('fwa');
      expect(result.success).toBe(true);
    });

    it('awwwards を受け入れる', () => {
      const result = awardSourceSchema.safeParse('awwwards');
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効なアワードソースを拒否する', () => {
      const result = awardSourceSchema.safeParse('behance');
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// SectionType Tests
// =========================================
describe('sectionTypeSchema', () => {
  const validSectionTypes = [
    'hero',
    'feature',
    'cta',
    'testimonial',
    'pricing',
    'footer',
    'navigation',
    'about',
    'contact',
    'gallery',
    'unknown',
  ];

  describe('正常系テスト', () => {
    validSectionTypes.forEach((sectionType) => {
      it(`${sectionType} を受け入れる`, () => {
        const result = sectionTypeSchema.safeParse(sectionType);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('異常系テスト', () => {
    it('無効なセクションタイプを拒否する', () => {
      const result = sectionTypeSchema.safeParse('invalid_section');
      expect(result.success).toBe(false);
    });

    it('数値を拒否する', () => {
      const result = sectionTypeSchema.safeParse(123);
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// MotionType Tests
// =========================================
describe('motionTypeSchema', () => {
  const validMotionTypes = [
    'scroll_trigger',
    'hover',
    'page_transition',
    'loading',
    'parallax',
    'reveal',
    'unknown',
  ];

  describe('正常系テスト', () => {
    validMotionTypes.forEach((motionType) => {
      it(`${motionType} を受け入れる`, () => {
        const result = motionTypeSchema.safeParse(motionType);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('異常系テスト', () => {
    it('無効なモーションタイプを拒否する', () => {
      const result = motionTypeSchema.safeParse('bounce');
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// AnalysisStatus Tests
// =========================================
describe('analysisStatusSchema', () => {
  const validStatuses = ['pending', 'processing', 'completed', 'failed'];

  describe('正常系テスト', () => {
    validStatuses.forEach((status) => {
      it(`${status} を受け入れる`, () => {
        const result = analysisStatusSchema.safeParse(status);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('異常系テスト', () => {
    it('無効なステータスを拒否する', () => {
      const result = analysisStatusSchema.safeParse('running');
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// SourceInfo Tests
// =========================================
describe('sourceInfoSchema', () => {
  const validSourceInfo = {
    type: 'award_gallery' as const,
    usageScope: 'inspiration_only' as const,
    awardSource: 'awwwards' as const,
    licenseNote: 'For inspiration only',
  };

  describe('正常系テスト', () => {
    it('有効なSourceInfoを受け入れる', () => {
      const result = sourceInfoSchema.safeParse(validSourceInfo);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('award_gallery');
        expect(result.data.usageScope).toBe('inspiration_only');
        expect(result.data.awardSource).toBe('awwwards');
      }
    });

    it('オプションフィールドなしでも受け入れる', () => {
      const minimalSourceInfo = {
        type: 'user_provided',
        usageScope: 'owned_asset',
      };
      const result = sourceInfoSchema.safeParse(minimalSourceInfo);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.awardSource).toBeUndefined();
        expect(result.data.licenseNote).toBeUndefined();
      }
    });
  });

  describe('異常系テスト', () => {
    it('無効なtypeを拒否する', () => {
      const invalidSourceInfo = { ...validSourceInfo, type: 'invalid' };
      const result = sourceInfoSchema.safeParse(invalidSourceInfo);
      expect(result.success).toBe(false);
    });

    it('必須フィールドが欠けている場合を拒否する', () => {
      const result = sourceInfoSchema.safeParse({ type: 'award_gallery' });
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// PageMetadata Tests
// =========================================
describe('pageMetadataSchema', () => {
  const validPageMetadata = {
    title: 'Modern SaaS Landing Page',
    description: 'A beautifully designed landing page',
    ogImage: 'https://example.com/og.png',
    keywords: ['saas', 'landing', 'modern'],
  };

  describe('正常系テスト', () => {
    it('有効なPageMetadataを受け入れる', () => {
      const result = pageMetadataSchema.safeParse(validPageMetadata);
      expect(result.success).toBe(true);
    });

    it('空のオブジェクトを受け入れる（全てオプション）', () => {
      const result = pageMetadataSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('日本語タイトルを受け入れる', () => {
      const result = pageMetadataSchema.safeParse({
        title: '美しいランディングページ',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効なURL形式のogImageを拒否する', () => {
      const invalidMetadata = { ...validPageMetadata, ogImage: 'not-a-url' };
      const result = pageMetadataSchema.safeParse(invalidMetadata);
      expect(result.success).toBe(false);
    });

    it('keywordsが文字列配列でない場合を拒否する', () => {
      const invalidMetadata = { ...validPageMetadata, keywords: 'not-array' };
      const result = pageMetadataSchema.safeParse(invalidMetadata);
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// ViewportInfo Tests
// =========================================
describe('viewportInfoSchema', () => {
  const validViewportInfo = {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
  };

  describe('正常系テスト', () => {
    it('有効なViewportInfoを受け入れる', () => {
      const result = viewportInfoSchema.safeParse(validViewportInfo);
      expect(result.success).toBe(true);
    });

    it('高DPIデバイスのスケールファクターを受け入れる', () => {
      const result = viewportInfoSchema.safeParse({
        ...validViewportInfo,
        deviceScaleFactor: 2,
      });
      expect(result.success).toBe(true);
    });

    it('モバイルサイズを受け入れる', () => {
      const result = viewportInfoSchema.safeParse({
        width: 375,
        height: 812,
        deviceScaleFactor: 3,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('負のwidth値を拒否する', () => {
      const result = viewportInfoSchema.safeParse({
        ...validViewportInfo,
        width: -100,
      });
      expect(result.success).toBe(false);
    });

    it('ゼロのheight値を拒否する', () => {
      const result = viewportInfoSchema.safeParse({
        ...validViewportInfo,
        height: 0,
      });
      expect(result.success).toBe(false);
    });

    it('負のdeviceScaleFactorを拒否する', () => {
      const result = viewportInfoSchema.safeParse({
        ...validViewportInfo,
        deviceScaleFactor: -1,
      });
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// ScreenshotResult Tests
// =========================================
describe('screenshotResultSchema', () => {
  const validScreenshotResult = {
    buffer: Buffer.from('fake-image-data'),
    mimeType: 'image/png' as const,
    viewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    },
  };

  describe('正常系テスト', () => {
    it('有効なScreenshotResultを受け入れる', () => {
      const result = screenshotResultSchema.safeParse(validScreenshotResult);
      expect(result.success).toBe(true);
    });

    it('image/jpeg mimeTypeを受け入れる', () => {
      const result = screenshotResultSchema.safeParse({
        ...validScreenshotResult,
        mimeType: 'image/jpeg',
      });
      expect(result.success).toBe(true);
    });

    it('image/webp mimeTypeを受け入れる', () => {
      const result = screenshotResultSchema.safeParse({
        ...validScreenshotResult,
        mimeType: 'image/webp',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効なmimeTypeを拒否する', () => {
      const result = screenshotResultSchema.safeParse({
        ...validScreenshotResult,
        mimeType: 'image/gif',
      });
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// IngestOptions Tests
// =========================================
describe('ingestOptionsSchema', () => {
  const validIngestOptions = {
    url: 'https://example.com',
    viewport: {
      width: 1920,
      height: 1080,
    },
    fullPage: true,
    waitForSelector: '.main-content',
    timeout: 30000,
    source: {
      type: 'user_provided',
      usageScope: 'owned_asset',
    },
  };

  describe('正常系テスト', () => {
    it('有効なIngestOptionsを受け入れる', () => {
      const result = ingestOptionsSchema.safeParse(validIngestOptions);
      expect(result.success).toBe(true);
    });

    it('URL以外全てオプションで受け入れる', () => {
      const result = ingestOptionsSchema.safeParse({
        url: 'https://example.com',
      });
      expect(result.success).toBe(true);
    });

    it('日本語サイトのURLを受け入れる', () => {
      const result = ingestOptionsSchema.safeParse({
        url: 'https://example.jp/page',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('urlが欠けている場合を拒否する', () => {
      const result = ingestOptionsSchema.safeParse({
        fullPage: true,
      });
      expect(result.success).toBe(false);
    });

    it('無効なURL形式を拒否する', () => {
      const result = ingestOptionsSchema.safeParse({
        url: 'not-a-valid-url',
      });
      expect(result.success).toBe(false);
    });

    it('負のtimeoutを拒否する', () => {
      const result = ingestOptionsSchema.safeParse({
        url: 'https://example.com',
        timeout: -1000,
      });
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// IngestResult Tests
// =========================================
describe('ingestResultSchema', () => {
  const validIngestResult = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    url: 'https://example.com',
    html: '<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>',
    metadata: {
      title: 'Test Page',
    },
    source: {
      type: 'user_provided',
      usageScope: 'owned_asset',
    },
    crawledAt: new Date(),
  };

  describe('正常系テスト', () => {
    it('有効なIngestResultを受け入れる', () => {
      const result = ingestResultSchema.safeParse(validIngestResult);
      expect(result.success).toBe(true);
    });

    it('スクリーンショット付きを受け入れる', () => {
      const resultWithScreenshot = {
        ...validIngestResult,
        screenshot: {
          buffer: Buffer.from('fake-image'),
          mimeType: 'image/png',
          viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
        },
      };
      const result = ingestResultSchema.safeParse(resultWithScreenshot);
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効なUUID形式のidを拒否する', () => {
      const result = ingestResultSchema.safeParse({
        ...validIngestResult,
        id: 'invalid-uuid',
      });
      expect(result.success).toBe(false);
    });

    it('htmlが欠けている場合を拒否する', () => {
      const { html, ...withoutHtml } = validIngestResult;
      const result = ingestResultSchema.safeParse(withoutHtml);
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// GridStructure Tests
// =========================================
describe('gridStructureSchema', () => {
  const validGridStructure = {
    columns: 3,
    rows: 2,
    gap: '1rem',
    areas: ['header', 'main', 'sidebar'],
  };

  describe('正常系テスト', () => {
    it('有効なGridStructureを受け入れる', () => {
      const result = gridStructureSchema.safeParse(validGridStructure);
      expect(result.success).toBe(true);
    });

    it('最小限のグリッド構造を受け入れる', () => {
      const result = gridStructureSchema.safeParse({
        columns: 1,
        rows: 1,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('columnsが0の場合を拒否する', () => {
      const result = gridStructureSchema.safeParse({
        ...validGridStructure,
        columns: 0,
      });
      expect(result.success).toBe(false);
    });

    it('負のrows値を拒否する', () => {
      const result = gridStructureSchema.safeParse({
        ...validGridStructure,
        rows: -1,
      });
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// ComponentNode Tests
// =========================================
describe('componentNodeSchema', () => {
  const validComponentNode = {
    tag: 'div',
    className: 'container mx-auto',
    role: 'main',
    children: [
      {
        tag: 'h1',
        className: 'text-4xl font-bold',
      },
      {
        tag: 'p',
        className: 'text-gray-600',
      },
    ],
  };

  describe('正常系テスト', () => {
    it('有効なComponentNodeを受け入れる', () => {
      const result = componentNodeSchema.safeParse(validComponentNode);
      expect(result.success).toBe(true);
    });

    it('tagのみでも受け入れる', () => {
      const result = componentNodeSchema.safeParse({ tag: 'span' });
      expect(result.success).toBe(true);
    });

    it('深いネスト構造を受け入れる', () => {
      const deepNested = {
        tag: 'div',
        children: [
          {
            tag: 'section',
            children: [
              {
                tag: 'article',
                children: [{ tag: 'p' }],
              },
            ],
          },
        ],
      };
      const result = componentNodeSchema.safeParse(deepNested);
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('tagが欠けている場合を拒否する', () => {
      const result = componentNodeSchema.safeParse({
        className: 'test-class',
      });
      expect(result.success).toBe(false);
    });

    it('空のtagを拒否する', () => {
      const result = componentNodeSchema.safeParse({ tag: '' });
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// SectionPatternData Tests
// =========================================
describe('sectionPatternDataSchema', () => {
  const validSectionPatternData = {
    sectionType: 'hero' as const,
    sectionIndex: 0,
    htmlFragment: '<section class="hero">...</section>',
    cssStyles: {
      display: 'flex',
      padding: '4rem',
    },
    gridStructure: {
      columns: 2,
      rows: 1,
    },
    componentTree: {
      tag: 'section',
      className: 'hero',
    },
    textRepresentation: 'Hero section with 2-column layout',
  };

  describe('正常系テスト', () => {
    it('有効なSectionPatternDataを受け入れる', () => {
      const result = sectionPatternDataSchema.safeParse(validSectionPatternData);
      expect(result.success).toBe(true);
    });

    it('必須フィールドのみでも受け入れる', () => {
      const result = sectionPatternDataSchema.safeParse({
        sectionType: 'footer',
        sectionIndex: 5,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効なsectionTypeを拒否する', () => {
      const result = sectionPatternDataSchema.safeParse({
        ...validSectionPatternData,
        sectionType: 'invalid_type',
      });
      expect(result.success).toBe(false);
    });

    it('負のsectionIndexを拒否する', () => {
      const result = sectionPatternDataSchema.safeParse({
        ...validSectionPatternData,
        sectionIndex: -1,
      });
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// MotionPatternData Tests
// =========================================
describe('motionPatternDataSchema', () => {
  const validMotionPatternData = {
    motionType: 'scroll_trigger' as const,
    triggerElement: '.hero-section',
    targetElement: '.hero-content',
    cssAnimation: '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }',
    jsImplementation: 'gsap.from(".hero-content", { opacity: 0 })',
    duration: 600,
    easing: 'ease-out',
    delay: 100,
    textRepresentation: 'Fade in animation on scroll trigger',
  };

  describe('正常系テスト', () => {
    it('有効なMotionPatternDataを受け入れる', () => {
      const result = motionPatternDataSchema.safeParse(validMotionPatternData);
      expect(result.success).toBe(true);
    });

    it('motionTypeのみでも受け入れる', () => {
      const result = motionPatternDataSchema.safeParse({
        motionType: 'hover',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効なmotionTypeを拒否する', () => {
      const result = motionPatternDataSchema.safeParse({
        ...validMotionPatternData,
        motionType: 'bounce',
      });
      expect(result.success).toBe(false);
    });

    it('負のdurationを拒否する', () => {
      const result = motionPatternDataSchema.safeParse({
        ...validMotionPatternData,
        duration: -100,
      });
      expect(result.success).toBe(false);
    });

    it('負のdelayを拒否する', () => {
      const result = motionPatternDataSchema.safeParse({
        ...validMotionPatternData,
        delay: -50,
      });
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// QualityScore Tests
// =========================================
describe('qualityScoreSchema', () => {
  const validQualityScore = {
    visualMotifsScore: 85,
    compositionScore: 90,
    contextScore: 78,
    overallScore: 84,
    detectedPatterns: ['hero-left-aligned', 'feature-grid-3col'],
    humanCraftedEvidence: ['unique typography', 'custom illustrations'],
  };

  describe('正常系テスト', () => {
    it('有効なQualityScoreを受け入れる', () => {
      const result = qualityScoreSchema.safeParse(validQualityScore);
      expect(result.success).toBe(true);
    });

    it('スコアのみでも受け入れる', () => {
      const result = qualityScoreSchema.safeParse({
        visualMotifsScore: 50,
        compositionScore: 60,
        contextScore: 70,
        overallScore: 60,
      });
      expect(result.success).toBe(true);
    });

    it('最大スコア100を受け入れる', () => {
      const result = qualityScoreSchema.safeParse({
        visualMotifsScore: 100,
        compositionScore: 100,
        contextScore: 100,
        overallScore: 100,
      });
      expect(result.success).toBe(true);
    });

    it('最小スコア0を受け入れる', () => {
      const result = qualityScoreSchema.safeParse({
        visualMotifsScore: 0,
        compositionScore: 0,
        contextScore: 0,
        overallScore: 0,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('100を超えるスコアを拒否する', () => {
      const result = qualityScoreSchema.safeParse({
        ...validQualityScore,
        visualMotifsScore: 101,
      });
      expect(result.success).toBe(false);
    });

    it('負のスコアを拒否する', () => {
      const result = qualityScoreSchema.safeParse({
        ...validQualityScore,
        compositionScore: -10,
      });
      expect(result.success).toBe(false);
    });

    it('必須フィールドが欠けている場合を拒否する', () => {
      const { overallScore, ...withoutOverall } = validQualityScore;
      const result = qualityScoreSchema.safeParse(withoutOverall);
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// LayoutInspectResult Tests
// =========================================
describe('layoutInspectResultSchema', () => {
  const validLayoutInspectResult = {
    webPageId: '550e8400-e29b-41d4-a716-446655440000',
    sections: [
      {
        sectionType: 'hero',
        sectionIndex: 0,
      },
      {
        sectionType: 'feature',
        sectionIndex: 1,
      },
    ],
    motions: [
      {
        motionType: 'scroll_trigger',
      },
    ],
    qualityScore: {
      visualMotifsScore: 80,
      compositionScore: 85,
      contextScore: 75,
      overallScore: 80,
    },
  };

  describe('正常系テスト', () => {
    it('有効なLayoutInspectResultを受け入れる', () => {
      const result = layoutInspectResultSchema.safeParse(validLayoutInspectResult);
      expect(result.success).toBe(true);
    });

    it('空のsectionsとmotionsを受け入れる', () => {
      const result = layoutInspectResultSchema.safeParse({
        webPageId: '550e8400-e29b-41d4-a716-446655440000',
        sections: [],
        motions: [],
      });
      expect(result.success).toBe(true);
    });

    it('qualityScoreなしでも受け入れる', () => {
      const { qualityScore, ...withoutQuality } = validLayoutInspectResult;
      const result = layoutInspectResultSchema.safeParse(withoutQuality);
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効なUUID形式のwebPageIdを拒否する', () => {
      const result = layoutInspectResultSchema.safeParse({
        ...validLayoutInspectResult,
        webPageId: 'invalid-uuid',
      });
      expect(result.success).toBe(false);
    });

    it('sectionsが欠けている場合を拒否する', () => {
      const result = layoutInspectResultSchema.safeParse({
        webPageId: '550e8400-e29b-41d4-a716-446655440000',
        motions: [],
      });
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// CodeGenerateOptions Tests
// =========================================
describe('codeGenerateOptionsSchema', () => {
  const validCodeGenerateOptions = {
    codeType: 'react' as const,
    paletteId: '550e8400-e29b-41d4-a716-446655440000',
    productionReady: false,
  };

  describe('正常系テスト', () => {
    it('有効なCodeGenerateOptionsを受け入れる', () => {
      const result = codeGenerateOptionsSchema.safeParse(validCodeGenerateOptions);
      expect(result.success).toBe(true);
    });

    it('codeTypeのみでも受け入れる', () => {
      const result = codeGenerateOptionsSchema.safeParse({
        codeType: 'html',
      });
      expect(result.success).toBe(true);
    });

    it('tailwindコードタイプを受け入れる', () => {
      const result = codeGenerateOptionsSchema.safeParse({
        codeType: 'tailwind',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効なcodeTypeを拒否する', () => {
      const result = codeGenerateOptionsSchema.safeParse({
        codeType: 'vue',
      });
      expect(result.success).toBe(false);
    });

    it('無効なUUID形式のpaletteIdを拒否する', () => {
      const result = codeGenerateOptionsSchema.safeParse({
        codeType: 'react',
        paletteId: 'invalid-uuid',
      });
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// GeneratedCodeResult Tests
// =========================================
describe('generatedCodeResultSchema', () => {
  const validGeneratedCodeResult = {
    code: '<div className="hero">...</div>',
    codeType: 'react' as const,
    inspirationUrls: ['https://awwwards.com/sites/example'],
    usageScope: 'inspiration_only' as const,
    productionReady: false,
    qualityNotes: 'Code requires review before production use',
  };

  describe('正常系テスト', () => {
    it('有効なGeneratedCodeResultを受け入れる', () => {
      const result = generatedCodeResultSchema.safeParse(validGeneratedCodeResult);
      expect(result.success).toBe(true);
    });

    it('qualityNotesなしでも受け入れる', () => {
      const { qualityNotes, ...withoutNotes } = validGeneratedCodeResult;
      const result = generatedCodeResultSchema.safeParse(withoutNotes);
      expect(result.success).toBe(true);
    });

    it('空のinspirationUrlsを受け入れる', () => {
      const result = generatedCodeResultSchema.safeParse({
        ...validGeneratedCodeResult,
        inspirationUrls: [],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('異常系テスト', () => {
    it('無効なcodeTypeを拒否する', () => {
      const result = generatedCodeResultSchema.safeParse({
        ...validGeneratedCodeResult,
        codeType: 'svelte',
      });
      expect(result.success).toBe(false);
    });

    it('無効なURL形式のinspirationUrlsを拒否する', () => {
      const result = generatedCodeResultSchema.safeParse({
        ...validGeneratedCodeResult,
        inspirationUrls: ['not-a-url'],
      });
      expect(result.success).toBe(false);
    });

    it('codeが欠けている場合を拒否する', () => {
      const { code, ...withoutCode } = validGeneratedCodeResult;
      const result = generatedCodeResultSchema.safeParse(withoutCode);
      expect(result.success).toBe(false);
    });
  });
});

// =========================================
// Type Export Tests
// =========================================
describe('型エクスポートの確認', () => {
  it('SourceType型が正しくエクスポートされている', () => {
    const sourceType: SourceType = 'award_gallery';
    expect(sourceType).toBeDefined();
  });

  it('UsageScope型が正しくエクスポートされている', () => {
    const usageScope: UsageScope = 'inspiration_only';
    expect(usageScope).toBeDefined();
  });

  it('AwardSource型が正しくエクスポートされている', () => {
    const awardSource: AwardSource = 'awwwards';
    expect(awardSource).toBeDefined();
  });

  it('SectionType型が正しくエクスポートされている', () => {
    const sectionType: SectionType = 'hero';
    expect(sectionType).toBeDefined();
  });

  it('MotionType型が正しくエクスポートされている', () => {
    const motionType: MotionType = 'scroll_trigger';
    expect(motionType).toBeDefined();
  });

  it('AnalysisStatus型が正しくエクスポートされている', () => {
    const status: AnalysisStatus = 'completed';
    expect(status).toBeDefined();
  });

  it('SourceInfo型が正しくエクスポートされている', () => {
    const sourceInfo: SourceInfo = {
      type: 'user_provided',
      usageScope: 'owned_asset',
    };
    expect(sourceInfo.type).toBeDefined();
  });

  it('PageMetadata型が正しくエクスポートされている', () => {
    const metadata: PageMetadata = {
      title: 'Test',
    };
    expect(metadata.title).toBeDefined();
  });

  it('ViewportInfo型が正しくエクスポートされている', () => {
    const viewport: ViewportInfo = {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    };
    expect(viewport.width).toBeDefined();
  });

  it('ScreenshotResult型が正しくエクスポートされている', () => {
    const screenshot: ScreenshotResult = {
      buffer: Buffer.from('test'),
      mimeType: 'image/png',
      viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    };
    expect(screenshot.mimeType).toBeDefined();
  });

  it('IngestOptions型が正しくエクスポートされている', () => {
    const options: IngestOptions = {
      url: 'https://example.com',
    };
    expect(options.url).toBeDefined();
  });

  it('IngestResult型が正しくエクスポートされている', () => {
    const result: IngestResult = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      url: 'https://example.com',
      html: '<html></html>',
      metadata: {},
      source: { type: 'user_provided', usageScope: 'owned_asset' },
      crawledAt: new Date(),
    };
    expect(result.id).toBeDefined();
  });

  it('GridStructure型が正しくエクスポートされている', () => {
    const grid: GridStructure = {
      columns: 3,
      rows: 2,
    };
    expect(grid.columns).toBeDefined();
  });

  it('ComponentNode型が正しくエクスポートされている', () => {
    const node: ComponentNode = {
      tag: 'div',
    };
    expect(node.tag).toBeDefined();
  });

  it('SectionPatternData型が正しくエクスポートされている', () => {
    const section: SectionPatternData = {
      sectionType: 'hero',
      sectionIndex: 0,
    };
    expect(section.sectionType).toBeDefined();
  });

  it('MotionPatternData型が正しくエクスポートされている', () => {
    const motion: MotionPatternData = {
      motionType: 'hover',
    };
    expect(motion.motionType).toBeDefined();
  });

  it('QualityScore型が正しくエクスポートされている', () => {
    const score: QualityScore = {
      visualMotifsScore: 80,
      compositionScore: 80,
      contextScore: 80,
      overallScore: 80,
    };
    expect(score.overallScore).toBeDefined();
  });

  it('LayoutInspectResult型が正しくエクスポートされている', () => {
    const result: LayoutInspectResult = {
      webPageId: '550e8400-e29b-41d4-a716-446655440000',
      sections: [],
      motions: [],
    };
    expect(result.webPageId).toBeDefined();
  });

  it('CodeGenerateOptions型が正しくエクスポートされている', () => {
    const options: CodeGenerateOptions = {
      codeType: 'react',
    };
    expect(options.codeType).toBeDefined();
  });

  it('GeneratedCodeResult型が正しくエクスポートされている', () => {
    const result: GeneratedCodeResult = {
      code: '<div></div>',
      codeType: 'html',
      inspirationUrls: [],
      usageScope: 'owned_asset',
      productionReady: false,
    };
    expect(result.code).toBeDefined();
  });
});
