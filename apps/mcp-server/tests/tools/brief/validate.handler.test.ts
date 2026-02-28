// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * brief.validate MCPツールハンドラーのテスト
 * TDD Red Phase: 先にテストを作成
 *
 * デザインブリーフを検証し、完成度スコアと改善提案を返すMCPツール
 *
 * テスト対象:
 * - 入力バリデーション
 * - 有効な入力での成功レスポンス
 * - 無効な入力でのエラーレスポンス
 * - strictModeの動作確認
 * - Response Objectパターンの検証
 * - DI（サービスファクトリ）対応
 * - ツール定義の検証
 *
 * @module tests/tools/brief/validate.handler.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// インポート
// =====================================================

import {
  briefValidateHandler,
  briefValidateToolDefinition,
  setBriefValidateServiceFactory,
  resetBriefValidateServiceFactory,
  type IBriefValidateServiceFactory,
} from '../../../src/tools/brief/validate.handler';

import {
  briefValidateInputSchema,
  briefValidateOutputSchema,
  BRIEF_MCP_ERROR_CODES,
  type Brief,
  type BriefValidateInput,
  type BriefValidateOutput,
  type BriefValidationResult,
} from '../../../src/tools/brief/schemas';

// =====================================================
// テストデータ
// =====================================================

/**
 * 完全なブリーフ（全フィールド入力済み）
 * strictMode の minDescription=100 を満たす必要がある
 */
const completeBrief: Brief = {
  projectName: 'Reftrix Web Application',
  description:
    'SVGアセット管理プラットフォーム。AIエージェント向けのMCPツールを提供し、SVGの検索・変換・最適化を支援します。ベクトル検索によるセマンティック検索とReactコンポーネント変換機能を実装しています。',
  targetAudience: 'Web開発者、UIデザイナー、AIエージェント開発者',
  industry: 'technology',
  tone: ['professional', 'minimal'],
  colorPreferences: {
    primary: '#3B82F6',
    secondary: '#10B981',
    accent: '#F59E0B',
  },
  references: [
    { url: 'https://example.com/design1', note: 'カラーパレット参考' },
    { url: 'https://example.com/design2', note: 'レイアウト参考' },
  ],
  constraints: {
    mustHave: ['アクセシビリティ対応', 'レスポンシブデザイン'],
    mustAvoid: ['過度なアニメーション', '複雑なナビゲーション'],
  },
};

/**
 * 最小限のブリーフ（必須フィールドのみ）
 */
const minimalBrief: Brief = {
  projectName: 'Minimal Project',
};

/**
 * 中程度のブリーフ
 * minLengths: description>=50, targetAudience>=20 を満たす必要がある
 * FIELD_WEIGHTS: projectName(10) + description(20) + targetAudience(15) = 45点を目標
 */
const partialBrief: Brief = {
  projectName: 'Partial Project',
  description:
    'このプロジェクトは部分的に記入されたブリーフです。目的と概要のみが記載されています。詳細な説明を追加予定。',
  targetAudience: '一般的なWebユーザーおよびモバイルアプリ利用者',
};

/**
 * 無効なプロジェクト名（短すぎる）
 */
const invalidShortNameBrief: Brief = {
  projectName: 'AB', // 3文字未満
};

/**
 * 無効なHEXカラー
 */
const invalidColorBrief: Brief = {
  projectName: 'Invalid Color Project',
  colorPreferences: {
    primary: 'invalid-color', // HEX形式でない
  },
};

/**
 * 無効なURL参照
 */
const invalidReferenceBrief: Brief = {
  projectName: 'Invalid Reference Project',
  references: [{ url: 'not-a-valid-url' }],
};

// =====================================================
// ツール定義テスト（5+ tests）
// =====================================================

describe('briefValidateToolDefinition', () => {
  it('正しいツール名を持つ', () => {
    expect(briefValidateToolDefinition.name).toBe('brief.validate');
  });

  it('description が設定されている', () => {
    expect(briefValidateToolDefinition.description).toBeDefined();
    expect(typeof briefValidateToolDefinition.description).toBe('string');
    expect(briefValidateToolDefinition.description.length).toBeGreaterThan(0);
  });

  it('inputSchema が object 型', () => {
    expect(briefValidateToolDefinition.inputSchema.type).toBe('object');
  });

  it('properties に brief を含む', () => {
    const { properties } = briefValidateToolDefinition.inputSchema;
    expect(properties).toHaveProperty('brief');
  });

  it('properties に strictMode を含む', () => {
    const { properties } = briefValidateToolDefinition.inputSchema;
    expect(properties).toHaveProperty('strictMode');
  });

  it('required に brief を含む', () => {
    const { required } = briefValidateToolDefinition.inputSchema;
    expect(required).toContain('brief');
  });

  it('strictMode のデフォルト値が false', () => {
    const { properties } = briefValidateToolDefinition.inputSchema;
    expect(properties.strictMode.default).toBe(false);
  });
});

// =====================================================
// 入力スキーマテスト（10+ tests）
// =====================================================

describe('briefValidateInputSchema', () => {
  describe('有効な入力', () => {
    it('完全なブリーフを受け付ける', () => {
      const input: BriefValidateInput = { brief: completeBrief };
      const result = briefValidateInputSchema.parse(input);
      expect(result.brief.projectName).toBe(completeBrief.projectName);
      expect(result.strictMode).toBe(false); // デフォルト
    });

    it('最小限のブリーフを受け付ける', () => {
      const input: BriefValidateInput = { brief: minimalBrief };
      const result = briefValidateInputSchema.parse(input);
      expect(result.brief.projectName).toBe(minimalBrief.projectName);
    });

    it('strictMode=true を受け付ける', () => {
      const input: BriefValidateInput = { brief: minimalBrief, strictMode: true };
      const result = briefValidateInputSchema.parse(input);
      expect(result.strictMode).toBe(true);
    });

    it('strictMode=false を明示的に受け付ける', () => {
      const input: BriefValidateInput = { brief: minimalBrief, strictMode: false };
      const result = briefValidateInputSchema.parse(input);
      expect(result.strictMode).toBe(false);
    });

    it('tone 配列を受け付ける', () => {
      const input: BriefValidateInput = {
        brief: { projectName: 'Test', tone: ['professional', 'minimal'] },
      };
      const result = briefValidateInputSchema.parse(input);
      expect(result.brief.tone).toEqual(['professional', 'minimal']);
    });

    it('colorPreferences を受け付ける', () => {
      const input: BriefValidateInput = {
        brief: {
          projectName: 'Test',
          colorPreferences: { primary: '#FF0000' },
        },
      };
      const result = briefValidateInputSchema.parse(input);
      expect(result.brief.colorPreferences?.primary).toBe('#FF0000');
    });

    it('references 配列を受け付ける', () => {
      const input: BriefValidateInput = {
        brief: {
          projectName: 'Test',
          references: [{ url: 'https://example.com' }],
        },
      };
      const result = briefValidateInputSchema.parse(input);
      expect(result.brief.references?.length).toBe(1);
    });

    it('constraints を受け付ける', () => {
      const input: BriefValidateInput = {
        brief: {
          projectName: 'Test',
          constraints: { mustHave: ['feature1'], mustAvoid: ['anti-pattern1'] },
        },
      };
      const result = briefValidateInputSchema.parse(input);
      expect(result.brief.constraints?.mustHave).toContain('feature1');
    });
  });

  describe('無効な入力', () => {
    it('brief がない場合エラー', () => {
      const input = {};
      expect(() => briefValidateInputSchema.parse(input)).toThrow();
    });

    it('projectName がない場合エラー', () => {
      const input = { brief: {} };
      expect(() => briefValidateInputSchema.parse(input)).toThrow();
    });

    it('projectName が空文字の場合エラー', () => {
      const input = { brief: { projectName: '' } };
      expect(() => briefValidateInputSchema.parse(input)).toThrow();
    });

    it('無効な tone 値の場合エラー', () => {
      const input = { brief: { projectName: 'Test', tone: ['invalid-tone'] } };
      expect(() => briefValidateInputSchema.parse(input)).toThrow();
    });

    it('無効なHEXカラーの場合エラー', () => {
      const input = {
        brief: {
          projectName: 'Test',
          colorPreferences: { primary: 'not-hex' },
        },
      };
      expect(() => briefValidateInputSchema.parse(input)).toThrow();
    });

    it('無効なURLの場合エラー', () => {
      const input = {
        brief: {
          projectName: 'Test',
          references: [{ url: 'invalid-url' }],
        },
      };
      expect(() => briefValidateInputSchema.parse(input)).toThrow();
    });

    it('references が10件を超える場合エラー', () => {
      const input = {
        brief: {
          projectName: 'Test',
          references: Array(11)
            .fill(null)
            .map((_, i) => ({ url: `https://example.com/${i}` })),
        },
      };
      expect(() => briefValidateInputSchema.parse(input)).toThrow();
    });
  });
});

// =====================================================
// ハンドラー成功テスト（15+ tests）
// =====================================================

describe('briefValidateHandler - 成功ケース', () => {
  beforeEach(() => {
    resetBriefValidateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Response Objectパターン', () => {
    it('成功時 success=true を返す', async () => {
      const input: BriefValidateInput = { brief: completeBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
    });

    it('成功時 data を含む', async () => {
      const input: BriefValidateInput = { brief: completeBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeDefined();
      }
    });

    it('成功時 error を含まない', async () => {
      const input: BriefValidateInput = { brief: completeBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect((result as { error?: unknown }).error).toBeUndefined();
      }
    });
  });

  describe('バリデーション結果', () => {
    it('isValid を返す', async () => {
      const input: BriefValidateInput = { brief: completeBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.isValid).toBe('boolean');
      }
    });

    it('completenessScore を返す（0-100）', async () => {
      const input: BriefValidateInput = { brief: completeBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.completenessScore).toBeGreaterThanOrEqual(0);
        expect(result.data.completenessScore).toBeLessThanOrEqual(100);
      }
    });

    it('issues 配列を返す', async () => {
      const input: BriefValidateInput = { brief: minimalBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.data.issues)).toBe(true);
      }
    });

    it('suggestions 配列を返す', async () => {
      const input: BriefValidateInput = { brief: minimalBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.data.suggestions)).toBe(true);
      }
    });

    it('readyForDesign を返す', async () => {
      const input: BriefValidateInput = { brief: completeBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.readyForDesign).toBe('boolean');
      }
    });
  });

  describe('完成度スコア計算', () => {
    it('完全なブリーフは高スコア（80以上）', async () => {
      const input: BriefValidateInput = { brief: completeBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.completenessScore).toBeGreaterThanOrEqual(80);
      }
    });

    it('最小限のブリーフは低スコア', async () => {
      const input: BriefValidateInput = { brief: minimalBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.completenessScore).toBeLessThan(50);
      }
    });

    it('中程度のブリーフは中程度スコア', async () => {
      const input: BriefValidateInput = { brief: partialBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.completenessScore).toBeGreaterThan(20);
        expect(result.data.completenessScore).toBeLessThan(80);
      }
    });
  });

  describe('readyForDesign 判定', () => {
    it('完全なブリーフは readyForDesign=true', async () => {
      const input: BriefValidateInput = { brief: completeBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.readyForDesign).toBe(true);
      }
    });

    it('最小限のブリーフは readyForDesign=false', async () => {
      const input: BriefValidateInput = { brief: minimalBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.readyForDesign).toBe(false);
      }
    });
  });

  describe('Issue生成', () => {
    it('最小限のブリーフで warning issues を生成', async () => {
      const input: BriefValidateInput = { brief: minimalBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const warnings = result.data.issues.filter((i) => i.severity === 'warning');
        expect(warnings.length).toBeGreaterThan(0);
      }
    });

    it('最小限のブリーフで suggestion issues を生成', async () => {
      const input: BriefValidateInput = { brief: minimalBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const suggestions = result.data.issues.filter((i) => i.severity === 'suggestion');
        expect(suggestions.length).toBeGreaterThan(0);
      }
    });

    it('完全なブリーフでは error issues がない', async () => {
      const input: BriefValidateInput = { brief: completeBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success) {
        const errors = result.data.issues.filter((i) => i.severity === 'error');
        expect(errors.length).toBe(0);
      }
    });

    it('issue に field, severity, message を含む', async () => {
      const input: BriefValidateInput = { brief: minimalBrief };
      const result = await briefValidateHandler(input);

      expect(result.success).toBe(true);
      if (result.success && result.data.issues.length > 0) {
        const issue = result.data.issues[0];
        expect(issue).toHaveProperty('field');
        expect(issue).toHaveProperty('severity');
        expect(issue).toHaveProperty('message');
      }
    });
  });
});

// =====================================================
// strictMode テスト（10+ tests）
// =====================================================

describe('briefValidateHandler - strictMode', () => {
  beforeEach(() => {
    resetBriefValidateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strictMode=false でデフォルト検証', async () => {
    const input: BriefValidateInput = { brief: partialBrief, strictMode: false };
    const result = await briefValidateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // 通常モードでは isValid になる可能性がある
      expect(typeof result.data.isValid).toBe('boolean');
    }
  });

  it('strictMode=true でより厳しい検証', async () => {
    const input: BriefValidateInput = { brief: partialBrief, strictMode: true };
    const result = await briefValidateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      // strictモードでは部分ブリーフは isValid=false
      expect(result.data.isValid).toBe(false);
    }
  });

  it('strictMode=true で error issues を生成', async () => {
    const input: BriefValidateInput = { brief: partialBrief, strictMode: true };
    const result = await briefValidateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const errors = result.data.issues.filter((i) => i.severity === 'error');
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('strictMode=true で description 必須', async () => {
    const briefWithoutDescription: Brief = {
      projectName: 'Test Project',
      tone: ['professional'],
      colorPreferences: { primary: '#3B82F6' },
      references: [
        { url: 'https://example.com/1' },
        { url: 'https://example.com/2' },
      ],
    };
    const input: BriefValidateInput = { brief: briefWithoutDescription, strictMode: true };
    const result = await briefValidateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const descriptionError = result.data.issues.find(
        (i) => i.field === 'description' && i.severity === 'error'
      );
      expect(descriptionError).toBeDefined();
    }
  });

  it('strictMode=true で tone 必須', async () => {
    const briefWithoutTone: Brief = {
      projectName: 'Test Project',
      description:
        'このプロジェクトは詳細な説明を持っていますが、トーンが設定されていません。100文字以上の説明です。',
      colorPreferences: { primary: '#3B82F6' },
      references: [
        { url: 'https://example.com/1' },
        { url: 'https://example.com/2' },
      ],
    };
    const input: BriefValidateInput = { brief: briefWithoutTone, strictMode: true };
    const result = await briefValidateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const toneError = result.data.issues.find(
        (i) => i.field === 'tone' && i.severity === 'error'
      );
      expect(toneError).toBeDefined();
    }
  });

  it('strictMode=true で colorPreferences 必須', async () => {
    const briefWithoutColors: Brief = {
      projectName: 'Test Project',
      description:
        'このプロジェクトは詳細な説明を持っていますが、カラー設定がありません。100文字以上の説明です。',
      tone: ['professional'],
      references: [
        { url: 'https://example.com/1' },
        { url: 'https://example.com/2' },
      ],
    };
    const input: BriefValidateInput = { brief: briefWithoutColors, strictMode: true };
    const result = await briefValidateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const colorError = result.data.issues.find(
        (i) => i.field === 'colorPreferences' && i.severity === 'error'
      );
      expect(colorError).toBeDefined();
    }
  });

  it('strictMode=true で references 2件以上必須', async () => {
    const briefWithOneReference: Brief = {
      projectName: 'Test Project',
      description:
        'このプロジェクトは詳細な説明を持っていますが、参考サイトが1件しかありません。100文字以上の説明です。',
      tone: ['professional'],
      colorPreferences: { primary: '#3B82F6' },
      references: [{ url: 'https://example.com/1' }],
    };
    const input: BriefValidateInput = { brief: briefWithOneReference, strictMode: true };
    const result = await briefValidateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const referencesError = result.data.issues.find(
        (i) => i.field === 'references' && i.severity === 'error'
      );
      expect(referencesError).toBeDefined();
    }
  });

  it('strictMode でも完全なブリーフは isValid=true', async () => {
    const input: BriefValidateInput = { brief: completeBrief, strictMode: true };
    const result = await briefValidateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isValid).toBe(true);
    }
  });

  it('strictMode の方がスコアが低くなる（部分ブリーフ）', async () => {
    const inputNormal: BriefValidateInput = { brief: partialBrief, strictMode: false };
    const inputStrict: BriefValidateInput = { brief: partialBrief, strictMode: true };

    const resultNormal = await briefValidateHandler(inputNormal);
    const resultStrict = await briefValidateHandler(inputStrict);

    expect(resultNormal.success).toBe(true);
    expect(resultStrict.success).toBe(true);

    if (resultNormal.success && resultStrict.success) {
      // strictモードでは isValid がより厳しくなる
      expect(resultStrict.data.isValid).toBe(false);
    }
  });
});

// =====================================================
// エラーハンドリングテスト（10+ tests）
// =====================================================

describe('briefValidateHandler - エラーケース', () => {
  beforeEach(() => {
    resetBriefValidateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Response Objectパターン（エラー）', () => {
    it('エラー時 success=false を返す', async () => {
      const result = await briefValidateHandler(null);
      expect(result.success).toBe(false);
    });

    it('エラー時 error を含む', async () => {
      const result = await briefValidateHandler(null);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });

    it('エラー時 data を含まない', async () => {
      const result = await briefValidateHandler(null);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect((result as { data?: unknown }).data).toBeUndefined();
      }
    });

    it('error に code と message を含む', async () => {
      const result = await briefValidateHandler(null);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toHaveProperty('code');
        expect(result.error).toHaveProperty('message');
      }
    });
  });

  describe('バリデーションエラー', () => {
    it('入力が null の場合 VALIDATION_ERROR', async () => {
      const result = await briefValidateHandler(null);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BRIEF_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('入力が undefined の場合 VALIDATION_ERROR', async () => {
      const result = await briefValidateHandler(undefined);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BRIEF_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('空オブジェクトの場合 VALIDATION_ERROR', async () => {
      const result = await briefValidateHandler({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BRIEF_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('brief が空オブジェクトの場合 VALIDATION_ERROR', async () => {
      const result = await briefValidateHandler({ brief: {} });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BRIEF_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('projectName が空の場合 VALIDATION_ERROR', async () => {
      const result = await briefValidateHandler({ brief: { projectName: '' } });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BRIEF_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('無効な tone 値の場合 VALIDATION_ERROR', async () => {
      const result = await briefValidateHandler({
        brief: { projectName: 'Test', tone: ['invalid'] },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BRIEF_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('無効なHEXカラーの場合 VALIDATION_ERROR', async () => {
      const result = await briefValidateHandler({
        brief: { projectName: 'Test', colorPreferences: { primary: 'red' } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BRIEF_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('無効なURLの場合 VALIDATION_ERROR', async () => {
      const result = await briefValidateHandler({
        brief: { projectName: 'Test', references: [{ url: 'not-url' }] },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(BRIEF_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  describe('エラーメッセージ', () => {
    it('エラーメッセージが空でない', async () => {
      const result = await briefValidateHandler(null);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    });

    it('バリデーションエラーで具体的なメッセージ', async () => {
      const result = await briefValidateHandler({ brief: {} });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBeDefined();
      }
    });
  });
});

// =====================================================
// DI（サービスファクトリ）テスト（5+ tests）
// =====================================================

describe('briefValidateHandler - DI', () => {
  beforeEach(() => {
    resetBriefValidateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('カスタムサービスファクトリを使用できる', async () => {
    const mockValidate = vi.fn().mockResolvedValue({
      isValid: true,
      completenessScore: 100,
      issues: [],
      suggestions: [],
      readyForDesign: true,
    } satisfies BriefValidationResult);

    setBriefValidateServiceFactory(() => ({
      validate: mockValidate,
    }));

    const input: BriefValidateInput = { brief: completeBrief };
    const result = await briefValidateHandler(input);

    expect(mockValidate).toHaveBeenCalledWith(completeBrief, false);
    expect(result.success).toBe(true);
  });

  it('サービスファクトリに strictMode が渡される', async () => {
    const mockValidate = vi.fn().mockResolvedValue({
      isValid: false,
      completenessScore: 50,
      issues: [],
      suggestions: [],
      readyForDesign: false,
    } satisfies BriefValidationResult);

    setBriefValidateServiceFactory(() => ({
      validate: mockValidate,
    }));

    const input: BriefValidateInput = { brief: completeBrief, strictMode: true };
    await briefValidateHandler(input);

    expect(mockValidate).toHaveBeenCalledWith(completeBrief, true);
  });

  it('サービスファクトリをリセットできる', async () => {
    const mockValidate = vi.fn().mockResolvedValue({
      isValid: true,
      completenessScore: 100,
      issues: [],
      suggestions: [],
      readyForDesign: true,
    } satisfies BriefValidationResult);

    setBriefValidateServiceFactory(() => ({
      validate: mockValidate,
    }));

    resetBriefValidateServiceFactory();

    const input: BriefValidateInput = { brief: completeBrief };
    await briefValidateHandler(input);

    // リセット後はモックが呼ばれない（デフォルトサービスを使用）
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it('サービスエラー時 INTERNAL_ERROR を返す', async () => {
    setBriefValidateServiceFactory(() => ({
      validate: vi.fn().mockRejectedValue(new Error('Service error')),
    }));

    const input: BriefValidateInput = { brief: completeBrief };
    const result = await briefValidateHandler(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(BRIEF_MCP_ERROR_CODES.INTERNAL_ERROR);
    }
  });

  it('サービスファクトリ未設定時はデフォルトサービスを使用', async () => {
    resetBriefValidateServiceFactory();

    const input: BriefValidateInput = { brief: completeBrief };
    const result = await briefValidateHandler(input);

    // デフォルトサービスで正常に動作
    expect(result.success).toBe(true);
  });
});

// =====================================================
// 出力スキーマテスト（5+ tests）
// =====================================================

describe('briefValidateOutputSchema', () => {
  it('成功レスポンスをバリデート', () => {
    const output: BriefValidateOutput = {
      success: true,
      data: {
        isValid: true,
        completenessScore: 85,
        issues: [],
        suggestions: ['カラーパレットを追加することを検討してください'],
        readyForDesign: true,
      },
    };
    expect(() => briefValidateOutputSchema.parse(output)).not.toThrow();
  });

  it('エラーレスポンスをバリデート', () => {
    const output: BriefValidateOutput = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
      },
    };
    expect(() => briefValidateOutputSchema.parse(output)).not.toThrow();
  });

  it('issues を含むレスポンスをバリデート', () => {
    const output: BriefValidateOutput = {
      success: true,
      data: {
        isValid: false,
        completenessScore: 30,
        issues: [
          {
            field: 'description',
            severity: 'warning',
            message: '説明を追加することを推奨します',
            suggestion: 'プロジェクトの目的と背景を記載してください',
          },
        ],
        suggestions: [],
        readyForDesign: false,
      },
    };
    expect(() => briefValidateOutputSchema.parse(output)).not.toThrow();
  });

  it('completenessScore が範囲外の場合エラー', () => {
    const output = {
      success: true,
      data: {
        isValid: true,
        completenessScore: 150, // 100を超える
        issues: [],
        suggestions: [],
        readyForDesign: true,
      },
    };
    expect(() => briefValidateOutputSchema.parse(output)).toThrow();
  });

  it('無効な severity でエラー', () => {
    const output = {
      success: true,
      data: {
        isValid: false,
        completenessScore: 50,
        issues: [
          {
            field: 'description',
            severity: 'critical', // 無効な値
            message: 'Invalid severity',
          },
        ],
        suggestions: [],
        readyForDesign: false,
      },
    };
    expect(() => briefValidateOutputSchema.parse(output)).toThrow();
  });
});

// =====================================================
// 統合テスト（5+ tests）
// =====================================================

describe('briefValidateHandler - 統合テスト', () => {
  beforeEach(() => {
    resetBriefValidateServiceFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ツール定義とハンドラーの入力が一致', () => {
    const { properties } = briefValidateToolDefinition.inputSchema;
    expect(properties).toHaveProperty('brief');
    expect(properties).toHaveProperty('strictMode');
  });

  it('ハンドラー結果が出力スキーマに適合', async () => {
    const input: BriefValidateInput = { brief: completeBrief };
    const result = await briefValidateHandler(input);

    expect(() => briefValidateOutputSchema.parse(result)).not.toThrow();
  });

  it('エラーコードが定義通りに使われる', async () => {
    // VALIDATION_ERROR
    const result1 = await briefValidateHandler({});
    expect(result1.success).toBe(false);
    if (!result1.success) {
      expect(Object.values(BRIEF_MCP_ERROR_CODES)).toContain(result1.error.code);
    }
  });

  it('複数回の呼び出しで独立した結果', async () => {
    const input1: BriefValidateInput = { brief: completeBrief };
    const input2: BriefValidateInput = { brief: minimalBrief };

    const [result1, result2] = await Promise.all([
      briefValidateHandler(input1),
      briefValidateHandler(input2),
    ]);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    if (result1.success && result2.success) {
      expect(result1.data.completenessScore).not.toBe(result2.data.completenessScore);
    }
  });

  it('isValid と readyForDesign の整合性', async () => {
    // readyForDesign=true なら isValid=true である必要がある
    const input: BriefValidateInput = { brief: completeBrief };
    const result = await briefValidateHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      if (result.data.readyForDesign) {
        expect(result.data.isValid).toBe(true);
      }
    }
  });
});
