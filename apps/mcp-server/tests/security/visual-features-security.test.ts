// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * visualFeatures セキュリティテスト
 *
 * Phase 3-SEC: JSONインジェクション対策検証
 *
 * 検証項目:
 * 1. SQLインジェクション対策（Zod + Prisma）
 * 2. JSONBインジェクション対策（プロトタイプ汚染）
 * 3. XSS対策（レスポンス側）
 * 4. DoS対策（配列サイズ制限）
 * 5. Null/Undefined インジェクション対策
 *
 * @module tests/security/visual-features-security.test
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

// テスト対象のスキーマをインポート
import {
  visualFeaturesSchema,
  visualFeaturesColorsSchema,
  visualFeaturesThemeSchema,
  visualFeaturesDensitySchema,
  visualFeaturesGradientSchema,
  visualFeaturesMoodSchema,
  visualFeaturesBrandToneSchema,
  colorPaletteItemSchema,
  type VisualFeatures,
} from '../../src/tools/page/schemas';

// ============================================================================
// テストユーティリティ
// ============================================================================

/**
 * 有効なvisualFeaturesオブジェクトのテンプレート
 */
const validVisualFeatures: VisualFeatures = {
  colors: {
    dominant: ['#FF0000', '#00FF00', '#0000FF'],
    accent: ['#FFFF00', '#FF00FF'],
    palette: [
      { color: '#FF0000', percentage: 30 },
      { color: '#00FF00', percentage: 25 },
      { color: '#0000FF', percentage: 20 },
    ],
    source: 'deterministic',
    confidence: 0.95,
  },
  theme: {
    type: 'light',
    backgroundColor: '#FFFFFF',
    textColor: '#000000',
    contrastRatio: 21,
    luminance: {
      background: 1.0,
      foreground: 0.0,
    },
    source: 'deterministic',
    confidence: 0.98,
  },
  density: {
    contentDensity: 0.45,
    whitespaceRatio: 0.55,
    visualBalance: 85,
    source: 'deterministic',
    confidence: 0.92,
  },
  gradient: {
    hasGradient: true,
    gradients: [],
    dominantGradientType: 'linear',
    confidence: 0.88,
    processingTimeMs: 123,
    source: 'deterministic',
  },
  mood: {
    primary: 'professional',
    secondary: 'elegant',
    source: 'vision-ai',
    confidence: 0.75,
  },
  brandTone: {
    primary: 'corporate',
    secondary: 'trustworthy',
    source: 'vision-ai',
    confidence: 0.72,
  },
  metadata: {
    mergedAt: '2026-01-19T10:00:00.000Z',
    deterministicAvailable: true,
    visionAiAvailable: true,
    overallConfidence: 0.85,
    completeness: 1.0,
    warnings: [],
  },
};

// ============================================================================
// Part 1: SQLインジェクション対策テスト
// ============================================================================

describe('visualFeatures SQLインジェクション対策', () => {
  describe('HEXカラーパターンによるSQLインジェクション防止', () => {
    it('SQLインジェクション文字列を含むカラーコードを拒否すること', () => {
      const maliciousColors = {
        dominant: ["'; DROP TABLE section_patterns; --"],
        accent: ['#FF0000'],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maliciousColors);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Invalid');
      }
    });

    it('UNIONベースのSQLインジェクションを拒否すること', () => {
      const maliciousColors = {
        dominant: ["#FF0000' UNION SELECT * FROM users --"],
        accent: ['#00FF00'],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maliciousColors);
      expect(result.success).toBe(false);
    });

    it('コメント文字列を含むインジェクションを拒否すること', () => {
      const maliciousColors = {
        dominant: ['#FF0000/*', '#00FF00*/'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maliciousColors);
      expect(result.success).toBe(false);
    });

    it('有効なHEXカラーコードは受け入れること', () => {
      const validColors = {
        dominant: ['#FF0000', '#00FF00', '#0000FF'],
        accent: ['#FFFF00'],
        palette: [{ color: '#123456', percentage: 50 }],
        source: 'deterministic' as const,
        confidence: 0.95,
      };

      const result = visualFeaturesColorsSchema.safeParse(validColors);
      expect(result.success).toBe(true);
    });

    it('小文字のHEXカラーコードも受け入れること', () => {
      const validColors = {
        dominant: ['#ff0000', '#aabbcc'],
        accent: ['#1a2b3c'],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(validColors);
      expect(result.success).toBe(true);
    });
  });

  describe('テーマフィールドのSQLインジェクション防止', () => {
    it('SQLインジェクション文字列をbackgroundColorとして拒否すること', () => {
      const maliciousTheme = {
        type: 'light' as const,
        backgroundColor: "'; DELETE FROM web_pages; --",
        textColor: '#000000',
        contrastRatio: 21,
        luminance: { background: 1.0, foreground: 0.0 },
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesThemeSchema.safeParse(maliciousTheme);
      expect(result.success).toBe(false);
    });

    it('テーマタイプへのインジェクションを拒否すること', () => {
      const maliciousTheme = {
        type: "light'; DROP TABLE section_patterns; --" as any,
        backgroundColor: '#FFFFFF',
        textColor: '#000000',
        contrastRatio: 21,
        luminance: { background: 1.0, foreground: 0.0 },
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesThemeSchema.safeParse(maliciousTheme);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Part 2: JSONBインジェクション対策（プロトタイプ汚染）
// ============================================================================

describe('visualFeatures JSONBインジェクション対策', () => {
  describe('プロトタイプ汚染攻撃の防止', () => {
    it('__proto__プロパティを含むオブジェクトを適切に処理すること', () => {
      // Zodはunknownキーを黙って削除（stripモード）
      const maliciousInput = {
        colors: {
          dominant: ['#FF0000'],
          accent: [],
          palette: [],
          source: 'deterministic',
          confidence: 0.9,
          __proto__: { admin: true },
        },
        theme: null,
      };

      const result = visualFeaturesSchema.safeParse(maliciousInput);
      // Zodのデフォルトでは未知のキーは削除される（strict()でない限り）
      if (result.success) {
        // 成功した場合、__proto__が結果に含まれていないことを確認
        expect((result.data.colors as any).__proto__?.admin).toBeUndefined();
        // 通常のプロトタイプチェーンは維持される
        expect(Object.getPrototypeOf(result.data.colors)).toBe(Object.prototype);
      }
    });

    it('constructorプロパティへの攻撃を適切に処理すること', () => {
      const maliciousInput = {
        colors: {
          dominant: ['#FF0000'],
          accent: [],
          palette: [],
          source: 'deterministic',
          confidence: 0.9,
          constructor: { prototype: { isAdmin: true } },
        },
      };

      const result = visualFeaturesSchema.safeParse(maliciousInput);
      if (result.success) {
        // constructorが汚染されていないことを確認
        expect((result.data.colors as any)?.constructor?.prototype?.isAdmin).toBeUndefined();
      }
    });

    it('ネストされたプロトタイプ汚染攻撃を防止すること', () => {
      const maliciousInput = {
        theme: {
          type: 'light',
          backgroundColor: '#FFFFFF',
          textColor: '#000000',
          contrastRatio: 21,
          luminance: {
            background: 1.0,
            foreground: 0.0,
            __proto__: { polluted: true },
          },
          source: 'deterministic',
          confidence: 0.9,
        },
      };

      const result = visualFeaturesSchema.safeParse(maliciousInput);
      if (result.success && result.data.theme) {
        expect((result.data.theme.luminance as any).__proto__?.polluted).toBeUndefined();
      }
    });
  });

  describe('JSON.parseによる攻撃の防止', () => {
    it('JSON文字列として埋め込まれた__proto__を拒否すること', () => {
      // themeのtypeフィールドはenumなので、不正な値は拒否される
      const maliciousTheme = {
        type: '{"__proto__": {"admin": true}}' as any,
        backgroundColor: '#FFFFFF',
        textColor: '#000000',
        contrastRatio: 21,
        luminance: { background: 1.0, foreground: 0.0 },
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesThemeSchema.safeParse(maliciousTheme);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Part 3: XSS対策テスト（レスポンス側）
// ============================================================================

describe('visualFeatures XSS対策', () => {
  describe('スクリプトタグインジェクションの防止', () => {
    it('カラーコードに含まれるスクリプトタグを拒否すること', () => {
      const maliciousColors = {
        dominant: ['<script>alert("XSS")</script>'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maliciousColors);
      expect(result.success).toBe(false);
    });

    it('イベントハンドラ属性を含む文字列を拒否すること', () => {
      const maliciousColors = {
        dominant: ['#FF0000" onmouseover="alert(1)'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maliciousColors);
      expect(result.success).toBe(false);
    });

    it('SVGベースのXSS攻撃を拒否すること', () => {
      const maliciousColors = {
        dominant: ['<svg onload="alert(1)">'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maliciousColors);
      expect(result.success).toBe(false);
    });

    it('imgタグのonerrorを含む攻撃を拒否すること', () => {
      const maliciousColors = {
        dominant: ['<img src=x onerror=alert(1)>'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maliciousColors);
      expect(result.success).toBe(false);
    });
  });

  describe('JavaScriptプロトコルインジェクションの防止', () => {
    it('javascript:プロトコルを含む文字列を拒否すること', () => {
      const maliciousColors = {
        dominant: ['javascript:alert(1)'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maliciousColors);
      expect(result.success).toBe(false);
    });

    it('data:プロトコルを含む文字列を拒否すること', () => {
      const maliciousColors = {
        dominant: ['data:text/html,<script>alert(1)</script>'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maliciousColors);
      expect(result.success).toBe(false);
    });
  });

  describe('ムード・ブランドトーンフィールドのXSS対策', () => {
    it('moodのprimaryに不正な値を拒否すること', () => {
      const maliciousMood = {
        primary: '<script>alert("XSS")</script>' as any,
        source: 'vision-ai' as const,
        confidence: 0.75,
      };

      const result = visualFeaturesMoodSchema.safeParse(maliciousMood);
      expect(result.success).toBe(false);
    });

    it('brandToneのprimaryに不正な値を拒否すること', () => {
      const maliciousBrandTone = {
        primary: '<img src=x onerror=alert(1)>' as any,
        source: 'vision-ai' as const,
        confidence: 0.7,
      };

      const result = visualFeaturesBrandToneSchema.safeParse(maliciousBrandTone);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Part 4: DoS対策テスト（配列サイズ制限）
// ============================================================================

describe('visualFeatures DoS対策', () => {
  describe('配列サイズ制限', () => {
    it('dominant配列が5要素を超える場合を拒否すること', () => {
      const oversizedColors = {
        dominant: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(oversizedColors);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('5');
      }
    });

    it('accent配列が3要素を超える場合を拒否すること', () => {
      const oversizedColors = {
        dominant: ['#FF0000'],
        accent: ['#00FF00', '#0000FF', '#FFFF00', '#FF00FF'],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(oversizedColors);
      expect(result.success).toBe(false);
    });

    it('dominant配列が正確に5要素の場合は受け入れること', () => {
      const maxColors = {
        dominant: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maxColors);
      expect(result.success).toBe(true);
    });

    it('accent配列が正確に3要素の場合は受け入れること', () => {
      const maxColors = {
        dominant: ['#FF0000'],
        accent: ['#00FF00', '#0000FF', '#FFFF00'],
        palette: [],
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maxColors);
      expect(result.success).toBe(true);
    });
  });

  describe('大量ペイロード攻撃の防止', () => {
    it('palette配列が100要素を超える場合を拒否すること', () => {
      const largePayload = {
        dominant: ['#FF0000'],
        accent: [],
        palette: Array(101).fill({ color: '#000000', percentage: 1 }),
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(largePayload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('100');
      }
    });

    it('palette配列が正確に100要素の場合は受け入れること', () => {
      const maxPayload = {
        dominant: ['#FF0000'],
        accent: [],
        palette: Array(100).fill({ color: '#000000', percentage: 1 }),
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesColorsSchema.safeParse(maxPayload);
      expect(result.success).toBe(true);
    });
  });

  describe('数値フィールドの範囲制限', () => {
    it('confidenceが1を超える場合を拒否すること', () => {
      const invalidColors = {
        dominant: ['#FF0000'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: 1.5,
      };

      const result = visualFeaturesColorsSchema.safeParse(invalidColors);
      expect(result.success).toBe(false);
    });

    it('confidenceが0未満の場合を拒否すること', () => {
      const invalidColors = {
        dominant: ['#FF0000'],
        accent: [],
        palette: [],
        source: 'deterministic' as const,
        confidence: -0.1,
      };

      const result = visualFeaturesColorsSchema.safeParse(invalidColors);
      expect(result.success).toBe(false);
    });

    it('contrastRatioが21を超える場合を拒否すること', () => {
      const invalidTheme = {
        type: 'light' as const,
        backgroundColor: '#FFFFFF',
        textColor: '#000000',
        contrastRatio: 25,
        luminance: { background: 1.0, foreground: 0.0 },
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesThemeSchema.safeParse(invalidTheme);
      expect(result.success).toBe(false);
    });

    it('percentageが100を超える場合を拒否すること', () => {
      const invalidPalette = {
        color: '#FF0000',
        percentage: 150,
      };

      const result = colorPaletteItemSchema.safeParse(invalidPalette);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Part 5: Null/Undefined インジェクション対策
// ============================================================================

describe('visualFeatures Null/Undefined インジェクション対策', () => {
  describe('Null値の適切な処理', () => {
    it('colorsがnullの場合を適切に処理すること', () => {
      const nullInput = {
        colors: null,
        theme: null,
      };

      const result = visualFeaturesSchema.safeParse(nullInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.colors).toBeNull();
        expect(result.data.theme).toBeNull();
      }
    });

    it('moodがnullの場合を適切に処理すること', () => {
      const input = {
        mood: null,
      };

      const result = visualFeaturesSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mood).toBeNull();
      }
    });
  });

  describe('Undefined値の適切な処理', () => {
    it('オプショナルフィールドがundefinedの場合を受け入れること', () => {
      const partialInput = {
        colors: {
          dominant: ['#FF0000'],
          accent: [],
          palette: [],
          source: 'deterministic' as const,
          confidence: 0.9,
        },
        // theme, density, gradient, mood, brandTone, metadataは省略
      };

      const result = visualFeaturesSchema.safeParse(partialInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.theme).toBeUndefined();
        expect(result.data.density).toBeUndefined();
      }
    });

    it('空オブジェクトを適切に処理すること', () => {
      const emptyInput = {};

      const result = visualFeaturesSchema.safeParse(emptyInput);
      expect(result.success).toBe(true);
    });
  });

  describe('型強制攻撃の防止', () => {
    it('数値フィールドに文字列nullを渡した場合を拒否すること', () => {
      const maliciousInput = {
        colors: {
          dominant: ['#FF0000'],
          accent: [],
          palette: [],
          source: 'deterministic',
          confidence: 'null' as any,
        },
      };

      const result = visualFeaturesSchema.safeParse(maliciousInput);
      expect(result.success).toBe(false);
    });

    it('配列フィールドに文字列undefinedを渡した場合を拒否すること', () => {
      const maliciousInput = {
        colors: {
          dominant: 'undefined' as any,
          accent: [],
          palette: [],
          source: 'deterministic',
          confidence: 0.9,
        },
      };

      const result = visualFeaturesSchema.safeParse(maliciousInput);
      expect(result.success).toBe(false);
    });

    it('enumフィールドにnullを渡した場合の動作を確認すること', () => {
      const maliciousTheme = {
        type: null as any,
        backgroundColor: '#FFFFFF',
        textColor: '#000000',
        contrastRatio: 21,
        luminance: { background: 1.0, foreground: 0.0 },
        source: 'deterministic' as const,
        confidence: 0.9,
      };

      const result = visualFeaturesThemeSchema.safeParse(maliciousTheme);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Part 6: 有効な入力の受け入れ確認（ポジティブテスト）
// ============================================================================

describe('visualFeatures 有効な入力の受け入れ', () => {
  it('完全なvisualFeaturesオブジェクトを受け入れること', () => {
    const result = visualFeaturesSchema.safeParse(validVisualFeatures);
    expect(result.success).toBe(true);
  });

  it('部分的なvisualFeaturesオブジェクトを受け入れること', () => {
    const partialFeatures = {
      colors: validVisualFeatures.colors,
      theme: null,
      mood: null,
      brandTone: null,
    };

    const result = visualFeaturesSchema.safeParse(partialFeatures);
    expect(result.success).toBe(true);
  });

  it('決定論的データのみのvisualFeaturesを受け入れること', () => {
    const deterministicOnly = {
      colors: validVisualFeatures.colors,
      theme: validVisualFeatures.theme,
      density: validVisualFeatures.density,
      gradient: validVisualFeatures.gradient,
    };

    const result = visualFeaturesSchema.safeParse(deterministicOnly);
    expect(result.success).toBe(true);
  });

  it('Vision AIデータのみのvisualFeaturesを受け入れること', () => {
    const visionAiOnly = {
      mood: validVisualFeatures.mood,
      brandTone: validVisualFeatures.brandTone,
    };

    const result = visualFeaturesSchema.safeParse(visionAiOnly);
    expect(result.success).toBe(true);
  });
});
