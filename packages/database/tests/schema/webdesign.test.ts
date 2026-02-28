// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @file webdesign.test.ts
 * @description Webデザイン解析機能用のPrismaスキーマテスト
 *
 * TDD Red Phase: スキーマが正しく定義されていることを検証するテスト
 * - モデルの存在確認
 * - フィールド型の確認
 * - リレーションの正確性確認
 */

import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';

// Prisma Client のモデル型をテストするためのヘルパー
type ModelNames = Prisma.ModelName;

describe('Webdesign Schema - モデル存在確認', () => {
  describe('WebPage モデル', () => {
    it('WebPage モデルが存在すること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).toContain('WebPage');
    });

    it('WebPage の必須フィールドが正しく定義されていること', () => {
      // 型レベルでのフィールド存在確認
      type WebPageFields = keyof Prisma.WebPageCreateInput;

      // 必須フィールド確認
      const requiredFields: WebPageFields[] = [
        'url',
        'sourceType',
        'usageScope',
      ];

      requiredFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });

    it('WebPage のオプショナルフィールドが正しく定義されていること', () => {
      type WebPageFields = keyof Prisma.WebPageCreateInput;

      const optionalFields: WebPageFields[] = [
        'title',
        'description',
        'sourcePlatform',
        'awardInfo',
        'licenseNote',
        'htmlContent',
        'htmlHash',
        'screenshotDesktopUrl',
        'screenshotMobileUrl',
        'screenshotFullUrl',
        'analysisStatus',
        'analyzedAt',
        'analysisVersion',
        'metadata',
      ];

      optionalFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });
  });

  describe('SectionPattern モデル', () => {
    it('SectionPattern モデルが存在すること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).toContain('SectionPattern');
    });

    it('SectionPattern の必須フィールドが正しく定義されていること', () => {
      type SectionPatternFields = keyof Prisma.SectionPatternCreateInput;

      const requiredFields: SectionPatternFields[] = [
        'sectionType',
        'positionIndex',
        'layoutInfo',
        'webPage', // リレーション
      ];

      requiredFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });

    it('SectionPattern のオプショナルフィールドが正しく定義されていること', () => {
      type SectionPatternFields = keyof Prisma.SectionPatternCreateInput;

      const optionalFields: SectionPatternFields[] = [
        'sectionName',
        'components',
        'visualFeatures',
        'htmlSnippet',
        'cssSnippet',
        'qualityScore',
        'tags',
        'metadata',
      ];

      optionalFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });
  });

  describe('SectionEmbedding モデル', () => {
    it('SectionEmbedding モデルが存在すること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).toContain('SectionEmbedding');
    });

    it('SectionEmbedding の必須フィールドが正しく定義されていること', () => {
      type SectionEmbeddingFields = keyof Prisma.SectionEmbeddingCreateInput;

      const requiredFields: SectionEmbeddingFields[] = [
        'modelVersion',
        'sectionPattern', // リレーション
      ];

      requiredFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });
  });

  describe('MotionPattern モデル', () => {
    it('MotionPattern モデルが存在すること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).toContain('MotionPattern');
    });

    it('MotionPattern の必須フィールドが正しく定義されていること', () => {
      type MotionPatternFields = keyof Prisma.MotionPatternCreateInput;

      const requiredFields: MotionPatternFields[] = [
        'name',
        'category',
        'triggerType',
        'animation',
        'implementation',
      ];

      requiredFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });

    it('MotionPattern のオプショナルフィールドが正しく定義されていること', () => {
      type MotionPatternFields = keyof Prisma.MotionPatternCreateInput;

      const optionalFields: MotionPatternFields[] = [
        'webPage', // リレーション (nullable)
        'type',
        'triggerConfig',
        'properties',
        'accessibility',
        'performance',
        'sourceUrl',
        'usageScope',
        'tags',
        'metadata',
      ];

      optionalFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });
  });

  describe('MotionEmbedding モデル', () => {
    it('MotionEmbedding モデルが存在すること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).toContain('MotionEmbedding');
    });

    it('MotionEmbedding の必須フィールドが正しく定義されていること', () => {
      type MotionEmbeddingFields = keyof Prisma.MotionEmbeddingCreateInput;

      const requiredFields: MotionEmbeddingFields[] = [
        'modelVersion',
        'motionPattern', // リレーション
      ];

      requiredFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });
  });

  // [DELETED OSS] GeneratedCode モデルは削除済み

  describe('QualityEvaluation モデル', () => {
    it('QualityEvaluation モデルが存在すること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).toContain('QualityEvaluation');
    });

    it('QualityEvaluation の必須フィールドが正しく定義されていること', () => {
      type QualityEvaluationFields = keyof Prisma.QualityEvaluationCreateInput;

      const requiredFields: QualityEvaluationFields[] = [
        'targetType',
        'targetId',
        'overallScore',
        'grade',
        'antiAiCliche',
        'evaluatorVersion',
      ];

      requiredFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });

    it('QualityEvaluation のオプショナルフィールドが正しく定義されていること', () => {
      type QualityEvaluationFields = keyof Prisma.QualityEvaluationCreateInput;

      const optionalFields: QualityEvaluationFields[] = [
        'designQuality',
        'technicalQuality',
        'recommendations',
        'evaluationMode',
      ];

      optionalFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });
  });
});

describe('Webdesign Schema - リレーション確認', () => {
  describe('WebPage リレーション', () => {
    it('WebPage から SectionPattern へのリレーションが定義されていること', () => {
      type WebPageInclude = Prisma.WebPageInclude;
      const hasRelation: keyof WebPageInclude = 'sectionPatterns';
      expect(hasRelation).toBe('sectionPatterns');
    });

    it('WebPage から MotionPattern へのリレーションが定義されていること', () => {
      type WebPageInclude = Prisma.WebPageInclude;
      const hasRelation: keyof WebPageInclude = 'motionPatterns';
      expect(hasRelation).toBe('motionPatterns');
    });
  });

  describe('SectionPattern リレーション', () => {
    it('SectionPattern から WebPage への外部キーが定義されていること', () => {
      type SectionPatternFields = keyof Prisma.SectionPatternWhereInput;
      const hasForeignKey: SectionPatternFields = 'webPageId';
      expect(hasForeignKey).toBe('webPageId');
    });

    it('SectionPattern から SectionEmbedding へのリレーションが定義されていること', () => {
      type SectionPatternInclude = Prisma.SectionPatternInclude;
      const hasRelation: keyof SectionPatternInclude = 'embedding';
      expect(hasRelation).toBe('embedding');
    });

    // [DELETED OSS] GeneratedCode リレーション確認は削除済み
  });

  describe('SectionEmbedding リレーション', () => {
    it('SectionEmbedding から SectionPattern への外部キーが定義されていること', () => {
      type SectionEmbeddingFields = keyof Prisma.SectionEmbeddingWhereInput;
      const hasForeignKey: SectionEmbeddingFields = 'sectionPatternId';
      expect(hasForeignKey).toBe('sectionPatternId');
    });

    it('SectionEmbedding の sectionPatternId がユニーク制約を持つこと', () => {
      // ユニーク制約はWhereUniqueInputで確認
      type SectionEmbeddingUniqueFields =
        keyof Prisma.SectionEmbeddingWhereUniqueInput;
      const hasUnique: SectionEmbeddingUniqueFields = 'sectionPatternId';
      expect(hasUnique).toBe('sectionPatternId');
    });
  });

  describe('MotionPattern リレーション', () => {
    it('MotionPattern から WebPage への外部キーが定義されていること（nullable）', () => {
      type MotionPatternFields = keyof Prisma.MotionPatternWhereInput;
      const hasForeignKey: MotionPatternFields = 'webPageId';
      expect(hasForeignKey).toBe('webPageId');
    });

    it('MotionPattern から MotionEmbedding へのリレーションが定義されていること', () => {
      type MotionPatternInclude = Prisma.MotionPatternInclude;
      const hasRelation: keyof MotionPatternInclude = 'embedding';
      expect(hasRelation).toBe('embedding');
    });
  });

  describe('MotionEmbedding リレーション', () => {
    it('MotionEmbedding から MotionPattern への外部キーが定義されていること', () => {
      type MotionEmbeddingFields = keyof Prisma.MotionEmbeddingWhereInput;
      const hasForeignKey: MotionEmbeddingFields = 'motionPatternId';
      expect(hasForeignKey).toBe('motionPatternId');
    });

    it('MotionEmbedding の motionPatternId がユニーク制約を持つこと', () => {
      type MotionEmbeddingUniqueFields =
        keyof Prisma.MotionEmbeddingWhereUniqueInput;
      const hasUnique: MotionEmbeddingUniqueFields = 'motionPatternId';
      expect(hasUnique).toBe('motionPatternId');
    });
  });

  // [DELETED OSS] GeneratedCode リレーションは削除済み
});

describe('Webdesign Schema - インデックス確認', () => {
  // インデックスの存在確認は実行時にPrismaが適切に動作することで検証
  // スキーマレベルでのテストとして、OrderByInputの存在を確認

  it('WebPage.url にユニーク制約が設定されていること', () => {
    type WebPageUniqueFields = keyof Prisma.WebPageWhereUniqueInput;
    const hasUnique: WebPageUniqueFields = 'url';
    expect(hasUnique).toBe('url');
  });

  it('WebPage でソート可能なフィールドが定義されていること', () => {
    type WebPageOrderByFields = keyof Prisma.WebPageOrderByWithRelationInput;
    const sortableFields: WebPageOrderByFields[] = [
      'crawledAt',
      'createdAt',
      'updatedAt',
    ];

    sortableFields.forEach((field) => {
      expect(typeof field).toBe('string');
    });
  });

  it('SectionPattern でソート可能なフィールドが定義されていること', () => {
    type SectionPatternOrderByFields =
      keyof Prisma.SectionPatternOrderByWithRelationInput;
    const sortableFields: SectionPatternOrderByFields[] = [
      'positionIndex',
      'createdAt',
      'updatedAt',
    ];

    sortableFields.forEach((field) => {
      expect(typeof field).toBe('string');
    });
  });

  it('QualityEvaluation でソート可能なフィールドが定義されていること', () => {
    type QualityEvaluationOrderByFields =
      keyof Prisma.QualityEvaluationOrderByWithRelationInput;
    const sortableFields: QualityEvaluationOrderByFields[] = [
      'overallScore',
      'evaluatedAt',
      'createdAt',
    ];

    sortableFields.forEach((field) => {
      expect(typeof field).toBe('string');
    });
  });
});

describe('Webdesign Schema - 既存モデルとの整合性', () => {
  it('BrandPalette モデルが存在すること（既存）', () => {
    const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
    expect(modelNames).toContain('BrandPalette');
  });

  // [DELETED OSS] GeneratedCode → BrandPalette リレーションは削除済み
});
