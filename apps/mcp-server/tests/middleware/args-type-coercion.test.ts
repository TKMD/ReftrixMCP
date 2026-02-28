// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * args-type-coercion middleware tests
 * MCP経由で文字列として渡された数値・ブーリアンパラメータを
 * JSON Schemaの型定義に基づいて自動変換するミドルウェアのテスト
 *
 * 問題の背景:
 * MCP プロトコル経由でパラメータが渡される際、一部のクライアントが
 * 数値パラメータを文字列としてシリアライズする場合がある。
 * 例: limit: "20" (string) → limit: 20 (number) に変換が必要
 *
 * @module tests/middleware/args-type-coercion
 */

import { describe, it, expect } from 'vitest';
import {
  coerceArgs,
  buildCoercionMap,
  type CoercionMap,
} from '../../src/middleware/args-type-coercion';

// ============================================================================
// buildCoercionMap tests
// ============================================================================

describe('buildCoercionMap', () => {
  it('should extract number fields from flat JSON Schema', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        query: { type: 'string' },
        offset: { type: 'integer' },
      },
    };

    const map = buildCoercionMap(schema);
    expect(map.get('limit')).toBe('number');
    expect(map.get('offset')).toBe('number');
    expect(map.has('query')).toBe(false);
  });

  it('should handle nested object properties', () => {
    const schema = {
      type: 'object',
      properties: {
        options: {
          type: 'object',
          properties: {
            timeout: { type: 'number' },
            enabled: { type: 'boolean' },
            name: { type: 'string' },
          },
        },
        limit: { type: 'number' },
      },
    };

    const map = buildCoercionMap(schema);
    expect(map.get('limit')).toBe('number');
    // Nested properties should be tracked with dot notation
    expect(map.get('options.timeout')).toBe('number');
    expect(map.get('options.enabled')).toBe('boolean');
    expect(map.has('options.name')).toBe(false);
  });

  it('should handle boolean fields', () => {
    const schema = {
      type: 'object',
      properties: {
        include_html: { type: 'boolean' },
        save_to_db: { type: 'boolean' },
        query: { type: 'string' },
      },
    };

    const map = buildCoercionMap(schema);
    expect(map.get('include_html')).toBe('boolean');
    expect(map.get('save_to_db')).toBe('boolean');
    expect(map.has('query')).toBe(false);
  });

  it('should return empty map for schema without properties', () => {
    const schema = { type: 'object' };
    const map = buildCoercionMap(schema);
    expect(map.size).toBe(0);
  });

  it('should return empty map for non-object schema', () => {
    const schema = { type: 'string' };
    const map = buildCoercionMap(schema);
    expect(map.size).toBe(0);
  });

  it('should handle deeply nested schemas (2 levels)', () => {
    const schema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: {
            inner: {
              type: 'object',
              properties: {
                deep_number: { type: 'number' },
              },
            },
          },
        },
      },
    };

    const map = buildCoercionMap(schema);
    expect(map.get('outer.inner.deep_number')).toBe('number');
  });
});

// ============================================================================
// coerceArgs tests - number coercion
// ============================================================================

describe('coerceArgs - number coercion', () => {
  it('should convert string "20" to number 20 for number fields', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        query: { type: 'string' },
      },
    };

    const args = { limit: '20', query: 'hero section' };
    const result = coerceArgs(args, schema);

    expect(result.limit).toBe(20);
    expect(typeof result.limit).toBe('number');
    expect(result.query).toBe('hero section');
  });

  it('should convert string "0.5" to number 0.5', () => {
    const schema = {
      type: 'object',
      properties: {
        minSimilarity: { type: 'number' },
      },
    };

    const args = { minSimilarity: '0.5' };
    const result = coerceArgs(args, schema);

    expect(result.minSimilarity).toBe(0.5);
    expect(typeof result.minSimilarity).toBe('number');
  });

  it('should not modify already-number values', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    };

    const args = { limit: 20 };
    const result = coerceArgs(args, schema);

    expect(result.limit).toBe(20);
    expect(typeof result.limit).toBe('number');
  });

  it('should handle integer type same as number', () => {
    const schema = {
      type: 'object',
      properties: {
        offset: { type: 'integer' },
      },
    };

    const args = { offset: '5' };
    const result = coerceArgs(args, schema);

    expect(result.offset).toBe(5);
    expect(typeof result.offset).toBe('number');
  });

  it('should not convert non-numeric strings to numbers', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    };

    const args = { limit: 'abc' };
    const result = coerceArgs(args, schema);

    // Non-numeric string should be left as-is (Zod will catch the error)
    expect(result.limit).toBe('abc');
  });

  it('should not convert empty string to number', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    };

    const args = { limit: '' };
    const result = coerceArgs(args, schema);

    expect(result.limit).toBe('');
  });

  it('should handle negative number strings', () => {
    const schema = {
      type: 'object',
      properties: {
        delay: { type: 'number' },
      },
    };

    const args = { delay: '-100' };
    const result = coerceArgs(args, schema);

    expect(result.delay).toBe(-100);
    expect(typeof result.delay).toBe('number');
  });
});

// ============================================================================
// coerceArgs tests - boolean coercion
// ============================================================================

describe('coerceArgs - boolean coercion', () => {
  it('should convert string "true" to boolean true', () => {
    const schema = {
      type: 'object',
      properties: {
        include_html: { type: 'boolean' },
      },
    };

    const args = { include_html: 'true' };
    const result = coerceArgs(args, schema);

    expect(result.include_html).toBe(true);
    expect(typeof result.include_html).toBe('boolean');
  });

  it('should convert string "false" to boolean false', () => {
    const schema = {
      type: 'object',
      properties: {
        save_to_db: { type: 'boolean' },
      },
    };

    const args = { save_to_db: 'false' };
    const result = coerceArgs(args, schema);

    expect(result.save_to_db).toBe(false);
    expect(typeof result.save_to_db).toBe('boolean');
  });

  it('should not modify already-boolean values', () => {
    const schema = {
      type: 'object',
      properties: {
        include_html: { type: 'boolean' },
      },
    };

    const args = { include_html: true };
    const result = coerceArgs(args, schema);

    expect(result.include_html).toBe(true);
    expect(typeof result.include_html).toBe('boolean');
  });

  it('should not convert non-boolean strings to boolean', () => {
    const schema = {
      type: 'object',
      properties: {
        include_html: { type: 'boolean' },
      },
    };

    const args = { include_html: 'yes' };
    const result = coerceArgs(args, schema);

    // Non-boolean string should be left as-is (Zod will catch the error)
    expect(result.include_html).toBe('yes');
  });
});

// ============================================================================
// coerceArgs tests - nested objects
// ============================================================================

describe('coerceArgs - nested objects', () => {
  it('should coerce nested number fields', () => {
    const schema = {
      type: 'object',
      properties: {
        options: {
          type: 'object',
          properties: {
            timeout: { type: 'number' },
            enabled: { type: 'boolean' },
          },
        },
      },
    };

    const args = {
      options: {
        timeout: '5000',
        enabled: 'true',
      },
    };

    const result = coerceArgs(args, schema);

    expect((result.options as Record<string, unknown>).timeout).toBe(5000);
    expect(typeof (result.options as Record<string, unknown>).timeout).toBe('number');
    expect((result.options as Record<string, unknown>).enabled).toBe(true);
    expect(typeof (result.options as Record<string, unknown>).enabled).toBe('boolean');
  });

  it('should not modify nested string fields', () => {
    const schema = {
      type: 'object',
      properties: {
        options: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            timeout: { type: 'number' },
          },
        },
      },
    };

    const args = {
      options: {
        name: 'test',
        timeout: '1000',
      },
    };

    const result = coerceArgs(args, schema);

    expect((result.options as Record<string, unknown>).name).toBe('test');
    expect((result.options as Record<string, unknown>).timeout).toBe(1000);
  });
});

// ============================================================================
// coerceArgs tests - edge cases
// ============================================================================

describe('coerceArgs - edge cases', () => {
  it('should handle null values gracefully', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    };

    const args = { limit: null };
    const result = coerceArgs(args, schema);

    expect(result.limit).toBeNull();
  });

  it('should handle undefined values gracefully', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    };

    const args = { limit: undefined };
    const result = coerceArgs(args, schema);

    expect(result.limit).toBeUndefined();
  });

  it('should pass through fields not in schema', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    };

    const args = { limit: '10', unknown_field: 'value', _request_id: 'abc-123' };
    const result = coerceArgs(args, schema);

    expect(result.limit).toBe(10);
    expect(result.unknown_field).toBe('value');
    expect(result._request_id).toBe('abc-123');
  });

  it('should handle empty args object', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    };

    const args = {};
    const result = coerceArgs(args, schema);

    expect(result).toEqual({});
  });

  it('should not mutate the original args object', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    };

    const args = { limit: '20' };
    const result = coerceArgs(args, schema);

    expect(result.limit).toBe(20);
    expect(args.limit).toBe('20'); // Original should be unchanged
  });

  it('should handle string "0" correctly for numbers', () => {
    const schema = {
      type: 'object',
      properties: {
        offset: { type: 'number' },
      },
    };

    const args = { offset: '0' };
    const result = coerceArgs(args, schema);

    expect(result.offset).toBe(0);
    expect(typeof result.offset).toBe('number');
  });

  it('should handle arrays in args (no coercion)', () => {
    const schema = {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
      },
    };

    const args = { ids: ['a', 'b'], limit: '5' };
    const result = coerceArgs(args, schema);

    expect(result.ids).toEqual(['a', 'b']);
    expect(result.limit).toBe(5);
  });
});

// ============================================================================
// coerceArgs tests - real-world MCP tool scenarios
// ============================================================================

describe('coerceArgs - real-world MCP tool scenarios', () => {
  it('should handle motion.search input with string limit and minSimilarity', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 10 },
        minSimilarity: { type: 'number', default: 0.5 },
        include_js_animations: { type: 'boolean', default: true },
        diversity_threshold: { type: 'number', default: 0.3 },
      },
    };

    const args = {
      query: 'fade in animation',
      limit: '20',
      minSimilarity: '0.7',
      include_js_animations: 'true',
      diversity_threshold: '0.5',
    };

    const result = coerceArgs(args, schema);

    expect(result.query).toBe('fade in animation');
    expect(result.limit).toBe(20);
    expect(result.minSimilarity).toBe(0.7);
    expect(result.include_js_animations).toBe(true);
    expect(result.diversity_threshold).toBe(0.5);
  });

  it('should handle layout.search input with string limit and offset', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 10 },
        offset: { type: 'integer', default: 0 },
        include_html: { type: 'boolean' },
        include_preview: { type: 'boolean', default: true },
        preview_max_length: { type: 'integer', default: 500 },
        auto_detect_context: { type: 'boolean', default: true },
      },
    };

    const args = {
      query: 'hero section with gradient',
      limit: '20',
      offset: '0',
      include_html: 'false',
      include_preview: 'true',
      preview_max_length: '300',
    };

    const result = coerceArgs(args, schema);

    expect(result.query).toBe('hero section with gradient');
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
    expect(result.include_html).toBe(false);
    expect(result.include_preview).toBe(true);
    expect(result.preview_max_length).toBe(300);
  });

  it('should handle page.analyze input with nested number fields', () => {
    const schema = {
      type: 'object',
      properties: {
        url: { type: 'string' },
        width: { type: 'integer', default: 1440 },
        height: { type: 'integer', default: 900 },
        timeout: { type: 'integer', default: 300000 },
        options: {
          type: 'object',
          properties: {
            layoutTimeout: { type: 'integer', default: 120000 },
            motionTimeout: { type: 'integer', default: 300000 },
            qualityTimeout: { type: 'integer', default: 60000 },
          },
        },
      },
    };

    const args = {
      url: 'https://example.com',
      width: '1440',
      height: '900',
      timeout: '300000',
      options: {
        layoutTimeout: '120000',
        motionTimeout: '300000',
        qualityTimeout: '60000',
      },
    };

    const result = coerceArgs(args, schema);

    expect(result.url).toBe('https://example.com');
    expect(result.width).toBe(1440);
    expect(result.height).toBe(900);
    expect(result.timeout).toBe(300000);
    expect((result.options as Record<string, unknown>).layoutTimeout).toBe(120000);
    expect((result.options as Record<string, unknown>).motionTimeout).toBe(300000);
    expect((result.options as Record<string, unknown>).qualityTimeout).toBe(60000);
  });
});
