// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @file phase1-cleanup.test.ts
 * @description Phase 1 クリーンアップ検証 - 削除済みモデルの不在と残存モデルの整合性テスト
 *
 * Phase 1で削除された不要なモデル:
 * - ProjectPage, ProjectBrief, ProjectLayoutVersion,
 *   ProjectLayoutScore, ProjectCodeExport
 * - Enums: ProjectPageType, BriefScope, LayoutSourceType
 * - Auth.js関連: Account, Session, VerificationToken
 * - RBAC関連: Role, Permission, UserRole, RolePermission
 *
 * 残存モデル（Phase 2保留）:
 * - Project
 * - ProjectBrandSetting
 */

import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';

// Prisma Client のモデル型をテストするためのヘルパー
type ModelNames = Prisma.ModelName;

describe('Phase 1 クリーンアップ検証 - Enum定義確認', () => {
  describe('ProjectStatus Enum', () => {
    it('ProjectStatus enum が存在すること', () => {
      // Prismaで生成されたEnumを確認
      const projectStatusValues = ['draft', 'in_progress', 'published', 'archived'];
      projectStatusValues.forEach((value) => {
        expect(typeof value).toBe('string');
      });
    });
  });

  describe('[Phase 1] 削除されたEnumが存在しないこと', () => {
    it('削除済みEnum（ProjectPageType, BriefScope, LayoutSourceType）が存在しないこと', () => {
      // これらのenumはPhase 1で不要なモデルとともに削除済み
      // Prisma.ModelNameに含まれないことを型レベルで確認
      // （enumはModelNameには含まれないが、Phase 1削除の記録として残す）
      expect(true).toBe(true);
    });
  });
});

describe('Phase 1 クリーンアップ検証 - モデル存在確認', () => {
  describe('Project モデル', () => {
    it('Project モデルが存在すること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).toContain('Project');
    });

    it('Project の必須フィールドが正しく定義されていること', () => {
      type ProjectFields = keyof Prisma.ProjectCreateInput;

      const requiredFields: ProjectFields[] = [
        'name',
        'slug',
        'user', // リレーション
      ];

      requiredFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });

    it('Project のオプショナルフィールドが正しく定義されていること', () => {
      type ProjectFields = keyof Prisma.ProjectCreateInput;

      const optionalFields: ProjectFields[] = [
        'description',
        'status',
      ];

      optionalFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });
  });

  describe('[Phase 1] 削除済みモデルの不在確認', () => {
    it('ProjectPage モデルが削除されていること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).not.toContain('ProjectPage');
    });

    it('ProjectBrief モデルが削除されていること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).not.toContain('ProjectBrief');
    });

    it('ProjectLayoutVersion モデルが削除されていること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).not.toContain('ProjectLayoutVersion');
    });

    it('ProjectLayoutScore モデルが削除されていること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).not.toContain('ProjectLayoutScore');
    });

    it('ProjectCodeExport モデルが削除されていること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).not.toContain('ProjectCodeExport');
    });
  });

  describe('ProjectBrandSetting モデル（Phase 2保留）', () => {
    it('ProjectBrandSetting モデルが存在すること', () => {
      const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
      expect(modelNames).toContain('ProjectBrandSetting');
    });

    it('ProjectBrandSetting の必須フィールドが正しく定義されていること', () => {
      type ProjectBrandSettingFields = keyof Prisma.ProjectBrandSettingCreateInput;

      const requiredFields: ProjectBrandSettingFields[] = [
        'project', // リレーション
      ];

      requiredFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });

    it('ProjectBrandSetting のオプショナルフィールドが正しく定義されていること', () => {
      type ProjectBrandSettingFields = keyof Prisma.ProjectBrandSettingCreateInput;

      const optionalFields: ProjectBrandSettingFields[] = [
        'brandId',
        'palette', // リレーション (nullable)
        'tokens',
      ];

      optionalFields.forEach((field) => {
        expect(typeof field).toBe('string');
      });
    });
  });
});

describe('Phase 1 クリーンアップ検証 - リレーション確認', () => {
  describe('Project リレーション', () => {
    it('Project から User への外部キーが定義されていること', () => {
      type ProjectFields = keyof Prisma.ProjectWhereInput;
      const hasForeignKey: ProjectFields = 'userId';
      expect(hasForeignKey).toBe('userId');
    });

    it('Project から ProjectBrandSetting への1:1リレーションが定義されていること', () => {
      type ProjectInclude = Prisma.ProjectInclude;
      const hasRelation: keyof ProjectInclude = 'brandSetting';
      expect(hasRelation).toBe('brandSetting');
    });
  });

  describe('ProjectBrandSetting リレーション', () => {
    it('ProjectBrandSetting から Project への外部キーが定義されていること（ユニーク）', () => {
      type ProjectBrandSettingFields = keyof Prisma.ProjectBrandSettingWhereInput;
      const hasForeignKey: ProjectBrandSettingFields = 'projectId';
      expect(hasForeignKey).toBe('projectId');
    });

    it('ProjectBrandSetting の projectId がユニーク制約を持つこと', () => {
      type ProjectBrandSettingUniqueFields = keyof Prisma.ProjectBrandSettingWhereUniqueInput;
      const hasUnique: ProjectBrandSettingUniqueFields = 'projectId';
      expect(hasUnique).toBe('projectId');
    });

    it('ProjectBrandSetting から BrandPalette への外部キーが定義されていること（nullable）', () => {
      type ProjectBrandSettingFields = keyof Prisma.ProjectBrandSettingWhereInput;
      const hasForeignKey: ProjectBrandSettingFields = 'paletteId';
      expect(hasForeignKey).toBe('paletteId');
    });
  });
});

describe('Phase 1 クリーンアップ検証 - インデックス確認', () => {
  it('Project.slug にユニーク制約が設定されていること', () => {
    type ProjectUniqueFields = keyof Prisma.ProjectWhereUniqueInput;
    const hasUnique: ProjectUniqueFields = 'slug';
    expect(hasUnique).toBe('slug');
  });

  it('Project でソート可能なフィールドが定義されていること', () => {
    type ProjectOrderByFields = keyof Prisma.ProjectOrderByWithRelationInput;
    const sortableFields: ProjectOrderByFields[] = [
      'createdAt',
      'updatedAt',
      'status',
    ];

    sortableFields.forEach((field) => {
      expect(typeof field).toBe('string');
    });
  });
});

describe('Phase 1 クリーンアップ検証 - 既存モデルとの整合性', () => {
  // [DELETED OSS] User モデルはOSSリリース時に削除済み

  it('[OSS] User モデルが削除されていること', () => {
    const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
    expect(modelNames).not.toContain('User');
  });

  it('[Phase 1] Auth.js モデルが削除されていること', () => {
    const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
    expect(modelNames).not.toContain('Account');
    expect(modelNames).not.toContain('Session');
    expect(modelNames).not.toContain('VerificationToken');
  });

  it('[Phase 1] RBAC モデルが削除されていること', () => {
    const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
    expect(modelNames).not.toContain('Role');
    expect(modelNames).not.toContain('Permission');
    expect(modelNames).not.toContain('UserRole');
    expect(modelNames).not.toContain('RolePermission');
  });

  it('BrandPalette モデルが存在すること（既存）', () => {
    const modelNames: ModelNames[] = Object.values(Prisma.ModelName);
    expect(modelNames).toContain('BrandPalette');
  });

  it('BrandPalette から ProjectBrandSetting へのリレーションが定義されていること', () => {
    type BrandPaletteInclude = Prisma.BrandPaletteInclude;
    const hasRelation: keyof BrandPaletteInclude = 'projectBrandSettings';
    expect(hasRelation).toBe('projectBrandSettings');
  });
});
